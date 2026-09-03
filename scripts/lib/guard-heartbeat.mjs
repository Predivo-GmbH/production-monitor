/**
 * A HEARTBEAT PING ANSWERS "DID THIS JOB RUN AND GET ITS FINDING OUT?", NOT "WAS THE JOB GREEN?".
 *
 * -- WHY THIS EXISTS (2026-09-03) -------------------------------------------------------------
 *
 * The CI runner watchdog's dead-man switch fired while the watchdog was working perfectly, and
 * the product mailer guard's fired while it was correctly reporting a staging-environment drift.
 *
 * The mechanism, end to end:
 *   1. Every guard in this repo ends `process.exit(1)` when it has a finding, because in this
 *      house "the red run IS the alert".
 *   2. A finding is routine. A repository served by only one of our two machines is a coverage
 *      WARNING. "Distribution-OS/staging: a dormant environment has grown a mailer" is a baseline
 *      drift notice about a staging environment. The fleet is fine, the guard did its whole job,
 *      and it still exits 1.
 *   3. The workflows' Heartbeat steps read `job.status`. Step 1 failed, so the job is `failure`,
 *      so the step pinged `<url>/fail`.
 *   4. healthchecks.io marks the check DOWN, and check-healthchecks-down.mjs files it.
 *
 * So the more useful a guard was, the deader it looked. Verified live on 2026-09-03:
 * `ci-runner-watchdog` was `status=down` with `last_ping` six minutes old and 780 pings on the
 * clock, and `mailer-config-guard` pinged `/fail` at 08:53:27Z over a mailer that had appeared in
 * a dormant STAGING environment - having just successfully emailed that same finding to Roger.
 * Neither had stopped running for a moment. That is the worst kind of false alarm, because it is
 * loudest exactly when the guard is earning its keep, and it trains you to ignore the one signal
 * that means "nobody is watching".
 *
 * The finding still travels: `if: failure()` still mails it and the run is still red. Only the
 * DEAD-MAN stops lying, and the dead-man is the one alarm whose whole purpose is to notice
 * SILENCE.
 *
 * -- THE ESCAPE HATCH, WHICH IS NOT NEGOTIABLE ------------------------------------------------
 *
 * mailer-config-check.yml carries a deliberate reason for its ping that the runner watchdog does
 * not have, written into the workflow: "THE ALERT MUST NOT TRAVEL OVER THE THING BEING CHECKED.
 * The step above leaves on our own Metanet mailbox, and three of the eight products this guard
 * watches send through that same Metanet server - so if that is what broke, the mail above dies
 * with it. This step is the layer that survives."
 *
 * That rationale is about THE ALERT FAILING TO LEAVE, not about the guard finding something. On
 * 2026-09-03 both were true within the same hour: SMTP_PASS was stale, every send died on
 * `535 5.7.8 authentication failure`, and healthchecks mailing from its own infrastructure was
 * the only channel left. So the escape hatch stays, stated precisely:
 *
 *     if the alert step could not deliver the finding, ping /fail.
 *
 * That is why `alertOutcome` is an input here. Dropping the /fail on a mere finding while keeping
 * it on an undelivered alert is the whole point: the two used to share one channel, and they are
 * opposite facts.
 *
 * -- WHAT ELSE STILL PINGS /fail --------------------------------------------------------------
 *
 * "It ran" is not "it exited 0", but it is also not "the process started". A run that could not
 * certify what it watches is exactly the condition a dead-man is for:
 *
 *   * no report file at all  - it died before it inspected anything (checkout, `npm ci`, a
 *                              crash, a job timeout, a cancel)
 *   * an unreadable report   - same class, one step later
 *   * the guard's own "I am blind" marker (see `broken` in each spec below)
 *   * the guard's own "absence is not success" condition (see `certified` in each spec)
 *   * a stale report         - the file on disk is from an EARLIER run, so it says nothing about
 *                              this one. In CI the checkout is fresh and this cannot happen; on
 *                              a developer machine it happens every time. UNKNOWN IS NEVER UP.
 *
 * Deliberately NOT a reason to ping /fail: findings, flips, or a red job status on its own.
 *
 * -- NOT THE SAME THING AS lib/hc-ping.mjs ----------------------------------------------------
 *
 * That module answers "what is this check's ping URL" for scripts running on our own machines,
 * where the URL comes from ~/.claude/scripts/hc-config.json. This one answers "what should the
 * ping SAY" for jobs running in GitHub Actions, where the URL arrives as a repository secret.
 * Different questions; neither replaces the other.
 */

export const UP = 'up'
export const FAIL = 'fail'

/**
 * How old a report may be and still describe THIS run. The busiest of these guards runs every ten
 * minutes and finishes in under a minute; healthchecks gives it a 90-minute grace. An hour is far
 * outside any honest run and far inside the grace, so a stale file is caught without a clock skew
 * of a few minutes ever manufacturing a false /fail.
 */
