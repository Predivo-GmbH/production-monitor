#!/usr/bin/env node
/**
 * NOTHING SHIPPED FOR TOO LONG, AND NOTHING SPLIT IN TWO.
 *
 * WHY THIS EXISTS (2026-09-03). Roger, on the Deploy Status page for the fourth time in two days:
 * *"I do not want to have this fucking deploy board stale and not working properly."*
 *
 * The page was not lying. Distribution-OS had been saying "staging and production have drifted
 * apart - this needs merging, not approving" since 2026-08-04 - a month - while each branch kept
 * collecting work the other never received, production's side including a gate password rotated
 * because the previous one had reached git. Other products sat "N commits on staging that
 * production does not have" until somebody happened to look.
 *
 * So the gap was never truthfulness. It was that A DASHBOARD IS PULL: nothing went red when the
 * page was right and nobody acted. Every other class of rot here is caught by something that fails
 * on its own; this one had nothing. `check-drift.mjs` watches Supabase schema and cron drift, not
 * shipping.
 *
 * A FINDING IS FILED TO THE BOARD AND EXITS 0, exactly like every sibling sensor in monitor.yml
 * (check-deploy-failures, check-healthchecks-down, check-sentry-issues, …). Exit 1 is reserved for
 * "I could not look": no product could be read, a repo was unreadable, or a GitHub API call failed.
 * A month-old shipping backlog is a chronic board item, not something to re-red the hourly monitor
 * and re-mail Roger every hour — that was the original defect (a finding exited 1, so it rode the
 * job's failure() path into send-alert.mjs on every run and could never resolve).
 *
 * ⭐ IT COMPARES WHAT IS DEPLOYED, NOT THE BRANCH HEADS. On Distribution-OS the branch heads say
 * ahead 9 / behind 17 and the deployed commits say ahead 9 / behind 8. Both true, different
 * questions; "is production behind" is about what is LIVE. Comparing one against the other is how
 * you invent a bug that is not there - I nearly filed exactly that.
 *
 * ABSENCE IS NOT SUCCESS. If it cannot read a repo it says so and fails, rather than reporting a
 * healthy fleet it never looked at.
 */
import { readFileSync } from 'fs'
import { classifyBacklog, rank, DEFAULT_MAX_AGE_H } from './lib/promotion-backlog.mjs'
import { isAppDeployRun } from './lib/auto-promote.mjs'

// The board this files into is BackOffice's, the same one every sibling sensor writes to.
export const SOURCE = 'promotion-backlog'
const BO_REF = 'xoecpzfsskalvjrtcbbl'
const BO_BASE = `https://${BO_REF}.supabase.co`
const BO_CREDS = 'C:\\Business\\Internal Projects\\BackOffice\\docs\\Credentials.txt'
const UA = 'promotion-backlog/1.0'

const OWNER = process.env.PROMO_OWNER || 'Predivo-GmbH'

// How far back the run history is searched for a deploy job that actually SUCCEEDED.
//
// ⭐ THE 22:19Z RED (monitor run 33810988565). This sweep read backoffice fine at 22:04:58Z
// ("5 commit(s) waiting 33.5h") and called it UNREADABLE fifteen minutes later, which exits 1 and
// reds the hourly monitor. Nothing about backoffice had changed. The window was a single page of
// 30 runs of the WHOLE repo, and backoffice fires Sync Outreach, Secret Scan, IMAP Poll, edge
// deploys and staging gates all hour: at 22:19 those 30 runs reached back only to 17:47:42Z, and
// the last successful production `deploy` job was run 33786226567 at 17:43:23Z (sha 6f35d6c).
// It missed by FOUR MINUTES.
//
// The bug is the unit. A window counted in RUNS goes blind fastest on the repo that deploys most,
// because in every `Deploy` run the `deploy` job is SKIPPED on a staging push (measured on
// 33800039519 / 33797511598 / 33793868640: `deploy-staging` success, `deploy` skipped). So the one
// event being searched for is the RAREST thing in the window, and the busier the repo the further
// out of reach it gets — the sensor loses sight of production exactly where shipping matters most.
//
// Paging until it is found makes the search proportional to the answer instead of to the noise.
// The cap keeps it bounded on a shared allowance, and `exhausted` records whether the history
// genuinely ran out — because "no successful deploy job" is an inference from however far you
// looked, and a bounded look must say so rather than assert an absolute absence.
const RUNS_PER_PAGE = 100
export const MAX_RUN_PAGES = 4

// Products that ship a website to the shared host and have a staging environment.
const FLEET = (process.env.PROMO_FLEET || 'ChannelMover,ScoutCopilot,Valrano,BoatBuddy,ReplyFlow,backoffice,distribution-os,signalscore')
  .split(',').map((s) => s.trim()).filter(Boolean)

