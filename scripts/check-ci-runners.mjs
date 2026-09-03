#!/usr/bin/env node
/**
 * SELF-HOSTED RUNNER WATCHDOG - and the automatic escape hatch.
 *
 * Our CI jobs run on a self-hosted runner in WSL2 on the office PC, because GitHub Actions is
 * rented compute billed by the minute and a machine we already own costs nothing. The obvious
 * risk is equally simple: if that machine is off, asleep, or its VM has been torn down, every
 * job queues forever and nothing ships.
 *
 * So `runs-on` in every migrated workflow is `${{ vars.RUNNER_LABEL || 'ubuntu-latest' }}`.
 * Where a job runs is a repository VARIABLE, not something baked into a file. This script is
 * what moves that variable:
 *
 *   repo has NO online runner  ->  clear RUNNER_LABEL   -> new jobs go to GitHub-hosted runners
 *   repo has an online runner  ->  set RUNNER_LABEL     -> new jobs come back to our machine
 *
 * The failure mode is therefore "we pay GitHub for a while", never "the fleet stops shipping".
 *
 * It runs in production-monitor because this repository is PUBLIC, and GitHub does not charge
 * for Actions minutes on public repositories - so the thing that watches the cost saver is
 * itself free. It must NEVER be given a self-hosted runner: a fork pull request on a public
 * repository can execute arbitrary code on its runner.
 *
 * ABSENCE IS NOT SUCCESS. If this script cannot list repositories, cannot read runners, or
 * finds no migrated repositories at all, it FAILS rather than reporting a healthy fleet. A
 * watchdog whose pass branch is satisfied by "I saw nothing" is worse than no watchdog, because
 * it manufactures confidence.
 */
import { writeFileSync } from 'node:fs'
import { auditRunnerMachines, loadExpectedMachines, loadRetiredMachines } from './lib/runner-machines.mjs'
import { auditRunnerSaturation } from './lib/runner-saturation.mjs'
import { looksLikeRunnerLoss, confirmRunnerLoss, describeRunnerLoss, recentFailedRuns } from './lib/runner-loss.mjs'
import { cancelledRequiredGates, describeCancelledGate, recentCancelledRuns } from './lib/cancelled-gate.mjs'

const OWNER = process.env.CI_RUNNER_OWNER || 'Predivo-GmbH'
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
const LABEL = process.env.CI_RUNNER_LABEL || 'predivo-wsl'
const APPLY = process.env.CI_RUNNER_APPLY !== '0' // set 0 to report without changing anything
const QUEUE_ALERT_MIN = Number(process.env.CI_RUNNER_QUEUE_ALERT_MIN || 20)
// How far back to look for jobs a dying machine destroyed. The watchdog runs every 10 minutes, so
// 90 covers a long outage without re-reporting yesterday; a repeat inside the window is the same
// incident being confirmed, not a new one.
const RUNNER_LOSS_LOOKBACK_MIN = Number(process.env.CI_RUNNER_LOSS_LOOKBACK_MIN || 90)

// When the watchdog itself cannot complete (no token, blind token, no runners, API errors) it must
// still leave a report behind, marked broken, so send-ci-runner-alert.mjs (if: failure()) has
// something to email. A red run in the GitHub UI is not an alert - nobody is watching it. Without
// this, the most likely failure of this watchdog (an expired/descoped DASHBOARD_PAT) is silent.
function bail(reason) {
  try {
    writeFileSync('ci-runner-findings.json', JSON.stringify({
      generated_at: new Date().toISOString(),
      watchdog_broken: true,
      broken_reason: reason,
      repos_with_runners: null,
      flips: [],
      findings: [`WATCHDOG COULD NOT COMPLETE: ${reason}`],
    }, null, 2))
  } catch { /* if we cannot even write the report, the alert's missing-file path still fires */ }
  console.error(`::error::${reason}`)
  process.exit(1)
}

if (!TOKEN) {
  bail('no GH_TOKEN / GITHUB_TOKEN - cannot check runners, and will not pretend the fleet is healthy')
}

const H = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'ci-runner-watchdog',
}
import { decideReminder } from '../lib/paidRunnerReminder.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let apiErrors = 0
// Set when a 403/429 is a genuine API RATE LIMIT (the shared hourly allowance emptied), NOT an
// auth failure. Distinguishing these is the whole point: an expired/descoped token and an exhausted
// rate limit both surface as 403, and reporting the first advice for the second told Roger to rotate
// a token that was working. GitHub sends x-ratelimit-remaining:0 only for the former.
let rateLimited = false
let rateLimitReset = null

