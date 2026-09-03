// The regression this suite exists for: on 2026-09-03 Roger opened the Deploy Status page for the
// fourth time in two days and found the same rows still sitting on it. Distribution-OS had been
// showing "staging and production have drifted apart" since 2026-08-04 - a MONTH - with security
// fixes stranded on one side. The page was RIGHT the whole time. Nothing failed because of it.
//
// Every case below uses the real shapes measured that day.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyBacklog, rank, DEFAULT_MAX_AGE_H } from '../scripts/lib/promotion-backlog.mjs'

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
