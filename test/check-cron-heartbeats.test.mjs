/**
 * Defect-injected tests for the fleet pg_cron heartbeat, layer 2 — "did the dispatched
 * HTTP call actually get answered?"
 *
 * WHY THIS FILE EXISTS. The check it covers carried this in its own header for over a
 * month: "Known limitation: net.http_post-based crons count as 'succeeded' once the HTTP
 * call is dispatched, even if the edge function errors." Since 2026-08-25 the fleet's
 * PAGER runs exactly that way (`signal-sweep-5min` on BackOffice production), so the
 * known limitation had quietly become "nothing would tell us if the alarm stopped".
 *
 * Every case below injects the failure the check claims to catch, and each one is first
 * run through OLD_verdict — a faithful reconstruction of what the check did BEFORE this
 * layer existed — to prove the old code said OK on the very same facts. A test that only
 * exercises the new code proves the new code runs, not that it catches anything.
 *
 * Run: node test/check-cron-heartbeats.test.mjs   (exit 0 = all pass)
 */
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import {
  httpDeliveryVerdict, scheduleIntervalMs, RESPONSE_RETENTION_MS, PERSISTENT_FAILURES,
  msSinceLastFire, deliveryCoverage,
  jobVerdict, allowanceMs, attributionClause, ATTRIBUTION_WINDOW_SEC,
} from '../scripts/check-cron-heartbeats.mjs'

let n = 0
const t = (name, fn) => { fn(); n++; console.log(`  ok - ${name}`) }

const NOW = Date.parse('2026-09-01T18:00:00Z')
const agoMin = (m) => new Date(NOW - m * 60000).toISOString()

/**
 * THE OLD CHECK, reconstructed exactly: last SUCCESSFUL run within 3x the interval.
 * It never looked at net._http_response, so its answer depends only on job_run_details.
 * pg_cron marks an http_post job 'succeeded' the instant the call is ENQUEUED, so this
 * returns OK for a pager that has not delivered anything in weeks.
 */
function OLD_verdict(job) {
  const allowMs = 3 * scheduleIntervalMs(job.schedule)
  const age = NOW - Date.parse(job.last_success)
  return age <= Math.max(allowMs, 90 * 60_000) ? 'OK' : 'DEAD'
}

/** The real shape: the fleet pager, ticking perfectly, every call refused. */
const PAGER_SUCCEEDING_IN_CRON = {
  jobname: 'signal-sweep-5min',
  schedule: '2-59/5 * * * *',
  uses_http_post: true,
  last_success: agoMin(3),      // three minutes ago: pg_cron could not look healthier
}

// ── reading a schedule ────────────────────────────────────────────────────────────────

t("the pager's own '2-59/5' range-step schedule is read as five minutes, not as daily", () => {
  // Defect injected: a parser that only knows '*/n'. Migration 135 wrote the pager's
  // schedule as a RANGE step, '2-59/5', to interleave with the local task's :00 offset.
  // Under a '*/n'-only parser it falls through to the daily default (24h), and 24h * 2 is
  // far past the 6h retention window — so "pg_net recorded zero responses" would be
  // dismissed as an unjudgeable window and the deadest possible pager would report
  // "unverifiable" forever instead of DEAD.
  assert.equal(scheduleIntervalMs('2-59/5 * * * *'), 5 * 60_000)
  assert.equal(scheduleIntervalMs('*/5 * * * *'), 5 * 60_000)
  assert.equal(scheduleIntervalMs('*/15 * * * *'), 15 * 60_000)
  assert.equal(scheduleIntervalMs('17 * * * *'), 3600_000)
  assert.equal(scheduleIntervalMs('7 5 * * *'), 24 * 3600_000)
  assert.equal(scheduleIntervalMs('0 6 * * 3'), 7 * 24 * 3600_000)
})

// ── the fault that hid for weeks ──────────────────────────────────────────────────────

t('THE INJECTED OUTAGE: the pager ticks green while every call is refused 401', () => {
  // This is the measured 2026-08-25 fault, reproduced: 3 x HTTP 401 among 106 x 200,
  // every one of them reported 'succeeded' by cron.job_run_details.
  assert.equal(OLD_verdict(PAGER_SUCCEEDING_IN_CRON), 'OK',
    'the old check must say OK here — that is the defect being injected')

  const v = httpDeliveryVerdict({
    stats: { calls: 109, ok: 106, bad: 3, refused: 3, timed_out: 0, errored: 0, bad_codes: '401' },
    queryError: null,
    httpPostSchedules: ['2-59/5 * * * *'],
  })
  assert.equal(v.verdict, 'dead')
  assert.match(v.detail, /401/, 'the finding must name the status, not just say "not 2xx"')
  assert.match(v.detail, /signal-sweep-5min/, 'it must say out loud that the pager may not be delivering')
})

