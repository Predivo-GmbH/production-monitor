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
 *
 * SELF-HOSTED (added 2026-08-27, before this guard had ever run once).
 * This file was written on 2026-08-24. The 24 self-hosted runners moved onto the CI laptop on
 * 2026-08-24/25. The two facts never met: the original accounting was `if (repo.private)
 * billedMinutes += min`, with no test for WHERE the job ran, so every minute the fleet spends on
 * OUR OWN hardware was counted as money owed to GitHub. The real bill over the two days after
 * the move went up by 37 cents; this guard would have projected the whole fleet's workload as
 * spend and failed on it, every Monday, for ever.
 *
 * So a job is billed only when its repo is private AND it did not run on a self-hosted runner,
 * judged by `self-hosted` appearing in the job's own labels. Self-hosted minutes are still
 * REPORTED, because "how much work moved off the paid runners" is worth seeing, and they still
 * count toward the absence check, because they are real evidence the harness is seeing the
 * fleet. They just are not money. The per-job CEILING check is likewise applied only to billed
 * runs: a job that got slower on our laptop costs nothing, and failing on it would be an alarm
 * about money that was never spent.
 *
 * The near miss is the lesson. This guard was never wrong in production because it had never
 * run: it was committed at 20:41 UTC on a Monday, after its own 07:10 Monday cron, so its first
 * scheduled fire would have been the following week. It was found by asking why its heartbeat
 * check had never received a single ping.
 */
import fs from 'node:fs'
import { makeGh } from './lib/gh-budget-fetch.mjs'

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
// The retry-and-attribution loop lives in lib/gh-budget-fetch.mjs so a test can drive the exact
// give-up attribution with a stubbed fetch (see test/ci-budget-giveup.test.mjs). stats carries the
// three run-wide counters the loop mutates; the rest of this file reads them after the sweep.
const stats = { apiErrors: 0, rateLimitGiveUps: 0, quotaResetAt: 0, calls: 0, stoppedBy: null, lowestRemaining: null }
// maxCalls / reserve default inside makeGh; see the CALL CAP note there for why there are two
// limits and why tripping either must not be allowed to print PASS.
const gh = makeGh({ headers: H, stats })

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

// OUR self-hosted runners, declared rather than guessed. Read from ci-budget.json so adding a
// runner label is a config change, not a code change.
//
// GUESSING THIS WRONG IS SILENT. The first attempt at this fix tested for the label
// `self-hosted`, which is what the GitHub docs suggest and what everyone expects. Our workflows
// say `runs-on: predivo-wsl`, so the jobs API reports `labels: ["predivo-wsl"]` and nothing
// else: the test would have matched NOTHING and the guard would have gone on billing us for our
// own laptop while looking fixed. Verified 2026-08-27 by reading the live jobs API across five
// repos - GitHub-hosted jobs came back `labels:["ubuntu-latest"], runner_name:"GitHub Actions
// 1000022991"`, ours came back `labels:["predivo-wsl"], runner_name:"wsl-LAPTOP-88N97BGG-<repo>"`.
const SELF_HOSTED_LABELS = new Set(
  (cfg.self_hosted_labels || ['self-hosted', 'predivo-wsl']).map((s) => String(s).toLowerCase()),
)
const SELF_HOSTED_RUNNER_PREFIX = String(cfg.self_hosted_runner_prefix || 'wsl-').toLowerCase()

// Deliberately asymmetric: a job counts as ours only on POSITIVE identification. Anything
// unrecognised is treated as billed. For a cost guard the safe error is over-reporting spend,
// because that fails loudly, while under-reporting reports a clean fleet on a rising bill.
const isSelfHosted = (job) => {
  if (Array.isArray(job.labels) && job.labels.some((l) => SELF_HOSTED_LABELS.has(String(l).toLowerCase()))) return true
  if (job.runner_name && String(job.runner_name).toLowerCase().startsWith(SELF_HOSTED_RUNNER_PREFIX)) return true
  return false
}

