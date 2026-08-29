/**
 * Unit tests for the GitHub shared-allowance alarm's decision logic.
 *
 * The alarm exists because on 2026-08-27 the one 5,000/hour core allowance drained to 0 twice in
 * an afternoon and started refusing our own deploys, and nothing was watching the request quota
 * (only the money). Each case below is one shape of "the pool is dying" or one shape of "a normal
 * burst that must NOT cry wolf".
 *
 * Run: node test/check-github-api-budget.test.mjs   (exit 0 = all pass)
 */
import assert from 'node:assert'
import { judgeQuota } from '../scripts/check-github-api-budget.mjs'

let n = 0
const t = (name, fn) => { fn(); n++; console.log(`  ok - ${name}`) }

const NOW = Date.parse('2026-08-27T15:37:00.000Z')
// reset epoch such that `secsToReset` and thus fraction-elapsed is what we want
const resetIn = (secs) => Math.round((NOW + secs * 1000) / 1000)

// ── EXHAUSTED: 0 remaining with time still on the clock -> the refused-deploy state ──
t('remaining 0 with 20 min to reset -> exhausted/critical', () => {
  const j = judgeQuota({ limit: 5000, remaining: 0, used: 5000, reset: resetIn(20 * 60) }, NOW)
  assert.equal(j.verdict, 'exhausted')
  assert.equal(j.severity, 'critical')
})

t('remaining 0 but only 30s to reset -> not alarmed (it is about to refill)', () => {
  const j = judgeQuota({ limit: 5000, remaining: 0, used: 5000, reset: resetIn(30) }, NOW)
  assert.notEqual(j.verdict, 'exhausted')
})

// ── DRAINING: on track to blow the ceiling before reset ──
t('3700 used at 37 min in (62% elapsed) -> draining/critical', () => {
  // 37 min elapsed => 23 min to reset; used/frac = 3700/0.617 ~ 5997 > 5000, remaining 1300 < 1500
  const j = judgeQuota({ limit: 5000, remaining: 1300, used: 3700, reset: resetIn(23 * 60) }, NOW)
  assert.equal(j.verdict, 'draining')
  assert.equal(j.severity, 'critical')
  assert.ok(j.projectedUse >= 5000)
})

// ── LOW: fast but not yet projected over the ceiling ──
t('projecting to ~90% of ceiling -> low/warning', () => {
  // 30 min elapsed (50%), used 2300 => projects ~4600 = 92% of 5000, remaining 2700
  const j = judgeQuota({ limit: 5000, remaining: 2700, used: 2300, reset: resetIn(30 * 60) }, NOW)
  assert.equal(j.verdict, 'low')
  assert.equal(j.severity, 'warning')
})

// ── EARLY-WINDOW GUARD: a normal post-reset burst must not project to nonsense ──
t('big burst in the first 3 min of the window -> healthy (projection refused)', () => {
  // 3 min elapsed (5% < 10% floor): even 900 spent must not project
  const j = judgeQuota({ limit: 5000, remaining: 4100, used: 900, reset: resetIn(57 * 60) }, NOW)
  assert.equal(j.verdict, 'healthy')
})

t('under the absolute call floor -> healthy even if fraction is tiny', () => {
  // 40% elapsed but only 1400 spent (< 1500 floor) -> projects to <3600, and floor not met anyway
  const j = judgeQuota({ limit: 5000, remaining: 3600, used: 1400, reset: resetIn(36 * 60) }, NOW)
  assert.equal(j.verdict, 'healthy')
})

// ── EDGE: a steady pace that projects to exactly the ceiling is worth a warning ──
t('half spent at half the window (projects to exactly 5000) -> low/warning', () => {
  const j = judgeQuota({ limit: 5000, remaining: 2500, used: 2500, reset: resetIn(30 * 60) }, NOW)
  assert.equal(j.verdict, 'low')
})

// ── HEALTHY: normal usage well under the pace that would exhaust the hour ──
t('1500 spent at half the window (projects ~3000) -> healthy', () => {
  const j = judgeQuota({ limit: 5000, remaining: 3500, used: 1500, reset: resetIn(30 * 60) }, NOW)
  assert.equal(j.verdict, 'healthy')
})

console.log(`\n${n} passed`)