t('ONE refused call is enough — a dead credential does not heal itself', () => {
  // Defect injected: requiring PERSISTENT_FAILURES of everything. A rotated Vault key
  // produces a steady trickle of 401s, and the real fault was 3 in 109. Demanding a
  // proportion, or a big absolute count, is how it would stay hidden.
  const v = httpDeliveryVerdict({
    stats: { calls: 200, ok: 199, bad: 1, refused: 1, timed_out: 0, errored: 0, bad_codes: '401' },
    queryError: null, httpPostSchedules: ['2-59/5 * * * *'],
  })
  assert.equal(v.verdict, 'dead')
})

t('a wrong route (404) and a forbidden call (403) count as refused too', () => {
  for (const code of ['403', '404']) {
    const v = httpDeliveryVerdict({
      stats: { calls: 50, ok: 49, bad: 1, refused: 1, timed_out: 0, errored: 0, bad_codes: code },
      queryError: null, httpPostSchedules: ['2-59/5 * * * *'],
    })
    assert.equal(v.verdict, 'dead', `${code} must be treated as a refusal`)
  }
})

// ── the transient/persistent line ─────────────────────────────────────────────────────

t('one transient 5xx is a blip and does NOT fire', () => {
  const v = httpDeliveryVerdict({
    stats: { calls: 180, ok: 179, bad: 1, refused: 0, timed_out: 0, errored: 0, bad_codes: '503' },
    queryError: null, httpPostSchedules: ['2-59/5 * * * *'],
  })
  assert.equal(v.verdict, 'ok')
  assert.match(v.detail, /1 transient failure/, 'a blip is still reported, never silently dropped')
})

t(`${PERSISTENT_FAILURES} transient failures in one window stop being a blip`, () => {
  const v = httpDeliveryVerdict({
    stats: { calls: 180, ok: 177, bad: 3, refused: 0, timed_out: 2, errored: 1, bad_codes: '502, 504' },
    queryError: null, httpPostSchedules: ['2-59/5 * * * *'],
  })
  assert.equal(v.verdict, 'dead')
  assert.match(v.detail, /502, 504/)
})

t('a response row with NO status code counts as bad, not as absent', () => {
  // Defect injected: `status_code != 200` style filtering, or ignoring NULLs. pg_net
  // writes a row with a null status when the request never completed. A missing answer
  // is not a passing answer — the same "exact comparison where a range was meant" shape
  // that let 502/503/504 pass as healthy for twenty hours on 2026-09-01.
  const v = httpDeliveryVerdict({
    stats: { calls: 100, ok: 96, bad: 4, refused: 0, timed_out: 4, errored: 4, bad_codes: 'no-response' },
    queryError: null, httpPostSchedules: ['2-59/5 * * * *'],
  })
  assert.equal(v.verdict, 'dead')
  assert.match(v.detail, /no-response/)
})

// ── the third way the pager can die: enqueued and never sent ───────────────────────────

t('ZERO responses while a 5-minute job dispatches = DEAD, never "quiet"', () => {
  // Defect injected: treating an empty table as "nothing went wrong". If pg_net's worker
  // stops, net.http_post still enqueues and pg_cron still records 'succeeded', so this is
  // a totally dead pager that every other layer calls healthy.
  assert.equal(OLD_verdict(PAGER_SUCCEEDING_IN_CRON), 'OK')
  const v = httpDeliveryVerdict({
    stats: { calls: 0, ok: 0, bad: 0, refused: 0, timed_out: 0, errored: 0, bad_codes: null },
    queryError: null, httpPostSchedules: ['2-59/5 * * * *'],
  })
  assert.equal(v.verdict, 'dead')
  assert.match(v.detail, /ZERO/)
})

