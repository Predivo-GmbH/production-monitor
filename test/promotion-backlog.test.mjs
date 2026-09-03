// The regression this suite exists for: on 2026-09-03 Roger opened the Deploy Status page for the
// fourth time in two days and found the same rows still sitting on it. Distribution-OS had been
// showing "staging and production have drifted apart" since 2026-08-04 - a MONTH - with security
// fixes stranded on one side. The page was RIGHT the whole time. Nothing failed because of it.
//
// Every case below uses the real shapes measured that day.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyBacklog, rank, DEFAULT_MAX_AGE_H } from '../scripts/lib/promotion-backlog.mjs'
import { signalFor, exitCode, SOURCE, describeUnreadable } from '../scripts/check-promotion-backlog.mjs'

const NOW = new Date('2026-09-03T12:00:00Z')
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3_600_000).toISOString()

test('THE ONE THAT SAT A MONTH: Distribution-OS diverged is reported, and told to merge not promote', () => {
  const r = classifyBacklog(
    { name: 'Distribution-OS', status: 'diverged', aheadBy: 9, behindBy: 8, oldestUnshippedAt: '2026-08-04T13:32:08Z' },
    { now: NOW },
  )
  assert.equal(r.level, 'diverged')
  assert.match(r.reason, /MERGING, not promoting/)
  assert.match(r.reason, /ships nothing/)
})

test('diverged is reported at ANY age - there is no grace period for a split that only widens', () => {
  const r = classifyBacklog(
    { name: 'X', status: 'diverged', aheadBy: 1, behindBy: 1, oldestUnshippedAt: hoursAgo(0.1) },
    { now: NOW },
  )
  assert.equal(r.level, 'diverged')
})

test('a product waiting longer than the threshold is STALE and says whose job it is', () => {
  const r = classifyBacklog(
    { name: 'BackOffice', status: 'ahead', aheadBy: 2, oldestUnshippedAt: hoursAgo(30) },
    { now: NOW },
  )
  assert.equal(r.level, 'stale')
  assert.match(r.reason, /Promoting is Claude's job, not Roger's/)
})

test('a long wait is reported in DAYS, because 400h means nothing to a reader', () => {
  const r = classifyBacklog(
    { name: 'Y', status: 'ahead', aheadBy: 5, oldestUnshippedAt: hoursAgo(24 * 30) },
    { now: NOW },
  )
  assert.match(r.reason, /30\.0 DAYS/)
})

test('a recent promotion is NOT nagged about - this must not cry wolf', () => {
  const r = classifyBacklog(
    { name: 'Z', status: 'ahead', aheadBy: 3, oldestUnshippedAt: hoursAgo(2) },
    { now: NOW },
  )
  assert.equal(r.level, 'ok')
})

test('exactly at the threshold counts as stale, not fresh', () => {
  const r = classifyBacklog(
    { name: 'Z', status: 'ahead', aheadBy: 1, oldestUnshippedAt: hoursAgo(DEFAULT_MAX_AGE_H) },
    { now: NOW },
  )
  assert.equal(r.level, 'stale')
})

test('nothing waiting is ok', () => {
  for (const s of ['identical', 'behind']) {
    assert.equal(classifyBacklog({ name: 'Q', status: s, aheadBy: 0, oldestUnshippedAt: null }, { now: NOW }).level, 'ok')
  }
  assert.equal(classifyBacklog({ name: 'Q', status: 'ahead', aheadBy: 0, oldestUnshippedAt: null }, { now: NOW }).level, 'ok')
})

test('AN UNREADABLE AGE IS TREATED AS NEGLECTED, NOT AS FRESH', () => {
  // The quiet path is how a thing sits forever. If we cannot tell how old it is, say so loudly.
  for (const bad of [null, undefined, 'not a date', '']) {
    const r = classifyBacklog({ name: 'W', status: 'ahead', aheadBy: 4, oldestUnshippedAt: bad }, { now: NOW })
    assert.equal(r.level, 'stale', `oldestUnshippedAt=${String(bad)}`)
    assert.match(r.reason, /could not be read/)
  }
})

test('ranking puts diverged first, then the oldest wait', () => {
  const results = [
    classifyBacklog({ name: 'fresh', status: 'ahead', aheadBy: 1, oldestUnshippedAt: hoursAgo(1) }, { now: NOW }),
    classifyBacklog({ name: 'old', status: 'ahead', aheadBy: 1, oldestUnshippedAt: hoursAgo(200) }, { now: NOW }),
    classifyBacklog({ name: 'newer', status: 'ahead', aheadBy: 1, oldestUnshippedAt: hoursAgo(40) }, { now: NOW }),
    classifyBacklog({ name: 'split', status: 'diverged', aheadBy: 2, behindBy: 2, oldestUnshippedAt: hoursAgo(5) }, { now: NOW }),
  ]
  const order = rank(results).map((r) => r.reason.split(':')[0])
  assert.deepEqual(order, ['split', 'old', 'newer'])
  assert.equal(rank(results).length, 3, 'the fresh one must not be reported')
})

