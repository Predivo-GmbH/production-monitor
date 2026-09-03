#!/usr/bin/env node
/**
 * A NON-TEST-STEP MONITOR FAILURE IS NOT A LOCAL-TRIAGE-RUNNER FAILURE.
 *
 * WHY (2026-09-03). The "Production Monitor" run can go red on a step that is NOT a Playwright
 * test — the out-of-band canaries (a dead/rotated key, a vendor 5xx) are the common one, and
 * machine-health / expire-sessions sweeps do the same. That failure carries its own NAMED alert
 * (send-alert.mjs's deriveFailures/canaryRows, the 2026-08-29 canary fix). But local-triage-
 * runner.mjs used to run agent-triage against it anyway; agent-triage found no failing spec to
 * triage, exited without a verdict, and the runner recorded a MISSING attempt and pinged the
 * agenttriage-localrunner dead-man RED. Observed live at 13:13Z and 14:13Z: two consecutive
 * canary-failing monitor runs each flapped that dead-man red for one tick. The runner was healthy;
 * nothing in its spec-triage scope had failed. That red was false.
 *
 * The fix routes the decision through isNonTestStepFailure(results.json text): the runner treats a
 * failed run with a readable report and ZERO failing specs as out-of-scope (green), while staying
 * conservative — RED — whenever it cannot PROVE no spec failed (absent/unreadable report), and
 * whenever a spec did fail (including a LAUNDERED failed-then-skipped spec, the exact false-green
 * this fleet keeps finding). These cases pin that boundary. No network, no services, no secrets.
 *
 * Run: node test/canary-failure-is-not-a-runner-failure.test.mjs   (exit 0 = all pass)
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isNonTestStepFailure } from '../scripts/lib/parse-failures.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')

let failures = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ok - ${name}`) } catch (e) {
    failures++
    console.log(`  NOT OK - ${name}`)
    console.log(`      ${e.message.split('\n').slice(0, 4).join('\n      ')}`)
  }
}

// A results.json where every spec PASSED — the shape of a canary-only / non-test-step failure.
const allSpecsPassed = JSON.stringify({
  suites: [{
    title: 'replyflow/production-monitor.spec.ts',
    suites: [{
      title: 'ReplyFlow — Production Monitor',
      specs: [{ title: 'landing page loads', tests: [{ status: 'expected', results: [{ status: 'passed' }] }] }],
    }],
  }],
  stats: { expected: 1, unexpected: 0, flaky: 0, skipped: 0 },
})

// A results.json with a genuine failed spec.
const oneSpecFailed = JSON.stringify({
  suites: [{
    title: 'replyflow/production-monitor.spec.ts',
    suites: [{
      title: 'ReplyFlow — Production Monitor',
      specs: [{ title: 'landing page loads', tests: [{ status: 'unexpected', results: [{ status: 'failed', errors: [{ message: 'expect(200) got 500' }] }] }] }],
    }],
  }],
})

// A LAUNDERED failure: failed on attempt 1, the retry test.skip()'d, so Playwright never marks it
// 'unexpected' and its exit code is 0 — but nothing ever disproved the failure. It MUST NOT read as
// a clean report (that is the false-green this whole file exists to prevent).
const oneSpecLaundered = JSON.stringify({
  suites: [{
    title: 'channelmover/production-monitor.spec.ts',
    suites: [{
      title: 'ChannelMover — Production Monitor',
      specs: [{
        title: 'OTP email arrives',
        tests: [{
          status: 'skipped',
          results: [
            { status: 'failed', errors: [{ message: 'mailbox empty' }] },
            { status: 'skipped', annotations: [{ type: 'skip', description: 'supabase rate limit' }] },
          ],
        }],
      }],
    }],
  }],
})

console.log('\nisNonTestStepFailure — the false-green boundary')

ok('a run with a readable report and ZERO failing specs is OUT OF SCOPE (green): the failure was a non-test step', () => {
  assert.equal(isNonTestStepFailure(allSpecsPassed), true)
})

ok('a report with a genuinely failed spec is IN SCOPE (not out-of-scope) — the runner must not skip it', () => {
  assert.equal(isNonTestStepFailure(oneSpecFailed), false)
})

ok('THE FALSE-GREEN GUARD: a LAUNDERED failed-then-skipped spec is NOT a clean report — stay conservative', () => {
  assert.equal(isNonTestStepFailure(oneSpecLaundered), false, 'a spec that failed and never passed is a failure, whatever Playwright labelled it')
})

ok('an ABSENT report (null) is conservative, NOT out-of-scope — we cannot prove no spec failed', () => {
  assert.equal(isNonTestStepFailure(null), false)
  assert.equal(isNonTestStepFailure(undefined), false)
})

ok('an UNREADABLE report is conservative, NOT out-of-scope — a failed parse is never a clean result', () => {
  assert.equal(isNonTestStepFailure('{ not json'), false)
  assert.equal(isNonTestStepFailure('{"stats":{}}'), false, 'no suites array = not a readable envelope')
})

console.log('\nSHAPE — the runner routes the monitor path through this decision before it can red the check')

{
  const src = readFileSync(join(REPO, 'scripts/local-triage-runner.mjs'), 'utf-8')
  ok('local-triage-runner returns on a non-test-step failure BEFORE recording an attempt', () => {
    assert.match(src, /isNonTestStepFailure\(/, 'the monitor path must consult the boundary decision')
    // The skip branch dedups (records the handled run) and returns, so no proved:false attempt is
    // pushed and the verdict stays idle/green.
    assert.match(src, /if \(isNonTestStepFailure\(resultsRaw\)\)[\s\S]{0,400}state\.lastHandledRun = run\.databaseId[\s\S]{0,200}return/,
      'the branch must record handled (dedup) and return before the agent/attempt block')
  })
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failing assertion(s)\n`)
process.exit(failures === 0 ? 0 : 1)
