/**
 * The weekly board measurement, and specifically its refusal to report a number it cannot see.
 *
 * Every gate here is trivially winnable by doing the wrong thing — switch the producers off and
 * the board "shrinks"; mass-merge the old rows and debt "ages down". So the tests that matter most
 * are the ones asserting the gate does NOT go green when it is being gamed, and the ones asserting
 * `unknown` where a pass would be a lie.
 *
 * Pure: no credentials, no network. Run: node test/measure-the-board.test.mjs
 */
import assert from 'node:assert'
import {
  measureBoard, gateBoardShrinks, gateDebtAgesDown, gateRowsWorkable, gateWeightIsReal,
  gateHisLaneIsHonest, gateHisLaneIsSmall, gateNothingIsFictional, gateWorkIsBatched,
} from '../scripts/measure-the-board.mjs'

let n = 0
const t = (name, fn) => { fn(); n++; console.log(`  ok - ${name}`) }
const NOW = Date.parse('2026-09-03T18:00:00Z')
const daysAgo = (d) => new Date(NOW - d * 86_400_000).toISOString()

// ── the board shrinks, and the way it is faked ───────────────────────────────────────────────
t('more out than in passes', () => {
  // Realistic volumes: 600 in / 700 out is 42.9 vs 50.0 per day against a 46.9 baseline, so the
  // intake-collapse companion does not fire. Deliberately NOT a toy number — 100 over 14 days is
  // 7.1/day, which this gate correctly treats as the producers having stopped.
  assert.equal(gateBoardShrinks({ opened: 600, closed: 700, days: 14 }).state, 'pass')
})

t('more in than out fails — the live board on 2026-09-03', () => {
  const g = gateBoardShrinks({ opened: 657, closed: 450, days: 14 })
  assert.equal(g.state, 'fail')
  assert.match(g.detail, /net \+14\.8\/day/)
})

t('GAMED: switching the producers off must NOT read as success', () => {
  // 40 in / 60 out over 14 days is 2.9 vs 4.3 per day — "shrinking" — but intake has collapsed
  // to a fraction of the 46.9/day baseline, which means the alarms stopped filing, not that the
  // work got done.
  const g = gateBoardShrinks({ opened: 40, closed: 60, days: 14, baselineOpenedPerDay: 46.9 })
  assert.equal(g.state, 'fail', 'a shrinking board with collapsed intake is not a win')
  assert.match(g.companion, /INTAKE COLLAPSED/)
})

t('an unreadable count is unknown, never a pass', () => {
  assert.equal(gateBoardShrinks({ opened: NaN, closed: 5, days: 14 }).state, 'unknown')
  assert.equal(gateBoardShrinks({ opened: 5, closed: 5, days: 0 }).state, 'unknown')
})

// ── debt ages down ───────────────────────────────────────────────────────────────────────────
t('a single run cannot know a trend, and says so instead of guessing one', () => {
  const g = gateDebtAgesDown({ open: [{ opened_at: daysAgo(21) }], merged: 0, now: NOW })
  assert.equal(g.state, 'unknown')
  assert.equal(g.value, 21)
})

t('the merge count rides along, because mass-merging is how this one is gamed', () => {
  const g = gateDebtAgesDown({ open: [{ opened_at: daysAgo(5) }], merged: 40, now: NOW })
  assert.match(g.companion, /40 row\(s\) merged/)
})

// ── rows are workable ────────────────────────────────────────────────────────────────────────
t('a declared row owes a finish-test; a machine row does not', () => {
  const g = gateRowsWorkable({ open: [
    { source: 'declaration', done_when: null },
    { source: 'monitor', done_when: null },        // exempt: its finish derives from its signal
  ] })
  assert.equal(g.state, 'fail')
  assert.match(g.detail, /1 of 1 declared/)
})

// ── weight is real ───────────────────────────────────────────────────────────────────────────
t('a critical row older than 48h fails', () => {
  const g = gateWeightIsReal({ open: [{ priority: 'critical', opened_at: daysAgo(3) }], openedInWindow: [], now: NOW })
  assert.equal(g.state, 'fail')
})

