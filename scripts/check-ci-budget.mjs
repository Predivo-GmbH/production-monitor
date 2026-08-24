#!/usr/bin/env node
/**
 * CI COST GUARD - a red run here IS the alert.
 *
 * WHY THIS EXISTS. The GitHub Actions bill has been "fixed" three times and came back every
 * time, because every previous round was a one-time edit with nothing watching it afterwards.
 * Verified in git on 2026-08-24:
 *   keep-alive.yml  deleted 2026-05-22 (by the optimisation commit itself), re-added 2026-06-08.
 *   test.yml        deleted 2026-05-22, re-added 2026-07-09 by a commit titled
 *                   "chore: commit pending docs/CI/assets (working-tree cleanup) [skip ci]".
 * Nothing failed either time, so nobody saw it. And the 2026-08 spike was not a duplicate file
 * at all: the Gate A discovery crawl grew from a documented "~25 min" to a measured 44m 48s
 * inside a gate that ran after every push, and no file-level rule would ever have noticed.
 * This guard notices.
 *
 * IT FAILS WHEN, and only when:
 *   1. a declared job's median billed minutes-per-run exceeds its ceiling (cost per run crept up)
 *   2. a workflow runs that is not declared in ci-budget.json at all     (something new is
 *                                                                         always-on, or something
 *                                                                         deleted has come back)
 *   3. the projected 30-day billed total exceeds monthly_minute_budget   (total spend)
 *   4. it discovers implausibly little data                              (see ABSENCE below)
 *
 * ABSENCE IS NOT SUCCESS. A guard whose pass branch is satisfied by "I found nothing" reports
 * green at the exact moment it is broken - the same defect as the FTP site-id guard that passed
 * on a failed login because an empty variable is not a mismatch. So a run that sees fewer than
 * MIN_RUNS_EXPECTED runs, or that hit API errors, FAILS as a broken harness rather than
 * announcing a clean fleet.
 *
 * BILLING MODEL. GitHub invoices per JOB, rounding each job UP to the next whole minute, and
 * bills parallel jobs separately. So billed = sum over jobs of ceil((completed_at - started_at)/60s).
 * Do NOT use /actions/runs/{id}/timing: it returns total_ms 0 on this account (verified
 * 2026-08-24 on run 32712888819, a 23-minute run). Public repositories are free on standard
 * runners, so their minutes are reported but excluded from the budget total.
 */
import fs from 'node:fs'

const OWNER = process.env.CI_BUDGET_OWNER || 'Predivo-GmbH'
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
const WINDOW_DAYS = Number(process.env.CI_BUDGET_WINDOW_DAYS || 7)
const MIN_RUNS_EXPECTED = Number(process.env.CI_BUDGET_MIN_RUNS || 100)
const RATE = 0.006 // USD per Actions Linux minute
const cfg = JSON.parse(fs.readFileSync(new URL('../ci-budget.json', import.meta.url), 'utf8'))

if (!TOKEN) {
  console.error('::error::no GH_TOKEN / GITHUB_TOKEN - cannot read the fleet. Failing rather than certifying a clean fleet on no data.')
  process.exit(1)
}

const H = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'ci-budget-guard',
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let apiErrors = 0

async function gh(url) {
  for (let attempt = 0; attempt < 6; attempt++) {
    let r
    try {
      r = await fetch(url, { headers: H })
    } catch {
      await sleep(2000)
      continue
    }
    if (r.status === 403 || r.status === 429) {
      const reset = Number(r.headers.get('x-ratelimit-reset') || 0) * 1000
      const wait = Math.min(Math.max(5000, reset - Date.now() + 3000), 180000)
      console.error(`  rate limited, waiting ${Math.round(wait / 1000)}s`)
      await sleep(wait)
      continue
    }
    if (r.status === 404) return null
    if (!r.ok) {
      if (r.status >= 500) {
        await sleep(2000)
        continue
      }
      apiErrors++
      return null
    }
    return r.json()
  }
  apiErrors++
  return null
}

