/**
 * Pure failure-derivation for the monitor alert (scripts/send-alert.mjs).
 *
 * WHY THIS EXISTS (2026-08-29). A monitor run can go red on a STEP that is not a
 * Playwright test — the "Out-of-band canaries" step is the common one (a dead/rotated
 * secret, a vendor 5xx). When that happens the Playwright report has ZERO failed specs,
 * so the old renderer fell through to a content-free "Run failed — no per-test detail"
 * that named neither the failing check nor its error. The incident: a Distribution-OS
 * REST 503 was mailed as "1 test(s) failed / likely a crash or timeout in setup".
 *
 * The fix: the canary step now writes canary-results.json, and deriveFailures() prefers
 * those NAMED failures over the generic line whenever the per-test report is empty.
 * Extracted here as a pure function so a unit suite can pin it with no network / no mail.
 */

/** Strip ANSI escape codes from error messages */
export function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '')
}

/** Recursively extract failed specs from nested suite structure.
 *  Playwright nests: file-suite (title=filename) > describe-suite (title=describe name) > specs.
 *  We prefer the deepest suite title that isn't a filename (contains " — "). */
export function extractFailures(suite, parentName) {
  const failures = []
  // Use this suite's title if it looks like a describe name, otherwise fall back to parent
  const isDescribe = suite.title && !suite.title.endsWith('.spec.ts')
  const name = isDescribe ? suite.title.replace(/ — Production Monitor$/, '') : (parentName || suite.title || 'Unknown')

  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      if (test.status === 'unexpected') {
        // Pull the error from the last result that actually failed (an
        // 'unexpected' test's final result holds the real error).
        const failedResult = [...(test.results ?? [])].reverse()
          .find((r) => r.errors?.length || r.error) || test.results?.[test.results.length - 1]
        const errorMsg = failedResult?.errors?.[0]?.message
          || failedResult?.error?.message
          || 'Unknown error'
        const location = failedResult?.errors?.[0]?.location
        const cleanError = stripAnsi(errorMsg).split('\n')[0].slice(0, 300)
        const fileRef = location
          ? `${location.file?.split('/').pop()}:${location.line}`
          : ''

        failures.push({
          project: name,
          test: spec.title || 'Unknown test',
          error: cleanError,
          file: fileRef,
        })
      }
    }
  }

  for (const child of suite.suites ?? []) {
    failures.push(...extractFailures(child, name))
  }

  return failures
}

/** Normalise a canary-results.json failure record into an alert row. */
export function canaryRows(canaryFailures = []) {
  return (canaryFailures ?? []).map((c) => ({
    project: c.project || 'Out-of-band canary',
    test: c.check || c.test || 'canary',
    error: c.error || String(c),
    file: c.file || '',
  }))
}

/**
 * Given the parsed Playwright results.json object and the canary failures
 * (from canary-results.json), return the failure rows the alert should render.
 *
 * Order of preference when there are NO failed specs:
 *   1. a NAMED out-of-band canary/step failure (the 2026-08-29 incident class),
 *   2. Playwright's own top-level errors (global setup/teardown / worker crash),
 *   3. the last-resort generic "no per-test detail" line.
 */
export function deriveFailures(results, canaryFailures = []) {
  const failures = []
  for (const suite of results.suites ?? []) failures.push(...extractFailures(suite, null))
  if (failures.length > 0) return failures

  // No per-test failures but the run still failed. Prefer a named canary/step
  // failure over a content-free "no per-test detail" — the whole point of the fix.
  const canary = canaryRows(canaryFailures)
  if (canary.length > 0) return canary

  const topErrors = (results.errors ?? [])
    .map((e) => stripAnsi(e?.message || String(e)).split('\n')[0].slice(0, 300))
    .filter(Boolean)
  if (topErrors.length) {
    return topErrors.map((msg) => ({
      project: 'Run-level error',
      test: 'global setup/teardown / worker',
      error: msg,
      file: '',
    }))
  }

  const s = results.stats || {}
  const statsLine = Object.keys(s).length
    ? `${s.expected ?? '?'} passed, ${s.unexpected ?? '?'} failed, ${s.flaky ?? '?'} flaky, ${s.skipped ?? '?'} skipped`
    : 'report had no suites and no top-level errors'
  return [{
    project: 'Run failed — no per-test detail',
    test: 'see run logs',
    error: `The run failed but produced no parseable per-test failures (${statsLine}). Likely a crash/timeout in setup or a worker died. Open the run logs.`,
    file: '',
  }]
}
