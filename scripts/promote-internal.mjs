#!/usr/bin/env node
/**
 * SHIP THE INTERNAL TOOLS BY ITSELF, SO "PROMOTING IT IS MINE" MEANS SOMETHING.
 *
 * WHY (2026-09-03). Roger's deploy page spent the day showing rows that read "Promoting it is
 * mine, not yours" while nothing promoted them. The sentence named an owner with no mechanism
 * behind it, so a row sat until a session happened to look, or the 24h backlog watcher reddened.
 * He asked what to do about it and decided: **"Yes - auto-promote internal."**
 *
 * SCOPE, and it is the whole point: BackOffice, Cockpit and Distribution-OS only. A customer-
 * facing product is still his word, every time, and scripts/lib/auto-promote.mjs refuses anything
 * not on that allowlist. See its header for the decision this encodes and the quotes behind it.
 *
 * ⭐ THIS DEPLOYS TO PRODUCTION WITH NOBODY PRESENT, so it is written to refuse on anything it
 * cannot positively prove, and to do AT MOST ONE promotion per run. It never merges, never forces,
 * never touches a diverged product, and never runs while another fleet deploy is in flight -
 * because on the morning of the same day three simultaneous promotions got our own address refused
 * by the shared host for 45 minutes.
 *
 *   PROMOTE_INTERNAL_DRY_RUN=1   decide and print, dispatch nothing
 *   PROMOTE_INTERNAL_OFF=1       kill switch: do nothing at all, loudly
 */
import { decide, pickOne, pipelineFor, AUTO_PROMOTABLE, REQUIRED_STAGING_JOBS } from './lib/auto-promote.mjs'

const OWNER = process.env.PROMO_OWNER || 'Predivo-GmbH'
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
const DRY = process.env.PROMOTE_INTERNAL_DRY_RUN === '1'

if (process.env.PROMOTE_INTERNAL_OFF === '1') {
  console.log('promote-internal: OFF by PROMOTE_INTERNAL_OFF=1 - nothing was promoted, on purpose.')
  process.exit(0)
}
if (!TOKEN) {
  console.error('::error::no GH_TOKEN / GITHUB_TOKEN - cannot read the fleet, and will not dispatch a production deploy blind')
  process.exit(1)
}

const H = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'promote-internal',
}
async function gh(path, init) {
  try {
    const r = await fetch(`https://api.github.com${path}`, { headers: H, ...init })
    if (!r.ok) return { ok: false, status: r.status, body: null }
    const body = r.status === 204 ? null : await r.json().catch(() => null)
    return { ok: true, status: r.status, body }
  } catch { return { ok: false, status: 0, body: null } }
}

/**
 * The newest run OF ONE NAMED WORKFLOW FILE whose named job actually SUCCEEDED, with that run's
 * job conclusions.
 *
 * It takes a workflow FILE, not a name pattern, and that is the whole fix of 2026-09-03: the old
 * version scanned every recent run for a name containing "deploy" holding a job called `deploy`,
 * and `deploy-edge-functions.yml` matches both. On backoffice and Distribution-OS the edge
 * pipeline won that scan, so "what production is running" was the sha of an edge-functions
 * deploy. See PIPELINES in lib/auto-promote.mjs for the measurements.
 */
async function lastDeployed(repo, workflowFile, jobName) {
  const runs = await gh(`/repos/${OWNER}/${repo}/actions/workflows/${workflowFile}/runs?per_page=30`)
  if (!runs.ok || !runs.body?.workflow_runs) return null
  for (const run of runs.body.workflow_runs) {
    const jobs = await gh(`/repos/${OWNER}/${repo}/actions/runs/${run.id}/jobs?per_page=50`)
    if (!jobs.ok) return null
    const list = jobs.body?.jobs || []
    const job = list.find((j) => j.name === jobName)
    if (job?.conclusion === 'success') {
      const byName = {}
      for (const j of list) byName[j.name] = j.conclusion
      return { sha: run.head_sha, runId: run.id, jobs: byName }
    }
  }
  return null
}

/** The commit a production dispatch would actually ship: the tip of that pipeline's branch. */
async function refHead(repo, ref) {
  const r = await gh(`/repos/${OWNER}/${repo}/commits/${ref}`)
  return r.ok ? (r.body?.sha ?? null) : null
}