const seen = new Map() // key(repo, workflow, job) -> {min, billed}[]
const workflowsSeen = new Set()
let totalRuns = 0
let privateRuns = 0   // the only runs that can prove the harness saw the repos that GENERATE the bill
let billedMinutes = 0
let freeMinutes = 0
let selfHostedMinutes = 0   // private-repo work that runs on our own laptop, so GitHub bills none of it

// WHERE THE MONEY GOES, per workflow. The guard used to report one fleet-wide total and nothing
// else, so every red run began with the same manual investigation: re-crawl 3600 runs by hand to
// find which workflow actually grew. The total tells you THAT you are over budget; it never tells
// you what to cut, which is the only decision the alert exists to prompt. Printed on every run,
// pass or fail, so a line that is climbing is visible BEFORE it breaches rather than after.
const wfBilled = new Map() // key(repo, workflow) -> {billed, selfHosted, jobs}

// PASS 1: list the runs. Cheap - one call per 100 runs.
const pending = [] // {repo, run}
for (const repo of repos) {
  if (repo.archived) continue
  for (let page = 1; page <= 20; page++) {
    const j = await gh(
      `https://api.github.com/repos/${OWNER}/${repo.name}/actions/runs?created=%3E%3D${encodeURIComponent(since)}&per_page=100&page=${page}`,
    )
    const runs = j?.workflow_runs || []
    for (const run of runs) {
      totalRuns++
      if (repo.private) privateRuns++
      workflowsSeen.add(key(repo.name, run.name))
      pending.push({ repo, run })
    }
    if (runs.length < 100) break
  }
}