function rateLimitReason() {
  return `GitHub API rate limit exhausted${rateLimitReset ? ` (core resets at ${rateLimitReset})` : ''} - this is a RATE LIMIT, not an auth failure. The token is valid; an invalid token could not reach the API at all. The shared hourly API allowance was emptied upstream (see the CI Cost Guard / github-api-budget), so this run cannot certify the fleet until the allowance resets. Do NOT rotate the DASHBOARD_PAT.`
}

// `soft` calls are enrichment, never certification: their failure must not count towards
// apiErrors, because apiErrors bails the whole run. Confirming an annotation is a nicety - losing
// it should downgrade one sentence from "GitHub said so" to "it has the shape", not stop the
// watchdog from certifying the fleet.
async function gh(path, init = {}, { soft = false } = {}) {
  for (let attempt = 0; attempt < 5; attempt++) {
    let r
    try {
      r = await fetch(`https://api.github.com/${path}`, { ...init, headers: { ...H, ...(init.headers || {}) } })
    } catch {
      await sleep(1500)
      continue
    }
    if (r.status === 403 || r.status === 429) {
      // A rate-limit 403 is NOT the token's fault, and retrying inside this run cannot fix it -
      // the reset is minutes to an hour away. Record it and stop, so we report the real cause
      // instead of falling through to a bail message that (wrongly) blames the credential.
      if (r.headers.get('x-ratelimit-remaining') === '0') {
        rateLimited = true
        const reset = Number(r.headers.get('x-ratelimit-reset'))
        if (reset) rateLimitReset = new Date(reset * 1000).toISOString()
        return { rateLimited: true }
      }
      await sleep(5000); continue
    }
    if (r.status === 404) return { notFound: true }
    if (r.status === 204) return { ok: true }
    if (!r.ok) {
      if (r.status >= 500) { await sleep(1500); continue }
      if (!soft) apiErrors++
      return { error: `${r.status} ${await r.text()}` }
    }
    return r.json()
  }
  if (!soft) apiErrors++
  return { error: 'gave up' }
}

// Private, non-archived repositories only. Public repos are free and must never host a runner.
const repos = []
for (let page = 1; page <= 5; page++) {
  const j = await gh(`user/repos?per_page=100&page=${page}&affiliation=owner`)
  if (!Array.isArray(j) || !j.length) break
  repos.push(...j.filter((r) => r.private && !r.archived).map((r) => r.name))
  if (j.length < 100) break
}
// A rate limit empties the repo list too, but for a reason that has nothing to do with the token.
// Check it FIRST so we never blame the credential for an exhausted allowance.
if (rateLimited) bail(rateLimitReason())
if (!repos.length) {
  bail('listed no private repositories. Broken token or broken harness - not a healthy fleet.')
}

const flipped = []
const alerts = []
// Repositories building on RENTED machines right now. The transition alert below fires once and
// then clears the label, so from the next run onward this is the only place that state exists.
const payingNow = []
let migrated = 0
// Kept so the per-MACHINE audit below can ask a question this loop structurally cannot: the loop
// asks "does this repository have an online runner", and two machines share that one number.
const perRepo = []
// How many jobs are WAITING FOR ONE OF OUR RUNNERS, per repository. Every other question in this
// file is about presence; this one is about whether the work is moving. A fleet can be fully
// online and still too small, and until 2026-09-03 nothing here would have said so.
//
// Counted per REPOSITORY and per JOB, deliberately. A run is "queued" if ANY of its jobs is, and
// a job may be waiting for a GitHub-hosted runner, which is not our queue at all. So the run list
// is only used to find candidates; what is counted is jobs with status "queued" whose labels ask
// for OUR label.
const queuedByRepo = {}

