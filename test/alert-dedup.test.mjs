/**
 * Unit test for the alert dedup decision (scripts/lib/alert-dedup.mjs), used by
 * scripts/send-alert.mjs.
 *
 * The 2026-08-31 board incident "alert-dedup-repages-when-one-cause-spreads": the dedup
 * signature was `${project}||${test}`. One root cause (a site 500ing, a dead service key)
 * paged once, then SPREAD to more specs in the next run — the new specs were "new"
 * signatures, so the same already-paged outage paged again every run. And the old
 * signature could not see a failure whose error CHANGED: a known test failing for a
 * brand-new reason was swallowed as "continuing".
 *
 * These cases pin: the signature carries the failure reason; a superset of an already-
 * paged root cause suppresses; a new test OR a new reason always pages; and every doubt
 * (no prior run, empty prior set, vague reason) fails OPEN.
 *
 * Run: node test/alert-dedup.test.mjs   (exit 0 = all pass)
 */
import assert from 'node:assert'
import { normalizeReason, failureSignature, previousDedupView, isAlreadyAlerted, shouldSuppressAlert } from '../scripts/lib/alert-dedup.mjs'

let passed = 0
let failed = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok   - ${name}`); passed++ }
  catch (e) { console.log(`  FAIL - ${name}: ${e.message}`); failed++ }
}

const site500 = 'expect(response.status()).toBe(200) — got 500'
const prev = [
  { project: 'ReplyFlow', test: 'landing page loads', error: site500 },
  { project: 'ReplyFlow', test: 'login works', error: site500 },
]

check('the signature now carries the failure reason, not just project||test', () => {
  const a = failureSignature({ project: 'P', test: 't', error: 'err-one' })
  const b = failureSignature({ project: 'P', test: 't', error: 'err-two' })
  assert.notEqual(a, b, 'same test, different reason must be a different signature')
  assert.ok(a.startsWith('P||t||'))
})

check('continuing failure (same test, same reason) is already alerted', () => {
  const view = previousDedupView(prev)
  assert.ok(isAlreadyAlerted({ project: 'ReplyFlow', test: 'landing page loads', error: site500 }, view))
  assert.ok(shouldSuppressAlert([prev[0]], view), 'a subset of the same failures suppresses')
})

check('THE INCIDENT: a SUPERSET of the same root cause suppresses (cause spread to a new spec)', () => {
  const view = previousDedupView(prev)
  const current = [...prev, { project: 'ReplyFlow', test: 'dashboard loads', error: site500 }]
  assert.ok(shouldSuppressAlert(current, view),
    'the new spec fails with the SAME reason — the root cause was already paged, do not re-page')
})

check('a NEW failure reason always pages, even on a test that was already failing', () => {
  const view = previousDedupView(prev)
  const current = [...prev, { project: 'ReplyFlow', test: 'landing page loads', error: 'TypeError: Cannot read properties of null' }]
  assert.ok(!shouldSuppressAlert(current, view),
    'same test failing for a NEW reason is a changed failure, not a continuing one')
})

check('a new test with a NEW reason pages (a genuinely different bug alongside the known one)', () => {
  const view = previousDedupView(prev)
  const current = [...prev, { project: 'ScoutCopilot', test: 'search works', error: 'Timeout 30000ms exceeded' }]
  assert.ok(!shouldSuppressAlert(current, view))
})

check('fail-open: no prior run / empty prior failures / empty current set never suppress', () => {
  assert.ok(!shouldSuppressAlert(prev, null))
  assert.ok(!shouldSuppressAlert(prev, previousDedupView([])))
  assert.ok(previousDedupView([]) === null, 'empty prev failures → null view → fail open')
  assert.ok(previousDedupView(null) === null)
  assert.ok(!shouldSuppressAlert([], previousDedupView(prev)))
})

check('fail-open: a vague/content-free reason never reason-matches', () => {
  const view = previousDedupView([{ project: 'P', test: 'a', error: 'Unknown error' }])
  assert.ok(!isAlreadyAlerted({ project: 'P', test: 'b', error: 'Unknown error' }, view),
    '"Unknown error" in both runs says nothing about a shared root cause')
  assert.ok(!isAlreadyAlerted({ project: 'P', test: 'b', error: '' }, view))
  // ...but the SAME test still continuing with that vague reason is a signature match.
  assert.ok(isAlreadyAlerted({ project: 'P', test: 'a', error: 'Unknown error' }, view))
})

check('reason normalisation: ANSI codes, newlines and whitespace noise do not break the match', () => {
  assert.equal(normalizeReason('[31mexpect(200) got 500[0m\n  at foo.spec.ts:12'), 'expect(200) got 500')
  const view = previousDedupView([{ project: 'P', test: 'a', error: 'expect(200)   got 500\nstack line' }])
  assert.ok(isAlreadyAlerted({ project: 'P', test: 'b', error: 'expect(200) got 500' }, view))
})

check('reason-match is case-insensitive (same cause, casing drift)', () => {
  const view = previousDedupView([{ project: 'P', test: 'a', error: 'REST root returned 503' }])
  assert.ok(isAlreadyAlerted({ project: 'P', test: 'b', error: 'rest root returned 503' }, view))
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
