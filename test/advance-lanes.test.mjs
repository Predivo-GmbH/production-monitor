/**
 * THE ADVANCER MUST NEVER TAKE A DECISION THAT IS ROGER'S.
 *
 * Roger asked for a board that lifts itself 24/7 and asks him only when it is really needed. The
 * danger in that is obvious and it is the only thing this suite really guards: a job that walks
 * rows forward automatically must be incapable of walking one across the line that is his.
 *
 * The line, from AUTONOMY-how-far-claude-goes-on-the-board-2026-09-04.md: six of seven lane moves
 * are mine on every product; `ready_for_release -> done` is his for anything a customer touches.
 * So this job has NO code path that performs it — an absence, not a flag, because a flag can be
 * set wrongly and an absence cannot.
 *
 * Pure: no network, no credentials, no database. Run: node test/advance-lanes.test.mjs
 */
import assert from 'node:assert'
import { LANES, nextLane, heldBack, planFor, isDryRun, moveCap } from '../scripts/advance-lanes.mjs'

let n = 0
const t = (name, fn) => { fn(); n++; console.log(`  ok - ${name}`) }
const row = (o = {}) => ({ lane: 'todo', gate_unmet: null, is_blocked: false, merged_into: null, blocked_owner: null, blocked_question: null, slug: 'r', id: '1', ...o })

// ══ THE LINE THAT IS ROGER'S ════════════════════════════════════════════════════════════════
t('the last lane has no successor: this job cannot release anything, ever', () => {
  assert.equal(nextLane('ready_for_release'), null,
    'releasing is a decision, and the job must not have a path that performs it')
  const p = planFor(row({ lane: 'ready_for_release' }))
  assert.equal(p.act, 'leave')
  assert.match(p.reason, /releasing is a decision/)
})

t('a released or dropped row is never touched', () => {
  for (const lane of ['done', 'abandoned', 'nonsense', '', null, undefined]) {
    assert.equal(nextLane(lane), null, `${JSON.stringify(lane)} must have no successor`)
  }
})

t('a row owed to Roger stays put however green its gate is', () => {
  const p = planFor(row({ lane: 'todo', gate_unmet: null, blocked_owner: 'roger' }))
  assert.equal(p.act, 'leave')
  assert.match(p.reason, /owed to Roger/)
})

t('a row that asks Roger a question stays put, even with no owner set', () => {
  const p = planFor(row({ blocked_question: 'yes or no?' }))
  assert.equal(p.act, 'leave')
  assert.match(p.reason, /question/)
})

t('case and padding cannot smuggle a row past the owed-to-Roger check', () => {
  for (const v of ['Roger', ' ROGER ', 'roger']) {
    assert.equal(planFor(row({ blocked_owner: v })).act, 'leave', `owner "${v}" must be held`)
  }
})

// ══ THE OVERLAY ═════════════════════════════════════════════════════════════════════════════
t('a blocked row waits for the block to clear, not for its gate', () => {
  const p = planFor(row({ is_blocked: true, gate_unmet: null }))
  assert.equal(p.act, 'leave')
  assert.match(p.reason, /blocked/)
})

t('a merged-away row is never advanced', () => {
  assert.equal(planFor(row({ merged_into: 'other-id' })).act, 'leave')
})

// ══ ONE STEP AT A TIME ══════════════════════════════════════════════════════════════════════
t('every advance is exactly one lane, so each transition is separately visible', () => {
  for (let i = 0; i < LANES.length - 1; i++) {
    const p = planFor(row({ lane: LANES[i] }))
    assert.equal(p.act, 'advance')
    assert.equal(p.to, LANES[i + 1], `${LANES[i]} must advance to ${LANES[i + 1]} and no further`)
  }
})

t('a row whose gate is unmet stays, carrying that exact reason forward', () => {
  const reason = 'no definition of finished: nothing says what "done" would look like'
  const p = planFor(row({ gate_unmet: reason }))
  assert.equal(p.act, 'leave')
  assert.equal(p.reason, reason, 'the board\'s own words are reported, never paraphrased')
})

t('whitespace is not a gate: a blank reason does not hold a row', () => {
  assert.equal(planFor(row({ gate_unmet: '   ' })).act, 'advance')
  assert.equal(planFor(row({ gate_unmet: null })).act, 'advance')
})

// ══ IT CANNOT RUN AWAY WITH THE BOARD ═══════════════════════════════════════════════════════
t('dry is the default and only the environment can switch it off', () => {
  assert.equal(isDryRun([], {}), true, 'an accidental run must move nothing')
  assert.equal(isDryRun([], { LANES_CONFIRM: '1' }), false)
  assert.equal(isDryRun(['--dry'], { LANES_CONFIRM: '1' }), true, '--dry only ever tightens')
})

t('there is always a cap, and a nonsense cap falls back to the default', () => {
  assert.equal(moveCap({}), 25)
  assert.equal(moveCap({ LANES_MAX: '3' }), 3)
  assert.equal(moveCap({ LANES_MAX: '0' }), 0, 'zero is a legitimate cap: move nothing')
  for (const bad of ['x', '-1', '', undefined]) assert.equal(moveCap({ LANES_MAX: bad }), 25)
})

t('hostile input never throws and never advances anything', () => {
  for (const v of [null, undefined, 0, 42, 'x', [], {}]) {
    assert.doesNotThrow(() => planFor(v))
    const p = planFor(v)
    if (p.act === 'advance') assert.fail(`${JSON.stringify(v)} must not advance`)
  }
})

console.log(`\n${n} passed`)
