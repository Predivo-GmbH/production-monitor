// automation-status.mjs — Collects the latest GitHub Actions run status for every
// workflow across all tracked repos, writes automation-status.json, FTP-uploads it to
// backoffice.predivo.ch (consumed by the BackOffice "Wie wir arbeiten" handbook), and
// flags any workflow that has been red for more than RED_ESCALATION_HOURS.
//
// Runs inside GitHub Actions (production-monitor) with GH_TOKEN + FTP creds.
// Exists because SignalScore production deploys were silently red for 2 weeks
// (missing staging secret, 2026-05-28 → 2026-06-11) with nobody watching the run history.

import { execSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const OWNER = 'Arivioo'
const RED_ESCALATION_HOURS = 48
// Workflows that only run on PRs / rarely — "no recent runs" is normal, not a problem.
const PR_ONLY_WORKFLOWS = ['Code Review', 'Security Review', 'Design Review']

/** Run a gh api call, return parsed JSON, or null on any error (never throws). */
function gh(path) {
  try {
    const out = execSync(`gh api "${path}" --paginate=false`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 20 * 1024 * 1024,
    })
    return JSON.parse(out)
  } catch {
    return null
  }
}

function hoursSince(iso) {
  if (!iso) return null
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return null
  return Math.round((NOW - then) / 36e5)
}

// NOW is captured once so the whole report shares a consistent clock.
const NOW = Date.now()

// --- Repo list: same source as update-dashboard.sh (project-dashboard data.json) ---
const dataFile = gh(`repos/${OWNER}/project-dashboard/contents/data.json`)
if (!dataFile || !dataFile.content) {
  console.error('Could not fetch project-dashboard data.json — aborting')
  process.exit(1)
}
const data = JSON.parse(Buffer.from(dataFile.content, 'base64').toString('utf-8'))
const projects = [...(data.products ?? []), ...(data.tools ?? [])]
  .filter((p) => p.repo)
  .map((p) => ({ repo: p.repo, name: p.name, branch: p.branch || 'main' }))

console.log(`Collecting automation status for ${projects.length} repos...`)

const repos = []
let green = 0
let red = 0
let unknown = 0
const escalations = []

for (const project of projects) {
  const workflowsResp = gh(`repos/${OWNER}/${project.repo}/actions/workflows`)
  if (!workflowsResp || !Array.isArray(workflowsResp.workflows)) {
    console.log(`  ${project.repo}: could not list workflows`)
    repos.push({ ...project, workflows: [], worstConclusion: 'unknown' })
    unknown++
    continue
  }

  const activeWorkflows = workflowsResp.workflows.filter((w) => w.state === 'active')
  const workflowStatuses = []

  for (const wf of activeWorkflows) {
    // Latest runs for this workflow (enough to find when a red streak started).
    const runsResp = gh(`repos/${OWNER}/${project.repo}/actions/workflows/${wf.id}/runs?per_page=30`)
    const runs = (runsResp && Array.isArray(runsResp.workflow_runs)) ? runsResp.workflow_runs : []
    // Ignore runs still in progress for the "latest concluded" view.
    const concluded = runs.filter((r) => r.status === 'completed')
    const latest = concluded[0]
    const prOnly = PR_ONLY_WORKFLOWS.some((n) => wf.name.includes(n))

    if (!latest) {
      workflowStatuses.push({
        name: wf.name,
        conclusion: prOnly ? 'idle' : 'none',
        lastRun: null,
        url: `https://github.com/${OWNER}/${project.repo}/actions/workflows/${wf.path.split('/').pop()}`,
        redSince: null,
        redHours: null,
        prOnly,
      })
      continue
    }

    // Find when the current red streak began (timestamp after the last success).
    let redSince = null
    if (latest.conclusion === 'failure') {
      redSince = latest.created_at
      for (const run of concluded) {
        if (run.conclusion === 'success') break
        if (run.conclusion === 'failure') redSince = run.created_at
      }
    }

    const redHours = redSince ? hoursSince(redSince) : 0
    workflowStatuses.push({
      name: wf.name,
      conclusion: latest.conclusion, // success | failure | cancelled | skipped | ...
      lastRun: latest.created_at,
      url: latest.html_url,
      redSince,
      redHours,
      prOnly,
    })

    if (latest.conclusion === 'failure' && !prOnly && redHours !== null && redHours >= RED_ESCALATION_HOURS) {
      escalations.push({
        repo: project.repo,
        name: project.name,
        workflow: wf.name,
        redHours,
        url: latest.html_url,
      })
    }
  }

  // Worst conclusion drives the repo badge color. PR-only idle/none don't count as red.
  let worst = 'success'
  for (const w of workflowStatuses) {
    if (w.prOnly) continue
    if (w.conclusion === 'failure') { worst = 'failure'; break }
    if (w.conclusion === 'none') worst = worst === 'failure' ? worst : 'unknown'
  }
  if (worst === 'failure') red++
  else if (worst === 'unknown') unknown++
  else green++

  repos.push({ ...project, workflows: workflowStatuses, worstConclusion: worst })
  console.log(`  ${project.repo}: ${worst} (${workflowStatuses.length} workflows)`)
}

