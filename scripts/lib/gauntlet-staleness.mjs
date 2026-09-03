/**
 * IS A GREEN SCHEDULED RUN STILL SAYING ANYTHING?
 *
 * WHY (2026-09-03 hourly check). `tests/ci-health/nightly-gauntlet.spec.ts` asks whether the
 * newest SCHEDULED run of each tiered product's deploy.yml failed, and returned "healthy" the
 * instant that run was green — with no regard for when it ran. So a nightly gauntlet that STOPS
 * FIRING after a green night reports healthy forever: the last scheduled run stays green, the
 * check keeps passing, and the entire nightly staging-regression net for five products is gone
 * without one red anywhere.
 *
 * That file's own header already claimed this was covered — "once >26h elapse with no fresh
 * scheduled run the suppression lifts and we page again (a stuck cron is itself worth a page)".
 * It was true only on the FAILURE path: the age arithmetic lived inside the `isFail` branch, and
 * a green run returned before ever reaching it. A stated guarantee the code did not provide.
 *
 * NOT HYPOTHETICAL. Measured on the live fleet the same morning: SignalForgeAi, belegpilot and
 * api-dashboard each last ran a scheduled workflow on 2026-07-02 — 62 days of total silence —
 * and every one of them was still being counted GREEN on the fleet board, because their final
 * run had succeeded. Those three turned out to be ARCHIVED, so their schedules stopped by
 * design and no alarm was owed. That is exactly why `archived` is a verdict here and not an
 * oversight: the benign case proved the sensor was blind, not that the fleet was broken.
 *
 * `scripts/check-workflow-cadence.mjs` asks this same question and is the right answer for it —
 * but it is hardcoded to THIS repo's own `.github/workflows`. Nothing was asking it of the five
 * product repos whose nightly gauntlet is the regression net.
 *
 * WHAT IT REFUSES TO GUESS. An unreadable workflow file and an unparseable cron are UNPROVEN,
 * reported by name and never smoothed into "fresh" — but they do not page either, because a
 * GitHub API blip must not red the hourly monitor. A workflow file that reads fine and contains
 * NO schedule at all is not unproven, it is a finding: the nightly was removed.
 */

/** GitHub drops scheduled ticks under load, so one missed night is never an alarm. Same
 *  3x-the-interval rule `check-workflow-cadence.mjs` uses for this repo's own schedules. */
export const OVERDUE_FACTOR = 3

/**
 * The stand-in for a period we have NOT looked up yet, so the common path costs zero extra
 * GitHub calls: the workflow file is only fetched once a run is old enough that the answer
 * could depend on its cron.
 *
 * PRECONDITION, and the reason this is a floor and not a rule: it is only sound for workflows
 * whose real interval satisfies OVERDUE_FACTOR x period >= this value, i.e. roughly 9h or
 * slower. Everything this check judges is a nightly gauntlet (a daily cron in deploy.yml, 3 x
 * 24 = 72h), so the floor is far inside the safe range. That precondition is enforced against
 * the LIVE deploy.yml crons, not a literal: tests/ci-health/nightly-gauntlet.spec.ts asserts
 * OVERDUE_FACTOR x the real fetched period >= this floor whenever it looks a period up, and
 * fails loudly the day a gauntlet is made sub-daily enough to break it. (The unit test in
 * test/nightly-gauntlet-staleness.test.mjs only checks that representative daily crons parse to
 * 24h — it cannot prove the floor against the real repos because it makes no GitHub calls.) If a
 * gauntlet is ever made sub-daily, this floor must come down with it or it will mask a stopped
 * schedule for up to 26h. A period we HAVE looked up is never overridden by this floor (see
 * below) — that bug was written here first and caught by the boundary test.
 */
export const FRESH_FLOOR_HOURS = 26

/**
 * @param {object} o
 * @param {number} o.ageHours     age of the newest scheduled run, hours
 * @param {boolean|null} o.archived  repo archived? null = could not be determined
 * @param {boolean} o.yamlRead    was the workflow file readable?
 * @param {number} o.cronCount    how many `cron:` entries the file declares
 * @param {number|null} o.periodHours  parsed cron period, null if unparseable
 * @returns {{verdict:'FRESH'|'RETIRED'|'UNPROVEN'|'NO_SCHEDULE'|'OVERDUE', reason:string}}
 */
export function scheduleFreshness({ ageHours, archived, yamlRead, cronCount, periodHours }) {
  if (!Number.isFinite(ageHours)) {
    return { verdict: 'UNPROVEN', reason: 'the age of the last scheduled run could not be computed' }
  }
  const retired = { verdict: 'RETIRED', reason: 'the repository is archived, so its schedules stopped by design' }

  // A KNOWN period is always judged on its own terms. The floor below is a stand-in for an
  // unknown one and must never override a real one: judging a 6-hourly workflow by a 26h floor
  // would call it healthy 18h after it had already stopped.
  if (Number.isFinite(periodHours) && periodHours > 0) {
    const overdueAfter = OVERDUE_FACTOR * periodHours
    if (ageHours <= overdueAfter) {
      return { verdict: 'FRESH', reason: `last scheduled run ${ageHours.toFixed(1)}h ago, scheduled every ${periodHours}h` }
    }
    if (archived === true) return retired
    return {
      verdict: 'OVERDUE',
      reason: `the last scheduled run was ${ageHours.toFixed(1)}h ago and this workflow is scheduled every ${periodHours}h — past ${OVERDUE_FACTOR}x its own interval (${overdueAfter}h), so it has stopped firing`,
    }
  }

  // Period unknown from here down.
  if (ageHours < FRESH_FLOOR_HOURS) {
    return { verdict: 'FRESH', reason: `last scheduled run ${ageHours.toFixed(1)}h ago` }
  }
  if (archived === true) return retired
  if (!yamlRead) {
    return { verdict: 'UNPROVEN', reason: 'the workflow file could not be read, so its cron is unknown' }
  }
  if (cronCount === 0) {
    return {
      verdict: 'NO_SCHEDULE',
      reason: `the workflow file declares no cron at all, so the nightly was removed — the last scheduled run was ${ageHours.toFixed(1)}h ago and there will be no next one`,
    }
  }
  return { verdict: 'UNPROVEN', reason: `the workflow declares ${cronCount} cron(s) but none could be parsed into an interval` }
}