export const MAX_REPORT_AGE_MS = 60 * 60 * 1000

const count = (v) => (Array.isArray(v) ? v.length : 0)

/**
 * ONE SPEC PER GUARD, NOT ONE DECISION FUNCTION PER GUARD.
 *
 * A second decision path eventually disagrees with the first, and then somebody mutes whichever
 * one is shouting. Everything guard-specific is data here; the reasoning below is shared.
 *
 *   file        the report the guard leaves behind
 *   stamp       the field carrying when it ran, or a function reading it (Playwright nests it)
 *   broken      -> a reason string if the guard declared itself blind, else null
 *   certified   -> true if the run actually observed the population it exists to observe
 *   uncertified the sentence to print when `certified` is false
 *   describe    the one-line UP reason
 */
export const GUARDS = {
  // Report: { generated_at, repos_with_runners, machines, flips, findings } (check-ci-runners.mjs).
  // bail() overwrites it with watchdog_broken/broken_reason and repos_with_runners: null.
  'ci-runner-watchdog': {
    file: 'ci-runner-findings.json',
    stamp: 'generated_at',
    broken: (r) => (r.watchdog_broken === true ? (r.broken_reason || 'no reason recorded') : null),
    certified: (r) => r.repos_with_runners !== null && r.repos_with_runners !== undefined,
    uncertified: 'the report certified no repositories, which is this watchdog\'s "absence is not success" condition',
    describe: (r) => `certified ${r.repos_with_runners} repo(s) with runners `
      + `(${count(r.findings)} finding(s), ${count(r.flips)} flip(s))`,
  },

  // Report: { checked_at, failures, warnings, rows } (check-mailer-config.mjs:502).
  // `rows` is one entry per product-environment actually examined. The guard itself exits 1 on an
  // empty `rows` because "no failures here means no observations, not a healthy fleet" - and the
  // report is written BEFORE that bail, so the file exists with rows: [] and this must read it the
  // same way the guard does.
  'mailer-config-guard': {
    file: 'mailer-findings.json',
    stamp: 'checked_at',
    broken: () => null,
    certified: (r) => Array.isArray(r.rows) && r.rows.length > 0,
    uncertified: 'not one mailer environment was examined, so "no failures" here means "no observations" - '
      + 'every product could be misconfigured and the report would look exactly like this',
    describe: (r) => `examined ${count(r.rows)} mailer environment(s) `
      + `(${count(r.failures)} failure(s), ${count(r.warnings)} warning(s))`,
  },

  // Report: { checked_at, window_days, runs_examined, billed_minutes, harness_failures, findings }
  // (check-ci-budget.mjs). That guard already separates the two kinds of red by prefix, and they
  // mean opposite things: `HARNESS:` is "this run certifies nothing" (no private runs read, API
  // calls failed, the sweep stopped early on its own call cap, the API hour ran out), while
  // `CEILING:`, `UNDECLARED:` and `BUDGET:` are the findings it exists to produce.
  'ci-cost-guard': {
    file: 'ci-budget-findings.json',
    stamp: 'checked_at',
    broken: (r) => (count(r.harness_failures) ? r.harness_failures.join(' | ') : null),
    certified: (r) => Number.isFinite(r.runs_examined) && r.runs_examined > 0,
    uncertified: 'the sweep examined no runs at all, so it read nothing that can cost money',
    describe: (r) => `swept ${r.runs_examined} run(s) over ${r.window_days} day(s) `
      + `(${r.billed_minutes} billed minute(s), ${count(r.findings)} finding(s))`,
  },

  // Report: Playwright's own JSON reporter, { config, suites, errors, stats } with
  // stats: { startTime, duration, expected, unexpected, flaky, skipped } (playwright.config.ts:40).
  // No new artefact was invented for this: the hourly monitor has always written one.
  //
  // WHY monitor.yml IS HERE AT ALL. Its heartbeat was `if: success()`, so the ping was not
  // mis-aimed - it was SKIPPED. Read against the 180-minute tolerance the workflow documents, that
  // made a three-hour PRODUCT outage indistinguishable from a three-hour MONITOR outage, and it is
  // the first that happens. Measured on the real run history, 2026-09-03: five consecutive
  // scheduled failures on 09-02 (06:55Z-10:42Z) and four more on 09-03, and in the three most
  // recent of them the failing steps were "Run production monitor" AND "Send alert on failure" -
  // the monitor found something, could not mail it, and skipped its heartbeat too. Every channel
  // silent at once. That is the case the escape hatch above exists for, and it was unreachable
  // here because the step never ran.
  //
  // The old comment argued a monitor red for three hours is its own incident. It is - but a
  // PRODUCT down for three hours already has its own alert, its own board rows and its own red
  // runs, and borrowing the dead-man to say it a fourth time costs the one alarm that means
  // "nobody is watching". A monitor that stops running still trips the same tolerance, because a
  // job that never starts writes no report and pings nothing at all.
  'monitor-hourly': {
    file: 'test-results/results.json',
    stamp: (r) => r.stats?.startTime,
    // Top-level `errors` is where Playwright puts a global setup/config failure - the sweep never
    // got as far as a test, which is precisely "could not run", not "found something".
    broken: (r) => (count(r.errors) ? r.errors.map((e) => e.message || String(e)).join(' | ').slice(0, 300) : null),
    // ABSENCE IS NOT SUCCESS. A run where every test SKIPPED observed nothing, and this is not
    // hypothetical: the results.json on disk from 2026-09-02T12:45Z reads
    // expected 0 / unexpected 0 / flaky 0 / skipped 13. A green step over a fleet nothing looked
    // at is the exact shape this repo exists to catch, and the DASHBOARD_PAT floor test in
    // tests/ci-health/nightly-gauntlet.spec.ts was added for the same reason.
    certified: (r) => ((r.stats?.expected || 0) + (r.stats?.unexpected || 0) + (r.stats?.flaky || 0)) > 0,
    uncertified: 'every check in the sweep SKIPPED, so nothing about any product was actually observed - '
      + '"no failures" here means "no observations", which is not an all-clear',
    describe: (r) => `ran ${(r.stats?.expected || 0) + (r.stats?.unexpected || 0) + (r.stats?.flaky || 0)} check(s) `
      + `(${r.stats?.unexpected || 0} failing, ${r.stats?.flaky || 0} flaky, ${r.stats?.skipped || 0} skipped)`,
  },
}

