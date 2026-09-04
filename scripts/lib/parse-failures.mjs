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

/**
 * A test FAILED at least once and never once passed — so nothing ever disproved that failure.
 *
 * WHY THIS IS NOT `status === 'unexpected'` (2026-09-03). Playwright calls a test "flaky" when
 * it has both failing and non-failing attempts — and `skipped` counts as non-failing. So a test
 * that fails on attempt 1 and whose RETRY calls `test.skip()` is reported as flaky, which reads
 * as "it recovered", and `npx playwright test` EXITS 0. Reproduced: a one-test suite of exactly
 * that shape prints "1 flaky" and exit code 0 — a green run over a failure nobody disproved.
 *
 * This is reachable from 40+ runtime `test.skip(cond, ...)` sites in tests/, because a condition
 * evaluated on the retry can differ from the same condition on the first attempt. It bit us live
 * in monitor run 33706296807: ChannelMover's OTP test failed on the mailbox, then its retry hit
 * the spec's own Supabase rate-limit branch — rate-limited BY the first attempt's own OTP
 * request — and skipped. It was masked only because four other projects failed outright in the
 * same run; alone, it would have gone out as green.
 *
 * The invariant: a test that never passed has not been shown to be healthy, whatever Playwright
 * labelled it. `interrupted` is treated like `skipped` for the same reason — it is an absence of
 * a result, not a passing one.
 */
export function isUnrecoveredFailure(test) {
  if (test?.status === 'unexpected') return true
  const results = test?.results ?? []
  if (results.some((r) => r?.status === 'passed')) return false
  return results.some((r) => r?.status === 'failed' || r?.status === 'timedOut')
}

/** True for the subset of isUnrecoveredFailure() that Playwright did NOT count as a failure —
 *  i.e. the ones that would otherwise vanish from both the exit code and the alert. */
export function isLaunderedFailure(test) {
  return test?.status !== 'unexpected' && isUnrecoveredFailure(test)
}

/** The reason the final attempt gave for not re-testing, e.g. the `test.skip()` description.
 *  Playwright records it as an annotation on that result (type 'skip'). */
export function launderedReason(test) {
  const last = (test?.results ?? [])[(test?.results ?? []).length - 1]
  const ann = (last?.annotations ?? []).find((a) => a?.type === 'skip')
    || (test?.annotations ?? []).find((a) => a?.type === 'skip')
  const why = ann?.description ? `: ${stripAnsi(String(ann.description)).split('\n')[0].slice(0, 160)}` : ''
  return `${last?.status || 'no result'}${why}`
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
      if (isUnrecoveredFailure(test)) {
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

        // A laundered failure needs the label said out loud, because its FINAL attempt did not
        // fail — without this line the row reads as a plain failure and the next reader
        // re-derives the whole 2026-09-03 diagnosis from scratch.
        const error = isLaunderedFailure(test)
          ? `NOT RETESTED (Playwright called this "${test.status}", which does not fail a run): the first attempt failed and the retry never re-tested it — ${launderedReason(test)}. The failure was never disproven: ${cleanError.slice(0, 200)}`
          : cleanError

        failures.push({
          project: name,
          test: spec.title || 'Unknown test',
          error,
          file: fileRef,
          laundered: isLaunderedFailure(test),
        })
      }
    }
  }

  for (const child of suite.suites ?? []) {
    failures.push(...extractFailures(child, name))
  }

  return failures
}

/** The laundered subset of a whole results.json — the rows that failed, never passed, and that
 *  Playwright's exit code will NOT report. Reuses extractFailures so the guard step and the
 *  alert email can never disagree about what counts as a failure. */
export function findLaunderedFailures(results) {
  const rows = []
  for (const suite of results?.suites ?? []) rows.push(...extractFailures(suite, null))
  return rows.filter((r) => r.laundered)
}

/** The project label of the last-resort row deriveFailures() emits when a run failed
 *  but produced no parseable per-test failure, no named canary and no top-level error.
 *  Exported so send-alert.mjs can detect that fallback and replace it with the STEP that
 *  actually failed (see failedStepRows). */
export const NO_DETAIL_PROJECT = 'Run failed — no per-test detail'

