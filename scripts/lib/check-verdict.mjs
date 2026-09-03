/**
 * THE THIRD STATE. A CHECK THAT COULD NOT LOOK MUST NOT BE ABLE TO SAY "FINE".
 *
 * -- WHY THIS FILE EXISTS (2026-09-03) ------------------------------------------------------
 *
 * This house's most expensive failure is a job that reports success for doing nothing. Eight
 * separate instances were found on 2026-09-02, each fixed by a different agent who did not know
 * the other seven existed. That is what makes it a CLASS and not a task: every fix was correct,
 * every fix was local, and nothing stopped the ninth.
 *
 * The class has one shape. A check has two possible answers in its head -- "I looked and it is
 * fine" and "I could not look" -- and only one channel to say them on, so the second collapses
 * into the first. Concretely, and all six of these were MEASURED by fault injection in this repo
 * on 2026-09-03, not reasoned about:
 *
 *   * an empty baseline file  ->  "every deployed edge function is at or ahead of its committed
 *                                 code (0 of 0 product(s) read)"                  exit 0
 *   * an empty product list   ->  "All declared mailers OK"                       exit 0
 *   * a register that returns
 *     zero rows               ->  "the scan has never run", filed as a WARNING
 *                                 with needs_human false, which by this fleet's own
 *                                 paging rule can never reach anybody              exit 0
 *   * no fleet token at all   ->  "gate-coverage check skipped: set FLEET_READ_TOKEN"  exit 0
 *                                 (so a revoked token silently retires the guard, forever)
 *
 * Every one of those sentences is TRUE. That is the trap: the lie is not in the words, it is in
 * the EXIT, and in the fact that a person reading a green workflow never sees the words.
 *
 * -- THE RULE -------------------------------------------------------------------------------
 *
 *     A CHECK HAS THREE ANSWERS, NOT TWO.
 *
 *       pass     I reached the thing I judge, and it is healthy.
 *       fail     I reached the thing I judge, and it is not.
 *       unknown  I did not reach it. This is NEVER 'pass'. It is an incident about the CHECK.
 *
 * 'unknown' is not a softer 'fail' and it is not a louder 'pass'. It is a statement about the
 * SENSOR, and it has to reach a human on the same wire a real finding would, because a sensor
 * that stopped sensing is the one condition under which every other reading in the system is
 * worthless.
 *
 * -- HOW A CHECK SPEAKS IT ------------------------------------------------------------------
 *
 * `sayVerdict(state, reason)` prints ONE canonical line. It is deliberately a printed marker
 * rather than only an exit code, because this fleet has a standing and CORRECT house rule that
 * a filed alarm exits 0 (scripts/lib/fleet-signal.mjs: "a filed alarm exits 0, only a failed
 * READ exits non-zero" -- an alarm that also reds the run double-reports one event). So the exit
 * code alone cannot carry the answer: 0 legitimately means both "healthy" and "unhealthy, and I
 * have already told somebody properly". The marker separates those two, which is exactly the
 * distinction the guard needs and the distinction the class destroys.
 *
 * -- THE CONTRACT THE GUARD ENFORCES --------------------------------------------------------
 *
 * test/a-check-cannot-pass-without-reaching-its-dependency.test.mjs runs every check in this
 * repo with its dependency broken -- the network refused, the token rejected with 401, the API
 * answering 200 with nothing -- and requires that the check does NOT come back 'pass'. A check
 * may satisfy that by exiting non-zero, or by printing `unknown` here. It may not satisfy it by
 * being quiet.
 *
 * That guard enumerates the checks BY GLOB, not by a list, so the tenth check written in this
 * repo is covered on the day it is written and nobody has to remember this file exists.
 */

/** I reached the thing I judge, and it is healthy. */
export const PASS = 'pass'
/** I reached the thing I judge, and it is not healthy. */
export const FAIL = 'fail'
/** I did not reach the thing I judge. Never 'pass'. */
export const UNKNOWN = 'unknown'

export const VERDICT_STATES = [PASS, FAIL, UNKNOWN]

/**
 * The marker. Chosen so it cannot collide with GitHub's own `::error::` / `::warning::`
 * annotations, which are NOT a substitute: an annotation decorates a log line and leaves the
 * step green, and a green step is precisely what nobody looks at. `check-external-tools-
 * freshness.mjs` printed `::warning::the external-tools scan is stale` for a register it had
 * failed to read at all, and the workflow was green, and that is the whole bug.
 */
export const VERDICT_MARKER = '::check-verdict::'

/**
 * Print the canonical verdict line. `reason` is a plain sentence a person can act on, not a
 * code -- it lands in a workflow log that somebody reads at 07:00 with no context.
 *
 * Deliberately writes to stdout, alongside the check's own human output, rather than to a file:
 * a verdict that only exists in an artefact is one more thing that can silently not be written.
 */
export function sayVerdict(state, reason) {
  if (!VERDICT_STATES.includes(state)) {
    throw new Error(`sayVerdict: "${state}" is not one of ${VERDICT_STATES.join(' / ')}`)
  }
  console.log(`${VERDICT_MARKER}${state} ${String(reason || '').trim()}`)
  return state
}

/**
 * The LAST verdict a run declared, or null when it declared none.
 *
 * Last, not first, on purpose: a check may narrow its answer as it learns more, and the final
 * word is the one the run stands behind. `null` is not a pass -- see mustNotBePass().
 */
export function verdictOf(output) {
  const lines = String(output || '').split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const at = lines[i].indexOf(VERDICT_MARKER)
    if (at === -1) continue
    const rest = lines[i].slice(at + VERDICT_MARKER.length).trim()
    const state = rest.split(/\s+/)[0]
    if (VERDICT_STATES.includes(state)) return { state, reason: rest.slice(state.length).trim() }
  }
  return null
}

/**
 * Did this run report a pass? The question the guard asks, written once so every caller asks it
 * the same way.
 *
 * A run counts as PASSING when it exited 0 and did not say otherwise. That asymmetry is the
 * point of the whole file: silence plus a zero exit is read as a claim of health, because that
 * is exactly how a human and a CI dashboard read it. A check that wants to exit 0 while being
 * unable to look must SAY SO with sayVerdict(UNKNOWN, ...).
 */
export function reportedPass({ exitCode, output }) {
  if (exitCode !== 0) return false
  const v = verdictOf(output)
  return !v || v.state === PASS
}
