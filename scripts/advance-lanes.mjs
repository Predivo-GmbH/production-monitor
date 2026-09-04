#!/usr/bin/env node
/**
 * THE THING THAT MAKES THE BOARD LIFT ITSELF.
 *
 * ══ WHY THIS EXISTS ═══════════════════════════════════════════════════════════════════════════
 *
 * Roger, 2026-09-04: *"what's really important for me is that this board still really lifts, and
 * it's orchestrated by you. You pick up the tasks, and you go through every step or every lane by
 * yourself, as far as you can, all the time, 24/7. You only ask me to do anything if it's really
 * needed."*
 *
 * `sql/101` gave the board eight lanes and a function, `lane_gate_unmet`, that answers ONE question
 * per row: is there a reason this row may not leave its lane, in plain English? This job reads that
 * answer and moves the rows whose reason is empty. Nothing else.
 *
 * ══ THE THREE RULES IT WILL NOT BREAK ═════════════════════════════════════════════════════════
 *
 * 1. **IT NEVER CROSSES THE LAST LANE.** `ready_for_release → done` is a promotion. For anything a
 *    customer touches that is Roger's, by his 2026-09-01 rule, and this job simply does not have a
 *    code path that performs it. Not a flag, not a guard — an absence.
 * 2. **IT NEVER MOVES A ROW OWED TO ROGER.** A row carrying a question for him waits for him
 *    whatever its gate says. Judging is not acting; the closer learned that distinction today.
 * 3. **IT ONLY EVER MOVES FORWARD ONE LANE.** A row that would satisfy three gates at once still
 *    advances one step per run, so every transition is separately visible in the evidence trail.
 *    A jump from Backlog to Ready-for-Release would be indistinguishable from a bug.
 *
 * ══ AND IT SAYS WHY IT DID NOT MOVE SOMETHING ═════════════════════════════════════════════════
 *
 * A run that moves nothing prints the reason for every row it looked at. "A job that reports
 * success for doing nothing is worse than one that fails" is a standing rule in this repository,
 * and a silent advancer would be exactly that.
 *
 * DRY BY DEFAULT. Set LANES_CONFIRM=1 to actually write, the same contract as the closer.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CLAUDE_CONFIG = join(homedir(), '.claude.json')

/** The track, in order. The last entry deliberately has no successor here. */
export const LANES = [
  'backlog', 'refined', 'todo', 'in_progress', 'in_review', 'in_testing', 'ready_for_release',
]

/**
 * The next lane a machine may move a row into, or null when it may not move it at all.
 *
 * `ready_for_release` returns null on purpose and that is rule 1: the promotion out of it is a
 * human decision for customer-facing products, so this function has nowhere to send it.
 */
export function nextLane(lane) {
  const i = LANES.indexOf(String(lane))
  if (i < 0) return null
  if (i === LANES.length - 1) return null
  return LANES[i + 1]
}

/** A row a machine may not touch, and the reason, or null when it is fair game. */
export function heldBack(row) {
  if (!row || typeof row !== 'object') return 'not a row'
  if (row.merged_into) return 'it was merged into another row'
  if (row.is_blocked) return 'it is blocked, and the block is what has to clear first'
  const owner = String(row.blocked_owner || '').trim().toLowerCase()
  if (owner === 'roger') return 'it is owed to Roger — judging is not acting, and this is his'
  if (String(row.blocked_question || '').trim()) return 'it asks Roger a question that is still open'
  if (!nextLane(row.lane)) {
    return row.lane === 'ready_for_release'
      ? 'it is ready for release, and releasing is a decision, not a step this job may take'
      : `nothing follows lane "${row.lane}"`
  }
  return null
}

/**
 * What this run would do to one row: { act: 'advance'|'leave', to?, reason }.
 * Pure, so the whole policy can be asserted without a database.
 */
export function planFor(row) {
  const held = heldBack(row)
  if (held) return { act: 'leave', reason: held }
  const gate = row.gate_unmet == null ? null : String(row.gate_unmet).trim()
  if (gate) return { act: 'leave', reason: gate }
  return { act: 'advance', to: nextLane(row.lane), reason: 'its gate is met and nothing holds it' }
}