t('ZERO responses when the only dispatcher is a DAILY job is unverifiable, not dead', () => {
  // The other direction, and it matters as much: the retention window is ~6h, so a job
  // that fires once a day legitimately leaves nothing behind most of the time. Calling
  // that DEAD would be an alarm that fires every night and gets muted.
  const v = httpDeliveryVerdict({
    stats: { calls: 0, ok: 0, bad: 0, refused: 0, timed_out: 0, errored: 0, bad_codes: null },
    queryError: null, httpPostSchedules: ['17 7 * * *'],
  })
  assert.equal(v.verdict, 'unverifiable')
  assert.ok(RESPONSE_RETENTION_MS < 24 * 3600_000, 'the window really is shorter than a day')
})

// ── a failed read is never a clean result ─────────────────────────────────────────────

t('a query that could not be read is UNVERIFIABLE, never ok', () => {
  // Defect injected: swallowing the error and moving on, which is exactly how
  // check-healthchecks-down.mjs used to turn a malformed 200 into a positive all-clear.
  const v = httpDeliveryVerdict({
    stats: null,
    queryError: 'HTTP 401: {"message":"Unauthorized"}',
    httpPostSchedules: ['2-59/5 * * * *'],
  })
  assert.equal(v.verdict, 'unverifiable')
  assert.match(v.detail, /never "fine"/)
})

t('an aggregate row that came back without a count is UNVERIFIABLE, never ok', () => {
  const v = httpDeliveryVerdict({ stats: {}, queryError: null, httpPostSchedules: ['*/5 * * * *'] })
  assert.equal(v.verdict, 'unverifiable')
})

// ── scope ─────────────────────────────────────────────────────────────────────────────

t('a database whose crons dispatch no HTTP has no delivery path to judge', () => {
  const v = httpDeliveryVerdict({ stats: null, queryError: null, httpPostSchedules: [] })
  assert.equal(v.verdict, 'not-applicable')
})

t('the healthy case says what the number counts, and does not claim to be per-job', () => {
  // net._http_response is per-DATABASE and shared by every pg_net caller on it. A label
  // saying "this job's calls" would be a number whose name does not match what it counts.
  const v = httpDeliveryVerdict({
    stats: { calls: 184, ok: 184, bad: 0, refused: 0, timed_out: 0, errored: 0, bad_codes: null },
    queryError: null, httpPostSchedules: ['2-59/5 * * * *', '*/15 * * * *'],
  })
  assert.equal(v.verdict, 'ok')
  assert.match(v.detail, /this database dispatched/)
  assert.match(v.detail, /184/)
})

// -- layer 1: what the DEAD line is allowed to leave out -------------------------------
//
// Added 2026-09-01 after heartbeat run 33555239704 went red with three findings and the
// run log could not tell any of them apart. The old console line was exactly:
//
//   DEAD <job> [<schedule>] last success <age> ago > allowed <allow>
//
// Reconstructed here as OLD_line and asserted against the same rows the new code sees.
// The point of each case is not that jobVerdict runs; it is that the old sentence was the
// SAME sentence for two problems with opposite owners.

const OLD_line = (age, allow) => `last success ${age == null ? 'never' : age} ago > allowed ${allow}`

/** ReplyFlow, the night this was written: pg_cron DID attempt it, and it did not succeed. */
const ATTEMPTED_AND_FAILED = {
  jobname: 'affiliate-monitor-daily',
  schedule: '0 7 * * *',
  last_success: '2026-08-31T07:00:00Z',
  last_run: '2026-09-01T07:00:00.101Z',
  last_result: 'failed: ERROR:  permission denied for table decrypted_secrets',
}

/** BackOffice, the same night: scheduled that afternoon, first tick (03:17) not yet due. */
const NEVER_ATTEMPTED = {
  jobname: 'product-check-run-prune-daily',
  schedule: '17 3 * * *',
  last_success: null,
  last_run: null,
  last_result: null,
}

t("a job that RAN and failed puts the database's own error message in the log", () => {
  const v = jobVerdict(ATTEMPTED_AND_FAILED, NOW)
  assert.equal(v.verdict, 'dead')
  assert.equal(v.neverRan, false)
  // The three facts that decide who owns this, none of which the old line carried.
  assert.match(v.detail, /last run 2026-09-01T07:00:00\.101Z/)
  assert.match(v.detail, /permission denied for table decrypted_secrets/)
  assert.match(v.detail, /allowed 26\.0h/)
  assert.doesNotMatch(OLD_line('37.4h', '26.0h'), /permission denied/)
})