// FULL timestamp, not .slice(0,10). A date-only `created>=` boundary includes the whole of that
// calendar day, so a "2 day" window actually spanned 3 days and the `x 30 / WINDOW_DAYS`
// projection divided by the wrong number (caught on the first live run, 2026-08-24: it read
// 5839 real minutes over 3 days and projected them as if they were 2).
const since = new Date(Date.now() - WINDOW_DAYS * 864e5).toISOString().replace(/\.\d+Z$/, 'Z')

// /user/repos, NOT /users/{owner}/repos. The latter returns ONLY PUBLIC repositories even when
// authenticated as that user, so the whole private fleet is silently skipped and the guard reports
// 0 billed minutes on a fleet that is billing normally. Caught on the first live run of this
// script, 2026-08-24: 218 runs found, all of them from the two public repos, billed total 0.
const repos = []
for (let page = 1; page <= 5; page++) {
  const j = await gh(`https://api.github.com/user/repos?per_page=100&page=${page}&affiliation=owner`)
  if (!j || !j.length) break
  repos.push(...j.map((r) => ({ name: r.name, private: r.private, archived: r.archived })))
  if (j.length < 100) break
}
if (!repos.length) {
  console.error('::error::the repository listing came back empty. That is a broken harness, not an empty fleet.')
  process.exit(1)
}
// The bill comes from PRIVATE repos. Seeing none of them means the token scope is wrong, not that
// the fleet is free - the exact absence-is-not-success failure this guard exists to avoid.
const privateRepos = repos.filter((r) => r.private && !r.archived)
if (!privateRepos.length) {
  console.error(`::error::listed ${repos.length} repositories and not one of them is private. The token cannot see the repos that generate the bill, so this run certifies nothing.`)
  process.exit(1)
}

// Keys are JSON arrays, not delimiter-joined strings: workflow and job names contain spaces
// ("v11 Staging Gates", "Deploy to Production"), so any single-character separator splits wrong.
const key = (...parts) => JSON.stringify(parts)
const unkey = (k) => JSON.parse(k)

const seen = new Map() // key(repo, workflow, job) -> minutes[]
const workflowsSeen = new Set()
let totalRuns = 0
let billedMinutes = 0
let freeMinutes = 0

for (const repo of repos) {
  if (repo.archived) continue
  for (let page = 1; page <= 20; page++) {
    const j = await gh(
      `https://api.github.com/repos/${OWNER}/${repo.name}/actions/runs?created=%3E%3D${encodeURIComponent(since)}&per_page=100&page=${page}`,
    )
    const runs = j?.workflow_runs || []
    for (const run of runs) {
      totalRuns++
      workflowsSeen.add(key(repo.name, run.name))
      const jj = await gh(
        `https://api.github.com/repos/${OWNER}/${repo.name}/actions/runs/${run.id}/jobs?per_page=100&filter=all`,
      )
      for (const job of jj?.jobs || []) {
        if (!job.started_at || !job.completed_at) continue
        const ms = new Date(job.completed_at) - new Date(job.started_at)
        if (ms <= 0) continue
        const min = Math.ceil(ms / 60000)
        if (repo.private) billedMinutes += min
        else freeMinutes += min
        const k = key(repo.name, run.name, job.name)
        if (!seen.has(k)) seen.set(k, [])
        seen.get(k).push(min)
      }
    }
    if (runs.length < 100) break
  }
}