/** The project label of the OTHER synthetic fallback send-alert.mjs emits when the run died before
 *  Playwright wrote any report at all (test-results/results.json absent). Shared here so both the
 *  producer (send-alert.mjs) and isCleanCancelledRun() name the same string. */
export const NO_REPORT_PROJECT = 'Run failed — no report produced'

/** True when `failures` is exactly the content-free no-per-test-detail fallback — i.e. the
 *  run went red on a non-test step (Supabase build currency / machine health / expire-sessions)
 *  while every Playwright spec passed, so there is nothing test-shaped to show. */
export function isNoDetailFallback(failures = []) {
  return failures.length === 1 && failures[0]?.project === NO_DETAIL_PROJECT
}

/**
 * A CANCELLED monitor run that carries NO concrete evidence of anything broken must not page.
 *
 * WHY THIS EXISTS (2026-09-04, board incident alerter-pages-on-cancelled-run, run 33861839218).
 * The alert step is gated `if: failure() || cancelled()` (commit c8db569) so a JOB-TIMEOUT that
 * DID find failures still reaches a human — a real fix. But the same widening pages on a run that
 * was cancelled with everything GREEN: a concurrency supersede, or (as on 33861839218) the job
 * merely overrunning its 40-minute cap after a 27-minute Chromium install, with all 204 specs
 * passing. deriveFailures then finds nothing and synthesises a "no per-test detail" row, so the
 * mail says "1 failure(s)" over a body that says "0 failed" — an alert that refutes itself.
 *
 * The scalpel: fire this ONLY when the run was cancelled AND no workflow STEP reported failure
 * (`cancelled() && !failure()`, passed in as cancelledNoFailure) AND `failures` holds nothing but
 * a synthetic no-evidence fallback row — no failed spec, no named canary, no failed step, no
 * top-level error. Any ONE concrete failure row (real project name) makes this false and the alert
 * fires as before. FAIL-SAFE: a non-test STEP failure sets failure()=true → cancelledNoFailure is
 * false → we page (2026-08-30 class preserved); a job-timeout WITH failing specs yields real rows
 * → not synthetic → we page (c8db569's intent preserved).
 *
 * @param {Array} failures            the rows deriveFailures/send-alert resolved for this run
 * @param {{cancelledNoFailure?: boolean}} opts  cancelledNoFailure = `cancelled() && !failure()`
 * @returns {boolean} true = suppress the alert (clean cancellation, nothing is wrong)
 */
/**
 * Did EVERY failure in this run happen before the browser reached the product at all?
 *
 * page.goto is the FIRST navigation. When every single failure carries that timeout, the runner
 * could not reach the host and NOTHING downstream was tested. Measured 2026-09-03/04: a run where
 * the runner could not reach 80.74.145.155 produced "[ALERT] 33 failure(s) - Arivioo (4),
 * BackOffice (11), BoatBuddy (4), Distribution-OS (7), Jass-Tour (5), LaunchReady (2)", every one
 * of them a page.goto timeout, while the six sites answered 200/301 from another machine minutes
 * later. Six products did not break; one runner could not see them.
 *
 * publish-check-results.mjs already abstains for this case on the DASHBOARD side (51eeed1). This
 * is the same defect in the other consumer: the alert counts SPECS, not fields, so the mail kept
 * saying 33 failures after the dashboard had stopped saying it.
 *
 * NOT a suppression. An unreachable host is worth telling him about - it is the SENTENCE that is
 * wrong, not the alert. The caller rewrites the subject instead of dropping the mail, because
 * silencing this would hide a real outage.
 */
export function isUnreachableRun(failures) {
  const list = Array.isArray(failures) ? failures : []
  if (list.length === 0) return false
  const goto = new RegExp(String.raw`page\.goto:\s*(Timeout|net::)`, 'i')
  return list.every((f) => goto.test(stripAnsi(String(f?.error ?? ''))))
}

export function isCleanCancelledRun(failures, { cancelledNoFailure } = {}) {
  if (!cancelledNoFailure) return false
  if (!Array.isArray(failures)) return false
  if (failures.length === 0) return true
  if (failures.length !== 1) return false
  const project = failures[0]?.project
  return project === NO_DETAIL_PROJECT || project === NO_REPORT_PROJECT
}