/** Credentials are read INSIDE this process and never spoken about. Returns key NAMES only. */
export function loadBoardCredentials({ configPath = CLAUDE_CONFIG, read = readFileSync, env = process.env } = {}) {
  let cfg
  try { cfg = JSON.parse(read(configPath, 'utf-8')) } catch (e) {
    return { ok: false, reason: `could not read the MCP registration at ${configPath} (${e.code || e.message})` }
  }
  const found = cfg && cfg.mcpServers && cfg.mcpServers['cockpit-mcp'] && cfg.mcpServers['cockpit-mcp'].env
  if (!found) return { ok: false, reason: `${configPath} carries no mcpServers['cockpit-mcp'].env block` }
  const needed = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY']
  const absent = needed.filter((k) => !found[k])
  if (absent.length) return { ok: false, reason: `the registration is missing ${absent.join(' and ')}` }
  for (const [k, v] of Object.entries(found)) env[k] = v
  return { ok: true, applied: Object.keys(found) }
}

export function isDryRun(argv = process.argv, env = process.env) {
  if (argv.includes('--dry')) return true
  return !env.LANES_CONFIRM
}

/**
 * Most rows one run may move. A first real run must not walk the whole board unwatched.
 *
 * An EMPTY value is "unset", not zero. `Number('')` is 0, which is finite and non-negative, so the
 * obvious implementation silently caps an accidentally-blank `LANES_MAX=` at zero: the job then
 * runs, moves nothing, and exits successfully for ever. That is the "reports success for doing
 * nothing" failure this repository was built to catch, and its own test caught it here first.
 */
export function moveCap(env = process.env) {
  const raw = String(env.LANES_MAX ?? '').trim()
  if (!raw) return 25
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : 25
}

async function main() {
  const creds = loadBoardCredentials()
  if (!creds.ok) {
    console.error(`::error::the lane advancer could NOT run: ${creds.reason}. This is unknown, not fine.`)
    process.exit(2)
  }
  const dry = isDryRun()
  const max = moveCap()
  const url = process.env.SUPABASE_URL
  const H = { apikey: process.env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}` }

  // Paged: PostgREST silently caps at 1000 rows however large a limit is asked for, and a capped
  // read looks exactly like a complete one.
  let rows = [], from = 0
  for (;;) {
    const r = await fetch(`${url}/rest/v1/work_track?select=*&order=lane_rank.asc&limit=1000&offset=${from}`, { headers: H })
    if (!r.ok) { console.error(`::error::could not read the track (HTTP ${r.status})`); process.exit(2) }
    const page = await r.json()
    rows = rows.concat(page)
    if (page.length < 1000) break
    from += 1000
  }

  const open = rows.filter((r) => !['done', 'abandoned'].includes(r.lane))
  console.log(`  track: ${rows.length} row(s) read, ${open.length} still on the move`)

  const plans = open.map((r) => ({ row: r, plan: planFor(r) }))
  const moving = plans.filter((p) => p.plan.act === 'advance')
  const staying = plans.filter((p) => p.plan.act === 'leave')

  const why = {}
  for (const s of staying) why[s.plan.reason] = (why[s.plan.reason] || 0) + 1
  console.log(`  ${moving.length} row(s) may advance; ${staying.length} stay put, and here is every reason:`)
  for (const [reason, n] of Object.entries(why).sort((a, b) => b[1] - a[1])) {
    console.log(`     ${String(n).padStart(4)}  ${reason}`)
  }

  let moved = 0
  for (const { row, plan } of moving.slice(0, max)) {
    console.log(`     ${dry ? 'would move' : 'MOVED'}  ${row.slug}: ${row.lane} -> ${plan.to}`)
    if (dry) continue
    const res = await fetch(`${url}/rest/v1/work_items?id=eq.${row.id}`, {
      method: 'PATCH',
      headers: { ...H, 'content-type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ lane: plan.to }),
    })
    if (res.status === 204) moved++
    else console.log(`     FAILED   ${row.slug}: HTTP ${res.status}`)
  }
  if (moving.length > max) console.log(`  LANES_MAX=${max} reached: ${moving.length - max} left for the next run`)

  const verdict = moving.length === 0
    ? `nothing could advance: every one of ${staying.length} row(s) has a stated reason above`
    : dry ? `DRY RUN: ${moving.length} row(s) would advance, nothing was written`
          : `${moved} row(s) advanced one lane`
  console.log(`::notice::${verdict}`)
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('advance-lanes.mjs')) {
  main().catch((e) => { console.error(`::error::the lane advancer threw: ${e.message}`); process.exit(2) })
}
