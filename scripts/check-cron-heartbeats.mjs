#!/usr/bin/env node
/**
 * Fleet pg_cron heartbeat — the dead-man's switch for every product's scheduled jobs.
 *
 * The products' own watchdogs (e.g. ReplyFlow monitor-sync-health) detect and
 * auto-fix their domain problems — but a watchdog that STOPS RUNNING is
 * indistinguishable from health from the inside. This check asks each prod
 * Supabase project, from the outside: "did every active cron job actually run
 * (and succeed) recently?" — where "recently" is derived from the job's own
 * schedule (3× its interval, with floors), so only a PERSISTENTLY dead job
 * fires, never a single missed tick (alerting philosophy 2026-07-23:
 * auto-fix first, alert only what stays broken, transient = noise).
 *
 * Healing stays product-local by design — this layer only answers
 * "is anyone watching the watchers?". Nightly; a red run IS the alert
 * (send-heartbeat-alert.mjs mails the findings), so max one email/day.
 *
 * ── LAYER 2: 'succeeded' IS NOT PROOF OF DELIVERY (added 2026-09-01) ─────────
 *
 * This file used to carry the note: "Known limitation: net.http_post-based crons
 * count as 'succeeded' once the HTTP call is dispatched, even if the edge function
 * errors — function-level failures are the product watchdogs' job, not this one."
 *
 * That limitation had swallowed a real, invisible outage. `net.http_post` only
 * ENQUEUES; the cron job is marked 'succeeded' whatever the HTTP call later
 * returns. Measured on BackOffice production 2026-08-25: **3 × HTTP 401
 * `{"error":"Unauthorized"}` against 106 × 200 in the same six-hour window, and
 * every one of the 401 jobs was reporting `succeeded`.** Four daily jobs had been
 * failing that way for weeks with nothing to see.
 *
 * It matters far more than "the product watchdogs' job", because since 2026-08-25
 * the fleet's PAGER itself runs this way: pg_cron job `signal-sweep-5min` on
 * BackOffice production POSTs {"action":"sweep"} to the signal-intake edge
 * function every five minutes, reading its bearer from `vault.decrypted_secrets`
 * at run time. That job is what delivers an alert when Roger's PC is off. If the
 * Vault secret is rotated, or the function's key changes, the sweep starts
 * answering 401 and NOTHING notices — `job_run_details` says `succeeded` forever.
 * Measured 2026-09-01: 288 consecutive `succeeded` rows in 24 hours, which is
 * exactly what a totally dead pager would also show. The weekly fire drill does
 * not cover it either: the drill calls the sweep ITSELF with its own secret, so it
 * proves the delivery channels and never proves that pg_cron can reach them.
 *
 * `net._http_response` is the ONLY table that knows. So this check now reads it.
 * Three distinct ways the cloud pager can quietly stop, and where each is caught:
 *   1. pg_cron stops firing          → layer 1, the last-success age above.
 *   2. pg_net enqueues, nothing sends → layer 2, zero responses in the window.
 *   3. the call is made and REFUSED   → layer 2, a non-2xx status code.
 *
 * Two disciplines carried over deliberately:
 *   * A FAILED READ IS NEVER A CLEAN RESULT. If the response table cannot be read,
 *     or the window is too short to judge, that is `unverifiable`, never OK.
 *   * ONLY WHAT STAYS BROKEN FIRES. A 5xx or a timeout is transient-capable, so it
 *     needs PERSISTENT_FAILURES of them before it counts. 401/403/404 are not
 *     transient — a refused credential and a wrong route do not heal themselves —
 *     so a single one is a finding. That is the exact shape of the 3-in-106 fault.
 *
 * The counts are labelled for what they actually count: `net._http_response` is
 * per-DATABASE, shared by every pg_net caller on it, not only the cron jobs. This
 * layer therefore says "HTTP calls this database made", never "this job's calls".
 *
 * HOW MUCH OF THE DAY THIS LAYER ACTUALLY SEES, stated rather than implied. pg_net
 * keeps responses for about six hours, and this workflow runs once a night, so layer
 * 2 inspects a SIX-HOUR SAMPLE of each twenty-four. That is deliberate and it is the
 * right trade: the faults it is built for — a rotated Vault key, a dead pg_net worker,
 * a wrong route — are PERSISTENT, so they are still failing at 05:07 the next morning
 * and are caught within a day of starting, against the "never" it was before. A fault
 * that begins and ends between two runs is invisible to it, which is the same
 * transient-is-noise rule layer 1 already applies. Running this every six hours would
 * close the sample gap, and would also mail a standing breakage four times a day
 * instead of once, which is how an alarm gets muted. If that trade is ever revisited,
 * the alerting cadence has to be separated from the reading cadence first.
 *
 * Uses the Supabase Management API query endpoint with per-product PATs
 * (same contract as check-drift.mjs). Read-only. Projects without pg_cron
 * (LaunchReady, Distribution-OS, BoatBuddy, Beize Jass, ScoutCopilot as of
 * 2026-07-23) are deliberately absent.
 */

