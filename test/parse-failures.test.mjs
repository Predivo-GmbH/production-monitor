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
import { deriveFailures, canaryRows, isNoDetailFallback, failedStepRows, NO_DETAIL_PROJECT } from '../scripts/lib/parse-failures.mjs'

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

// ── 2026-08-30 board incident: a run went red ONLY on the non-test step "Supabase build
// currency" (176 passed, 0 failed), and the alert rendered the generic no-per-test-detail row,
// which the header printed as "1 test(s) failed". These pin that (a) the fallback is detectable,
// and (b) the failing STEP is named instead, so a red monitor says what actually broke.

check('the no-per-test-detail fallback is detectable as such', () => {
  const rows = deriveFailures({ suites: [], errors: [], stats: { expected: 176, unexpected: 0 } }, [])
  assert.equal(rows[0].project, NO_DETAIL_PROJECT)
  assert.ok(isNoDetailFallback(rows), 'the generic fallback must be recognised')
})

check('a real test failure is NOT mistaken for the fallback', () => {
  const rows = deriveFailures(reportWithFailure, [])
  assert.ok(!isNoDetailFallback(rows), 'a genuine per-test failure must never be replaced by step rows')
})

check('failedStepRows names the failed workflow STEP, not a phantom test', () => {
  const jobs = [{
    name: 'monitor',
    steps: [
      { name: 'Run production monitor', conclusion: 'success' },
      { name: 'Supabase build currency (how far behind each project is)', conclusion: 'failure' },
      { name: 'Out-of-band canaries', conclusion: 'success' },
    ],
  }]
  const rows = failedStepRows(jobs)
  assert.equal(rows.length, 1)
  assert.match(rows[0].test, /Supabase build currency/, 'the failing step must be named')
  assert.ok(!/test/i.test(rows[0].project) || /step/i.test(rows[0].project), 'it must read as a step, not a test')
  assert.match(rows[0].error, /No Playwright test failed/, 'must say no test failed')
})

check('a continue-on-error step (conclusion success, outcome failure) is NOT named', () => {
  // ci_watchdog_alive fails with continue-on-error, so its conclusion is success here and it
  // owns a dedicated email — naming it would double-report one event.
  const jobs = [{ name: 'monitor', steps: [{ name: 'CI runner watchdog is still alive', conclusion: 'success' }] }]
  assert.equal(failedStepRows(jobs).length, 0)
})

check('failedStepRows tolerates empty / missing input', () => {
  assert.equal(failedStepRows([]).length, 0)
  assert.equal(failedStepRows(undefined).length, 0)
  assert.equal(failedStepRows([{ name: 'j' }]).length, 0)
})

console.log(`\n${passed} passed, ${failed} failed.`)
process.exit(failed ? 1 : 0)