async function main() {
  const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  const MAX_AGE_H = Number(process.env.PROMO_MAX_AGE_H || DEFAULT_MAX_AGE_H)
  const dry = process.argv.includes('--dry')

  if (!TOKEN) {
    console.error('::error::no GH_TOKEN / GITHUB_TOKEN - cannot check the promotion backlog, and will not pretend the fleet is clean')
    return 1
  }

  const H = {
    Authorization: `Bearer ${TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'promotion-backlog',
  }
  let apiErrors = 0
  // WHY the last failed call failed, in the same idiom check-deploy-failures.mjs uses
  // (`GET <path> -> HTTP <status>`). Throwing this away is the 2026-09-03 20:10Z defect: see
  // describeUnreadable() below. Kept as the LAST reason rather than a list because the causes
  // that blind this sweep are fleet-wide (an empty allowance, a dead token), not per-repo.
  let lastApiError = null
  async function gh(path) {
    try {
      const r = await fetch(`https://api.github.com${path}`, { headers: H })
      if (!r.ok) { apiErrors++; lastApiError = `GET ${path} -> HTTP ${r.status}`; return null }
      return await r.json()
    } catch (e) { apiErrors++; lastApiError = `GET ${path} -> ${e.message}`; return null }
  }

  // ONE page of run history per repo, and ONE jobs read per run, shared by BOTH lookups below.
  // The prod and staging scans walk the SAME runs, so without this every app-deploy run was read
  // twice and every history page fetched twice, on a token whose allowance is shared fleet-wide.
  const pages = new Map()   // `${repo}#${page}`  -> runs[] | null   (null = that read failed)
  const jobsOf = new Map()  // `${repo}#${runId}` -> jobs[] | null
  async function runsPage(repo, page) {
    const key = `${repo}#${page}`
    if (!pages.has(key)) {
      const r = await gh(`/repos/${OWNER}/${repo}/actions/runs?per_page=${RUNS_PER_PAGE}&page=${page}`)
      pages.set(key, r?.workflow_runs || null)
    }
    return pages.get(key)
  }
  async function jobsFor(repo, runId) {
    const key = `${repo}#${runId}`
    if (!jobsOf.has(key)) {
      const j = await gh(`/repos/${OWNER}/${repo}/actions/runs/${runId}/jobs?per_page=50`)
      jobsOf.set(key, j?.jobs || null)
    }
    return jobsOf.get(key)
  }
  const lastDeployed = (repo, jobName) => findLastDeployedSha({
    getRunsPage: (page) => runsPage(repo, page),
    getJobs: (runId) => jobsFor(repo, runId),
    isWanted: isAppDeployRun,
    jobName,
  })

  const results = []
  const unreadable = []

  for (const repo of FLEET) {
    // Only an error raised while reading THIS product may be offered as this product's cause.
    const errorsBefore = apiErrors
    // isAppDeployRun, not /deploy/i: `deploy-edge-functions.yml` is named "Deploy edge functions"
    // AND its job is called `deploy`, so it satisfied both halves of the old match and, being far
    // more frequent, won the scan. This board then reported backoffice and Distribution-OS against
    // an edge-functions sha - Distribution-OS's "behind 8" on Roger's deploy page was really
    // behind 1. Measured across all eight products; only those two change.
    const prodRes = await lastDeployed(repo, 'deploy')
    const stagingRes = await lastDeployed(repo, 'deploy-staging')
    const prod = prodRes.sha
    const staging = stagingRes.sha
    if (!prod || !staging) {
      unreadable.push(describeUnreadable({
        repo, prod: !!prod, staging: !!staging, cause: apiErrors > errorsBefore ? lastApiError : null,
        // How far the half that came back EMPTY actually looked. Reporting the other half's span
        // would overstate the search that failed.
        searched: prod ? stagingRes : prodRes,
      }))
      continue
    }
    if (prod === staging) { results.push({ ...classifyBacklog({ name: repo, status: 'identical', aheadBy: 0, oldestUnshippedAt: null }, { maxAgeH: MAX_AGE_H }), repo }); continue }

    const cmpErrorsBefore = apiErrors
    const cmp = await gh(`/repos/${OWNER}/${repo}/compare/${prod}...${staging}`)
    if (!cmp) {
      unreadable.push(describeUnreadable({
        repo, prod: true, staging: true, comparing: true,
        cause: apiErrors > cmpErrorsBefore ? lastApiError : null,
      }))
      continue
    }

    // The OLDEST commit still waiting, which is what "how long has this sat" means.
    const oldest = (cmp.commits || [])[0]?.commit?.committer?.date || null
    results.push({ ...classifyBacklog({
      name: repo,
      status: cmp.status,
      aheadBy: cmp.ahead_by,
      behindBy: cmp.behind_by,
      oldestUnshippedAt: oldest,
    }, { maxAgeH: MAX_AGE_H }), repo })
  }

  const bad = rank(results)
  for (const r of results.filter((x) => x.level === 'ok')) console.log(`  ok    ${r.reason}`)
  for (const r of bad) console.log(`  ${r.level.toUpperCase().padEnd(8)} ${r.reason}`)

  if (unreadable.length) {
    console.log('')
    for (const u of unreadable) console.log(`::error::could not read shipping state for ${u}`)
  }

  console.log(`\nchecked ${results.length} product(s), ${bad.length} needing action, ${unreadable.length} unreadable`)

  // ── file findings to the board, and resolve the ones that caught up ───────────
  // A finding is a board row, not a job failure. Only "could not look" reds the run.
  if (results.length && !dry) {
    const secret = readBoSecret()
    // 'superseded' is read alongside 'open' for the same reason the sibling producers do it: the
    // board-drainer stamps a row superseded when it moves it onto the work board, and a product that
    // catches up while it sits there still has to be resolved.
    const open = await boGet(secret, `fleet_signals?source=eq.${SOURCE}&state=in.(open,superseded)&select=key`)
    const openKeys = new Set(open.map((r) => r.key))
    const redKeys = new Set(bad.map((r) => r.repo))
    const judgedKeys = new Set(results.map((r) => r.repo))   // every product we could actually read

    for (const r of bad) {
      const res = await fileSignal(secret, signalFor(r))
      console.log(`  filed ${r.repo} - ${res.will_page ? `page due ${res.page_due_at}` : `not paging (${res.suppressed ?? 'not eligible'})`}`)
    }

    // Resolve only keys THIS run judged and did not find bad — never "everything under this source
    // that is not red", the erasure trap the sibling producers document.
    for (const key of [...openKeys].filter((k) => judgedKeys.has(k) && !redKeys.has(k))) {
      await fileSignal(secret, {
        source: SOURCE, key, kind: 'incident', severity: 'info', state: 'resolved',
        title: `${key}: shipping is caught up again`,
        summary: 'The deployed commits match, or the wait is back under the threshold, so this cleared itself.',
        link: 'https://cockpit.predivo.ch/deploy',
      })
      console.log(`  recovered: ${key} - signal resolved.`)
    }
  } else if (dry) {
    console.log(`--dry: would file ${bad.length} finding(s) and resolve any caught-up rows. Nothing written.`)
  }

  // Annotations, not a job failure: these show red in the log but do NOT set failure() (exactly as
  // check-deploy-failures.mjs does), so a chronic backlog cannot re-mail Roger every hour.
  for (const r of bad) console.log(`::error::${r.reason}`)

  // EXIT 1 IS RESERVED FOR "I COULD NOT LOOK". A finding is filed above and exits 0.
  return exitCode({ readCount: results.length, unreadableCount: unreadable.length, apiErrors })
}

