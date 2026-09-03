/**
 * A HEARTBEAT PING ANSWERS "DID THIS JOB RUN?", NOT "WAS THIS JOB GREEN?".
 *
 * -- WHY THIS EXISTS (2026-09-03) -------------------------------------------------------------
 *
 * The CI runner watchdog's dead-man switch fired while the watchdog was working perfectly.
 *
 * The mechanism, end to end:
 *   1. check-ci-runners.mjs ends `process.exit(1)` whenever it has ANY finding, because in this
 *      house "the red run IS the alert" (check-ci-runners.mjs, last line).
 *   2. A finding is routine. A repository served by only one of our two machines is a coverage
 *      WARNING; a cancelled required gate on another repo is a report about somebody else. The
 *      fleet is fine, the watchdog did its whole job, and it still exits 1.
 *   3. The workflow's Heartbeat step read `job.status`. Step 1 failed, so the job is `failure`,
 *      so the step pinged `<url>/fail`.
 *   4. healthchecks.io marks the check DOWN, and check-healthchecks-down.mjs files it with the
 *      title "Scheduled job stopped running: ci-runner-watchdog".
 *
 * So the more useful the watchdog was, the deader it looked. Verified live on 2026-09-03: the
 * check was `status=down` with `last_ping` six minutes old and 780 pings on the clock — it had
 * never stopped running for a moment, and every finding it reported turned the alarm about it
 * red. That is the worst kind of false alarm, because it is loudest exactly when the watchdog is
 * earning its keep, and it trains you to ignore the one signal that means "nobody is watching".
 *
 * The finding still travels: `if: failure()` still mails it (send-ci-runner-alert.mjs) and the
 * run is still red in the UI. Only the DEAD-MAN stops lying, and the dead-man is the one alarm
 * whose whole purpose is to notice SILENCE.
 *
 * -- WHAT STILL PINGS /fail -------------------------------------------------------------------
 *
 * "It ran" is not "it exited 0", but it is also not "the process started". A run that could not
 * certify the fleet is exactly the condition a dead-man is for, so those still ping /fail:
 *
 *   * no report file at all  - it died before it could inspect anything (checkout, `npm ci`, a
 *                              crash, a job timeout, a cancel)
 *   * an unreadable report   - same class, one step later
 *   * watchdog_broken: true  - bail(): blind token, no runners, failed API calls, rate limit
 *   * repos_with_runners nul - it wrote a report but certified nothing
 *   * a stale report         - the file on disk is from an EARLIER run, so it says nothing about
 *                              this one. In CI the checkout is fresh and this cannot happen; on
 *                              a developer machine it happens every time. UNKNOWN IS NEVER UP.
 *
 * Deliberately NOT a reason to ping /fail: findings, flips, or a red job status on its own.
 */

export const UP = 'up'
export const FAIL = 'fail'

/**
 * How old a report may be and still describe THIS run. The watchdog runs every ten minutes and
 * finishes in under a minute; healthchecks gives the check a 90-minute grace. An hour is far
 * outside any honest run and far inside the grace, so a stale file is caught without a clock
 * skew of a few minutes ever manufacturing a false /fail.
 */
export const MAX_REPORT_AGE_MS = 60 * 60 * 1000

/**
 * The whole decision, pure and testable.
 *
 * @param {object}  input
 * @param {?string} input.reportRaw  contents of the findings JSON, or null if the file is absent
 * @param {string}  [input.jobStatus] the workflow's `job.status`; recorded, never decisive on its own
 * @param {number}  [input.now]      ms epoch, injectable for tests
 * @returns {{ ping: 'up'|'fail', reason: string }}
 */
export function decideHeartbeat({ reportRaw, jobStatus = 'unknown', now = Date.now() } = {}) {
  if (reportRaw === null || reportRaw === undefined || String(reportRaw).trim() === '') {
    return {
      ping: FAIL,
      reason: `no findings report was written, so this run never inspected the fleet (job.status=${jobStatus})`,
    }
  }

  let report
  try {
    report = JSON.parse(reportRaw)
  } catch {
    return { ping: FAIL, reason: 'the findings report could not be parsed, so this run cannot be shown to have completed' }
  }

  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    return { ping: FAIL, reason: 'the findings report is not an object, so this run cannot be shown to have completed' }
  }

  if (report.watchdog_broken === true) {
    return { ping: FAIL, reason: `the watchdog reported it could not certify the fleet: ${report.broken_reason || 'no reason recorded'}` }
  }

  const stamp = Date.parse(report.generated_at || '')
  if (!Number.isFinite(stamp)) {
    return { ping: FAIL, reason: 'the findings report carries no usable generated_at, so it cannot be tied to this run' }
  }
  const age = now - stamp
  if (age > MAX_REPORT_AGE_MS) {
    return {
      ping: FAIL,
      reason: `the findings report is ${Math.round(age / 60000)} minutes old - it is a previous run's file and says nothing about this one`,
    }
  }

  if (report.repos_with_runners === null || report.repos_with_runners === undefined) {
    return { ping: FAIL, reason: 'the report certified no repositories, which is this watchdog\'s "absence is not success" condition' }
  }

  const findings = Array.isArray(report.findings) ? report.findings.length : 0
  const flips = Array.isArray(report.flips) ? report.flips.length : 0
  return {
    ping: UP,
    reason: `the watchdog completed and certified ${report.repos_with_runners} repo(s) with runners `
      + `(${findings} finding(s), ${flips} flip(s), job.status=${jobStatus}). `
      + 'Findings travel by email and by the red run; they are not silence.',
  }
}