t('a job pg_cron NEVER attempted is not reported as one that has been failing forever', () => {
  const v = jobVerdict(NEVER_ATTEMPTED, NOW)
  assert.equal(v.verdict, 'dead')          // still a finding: unproven is never healthy
  assert.equal(v.neverRan, true)
  assert.match(v.detail, /NEVER RUN/)
  assert.match(v.detail, /no attempt at all/)
  // "last success never ago" was the old sentence, and it is the same sentence a job dead
  // since July would print. It must not survive.
  assert.doesNotMatch(v.detail, /never ago/)
  assert.match(OLD_line(null, '26.0h'), /never ago/)   // ...which is what it used to say
})

t('never-ran and ran-and-failed do not produce the same line', () => {
  // The old pair differed only in two numbers, and said nothing about which of pg_cron,
  // the job, or the schedule was the thing to go and look at.
  assert.notEqual(jobVerdict(NEVER_ATTEMPTED, NOW).detail, jobVerdict(ATTEMPTED_AND_FAILED, NOW).detail)
})

t('a healthy job is unchanged: the verdict is ok and the line stays short', () => {
  const v = jobVerdict({
    jobname: 'refresh-tokens-hourly', schedule: '0 * * * *',
    last_success: agoMin(26), last_run: agoMin(26), last_result: 'succeeded',
  }, NOW)
  assert.equal(v.verdict, 'ok')
  assert.equal(v.detail, 'last success 26min ago')
})

t("the allowance is still derived from the job's own schedule, not a constant", () => {
  // Guards the refactor: allowanceMs moved from private to exported, and a silent
  // regression to "26h for everything" would make every fast job unfailable.
  assert.equal(allowanceMs('0 7 * * *'), 26 * 3600_000)        // daily
  assert.equal(allowanceMs('*/5 * * * *'), 90 * 60_000)        // */5 -> 90min floor
  assert.equal(allowanceMs('0 * * * *'), 3 * 3600_000)         // hourly at a fixed minute
  assert.equal(allowanceMs('0 9 1 * *'), 33 * 24 * 3600_000)   // monthly
})

t('last_success decides the verdict; last_run is evidence and never overrules it', () => {
  const v = jobVerdict({
    jobname: 'send-weekly-digest-monday-8am', schedule: '0 8 * * 1',
    last_success: '2026-08-20T08:00:00Z', last_run: agoMin(10), last_result: 'failed: boom',
  }, NOW)
  assert.equal(v.verdict, 'dead')
  assert.match(v.detail, /failed: boom/)
})


// ─── LAYER 2, COVERAGE ───────────────────────────────────────────────────────
// The window is six hours; the day is twenty-four. Everything below is about the
// eighteen hours layer 2 could not see, and the fact that it used to describe them
// with the same words it used for a clean bill of health.

/** BackOffice production, exactly as read from cron.job on 2026-09-02. */
const BACKOFFICE_HTTP_JOBS = [
  { jobname: 'github-invite-poller',           schedule: '*/15 * * * *' },
  { jobname: 'ledger-invariant-monitor-daily', schedule: '23 6 * * *' },
  { jobname: 'outreach-reply-digest-daily',    schedule: '31 6 * * *' },
  { jobname: 'reminders-check-daily',          schedule: '17 7 * * *' },
  { jobname: 'signal-sweep-5min',              schedule: '2-59/5 * * * *' },
  { jobname: 'support-send-due',               schedule: '*/5 * * * *' },
  { jobname: 'vat-return-reminder-daily',      schedule: '0 7 * * *' },
]

/** 05:24 UTC — when the nightly run actually looked, and saw none of the broken jobs. */
const AT_0524 = Date.parse('2026-09-02T05:24:00Z')
/** 12:28 UTC — the manual dispatch whose window did contain them. */
const AT_1228 = Date.parse('2026-09-02T12:28:00Z')

t('a daily job pinned to a wall-clock hour is placed in time, not guessed at', () => {
  // Cross-checked against pg_cron's own last_success in run 33594504359: the log said
  // 22.1h / 22.4h / 22.9h / 23.0h for these four, to the decimal.
  const h = (s, now) => msSinceLastFire(s, now) / 3600_000
  assert.equal(h('17 7 * * *', AT_0524).toFixed(1), '22.1')
  assert.equal(h('0 7 * * *',  AT_0524).toFixed(1), '22.4')
  assert.equal(h('31 6 * * *', AT_0524).toFixed(1), '22.9')
  assert.equal(h('23 6 * * *', AT_0524).toFixed(1), '23.0')
  // Same job, seen from after its fire time: hours old, not a day old.
  assert.equal(h('17 7 * * *', AT_1228).toFixed(1), '5.2')
})

