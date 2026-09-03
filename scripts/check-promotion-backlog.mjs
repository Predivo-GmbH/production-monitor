#!/usr/bin/env node
/**
 * NOTHING SHIPPED FOR TOO LONG, AND NOTHING SPLIT IN TWO.
 *
 * WHY THIS EXISTS (2026-09-03). Roger, on the Deploy Status page for the fourth time in two days:
 * *"I do not want to have this fucking deploy board stale and not working properly."*
 *
 * The page was not lying. Distribution-OS had been saying "staging and production have drifted
 * apart - this needs merging, not approving" since 2026-08-04 - a month - while each branch kept
 * collecting work the other never received, production's side including a gate password rotated
 * because the previous one had reached git. Other products sat "N commits on staging that
 * production does not have" until somebody happened to look.
 *
 * So the gap was never truthfulness. It was that A DASHBOARD IS PULL: nothing went red when the
 * page was right and nobody acted. Every other class of rot here is caught by something that fails
 * on its own; this one had nothing. `check-drift.mjs` watches Supabase schema and cron drift, not
 * shipping.
 *
 * This run FAILS (exit 1) when a product has been promotable past the threshold, or is diverged at
 * any age. The red run IS the alert, same as every other guard in this repo.
 *
 * ⭐ IT COMPARES WHAT IS DEPLOYED, NOT THE BRANCH HEADS. On Distribution-OS the branch heads say
 * ahead 9 / behind 17 and the deployed commits say ahead 9 / behind 8. Both true, different
 * questions; "is production behind" is about what is LIVE. Comparing one against the other is how
 * you invent a bug that is not there - I nearly filed exactly that.
 *
 * ABSENCE IS NOT SUCCESS. If it cannot read a repo it says so and fails, rather than reporting a
 * healthy fleet it never looked at.
 */
import { classifyBacklog, rank, DEFAULT_MAX_AGE_H } from './lib/promotion-backlog.mjs'

const OWNER = process.env.PROMO_OWNER || 'Predivo-GmbH'
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
const MAX_AGE_H = Number(process.env.PROMO_MAX_AGE_H || DEFAULT_MAX_AGE_H)

// Products that ship a website to the shared host and have a staging environment.
const FLEET = (process.env.PROMO_FLEET || 'ChannelMover,ScoutCopilot,Valrano,BoatBuddy,ReplyFlow,backoffice,distribution-os,signalscore')
  .split(',').map((s) => s.trim()).filter(Boolean)

if (!TOKEN) {
  console.error('::error::no GH_TOKEN / GITHUB_TOKEN - cannot check the promotion backlog, and will not pretend the fleet is clean')
  process.exit(1)
}

const H = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'promotion-backlog',
}
let apiErrors = 0
async function gh(path) {
  try {
    const r = await fetch(`https://api.github.com${path}`, { headers: H })
    if (!r.ok) { apiErrors++; return null }
    return await r.json()
  } catch { apiErrors++; return null }
}

/** The head sha of the most recent run whose named job actually SUCCEEDED. Never the run colour. */
async function lastDeployedSha(repo, workflowMatch, jobName) {
  const runs = await gh(`/repos/${OWNER}/${repo}/actions/runs?per_page=30`)
  if (!runs?.workflow_runs) return null
  for (const run of runs.workflow_runs) {
    if (!workflowMatch.test(String(run.name || ''))) continue
    const jobs = await gh(`/repos/${OWNER}/${repo}/actions/runs/${run.id}/jobs?per_page=50`)
    const job = (jobs?.jobs || []).find((j) => j.name === jobName)
    if (job?.conclusion === 'success') return run.head_sha
  }
  return null
}

const results = []
const unreadable = []

for (const repo of FLEET) {
  const prod = await lastDeployedSha(repo, /deploy/i, 'deploy')
  const staging = await lastDeployedSha(repo, /deploy/i, 'deploy-staging')
  if (!prod || !staging) { unreadable.push(`${repo} (prod=${prod ? 'ok' : 'unknown'}, staging=${staging ? 'ok' : 'unknown'})`); continue }
  if (prod === staging) { results.push(classifyBacklog({ name: repo, status: 'identical', aheadBy: 0, oldestUnshippedAt: null }, { maxAgeH: MAX_AGE_H })); continue }

  const cmp = await gh(`/repos/${OWNER}/${repo}/compare/${prod}...${staging}`)
  if (!cmp) { unreadable.push(`${repo} (compare failed)`); continue }

  // The OLDEST commit still waiting, which is what "how long has this sat" means.
  const oldest = (cmp.commits || [])[0]?.commit?.committer?.date || null
  results.push(classifyBacklog({
    name: repo,
    status: cmp.status,
    aheadBy: cmp.ahead_by,
    behindBy: cmp.behind_by,
    oldestUnshippedAt: oldest,
  }, { maxAgeH: MAX_AGE_H }))
}

const bad = rank(results)
for (const r of results.filter((x) => x.level === 'ok')) console.log(`  ok    ${r.reason}`)
for (const r of bad) console.log(`  ${r.level.toUpperCase().padEnd(8)} ${r.reason}`)

if (unreadable.length) {
  console.log('')
  for (const u of unreadable) console.log(`::error::could not read shipping state for ${u}`)
}

console.log(`\nchecked ${results.length} product(s), ${bad.length} needing action, ${unreadable.length} unreadable`)

if (results.length === 0) {
  console.error('::error::no product could be read at all - refusing to report a clean fleet')
  process.exit(1)
}
for (const r of bad) console.log(`::error::${r.reason}`)
process.exit(bad.length || unreadable.length || apiErrors ? 1 : 0)