// EMIT MODE: regenerate ci-budget.json from what is actually running now, instead of
// hand-maintaining 120 entries. Review the diff before committing it - this writes down
// today's behaviour as tomorrow's ceiling, so emitting while something is already too
// expensive would bless the very thing the guard exists to catch.
if (process.env.CI_BUDGET_EMIT === '1') {
  const out = {}
  for (const [k, mins] of seen) {
    const [repo, wf, job] = unkey(k)
    if (!privateRepos.some((r) => r.name === repo)) continue
    const sorted = mins.slice().sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]
    const p90 = sorted[Math.floor(sorted.length * 0.9)]
    ;((out[repo] ||= {})[wf] ||= {})[job] = {
      median,
      p90,
      ceiling_min_per_run: Math.max(3, p90 * 2),
      runs_in_window: mins.length,
    }
  }
  const next = { ...cfg, _emitted_at: new Date().toISOString(), _emitted_window_days: WINDOW_DAYS, repos: out }
  fs.writeFileSync(new URL('../ci-budget.json', import.meta.url), JSON.stringify(next, null, 2) + String.fromCharCode(10))
  let n = 0
  for (const r of Object.values(out)) for (const w of Object.values(r)) n += Object.keys(w).length
  console.log(`emitted ci-budget.json: ${n} jobs across ${Object.keys(out).length} private repos, from ${totalRuns} runs in ${WINDOW_DAYS} days`)
  process.exit(0)
}

const failures = []

// 4. absence check FIRST - a harness that saw nothing must never report a clean fleet
if (totalRuns < MIN_RUNS_EXPECTED) {
  failures.push(
    `HARNESS: only ${totalRuns} runs found in ${WINDOW_DAYS} days (expected at least ${MIN_RUNS_EXPECTED}). Treating this as a broken checker, not a quiet fleet.`,
  )
}
if (apiErrors > 0) {
  failures.push(
    `HARNESS: ${apiErrors} API calls failed, so the figures below are incomplete and this run cannot certify anything.`,
  )
}

// 1. per-job ceilings
for (const [k, mins] of seen) {
  const [repo, wf, job] = unkey(k)
  const declared = cfg.repos?.[repo]?.[wf]?.[job]
  if (!declared) continue
  const sorted = mins.slice().sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  if (median > declared.ceiling_min_per_run) {
    failures.push(
      `CEILING: ${repo} / ${wf} / ${job} median ${median} min per run over ${mins.length} runs, ceiling ${declared.ceiling_min_per_run}. ${declared._note || ''}`,
    )
  }
}

// 2. undeclared workflows
const privateNames = new Set(privateRepos.map((r) => r.name))
for (const wfKey of workflowsSeen) {
  const [repo, wf] = unkey(wfKey)
  if (!privateNames.has(repo)) continue // public repo: free on standard runners, nothing to budget
  if (!cfg.repos?.[repo]?.[wf]) {
    failures.push(
      `UNDECLARED: ${repo} / "${wf}" ran but is not in ci-budget.json. Either it is new and needs a declared ceiling, or it is a workflow that was deliberately removed and has come back.`,
    )
  }
}

// 3. projected monthly total - private repos only, public repos are free on standard runners
const projected = Math.round((billedMinutes * 30) / WINDOW_DAYS)
if (projected > cfg.monthly_minute_budget) {
  failures.push(
    `BUDGET: ${billedMinutes} billed minutes in ${WINDOW_DAYS} days. ${billedMinutes} x 30 / ${WINDOW_DAYS} = ${projected} projected for 30 days, over the declared ${cfg.monthly_minute_budget}. That is $${(projected * RATE).toFixed(2)} against $${(cfg.monthly_minute_budget * RATE).toFixed(2)}.`,
  )
}

console.log(`window            : last ${WINDOW_DAYS} days (created >= ${since})`)
console.log(`repos scanned     : ${repos.filter((r) => !r.archived).length} (${privateRepos.length} private, which are the ones that cost money)`)
console.log(`runs examined     : ${totalRuns}`)
console.log(`billed minutes    : ${billedMinutes} (private repos)   free: ${freeMinutes} (public repos)`)
console.log(
  `projected 30 days : ${billedMinutes} x 30 / ${WINDOW_DAYS} = ${projected} min = $${(projected * RATE).toFixed(2)}   budget ${cfg.monthly_minute_budget} min = $${(cfg.monthly_minute_budget * RATE).toFixed(2)}`,
)
console.log('')

if (!failures.length) {
  console.log('CI budget guard: PASS')
  process.exit(0)
}
for (const f of failures) console.log(`::error::${f}`)
console.log(`\nCI budget guard: FAIL (${failures.length})`)
process.exit(1)
