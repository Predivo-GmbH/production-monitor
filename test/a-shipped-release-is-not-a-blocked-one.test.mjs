/**
 * A CANCELLED GATE THAT A LATER RUN HAS OVERTAKEN IS HISTORY, NOT AN INCIDENT.
 *
 * -- WHAT IT ENFORCES -----------------------------------------------------------------------
 *
 *     A FINDING MUST BE TRUE ABOUT NOW, NOT ONLY TRUE ABOUT WHEN IT WAS FOUND.
 *
 * -- THE MEASUREMENT THIS COMES FROM ---------------------------------------------------------
 *
 * 2026-09-03. BoatBuddy run 33726492534 had its required `gate-e2e` cancelled at 07:07Z, and the
 * watchdog correctly reported that the release was blocked. Run 33729608920 then ran the same
 * workflow at 07:43:57Z, passed the same gate at 07:45:34Z and deployed at 07:47:52Z. The release
 * was no longer blocked — and the watchdog said it was, seven times, between 07:44:30Z and
 * 08:48:05Z. Five of those were still unread; each new copy pulled the thread back into the inbox
 * faster than it could be filed.
 *
 * The arithmetic is the point: the watchdog runs `cron: *\/10` against a 90-minute lookback, so
 * 90 / 10 = up to NINE copies of a single dead finding, by design, with no memory between runs.
 * The alert was not noisy because of a threshold. It was noisy because nothing ever asked whether
 * the thing it described was still true.
 *
 * -- WHY A TEST AND NOT A COMMENT ------------------------------------------------------------
 *
 * The call site ALREADY carried a comment promising this behaviour — "see cancelled-gate.mjs for
 * the signature and why it cannot fire on a superseded run". That sentence referred to a different
 * guard (`someJobSucceeded`, which separates a singled-out gate from a whole-run cancel) and no
 * code implemented what the comment claimed. A promise in a comment is exactly what this fleet has
 * been removing all week; this file is the promise made checkable.
 */
import assert from 'node:assert/strict'
import { supersededByLaterSuccess } from '../scripts/lib/cancelled-gate.mjs'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log('  ok - ' + name) }

const cancelled = {
  id: 33726492534, workflow_id: 900, head_branch: 'main',
  conclusion: 'cancelled', created_at: '2026-09-03T07:05:00Z',
}

check('RED: the real case — a later success on the same workflow and branch supersedes it', () => {
  const later = [{ id: 33729608920, workflow_id: 900, head_branch: 'main', conclusion: 'success', created_at: '2026-09-03T07:43:57Z' }]
  assert.equal(supersededByLaterSuccess(cancelled, later), true)
})

check('GREEN: nothing later — the release really is still blocked and must still be reported', () => {
  assert.equal(supersededByLaterSuccess(cancelled, []), false)
})

check('a success on a DIFFERENT workflow does not clear it', () => {
  const later = [{ workflow_id: 901, head_branch: 'main', conclusion: 'success', created_at: '2026-09-03T07:43:57Z' }]
  assert.equal(supersededByLaterSuccess(cancelled, later), false)
})

check('a success on a DIFFERENT branch does not clear it', () => {
  const later = [{ workflow_id: 900, head_branch: 'staging', conclusion: 'success', created_at: '2026-09-03T07:43:57Z' }]
  assert.equal(supersededByLaterSuccess(cancelled, later), false)
})

check('an EARLIER success does not clear it — order is the whole question', () => {
  const later = [{ workflow_id: 900, head_branch: 'main', conclusion: 'success', created_at: '2026-09-03T06:00:00Z' }]
  assert.equal(supersededByLaterSuccess(cancelled, later), false)
})

check('a later run that FAILED does not clear it', () => {
  const later = [{ workflow_id: 900, head_branch: 'main', conclusion: 'failure', created_at: '2026-09-03T07:43:57Z' }]
  assert.equal(supersededByLaterSuccess(cancelled, later), false)
})

check('a later run still IN PROGRESS does not clear it', () => {
  const later = [{ workflow_id: 900, head_branch: 'main', conclusion: null, created_at: '2026-09-03T07:43:57Z' }]
  assert.equal(supersededByLaterSuccess(cancelled, later), false)
})

check('unreadable input is never treated as "superseded" — it fails towards reporting', () => {
  assert.equal(supersededByLaterSuccess(null, [{ conclusion: 'success' }]), false)
  assert.equal(supersededByLaterSuccess({ workflow_id: 900, created_at: 'nonsense' }, [{ workflow_id: 900, conclusion: 'success', created_at: '2026-09-03T07:43:57Z' }]), false)
  assert.equal(supersededByLaterSuccess(cancelled, null), false)
  assert.equal(supersededByLaterSuccess(cancelled, [null, undefined]), false)
})

console.log('\na-shipped-release-is-not-a-blocked-one: ' + passed + ' checks passed')