/** Is any fleet deploy in flight? Same question the PreToolUse serializer asks. */
async function fleetBusy() {
  for (const repo of [...AUTO_PROMOTABLE, 'ChannelMover', 'ScoutCopilot', 'Valrano', 'BoatBuddy', 'ReplyFlow', 'signalscore', 'predivo']) {
    const r = await gh(`/repos/${OWNER}/${repo}/actions/runs?per_page=8`)
    if (!r.ok) return { busy: true, why: `could not read ${repo}'s runs - treating the fleet as busy rather than guessing it is idle` }
    for (const run of r.body?.workflow_runs || []) {
      if (!/deploy/i.test(String(run.name || ''))) continue
      if (run.status === 'in_progress' || run.status === 'queued') {
        return { busy: true, why: `${repo} "${run.name}" is ${run.status} (run ${run.id})` }
      }
    }
  }
  return { busy: false, why: '' }
}

const busy = await fleetBusy()
if (busy.busy) console.log(`promote-internal: fleet busy - ${busy.why}`)

const decisions = []
for (const repo of AUTO_PROMOTABLE) {
  // The pipeline is PINNED, never pattern-matched. A repo the map does not name is refused here
  // rather than guessed at, the same way the allowlist refuses a product it does not name.
  const pipe = pipelineFor(repo)
  if (!pipe) {
    decisions.push({ promote: false, reason: `${repo}: no production pipeline is pinned for it in lib/auto-promote.mjs - refusing to go looking for one`, repo, stagingSha: null, pipe: null })
    continue
  }
  const prod = await lastDeployed(repo, pipe.prod, 'deploy')
  const staging = await lastDeployed(repo, pipe.staging, 'deploy-staging')
  let compareStatus = null
  if (prod?.sha && staging?.sha && prod.sha !== staging.sha) {
    const cmp = await gh(`/repos/${OWNER}/${repo}/compare/${prod.sha}...${staging.sha}`)
    compareStatus = cmp.ok ? (cmp.body?.status ?? null) : null
  } else if (prod?.sha && staging?.sha) {
    compareStatus = 'identical'
  }
  decisions.push({
    ...decide({
      repo,
      prodSha: prod?.sha ?? null,
      stagingSha: staging?.sha ?? null,
      compareStatus,
      stagingJobs: staging?.jobs ?? {},
      fleetBusy: busy.busy,
      // What would ACTUALLY ship. Read only when there is something to ship, so a hold costs no
      // extra API call; decide() refuses on a null it needed.
      refHeadSha: prod?.sha && staging?.sha && prod.sha !== staging.sha ? await refHead(repo, pipe.ref) : null,
    }),
    repo,
    pipe,
    stagingSha: staging?.sha ?? null,
  })
}

for (const d of decisions) console.log(`  ${d.promote ? 'PROMOTE' : 'hold   '} ${d.reason}`)

const chosen = pickOne(decisions)
if (!chosen) {
  console.log(`promote-internal: nothing to promote (checked ${decisions.length}: ${AUTO_PROMOTABLE.join(', ')}).`)
  process.exit(0)
}

if (DRY) {
  console.log(`promote-internal: DRY RUN - would promote ${chosen.repo} ${String(chosen.stagingSha).slice(0, 7)} via ${chosen.pipe.prod} on ${chosen.pipe.ref}. Nothing dispatched.`)
  process.exit(0)
}

// The workflow dispatched is the SAME FILE the production sha was read from, and the ref is that
// pipeline's own branch - "main" used to be hardcoded here, which for Distribution-OS (default
// branch `master`) would have failed every promotion it ever attempted with an HTTP 422.
const res = await gh(`/repos/${OWNER}/${chosen.repo}/actions/workflows/${chosen.pipe.prod}/dispatches`, {
  method: 'POST',
  body: JSON.stringify({ ref: chosen.pipe.ref, inputs: { confirm: 'deploy' } }),
})
if (!res.ok) {
  console.error(`::error::${chosen.repo}: dispatching ${chosen.pipe.prod} on ${chosen.pipe.ref} failed (HTTP ${res.status}). Nothing was promoted.`)
  process.exit(1)
}
console.log(`promote-internal: dispatched ${chosen.pipe.prod} (${chosen.pipe.ref}) for ${chosen.repo} on ${String(chosen.stagingSha).slice(0, 7)}.`)
console.log(`  gates required and proven green on that commit: ${REQUIRED_STAGING_JOBS.join(', ')}`)
console.log('  The deploy JOB conclusion is the proof it shipped - never the run colour.')
