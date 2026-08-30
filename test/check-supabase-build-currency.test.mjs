/**
 * Unit test for check-supabase-build-currency.mjs — the BLIND path.
 *
 * THE 2026-08-30 BUG: 986d205 moved this check's findings onto the Cockpit signals board,
 * because a bare process.exit(1) only reds the workflow and send-alert.mjs reads Playwright's
 * results.json — so the alert email lists ZERO failures while the real fact appears nowhere a
 * person looks. That fix was applied to the `behind` path only. The `unreadable` path kept the
 * bare exit, and `unreadable` was the path that was actually red: on 2026-08-30 the monitor
 * failed hourly on SUPABASE_TOKEN_CHANNELMOVER (401), YTMIGRATION_SUPABASE_ACCESS_TOKEN (401)
 * and arivioo-staging (no build version), and the reason existed only inside a workflow log.
 *
 * Blindness still exits non-zero — the house rule in fleet-signal.mjs is that only a failed
 * READ exits non-zero, and a watchdog that could not read IS a failed read. These cases pin
 * that the fact is FILED as well, and that a dead token reads differently from a dead project,
 * because the remedies differ: one needs a new token minted by a person, the other needs the
 * project looked at. No network, no secrets, no services.
 *
 * Run: node test/check-supabase-build-currency.test.mjs   (exit 0 = all pass)
 */
import assert from 'node:assert'
import { blindSignal } from '../scripts/check-supabase-build-currency.mjs'

let passed = 0
let failed = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok   - ${name}`); passed++ }
  catch (e) { console.log(`  FAIL - ${name}: ${e.message}`); failed++ }
}

check('a fully readable sweep files nothing', () => {
  assert.equal(blindSignal([{ product: 'ReplyFlow', level: 'ok' }, { product: 'Valrano', level: 'warn' }]), null,
    'only blindness files a blindness row')
})

check('the row asks for a human and is keyed stably', () => {
  const row = blindSignal([{ product: 'SUPABASE_TOKEN_CHANNELMOVER', level: 'unreadable', isToken: true, detail: 'management API returned 401 — token dead or rotated' }])
  assert.equal(row.needs_human, true, 'only a person can mint a replacement management token')
  assert.equal(row.severity, 'critical')
  assert.equal(row.key, 'supabase-build-currency-blind', 'a stable key updates one row instead of breeding duplicates every hour')
})

// The real 2026-08-30 run: two dead tokens and one project that would not report a version.
check('dead TOKENS and unreadable PROJECTS are counted and described separately', () => {
  const row = blindSignal([
    { product: 'Valrano Production', level: 'ok' },
    { product: 'SUPABASE_TOKEN_CHANNELMOVER', level: 'unreadable', isToken: true, detail: 'management API returned 401 — token dead or rotated' },
    { product: 'YTMIGRATION_SUPABASE_ACCESS_TOKEN', level: 'unreadable', isToken: true, detail: 'management API returned 401 — token dead or rotated' },
    { product: 'arivioo-staging', level: 'unreadable', detail: 'could not read build version' },
  ])
  assert.match(row.summary, /2 management token\(s\)/, 'the two dead tokens must be counted as tokens')
  assert.match(row.summary, /1 project\(s\)/, 'the unreadable project must NOT be lumped in with the tokens')
  assert.match(row.summary, /SUPABASE_TOKEN_CHANNELMOVER/)
  assert.match(row.summary, /YTMIGRATION_SUPABASE_ACCESS_TOKEN/, 'every dead token must be named, not just the first')
  assert.match(row.summary, /arivioo-staging/)
  assert.equal(row.title, 'The Supabase build watchdog is blind for 3 subject(s)')
  assert.equal(row.detail.blind.length, 3, 'the machine-readable detail must carry all three')
  assert.equal(row.detail.blind.filter((b) => b.isToken).length, 2)
})

check('an unreadable-projects-only sweep does not claim any token is dead', () => {
  const row = blindSignal([{ product: 'arivioo-staging', level: 'unreadable', detail: 'could not read build version' }])
  assert.ok(!/management token/.test(row.summary), 'no dead token must be implied when every token authenticated')
  assert.match(row.summary, /1 project\(s\)/)
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
