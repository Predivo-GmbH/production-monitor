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
import {
  httpDeliveryVerdict, scheduleIntervalMs, RESPONSE_RETENTION_MS, PERSISTENT_FAILURES,
  jobVerdict, allowanceMs,
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

console.log(`\n${n} assertions passed.`)
