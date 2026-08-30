/**
 * Unit test for the session-expiry sweep. No network, no secrets.
 *
 * Two things are pinned, both because they already went wrong once:
 *  1. the dry query must only COUNT and the real query must DELETE both the session and its
 *     refresh token — a dry run that deletes, or a real run that forgets refresh_tokens,
 *     would be silent damage;
 *  2. the "remaining" count must NOT live inside the delete statement. It did, and every CTE
 *     in one statement reads the same pre-delete snapshot, so the first real sweep reported
 *     "deleted 3384, 9401 remain" when 9401 was the count BEFORE. Verified against the live
 *     database afterwards: replyflow-staging went 9401 -> 6017.
 */
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { sweepSql, IDLE_DAYS, ABSOLUTE_DAYS } from '../scripts/expire-stale-sessions.mjs'

let passed = 0, failed = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok   - ${name}`); passed++ }
  catch (e) { console.log(`  FAIL - ${name}: ${e.message}`); failed++ }
}

check('the fleet policy is idle 30 days and absolute 180 days', () => {
  assert.strictEqual(IDLE_DAYS, 30)
  assert.strictEqual(ABSOLUTE_DAYS, 180)
})

check('a dry run only counts, it never deletes', () => {
  const sql = sweepSql(30, 180, true)
  assert.ok(/^\s*select count/i.test(sql), 'dry sql must start with a count')
  assert.ok(!/delete from/i.test(sql), 'dry sql must contain no DELETE statement (the column is named would_delete, which is why this matches the statement, not the word)')
})

check('a real run deletes the session AND its refresh token', () => {
  const sql = sweepSql(30, 180, false)
  assert.ok(/delete from auth\.sessions/i.test(sql), 'must delete the session')
  assert.ok(/delete from auth\.refresh_tokens/i.test(sql), 'must delete the refresh token too')
})

check('both halves of the policy are in the where clause', () => {
  const sql = sweepSql(30, 180, false)
  assert.ok(/created_at < now\(\) - interval '180 days'/.test(sql), 'absolute cap missing')
  assert.ok(/coalesce\(refreshed_at, updated_at, created_at\) < now\(\) - interval '30 days'/.test(sql), 'idle cap missing')
})

check('the remaining count is NOT inside the delete statement', () => {
  const sql = sweepSql(30, 180, false)
  assert.ok(!/remaining/.test(sql), 'a count inside the delete reads the pre-delete snapshot and reports a false number')
  const src = readFileSync(new URL('../scripts/expire-stale-sessions.mjs', import.meta.url), 'utf8')
  assert.ok(/select count\(\*\) remaining from auth\.sessions/.test(src), 'remaining must be counted in its own statement')
})

console.log(`\n${passed} passed, ${failed} failed.`)
process.exit(failed ? 1 : 0)
