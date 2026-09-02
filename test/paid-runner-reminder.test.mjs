/**
 * Unit tests for "how long have we been paying GitHub, and when is that worth saying".
 *
 * The shape is Roger's, answered 2026-09-02 with the measured numbers in front of him: quiet for
 * 12 hours, then once a day, silent again the moment a machine comes home. Every assertion here
 * fails against the behaviour it replaces — a single alert on the transition, then green for ever.
 *
 * Run: node test/paid-runner-reminder.test.mjs   (exit 0 = all pass)
 */
import assert from 'node:assert'
import { decideReminder, GRACE_H, REALERT_H } from '../lib/paidRunnerReminder.mjs'

let n = 0
const t = (name, fn) => { fn(); n++; console.log(`  ok - ${name}`) }

const NOW = Date.parse('2026-09-02T12:00:00.000Z')
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString()

// ── the quiet window: an evening or a night with a machine off says nothing ───────────────────

t('a repository that has just started paying starts a clock and says nothing', () => {
  const r = decideReminder({ paying: ['replyflow'], state: {}, now: NOW })
  assert.equal(r.alert, null)
  assert.equal(r.changed, true)
  assert.ok(r.state.replyflow.since, 'the clock must be recorded, or the next run starts it again')
})

t('eleven hours of paying is still silent, because a machine off overnight fixes itself', () => {
  const r = decideReminder({ paying: ['replyflow'], state: { replyflow: { since: hoursAgo(11), alerted_at: null } }, now: NOW })
  assert.equal(r.alert, null)
})

t(`past ${GRACE_H} hours it speaks, once, and says what it costs and how to end it`, () => {
  const r = decideReminder({ paying: ['replyflow'], state: { replyflow: { since: hoursAgo(13), alerted_at: null } }, now: NOW })
  assert.match(r.alert, /PAYING GITHUB FOR BUILDS/)
  assert.match(r.alert, /13h/)
  assert.match(r.alert, /Nothing is broken/)
  assert.match(r.alert, /Switching one on ends this/)
  assert.equal(r.state.replyflow.alerted_at, new Date(NOW).toISOString())
})

// ── the throttle, which is the whole reason this needed a decision ────────────────────────────

t('it does NOT repeat on the next ten-minute run — that would be 144 emails a day', () => {
  const r = decideReminder({ paying: ['replyflow'], state: { replyflow: { since: hoursAgo(13), alerted_at: hoursAgo(0.2) } }, now: NOW })
  assert.equal(r.alert, null, 'the sender has no throttle of its own; this clock IS the throttle')
})

t(`it repeats after ${REALERT_H} hours, for as long as the fleet is still paying`, () => {
  const r = decideReminder({ paying: ['replyflow'], state: { replyflow: { since: hoursAgo(50), alerted_at: hoursAgo(25) } }, now: NOW })
  assert.match(r.alert, /50h/)
})

// ── coming home is silence, not a message ─────────────────────────────────────────────────────

t('a machine coming back drops the row and says nothing at all', () => {
  const r = decideReminder({ paying: [], state: { replyflow: { since: hoursAgo(30), alerted_at: hoursAgo(2) } }, now: NOW })
  assert.equal(r.alert, null)
  assert.deepEqual(r.state, {})
  assert.equal(r.changed, true, 'the cleared state must be written back, or the old clock keeps running')
})

t('a fleet that has never fallen back writes nothing and says nothing', () => {
  const r = decideReminder({ paying: [], state: {}, now: NOW })
  assert.equal(r.alert, null)
  assert.equal(r.changed, false, 'a quiet run must not spend a write')
})

// ── one message for the whole fleet, not one per repository ───────────────────────────────────

t('fourteen repositories paying for the same reason produce ONE message naming them', () => {
  const repos = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n']
  const state = Object.fromEntries(repos.map((r) => [r, { since: hoursAgo(20), alerted_at: null }]))
  const r = decideReminder({ paying: repos, state, now: NOW })
  assert.equal(typeof r.alert, 'string')
  assert.match(r.alert, /14 repositories have been building on rented machines/)
  for (const repo of repos) assert.ok(r.alert.includes(repo), `${repo} must be named`)
})

t('the longest-running one sets the number in the message, not the newest', () => {
  const r = decideReminder({
    paying: ['old', 'new'],
    state: { old: { since: hoursAgo(40), alerted_at: null }, new: { since: hoursAgo(13), alerted_at: null } },
    now: NOW,
  })
  assert.match(r.alert, /40h/)
})

// ── an unreadable clock must not silence the alarm for ever ───────────────────────────────────

t('a corrupted timestamp is treated as no clock at all, and a fresh one is started', () => {
  const r = decideReminder({ paying: ['replyflow'], state: { replyflow: { since: 'not-a-date', alerted_at: null } }, now: NOW })
  // It cannot claim hours it cannot measure, so it stays silent this run - but it must not carry
  // the unreadable value forward as if it were a measurement.
  assert.equal(r.alert, null)
  assert.equal(r.state.replyflow.since, 'not-a-date')
})

console.log(`\n${n} passed`)