for (const repo of repos) {
  const runners = await gh(`repos/${OWNER}/${repo}/actions/runners`)
  // A RUNNER LIST WE COULD NOT READ IS NOT AN EMPTY ONE (2026-09-01 audit; the same defect
  // checksFrom() closed in check-healthchecks-down.mjs). `runners?.runners || []` turned a 404
  // from a renamed or descoped repository, an error object, or a changed body shape into "this
  // repository has no runners", which the next line read as "never migrated: leave it alone". A
  // repository we cannot SEE is not a repository that is fine, so it is counted as an API error
  // and the existing apiErrors bail fails the run instead of certifying a fleet nobody read.
  if (!Array.isArray(runners?.runners)) {
    apiErrors++
    console.error(`::error::could not read the runner list for ${repo}: ${runners?.notFound
      ? 'HTTP 404 - the token cannot see this repository, or it was renamed'
      : runners?.error || 'the response carried no runner list'}`)
    continue
  }
  const list = runners.runners
  perRepo.push({ repo, runners: list })

  // Soft: a repository whose queue we cannot read must not fail the fleet check. A queue we could
  // not read is left UNRECORDED rather than written down as zero - zero is the answer that means
  // "everything is fine", and that is the one answer we must never invent.
  const queuedRuns = await gh(`repos/${OWNER}/${repo}/actions/runs?status=queued&per_page=10`, {}, { soft: true })
  if (Array.isArray(queuedRuns?.workflow_runs)) {
    let ours = 0
    let readAll = true
    // Queued runs are rare, so this costs nothing on a healthy fleet and only does work when
    // something is actually waiting - which is exactly when we want the detail.
    for (const run of queuedRuns.workflow_runs) {
      const jobs = await gh(`repos/${OWNER}/${repo}/actions/runs/${run.id}/jobs?per_page=50`, {}, { soft: true })
      if (!Array.isArray(jobs?.jobs)) { readAll = false; continue }
      ours += jobs.jobs.filter((j) => j.status === 'queued' && (j.labels || []).includes(LABEL)).length
    }
    if (readAll || ours > 0) queuedByRepo[repo] = ours
  }

  // The label is read for EVERY repository, BEFORE the "nothing registered" skip, because the two
  // cases that skip look identical from the runner list alone and are opposites:
  //   no runners + no label  -> never migrated. Nothing to watch.
  //   no runners + our label -> the runners were DEREGISTERED while every job still asks for a
  //                             label nothing answers, so they queue for ever.
  const cur = await gh(`repos/${OWNER}/${repo}/actions/variables/RUNNER_LABEL`)
  const isSet = !cur?.notFound && cur?.value === LABEL
  if (!list.length && !isSet) continue // never migrated: nothing to watch, leave it alone
  migrated++

  const online = list.filter((r) => r.status === 'online').length

  if (online === 0 && isSet) {
    alerts.push(list.length
      ? `${repo}: ${list.length} runner(s) registered, NONE online -> falling back to GitHub-hosted`
      : `${repo}: every job still asks for "${LABEL}" but NO runner is registered at all, so they queue for ever -> falling back to GitHub-hosted`)
    if (APPLY) {
      const res = await gh(`repos/${OWNER}/${repo}/actions/variables/RUNNER_LABEL`, { method: 'DELETE' })
      flipped.push(`${repo} -> ubuntu-latest${res?.error ? ` (FAILED: ${res.error})` : ''}`)
    }
  } else if (online === 0 && !isSet) {
    // ALREADY on rented machines. This is the state the transition alert left behind and then
    // never mentioned again, which is how the fleet could pay for a week behind a green watchdog.
    // Not alerted here: the reminder below is fleet-wide and carries Roger's 12-hour quiet window.
    payingNow.push(repo)
  } else if (online > 0 && !isSet) {
    if (APPLY) {
      const body = JSON.stringify({ name: 'RUNNER_LABEL', value: LABEL })
      let res = await gh(`repos/${OWNER}/${repo}/actions/variables/RUNNER_LABEL`, {
        method: 'PATCH', body, headers: { 'Content-Type': 'application/json' },
      })
      if (res?.notFound || res?.error) {
        res = await gh(`repos/${OWNER}/${repo}/actions/variables`, {
          method: 'POST', body, headers: { 'Content-Type': 'application/json' },
        })
      }
      // THE WRITE IS CHECKED, exactly like its sibling above (2026-09-01 audit). This used to
      // report the flip home the instant it had been ATTEMPTED: a 404 from the POST leaves no
      // apiErrors behind, so the report said "runner back online", the run went green, and the
      // repository carried on paying for GitHub-hosted minutes. Reporting a write whose answer you
      // never read is how a watchdog certifies the opposite of what happened.
      const failedWrite = res?.notFound || res?.error
      flipped.push(`${repo} -> ${LABEL} (runner back online)${failedWrite ? ` (FAILED: ${res.error || 'HTTP 404'})` : ''}`)
      if (failedWrite) alerts.push(`${repo}: the runner is back online but the label could NOT be restored (${res?.error || 'HTTP 404'}) - this repository keeps using paid runners.`)
    }
  }

  // A job stuck queued is the symptom a human actually notices, so report it explicitly.
  const runs = await gh(`repos/${OWNER}/${repo}/actions/runs?status=queued&per_page=20`)
  for (const run of runs?.workflow_runs || []) {
    const mins = Math.round((Date.now() - new Date(run.created_at)) / 60000)
    if (mins >= QUEUE_ALERT_MIN) {
      alerts.push(`${repo}: "${run.name}" queued ${mins} min (run ${run.id})`)
    }
  }

  // DID ONE OF OUR MACHINES DIE UNDER A JOB THAT WAS ALREADY RUNNING?
  //
  // Everything above this line watches PRESENCE - is a runner online now. The VM that holds our
  // runners comes back in seconds, so a teardown is invisible to all of it: the runner was online
  // before, online after, and only the job in between was destroyed. That is exactly how
  // ChannelMover sat red on 2026-09-01 with every watcher green and Roger finding it himself.
  // See scripts/lib/runner-loss.mjs for the signature and why it cannot fire on an ordinary
  // failure. Bounded on purpose - the fleet shares one hourly API allowance.
  const failed = await gh(`repos/${OWNER}/${repo}/actions/runs?status=failure&per_page=10`)
  for (const run of recentFailedRuns(failed?.workflow_runs, { lookbackMinutes: RUNNER_LOSS_LOOKBACK_MIN })) {
    const jobs = await gh(`repos/${OWNER}/${repo}/actions/runs/${run.id}/jobs?per_page=50`, {}, { soft: true })
    for (const job of jobs?.jobs || []) {
      if (!looksLikeRunnerLoss(job)) continue
      // Ask GitHub to confirm, but never let that question decide whether we report. An
      // unreachable annotations endpoint downgrades the wording; it does not hide the incident.
      let confirmed = false
      if (job.check_run_url) {
        const ann = await gh(`${job.check_run_url.replace('https://api.github.com/', '')}/annotations`, {}, { soft: true })
        confirmed = confirmRunnerLoss(ann)
      }
      alerts.push(describeRunnerLoss({ repo, run, job, confirmed }))
    }
  }

  // WAS A REQUIRED GATE CANCELLED RATHER THAN FAILED? (an invisible release blocker)
  //
  // The block above catches a runner destroyed mid-job (conclusion=failure, no completed steps).
  // This catches the sibling blind spot the same PRESENCE-watchers also miss: a required GATE that
  // concluded `cancelled` — a job the production `deploy` needs:, killed at its own timeout while
  // the run's other jobs succeeded. A cancelled job is not a red run, so nothing else here sees it;
  // that is exactly how ChannelMover run 33680699080 blocked a release with every watcher green.
  // See scripts/lib/cancelled-gate.mjs for the signature and why it cannot fire on a superseded run.
  // Same bounded, cheap shape as the runner-loss block above; the run conclusion is `cancelled` when
  // a gate is singled out, so status=cancelled is the correct cheap prefilter.
  const cancelledRuns = await gh(`repos/${OWNER}/${repo}/actions/runs?status=cancelled&per_page=10`)
  for (const run of recentCancelledRuns(cancelledRuns?.workflow_runs, { lookbackMinutes: RUNNER_LOSS_LOOKBACK_MIN })) {
    const jobs = await gh(`repos/${OWNER}/${repo}/actions/runs/${run.id}/jobs?per_page=50`, {}, { soft: true })
    for (const job of cancelledRequiredGates(jobs?.jobs)) {
      alerts.push(describeCancelledGate({ repo, run, job }))
    }
  }
}