// ── pure helpers (importable for tests) ───────────────────────────────────────

/**
 * WHY one product's shipping state could not be read — the cause, not just the fact.
 *
 * THE DEFECT THIS FIXES (2026-09-03 20:10Z, monitor run 33800656551). The shared GitHub REST
 * allowance was empty (0/5000, reset 20:29:21Z). This sweep printed eight identical annotations,
 * `could not read shipping state for <product> (prod=unknown, staging=unknown)`, and named no
 * cause — the `gh()` closure knew the status and dropped it on the floor. Eight products reported
 * unreadable, one per line, reads exactly like eight broken deploy pipelines. The sibling sensor
 * `check-deploy-failures.mjs` failed 0.5s later on the SAME token and said, in one line,
 * `deploy-watch could not tell red from green: GET /repos/... -> HTTP 403`. That line is what made
 * the hour diagnosable; these eight contributed nothing. monitor.yml already carries this exact
 * lesson on its IMAP step — "the step that knew the real cause was the one nobody could see".
 *
 * ABSENCE OF A CAUSE IS ITSELF INFORMATION, so it gets its own sentence rather than a blank: if no
 * API call failed while reading this product, the API answered and there genuinely was no
 * successful deploy job of that name to find. That is a different problem with a different fix,
 * and the old message could not tell the two apart. Pure.
 */
/**
 * The head sha of the most recent run whose named job actually SUCCEEDED — never the run colour,
 * and never merely the most recent run that LOOKS like a deploy.
 *
 * Walks run history a page at a time and STOPS at the first success, so a repo that deploys often
 * costs one page and a repo drowning in unrelated workflow noise keeps looking instead of going
 * blind. See MAX_RUN_PAGES for the 22:19Z red that this shape exists for.
 *
 * Returns `{ sha, scanned, oldest, exhausted }`. `exhausted` is true ONLY when the repo's history
 * genuinely ended inside the cap; a null sha with `exhausted:false` means "not found this far
 * back", which is a different sentence and must stay one. Fetchers are injected so the paging is
 * testable without a network.
 */