t('a step schedule is bounded by its own interval and is always inside the window', () => {
  assert.equal(msSinceLastFire('*/5 * * * *', AT_0524), 5 * 60_000)
  assert.equal(msSinceLastFire('2-59/5 * * * *', AT_0524), 5 * 60_000)   // the pager's range-step
  assert.equal(msSinceLastFire('0 */6 * * *', AT_0524), 6 * 3600_000)
  assert.equal(msSinceLastFire('0 * * * *', AT_0524), 3600_000)          // hourly at fixed minute
})

t('weekly and monthly shapes resolve to a real past instant', () => {
  // 2026-09-02 is a Wednesday; the Monday 08:00 fire is 2026-08-31.
  const weekly = msSinceLastFire('0 8 * * 1', AT_1228)
  assert.equal(new Date(AT_1228 - weekly).toISOString(), '2026-08-31T08:00:00.000Z')
  // Monthly on the 1st at 09:00 → yesterday, not next month.
  const monthly = msSinceLastFire('0 9 1 * *', AT_1228)
  assert.equal(new Date(AT_1228 - monthly).toISOString(), '2026-09-01T09:00:00.000Z')
})

t('THE INJECTED BLIND SPOT: a clean-sounding sentence about a window that excluded every broken job', () => {
  // These are the REAL numbers from the 05:24 run on 2026-09-02: 175 calls, every one
  // of them 2xx. Nothing here is a failure the old code missed by misjudging it — it is
  // a failure the old code never had in front of it, because the four jobs that were
  // 401ing had fired 22-23 hours earlier and pg_net had already forgotten them.
  const facts = { stats: { calls: 175, ok: 175, bad: 0, refused: 0 }, queryError: null }

  // OLD: no nowMs, so no coverage clause — the exact sentence that was printed, which
  // reads as "this database's delivery is fine".
  const old = httpDeliveryVerdict({ ...facts, httpPostJobs: BACKOFFICE_HTTP_JOBS })
  assert.equal(old.verdict, 'ok')
  assert.doesNotMatch(old.detail, /UNOBSERVED/)

  // NEW: same verdict — 175 really were fine — but it can no longer be read as a
  // statement about the four jobs nobody looked at, because it names all four.
  const now = httpDeliveryVerdict({ ...facts, httpPostJobs: BACKOFFICE_HTTP_JOBS, nowMs: AT_0524 })
  assert.equal(now.verdict, 'ok')
  assert.match(now.detail, /UNOBSERVED/)
  for (const name of ['ledger-invariant-monitor-daily', 'outreach-reply-digest-daily',
                      'reminders-check-daily', 'vat-return-reminder-daily']) {
    assert.match(now.detail, new RegExp(name))
  }
  // The jobs that WERE covered must not be smeared into the doubt.
  assert.doesNotMatch(now.detail, /signal-sweep-5min/)
  assert.doesNotMatch(now.detail, /support-send-due/)
})

t('shifting the window to when those jobs fire makes the doubt disappear', () => {
  // The same database seen at 12:28, which is what the dispatch that found the 401s did.
  const c = deliveryCoverage({ httpPostJobs: BACKOFFICE_HTTP_JOBS, nowMs: AT_1228 })
  const unobserved = c.unobserved.map((j) => j.jobname)
  // ledger fires 06:23 and the window opens 06:28, so it is the one that stays outside —
  // five minutes of blind spot, which is exactly why the schedule and not the wording is
  // what has to close this.
  assert.deepEqual(unobserved, ['ledger-invariant-monitor-daily'])
  assert.equal(c.observed.length, 6)
})

t('a covered window adds nothing: the healthy sentence stays short', () => {
  const v = httpDeliveryVerdict({
    stats: { calls: 259, ok: 259, bad: 0, refused: 0 }, queryError: null,
    httpPostJobs: [{ jobname: 'lifecycle-tick', schedule: '*/5 * * * *' }],
    nowMs: AT_0524,
  })
  assert.equal(v.verdict, 'ok')
  assert.doesNotMatch(v.detail, /NOTE:/)
})