// A rate limit mid-loop leaves runners/runs unread and would otherwise trip the "token cannot see
// runners" bail below - the same misattribution, one layer down. Report the rate limit instead.
if (rateLimited) bail(rateLimitReason())
if (!migrated) {
  bail('no repository has a self-hosted runner registered. Either the migration was undone, or this token cannot see runners. Not treating that as healthy.')
}
if (apiErrors) {
  bail(`${apiErrors} API call(s) failed - this run cannot certify the fleet`)
}

// PER MACHINE, not per repository. The check above is satisfied by ONE online runner in a repo,
// and we run two machines whose runners share that number - so when all 24 of the office PC's
// runners were deregistered on 2026-08-25, the laptop kept every repository above zero and this
// watchdog reported PASS for a week with half the fleet's CI capacity gone. See
// scripts/lib/runner-machines.mjs. Deliberately NOT wired to the RUNNER_LABEL flip: a missing
// machine is a thing to tell Roger about, not a reason to start paying GitHub while the other
// machine is working perfectly well.
const machineAudit = auditRunnerMachines(perRepo, { expected: loadExpectedMachines(), retired: loadRetiredMachines() })
alerts.push(...machineAudit.alerts)
for (const [machine, coveredRepos] of Object.entries(machineAudit.machines)) {
  console.log(`machine ${machine.padEnd(16)}: online in ${coveredRepos.length} repo(s)`)
}

