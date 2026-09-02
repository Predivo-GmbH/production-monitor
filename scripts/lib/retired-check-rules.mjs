/**
 * A PAUSED ALARM IS A DECISION, AND EVERY ONE OF THEM MUST BE WRITTEN DOWN.
 *
 * healthchecks.io has two states that CANNOT page, ever: `paused` and `new`. The producer this
 * guards, `check-healthchecks-down.mjs`, says so in its own header — "`paused` is a deliberate
 * human act. Only `down` files a signal." So a paused check is not a quiet alarm, it is no alarm:
 * nothing about the job behind it can reach anybody, for any reason, for as long as it stays that
 * way.
 *
 * THE HOLE THIS REPLACES (found 2026-09-02, red in CI for 3+ runs). The first version of this rule
 * asked "is any paused check still being pinged in the last 36h?" — and it was right that a live
 * job with its alarm off is the dangerous direction. But it measured the JOB's pulse, not the
 * ALARM's state, so it inverted exactly when it mattered:
 *
 *     job alive + alarm off  -> last_ping is recent -> RED   (correct, but this is the safe case:
 *                                                             pausing is undone by the next ping)
 *     job DEAD  + alarm off  -> last_ping ages out  -> GREEN (the catastrophe, reported as fine)
 *
 * A paused check can never go `down`, so it never recovers on its own either. If the job stops,
 * nothing pings, `last_ping` slides past 36h, and the guard fell silent about a switched-off alarm
 * over a job that is genuinely gone — the one state it exists to shout about. The test went green
 * by waiting.
 *
 * So the question is asked about the alarm instead, and it has no clock in it at all: EVERY PAUSED
 * CHECK MUST BE A DECLARED RETIREMENT. There are exactly two honest ways to clear a finding here —
 * arm the check again, or write down that the job is retired and why — and neither of them is
 * "wait". Time cannot turn this green.
 *
 * `new` is deliberately NOT judged here. It also cannot page, but it is already reported every hour
 * by the producer ("configured but never pinged — wired, not proven"), it is what `/resume` legally
 * leaves behind until the job's next real ping, and it clears itself the moment the job proves it is
 * alive. Claiming it twice would be a second alarm nobody can close.
 *
 * Pure and offline: it takes checks and a declaration list, it returns findings. It reads no
 * network and holds no credential.
 */

/** A check is deaf when it is in a state that cannot page, whatever the job behind it is doing. */
export const isPaused = (c) => c.status === 'paused'

/** The id healthchecks knows a check by, falling back to the name when no slug is set. */
export const keyOf = (c) => c.slug || c.name

/**
 * The whole rule. `checks` is every check across every account; `retired` is the committed list of
 * jobs this fleet switched off on purpose. Returns findings in the order a reader wants them:
 * a declaration that no longer matches reality first, then an alarm nobody declared.
 */
export function auditRetirement(checks, retired) {
  const byKey = new Map(checks.map((c) => [keyOf(c), c]))
  const declared = new Set(retired.map((r) => r.check))
  const findings = []

  for (const r of retired) {
    const c = byKey.get(r.check)
    if (!c) {
      findings.push({
        kind: 'missing',
        check: r.check,
        message: `"${r.check}" is declared retired but is not present in any account. It was retired by PAUSING, not by deleting, so it must still exist — a deleted check takes the record of why it was switched off with it. ${r.why}`,
      })
      continue
    }
    if (!isPaused(c)) {
      findings.push({
        kind: 'rearmed',
        check: r.check,
        message: `"${r.check}" is "${c.status}", not paused. ${r.why} An armed watch over a switched-off job pages every night for nothing, which is how a real alarm gets muted.`,
      })
    }
  }

  for (const c of checks) {
    if (!isPaused(c)) continue
    const key = keyOf(c)
    if (declared.has(key)) continue
    findings.push({
      kind: 'undeclared',
      check: key,
      message: `"${key}" is paused and nothing says why. A paused check cannot go down, so nothing about this job can reach anybody — if it has already stopped, this is silence over a corpse. Clear it one of two ways: resume the check so it can page again, or add it to RETIRED with the reason it is off for good. Waiting will not clear it.`,
    })
  }

  return findings
}