const report = {
  generatedAt: new Date(NOW).toISOString(),
  redEscalationHours: RED_ESCALATION_HOURS,
  summary: { repos: projects.length, green, red, unknown, escalations },
  repos,
}

writeFileSync('/tmp/automation-status.json', JSON.stringify(report, null, 2))
console.log(`\nSummary: ${green} green, ${red} red, ${unknown} unknown — ${escalations.length} escalation(s)`)

// --- Resolution detection: diff against the PREVIOUSLY published report ---
// Must run BEFORE the FTP upload below overwrites the published file. Any escalation
// that was in the last published report but is no longer escalated AND whose workflow
// is now green gets a "[AUTOMATION RESOLVED]" email (send-automation-resolved.mjs).
let previousEscalations = []
try {
  const prevRes = await fetch('https://backoffice.predivo.ch/automation-status.json')
  if (prevRes.ok) previousEscalations = (await prevRes.json())?.summary?.escalations ?? []
} catch { /* unreachable/first run — no resolution emails this round */ }

const stillEscalated = new Set(escalations.map((e) => `${e.repo}/${e.workflow}`))
const resolvedEscalations = previousEscalations.filter((e) => {
  if (stillEscalated.has(`${e.repo}/${e.workflow}`)) return false
  const repo = repos.find((r) => r.repo === e.repo)
  const wf = repo?.workflows?.find((w) => w.name === e.workflow)
  return wf?.conclusion === 'success' // only report resolved when it is genuinely green now
})
writeFileSync('/tmp/automation-resolved.json', JSON.stringify(resolvedEscalations, null, 2))
if (resolvedEscalations.length > 0) {
  console.log(`${resolvedEscalations.length} previously-escalated workflow(s) now green (resolution email will be sent):`)
  for (const e of resolvedEscalations) console.log(`  ${e.name} / ${e.workflow} (was red ${e.redHours}h)`)
}

// --- FTP upload to backoffice.predivo.ch (same target as project-data.json) ---
const { FTP_HOST, FTP_USER, FTP_PASS } = process.env
if (FTP_HOST && FTP_USER && FTP_PASS) {
  try {
    execSync(
      `curl -s -T /tmp/automation-status.json "ftp://${FTP_USER}:${FTP_PASS}@${FTP_HOST}/backoffice.predivo.ch/automation-status.json"`,
      { stdio: ['ignore', 'ignore', 'pipe'] },
    )
    console.log('FTP upload complete (automation-status.json).')
  } catch (e) {
    // Was: log and carry on, which left the job green while the published
    // automation-status.json silently went stale. A failed publish IS a failure.
    // (2026-08-23)
    console.error('::error::FTP upload of automation-status.json failed:', e.message)
    process.exitCode = 1
  }
} else {
  console.log('FTP creds not set — skipping upload.')
}

// Write the escalation list so the always()-step can email if non-empty.
// Escalations are DATA, not a script failure — exit 0 so the workflow stays green
// (its job is collecting + uploading, which succeeded). The email + the handbook
// widget surface the red workflows; a real script error still throws → exit 1 → red.
writeFileSync('/tmp/automation-escalations.json', JSON.stringify(escalations, null, 2))

if (escalations.length > 0) {
  console.log(`\n${escalations.length} workflow(s) red for >${RED_ESCALATION_HOURS}h (alert email will be sent):`)
  for (const e of escalations) console.log(`  ${e.name} / ${e.workflow} — ${e.redHours}h`)
}
