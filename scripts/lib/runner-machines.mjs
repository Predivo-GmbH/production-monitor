// WHICH PHYSICAL MACHINE IS ACTUALLY DOING OUR CI - and the alarm for when one of them stops.
//
// WHY THIS EXISTS (2026-09-01). The CI runner watchdog counted ONLINE RUNNERS PER REPOSITORY and
// was satisfied by one. We run two machines, an office PC and a laptop, each with its own set of
// runners in every repository. On 2026-08-25 all 24 of the office PC's runners had their
// registrations DELETED by GitHub - the machine's WSL distro does not start at boot, nothing
// restarted it, and GitHub removes a runner registration that has been offline too long. The
// watchdog stayed green for a week, because the laptop's runners kept every repository's count
// above zero. Half the fleet's CI capacity vanished and the only symptom was that jobs took
// longer and one machine wore all the work.
//
// The lesson, and the rule this file encodes: A COUNT THAT AGGREGATES TWO MACHINES CANNOT SEE
// ONE OF THEM DIE. Ask per machine, not per repository.
//
// Two questions, because they fail differently:
//   1. Is every machine we expect still present ANYWHERE in the fleet? A machine with zero online
//      runners across every repository has gone: powered off, WSL down, or deregistered.
//   2. Is any repository being served by only ONE machine while other machines are alive? That
//      repository has silently become a single point of failure - the exact state the fleet was
//      in for a week - even though its own runner count looks fine.
//
// ABSENCE IS NOT SUCCESS. A runner whose name does not follow the convention is REPORTED, never
// silently dropped: an unparseable name means we cannot tell which machine it belongs to, and a
// coverage answer computed from runners we could not attribute is not an answer.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// Our runners are registered as `wsl-<MACHINE>-<repo>[-N]`, e.g. `wsl-LAPTOP-88N97BGG-cockpit-2`.
// GitHub's runner API does not return a hostname, so the name is the only place the machine is
// recorded. Windows machine names here are upper-case letters/digits with a single hyphen
// (LAPTOP-88N97BGG, DESKTOP-124K6MV); the repository suffix that follows is lower/mixed case.
const RUNNER_NAME = /^wsl-([A-Z0-9]+-[A-Z0-9]+)-(.+)$/

/**
 * The machine a runner name belongs to, or null when the name does not follow the convention.
 * Never guesses: a null here becomes a reported finding, not a skipped runner.
 */
export function machineOf(runnerName) {
  const m = RUNNER_NAME.exec(String(runnerName ?? ''))
  return m ? m[1] : null
}

export function loadExpectedMachines() {
  const here = dirname(fileURLToPath(import.meta.url))
  const raw = JSON.parse(readFileSync(join(here, 'ci-runner-machines-baseline.json'), 'utf8'))
  return raw.machines
}

/**
 * @param {Array<{repo: string, runners: Array<{name: string, status: string}>}>} perRepo
 * @param {{expected: string[]}} opts  machines we expect to exist (the baseline file)
 * @returns {{machines: object, alerts: string[], unattributed: string[]}}
 */
export function auditRunnerMachines(perRepo, { expected }) {
  const machines = {}          // machine -> Set of repos where it has an ONLINE runner
  const unattributed = []      // runner names we could not attribute to a machine
  const reposWithRunners = []

  for (const { repo, runners } of perRepo) {
    const list = runners || []
    if (!list.length) continue // never migrated: nothing to watch here
    reposWithRunners.push(repo)
    for (const r of list) {
      const machine = machineOf(r.name)
      if (!machine) { unattributed.push(`${repo}: "${r.name}"`); continue }
      if (r.status !== 'online') continue
      ;(machines[machine] ||= new Set()).add(repo)
    }
  }

  const alerts = []

  // 1. A machine we expect that is nowhere online has gone, not "is quiet".
  for (const m of expected) {
    const covers = machines[m]
    if (!covers || covers.size === 0) {
      alerts.push(
        `MACHINE GONE: ${m} has no online runner in ANY repository. Its share of the fleet's CI is ` +
        `now being done by the other machine(s), and no run will fail to tell you. If it stays ` +
        `offline GitHub deletes its registrations and it will not come back by itself.`,
      )
    }
  }

  // A machine we did NOT expect is not an error, but it must not pass unremarked - it is either a
  // new machine nobody wrote down or a name that changed under us.
  for (const m of Object.keys(machines)) {
    if (!expected.includes(m)) {
      alerts.push(`UNKNOWN MACHINE: ${m} has online runners but is not in the baseline. Add it or remove it.`)
    }
  }

  // 2. Only worth asking once at least two machines are actually alive - with one machine left,
  //    "this repo has one machine" is the same fact as the MACHINE GONE alert above, and saying it
  //    once per repository would bury it.
  const alive = Object.keys(machines).filter((m) => machines[m].size > 0)
  if (alive.length >= 2) {
    for (const repo of reposWithRunners) {
      const covering = alive.filter((m) => machines[m].has(repo))
      if (covering.length === 1) {
        alerts.push(
          `SINGLE MACHINE: ${repo} is served only by ${covering[0]}. ${alive.length} machines are ` +
          `alive, so this repository lost one and its runner count did not change.`,
        )
      }
    }
  }

  for (const u of unattributed) {
    alerts.push(`UNREADABLE RUNNER NAME: ${u} - cannot tell which machine it is on, so coverage for it is unknown.`)
  }

  return {
    machines: Object.fromEntries(Object.entries(machines).map(([k, v]) => [k, [...v].sort()])),
    alerts,
    unattributed,
  }
}