// IS THE WORK MOVING? Presence is not throughput. Roger asked on 2026-09-03 whether the one
// remaining CI machine can keep up, and no check could answer him - so this one watches the harm
// directly: a job that has been handed to us and cannot start.
const saturation = auditRunnerSaturation({ perRepo, queuedOurs: queuedByRepo })
alerts.push(...saturation.alerts)
console.log(`runners busy       : ${saturation.busy} of ${saturation.online} online`)
console.log(`jobs waiting       : ${saturation.queuedTotal} (asking for "${LABEL}")`)

console.log(`repos with runners : ${migrated}`)
console.log(`variable flips     : ${flipped.length ? flipped.join(', ') : 'none'}`)
console.log(`apply mode         : ${APPLY ? 'on (variables are changed)' : 'off (report only)'}`)

// House pattern: the guard writes findings, a matching send-*.mjs emails them on failure.
// A red run in the GitHub UI is not an alert, because nobody is watching the GitHub UI.
writeFileSync('ci-runner-findings.json', JSON.stringify({
  generated_at: new Date().toISOString(),
  repos_with_runners: migrated,
  runners_busy: saturation.busy,
  runners_online: saturation.online,
  jobs_waiting: saturation.queuedTotal,
  machines: machineAudit.machines,
  flips: flipped,
  findings: alerts,
}, null, 2))

// ── HOW LONG HAVE WE BEEN PAYING (Roger's answer, 2026-09-02: quiet 12h, then once a day) ────
// State lives in ONE variable on this repository rather than one per product, so this costs a
// single API read per run instead of fourteen. The shared GitHub allowance has been exhausted
// twice this fleet's lifetime; a watcher that spends 2,900 calls a day to watch a bill would be
// its own kind of expensive.
{
  const STATE_VAR = process.env.CI_RUNNER_PAID_STATE_VAR || 'RUNNER_PAID_STATE'
  const SELF = process.env.CI_RUNNER_STATE_REPO || 'production-monitor'
  let prior = {}
  const raw = await gh(`repos/${OWNER}/${SELF}/actions/variables/${STATE_VAR}`, {}, { soft: true })
  if (raw && !raw.notFound && typeof raw.value === 'string') {
    try { prior = JSON.parse(raw.value) } catch { prior = {} }
  }
  const { state: nextState, changed, alert } = decideReminder({ paying: payingNow, state: prior, now: Date.now() })
  if (alert) alerts.push(alert)
  if (changed && APPLY) {
    const body = JSON.stringify({ name: STATE_VAR, value: JSON.stringify(nextState) })
    let res = await gh(`repos/${OWNER}/${SELF}/actions/variables/${STATE_VAR}`, { method: 'PATCH', body, headers: { 'Content-Type': 'application/json' } }, { soft: true })
    if (res?.notFound || res?.error) {
      res = await gh(`repos/${OWNER}/${SELF}/actions/variables`, { method: 'POST', body, headers: { 'Content-Type': 'application/json' } }, { soft: true })
    }
    // A write we could not make means the clock did not move, so say it rather than assume it did.
    if (res?.notFound || res?.error) console.error(`::warning::could not record how long the fleet has been paying (${res?.error || 'HTTP 404'}); the reminder may repeat or reset`)
  }
  if (payingNow.length) {
    console.log(`paying GitHub    : ${payingNow.length} repo(s) on rented machines${alert ? ' (said out loud this run)' : ' (inside the quiet window)'}`)
  }
}

if (!alerts.length) {
  console.log('\nCI runner watchdog: PASS')
  process.exit(0)
}
for (const a of alerts) console.log(`::warning::${a}`)
console.log(`\nCI runner watchdog: ${flipped.length ? 'FELL BACK TO GITHUB-HOSTED' : 'ATTENTION'} (${alerts.length})`)
// Exit 1 so the red run IS the alert, same model as the other fleet guards.
process.exit(1)
