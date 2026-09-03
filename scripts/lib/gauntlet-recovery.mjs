/**
 * HAS THE GATE WE ARE ABOUT TO PAGE ABOUT ALREADY PASSED SINCE?
 *
 * WHY (2026-09-03 hourly check, monitor run 33731470295). The hourly monitor went red on one
 * test and paged:
 *
 *   "Arivioo/BoatBuddy NIGHTLY GAUNTLET PERSISTENTLY FAILING — the job(s) that failed:
 *    gate-security (step "Dependency audit (blocking at high)"). The auto-retry did not
 *    recover it (attempt 1, 27.4h, .../runs/33591920887).
 *    NOTE: 1 newer scheduled run(s) gave no verdict and were stepped over: cancelled."
 *
 * Measured on the live fleet the same hour: in that stepped-over run — scheduled run
 * 33718969126, 2026-09-03T05:28Z, two and a half hours before the page — `gate-security`
 * concluded SUCCESS, and its step "Dependency audit (blocking at high)" concluded SUCCESS.
 * The advisory had been patched at 03:34Z (BoatBuddy dbb02d8, fast-uri + qs in the lockfile),
 * and that run ran on exactly that commit. The run's OVERALL conclusion was `cancelled` only
 * because a different job, `gate-integration`, hit a job timeout at 10m09s.
 *
 * So the alert asserted a gate was persistently failing while the newest thing the monitor
 * knew about that gate was a pass — and it printed the very run holding that pass in its own
 * NOTE clause. The evidence was in the check's hand and it never looked inside.
 *
 * THE SHAPE OF THE DEFECT. `pickJudgeableRun` (scripts/lib/gauntlet-verdict.mjs) correctly
 * refuses to let a cancelled run stand in for a verdict ABOUT THE RUN, and walks back to the
 * newest run that concluded. That is right: a cancelled run did not finish, so it cannot say
 * "this product is fine". But the check then treated the stepped-over runs as if they did not
 * exist at all, and "persistently failing" was decided from the old run's age and attempt count
 * alone. A run can fail to produce a verdict about the PRODUCT and still produce a perfectly
 * conclusive verdict about a JOB inside it. Absence of a verdict at the run level is not
 * absence of evidence at the job level.
 *
 * WHAT PERSISTENCE ACTUALLY CLAIMS. "Persistently failing" is not a statement about how old a
 * failure is. It is a statement that nothing since has shown it recovered. The age and the
 * retry count are a proxy for that — a good one when there is nothing newer to look at, and
 * simply wrong when there is. This module supplies the missing question.
 *
 * WHAT THIS REFUSES TO DO. It does not clear a failure because a run is newer, because a
 * commit is newer, or because a gate "probably" got fixed — this repo has been burned by
 * exactly that inference (the SUPERSEDED window in nightly-gauntlet.spec.ts suppresses on a
 * newer tip and is deliberately time-boxed for it). It clears only on a POSITIVE, job-level
 * `success` for the named job in a newer SCHEDULED run of the same workflow. Every other
 * outcome — the job re-failed, the job was cancelled, the job is absent from the newer run, the
 * job list could not be read, the failing job was never named — leaves the page standing. The
 * fail-safe direction is always "page".
 *
 * ONE JOB AT A TIME, NEWEST WINS. For each named job we take the NEWEST conclusive observation
 * of THAT job and nothing else. A job that passed at 04:00 and failed again at 05:00 has
 * re-failed; reading the pass would be picking the answer we like out of two.
 * A page is cleared only when EVERY named job has recovered — one unrecovered gate is still a
 * red gauntlet, and clearing on "some of them passed" would be the same over-claim in reverse.
 */

/** A job conclusion that is a verdict about that job. Everything else (`cancelled`, `skipped`,
 *  `neutral`, null while queued) is the job not having answered. Named as the conclusive set,
 *  not the inconclusive one, so anything GitHub adds later is inconclusive by default — which
 *  is the safe direction here, because inconclusive never clears a page. */
export const CONCLUSIVE_JOB_CONCLUSIONS = ['success', 'failure', 'timed_out']

/** Job names that failed in a run, in the run's own order. Mirrors how the spec names the
 *  failing gate in the alert, so the names looked up here are the names Roger was shown. */
export function failedJobNames(jobs) {
  if (!Array.isArray(jobs)) return []
  return jobs
    .filter((j) => ['failure', 'timed_out'].includes(j?.conclusion))
    .map((j) => j?.name)
    .filter((n) => typeof n === 'string' && n.length > 0)
}

/**
 * @param {string[]} names   job names that failed in the run we are about to page about.
 * @param {Array<{run:object, jobs:Array<object>}>} newer  the stepped-over scheduled runs that
 *        are NEWER than the judged one, NEWEST FIRST, each with its job list. A run whose jobs
 *        could not be read must be passed with `jobs: null` — unread is not empty.
 * @returns {{recovered:boolean, reason:string, perJob:Array<{name:string,state:string,run:object|null}>}}
 *   recovered  true only when every named job has a newest-conclusive `success` in `newer`.
 *   reason     one clause fit to append to an alert, or to explain the suppression.
 *   perJob     the newest conclusive observation of each named job: state is
 *              'recovered' | 'refailed' | 'unproven'.
 */
export function recoveredSince(names, newer) {
  // No name means the job list could not be read upstream, and the alert already says so. We
  // cannot look up a job we cannot name, and "we did not look" must never clear a page.
  if (!Array.isArray(names) || names.length === 0) {
    return { recovered: false, reason: 'no failing job was named, so nothing could be re-checked', perJob: [] }
  }
  const runs = Array.isArray(newer) ? newer : []
  if (runs.length === 0) {
    return { recovered: false, reason: 'no newer scheduled run to check the failing job against', perJob: [] }
  }

  const perJob = names.map((name) => {
    // NEWEST FIRST: the first conclusive sighting of this job is the current truth about it.
    for (const entry of runs) {
      if (!Array.isArray(entry?.jobs)) continue // unread job list — skip, never treat as absent
      const job = entry.jobs.find((j) => j?.name === name)
      if (!job || !CONCLUSIVE_JOB_CONCLUSIONS.includes(job.conclusion)) continue
      return {
        name,
        state: job.conclusion === 'success' ? 'recovered' : 'refailed',
        run: entry.run ?? null,
      }
    }
    return { name, state: 'unproven', run: null }
  })

  const refailed = perJob.filter((j) => j.state === 'refailed')
  const unproven = perJob.filter((j) => j.state === 'unproven')

  if (refailed.length) {
    return {
      recovered: false,
      reason: `still failing in a newer scheduled run: ${refailed.map((j) => j.name).join('; ')}`,
      perJob,
    }
  }
  if (unproven.length) {
    return {
      recovered: false,
      reason: `no newer scheduled run gives a verdict on ${unproven.map((j) => j.name).join('; ')}`,
      perJob,
    }
  }
  return {
    recovered: true,
    reason: `${perJob.map((j) => `${j.name} passed in a newer scheduled run${j.run?.html_url ? ` (${j.run.html_url})` : ''}`).join('; ')}`,
    perJob,
  }
}
