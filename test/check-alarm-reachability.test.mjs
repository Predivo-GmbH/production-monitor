/**
 * Unit tests for the alarm-reachability check.
 *
 * The check exists because of a measurement, not a theory: of the 24 signals that ever asked to
 * ring Roger's phone, 21 never rang, and nothing in the fleet was asking whether an alarm could
 * reach anybody. Each case below is one way "the alarms work" can be false.
 *
 * The tests that matter most are the ones asserting UNKNOWN, not the ones asserting a fault. A
 * reachability check that reports "all clear" when its own read failed is the same bug it exists
 * to catch, one level up.
 *
 * Run: node test/check-alarm-reachability.test.mjs   (exit 0 = all pass)
 */
import assert from 'node:assert'
import { judgeReachability } from '../scripts/check-alarm-reachability.mjs'

let n = 0
const t = (name, fn) => { fn(); n++; console.log(`  ok - ${name}`) }

const ARMED = [{ source: 'production-monitor', may_page: true }, { source: 'healthchecks', may_page: true }]
const sig = (o) => ({ source: 'production-monitor', key: 'k', severity: 'warning', needs_human: false, state: 'open', page_suppressed_reason: null, ...o })

// ── could not tell is never fine ───────────────────────────────────────────────────────────
t('an EMPTY board is unknown, never ok — the board is never empty, so that is a failed read', () => {
  const j = judgeReachability({ signals: [], policies: ARMED })
  assert.equal(j.verdict, 'unknown')
  assert.equal(j.severity, 'critical')
  assert.notEqual(j.verdict, 'ok')
})

t('a policy table that could not be read is unknown, never ok', () => {
  const j = judgeReachability({ signals: [sig({})], policies: null })
  assert.equal(j.verdict, 'unknown')
})

t('a signals read that failed outright is unknown, never ok', () => {
  for (const bad of [null, undefined, 'HTTP 500']) {
    assert.equal(judgeReachability({ signals: bad, policies: ARMED }).verdict, 'unknown')
  }
})

// ── fault 1: a source that asked to page and structurally cannot ───────────────────────────
t('THE LIVE FAILURE: a source with a page-worthy finding and no policy row is unreachable', () => {
  // The shape of `sentry` on 2026-09-01: 34 signals filed, one of them critical + needs_human,
  // 13 stamped policy-off, and never paged once in its entire life.
  const j = judgeReachability({
    signals: [
      sig({ source: 'sentry', key: 'BACKOFFICE-9', severity: 'critical', needs_human: true, state: 'superseded' }),
      sig({ source: 'sentry', key: 'other', page_suppressed_reason: 'policy-off' }),
    ],
    policies: ARMED,
  })
  assert.equal(j.verdict, 'unreachable')
  assert.equal(j.severity, 'critical')
  assert.equal(j.faults.filter((f) => f.kind === 'mute-source').length, 1)
  assert.match(j.faults[0].detail, /never added/)
})

t('an ARMED source with page-worthy findings is not a fault', () => {
  const j = judgeReachability({
    signals: [sig({ severity: 'critical', needs_human: true })],
    policies: ARMED,
  })
  assert.equal(j.verdict, 'ok')
})

t('a source present in the policy table but may_page=false is still muted', () => {
  // Explicitly switched off and never added are different decisions with identical consequences.
  // Only the first is a decision, but the alarm is equally silent, so both must be reported.
  const j = judgeReachability({
    signals: [sig({ source: 'sentry', severity: 'critical', needs_human: true })],
    policies: [...ARMED, { source: 'sentry', may_page: false }],
  })
  assert.equal(j.verdict, 'unreachable')
})

t('an unarmed source that has NEVER filed anything page-worthy is not a fault', () => {
  // Most sources file only warnings and are meant to. Reporting all 17 of them would be noise,
  // and noise is what trains an alarm away. Only a source that has actually TRIED to reach a
  // human and could not is a fault.
  const j = judgeReachability({
    signals: [sig({ source: 'closer-digest', severity: 'info' }), sig({ source: 'report', severity: 'warning' })],
    policies: ARMED,
  })
  assert.equal(j.verdict, 'ok')
})

// ── fault 2: a critical finding that cannot page itself ────────────────────────────────────
t('an OPEN critical finding with needs_human=false is a fault — it is a contradiction', () => {
  const j = judgeReachability({
    signals: [sig({ source: 'monitoring-hygiene', key: 'supabase-disk-pressure-rotates-across-projects', severity: 'critical', needs_human: false, state: 'open' })],
    policies: ARMED,
  })
  assert.equal(j.verdict, 'unreachable')
  assert.equal(j.faults.filter((f) => f.kind === 'critical-cannot-page').length, 1)
})

t('an acknowledged critical that cannot page still counts; a resolved one does not', () => {
  const ack = judgeReachability({
    signals: [sig({ severity: 'critical', needs_human: false, state: 'acknowledged' })],
    policies: ARMED,
  })
  assert.equal(ack.verdict, 'unreachable')
  const done = judgeReachability({
    signals: [sig({ severity: 'critical', needs_human: false, state: 'resolved' })],
    policies: ARMED,
  })
  assert.equal(done.verdict, 'ok', 'a closed finding needs nobody paged')
})

t('needs_human must be strictly true — a missing or truthy-ish value is not consent to page', () => {
  for (const nh of [undefined, null, 'true', 1]) {
    const j = judgeReachability({
      signals: [sig({ severity: 'critical', needs_human: nh, state: 'open' })],
      policies: ARMED,
    })
    assert.equal(j.verdict, 'unreachable', `needs_human=${String(nh)} must not be read as true`)
  }
})

// ── the healthy end state ──────────────────────────────────────────────────────────────────
t('a board where every page-worthy source is armed and no critical is blocked reports ok', () => {
  const j = judgeReachability({
    signals: [
      sig({ severity: 'critical', needs_human: true, state: 'open' }),
      sig({ source: 'healthchecks', severity: 'critical', needs_human: true, state: 'open' }),
      sig({ source: 'report', severity: 'info' }),
    ],
    policies: ARMED,
  })
  assert.equal(j.verdict, 'ok')
  assert.equal(j.faults.length, 0)
})

console.log(`\n${n} tests passed.`)