export async function findLastDeployedSha({
  getRunsPage, getJobs, isWanted, jobName,
  maxPages = MAX_RUN_PAGES,
  // A short page is how "the history ran out" is detected, so the size the FETCHER actually asks
  // for has to be the size compared against. Reading it off a module constant instead silently
  // mislabels a bounded search as an exhausted one the moment the two disagree.
  pageSize = RUNS_PER_PAGE,
}) {
  let scanned = 0
  let oldest = null
  for (let page = 1; page <= maxPages; page++) {
    const runs = await getRunsPage(page)
    // A failed read is NOT an empty history. Bail without claiming the history ran out; the
    // caller's apiErrors counter is what turns this into a named cause.
    if (!runs) return { sha: null, scanned, oldest, exhausted: false }
    for (const run of runs) {
      scanned++
      if (run?.created_at) oldest = run.created_at
      if (!isWanted(String(run?.name || ''))) continue
      const jobs = await getJobs(run.id)
      const job = (jobs || []).find((j) => j.name === jobName)
      if (job?.conclusion === 'success') return { sha: run.head_sha, scanned, oldest, exhausted: false }
    }
    if (runs.length < pageSize) return { sha: null, scanned, oldest, exhausted: true }
  }
  return { sha: null, scanned, oldest, exhausted: false }
}

export function describeUnreadable({ repo, prod, staging, cause, comparing = false, searched = null }) {
  const what = comparing
    ? `${repo} (compare failed)`
    : `${repo} (prod=${prod ? 'ok' : 'unknown'}, staging=${staging ? 'ok' : 'unknown'})`
  if (cause) return `${what} - ${cause}`
  // HOW FAR IT LOOKED is part of the claim. The old sentence asserted a flat absence after reading
  // ONE page of 30 runs, which is how backoffice was called unreadable at 22:19Z while its
  // production deploy sat four minutes past the edge of the window.
  const span = !searched ? ''
    : searched.exhausted
      ? ` in this repo's entire run history (${searched.scanned} run(s))`
      : ` in the last ${searched.scanned} run(s)${searched.oldest ? `, back to ${searched.oldest}` : ''}`
  return `${what} - the GitHub API answered; no successful deploy job of that name was found${span}`
}

/** The board signal for one product that is behind or split. Pure. */
export function signalFor(r) {
  const title = r.level === 'diverged'
    ? `${r.repo}: staging and production have drifted apart and need merging`
    : `${r.repo}: commits have been waiting too long to go live`
  return {
    source: SOURCE,
    key: r.repo,
    kind: 'incident',
    severity: 'warning',
    state: 'open',
    // Claude promotes or merges this; it lands on /signals and never rings Roger's phone. There is
    // no signal_page_policy row for this source, so upsert_signal records it policy-off regardless.
    needs_human: false,
    title,
    summary: r.reason,
    detail: { level: r.level, age_hours: r.ageH },
    link: 'https://cockpit.predivo.ch/deploy',
  }
}

/**
 * The exit discipline every sibling sensor states in its monitor.yml comment: exit 1 ONLY when the
 * sweep could not look (nothing read, a repo unreadable, or a GitHub API call failed). A finding is
 * a filed board row and exits 0. Pure.
 */
export function exitCode({ readCount, unreadableCount, apiErrors: apiErr }) {
  return readCount === 0 || unreadableCount > 0 || apiErr > 0 ? 1 : 0
}

// ── board I/O (mirrors check-deploy-failures.mjs exactly) ─────────────────────

function readBoSecret() {
  if (process.env.BOARD_SUPABASE_SECRET) return process.env.BOARD_SUPABASE_SECRET.trim()
  if (process.env.BACKOFFICE_SERVICE_ROLE_KEY) return process.env.BACKOFFICE_SERVICE_ROLE_KEY.trim()
  const txt = readFileSync(BO_CREDS, 'utf-8')
  const m = txt.match(/sb_secret_[A-Za-z0-9_]+/)
  if (!m) throw new Error(`no sb_secret_ key found in ${BO_CREDS}`)
  return m[0]
}

async function boGet(secret, path) {
  const res = await fetch(`${BO_BASE}/rest/v1/${path}`, {
    headers: { apikey: secret, Authorization: `Bearer ${secret}`, 'User-Agent': UA },
  })
  if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`)
  return res.json()
}

async function fileSignal(secret, body) {
  const res = await fetch(`${BO_BASE}/functions/v1/signal-intake`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`signal-intake -> HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`)
  return res.json()
}

// Importable for tests; only runs the sweep when executed directly.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('check-promotion-backlog.mjs')) {
  main().then((c) => process.exit(c)).catch((e) => {
    console.error(`::error::promotion-backlog could not complete: ${e.message}`)
    process.exit(1)
  })
}