import { writeFileSync } from 'node:fs'

const PRODUCTS = [
  { name: 'ReplyFlow',    patEnv: 'SUPABASE_TOKEN_REPLYFLOW',    ref: 'dqmhsdzldkxngwjrxois' },
  { name: 'BackOffice',   patEnv: 'SUPABASE_TOKEN_BACKOFFICE',   ref: 'xoecpzfsskalvjrtcbbl' },
  { name: 'SignalScore',  patEnv: 'SUPABASE_TOKEN_MUELLER',      ref: 'ogdpgufptemcgyszmjek' },
  { name: 'ChannelMover', patEnv: 'SUPABASE_TOKEN_CHANNELMOVER', ref: 'qswluvqunswggfmesdcs' },
  { name: 'Arivioo',      patEnv: 'SUPABASE_TOKEN_ARIVIOO',      ref: 'iooexkbuxmeryeuzpxau' },
  { name: 'Valrano',      patEnv: 'SUPABASE_TOKEN_VALRANO',      ref: 'mkdeftmubrkseyrrbzvp' },
]

// One row per active job: schedule + most recent success + most recent outcome, plus
// whether the job's command dispatches an HTTP call (which is what makes its
// 'succeeded' status meaningless on its own — see LAYER 2 in the header).
// job_run_details is bounded to 35 days so the aggregate stays cheap even on
// */2-minute jobs; 35d still covers a monthly job's largest legitimate gap.
const HEARTBEAT_SQL = `
  select j.jobname, j.schedule,
    (j.command ilike '%net.http_post%') as uses_http_post,
    max(d.start_time) filter (where d.status = 'succeeded') as last_success,
    max(d.start_time) as last_run,
    (select d2.status || coalesce(': ' || left(d2.return_message, 200), '')
       from cron.job_run_details d2
      where d2.jobid = j.jobid order by d2.start_time desc limit 1) as last_result
  from cron.job j
  left join cron.job_run_details d
    on d.jobid = j.jobid and d.start_time > now() - interval '35 days'
  where j.active
  group by j.jobid, j.jobname, j.schedule, j.command
  order by j.jobname`

/**
 * What the dispatched HTTP calls actually RETURNED, from pg_net's own response table.
 * One aggregate row. `bad_codes` names the distinct offending statuses so the finding
 * says 401 rather than "something was not 200".
 *
 * Note `status_code IS NULL` counts as bad: pg_net writes a row with no status when
 * the request never completed. A missing answer is not a passing answer.
 */
const HTTP_OUTCOME_SQL = `
  select count(*)::int as calls,
         count(*) filter (where status_code between 200 and 299)::int as ok,
         count(*) filter (where status_code is null or status_code < 200 or status_code >= 300)::int as bad,
         count(*) filter (where status_code in (401, 403, 404))::int as refused,
         count(*) filter (where timed_out)::int as timed_out,
         count(*) filter (where error_msg is not null)::int as errored,
         min(created) as oldest, max(created) as newest,
         (select string_agg(distinct coalesce(status_code::text, 'no-response'), ', ')
            from net._http_response
           where status_code is null or status_code < 200 or status_code >= 300) as bad_codes
  from net._http_response`

/**
 * pg_net keeps `net._http_response` for six hours by default (`net.ttl`), and the
 * BackOffice window measured 2026-09-01 was 5.998h, so this is the real number and
 * not a guess. It decides ONE thing: whether "no rows at all" is a fact about the
 * fleet or a fact about the window being too short to hold anything.
 */
export const RESPONSE_RETENTION_MS = 6 * 3600_000

/** How many transient-capable failures (5xx, timeouts, refused connections) it takes
 *  before this stops being a blip. Same spirit as layer 1's 3× interval rule. */
export const PERSISTENT_FAILURES = 3

/** The raw interval a cron schedule implies, in ms — NOT layer 1's 3x allowance.
 *  Used only to decide whether a job is fast enough that it MUST have left a trace
 *  inside the response table's short retention window. */