t('GAMED: an inflated critical share is called out even while the gate passes', () => {
  const g = gateWeightIsReal({
    open: [{ priority: 'critical', opened_at: daysAgo(0.5) }],
    openedInWindow: Array.from({ length: 10 }, () => ({ priority: 'critical' })),
    now: NOW,
  })
  assert.equal(g.state, 'pass', 'nothing is stale, so the gate itself passes')
  assert.match(g.companion, /CRITICAL SHARE 100%/, 'and the bypass abuse is still surfaced')
})

// ── his lane ─────────────────────────────────────────────────────────────────────────────────
t('a row owed to Roger that states no question fails the honesty gate', () => {
  const g = gateHisLaneIsHonest({ open: [{ blocked_owner: 'roger', blocked_question: null }] })
  assert.equal(g.state, 'fail')
})

t('a vendor-blocked row is not in his lane at all', () => {
  const g = gateHisLaneIsHonest({ open: [{ blocked_owner: 'vendor', blocked_question: null }] })
  assert.equal(g.state, 'pass')
})

t('a question waiting on him longer than a week fails', () => {
  const g = gateHisLaneIsSmall({ open: [{ blocked_owner: 'roger', state_since: daysAgo(9) }], now: NOW })
  assert.equal(g.state, 'fail')
})

// ── the two gates that must say "I cannot tell" ──────────────────────────────────────────────
t('batching cannot pass or fail while there is no batch column', () => {
  const g = gateWorkIsBatched({ hasBatchColumn: false })
  assert.equal(g.state, 'unknown')
  assert.match(g.detail, /no batch column/)
})

t('partial evaluation is unknown — an unevaluated check proves nothing either way', () => {
  const g = gateNothingIsFictional({ open: [
    { done_when: {}, done_check_result: 'pass' },
    { done_when: {}, done_check_result: null },
  ] })
  assert.equal(g.state, 'unknown', 'this is the exact shape of "0 of 0 checked, all fine"')
})

t('fully evaluated with an unrunnable check fails', () => {
  const g = gateNothingIsFictional({ open: [{ done_when: {}, done_check_result: 'unknown' }] })
  assert.equal(g.state, 'fail')
})

t('fully evaluated and all runnable passes', () => {
  const g = gateNothingIsFictional({ open: [{ done_when: {}, done_check_result: 'pass' }] })
  assert.equal(g.state, 'pass')
})

// ── the whole measurement ────────────────────────────────────────────────────────────────────
t('a closed or abandoned row is never counted as open', () => {
  const m = measureBoard({ rows: [
    { status: 'done', source: 'declaration', opened_at: daysAgo(1) },
    { status: 'abandoned', source: 'declaration', opened_at: daysAgo(1) },
  ], now: NOW })
  assert.equal(m.open, 0)
})

t('any failing gate makes the whole measurement fail, and names which', () => {
  const m = measureBoard({
    rows: [{ status: 'next', source: 'declaration', done_when: null, opened_at: daysAgo(1) }],
    openedInWindow: Array.from({ length: 657 }, () => ({})),
    closedInWindow: Array.from({ length: 450 }, () => ({})),
    days: 14, now: NOW,
  })
  assert.equal(m.state, 'fail')
  assert.match(m.headline, /The board shrinks/)
  assert.match(m.headline, /Rows are workable/)
})

t('with nothing failing it still reports unknown while any gate cannot be judged', () => {
  const m = measureBoard({
    rows: [], openedInWindow: [], closedInWindow: Array.from({ length: 10 }, () => ({})),
    days: 14, now: NOW,
  })
  assert.notEqual(m.state, 'pass', 'unjudgeable gates must never be rounded up to a pass')
})

t('an empty board never throws', () => {
  assert.doesNotThrow(() => measureBoard())
})

console.log(`\n${n} passed`)