t('a DEAD finding is still only a finding about what was in the window', () => {
  // 27 of 230 no-response on ReplyFlow is real, but it is not the whole database either.
  const v = httpDeliveryVerdict({
    stats: { calls: 230, ok: 203, bad: 27, refused: 0, timed_out: 27, errored: 27, bad_codes: 'no-response' },
    queryError: null,
    httpPostJobs: [
      { jobname: 'process-queue-every-2min', schedule: '*/2 * * * *' },
      { jobname: 'send-weekly-digest-monday-8am', schedule: '0 8 * * 1' },
    ],
    nowMs: AT_0524,
  })
  assert.equal(v.verdict, 'dead')
  assert.match(v.detail, /no longer a blip/)
  assert.match(v.detail, /UNOBSERVED here — send-weekly-digest-monday-8am/)
})

t('a schedule that cannot be placed in time is UNKNOWN, not quietly counted as covered', () => {
  const c = deliveryCoverage({
    httpPostJobs: [{ jobname: 'weird', schedule: 'H/5 * * * *' }],
    nowMs: AT_0524,
  })
  assert.equal(c.observed.length, 0)
  assert.equal(c.unobserved.length, 0)
  assert.equal(c.unknown.length, 1)
  const v = httpDeliveryVerdict({
    stats: { calls: 10, ok: 10, bad: 0, refused: 0 }, queryError: null,
    httpPostJobs: [{ jobname: 'weird', schedule: 'H/5 * * * *' }], nowMs: AT_0524,
  })
  assert.match(v.detail, /cannot place in time/)
})

t('THE WIRING: the shipped script passes real job names and its own clock, not just schedules', () => {
  // A green test on an exported function proves the function works, never that the
  // product calls it — exitDecision() was exported, documented and unit-tested here
  // while the CLI had stopped calling it (fixed in 6f2fd93). Same trap, same guard.
  const src = readFileSync(new URL('../scripts/check-cron-heartbeats.mjs', import.meta.url), 'utf8')
  assert.match(src, /httpDeliveryVerdict\(\{ stats, queryError, httpPostJobs, nowMs: now, attribution, attributionError \}\)/)
  assert.match(src, /const httpPostJobs = rows\.filter\(\(r\) => r\.uses_http_post\)/)
})

// ── WHICH JOB WAS REFUSED ────────────────────────────────────────────────────────
// The 2026-09-02 red run produced two findings and neither named a culprit: "2 of 184
// were REFUSED (401)" and "27 of 231 failed". Both are counts. Acting on either meant a
// human re-deriving the job by hand from the schedule list, which is what happened, twice.

t('DEFECT: a refused call now NAMES the job and its route, where before it named a number', () => {
  const v = httpDeliveryVerdict({
    stats: { calls: 184, ok: 182, bad: 2, refused: 2, bad_codes: '401' }, queryError: null,
    httpPostJobs: [{ jobname: 'vat-return-reminder-daily', schedule: '0 7 * * *' }],
    attribution: [
      { status: '401', candidate_count: 1, candidates: 'vat-return-reminder-daily -> https://x.supabase.co/functions/v1/vat-return-reminder', n: 2 },
    ],
  })
  assert.equal(v.verdict, 'dead')
  assert.match(v.detail, /WHICH JOB/)
  assert.match(v.detail, /vat-return-reminder-daily/)
  assert.match(v.detail, /functions\/v1\/vat-return-reminder/)
  // The old wording is still there — the count was never the problem, the silence after it was.
  assert.match(v.detail, /2 of 184 HTTP calls/)
})

t('a job that cannot be pinned down is offered as a candidate, never asserted as the culprit', () => {
  const v = httpDeliveryVerdict({
    stats: { calls: 231, ok: 204, bad: 27, refused: 0, timed_out: 27, errored: 27, bad_codes: 'no-response' }, queryError: null,
    httpPostJobs: [{ jobname: 'process-queue-every-2min', schedule: '*/2 * * * *' }],
    attribution: [
      { status: 'no-response', candidate_count: 2, candidates: 'process-queue-every-2min -> https://x/a, refresh-tokens-hourly -> https://x/b', n: 27 },
    ],
  })
  assert.match(v.detail, /one of 2 jobs/)
  assert.match(v.detail, /process-queue-every-2min/)
  assert.match(v.detail, /refresh-tokens-hourly/)
})