/** Turn the `jobs` array of `gh run view <id> --json jobs` into alert rows naming each STEP
 *  that failed. A non-test workflow step that exits 1 (build-currency finding a project
 *  unreadable, a machine-health probe, a stale-session sweep) fails the job but writes no
 *  Playwright result, so the alert used to synthesise a phantom "1 test(s) failed" row. This
 *  names the real step instead — the 2026-08-30 board incident, same class as the 2026-08-21
 *  drift-check misreport. continue-on-error steps report conclusion 'success' here (their
 *  outcome is failure but they own a dedicated alert), so they are correctly not named. */
export function failedStepRows(jobs = []) {
  const rows = []
  for (const job of jobs ?? []) {
    for (const step of job.steps ?? []) {
      if (step.conclusion === 'failure') {
        rows.push({
          project: 'Monitor step failed',
          test: step.name || 'unnamed step',
          error: `The workflow step "${step.name || 'unnamed step'}" exited non-zero. No Playwright test failed in this run — open the run logs for that step's output.`,
          file: '',
        })
      }
    }
  }
  return rows
}

/**
 * The monitor run FAILED, and the local spec-triage runner (local-triage-runner.mjs) is deciding
 * whether that failure is in ITS scope. It is NOT — and the runner must ping GREEN — when the run
 * failed at a NON-TEST step: the out-of-band canaries (a dead/rotated key, a vendor 5xx), a
 * machine-health probe, an expire-sessions sweep. None of those produce a failing Playwright spec,
 * and each carries its OWN named alert (deriveFailures/canaryRows, send-alert.mjs). Reddening the
 * agenttriage-localrunner dead-man for them is a FALSE red: the runner is healthy, nothing in its
 * spec-triage scope failed. (Observed live 2026-09-03 13:13Z/14:13Z: two consecutive canary
 * failures each flapped that dead-man red for one tick, because agent-triage found nothing to
 * triage and the runner then recorded a MISSING attempt.)
 *
 * Return TRUE (out of scope → green) ONLY when results.json is positively readable AND shows zero
 * unrecovered spec failures. Return FALSE (conservative → the run may go red) when the report is
 * absent or unreadable — then we cannot PROVE no spec failed, so we must not colour the check
 * green. Uses the laundered-aware extractFailures so a failed-then-skipped spec (isUnrecovered but
 * not `unexpected`) is never mistaken for a clean report — the exact false-green this fleet guards.
 *
 * @param {string|null|undefined} resultsRaw  text of test-results/results.json, or null if absent
 * @returns {boolean} true = non-test-step failure, out of this tier's scope; false = conservative
 */
export function isNonTestStepFailure(resultsRaw) {
  if (resultsRaw == null) return false
  let parsed
  try { parsed = JSON.parse(resultsRaw) } catch { return false }
  if (!Array.isArray(parsed.suites)) return false
  const failing = parsed.suites.flatMap((s) => extractFailures(s, null))
  return failing.length === 0
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
 * When there ARE failed specs, the canary rows are APPENDED, not dropped: a
 * rotated/dead service key breaks the live-site specs AND trips the canary in
 * the same run, so returning only the specs would bury the named credential
 * line (e.g. "service-key: ScoutCopilot - 401 dead/rotated key?") that is the
 * whole reason the canaries exist. Concatenating keeps both in the alert.
 *
 * Order of preference when there are NO failed specs:
 *   1. a NAMED out-of-band canary/step failure (the 2026-08-29 incident class),
 *   2. Playwright's own top-level errors (global setup/teardown / worker crash),
 *   3. the last-resort generic "no per-test detail" line.
 */
export function deriveFailures(results, canaryFailures = []) {
  const failures = []
  for (const suite of results.suites ?? []) failures.push(...extractFailures(suite, null))
  // Append (never replace) named canary failures so a dead-key line still reaches
  // the alert when a spec also failed. With no canaries, canaryRows([]) is [].
  if (failures.length > 0) return [...failures, ...canaryRows(canaryFailures)]

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
    project: NO_DETAIL_PROJECT,
    test: 'see run logs',
    error: `The run failed but produced no parseable per-test failures (${statsLine}). Likely a crash/timeout in setup or a worker died. Open the run logs.`,
    file: '',
  }]
}
