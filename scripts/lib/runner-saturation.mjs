// IS OUR CI ACTUALLY KEEPING UP - and would we find out if it stopped?
//
// WHY THIS EXISTS (2026-09-03). Roger found 24 GitHub Actions runners on his personal work PC that
// he had never agreed to, and when they were removed he asked the question nobody had a number
// for: "we still have an issue if this is still going on. This was the reason why we used the PC
// in the first place, because it's more capable, or am I mistaken here?"
//
// He was mistaken about the cause - measured over 239 jobs while both machines were serving, the
// laptop's median queue wait was identical (3.0s) and the same job took 0.99x as long. But he was
// RIGHT that nothing was watching. Every existing check asks whether a runner is PRESENT. None
// asked whether work is WAITING. A fleet can be fully online and still too small.
//
// WHAT THIS WATCHES IS THE HARM, NOT THE COMPONENT: a job that has been handed to us and is
// sitting in a queue. Not core counts, not load averages, not "is the machine up" - a real job
// that cannot start. That is the same rule the runner-loss check follows, for the same reason:
// a proxy goes green for the wrong thing, the harm does not.
//
// Two states share the symptom "jobs are queued" and are opposites, so they are reported apart:
//   SATURATED    - jobs waiting AND our runners are nearly all busy. We are out of capacity.
//                  The answer is a bigger or an extra CI machine, never Roger's work PC.
//   STARVED      - jobs waiting while our runners sit IDLE. That is not capacity, that is a
//                  mismatch: the jobs are asking for a label nothing here offers, and adding
//                  hardware would fix nothing.

/** Fraction of runners currently executing a job, 0 when there are none. */
export function busyFraction({ busy, total }) {
  return total > 0 ? busy / total : 0
}

/**
 * @param {{perRepo: Array<{repo: string, runners: Array<{status: string, busy: boolean}>}>,
 *          queued: Record<string, number>,
 *          saturatedAt?: number}} opts
 * @returns {{busy: number, online: number, queuedTotal: number, alerts: string[]}}
 */
export function auditRunnerSaturation({ perRepo, queued = {}, saturatedAt = 0.9 }) {
  let online = 0
  let busy = 0
  for (const { runners } of perRepo) {
    for (const r of runners || []) {
      if (r.status !== 'online') continue
      online++
      if (r.busy) busy++
    }
  }
  const waiting = Object.entries(queued).filter(([, n]) => n > 0)
  const queuedTotal = waiting.reduce((a, [, n]) => a + n, 0)
  const frac = busyFraction({ busy, total: online })
  const alerts = []

  if (queuedTotal > 0) {
    const where = waiting.map(([repo, n]) => `${repo} (${n})`).join(', ')
    if (frac >= saturatedAt) {
      alerts.push(
        `CI IS SATURATED: ${queuedTotal} job(s) are waiting for a runner while ${busy} of ${online} ` +
        `runners are already busy - ${where}. Our CI machine is at capacity, so deploys and gates ` +
        `are queueing behind each other. The fix is more capacity on the CI host, or a second ` +
        `dedicated machine. It is NOT Roger's work PC: he retired that on 2026-08-25 and again on ` +
        `2026-09-03.`,
      )
    } else {
      alerts.push(
        `JOBS QUEUED WHILE RUNNERS ARE IDLE: ${queuedTotal} job(s) are waiting - ${where} - but only ` +
        `${busy} of ${online} runners are busy. This is not a capacity problem and more hardware ` +
        `would not fix it: those jobs are asking for a runner label nothing here offers, or their ` +
        `repository has no runner registered.`,
      )
    }
  }

  return { busy, online, queuedTotal, alerts }
}
