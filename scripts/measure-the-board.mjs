#!/usr/bin/env node
/**
 * IS THE WORK BOARD ACTUALLY GETTING BETTER? The weekly measurement, run by a machine.
 *
 * -- WHY THIS EXISTS -------------------------------------------------------------------------
 *
 * The work-board requirement (standards/REQUIREMENT-how-the-work-board-is-built-and-worked,
 * §9) lists the gates that decide whether the whole rebuild worked. Every one of them was prose.
 * A measure nobody runs is a wish, and this house has a standing rule that a rule without an
 * enforcement point gets violated the day it is written.
 *
 * The baseline it is measured against, taken from the live board on 2026-09-03:
 *   219 open - 46.9 opened/day, 32.1 closed/day, net +14.8/day over 14 days
 *   111 of 219 machine-raised - 84 of 219 carrying a finish-test - 75 still `unjudged`
 *
 * -- WHY EACH GATE HAS AN ANTI-GAMING COMPANION ----------------------------------------------
 *
 * Every number here is trivially improvable by doing the wrong thing. "The board shrinks" is won
 * by switching the producers off. "Debt ages down" is won by mass-merging the old rows. So a gate
 * that can be gamed carries a second number that moves the opposite way when it is, and BOTH are
 * printed. The companion is not a pass/fail of its own; it is the context that makes the headline
 * honest.
 *
 * -- THREE ANSWERS, NEVER TWO ----------------------------------------------------------------
 *
 * pass / fail / unknown, per scripts/lib/check-verdict.mjs. A gate that cannot see what it judges
 * says `unknown` and never `pass`. Two gates are `unknown` BY CONSTRUCTION today and say so
 * loudly rather than quietly reporting green:
 *   - "work is batched" -- there is no batch column on work_items yet, so nothing can be counted.
 *   - "nothing is fictional" -- only rows the closer has actually evaluated carry a
 *     done_check_result, so an unevaluated row is not evidence of honesty.
 * Reporting either as a pass would be the exact failure this repo exists to catch.
 *
 * Read-only. It never closes, moves, grades or edits a row.
 *
 *   node scripts/measure-the-board.mjs            print the measurement
 *   node scripts/measure-the-board.mjs --json     machine-readable
 */
import { readFileSync } from 'fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { sayVerdict, PASS, FAIL, UNKNOWN } from './lib/check-verdict.mjs'

// RESOLVED, NEVER HARDCODED. This was 'C:/Users/roger_rwjnmnz/.claude.json' and the job failed
// on its very first real run: it is scheduled on LAPTOP-88N97BGG, where the user is
// `roger_spfi4lz` and that path does not exist. The task reported LastTaskResult 1 and the
// script said honestly that it could not read the board registration -- which is the only reason
// this was caught rather than becoming a weekly job that quietly never measured anything.
// close-finished-items.mjs had it right all along: join(homedir(), '.claude.json').
const CLAUDE_CONFIG = join(homedir(), '.claude.json')
const WINDOW_DAYS = Number(process.env.BOARD_WINDOW_DAYS || 14)
const DAY = 86_400_000

/** Credentials are read INSIDE the process and never printed, logged or passed on a command line. */
export function loadBoardCredentials({ configPath = CLAUDE_CONFIG, read = readFileSync, env = process.env } = {}) {
  let raw
  try { raw = JSON.parse(read(configPath, 'utf8')) } catch (e) { return { ok: false, why: `could not read the board registration (${e.code || e.message})` } }
  const found = raw?.mcpServers?.['cockpit-mcp']?.env || {}
  for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY']) {
    if (!found[k]) return { ok: false, why: `the board registration is missing ${k}` }
    env[k] = found[k]
  }
  return { ok: true }
}

// ── the pure core: every judgement below is a function of rows, so it is testable offline ─────

const isOpen = (r) => !['done', 'abandoned'].includes(r.status)
const owedToRoger = (r) => String(r.blocked_owner || '').toLowerCase() === 'roger'
  || (r.status === 'blocked' && Boolean(String(r.blocked_question || '').trim()))
const ageDays = (iso, now) => (now - Date.parse(iso)) / DAY

/**
 * THE BOARD SHRINKS -- closed/day must exceed opened/day.
 * Companion: intake. If the producers were switched off, the ratio improves while nothing got
 * better, so the opened/day is printed beside it and a COLLAPSE in intake is called out.
 */
