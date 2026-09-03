// IS OUR CI ACTUALLY KEEPING UP - and would we find out if it stopped?
//
// WHY THIS EXISTS (2026-09-03). Roger found 24 GitHub Actions runners on his personal work PC that
// he had never agreed to, and when they were removed he asked the question nobody had a number
// for: "we still have an issue if this is still going on. This was the reason why we used the PC
// in the first place, because it's more capable, or am I mistaken here?"
//
// He was mistaken about the cause - measured over 239 jobs while both machines were serving, the
// laptop's median queue wait was identical (3.0s) and the same job took 0.99x as long. But he was
// RIGHT that nothing was watching. Every other check here asks whether a runner is PRESENT. None
// asked whether the work is MOVING. A fleet can be fully online and still too small.
//
// WHAT THIS WATCHES IS THE HARM, NOT THE COMPONENT: a job that has been handed to us and cannot
// start. Not core counts, not load averages, not "is the machine up".
//
// IT ASKS PER REPOSITORY, AND THAT IS THE WHOLE POINT. The first version of this file compared
// queued jobs against the FLEET's busy runners and, on its first live run, called a real Valrano
// backlog "not a capacity problem" because 22 runners were idle - in other repositories. A GitHub
// runner is registered to ONE repository and can never take another's work, so a fleet total is
// the wrong denominator. This is the same defect the machine audit was written to fix, one layer
// down: A COUNT THAT AGGREGATES CANNOT SEE THE PART OF IT THAT IS FULL.
//
// Two states share the symptom "jobs are queued" and are opposites, so they are reported apart:
//   SATURATED - this repository's own runners are ALL busy while its jobs wait. Real backlog.
//               The answer is more runners or a bigger CI machine, never Roger's work PC.
//   IDLE      - jobs waiting while this repository's runners sit doing nothing. Not capacity:
//               a label mismatch, or a job asking for a runner this repository does not have.
//               More hardware would fix nothing.

/**
 * @param {{perRepo: Array<{repo: string, runners: Array<{status: string, busy: boolean}>}>,
 *          queuedOurs: Record<string, number>}} opts
 *   `queuedOurs` = jobs QUEUED in that repo that ask for OUR runner label. Jobs waiting for a
 *   GitHub-hosted runner are somebody else's queue and must never appear here.
 * @returns {{busy: number, online: number, queuedTotal: number, perRepo: object, alerts: string[]}}
 */
export function auditRunnerSaturation({ perRepo, queuedOurs = {} }) {
  const alerts = []
  const detail = {}
  let busy = 0
  let online = 0

  for (const { repo, runners } of perRepo) {
    const list = (runners || []).filter((r) => r.status === 'online')
    const repoBusy = list.filter((r) => r.busy).length
    const idle = list.length - repoBusy
    const waiting = queuedOurs[repo] || 0
    online += list.length
    busy += repoBusy
    detail[repo] = { online: list.length, busy: repoBusy, waiting }
    if (waiting <= 0) continue

    if (list.length > 0 && idle === 0) {
      alerts.push(
        `CI IS SATURATED: ${repo} has ${waiting} job(s) waiting and all ${list.length} of its own ` +
        `runners are busy. Runners belong to ONE repository, so idle runners elsewhere cannot take ` +
        `this work - the fleet total is not the answer here. Deploys and gates in ${repo} are ` +
        `queueing behind each other. The fix is more runners for ${repo} or a bigger CI machine. ` +
        `It is NOT Roger's work PC: he retired that on 2026-08-25 and again on 2026-09-03.`,
      )
    } else {
      alerts.push(
        `JOBS QUEUED WHILE ${repo.toUpperCase()}'S OWN RUNNERS ARE IDLE: ${waiting} job(s) waiting ` +
        `with ${idle} of ${list.length} runners doing nothing. This is not capacity and more ` +
        `hardware would fix nothing: those jobs are asking for a runner label this repository does ` +
        `not offer, or it has no runner registered at all.`,
      )
    }
  }

  const queuedTotal = Object.values(queuedOurs).reduce((a, n) => a + (n > 0 ? n : 0), 0)
  return { busy, online, queuedTotal, perRepo: detail, alerts }
}