export function scheduleIntervalMs(schedule) {
  const parts = String(schedule).trim().split(/\s+/)
  if (parts.length !== 5) return 24 * 3600_000
  const [min, hour, dom, , dow] = parts
  const every = (f) => { const m = /^\*\/(\d+)$/.exec(f); return m ? parseInt(m[1], 10) : null }
  // '2-59/5' and '*/5' both mean every five minutes; the range form is what
  // migration 135 used for signal-sweep-5min, and a parser that only knew '*/n'
  // would have called the fleet pager a daily job and never demanded a trace.
  const step = (f) => { const m = /^(?:\*|\d+-\d+)\/(\d+)$/.exec(f); return m ? parseInt(m[1], 10) : null }
  const eMin = step(min) ?? every(min)
  if (eMin) return eMin * 60_000
  const eHour = step(hour) ?? every(hour)
  if (eHour) return eHour * 3600_000
  if (hour === '*') return 3600_000            // hourly at a fixed minute
  if (dom !== '*') return 30 * 24 * 3600_000   // monthly
  if (dow !== '*') return 7 * 24 * 3600_000    // weekly
  return 24 * 3600_000                         // daily
}

/**
 * THE WHOLE LAYER-2 DECISION, pure and testable: given what pg_net recorded and which
 * cron jobs dispatch HTTP, is the delivery path working, broken, or unjudgeable?
 *
 * @param {{stats: object|null, queryError: string|null, httpPostSchedules: string[]}} input
 * @returns {{verdict: 'ok'|'dead'|'unverifiable'|'not-applicable', detail: string}}
 */
export function httpDeliveryVerdict({ stats, queryError, httpPostSchedules }) {
  if (!httpPostSchedules.length) {
    return { verdict: 'not-applicable', detail: 'no active cron job on this database dispatches an HTTP call' }
  }
  // A read that did not happen is not a read that came back clean. This is the same
  // rule as layer 1's "Management API query failed" branch and it is the reason the
  // whole check can be trusted: nothing here has a silent path to OK.
  if (queryError) {
    return { verdict: 'unverifiable', detail: `could not read net._http_response (${queryError}) — so whether the dispatched calls are being answered is unknown, which is never "fine"` }
  }
  if (!stats || typeof stats.calls !== 'number') {
    return { verdict: 'unverifiable', detail: 'net._http_response returned no aggregate row, so nothing could be judged' }
  }

  const fastest = Math.min(...httpPostSchedules.map(scheduleIntervalMs))

  if (stats.calls === 0) {
    // Fast enough that the retention window must contain several of its calls. Zero
    // means the calls are not being made or not being recorded: pg_net's background
    // worker is not running, and every http_post cron on this database is a no-op
    // while `job_run_details` cheerfully reports 'succeeded'.
    if (fastest * 2 <= RESPONSE_RETENTION_MS) {
      return { verdict: 'dead', detail: `pg_net recorded ZERO HTTP responses in its ~${(RESPONSE_RETENTION_MS / 3600_000).toFixed(0)}h retention window, but a cron job dispatches one every ${fmtAge(fastest)}. The calls are being enqueued and never sent (or never recorded), so every http_post cron here is silently doing nothing while cron.job_run_details reports 'succeeded'.` }
    }
    return { verdict: 'unverifiable', detail: `no HTTP responses inside pg_net's ~${(RESPONSE_RETENTION_MS / 3600_000).toFixed(0)}h retention window; the fastest http_post cron runs every ${fmtAge(fastest)}, so an empty window proves nothing either way` }
  }

  const refused = stats.refused || 0
  const transient = (stats.bad || 0) - refused

  if (refused > 0) {
    // 401/403/404 do not heal themselves. One is a finding. This is the exact fault
    // that hid for weeks: 3 × 401 among 106 × 200, every job reporting 'succeeded'.
    return { verdict: 'dead', detail: `${refused} of ${stats.calls} HTTP calls this database dispatched were REFUSED (status ${stats.bad_codes ?? 'unknown'}). A refused credential or a wrong route does not recover on its own, and cron.job_run_details still reports these as 'succeeded'. If signal-sweep-5min is among them, the fleet pager is not delivering.` }
  }
  if (transient >= PERSISTENT_FAILURES) {
    return { verdict: 'dead', detail: `${transient} of ${stats.calls} HTTP calls this database dispatched failed (status ${stats.bad_codes ?? 'unknown'}; ${stats.timed_out || 0} timed out, ${stats.errored || 0} errored). Past ${PERSISTENT_FAILURES} in one window this is no longer a blip.` }
  }
  if (transient > 0) {
    return { verdict: 'ok', detail: `${stats.ok} of ${stats.calls} dispatched HTTP calls answered 2xx; ${transient} transient failure(s) (${stats.bad_codes}), under the ${PERSISTENT_FAILURES} needed to count` }
  }
  return { verdict: 'ok', detail: `all ${stats.calls} HTTP calls this database dispatched in the last ~${(RESPONSE_RETENTION_MS / 3600_000).toFixed(0)}h answered 2xx` }
}

