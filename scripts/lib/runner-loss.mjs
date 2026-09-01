// DID A SELF-HOSTED RUNNER DIE UNDER A JOB THAT WAS ALREADY RUNNING?
//
// WHY THIS EXISTS (2026-09-01). ChannelMover's `deploy-staging` was destroyed at 19:59Z with
// GitHub's annotation "The self-hosted runner lost communication with the server." The runner had
// not crashed: the WSL2 VM it lives in was torn down, and every one of that machine's 24 runner
// services died with it. Nothing in the fleet noticed, and Roger found it himself on the Deploy
// Status page.
//
// Nothing noticed because every existing layer watches PRESENCE, and this fault is a gap in
// CONTINUITY:
//   - check-ci-runners.mjs asks "does this repo have an ONLINE runner". The VM restarts in
//     seconds, so by the next poll the runner is online again. It was online before and after;
//     only the job in the middle was destroyed.
//   - the machine audit (runner-machines.mjs) asks the same question per MACHINE. Same blind spot.
//   - the `ci-runner-host` heartbeat is pinged every few minutes by the keep-alive loop, which
//     RESTARTS the VM and then reports success - so a teardown makes it greener, not redder.
//   - the machine's own keep-alive log said "ok: 24/24 runner services active" at 21:48 and again
//     at 22:01 local, straddling the exact window in which the job was being shredded. Counting
//     services that come back up in seconds cannot see a VM that went away.
//
// So this module does not watch the runner at all. It watches the HARM: a job that was assigned
// to one of our own runners and then failed without ever reporting a step.
//
// THE SIGNATURE, read off the real failure (run 33551695250, attempt 1) rather than assumed:
//     conclusion   : 'failure'
//     runner_name  : 'wsl-DESKTOP-124K6MV-ChannelMover'   <- ours, per the naming convention
//     steps        : []                                    <- NOTHING ran
// An ordinary failure cannot look like this. Lint failing, a test failing, a bad FTP password -
// all of them fail AT a step, so the step list is non-empty and one entry is `failure`. Zero
// completed steps on a job that was handed to a real runner means the runner stopped answering
// before it could report even "Set up job".
//
// Deliberately NOT keyed on the annotation text. The annotation is authoritative and is used to
// CONFIRM (see confirmRunnerLoss below), but making it the primary test would cost one extra API
// call per failed job on a shared hourly allowance that the fleet has already emptied once
// (2026-08-27, four sweeps in two hours). The cheap structural filter runs first; confirmation is
// only ever asked for the handful of jobs that already look like this.
import { machineOf } from './runner-machines.mjs'

// GitHub's wording. Matched loosely (case-insensitive, on the distinctive middle) so a future
// rephrasing of the sentence's head or tail does not silently turn confirmation off.
export const LOST_COMMUNICATION_RE = /lost communication with the server/i

/**
 * The cheap structural test: does this job look like its runner vanished under it?
 * Pure; takes a job object exactly as GitHub's "list jobs for a workflow run" returns it.
 */
export function looksLikeRunnerLoss(job) {
  if (!job || job.conclusion !== 'failure') return false

  // Must have been assigned to one of OUR machines. A GitHub-hosted runner cannot have this
  // fault, and a job that never got a runner at all (queued, cancelled) has runner_name null.
  const machine = machineOf(job.runner_name)
  if (!machine) return false

  // The heart of it: nothing ever ran. Treat "no steps at all" and "steps exist but not one of
  // them reached completed" as the same thing - the second is what a runner that died a moment
  // later looks like, and both mean the failure cannot be attributed to anything in the repo.
  const steps = Array.isArray(job.steps) ? job.steps : []
  return !steps.some((s) => s?.status === 'completed')
}

/**
 * The authoritative test, for jobs that already passed looksLikeRunnerLoss.
 * `annotations` is the array from GET <check_run_url>/annotations.
 * Returns true only when GitHub itself says the runner stopped answering.
 */
export function confirmRunnerLoss(annotations) {
  if (!Array.isArray(annotations)) return false
  return annotations.some((a) => LOST_COMMUNICATION_RE.test(a?.message || ''))
}

/**
 * One human sentence per destroyed job. This is what lands in Roger's inbox, so it names the
 * MACHINE - the thing he can act on - not the runner id, and says plainly that the repo did
 * nothing wrong. `confirmed` distinguishes "GitHub said so" from "it has the shape".
 */
export function describeRunnerLoss({ repo, run, job, confirmed }) {
  const machine = machineOf(job.runner_name) || 'an unknown machine'
  const what = confirmed
    ? 'the runner stopped answering mid-job (GitHub: "lost communication with the server")'
    : 'the runner reported no steps at all, which is what a runner dying mid-job looks like'
  return `${repo}: "${job.name}" was destroyed on ${machine} - ${what}. `
    + `Nothing is wrong with the code; the build machine went away under a running job. `
    + `Run ${run?.id ?? '?'}${run?.html_url ? ` ${run.html_url}` : ''}`
}

/**
 * Decide which recently-failed runs are worth spending a jobs call on.
 * Bounded on purpose: the fleet shares one hourly GitHub API allowance and has emptied it before.
 */
export function recentFailedRuns(runs, { now = Date.now(), lookbackMinutes = 90, max = 5 } = {}) {
  const cutoff = now - lookbackMinutes * 60_000
  return (runs || [])
    .filter((r) => r?.conclusion === 'failure')
    .filter((r) => {
      const t = Date.parse(r.updated_at || r.created_at || '')
      return Number.isFinite(t) && t >= cutoff
    })
    .slice(0, max)
}
