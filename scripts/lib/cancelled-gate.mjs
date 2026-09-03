// WAS A REQUIRED GATE CANCELLED RATHER THAN FAILED? (the invisible release blocker)
//
// WHY THIS EXISTS (2026-09-03). ChannelMover run 33680699080 ("Deploy to Production"): the
// `gate-security` job's nine real steps all succeeded in 2m06s, then `actions/setup-node`'s
// cache-save post-step ran for eight minutes and the job was cancelled at its own 10-minute limit.
// The production `deploy` job has `needs: gate-security`, so the release was blocked — and NOTHING
// showed red. A cancelled job is not a failed job: the run page answered fine, the run's own
// conclusion said nothing was wrong, and every watcher the fleet had keys on `failure`. Roger would
// only have found this by opening the run and reading the job list.
//
// The root cause of that particular cancellation is being removed repo by repo (gate-security asked
// setup-node for `cache: npm` in a job that never installs, so the cache-save post-step could hang).
// But the CONTINUITY GAP is what this module closes: a required gate can be cancelled for any reason
// — a timeout, a runner going away in cleanup, a future edit — and a cancelled gate must be as
// visible as a failed one, because it blocks the release just the same.
//
// THE SIGNATURE, read off run 33680699080 rather than assumed:
//   gate-security     conclusion=cancelled, 12 steps completed (success + one cancelled post-step)
//   gate-integration  conclusion=success   <- a sibling gate still passed
//   gate-e2e          conclusion=success   <- and another
//   deploy / prod-*   conclusion=skipped
// A run-wide concurrency/supersede cancel takes the WHOLE run: every in-flight job is cancelled at
// once and the run conclusion is `cancelled`. One gate cancelled while SIBLINGS SUCCEED is a
// per-job event — the job hit its own timeout — and that is the case that blocks a release quietly.
// So this is deliberately NOT "any cancelled job": the run-level guard below requires that some
// other job in the same run concluded `success`, which is what tells a superseded run apart from a
// gate that was singled out.

// A required gate, by the fleet's own naming convention. Every `deploy` job in these workflows lists
// its `needs:` as gate-security / gate-integration / gate-e2e / gate-coverage / gate-critical /
// gate-edge-typecheck — all of them begin with "gate". Deliberately anchored on the name rather than
// re-reading each run's `needs:` from the workflow file, which would cost an extra API call per run
// on a shared hourly allowance the fleet has emptied before.
export function isRequiredGateJob(name) {
  return /^gate[-_ ]/i.test(String(name || ''))
}

/**
 * The per-job test: does this job look like a required gate that was cancelled after doing real
 * work? Pure; takes a job object exactly as GitHub's "list jobs for a workflow run" returns it.
 *
 * Requires at least one COMPLETED step, so a gate that was cancelled before it ever started (a
 * queued job killed when a newer run superseded it) is not mistaken for one that ran and was then
 * killed in cleanup — the shape of the real incident, where all twelve steps completed.
 */
export function looksLikeCancelledGate(job) {
  if (!job || job.conclusion !== 'cancelled') return false
  if (!isRequiredGateJob(job.name)) return false
  const steps = Array.isArray(job.steps) ? job.steps : []
  return steps.some((s) => s?.status === 'completed')
}

/**
 * Did any job in this run actually pass? Used to tell a per-job cancellation (some jobs succeeded,
 * one gate was singled out) apart from a wholesale run cancellation (a supersede/concurrency cancel
 * takes everything, so nothing succeeds). Pure.
 */
export function someJobSucceeded(jobs) {
  return (Array.isArray(jobs) ? jobs : []).some((j) => j?.conclusion === 'success')
}

/**
 * The run-level test: the required gates that were cancelled while the run itself made progress.
 * Empty when no job succeeded — that run was cancelled as a whole, which is not this fault. Pure.
 */
export function cancelledRequiredGates(jobs) {
  const list = Array.isArray(jobs) ? jobs : []
  if (!someJobSucceeded(list)) return []
  return list.filter(looksLikeCancelledGate)
}

/**
 * One human sentence per cancelled gate. This is what lands in Roger's inbox, so it says plainly
 * that the code is fine and the RELEASE is blocked, and that a cancelled job shows no red — the
 * whole reason nothing caught it. Names the gate (the thing `deploy` needs) and the run to open.
 */
export function describeCancelledGate({ repo, run, job }) {
  return `${repo}: required gate "${job.name}" was CANCELLED, not failed, in run ${run?.id ?? '?'}. `
    + `Its steps ran and passed; the job was killed at its own timeout (typically the setup-node `
    + `cache-save post-step in a gate that never installs). A cancelled job shows no red — the run `
    + `page and the run's conclusion look clean — but the production deploy needs "${job.name}", so `
    + `the release is silently blocked. Nothing is wrong with the code.`
    + `${run?.html_url ? ` Run ${run.html_url}` : ` Run ${run?.id ?? '?'}`}`
}

/**
 * Decide which recent runs are worth spending a jobs call on. A run whose whole conclusion is
 * `cancelled` is the cheap prefilter (a singled-out gate cancellation sets the run conclusion to
 * cancelled — measured on run 33680699080). Bounded on purpose: the fleet shares one hourly GitHub
 * API allowance and has emptied it before.
 */
export function recentCancelledRuns(runs, { now = Date.now(), lookbackMinutes = 90, max = 5 } = {}) {
  const cutoff = now - lookbackMinutes * 60_000
  return (runs || [])
    .filter((r) => r?.conclusion === 'cancelled')
    .filter((r) => {
      const t = Date.parse(r.updated_at || r.created_at || '')
      return Number.isFinite(t) && t >= cutoff
    })
    .slice(0, max)
}