/** Max tolerated age of the last SUCCESSFUL run, derived from the cron schedule.
 *  3× the interval (with floors) = several consecutive misses, never one blip. */
export function allowanceMs(schedule) {
  const parts = String(schedule).trim().split(/\s+/)
  if (parts.length !== 5) return 26 * 3600_000 // unrecognized → treat as daily
  const [min, hour, dom, , dow] = parts
  const every = (f) => { const m = /^\*\/(\d+)$/.exec(f); return m ? parseInt(m[1], 10) : null }
  const eMin = every(min)
  if (eMin) return Math.max(3 * eMin, 90) * 60_000          // */n min → ≥90 min
  const eHour = every(hour)
  if (eHour) return Math.max(3 * eHour, 12) * 3600_000      // every k hours
  if (hour === '*') return 3 * 3600_000                     // hourly at fixed minute
  if (dom !== '*') return 33 * 24 * 3600_000                // monthly
  if (dow !== '*') return 8 * 24 * 3600_000                 // weekly
  return 26 * 3600_000                                      // daily
}

function fmtAge(ms) {
  if (ms == null) return 'never'
  const h = ms / 3600_000
  if (h < 1) return `${Math.round(ms / 60_000)}min`
  return h < 48 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)}d`
}

/**
 * LAYER 1, made explicit and testable: is this job's last SUCCESS recent enough for its
 * own schedule — and, when it is not, WHY.
 *
 * WHY THIS IS A FUNCTION AND NOT THREE LINES INSIDE THE LOOP (2026-09-01). The console
 * line stopped at `DEAD affiliate-monitor-daily [0 7 * * *] last success 37.4h ago >
 * allowed 26.0h`. The two fields that answer the only question that follows — did pg_cron
 * ATTEMPT it, and what did the attempt say — were already being read by HEARTBEAT_SQL,
 * folded into the finding, and then left the machine by email and nowhere else. The
 * runbook's first diagnostic step is "download the failed run's logs", so the evidence was
 * missing from the first place anyone looks. Measured that night on run 33555239704: three
 * findings, and the log could not tell any of them apart.
 *
 * `last_run` is the field that separates the two very different failures that both arrive
 * as "no recent success":
 *   * a run happened and did not succeed  → pg_cron is fine, the JOB is broken, and
 *     `last_result` carries the database's own error message.
 *   * no run was ever recorded            → pg_cron never attempted it. On a database
 *     whose other jobs are ticking, that means the job is younger than its first tick,
 *     not that it has been dead for weeks — a distinction the old line erased, and the
 *     reason BackOffice's freshly scheduled `product-check-run-prune-daily` read exactly
 *     like a job that had been failing since July.
 *
 * Pure: no clock, no network. `nowMs` is passed in so a test can place the facts in time.
 *
 * @param {{jobname: string, schedule: string, last_success: string|null, last_run: string|null, last_result: string|null}} row
 * @param {number} nowMs
 * @returns {{verdict: 'ok'|'dead', neverRan: boolean, detail: string}}
 */
export function jobVerdict(row, nowMs) {
  const allow = allowanceMs(row.schedule)
  const lastSuccess = row.last_success ? new Date(row.last_success).getTime() : null
  const age = lastSuccess == null ? null : nowMs - lastSuccess

  if (age != null && age <= allow) {
    return { verdict: 'ok', neverRan: false, detail: `last success ${fmtAge(age)} ago` }
  }

  // Never attempted. Say that, rather than "last success never ago", which reads as a
  // job that has been failing forever and is the same sentence for a job added an hour ago.
  if (!row.last_run) {
    return {
      verdict: 'dead',
      neverRan: true,
      detail: `NEVER RUN — cron.job_run_details holds no attempt at all for this job (allowed ${fmtAge(allow)} between successes). Either it was scheduled after its most recent tick was due — check whether the previous heartbeat run knew this job at all — or pg_cron is not firing it.`,
    }
  }

  return {
    verdict: 'dead',
    neverRan: false,
    detail: `last success ${fmtAge(age)} ago (allowed ${fmtAge(allow)}); last run ${row.last_run}; last result: ${row.last_result ?? 'none in 35d'}`,
  }
}

/** Management API query with retries — api.supabase.com intermittently 502s
 *  (observed 2026-07-23); a transient gateway blip must not page anyone. */
async function query(ref, pat, sql) {
  let lastErr
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: sql }),
        signal: AbortSignal.timeout(30_000),
      })
      const text = await res.text()
      if (res.ok && !text.startsWith('<')) return JSON.parse(text)
      lastErr = new Error(`HTTP ${res.status}: ${text.slice(0, 150)}`)
    } catch (e) {
      lastErr = e
    }
    if (attempt < 4) await new Promise((r) => setTimeout(r, attempt * 5000))
  }
  throw lastErr
}

async function main() {
  const findings = []
  const now = Date.now()

  for (const { name, patEnv, ref } of PRODUCTS) {
    console.log(`\n== ${name} (${ref})`)
    const pat = process.env[patEnv]
    if (!pat) {
      findings.push({ product: name, job: '(all)', schedule: '', problem: 'unverifiable', detail: `env ${patEnv} not set — heartbeats cannot be checked` })
      console.error(`  UNVERIFIABLE env ${patEnv} not set`)
      continue
    }
    let rows
    try {
      rows = await query(ref, pat, HEARTBEAT_SQL)
    } catch (e) {
      findings.push({ product: name, job: '(all)', schedule: '', problem: 'unverifiable', detail: `Management API query failed after retries: ${e.message}` })
      console.error(`  UNVERIFIABLE ${e.message}`)
      continue
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      // A cron-bearing product losing ALL its jobs would be a real incident, but a
      // legitimately emptied project shouldn't page forever — flag it as dead.
      findings.push({ product: name, job: '(all)', schedule: '', problem: 'dead', detail: 'no active cron jobs found — expected at least one (remove the product from check-cron-heartbeats.mjs if intentional)' })
      console.error('  DEAD no active cron jobs found')
      continue
    }
    for (const r of rows) {
      const v = jobVerdict(r, now)
      if (v.verdict === 'ok') {
        console.log(`  OK   ${r.jobname} [${r.schedule}] ${v.detail}${r.uses_http_post ? ' (dispatches HTTP — see delivery line below)' : ''}`)
      } else {
        findings.push({ product: name, job: r.jobname, schedule: r.schedule, problem: 'dead', detail: v.detail })
        // The SAME detail that goes in the email goes in the log. An alert whose evidence
        // only exists in someone's inbox is an alert nobody can act on from the run page.
        console.error(`  DEAD ${r.jobname} [${r.schedule}] ${v.detail}`)
      }
    }

    // ── LAYER 2 ─────────────────────────────────────────────────────────────
    // Every 'succeeded' printed above is, for an http_post job, a statement about
    // the ENQUEUE and nothing else. Ask pg_net what the calls actually returned.
    const httpPostSchedules = rows.filter((r) => r.uses_http_post).map((r) => r.schedule)
    let stats = null, queryError = null
    if (httpPostSchedules.length) {
      try {
        const out = await query(ref, pat, HTTP_OUTCOME_SQL)
        stats = Array.isArray(out) ? out[0] : null
      } catch (e) {
        queryError = e.message
      }
    }
    const delivery = httpDeliveryVerdict({ stats, queryError, httpPostSchedules })
    if (delivery.verdict === 'not-applicable') {
      // Say nothing: a database with no http_post cron has no delivery path to judge.
    } else if (delivery.verdict === 'ok') {
      console.log(`  OK   HTTP delivery — ${delivery.detail}`)
    } else {
      findings.push({
        product: name,
        job: `(${httpPostSchedules.length} http_post cron job(s))`,
        schedule: '',
        problem: delivery.verdict,
        detail: delivery.detail,
      })
      console.error(`  ${delivery.verdict.toUpperCase()} HTTP delivery — ${delivery.detail}`)
    }
  }

  writeFileSync('heartbeat-findings.json', JSON.stringify(findings, null, 2))

  if (findings.length > 0) {
    console.error(`\n${findings.length} heartbeat finding(s) — failing the run (the red run is the alert).`)
    return 1
  }
  console.log('\nAll fleet cron heartbeats healthy, and every dispatched HTTP call was answered.')
  return 0
}

if (import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1] || '').href) {
  main().then(
    (code) => { process.exitCode = code },
    (e) => {
      console.error(`::error::the cron heartbeat check could NOT run (${e.message}). Unknown is not healthy.`)
      process.exitCode = 1
    },
  )
}
