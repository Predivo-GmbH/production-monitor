/**
 * A DEAD-MAN'S SWITCH MAY ONLY SAY "THIS JOB STOPPED RUNNING" WHILE NOTHING PROVES IT RAN.
 *
 * WHY THIS EXISTS (2026-09-03). The fleet's top-level dead-man is healthchecks check
 * `my-first-check`, whose name is "production-monitor (hourly)". It sat CRITICAL for 10.7 hours
 * on 2026-09-03 (last ping 2026-09-02T19:57:06Z) announcing "Scheduled job stopped running:
 * production-monitor (hourly)" — while the job was running every half hour. Receipts from that
 * morning, all taken at 06:36Z:
 *
 *   - GitHub delivered monitor.yml at 02:05, 02:34, 03:01, 03:51, 05:28, 05:56 and 06:34Z.
 *   - machine_state.monitoring.updated_at = 06:36:53Z, written by monitor.yml's OWN
 *     `if: always()` heartbeat step, so the workflow ran to its end.
 *   - the stuck alarm row's last_seen_at = 06:36:02Z — meaning the process that re-stamped
 *     "production-monitor stopped running" WAS production-monitor, 51 seconds before that same
 *     run proved itself alive.
 *
 * THE MECHANISM, and it is the whole point. The heartbeat ping in monitor.yml is `if: success()`.
 * That welds two different facts onto one wire: "the scheduler still fires this job" and "the job
 * was happy". A dead-man switch only ever watched the first. So ANY finding by ANY of the ~20
 * sensors — including a transient one, and on 2026-09-03 it was a late ten-minute cron tick judged
 * dead by check-workflow-cadence — withholds the liveness ping, and the top alarm goes red about
 * something that is not happening. It then STAYS red, because the recovery write IS that same
 * gated ping: the only thing that can clear the alarm is the thing the hiccup skipped.
 *
 * WHY THAT IS CRITICAL RATHER THAN COSMETIC. An alarm stuck red is worse than an alarm switched
 * off, because it teaches everybody to scroll past the one row that is supposed to stop them.
 * Widening the tolerance of whichever sensor happened to trip it (the previous attempt, commit
 * 90128ef) removes one trigger out of twenty and leaves the wire welded.
 *
 * THE RULE THIS MODULE IMPLEMENTS. "The job stopped running" is a CLAIM. It may stand only while
 * nothing contradicts it. So before that claim is filed, look for an independent, unconditional
 * record of the job having executed — a beacon — and if the beacon is fresher than the check's own
 * tolerance, the claim is false and the alarm clears itself. The job's UNHAPPINESS is a different
 * fact with its own sensors and its own rows; it is not this alarm's to report, and welding it here
 * is what made this alarm untrustworthy.
 *
 * WHY THIS CANNOT MASK A REAL OUTAGE, which is the only property that matters:
 *
 *   1. A beacon is written BY THE JOB ITSELF, from a step that runs unconditionally. If the
 *      scheduler genuinely stops firing — GitHub disabling the cron on repo inactivity, the runner
 *      never starting, the workflow file broken — the workflow never starts, so nothing writes the
 *      beacon, it goes stale, and the critical alarm stands untouched. The failure mode the switch
 *      exists for is exactly the failure mode that cannot forge a beacon.
 *   2. NO BEACON MEANS NO REPRIEVE. Only checks named in LIVENESS_BEACONS can ever be reprieved.
 *      Every other check on both accounts behaves precisely as it did before.
 *   3. UNREADABLE IS NOT ALIVE. A beacon that cannot be read, is missing, or carries an
 *      unparseable timestamp leaves the alarm red. Unknown is never healthy — the house rule.
 *   4. A FUTURE-DATED BEACON IS NOT TRUSTED. A corrupt or clock-skewed write far in the future
 *      would otherwise silence this alarm for ever, which is a permanent mute installed by
 *      accident. Past the tolerance into the future it is treated as unreadable.
 *
 * Everything here is pure: it takes a check, a beacon timestamp and a clock, and returns a verdict.
 * The I/O lives in the caller (scripts/check-healthchecks-down.mjs).
 */

/** Used only when a check reports neither `timeout` nor `grace`. Three hours, the value monitor.yml
 *  derived from real ping-to-ping history: above one missed run, below two. */
export const DEFAULT_TOLERANCE_MINUTES = 180

