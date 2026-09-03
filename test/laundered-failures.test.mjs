// A failing test must not be able to erase itself on the retry.
//
// THE REGRESSION (2026-09-03, monitor run 33706296807). ChannelMover's OTP test failed on the
// unreadable shared mailbox; its retry hit the spec's own Supabase rate-limit branch — rate-limited
// BY the first attempt's own OTP request — and called test.skip(). Playwright counts `skipped` as a
// non-failing attempt, so a failed-then-skipped test is reported "flaky" and the runner EXITS 0.
// Four other projects failed outright that hour and masked it; alone, the run would have gone GREEN.
//
// The fixture below is not imagined. It is the shape Playwright ACTUALLY emitted for a minimal
// two-attempt suite of exactly that form (failed, then a skipped retry), read back out of its own
// results.json — `1 flaky`, exit code 0 — and reduced to the fields the parser reads.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  isUnrecoveredFailure,
  isLaunderedFailure,
  launderedReason,
  findLaunderedFailures,
  extractFailures,
  deriveFailures,
} from '../scripts/lib/parse-failures.mjs'

const GUARD = fileURLToPath(new URL('../scripts/check-laundered-failures.mjs', import.meta.url))

/** Verbatim (reduced) shape of the real failed→skipped-retry test Playwright produced. */
const LAUNDERED = {
  status: 'flaky',
  annotations: [{ type: 'skip', description: 'OTP request rate-limited: over_email_send_rate_limit' }],
  results: [
    {
      status: 'failed',
      errors: [{
        message: 'Error: MONITOR FAULT - cannot verify ChannelMover OTP delivery',
        location: { file: '/x/tests/ytmigration/production-monitor.spec.ts', line: 424, column: 13 },
      }],
      annotations: [],
    },
    {
      status: 'skipped',
      errors: [],
      annotations: [{ type: 'skip', description: 'OTP request rate-limited: over_email_send_rate_limit' }],
    },
  ],
}

/** A genuine flake: failed, then PASSED. Retries exist for this and it must stay absorbed. */
const REAL_FLAKE = {
  status: 'flaky',
  annotations: [],
  results: [
    { status: 'failed', errors: [{ message: 'Error: net::ERR_CONNECTION_RESET' }], annotations: [] },
    { status: 'passed', errors: [], annotations: [] },
  ],
}

/** Skipped on every attempt (IMAP_PASS unset). Never failed — not a failure. */
const ALWAYS_SKIPPED = {
  status: 'skipped',
  annotations: [{ type: 'skip', description: 'IMAP_PASS not configured' }],
  results: [{ status: 'skipped', errors: [], annotations: [] }],
}

/** An ordinary outright failure — already in the exit code. */
const OUTRIGHT = {
  status: 'unexpected',
  annotations: [],
  results: [
    { status: 'failed', errors: [{ message: 'Error: expected 200, got 503' }], annotations: [] },
    { status: 'failed', errors: [{ message: 'Error: expected 200, got 503' }], annotations: [] },
  ],
}

const PASSED = { status: 'expected', annotations: [], results: [{ status: 'passed', errors: [], annotations: [] }] }

function suiteOf(pairs) {
  return {
    title: 'production-monitor.spec.ts',
    suites: [{
      title: 'ChannelMover — Production Monitor',
      specs: pairs.map(([title, t]) => ({ title, tests: [t] })),
      suites: [],
    }],
    specs: [],
  }
}

// ── the classifier ────────────────────────────────────────────────────────────────────────

test('a failed test whose retry was SKIPPED is an unrecovered failure, not a flake', () => {
  assert.equal(isUnrecoveredFailure(LAUNDERED), true)
  assert.equal(isLaunderedFailure(LAUNDERED), true, 'Playwright did not call it unexpected, so it is laundered')
})

test('a failed test that PASSED on retry stays absorbed — retries must keep working', () => {
  assert.equal(isUnrecoveredFailure(REAL_FLAKE), false)
  assert.equal(isLaunderedFailure(REAL_FLAKE), false)
})

test('a test skipped on every attempt never failed, so it is not a failure', () => {
  assert.equal(isUnrecoveredFailure(ALWAYS_SKIPPED), false)
  assert.equal(isLaunderedFailure(ALWAYS_SKIPPED), false)
})

test('an outright failure is still a failure, and is NOT double-counted as laundered', () => {
  assert.equal(isUnrecoveredFailure(OUTRIGHT), true)
  assert.equal(isLaunderedFailure(OUTRIGHT), false, 'it is already in the exit code')
})

test('a passing test is not a failure', () => {
  assert.equal(isUnrecoveredFailure(PASSED), false)
})

