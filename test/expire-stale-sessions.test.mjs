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
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { sweepSql, sweep, IDLE_DAYS, ABSOLUTE_DAYS, blindSignal, deadTokenSignal, exitDecision, missingFindings } from '../scripts/expire-stale-sessions.mjs'
import { coverageGaps } from '../scripts/lib/supabase-coverage.mjs'

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

// A dead management token must land in `blind`, never vanish silently. Before this was
// fixed, `if (!r.ok) continue` dropped a 401 token's entire account from the sweep, so the
// run exited 0 with a smaller project count and those products' logins were never expired —
// which is how 113,284 abandoned sessions accumulated.
const acheck = async (name, fn) => {
  try { await fn(); console.log(`  ok   - ${name}`); passed++ }
  catch (e) { console.log(`  FAIL - ${name}: ${e.message}`); failed++ }
}
const withStubbedFetch = async (impl, fn) => {
  const real = globalThis.fetch
  globalThis.fetch = impl
  try { return await fn() } finally { globalThis.fetch = real }
}

await acheck('a revoked token is recorded as unreadable, not silently skipped', async () => {
  const results = await withStubbedFetch(
    async () => ({ ok: false, status: 401, json: async () => ({}) }),
    () => sweep({ SUPABASE_TOKEN_DEAD: 'sbp_revoked' }, true),
  )
  const blind = results.filter((r) => !r.ok)
  assert.strictEqual(blind.length, 1, 'the dead token must produce exactly one unreadable entry')
  assert.strictEqual(blind[0].product, 'SUPABASE_TOKEN_DEAD', 'the entry must name the credential')
  assert.ok(/401/.test(blind[0].error), 'the error must carry the HTTP status')
})

await acheck('a network error on the project listing is recorded, not swallowed', async () => {
  const results = await withStubbedFetch(
    async () => { throw new Error('ECONNRESET') },
    () => sweep({ SUPABASE_TOKEN_FLAKY: 'sbp_x' }, true),
  )
  const blind = results.filter((r) => !r.ok)
  assert.strictEqual(blind.length, 1, 'the unreachable token must produce one unreadable entry')
  assert.ok(/ECONNRESET/.test(blind[0].error), 'the error must carry the network cause')
})

// ---------------------------------------------------------------------------------------
// COVERAGE — the 2026-08-30 15:11 UTC failure. The step reported `21 projects, 1 unreadable`
// and red the whole hourly monitor, where the 1 was the dead YTMIGRATION_SUPABASE_ACCESS_
// TOKEN whose only project had just been swept by SUPABASE_TOKEN_CHANNELMOVER. All 20
// expected projects were swept. Meanwhile a project that vanished from EVERY token would
// have exited 0, because absent read as fine. Both halves are pinned here.
// ---------------------------------------------------------------------------------------
const BASELINE = { projects: [{ ref: 'aaa', product: 'ReplyFlow' }, { ref: 'bbb', product: 'Valrano Production' }] }
const DEAD_TOKEN = { product: 'YTMIGRATION_SUPABASE_ACCESS_TOKEN', ok: false, isToken: true, error: 'management API returned 401 — token dead or rotated' }

check('a dead token whose projects were all swept does NOT red the run', () => {
  const swept = [{ ref: 'aaa', product: 'ReplyFlow', ok: true }, { ref: 'bbb', product: 'Valrano Production', ok: true }, DEAD_TOKEN]
  const gaps = coverageGaps(swept, BASELINE)
  assert.deepEqual(gaps, [], 'every expected project was swept, so coverage is proven complete')
  assert.equal(exitDecision(swept, gaps).code, 0, 'a credential that cost no coverage must not red the hour')
})

check('the same dead token DOES red the run while coverage is unproven', () => {
  const { code, reasons } = exitDecision([{ ref: 'aaa', ok: true }, DEAD_TOKEN], null)
  assert.equal(code, 1, 'with no baseline nothing establishes the sweep was complete without it')
  assert.match(reasons.join(' '), /no project baseline/)
})