/**
 * Checks whose "did it run?" question has an independent, unconditional answer somewhere.
 *
 * KEYED BY THE CHECK'S ID AT HEALTHCHECKS, NOT ITS NAME. `my-first-check` is the id healthchecks
 * hands the first check on a new account; this one was renamed to "production-monitor (hourly)"
 * and the id was not. check-healthchecks-down.mjs documents that trap at length. The id is what
 * `signalFor` uses as the signal key, so the id is what this map has to match.
 *
 * A `beacon` here is a promise about a WRITE SITE, and adding an entry is a claim that the write
 * cannot happen unless the job actually ran. Do not add a beacon that something other than the job
 * itself can write.
 */
export const LIVENESS_BEACONS = {
  'my-first-check': {
    job: 'production-monitor (hourly)',
    workflow: 'monitor.yml',
    // machine_state row `monitoring`, upserted by `node scripts/factory-heartbeat.mjs monitoring`
    // at monitor.yml:719 under `if: always()`. Unconditional on the run's outcome, and reachable
    // only from inside a run of this workflow.
    beacon: { table: 'machine_state', kind: 'monitoring', column: 'updated_at' },
    describe: 'the hourly monitor wrote its machine_state row',
  },
}

export function beaconFor(key, beacons = LIVENESS_BEACONS) {
  return (key && Object.prototype.hasOwnProperty.call(beacons, key)) ? beacons[key] : null
}

/**
 * The window inside which a beacon still counts as proof, taken from the CHECK'S OWN settings so
 * it can never drift away from what healthchecks itself is measuring.
 *
 * `timeout + grace` is the simple-check shape (my-first-check: 3600 + 7200 = 180 min, which is the
 * three hours monitor.yml documents). A cron check carries `schedule` instead of `timeout`, so only
 * `grace` is known; the caller's default covers that.
 */
export function toleranceMinutes(check, fallback = DEFAULT_TOLERANCE_MINUTES) {
  const timeout = Number(check?.timeout)
  const grace = Number(check?.grace)
  const parts = [timeout, grace].filter((n) => Number.isFinite(n) && n > 0)
  if (!parts.length) return fallback
  return Math.round(parts.reduce((a, b) => a + b, 0) / 60)
}

/**
 * Is this DOWN check down because it RAN AND PINGED /fail, rather than because it went silent?
 *
 * healthchecks marks a check `down` for two very different reasons, and its own mail names them:
 *   - "received a failure signal"       the job ran, hit its /fail URL; last_ping is FRESH.
 *   - "success signal did not arrive"   the job went silent; last_ping is STALE, aged past the
 *                                        check's own allowance (that is the very moment healthchecks
 *                                        flips it down for silence).
 *
 * The checks-list API does not label the last ping's KIND, but last_ping FRESHNESS is a faithful
 * proxy: a fail ping updates last_ping to now, so a down check whose last_ping is still inside its
 * own timeout+grace ran within that window and did not stop. Only a job that has genuinely stopped
 * lets last_ping age past its own tolerance.
 *
 * Conservative in the SAME direction as the beacon rule — UNKNOWN IS NOT ALIVE. A missing or
 * unparseable last_ping, or one aged past tolerance, returns false, so the alarm keeps its full
 * "stopped running" claim. A future-dated ping is not a reading and is refused too. Only a
 * demonstrably fresh ping softens the claim, so this can only ever DOWNGRADE a false page, never
 * hide a real dead job.
 */
export function ranAndReportedFailure(check, now = Date.now()) {
  const t = Date.parse(check?.last_ping || '')
  if (!Number.isFinite(t)) return false
  const ageMinutes = (now - t) / 60_000
  if (ageMinutes < 0) return false
  return ageMinutes <= toleranceMinutes(check)
}

/**
 * Is there proof this job ran recently enough?
 *
 * @param check       the healthchecks check, as returned by the API
 * @param beaconAt    ISO timestamp read from the beacon's write site, or null/undefined if the
 *                    read failed, the row is missing, or this check has no beacon at all
 * @returns {{alive: boolean, verdict: string, why: string, ageMinutes: number|null, toleranceMinutes: number|null}}
 *
 * `alive: true` is the ONLY value that reprieves an alarm, and exactly one verdict produces it.
 */
