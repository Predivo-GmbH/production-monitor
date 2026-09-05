import { test } from '@playwright/test'

/**
 * Skip on a FIRST attempt; on a RETRY, fail — because a retry that does not re-test cannot
 * clear the attempt that failed.
 *
 * Playwright counts a skip as a non-failing attempt, so failed-then-skipped is reported "flaky",
 * which does not fail the run: the first attempt's failure is erased and the runner exits 0.
 * The `A failed test must not erase itself on the retry` step (check-laundered-failures.mjs)
 * catches this after the fact and reds the run, but by then the failing test is missing from the
 * alert email — the email is built from Playwright's verdicts, and Playwright's verdict was
 * "flaky". 2026-09-05 07:38Z, run 33953125488: BackOffice's "email contains valid links" test
 * failed because the monitor could not open its own mailbox, the retry hit the OTP rate limit
 * that the first attempt's own request had caused, skipped, and the failure survived only as the
 * guard step's complaint. Four other OTP specs already inline this rule (commit caa60e2); this is
 * the same rule as a function so the remaining specs can adopt it in one line.
 *
 * It is also near-certain to happen on OTP tests: the rate limit is caused BY the first attempt's
 * own OTP request, so a retry that got that far will almost always land on the skip branch.
 */
export function skipOrStand(product: string, reason: string): never {
  if (test.info().retry > 0) {
    throw new Error(
      `${reason} — on the RETRY (attempt ${test.info().retry + 1}), so this test could not be re-run after its ` +
      'first attempt failed. That earlier failure was never disproven and stands. This is a monitor-side ' +
      `limitation, not proof that ${product} failed.`,
    )
  }
  test.skip(true, reason)
  // test.skip(true, …) throws Playwright's skip signal; this line exists only for the `never` type.
  throw new Error(`skipped: ${reason}`)
}