/**
 * The whole decision, pure and testable, for every guard.
 *
 * @param {object}   input
 * @param {?string}  input.reportRaw      contents of the guard's report, or null if absent
 * @param {string}   [input.guard]        a key of GUARDS; defaults to the runner watchdog
 * @param {string}   [input.jobStatus]    the workflow's `job.status`; recorded, never decisive alone
 * @param {?string}  [input.alertOutcome] the alert step's `outcome`; 'failure' means the finding
 *                                        could not be delivered, which IS a dead-man condition
 * @param {number}   [input.now]          ms epoch, injectable for tests
 * @returns {{ ping: 'up'|'fail', reason: string }}
 */
export function decideHeartbeat({
  reportRaw,
  guard = 'ci-runner-watchdog',
  jobStatus = 'unknown',
  alertOutcome = null,
  now = Date.now(),
} = {}) {
  const spec = GUARDS[guard]
  if (!spec) {
    return { ping: FAIL, reason: `no heartbeat spec for guard "${guard}", so this run cannot be judged at all` }
  }

  // THE ESCAPE HATCH, FIRST. If the finding could not be delivered, the dead-man is the only
  // channel left and it must not report health. This is the case mailer-config-check.yml's
  // heartbeat was written for, and the one it was accidentally firing on everything else.
  if (alertOutcome === 'failure') {
    return {
      ping: FAIL,
      reason: 'the alert step could not deliver the finding, so healthchecks.io is the only channel '
        + 'left and must not report this run as healthy',
    }
  }

  if (reportRaw === null || reportRaw === undefined || String(reportRaw).trim() === '') {
    return {
      ping: FAIL,
      reason: `no ${spec.file} was written, so this run never inspected anything (job.status=${jobStatus})`,
    }
  }

  let report
  try {
    report = JSON.parse(reportRaw)
  } catch {
    return { ping: FAIL, reason: `${spec.file} could not be parsed, so this run cannot be shown to have completed` }
  }

  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    return { ping: FAIL, reason: `${spec.file} is not an object, so this run cannot be shown to have completed` }
  }

  const brokenReason = spec.broken(report)
  if (brokenReason) {
    return { ping: FAIL, reason: `the guard reported it could not certify what it watches: ${brokenReason}` }
  }

  const stamp = Date.parse((typeof spec.stamp === 'function' ? spec.stamp(report) : report[spec.stamp]) || '')
  if (!Number.isFinite(stamp)) {
    const named = typeof spec.stamp === 'function' ? 'timestamp' : spec.stamp
    return { ping: FAIL, reason: `${spec.file} carries no usable ${named}, so it cannot be tied to this run` }
  }
  const age = now - stamp
  if (age > MAX_REPORT_AGE_MS) {
    return {
      ping: FAIL,
      reason: `${spec.file} is ${Math.round(age / 60000)} minutes old - it is a previous run's file and says nothing about this one`,
    }
  }

  if (!spec.certified(report)) {
    return { ping: FAIL, reason: spec.uncertified }
  }

  return {
    ping: UP,
    reason: `the guard completed and ${spec.describe(report)}, job.status=${jobStatus}. `
      + 'Findings travel by email and by the red run; they are not silence.',
  }
}