export function livenessVerdict({ check, beaconAt, now = Date.now(), beacons = LIVENESS_BEACONS }) {
  const key = check?.slug || check?.name
  const spec = beaconFor(key, beacons)
  if (!spec) {
    return { alive: false, verdict: 'no-beacon', why: 'nothing independently records whether this job ran, so its own silence is the only evidence there is', ageMinutes: null, toleranceMinutes: null }
  }

  const tol = toleranceMinutes(check)
  const t = Date.parse(beaconAt || '')
  if (!Number.isFinite(t)) {
    return { alive: false, verdict: 'unreadable', why: `${spec.beacon.table}.${spec.beacon.kind} could not be read, so nothing contradicts the alarm — unknown is not healthy`, ageMinutes: null, toleranceMinutes: tol }
  }

  const ageMinutes = Math.round((now - t) / 60_000)

  // Ahead of the clock by more than the whole tolerance window: not a fact, a corrupt or skewed
  // write. Trusting it would install a permanent mute on the fleet's top alarm.
  if (ageMinutes < -tol) {
    return { alive: false, verdict: 'unreadable', why: `${spec.beacon.table}.${spec.beacon.kind} is dated ${Math.abs(ageMinutes)} min in the FUTURE, which is not a reading, so the alarm stands`, ageMinutes, toleranceMinutes: tol }
  }

  if (ageMinutes > tol) {
    return { alive: false, verdict: 'stale', why: `${spec.describe} ${ageMinutes} min ago, past this check's own ${tol} min tolerance — the job really has stopped`, ageMinutes, toleranceMinutes: tol }
  }

  return {
    alive: true,
    verdict: 'ping-suppressed',
    why: `${spec.describe} ${ageMinutes} min ago, inside this check's own ${tol} min tolerance, so the job IS running and only its heartbeat ping was withheld`,
    ageMinutes,
    toleranceMinutes: tol,
  }
}

/**
 * Split the checks healthchecks calls DOWN into the ones that really stopped and the ones whose
 * liveness ping was merely withheld.
 *
 * @param down             the down checks, from classifyChecks
 * @param beaconReadings   { [checkKey]: isoString|null } — whatever the caller managed to read
 * @returns {{dead: object[], reprieved: {check: object, key: string, verdict: object}[]}}
 *
 * `dead` keeps the input order, so the rollup threshold and its "one fault, not eleven" logic go on
 * counting exactly the checks that are genuinely dark.
 */
export function partitionDownChecks({ down, beaconReadings = {}, now = Date.now(), beacons = LIVENESS_BEACONS }) {
  const dead = []
  const reprieved = []
  for (const check of down || []) {
    const key = check?.slug || check?.name
    const verdict = livenessVerdict({ check, beaconAt: beaconReadings[key], now, beacons })
    if (verdict.alive) reprieved.push({ check, key, verdict })
    else dead.push(check)
  }
  return { dead, reprieved }
}

/**
 * The row that replaces a false "this job stopped running".
 *
 * RESOLVED, NOT DELETED, AND NOT RETITLED-AND-LEFT-RED. The claim the alarm was making is untrue,
 * so the alarm clears; but the row stays on the board carrying WHY it cleared, because a top alarm
 * that vanishes without explanation is its own kind of untrustworthy. `severity: info` and the
 * resolved state are what signal-intake reads as "cancel any page still inside its self-heal
 * window" — nobody is rung about a job that is running.
 *
 * Nothing is masked by this. Whatever made the run red is reported by the sensor that found it, on
 * its own row, under its own key; that is how every other sensor in monitor.yml already works.
 */
export function reprievedResolution({ check, key, verdict, link = 'https://cockpit.predivo.ch/signals' }) {
  return {
    source: 'healthchecks',
    key,
    kind: 'incident',
    severity: 'info',
    state: 'resolved',
    title: `Scheduled job is running again: ${check?.name || key}`,
    summary: `It never stopped. ${verdict.why}. The ping is only sent on a green run, so a single finding withholds it; that is why this alarm was red while the job was working.`,
    detail: {
      name: check?.name ?? null,
      slug: check?.slug ?? null,
      status: check?.status ?? null,
      last_ping: check?.last_ping ?? null,
      resolved_by: 'check-healthchecks-down/alarm-state',
      liveness_verdict: verdict.verdict,
      liveness_age_minutes: verdict.ageMinutes,
      liveness_tolerance_minutes: verdict.toleranceMinutes,
    },
    link,
  }
}
