// The regression this suite exists for: on 2026-09-04 (board incident alerter-pages-on-cancelled-run)
// monitor run 33861839218 concluded CANCELLED with every step success/skipped — 204 specs passed,
// 0 failed — yet the alert step (gated `failure() || cancelled()` since c8db569 so a job-timeout
// with real failures still pages) fired on cancelled() and mailed "1 failure(s)" over a body that
// said "0 failed", inventing a synthetic "Run failed — no per-test detail" row. isCleanCancelledRun
// is the scalpel: suppress ONLY when the run was cancelled with no step failure AND the only row is
// a synthetic no-evidence fallback. Any concrete evidence, or a failed step, still pages.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isCleanCancelledRun,
  deriveFailures,
  NO_DETAIL_PROJECT,
  NO_REPORT_PROJECT,
} from '../scripts/lib/parse-failures.mjs'

const cancelledClean = { cancelledNoFailure: true }
const notCancelled = { cancelledNoFailure: false }

test('the exact incident: cancelled + only the no-per-test-detail row → suppress', () => {
  // What deriveFailures returns for run 33861839218's report (204 passed, 0 failed, 0 flaky, 9 skipped).
  const report = { suites: [], errors: [], stats: { expected: 204, unexpected: 0, flaky: 0, skipped: 9 } }
  const failures = deriveFailures(report, [])
  assert.equal(failures.length, 1)
  assert.equal(failures[0].project, NO_DETAIL_PROJECT)
  assert.equal(isCleanCancelledRun(failures, cancelledClean), true)
})

test('cancelled + no rows at all → suppress', () => {
  assert.equal(isCleanCancelledRun([], cancelledClean), true)
})

test('cancelled + only the no-report-produced row → suppress', () => {
  const failures = [{ project: NO_REPORT_PROJECT, test: 'results.json missing', error: '...', file: '' }]
  assert.equal(isCleanCancelledRun(failures, cancelledClean), true)
})

test('NOT cancelled (failure()=true) → never suppress, even with only the synthetic row', () => {
  // A non-test STEP failed: the job conclusion is failure, so cancelled() && !failure() is false.
  // The generic row is still a real red the step-failure lookup will name — must page.
  const failures = [{ project: NO_DETAIL_PROJECT, test: 'see run logs', error: '...', file: '' }]
  assert.equal(isCleanCancelledRun(failures, notCancelled), false)
})

test('cancelled but a real spec failed → never suppress', () => {
  // A job-timeout that cancelled the run AFTER a spec had already failed: extractFailures returns a
  // real, non-synthetic row. c8db569 must still reach a human.
  const failures = [{ project: 'ReplyFlow', test: 'signup e2e', error: 'expect(...).toBeVisible failed', file: 'x.spec.ts:10' }]
  assert.equal(isCleanCancelledRun(failures, cancelledClean), false)
})

test('cancelled but a named canary failed → never suppress', () => {
  const failures = [{ project: 'Out-of-band canary', test: 'service-key: ScoutCopilot', error: '401 dead/rotated key?', file: '' }]
  assert.equal(isCleanCancelledRun(failures, cancelledClean), false)
})

test('cancelled + synthetic row PLUS a real row → never suppress (two rows, not lone synthetic)', () => {
  const failures = [
    { project: NO_DETAIL_PROJECT, test: 'see run logs', error: '...', file: '' },
    { project: 'ChannelMover', test: 'dashboard loads', error: 'boom', file: '' },
  ]
  assert.equal(isCleanCancelledRun(failures, cancelledClean), false)
})

test('missing/absent cancelledNoFailure signal → never suppress (manual run, other caller)', () => {
  const failures = [{ project: NO_DETAIL_PROJECT, test: 'see run logs', error: '...', file: '' }]
  assert.equal(isCleanCancelledRun(failures, {}), false)
  assert.equal(isCleanCancelledRun(failures), false)
})

test('junk in does not throw', () => {
  assert.equal(isCleanCancelledRun(null, cancelledClean), false)
  assert.equal(isCleanCancelledRun(undefined, cancelledClean), false)
  assert.equal(isCleanCancelledRun('nope', cancelledClean), false)
})