check('a project no token can see reds the run and is named', () => {
  const gaps = coverageGaps([{ ref: 'aaa', product: 'ReplyFlow', ok: true }], BASELINE)
  assert.deepEqual(gaps.map((p) => p.product), ['Valrano Production'])
  const results = [{ ref: 'aaa', product: 'ReplyFlow', ok: true }, ...missingFindings(gaps)]
  const { code, reasons } = exitDecision(results, gaps)
  assert.equal(code, 1, 'a product whose logins nobody expires is the dangerous case')
  assert.match(reasons.join(' '), /Valrano Production/, 'and the run must say WHICH product')
})

check('null coverage is not the same as no gaps', () => {
  assert.equal(coverageGaps([{ ref: 'aaa', ok: true }], null), null, 'null means we never established what to expect')
  assert.equal(missingFindings(null).length, 0, 'unproven coverage invents no findings')
})

check('the housekeeping row carries the exact command and never rings a phone', () => {
  const row = deadTokenSignal([DEAD_TOKEN], [], BASELINE)
  assert.equal(row.severity, 'warning', 'it must not red or page — the automation may not delete a secret')
  assert.match(row.summary, /gh secret delete YTMIGRATION_SUPABASE_ACCESS_TOKEN/, 'the remedy must be copy-pasteable')
  assert.match(row.summary, /all 2 projects expected/, 'the claim of harmlessness must show its evidence')
  assert.equal(row.key, 'session-expiry-dead-management-token', 'a stable key updates one row instead of breeding duplicates hourly')
})

check('an unproven or incomplete sweep may not call a dead token harmless', () => {
  assert.equal(deadTokenSignal([DEAD_TOKEN], null, null), null, 'unproven coverage cannot clear a token')
  assert.equal(deadTokenSignal([DEAD_TOKEN], [{ ref: 'bbb', product: 'Valrano Production' }], BASELINE), null,
    'with a project actually missing, the dead token is a suspect, not housekeeping')
})

check('a harmless dead token never silences a real unswept project', () => {
  // Both true at once: the token cost nothing, and Valrano is reachable by nobody.
  const gaps = [{ ref: 'bbb', product: 'Valrano Production' }]
  const blind = [DEAD_TOKEN, ...missingFindings(gaps)]
  const row = blindSignal(blind.filter((r) => !r.isToken))
  assert.match(row.summary, /Valrano Production/, 'the real blindness must still reach the board')
  assert.ok(!/YTMIGRATION/.test(row.summary), 'and it must not blame the token that was fine')
  assert.equal(row.needs_human, true, 'a product nobody sweeps needs a person')
})

// ---------------------------------------------------------------------------------------
// WIRING — 6f2fd93: an exit policy was exported, documented and unit-tested while the CLI
// had quietly stopped calling it. A green test on an exported function proves nothing about
// what the product does, so this spawns the real script. It also catches the Windows
// crash-instead-of-exit-code that process.exit() causes while undici holds its sockets.
// ---------------------------------------------------------------------------------------
await acheck('the SHIPPED script enforces coverage and exits on it', () => {
  // No management tokens -> the sweep sees nothing -> every baseline project is a gap.
  // BOARD_SUPABASE_SECRET is a dummy on purpose: it makes the board POST fail authentication
  // so this test cannot write to the live signals board, and the filing failure is caught by
  // the script by design, so the exit code still comes from the policy under test.
  const env = { ...process.env, BOARD_SUPABASE_SECRET: 'not-a-real-secret-this-test-must-not-file' }
  for (const k of Object.keys(env)) if (/^SUPABASE_TOKEN_|_SUPABASE_ACCESS_TOKEN$/.test(k)) delete env[k]
  const r = spawnSync(process.execPath, ['scripts/expire-stale-sessions.mjs', '--dry'], { env, encoding: 'utf8', cwd: new URL('..', import.meta.url) })
  assert.equal(r.status, 1, 'a sweep that swept nothing must never exit 0')
  assert.match(r.stdout, /coverage: 0\//, 'the shipped script must report coverage, not just count what it happened to see')
  assert.match(r.stderr, /project\(s\) could not be swept/, 'and it must say why it failed where a person will read it')
})

console.log(`\n${passed} passed, ${failed} failed.`)
process.exit(failed ? 1 : 0)
