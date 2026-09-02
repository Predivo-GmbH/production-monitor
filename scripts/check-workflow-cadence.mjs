#!/usr/bin/env node
/**
 * DID THE WATCHERS THEMSELVES RUN? The dead-man's switch for this repo's own schedules.
 *
 * WHY (2026-09-01 audit). Twelve workflows in this repo are on a cron, and only four of them
 * ping healthchecks.io, so only four can report that they stopped. For the other eight -
 * including the auth-email guard, the RLS grant guard, the drift check and the daily
 * keep-alive that stops free Supabase projects being paused - a workflow that silently stops
 * being scheduled is indistinguishable from a workflow that runs and finds nothing wrong.
 * GitHub does disable schedules by itself (60 days of repo inactivity), a cron can be dropped
 * in an edit, and a workflow can be disabled by hand. None of those produce a red run, because
 * they produce NO run, and nothing here was asking.
 *
 * `check-cron-heartbeats.mjs` answers the same question for the products' pg_cron jobs inside
 * Supabase. This is the same idea one layer out, for our own GitHub schedules.
 *
 * HOW IT DECIDES. Each workflow's cron is read from the file, turned into an expected interval,
 * and compared against the newest scheduled run GitHub reports for it. Overdue means older than
 * 3x the interval, the same "only a persistently dead job fires" rule the pg_cron heartbeat
 * uses, so a single missed tick is never an alarm - and GitHub does drop scheduled ticks under
 * load (see the measurement block at the top of monitor.yml).
 *
 * WHAT IT REFUSES TO DO. A cron shape it cannot parse, a workflow GitHub will not answer for,
 * and a workflow with no scheduled run at all are each reported as DEAD and fail the check.
 * They are not "fine": not knowing whether a guard ran is the state this file exists to end.
 *
 * Contract: node scripts/check-workflow-cadence.mjs
 *   env: GH_TOKEN or GITHUB_TOKEN (actions:read), GITHUB_REPOSITORY (owner/repo).
 * Exit 0 = every scheduled workflow ran within its own window. Exit 1 = one is overdue,
 * disabled, unreadable or unknown.
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WORKFLOW_DIR = process.env.WORKFLOW_DIR || path.join(HERE, '..', '.github', 'workflows')
const REPO = process.env.GITHUB_REPOSITORY || 'Predivo-GmbH/production-monitor'
export const OVERDUE_FACTOR = 3

/**
 * How often does this cron fire, in minutes? Only the shapes this fleet actually writes are
 * understood; anything else returns null, which is reported as unknown rather than guessed.
 */
export function intervalMinutes(expr) {
  const parts = String(expr).trim().split(/\s+/)
  if (parts.length !== 5) return null
  const [min, hour, dom, mon, dow] = parts
  if (dom !== '*' || mon !== '*') return null
  const every = /^\*\/(\d+)$/.exec(min)
  if (every && hour === '*' && dow === '*') return Number(every[1])
  if (/^\d+$/.test(min) && hour === '*' && dow === '*') return 60
  // A comma list of hours ('7 5,11 * * *'). What matters for "is it overdue" is the
  // LONGEST legitimate wait between two runs, not the average: 5,11 fires 6h apart and
  // then 18h apart, and calling that "every 12h" would make a perfectly normal overnight
  // gap look late. A single hour is just this with one entry, and still means 24h.
  if (/^\d+$/.test(min) && /^\d+(,\d+)*$/.test(hour) && dow === '*') {
    const hs = [...new Set(hour.split(',').map(Number))].sort((a, b) => a - b)
    if (hs.some((h) => h > 23)) return null
    let widest = 0
    for (let i = 0; i < hs.length; i++) {
      const next = i + 1 < hs.length ? hs[i + 1] : hs[0] + 24
      widest = Math.max(widest, next - hs[i])
    }
    return widest * 60
  }
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && /^\d+$/.test(dow)) return 60 * 24 * 7
  return null
}