test('an interrupted retry launders a failure exactly like a skipped one', () => {
  const interrupted = {
    status: 'flaky',
    annotations: [],
    results: [
      { status: 'failed', errors: [{ message: 'Error: boom' }], annotations: [] },
      { status: 'interrupted', errors: [], annotations: [] },
    ],
  }
  assert.equal(isLaunderedFailure(interrupted), true, 'an absent result is not a passing one')
})

test('the reason names WHY the retry did not re-test, so the row is actionable', () => {
  const why = launderedReason(LAUNDERED)
  assert.match(why, /skipped/)
  assert.match(why, /over_email_send_rate_limit/)
})

// ── what the alert email says ─────────────────────────────────────────────────────────────

test('the alert NAMES a laundered failure — the old parser dropped it entirely', () => {
  const rows = extractFailures(suiteOf([['E2E OTP: ChannelMover', LAUNDERED]]), null)
  assert.equal(rows.length, 1, 'a laundered failure must reach the alert')
  assert.equal(rows[0].project, 'ChannelMover')
  assert.match(rows[0].error, /NOT RETESTED/)
  assert.match(rows[0].error, /never disproven/)
  assert.match(rows[0].error, /MONITOR FAULT/, 'the original error must survive')
  assert.equal(rows[0].file, 'production-monitor.spec.ts:424')
})

test('a laundered failure alone still produces real alert rows, not the no-detail fallback', () => {
  const rows = deriveFailures({ suites: [suiteOf([['E2E OTP: ChannelMover', LAUNDERED]])] }, [])
  assert.equal(rows.length, 1)
  assert.match(rows[0].error, /NOT RETESTED/)
  assert.ok(!/no per-test detail/.test(rows[0].error))
})

test('a green run with a genuine flake produces no rows at all', () => {
  const rows = extractFailures(suiteOf([['ok', PASSED], ['blip', REAL_FLAKE], ['off', ALWAYS_SKIPPED]]), null)
  assert.deepEqual(rows, [])
})

test('findLaunderedFailures returns only the laundered subset', () => {
  const results = { suites: [suiteOf([
    ['E2E OTP: ChannelMover', LAUNDERED],
    ['dead backend', OUTRIGHT],
    ['blip', REAL_FLAKE],
    ['ok', PASSED],
  ])] }
  const rows = findLaunderedFailures(results)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].test, 'E2E OTP: ChannelMover')
})

// ── the guard step's exit code, which is what actually reddens the run ─────────────────────

function runGuard(results) {
  const dir = mkdtempSync(join(tmpdir(), 'laundered-'))
  const file = join(dir, 'results.json')
  if (results !== null) writeFileSync(file, JSON.stringify(results))
  try {
    const stdout = execFileSync(process.execPath, [GUARD], {
      env: { ...process.env, PLAYWRIGHT_RESULTS: file },
      encoding: 'utf-8',
    })
    return { code: 0, stdout }
  } catch (e) {
    return { code: e.status, stdout: e.stdout || '' }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('THE REGRESSION: the guard FAILS the run on a laundered failure Playwright exited 0 on', () => {
  const { code, stdout } = runGuard({
    stats: { expected: 199, unexpected: 0, flaky: 1, skipped: 9 },
    suites: [suiteOf([['E2E OTP: ChannelMover', LAUNDERED]])],
  })
  assert.equal(code, 1, 'a failure nobody disproved must red the run')
  assert.match(stdout, /ChannelMover/)
  assert.match(stdout, /NOT RETESTED/)
})

test('the guard stays quiet on a clean run, so it cannot make the monitor noisy', () => {
  const { code, stdout } = runGuard({
    stats: { expected: 200, unexpected: 0, flaky: 1, skipped: 9 },
    suites: [suiteOf([['ok', PASSED], ['blip', REAL_FLAKE], ['off', ALWAYS_SKIPPED]])],
  })
  assert.equal(code, 0)
  assert.match(stdout, /^OK:/m)
})

test('the guard does not double-red a run that already failed outright', () => {
  const { code } = runGuard({ stats: {}, suites: [suiteOf([['dead backend', OUTRIGHT]])] })
  assert.equal(code, 0, 'an outright failure is already in the Playwright exit code')
})

test('with no results.json the guard says UNPROVEN, never OK — it did not look', () => {
  const { code, stdout } = runGuard(null)
  assert.equal(code, 0)
  assert.match(stdout, /UNPROVEN/)
  assert.ok(!/^OK:/m.test(stdout), 'an all-clear that never looked is the bug this repo keeps finding')
})