test('junk in does not throw', () => {
  for (const p of [{}, { name: 'x' }, { name: 'x', status: 'ahead' }]) {
    const r = classifyBacklog(p, { now: NOW })
    assert.ok(['ok', 'stale', 'diverged'].includes(r.level))
  }
})

// The regression this half of the suite exists for: on 2026-09-03 the sensor exited 1 on a FINDING,
// so a month-old backlog rode the monitor's failure() path into send-alert.mjs and mailed Roger
// EVERY HOUR, and could never resolve. A finding must be a filed board row that exits 0; exit 1 is
// only for "I could not look" - exactly what every sibling sensor states in its monitor.yml comment.
test('A FINDING EXITS 0 - it is a board row, not a job failure', () => {
  assert.equal(exitCode({ readCount: 8, unreadableCount: 0, apiErrors: 0 }), 0)
})

test('exit 1 is reserved for "could not look": nothing read, a repo unreadable, or an API error', () => {
  assert.equal(exitCode({ readCount: 0, unreadableCount: 0, apiErrors: 0 }), 1, 'read nothing')
  assert.equal(exitCode({ readCount: 5, unreadableCount: 1, apiErrors: 0 }), 1, 'a repo was unreadable')
  assert.equal(exitCode({ readCount: 5, unreadableCount: 0, apiErrors: 3 }), 1, 'a GitHub API call failed')
})

test('the filed signal never pages Roger - it lands on /signals for Claude to promote or merge', () => {
  const diverged = signalFor({ repo: 'distribution-os', level: 'diverged', ageH: 720, reason: 'D: drifted' })
  assert.equal(diverged.source, SOURCE)
  assert.equal(diverged.key, 'distribution-os')
  assert.equal(diverged.needs_human, false, 'must not ring the phone - this is what mailed hourly')
  assert.equal(diverged.severity, 'warning')
  assert.equal(diverged.state, 'open')
  assert.match(diverged.title, /merging/)

  const stale = signalFor({ repo: 'backoffice', level: 'stale', ageH: 30, reason: 'B: waited' })
  assert.equal(stale.needs_human, false)
  assert.match(stale.title, /waiting too long/)
})

// ── "I could not look" must name WHY it could not look ────────────────────────
// Regression for monitor run 33800656551 (2026-09-03 20:10Z). The shared GitHub REST allowance was
// empty (0/5000, reset 20:29:21Z). This sweep emitted eight annotations reading
// `could not read shipping state for <product> (prod=unknown, staging=unknown)` and named no cause,
// so the run summary looked like eight broken deploy pipelines. The real fact was one refused
// allowance that healed itself 19 minutes later.

test('THE 20:10Z RED: a refused API call is named with its status, not laundered into "unknown"', () => {
  const line = describeUnreadable({
    repo: 'ChannelMover',
    prod: false,
    staging: false,
    cause: 'GET /repos/Predivo-GmbH/ChannelMover/actions/runs?per_page=30 -> HTTP 403',
  })
  assert.match(line, /HTTP 403/, 'the status is the whole diagnosis - it must survive to the log')
  assert.match(line, /ChannelMover/)
  // The old line said only this much, and that was the defect.
  assert.notEqual(line, 'ChannelMover (prod=unknown, staging=unknown)')
})

test('a blind read and an empty read are DIFFERENT problems and must not print the same sentence', () => {
  const refused = describeUnreadable({ repo: 'Valrano', prod: false, staging: false, cause: 'GET /x -> HTTP 403' })
  const answered = describeUnreadable({ repo: 'Valrano', prod: false, staging: false, cause: null })
  assert.notEqual(refused, answered, 'one needs waiting out, the other needs a workflow fixed')
  assert.match(answered, /the GitHub API answered/, 'silence about the cause sent the reader hunting an outage')
  assert.match(answered, /no successful deploy job/)
  assert.doesNotMatch(answered, /HTTP/, 'must not imply an API failure that did not happen')
})

test('the half-read case still reports WHICH half was read, so the cause is not over-claimed', () => {
  const line = describeUnreadable({ repo: 'ReplyFlow', prod: true, staging: false, cause: 'GET /y -> HTTP 403' })
  assert.match(line, /prod=ok/)
  assert.match(line, /staging=unknown/)
  assert.match(line, /HTTP 403/)
})

test('a failed compare carries its cause too - it was the one unreadable path with no detail at all', () => {
  const line = describeUnreadable({ repo: 'BoatBuddy', prod: true, staging: true, comparing: true, cause: 'GET /compare -> HTTP 502' })
  assert.match(line, /compare failed/)
  assert.match(line, /HTTP 502/)
})

test('a network error, not just an HTTP status, reaches the log', () => {
  const line = describeUnreadable({ repo: 'signalscore', prod: false, staging: false, cause: 'GET /z -> fetch failed' })
  assert.match(line, /fetch failed/)
})