/** Every cron in a workflow file. A file with none is not scheduled and is not our business. */
export function cronsIn(yamlText) {
  const out = []
  for (const m of String(yamlText).matchAll(/^\s*-\s*cron:\s*['"]?([^'"#\n]+?)['"]?\s*(?:#.*)?$/gm)) {
    out.push(m[1].trim())
  }
  return out
}

/**
 * The verdict for one workflow, pure so it can be tested without GitHub. `lastRunAt` null means
 * GitHub reported no scheduled run at all, which is never "fine, it just has not fired yet".
 */
export function verdictFor({ name, crons, state, lastRunAt, now }) {
  if (!crons.length) return null
  if (state && state !== 'active') {
    return { name, ok: false, why: `GitHub reports this workflow as ${state}, so its schedule is not firing` }
  }
  const mins = crons.map(intervalMinutes)
  if (mins.some((m) => m === null)) {
    return { name, ok: false, why: `cron shape not understood (${crons.join(', ')}), so nothing knows when it should run` }
  }
  const interval = Math.min(...mins)
  if (!lastRunAt) return { name, ok: false, why: 'GitHub reports no scheduled run at all for this workflow' }
  const ageMin = (now - new Date(lastRunAt).getTime()) / 60000
  const limit = interval * OVERDUE_FACTOR
  const every = interval >= 60 ? `${Math.round(interval / 60)}h` : `${interval}min`
  if (ageMin > limit) {
    return { name, ok: false, why: `last scheduled run ${Math.round(ageMin / 60)}h ago, expected every ${every} (past ${OVERDUE_FACTOR}x)` }
  }
  return { name, ok: true, why: `last scheduled run ${Math.round(ageMin)} min ago, expected every ${every}` }
}

/** Say what was covered. A count of what it happened to read is not a count of what exists. */
export function coverageLine(scheduled, judged) {
  return scheduled === judged
    ? `workflows: judged all ${scheduled} scheduled workflows`
    : `workflows: judged ${judged} of ${scheduled} scheduled workflows - the rest could not be read, which is not the same as fine`
}

async function gh(pathname, token) {
  const res = await fetch(`https://api.github.com${pathname}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'workflow-cadence/1.0',
    },
  })
  if (!res.ok) throw new Error(`GET ${pathname} -> HTTP ${res.status}`)
  return res.json()
}

/**
 * THE SAME QUESTION, ONE LAYER OUT: did the FLEET's scheduled workflows run? (added 2026-09-02)
 *
 * The per-repo half above reads this repo's cron files. It cannot help the rest of the fleet, and
 * the rest of the fleet has the same hole: pull-engine's weekly technical-floor gate carries a
 * heartbeat step guarded by `if [ -n "$HC_URL" ]` and the secret it reads, HC_PING_TECH_FLOOR,
 * does not exist in that repo - enumerated its 11 secrets on 2026-09-02, not searched for a name.
 * So that dead-man switch has never pinged anything, and if the gate stopped running nothing would
 * say so.
 *
 * The cadence is MEASURED rather than parsed here, deliberately: reading every fleet repo's YAML
 * would cost a content fetch per workflow and would still be a guess about what GitHub does with
 * it. The gap between a workflow's own last few scheduled runs is what it actually does. Overdue
 * is the same 3x rule the per-repo half uses, so one dropped tick is never an alarm.
 *
 * A workflow with fewer than three scheduled runs in its history is NOT judged - there is no
 * observed cadence to judge it against, and inventing one is how a checker starts reporting on a
 * window nobody chose.
 */
export function judgeObserved({ name, runs, now }) {
  const scheduled = (runs || []).map((r) => Date.parse(r.created_at)).filter(Number.isFinite).sort((a, b) => b - a)
  if (scheduled.length < 3) return null
  const gaps = []
  for (let i = 1; i < scheduled.length; i++) gaps.push(scheduled[i - 1] - scheduled[i])
  // The median gap, so one slow week does not redefine the cadence.
  const median = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)]
  const ageMin = (now - scheduled[0]) / 60000
  const limitMin = (median / 60000) * OVERDUE_FACTOR
  if (ageMin > limitMin) {
    return { name, ok: false, why: `last scheduled run ${Math.round(ageMin / 60)}h ago; its own recent cadence is about every ${Math.round(median / 3600000)}h (past ${OVERDUE_FACTOR}x)` }
  }
  return { name, ok: true, why: `last scheduled run ${Math.round(ageMin / 60)} min ago, cadence about every ${Math.round(median / 3600000)}h` }
}

async function fleetMode(token) {
  const { getFleet } = await import('../lib/fleet.mjs')
  const { fleet, source } = await getFleet()
  const repos = [...new Set(fleet.map((p) => p.repo).filter(Boolean))]
  console.log(`fleet workflows: reading ${repos.length} repo(s) from the ${source} fleet list`)

  const dead = []
  let judged = 0
  for (const repo of repos) {
    let listed
    try {
      listed = await gh(`/repos/${repo}/actions/workflows?per_page=100`, token)
    } catch (err) {
      dead.push({ name: repo, ok: false, why: `could not list its workflows (${err.message})` })
      continue
    }
    for (const wf of listed.workflows || []) {
      let runs = []
      try {
        const r = await gh(`/repos/${repo}/actions/workflows/${wf.id}/runs?per_page=5&event=schedule`, token)
        runs = r.workflow_runs || []
      } catch (err) {
        dead.push({ name: `${repo} / ${wf.name}`, ok: false, why: `could not read its runs (${err.message})` })
        continue
      }
      if (!runs.length) continue // never ran on a schedule: not a scheduled workflow, not our business
      if (wf.state && wf.state !== 'active') {
        dead.push({ name: `${repo} / ${wf.name}`, ok: false, why: `GitHub reports it as ${wf.state}, so its schedule is not firing` })
        continue
      }
      const v = judgeObserved({ name: `${repo} / ${wf.name}`, runs, now: Date.now() })
      if (!v) continue
      judged++
      if (!v.ok) dead.push(v)
    }
  }

  console.log(`fleet workflows: judged ${judged} scheduled workflow(s) across ${repos.length} repo(s)`)
  for (const d of dead) console.log(`  DEAD  ${d.name.padEnd(46)} ${d.why}`)
  if (dead.length) {
    console.error(`\nFAIL: ${dead.length} scheduled workflow(s) in the fleet are not running as scheduled.`)
    return 1
  }
  console.log('\nEvery scheduled workflow in the fleet has run inside its own observed cadence.')
  return 0
}

async function main() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  if (!token) {
    console.error('FAIL: no GH_TOKEN/GITHUB_TOKEN, so nothing could be checked')
    return 1
  }

  if (process.argv.includes('--fleet')) return fleetMode(token)

  const files = readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/.test(f))
  const scheduled = files
    .map((f) => ({ file: f, crons: cronsIn(readFileSync(path.join(WORKFLOW_DIR, f), 'utf8')) }))
    .filter((w) => w.crons.length)

  const listed = await gh(`/repos/${REPO}/actions/workflows?per_page=100`, token)
  const byFile = new Map((listed.workflows || []).map((w) => [path.basename(w.path), w]))

  const now = Date.now()
  const verdicts = []
  for (const w of scheduled) {
    const meta = byFile.get(w.file)
    if (!meta) {
      verdicts.push({ name: w.file, ok: false, why: 'GitHub does not list this workflow at all' })
      continue
    }
    let lastRunAt = null
    try {
      const runs = await gh(`/repos/${REPO}/actions/workflows/${meta.id}/runs?per_page=1&event=schedule`, token)
      lastRunAt = runs.workflow_runs && runs.workflow_runs[0] ? runs.workflow_runs[0].created_at : null
    } catch (err) {
      verdicts.push({ name: w.file, ok: false, why: `could not read its runs (${err.message})` })
      continue
    }
    verdicts.push(verdictFor({ name: w.file, crons: w.crons, state: meta.state, lastRunAt, now }))
  }

  console.log(coverageLine(scheduled.length, verdicts.length))
  for (const v of verdicts.filter(Boolean)) {
    console.log(`  ${v.ok ? 'OK  ' : 'DEAD'}  ${v.name.padEnd(32)} ${v.why}`)
  }

  const dead = verdicts.filter((v) => v && !v.ok)
  if (dead.length) {
    console.error(`\nFAIL: ${dead.length} scheduled workflow(s) are not running as scheduled: ${dead.map((d) => d.name).join(', ')}`)
    return 1
  }
  console.log('\nEvery scheduled workflow in this repo has run inside its own window.')
  return 0
}

const invoked = process.argv[1] && process.argv[1].endsWith('check-workflow-cadence.mjs')
if (invoked) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('FAIL:', err.message)
      process.exit(1)
    })
}