// PASS 2: the expensive half - ONE jobs call per run, and there is no cheaper aggregate
// (/actions/runs/{id}/timing returns 0 on this account, see BILLING MODEL above).
//
// WHY THIS IS A POOL AND NOT A LOOP (2026-08-27). Serially, this step could not finish inside
// the workflow's own `timeout-minutes: 30`: the first manual run started 09:46:32Z and was
// killed at 10:16:54Z, thirty minutes and twenty-two seconds later, still on this step. A
// 2-day window alone examined 681 runs, so the scheduled 7-day window is roughly three and a
// half times that. Quota was never the problem - the primary limit is 5000 requests an hour and
// a 7-day sweep needs around 2400 - it was WALL CLOCK, one round trip at a time.
//
// Concurrency is kept low on purpose. GitHub's SECONDARY limit punishes bursts regardless of
// remaining quota, and gh() already backs off on 403/429, so a big pool would spend its time
// sleeping. Shared counters are safe: JavaScript runs this on one thread, and only complete
// awaits interleave.
const CONCURRENCY = Number(process.env.CI_BUDGET_CONCURRENCY || 6)
let nextIdx = 0
const consumeJobs = async () => {
  while (nextIdx < pending.length) {
    const { repo, run } = pending[nextIdx++]
    const jj = await gh(
      `https://api.github.com/repos/${OWNER}/${repo.name}/actions/runs/${run.id}/jobs?per_page=100&filter=all`,
    )
    for (const job of jj?.jobs || []) {
      if (!job.started_at || !job.completed_at) continue
      const ms = new Date(job.completed_at) - new Date(job.started_at)
      if (ms <= 0) continue
      const min = Math.ceil(ms / 60000)
      // A job on OUR OWN hardware costs nothing, whatever repo it belongs to. See SELF-HOSTED
      // in the header: without this test the guard bills us for our own laptop.
      const billed = repo.private && !isSelfHosted(job)
      if (billed) billedMinutes += min
      else if (repo.private) selfHostedMinutes += min
      else freeMinutes += min
      if (repo.private) {
        const wk = key(repo.name, run.name)
        const e = wfBilled.get(wk) || { billed: 0, selfHosted: 0, jobs: 0 }
        if (billed) e.billed += min
        else e.selfHosted += min
        e.jobs++
        wfBilled.set(wk, e)
      }
      const k = key(repo.name, run.name, job.name)
      if (!seen.has(k)) seen.set(k, [])
      seen.get(k).push({ min, billed })
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, consumeJobs))

// EMIT MODE: regenerate ci-budget.json from what is actually running now, instead of
// hand-maintaining 120 entries. Review the diff before committing it - this writes down
// today's behaviour as tomorrow's ceiling, so emitting while something is already too
// expensive would bless the very thing the guard exists to catch.
if (process.env.CI_BUDGET_EMIT === '1') {
  const out = {}
  for (const [k, mins] of seen) {
    const [repo, wf, job] = unkey(k)
    if (!privateRepos.some((r) => r.name === repo)) continue
    // Ceilings are declared from BILLED runs only, for the same reason the check reads them that
    // way. A job that runs solely on our own hardware still gets an entry, so it is never later
    // reported as an undeclared workflow, but its ceiling is marked as not a cost ceiling.
    const billedRuns = mins.filter((m) => m.billed).map((m) => m.min)
    const sorted = (billedRuns.length ? billedRuns : mins.map((m) => m.min)).slice().sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]
    const p90 = sorted[Math.floor(sorted.length * 0.9)]
    ;((out[repo] ||= {})[wf] ||= {})[job] = {
      median,
      p90,
      ceiling_min_per_run: Math.max(3, p90 * 2),
      runs_in_window: mins.length,
      billed_runs_in_window: billedRuns.length,
      ...(billedRuns.length ? {} : { _note: 'runs only on self-hosted runners in this window, so this ceiling is not a cost ceiling' }),
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
// COUNTED ON PRIVATE REPOS TOO (2026-09-01 audit). `totalRuns` counted every repository, and the
// two PUBLIC ones are the busiest we own - production-monitor alone runs a */10 watchdog - so this
// guard's own founding incident, quoted in the header ("218 runs found, all of them from the two
// public repos, billed total 0"), sailed straight through a floor of 100. Free minutes prove
// nothing about the bill. The floor on private runs is deliberately ZERO rather than a number
// nobody has measured: seeing not one run in any private repo means the harness read nothing that
// can cost money, and that is never a clean result. Raise it once the real weekly figure is known.
if (privateRuns === 0 && privateRepos.length) {
  failures.push(
    `HARNESS: not one run was read in any of the ${privateRepos.length} private repo(s) over ${WINDOW_DAYS} days, while ${totalRuns} runs were seen in total - all of them in public repos, which are free and say nothing about the bill. Treating this as a broken checker, not a quiet fleet.`,
  )
}
if (totalRuns < MIN_RUNS_EXPECTED) {
  failures.push(
    `HARNESS: only ${totalRuns} runs found in ${WINDOW_DAYS} days (expected at least ${MIN_RUNS_EXPECTED}). Treating this as a broken checker, not a quiet fleet.`,
  )
}
if (stats.apiErrors > 0) {
  failures.push(
    `HARNESS: ${stats.apiErrors} API calls failed, so the figures below are incomplete and this run cannot certify anything.`,
  )
}
// The guard's OWN safety cap tripped. Its own line, because the remedy is different from every
// other harness failure here: nothing is broken, this run simply refused to spend the rest of the
// fleet's API hour on itself. Narrow the window or wait for the refill - do NOT raise the cap to
// make the red go away, which would restore exactly the 2026-08-29 behaviour it exists to prevent.
if (stats.stoppedBy) {
  const [kind] = stats.stoppedBy.split(':')
  const why = kind === 'maxcalls'
    ? `this run hit its own per-run ceiling of ${stats.stoppedBy.split(':')[1]} API calls`
    : `the shared GitHub hour was down to ${stats.lowestRemaining} calls and this run stood down to leave the rest for the fleet`
  failures.push(
    `HARNESS: the sweep was stopped early because ${why}. It made ${stats.calls} calls and the figures below are INCOMPLETE, so this run certifies nothing. On 2026-08-29 three back-to-back dispatches of this guard took the fleet allowance to 0/5000 and everything else that needed the API that hour stopped; that is what this limit prevents. Re-run with a smaller CI_BUDGET_WINDOW_DAYS, or after the quota refills. Do not raise the cap to clear this.`,
  )
}
// Separate line, separate wording: an empty API hour is a scheduling problem with a known
// remedy (wait for the refill), not evidence that the fleet or the checker is broken. Saying
// "N API calls failed" for this sent the 2026-08-29 investigation into the code for nothing.
if (stats.rateLimitGiveUps > 0) {
  const when = stats.quotaResetAt ? new Date(stats.quotaResetAt).toISOString().replace(/\.\d+Z$/, 'Z') : 'unknown'
  failures.push(
    `HARNESS: the GitHub API hour ran out and ${stats.rateLimitGiveUps} calls were abandoned, so the figures below are incomplete and this run cannot certify anything. This is a quota problem, not a broken fleet: a full sweep needs roughly 2400 calls against a 5000/hour limit, so back-to-back manual re-runs exhaust it. Quota refills at ${when}; re-run after that.`,
  )
}

// 1. per-job ceilings
for (const [k, mins] of seen) {
  const [repo, wf, job] = unkey(k)
  const declared = cfg.repos?.[repo]?.[wf]?.[job]
  if (!declared) continue
  // Only BILLED runs of this job can breach a cost ceiling. A job that got slower on our own
  // laptop costs nothing, and failing on it would be an alarm about money that was never spent.
  const billedRuns = mins.filter((m) => m.billed).map((m) => m.min)
  if (!billedRuns.length) continue
  const sorted = billedRuns.slice().sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  if (median > declared.ceiling_min_per_run) {
    failures.push(
      `CEILING: ${repo} / ${wf} / ${job} median ${median} min per run over ${billedRuns.length} BILLED runs, ceiling ${declared.ceiling_min_per_run}. ${declared._note || ''}`,
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
// Printed on EVERY run, pass or fail. What this guard costs the shared API hour was invisible
// until it had already emptied it; a number that is climbing towards the cap should be readable
// before it trips, not only in the failure that says it did.
console.log(
  `github api calls  : ${stats.calls}${stats.lowestRemaining !== null ? `   (lowest remaining on the shared 5000/hour: ${stats.lowestRemaining})` : ''}${stats.stoppedBy ? `   STOPPED EARLY: ${stats.stoppedBy}` : ''}`,
)
console.log(`billed minutes    : ${billedMinutes} (private repos on GitHub-hosted runners)`)
console.log(`free minutes      : ${freeMinutes} (public repos)   ${selfHostedMinutes} (private repos on our own runners)`)
console.log(
  `projected 30 days : ${billedMinutes} x 30 / ${WINDOW_DAYS} = ${projected} min = $${(projected * RATE).toFixed(2)}   budget ${cfg.monthly_minute_budget} min = $${(cfg.monthly_minute_budget * RATE).toFixed(2)}`,
)

// Ranked by BILLED minutes only - the self-hosted column is shown beside it because "this
// workflow is huge but costs nothing" and "this workflow is huge and we pay for it" look
// identical in a minutes total, and only the second one is a thing to act on.
const ranked = [...wfBilled.entries()]
  .map(([k, v]) => ({ ...v, name: unkey(k).join(' / ') }))
  .filter((w) => w.billed > 0)
  .sort((a, b) => b.billed - a.billed)
if (ranked.length) {
  console.log(`top billed workflows (of ${ranked.length} that cost anything):`)
  for (const w of ranked.slice(0, 15)) {
    const share = billedMinutes ? Math.round((w.billed / billedMinutes) * 100) : 0
    const perMonth = ((w.billed * 30) / WINDOW_DAYS) * RATE
    console.log(
      `  ${String(w.billed).padStart(5)} min  ${String(share).padStart(2)}%  $${perMonth.toFixed(2).padStart(7)}/mo  ${w.name}` +
        (w.selfHosted ? `   (+${w.selfHosted} min free on our own runners)` : ''),
    )
  }
}
console.log('')

if (!failures.length) {
  console.log('CI budget guard: PASS')
  process.exit(0)
}
for (const f of failures) console.log(`::error::${f}`)
console.log(`\nCI budget guard: FAIL (${failures.length})`)
process.exit(1)