/**
 * DID WE SEE THAT ABSENCE TWICE?
 *
 * WHY (2026-09-03 hourly check, hours after the gate above was added). Monitor run 33723882661
 * paged: "Arivioo/ChannelMover NIGHTLY GAUNTLET HAS STOPPED RUNNING — the last scheduled run was
 * 457.6h ago and this workflow is scheduled every 24h". It had not stopped. Its nightly ran 2h
 * before that alarm (run 33719060817, 2026-09-03T05:29:28Z) and every night before it without a
 * gap. The GitHub list endpoint
 * `/repos/{repo}/actions/workflows/deploy.yml/runs?event=schedule&per_page=10` answered 200 at
 * 06:37:49.645Z with a page whose FIRST entry was run 31865853339 from 2026-08-15 — nineteen days
 * stale. Not a truncated page and not an ordering fault: the ten newer scheduled runs were simply
 * absent from it, so `pickJudgeableRun` reported nothing stepped over (the alert carries no
 * describeSkipped note, which is how we know) and the freshness arithmetic above was done on a
 * run that had been superseded ten times over.
 *
 * 2.2 seconds later the Playwright retry made the identical call and got the true page — it
 * skipped with "latest scheduled gauntlet is 'success' — healthy", which is what laundered the
 * failure and is why check-laundered-failures.mjs is what actually reported this. The four
 * sibling repos in the same run, judged in the same seconds through the same token, all read
 * correctly. Re-measured the same morning: 145 further reads of that exact URL (25 serial, 120
 * concurrent) returned the correct newest run every single time. So the bad page is rare, is not
 * reproducible on demand, and is not something this repo can fix at its source.
 *
 * WHAT WAS ACTUALLY WRONG ON OUR SIDE. Every other paging path in nightly-gauntlet.spec.ts
 * already refuses to alarm on a single observation: a failure must outlive the auto-retry window
 * (persistence gate), an inconclusive run needs MIN_INCONCLUSIVE_TO_PAGE=2 conclusive-free runs
 * behind it, a red run superseded by a newer commit waits for the next nightly, and ANY API error
 * is UNPROVEN and silent. The staleness gate was the one verdict that paged on a single read —
 * and it is the verdict least able to afford one, because it asserts something is NOT THERE. A
 * failing run is evidence in hand and survives a bad page; an absent run is only ever an
 * inference from a list you were handed once, so a bad list IS the finding.
 *
 * So a stopped schedule must be seen twice before it is announced: a second, fresh call to the
 * same endpoint, and the two reads must name the SAME newest run AND reach the SAME verdict.
 *
 * WHAT THIS DOES NOT CLAIM. Two reads can both be stale; this does not make that impossible, and
 * a second read of the same endpoint is corroboration, not independence. It buys the thing that
 * matters here: the hourly monitor asks again in an hour, and a gauntlet that has genuinely
 * stopped answers identically on every read forever — so a real alarm is delayed by at most one
 * hour, while a one-off bad page is silenced outright. A benign race (a new scheduled run
 * starting between the two reads) also lands as "not confirmed", which is the correct answer:
 * a schedule that just fired is not a stopped schedule.
 */

/** The verdicts that PAGE — the ones asserting the schedule has stopped. RETIRED and UNPROVEN are
 *  named and stay quiet, and FRESH is health, so none of the three needs corroborating. Kept as a
 *  named set so a verdict added later must be classified deliberately (test/ asserts the set is
 *  exhaustive against everything scheduleFreshness can return). */
export const STOPPED_VERDICTS = ['OVERDUE', 'NO_SCHEDULE']

/**
 * @param {{verdict:string, newestRunId:number|string|null}} first  the read that wants to page
 * @param {{ok:boolean, verdict?:string, newestRunId?:number|string|null}} second the confirming read
 * @returns {{confirmed:boolean, reason:string}} confirmed=true means it is safe to announce that
 *   this schedule has stopped; false means say so out loud and stay quiet until the next hour.
 */
export function corroborateStopped(first, second) {
  if (!second?.ok) {
    return {
      confirmed: false,
      reason: 'the confirming read of the scheduled-run list did not come back, so the gap was seen once and never checked',
    }
  }
  if (String(second.newestRunId) !== String(first?.newestRunId)) {
    return {
      confirmed: false,
      reason: `the two reads named DIFFERENT newest scheduled runs (${first?.newestRunId} then ${second.newestRunId}) — one of them is wrong and there is no way from here to tell which, so nothing about this schedule has been proven`,
    }
  }
  if (second.verdict !== first?.verdict) {
    return {
      confirmed: false,
      reason: `both reads named run ${second.newestRunId} but reached different verdicts (${first?.verdict} then ${second.verdict}), so the freshness of this schedule is in dispute`,
    }
  }
  return {
    confirmed: true,
    reason: `seen twice: two separate reads of the scheduled-run list both name run ${second.newestRunId} as the newest and both say ${second.verdict}`,
  }
}