t('a bad call with no cron run behind it says so — net._http_response is per-database, not per-job', () => {
  const c = attributionClause([{ status: '500', candidate_count: 0, candidates: '', n: 4 }])
  assert.match(c, /4 × 500/)
  assert.match(c, /no cron run in the 90s before them/)
  assert.match(c, /other than pg_cron/)
})

t('DEFECT: a failed attribution read says it failed rather than going quiet', () => {
  // Silence after "2 of 184 were REFUSED" reads as "there is nothing more to say", which
  // is exactly the wrong inference. Same rule as layer 2's own unverifiable branch.
  const v = httpDeliveryVerdict({
    stats: { calls: 184, ok: 182, bad: 2, refused: 2, bad_codes: '401' }, queryError: null,
    httpPostJobs: [{ jobname: 'a', schedule: '0 7 * * *' }],
    attribution: null, attributionError: 'HTTP 500: upstream',
  })
  assert.match(v.detail, /WHICH JOB: unknown, the attribution read itself failed \(HTTP 500: upstream\)/)
})

t('a caller that supplies no attribution gets the verdict it always got, with nothing invented', () => {
  const v = httpDeliveryVerdict({
    stats: { calls: 184, ok: 182, bad: 2, refused: 2, bad_codes: '401' }, queryError: null,
    httpPostJobs: [{ jobname: 'a', schedule: '0 7 * * *' }],
  })
  assert.equal(v.verdict, 'dead')
  assert.doesNotMatch(v.detail, /WHICH JOB/)
})

t('SAFETY: the attribution query reads the URL out of the command and never the command itself', () => {
  // These findings are emailed and printed into a run log. Older migrations wrote the
  // service_role bearer as a LITERAL inside the cron command (the pattern migration 160
  // replaces with a vault lookup), so selecting j.command would publish a live key.
  const src = readFileSync(new URL('../scripts/check-cron-heartbeats.mjs', import.meta.url), 'utf8')
  const sql = src.slice(src.indexOf('const HTTP_FAILURE_ATTRIBUTION_SQL'), src.indexOf('export function attributionClause'))
  assert.match(sql, /substring\(j\.command from/)
  // j.command may appear only inside substring() and the ilike filter — never as a selected column.
  for (const m of sql.matchAll(/j\.command/g)) {
    const around = sql.slice(Math.max(0, m.index - 40), m.index + 20)
    assert.ok(/substring\(|ilike/.test(around), `j.command exposed raw near: ${around}`)
  }
})

t('the naming states its own scope, because it is wider than the headline it follows', () => {
  // Run 33643053842 read "1 of 191 were REFUSED" and then attributed three calls — a 500,
  // a no-response and the 404. Each carried its own status, and it still read as "three
  // were refused" at a glance. The headline counts one class; this lists every non-2xx.
  const c = attributionClause([{ status: '500', candidate_count: 1, candidates: 'signal-sweep-5min -> https://x/functions/v1/signal-intake', n: 1 }])
  assert.match(c, /every call in this window that was not answered 2xx/)
})

t('a job that builds its URL at run time is still given a route, not "(no url)"', () => {
  // ReplyFlow composes the host from a setting, so the command contains no 'https://' and
  // all nine of its jobs came back "(command names no url)" on run 33643053842. The route
  // is in the command either way; the SQL falls back to it. Verified against real Postgres.
  const src = readFileSync(new URL('../scripts/check-cron-heartbeats.mjs', import.meta.url), 'utf8')
  const sql = src.slice(src.indexOf('const HTTP_FAILURE_ATTRIBUTION_SQL'), src.indexOf('export function attributionClause'))
  assert.match(sql, /coalesce\(\s*\n\s*substring\(j\.command from 'https\?/)
  assert.match(sql, /substring\(j\.command from '\/functions\/v1\//)
})

t('THE WIRING: the shipped script actually runs the attribution query, and only when there is a failure', () => {
  const src = readFileSync(new URL('../scripts/check-cron-heartbeats.mjs', import.meta.url), 'utf8')
  assert.match(src, /if \(stats && Number\(stats\.bad\) > 0\) \{/)
  assert.match(src, /await query\(ref, pat, HTTP_FAILURE_ATTRIBUTION_SQL\)/)
})

console.log(`\n${n} assertions passed.`)
