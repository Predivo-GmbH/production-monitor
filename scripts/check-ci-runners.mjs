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

const OWNER = process.env.CI_RUNNER_OWNER || 'Predivo-GmbH'
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
const LABEL = process.env.CI_RUNNER_LABEL || 'predivo-wsl'
const APPLY = process.env.CI_RUNNER_APPLY !== '0' // set 0 to report without changing anything
const QUEUE_ALERT_MIN = Number(process.env.CI_RUNNER_QUEUE_ALERT_MIN || 20)

if (!TOKEN) {
  console.error('::error::no GH_TOKEN / GITHUB_TOKEN - cannot check runners, and will not pretend the fleet is healthy')
  process.exit(1)
}

const H = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'ci-runner-watchdog',
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let apiErrors = 0

async function gh(path, init = {}) {
  for (let attempt = 0; attempt < 5; attempt++) {
    let r
    try {
      r = await fetch(`https://api.github.com/${path}`, { ...init, headers: { ...H, ...(init.headers || {}) } })
    } catch {
      await sleep(1500)
      continue
    }
    if (r.status === 403 || r.status === 429) { await sleep(5000); continue }
    if (r.status === 404) return { notFound: true }
    if (r.status === 204) return { ok: true }
    if (!r.ok) {
      if (r.status >= 500) { await sleep(1500); continue }
      apiErrors++
      return { error: `${r.status} ${await r.text()}` }
    }
    return r.json()
  }
  apiErrors++
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
if (!repos.length) {
  console.error('::error::listed no private repositories. Broken token or broken harness - not a healthy fleet.')
  process.exit(1)
}

const flipped = []
const alerts = []
let migrated = 0

for (const repo of repos) {
  const runners = await gh(`repos/${OWNER}/${repo}/actions/runners`)
  const list = runners?.runners || []
  if (!list.length) continue // never migrated: nothing to watch, leave it alone
  migrated++

  const online = list.filter((r) => r.status === 'online').length
  const cur = await gh(`repos/${OWNER}/${repo}/actions/variables/RUNNER_LABEL`)
  const isSet = !cur?.notFound && cur?.value === LABEL

  if (online === 0 && isSet) {
    alerts.push(`${repo}: ${list.length} runner(s) registered, NONE online -> falling back to GitHub-hosted`)
    if (APPLY) {
      const res = await gh(`repos/${OWNER}/${repo}/actions/variables/RUNNER_LABEL`, { method: 'DELETE' })
      flipped.push(`${repo} -> ubuntu-latest${res?.error ? ` (FAILED: ${res.error})` : ''}`)
    }
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
      flipped.push(`${repo} -> ${LABEL} (runner back online)`)
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
}

if (!migrated) {
  console.error('::error::no repository has a self-hosted runner registered. Either the migration was undone, or this token cannot see runners. Not treating that as healthy.')
  process.exit(1)
}
if (apiErrors) {
  console.error(`::error::${apiErrors} API call(s) failed - this run cannot certify the fleet`)
  process.exit(1)
}

console.log(`repos with runners : ${migrated}`)
console.log(`variable flips     : ${flipped.length ? flipped.join(', ') : 'none'}`)
console.log(`apply mode         : ${APPLY ? 'on (variables are changed)' : 'off (report only)'}`)

// House pattern: the guard writes findings, a matching send-*.mjs emails them on failure.
// A red run in the GitHub UI is not an alert, because nobody is watching the GitHub UI.
writeFileSync('ci-runner-findings.json', JSON.stringify({
  generated_at: new Date().toISOString(),
  repos_with_runners: migrated,
  flips: flipped,
  findings: alerts,
}, null, 2))

if (!alerts.length) {
  console.log('\nCI runner watchdog: PASS')
  process.exit(0)
}
for (const a of alerts) console.log(`::warning::${a}`)
console.log(`\nCI runner watchdog: ${flipped.length ? 'FELL BACK TO GITHUB-HOSTED' : 'ATTENTION'} (${alerts.length})`)
// Exit 1 so the red run IS the alert, same model as the other fleet guards.
process.exit(1)
