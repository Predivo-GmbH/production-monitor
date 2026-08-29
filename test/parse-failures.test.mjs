/**
 * Unit test for deriveFailures (scripts/lib/parse-failures.mjs).
 *
 * The 2026-08-29 board finding: a monitor run went red ONLY on the "Out-of-band canaries"
 * step (a Distribution-OS REST 503). No Playwright spec failed, so the report carried zero
 * failures and the alert rendered the content-free "Run failed — no per-test detail / likely
 * a crash or timeout in setup" — naming neither the failing check nor its error. These cases
 * pin that a NAMED canary failure is surfaced instead, with no network and no mail.
 *
 * Run: node test/parse-failures.test.mjs   (exit 0 = all pass)
 */
import assert from 'node:assert'
import { deriveFailures, canaryRows } from '../scripts/lib/parse-failures.mjs'

let passed = 0
let failed = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok   - ${name}`); passed++ }
  catch (e) { console.log(`  FAIL - ${name}: ${e.message}`); failed++ }
}

// A Playwright report with one failed spec (nested file-suite > describe > spec).
const reportWithFailure = {
  suites: [{
    title: 'replyflow/production-monitor.spec.ts',
    suites: [{
      title: 'ReplyFlow — Production Monitor',
      specs: [{
        title: 'landing page loads',
        tests: [{ status: 'unexpected', results: [{ errors: [{ message: 'expect(200) got 500' }] }] }],
      }],
    }],
  }],
}

const canaryFailure = [
  { project: 'Out-of-band canary', check: 'service-key: Distribution-OS', error: 'REST root returned 503 (Supabase REST unavailable, not a key problem — retried once)' },
]

check('a per-test failure AND a canary failure BOTH surface (rotated key: the dead-credential line must not be dropped)', () => {
  // A rotated/dead key breaks the live-site spec AND trips the canary in the same run.
  // Returning only the spec would bury the named credential line — the class the canaries exist for.
  const rows = deriveFailures(reportWithFailure, canaryFailure)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].project, 'ReplyFlow')
  assert.match(rows[0].error, /got 500/)
  assert.ok(rows.some((r) => /service-key: Distribution-OS/.test(r.test)),
    'the out-of-band canary must still reach the alert, not be replaced by the spec failure')
})

check('THE INCIDENT: zero failed specs + a canary failure surfaces the NAMED check, never the generic line', () => {
  const rows = deriveFailures({ suites: [], errors: [], stats: { expected: 200, unexpected: 0 } }, canaryFailure)
  assert.equal(rows.length, 1)
  assert.match(rows[0].test, /service-key: Distribution-OS/, 'the failing check must be named')
  assert.match(rows[0].error, /503/, 'the printed error must be carried into the mail')
  assert.ok(!/no per-test detail/i.test(rows[0].error), 'must NOT fall through to the generic line')
  assert.ok(!/dead\/rotated key/i.test(rows[0].error), 'a 5xx must not be blamed on the key')
})

check('a 5xx canary error reads as availability, not auth', () => {
  const [row] = canaryRows(canaryFailure)
  assert.match(row.error, /unavailable|not a key problem/i)
  assert.ok(!/dead\/rotated key/i.test(row.error))
})

check('zero specs + no canary + a top-level error surfaces the run-level error', () => {
  const rows = deriveFailures({ suites: [], errors: [{ message: 'global setup failed: Error: boom' }] }, [])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].project, 'Run-level error')
  assert.match(rows[0].error, /global setup failed/)
})

check('zero specs + nothing else falls back to the generic no-per-test-detail line', () => {
  const rows = deriveFailures({ suites: [], errors: [], stats: { expected: 200, unexpected: 0 } }, [])
  assert.equal(rows.length, 1)
  assert.match(rows[0].project, /no per-test detail/)
  assert.match(rows[0].error, /200 passed/)
})

console.log(`\n${passed} passed, ${failed} failed.`)
process.exit(failed ? 1 : 0)