export function gateBoardShrinks({ opened, closed, days, baselineOpenedPerDay = 46.9 }) {
  if (!days || !Number.isFinite(opened) || !Number.isFinite(closed)) {
    return { name: 'The board shrinks', state: UNKNOWN, detail: 'the open/close counts could not be read' }
  }
  const inPerDay = opened / days
  const outPerDay = closed / days
  const net = inPerDay - outPerDay
  // A drop to under half the baseline intake is suppression, not success.
  const suppressed = inPerDay < baselineOpenedPerDay / 2
  return {
    name: 'The board shrinks',
    state: outPerDay > inPerDay && !suppressed ? PASS : FAIL,
    detail: `${opened} in / ${closed} out over ${days} days = ${inPerDay.toFixed(1)} vs ${outPerDay.toFixed(1)} per day, net ${net >= 0 ? '+' : ''}${net.toFixed(1)}/day`,
    companion: suppressed
      ? `INTAKE COLLAPSED to ${inPerDay.toFixed(1)}/day against a ${baselineOpenedPerDay}/day baseline — a shrinking board means nothing if the producers stopped filing`
      : `intake ${inPerDay.toFixed(1)}/day against a ${baselineOpenedPerDay}/day baseline — not suppressed`,
  }
}

/**
 * DEBT AGES DOWN -- the oldest open row must not keep getting older.
 * Companion: how many rows were merged away in the window. Mass-merging old rows improves this
 * number without anyone finishing anything.
 */
export function gateDebtAgesDown({ open, merged, now }) {
  if (!open.length) return { name: 'Debt ages down', state: PASS, detail: 'nothing is open' }
  const oldest = Math.max(...open.map((r) => ageDays(r.opened_at, now)))
  return {
    name: 'Debt ages down',
    // No trend is available on a single run; the number is the record the NEXT run compares to.
    state: UNKNOWN,
    detail: `oldest open row is ${oldest.toFixed(0)} days old — a trend needs a previous run to compare with`,
    companion: `${merged} row(s) merged in the window — mass-merging is how this number is gamed`,
    value: Number(oldest.toFixed(1)),
  }
}

/** ROWS ARE WORKABLE -- a declared row owes a finish-test. Machine rows derive theirs, so exempt. */
export function gateRowsWorkable({ open }) {
  const declared = open.filter((r) => r.source === 'declaration')
  const missing = declared.filter((r) => !r.done_when)
  return {
    name: 'Rows are workable',
    state: missing.length === 0 ? PASS : FAIL,
    detail: `${missing.length} of ${declared.length} declared row(s) state no finish-test`,
  }
}

/**
 * WEIGHT IS REAL -- nothing critical may sit for more than 48 hours.
 * Companion: the critical SHARE of rows opened in the window. The ceiling has a documented
 * critical bypass, so an inflated share means the bypass is being used as a routine door.
 */
export function gateWeightIsReal({ open, openedInWindow, now, maxCriticalHours = 48, maxShare = 0.2 }) {
  const crit = open.filter((r) => r.priority === 'critical')
  const stale = crit.filter((r) => ageDays(r.opened_at, now) * 24 > maxCriticalHours)
  const newCrit = openedInWindow.filter((r) => r.priority === 'critical').length
  const share = openedInWindow.length ? newCrit / openedInWindow.length : 0
  return {
    name: 'Weight is real',
    state: stale.length === 0 ? PASS : FAIL,
    detail: `${stale.length} critical row(s) older than ${maxCriticalHours}h, of ${crit.length} open critical`,
    companion: share > maxShare
      ? `CRITICAL SHARE ${(share * 100).toFixed(0)}% of rows opened in the window — above ${(maxShare * 100).toFixed(0)}%, the bypass is being used as a routine door`
      : `critical share ${(share * 100).toFixed(0)}% of new rows — within ${(maxShare * 100).toFixed(0)}%`,
  }
}

/** HIS LANE IS HONEST -- a row owed to Roger that states no question asks him for nothing. */
export function gateHisLaneIsHonest({ open }) {
  const his = open.filter(owedToRoger)
  const silent = his.filter((r) => !String(r.blocked_question || '').trim())
  return {
    name: 'His lane is honest',
    state: silent.length === 0 ? PASS : FAIL,
    detail: `${silent.length} of ${his.length} row(s) owed to Roger state no question`,
  }
}

/** HIS LANE IS SMALL -- no row may wait on him for more than a week. */
export function gateHisLaneIsSmall({ open, now, maxWaitDays = 7 }) {
  const his = open.filter(owedToRoger)
  if (!his.length) return { name: 'His lane is small', state: PASS, detail: 'nothing is waiting on him' }
  const waiting = his.filter((r) => ageDays(r.state_since || r.opened_at, now) > maxWaitDays)
  return {
    name: 'His lane is small',
    state: waiting.length === 0 ? PASS : FAIL,
    detail: `${his.length} row(s) in his lane, ${waiting.length} waiting longer than ${maxWaitDays} days`,
  }
}

/**
 * NOTHING IS FICTIONAL -- no row may state a check that cannot be executed.
 * UNKNOWN by construction while coverage is partial: only rows the closer has actually evaluated
 * carry a done_check_result, and an unevaluated row proves nothing either way.
 */
