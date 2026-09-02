/**
 * HOW LONG HAVE WE BEEN PAYING GITHUB, and when is that worth saying out loud.
 *
 * WHY THIS EXISTS (2026-09-01 audit). `check-ci-runners.mjs` alerted on the TRANSITION away from
 * our own build machines — `online === 0 && isSet` — and the act of alerting cleared the label, so
 * ten minutes later the same repository answered `online === 0 && !isSet`, matched no branch,
 * produced no finding, and the run printed "CI runner watchdog: PASS". The fleet could sit on
 * rented runners for a week behind a green watchdog and a silent mailbox. Nothing is broken while
 * that happens — deploys still ship — it is purely a bill nobody is told about.
 *
 * ROGER'S DECISION, 2026-09-02, asked as a question with the measured numbers in front of him
 * (rate $0.006 per Linux minute, read from check-ci-budget.mjs; declared ceiling 12,000 minutes a
 * month, so $72 for a month entirely on rented machines):
 *
 *     "Once a day, after 12 quiet hours."
 *
 * So: silent for the first GRACE_H hours, because a machine switched off overnight or over an
 * evening costs cents and fixes itself when somebody turns it on, and an alarm for that is an
 * alarm that gets muted. After that, ONE message a day for as long as it lasts, and silence again
 * the moment a machine comes home. Worst case is about 7 messages in a week of total outage, which
 * stays inside his standing measure that more than about two alerts a week means the alerts are
 * wrong — for something that is genuinely rare.
 *
 * WHY THE RE-ALERT CLOCK IS NOT OPTIONAL: the watchdog runs every ten minutes and
 * `send-ci-runner-alert.mjs` has no throttle of its own, so without REALERT_H a build machine left
 * off would send six emails an hour, 144 a day. That is the whole reason this needed a decision
 * rather than a quick fix.
 *
 * WHY ONE FLEET-WIDE MESSAGE AND NOT ONE PER REPOSITORY: all fourteen fall back in the same minute
 * for the same reason — a machine is off — and fourteen mails about one fact is the shape that
 * trains an alarm away. Same reasoning as the rollup in check-healthchecks-down.mjs.
 *
 * The state lives in ONE repository variable on production-monitor rather than one per product, so
 * the whole thing costs a single API read per run instead of fourteen. The GitHub allowance is a
 * shared 5,000/hour pool that this fleet has already exhausted twice, so a watcher that spends
 * 2,900 calls a day to watch a bill would be its own kind of expensive.
 */

export const GRACE_H = Number(process.env.CI_RUNNER_PAID_GRACE_H || 12)
export const REALERT_H = Number(process.env.CI_RUNNER_PAID_REALERT_H || 24)
/** Read from check-ci-budget.mjs, which is where the fleet's cost arithmetic already lives. */
export const RATE_PER_MIN = 0.006

const hoursBetween = (fromIso, now) => {
  const t = Date.parse(fromIso || '')
  return Number.isFinite(t) ? (now - t) / 3600000 : null
}

/**
 * The whole decision, pure so it can be tested without GitHub, a clock or a network.
 *
 * `paying` is the list of repository names currently building on rented runners. `state` is what we
 * recorded last run: `{ repo: { since, alerted_at } }`. Returns the new state, whether it changed,
 * and the one alert line to send — or null for silence, which is the answer on almost every run.
 */
export function decideReminder({ paying, state = {}, now = Date.now(), graceH = GRACE_H, realertH = REALERT_H }) {
  const next = {}
  let changed = false

  for (const repo of paying) {
    // A repository that has just started paying gets its clock started and says nothing. We can
    // only honestly measure from the moment we began measuring.
    next[repo] = state[repo]?.since ? { ...state[repo] } : { since: new Date(now).toISOString(), alerted_at: null }
    if (!state[repo]?.since) changed = true
  }
  // Anything that came home drops out of the state entirely: silence is the correct report for a
  // fleet that is no longer paying, and a stale row would otherwise keep its old clock running.
  for (const repo of Object.keys(state)) if (!(repo in next)) changed = true

  const due = Object.entries(next).filter(([, mark]) => {
    const paidFor = hoursBetween(mark.since, now)
    if (paidFor === null || paidFor < graceH) return false
    const sinceTold = mark.alerted_at ? hoursBetween(mark.alerted_at, now) : null
    return sinceTold === null || sinceTold >= realertH
  })

  if (!due.length) return { state: next, changed, alert: null }

  const longest = Math.max(...due.map(([, m]) => hoursBetween(m.since, now) ?? 0))
  const names = due.map(([repo]) => repo).sort()
  const stamp = new Date(now).toISOString()
  for (const [repo] of due) { next[repo].alerted_at = stamp; changed = true }

  return {
    state: next,
    changed,
    alert:
      `PAYING GITHUB FOR BUILDS: ${names.length} repositor${names.length === 1 ? 'y has' : 'ies have'} been building on rented machines for `
      + `${Math.round(longest)}h, because no build machine of ours is online for them (${names.join(', ')}). `
      + `Nothing is broken and deploys still ship — every build minute is simply billed at $${RATE_PER_MIN} until a machine comes back. `
      + `Switching one on ends this by itself, and this message repeats at most once a day.`,
  }
}
