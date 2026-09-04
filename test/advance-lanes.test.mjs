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
import { LANES, nextLane, heldBack, planFor, isDryRun, moveCap, statusForLane } from '../scripts/advance-lanes.mjs'

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

// ══ THE MOVE MUST NOT LIE TO THE OTHER TRIGGERS ═════════════════════════════════════════════
// A PATCH of { lane } alone leaves status out of the statement, so trg_work_items_next_has_no_owner
// (Cockpit sql/061) fires first, sees the OLD status `next`, and strips owner_session on the exact
// todo -> in_progress move that only ever happens to a CLAIMED row — landing it In Progress with no
// owner (the state sql/076 forbids). We send the derived status with the lane so 061/062/074 see
// where the row is going. This mirrors sql/101's own map; if that map drifts, this must too.
t('every lane maps to the status sql/101 gives it', () => {
  assert.equal(statusForLane('backlog'), 'next')
  assert.equal(statusForLane('refined'), 'next')
  assert.equal(statusForLane('todo'), 'next')
  assert.equal(statusForLane('in_progress'), 'in_progress')
  assert.equal(statusForLane('in_review'), 'in_progress')
  assert.equal(statusForLane('in_testing'), 'in_progress')
  assert.equal(statusForLane('ready_for_release'), 'awaiting_signoff')
})

t('every advance target carries a non-null status, so the PATCH never omits it', () => {
  for (let i = 0; i < LANES.length - 1; i++) {
    const to = nextLane(LANES[i])
    assert.ok(statusForLane(to) != null,
      `advancing ${LANES[i]} -> ${to} must send a status; a null would drop the column and re-open the bug`)
  }
})

t('the todo -> in_progress move sends in_progress, not the stale next', () => {
  // The regression itself: this is the transition that stripped owner_session in ebade94.
  const to = nextLane('todo')
  assert.equal(to, 'in_progress')
  assert.equal(statusForLane(to), 'in_progress',
    'if this ever returns next again, the advancer nulls the owner of every row it promotes out of To Do')
})

console.log(`\n${n} passed`)