export function gateNothingIsFictional({ open }) {
  const withTest = open.filter((r) => r.done_when)
  const evaluated = withTest.filter((r) => r.done_check_result)
  const unrunnable = evaluated.filter((r) => r.done_check_result === 'unknown')
  if (evaluated.length < withTest.length) {
    return {
      name: 'Nothing is fictional',
      state: UNKNOWN,
      detail: `only ${evaluated.length} of ${withTest.length} stated check(s) have ever been evaluated — the rest are unproven either way`,
      companion: `${unrunnable.length} of the ${evaluated.length} evaluated could not be executed`,
    }
  }
  return {
    name: 'Nothing is fictional',
    state: unrunnable.length === 0 ? PASS : FAIL,
    detail: `${unrunnable.length} of ${evaluated.length} stated check(s) cannot be executed`,
  }
}

/** WORK IS BATCHED -- not measurable until rows carry a batch. Says so; never reports a pass. */
export function gateWorkIsBatched({ hasBatchColumn = false }) {
  if (!hasBatchColumn) {
    return {
      name: 'Work is batched',
      state: UNKNOWN,
      detail: 'work_items carries no batch column yet, so nothing can be counted — this gate cannot pass or fail until batching is built',
    }
  }
  return { name: 'Work is batched', state: UNKNOWN, detail: 'not implemented' }
}

export function measureBoard({ rows = [], openedInWindow = [], closedInWindow = [], merged = 0, days = WINDOW_DAYS, now = Date.now(), hasBatchColumn = false } = {}) {
  const open = rows.filter(isOpen)
  const gates = [
    gateBoardShrinks({ opened: openedInWindow.length, closed: closedInWindow.length, days }),
    gateDebtAgesDown({ open, merged, now }),
    gateRowsWorkable({ open }),
    gateWorkIsBatched({ hasBatchColumn }),
    gateWeightIsReal({ open, openedInWindow, now }),
    gateHisLaneIsSmall({ open, now }),
    gateHisLaneIsHonest({ open }),
    gateNothingIsFictional({ open }),
  ]
  const failed = gates.filter((g) => g.state === FAIL)
  const unknown = gates.filter((g) => g.state === UNKNOWN)
  return {
    gates,
    open: open.length,
    headline: failed.length
      ? `${failed.length} of ${gates.length} board gate(s) FAIL (${unknown.length} cannot be judged yet): ${failed.map((g) => g.name).join(', ')}`
      : `every measurable board gate passes (${unknown.length} of ${gates.length} cannot be judged yet)`,
    state: failed.length ? FAIL : (unknown.length ? UNKNOWN : PASS),
  }
}

// ── the run ───────────────────────────────────────────────────────────────────────────────────

async function boardGet(path) {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: process.env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}` },
  })
  if (!res.ok) throw new Error(`board read ${res.status}: ${(await res.text()).slice(0, 160)}`)
  return res.json()
}

async function main() {
  const cred = loadBoardCredentials()
  if (!cred.ok) {
    sayVerdict(UNKNOWN, `the board measurement could NOT run: ${cred.why}. This is unknown, not fine.`)
    return 1
  }
  const since = new Date(Date.now() - WINDOW_DAYS * DAY).toISOString()
  const [rows, openedInWindow, closedInWindow, mergedRows] = await Promise.all([
    boardGet('work_items?select=slug,status,priority,source,opened_at,state_since,blocked_owner,blocked_question,done_when,done_check_result&limit=5000'),
    boardGet(`work_items?opened_at=gte.${since}&select=priority&limit=5000`),
    boardGet(`work_items?closed_at=gte.${since}&select=slug&limit=5000`),
    boardGet(`work_items?merged_into=not.is.null&select=slug&limit=5000`).catch(() => []),
  ])

  const m = measureBoard({
    rows, openedInWindow, closedInWindow, merged: mergedRows.length, days: WINDOW_DAYS,
  })

  console.log(`\nTHE WORK BOARD, measured over ${WINDOW_DAYS} days — ${m.open} open\n`)
  for (const g of m.gates) {
    console.log(`  ${String(g.state).toUpperCase().padEnd(7)} ${g.name}: ${g.detail}`)
    if (g.companion) console.log(`          ^ ${g.companion}`)
  }
  console.log()
  if (process.argv.includes('--json')) console.log(JSON.stringify(m, null, 2))
  sayVerdict(m.state, m.headline)
  // A filed measurement exits 0 whatever it found: only an unreadable board is this job failing.
  return 0
}

if (import.meta.url === (await import('url')).pathToFileURL(process.argv[1] || '').href) {
  main().then(
    (code) => { process.exitCode = code },
    (e) => {
      sayVerdict(UNKNOWN, `the board measurement could NOT run (${e.message}). This is unknown, not fine.`)
      process.exitCode = 1
    },
  )
}
