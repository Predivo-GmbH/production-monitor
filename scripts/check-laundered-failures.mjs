/**
 * Guard: a failing test must not be able to erase itself on the retry.
 *
 * THE HOLE (found live 2026-09-03, monitor run 33706296807). Playwright classifies a test as
 * "flaky" whenever it has both failing and non-failing attempts — and `skipped` counts as
 * non-failing. So a test that FAILS on attempt 1 and whose RETRY calls `test.skip()` is
 * reported as flaky, not failed, and `npx playwright test` EXITS 0. Reproduced from scratch:
 * a one-test suite of exactly that shape prints "1 flaky" and returns exit code 0.
 *
 * That is a green run over a failure nobody disproved, and it fails BOTH ways at once:
 *   - exit 0 means the job succeeds, so every `if: failure()` step in monitor.yml — auto-fix,
 *     auto-heal, triage AND the alert email — never runs;
 *   - and the alert's own parser only ever collected `status === 'unexpected'`, so even a run
 *     reddened by something else would not have NAMED the laundered test.
 *
 * It is not hypothetical and not confined to one spec: tests/ has 40+ runtime
 * `test.skip(cond, ...)` sites, and any condition that can evaluate differently on the retry
 * than on the first attempt opens this. The live instance: ChannelMover's OTP test failed on
 * the unreadable test mailbox, and its retry was rate-limited BY the first attempt's own OTP
 * request, so the spec skipped it. Four other projects failed outright that hour and masked it;
 * alone, that run would have gone out green.
 *
 * This step runs `if: always()` after the Playwright step and fails the run when any test
 * failed and never once passed. Legitimate flakes are untouched: failed-then-PASSED still has
 * a passing attempt, so retries keep absorbing real blips exactly as before.
 *
 * With no results.json there is nothing to read, and this prints UNPROVEN rather than OK — an
 * "all clear" that never looked is the failure mode this repo keeps finding in its own sensors.
 * It exits 0 there because the missing report is already reported by the Playwright step and by
 * send-alert.mjs; this guard's job is the laundered case, not that one.
 */
import { readFileSync, existsSync } from 'fs'
import { findLaunderedFailures } from './lib/parse-failures.mjs'

const RESULTS = process.env.PLAYWRIGHT_RESULTS || 'test-results/results.json'

if (!existsSync(RESULTS)) {
  console.log(`UNPROVEN: ${RESULTS} does not exist, so no test was checked for a laundered failure.`)
  console.log('This is NOT an all-clear. The Playwright step and send-alert.mjs report a missing report.')
  process.exit(0)
}

let results
try {
  results = JSON.parse(readFileSync(RESULTS, 'utf-8'))
} catch (e) {
  console.log(`UNPROVEN: cannot parse ${RESULTS} (${e.message}), so no test was checked.`)
  process.exit(0)
}

const laundered = findLaunderedFailures(results)

if (laundered.length === 0) {
  const stats = results.stats || {}
  console.log(
    `OK: no laundered failure. Every test that failed either failed outright (and is in the exit code) `
    + `or passed on a retry. Checked ${stats.expected ?? '?'} passed / ${stats.unexpected ?? '?'} failed / `
    + `${stats.flaky ?? '?'} flaky / ${stats.skipped ?? '?'} skipped.`,
  )
  process.exit(0)
}

console.log(`::error title=A failed test erased itself on the retry::${laundered.length} test(s) failed and were NOT reported as failures`)
console.log('')
console.log(`${laundered.length} test(s) failed at least once, never passed, and Playwright did not count them`)
console.log('as failures — so this run would have exited 0 on them alone. They are NOT recovered:')
console.log('')
for (const row of laundered) {
  console.log(`  - ${row.project} › ${row.test}${row.file ? ` (${row.file})` : ''}`)
  console.log(`      ${row.error}`)
}
console.log('')
console.log('A retry that does not re-test cannot clear the attempt that failed. Fix the spec so the')
console.log('retry either re-tests or fails — do not silence this step.')
process.exit(1)
