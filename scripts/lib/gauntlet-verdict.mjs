/**
 * WHICH SCHEDULED RUN ACTUALLY SAYS SOMETHING?
 *
 * WHY (2026-09-03 hourly check). `tests/ci-health/nightly-gauntlet.spec.ts` judged the NEWEST
 * scheduled run of each tiered product's deploy.yml and asked one question: did it fail? A run
 * that was CANCELLED answered "no", so it was reported healthy — in the check's own words,
 * "latest scheduled gauntlet is 'cancelled' — healthy".
 *
 * A cancelled run is not a pass. It is the ABSENCE of a verdict: the gauntlet was stopped before
 * it could say anything. Treating it as health is wrong twice over, and the second way is worse:
 *
 *   1. it does not page, though nothing tested the product against live staging that night; and
 *   2. it RESETS THE STALENESS CLOCK. The freshness gate added hours earlier the same morning
 *      (scripts/lib/gauntlet-staleness.mjs, commit 863c731) measures the age of the newest
 *      scheduled run. A cancelled run is a new run, so its recent timestamp made the gate answer
 *      FRESH — and the very hole 863c731 closed reopened through a different door. The two
 *      defects compose: a nightly that is cancelled every night is both "healthy" and "fresh"
 *      forever, while the staging regression net for that product is simply gone.
 *
 * NOT HYPOTHETICAL. Measured against the live fleet on 2026-09-03 over every scheduled deploy.yml
 * run in the five tiered repos (~240 scheduled runs): ReplyFlow has two cancelled scheduled
 * nightlies — run 33049024073 (2026-08-27) and run 31080989158 (2026-08-06). Neither was a
 * concurrency supersession cancelled at second zero: in both, `gate-e2e` ran for roughly twenty
 * minutes and was then cancelled (07:16 -> 07:37 and 07:27 -> 07:46), with `deploy` and
 * `prod-smoke` cancelled behind it. Those are gauntlets that genuinely did not finish, and for
 * the ~24h each was the newest scheduled run the monitor called ReplyFlow healthy.
 *
 * The same lesson was already learned in this repo ONE DAY EARLIER at the JOB level — commit
 * 2de569b, "monitor: surface a required CI gate CANCELLED, not just failed", after a cancelled
 * `gate-security` blocked a ChannelMover release while every PRESENCE/failure watcher missed it.
 * That fix looked inside a run at its jobs. This one is the same mistake one level up, at the
 * RUN, and it survived because the two checks are different files. A lesson written down in one
 * place is not a guard in another.
 *
 * WHAT THIS REFUSES TO DO. It does not turn a cancel into a failure — a cancel has many benign
 * causes (a human stopping a run, a superseding push) and paging on one would be exactly the
 * false alarm this repo's alerting philosophy forbids. It does something narrower and safer: it
 * declines to let an inconclusive run stand in for a verdict, and hands back the newest run that
 * DID conclude, so every downstream question — did it fail, is it still fresh, has it been
 * superseded — is asked of a run that actually ran. A cancel is therefore silent on its own and
 * only ever visible through the staleness it can no longer hide.
 */

/** The only conclusions that are a verdict about the product. Everything else — `cancelled`,
 *  `neutral`, `stale`, `action_required`, `startup_failure` — is the run not having answered.
 *  (Measured 2026-09-03: only success/failure/cancelled occur in these repos today, but naming
 *  the conclusive set rather than the inconclusive one means a conclusion GitHub adds later is
 *  inconclusive by default, which is the safe direction.) */
export const CONCLUSIVE_CONCLUSIONS = ['success', 'failure', 'timed_out']

/** One cancelled night with nothing conclusive behind it in the window is not an alarm — that is
 *  a single blip, and this repo does not page on one. Two or more means the gauntlet is never
 *  completing, which is a finding about the regression net itself. */
export const MIN_INCONCLUSIVE_TO_PAGE = 2

const isConclusive = (r) => r?.status === 'completed' && CONCLUSIVE_CONCLUSIONS.includes(r?.conclusion)

/**
 * @param {Array<object>} runs GitHub workflow runs, NEWEST FIRST (the order the API returns).
 * @returns {{verdict:'NO_RUNS'|'PENDING'|'JUDGE'|'NONE_CONCLUSIVE'|'UNPROVEN',
 *            judged:object|null, skipped:Array<object>, reason:string}}
 *   NO_RUNS          nothing has ever run on this schedule — caller stays quiet.
 *   PENDING          the newest run has not completed yet — caller stays quiet (unchanged
 *                    behaviour: a nightly mid-flight is judged an hour later, not now).
 *   JUDGE            `judged` is the newest run that actually concluded; ask every downstream
 *                    question of THAT run. `skipped` are the inconclusive runs newer than it.
 *   NONE_CONCLUSIVE  every completed run in the window ended without a verdict — a finding.
 *   UNPROVEN         one inconclusive run and nothing conclusive behind it — named, not paged.
 */
export function pickJudgeableRun(runs) {
  if (!Array.isArray(runs) || runs.length === 0) {
    return { verdict: 'NO_RUNS', judged: null, skipped: [], reason: 'no scheduled run yet' }
  }

  const newest = runs[0]
  if (newest?.status !== 'completed') {
    return {
      verdict: 'PENDING',
      judged: null,
      skipped: [],
      reason: `the newest scheduled run is still ${newest?.status ?? 'in an unknown state'}`,
    }
  }

  const idx = runs.findIndex(isConclusive)
  if (idx >= 0) {
    return {
      verdict: 'JUDGE',
      judged: runs[idx],
      // Only COMPLETED-but-inconclusive runs count as skipped; an in-progress run newer than the
      // judged one is not something that failed to answer, it simply has not answered yet.
      skipped: runs.slice(0, idx).filter((r) => r?.status === 'completed'),
      reason: idx === 0 ? 'the newest scheduled run concluded' : `skipped ${idx} newer run(s) that did not conclude`,
    }
  }

  const inconclusive = runs.filter((r) => r?.status === 'completed')
  if (inconclusive.length >= MIN_INCONCLUSIVE_TO_PAGE) {
    return {
      verdict: 'NONE_CONCLUSIVE',
      judged: null,
      skipped: inconclusive,
      reason: `the last ${inconclusive.length} completed scheduled runs all ended without a verdict (${inconclusive
        .map((r) => r.conclusion ?? 'no conclusion')
        .join(', ')}), so nothing has actually been tested`,
    }
  }
  return {
    verdict: 'UNPROVEN',
    judged: null,
    skipped: inconclusive,
    reason: `the only completed scheduled run in the window ended '${inconclusive[0]?.conclusion ?? 'with no conclusion'}' and there is nothing conclusive behind it`,
  }
}

/** One short clause naming what was stepped over, for an alert a person has to act on. Empty
 *  string when nothing was skipped, so callers can concatenate it unconditionally. */
export function describeSkipped(skipped) {
  if (!skipped?.length) return ''
  const each = skipped.map((r) => `${r.conclusion ?? 'no conclusion'} (${r.run_started_at ?? r.created_at ?? 'unknown time'})`)
  return ` NOTE: ${skipped.length} newer scheduled run(s) gave no verdict and were stepped over: ${each.join('; ')}.`
}
