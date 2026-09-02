#!/usr/bin/env node
/**
 * Does the robot that fixes the fleet actually still fix anything?
 *
 * WHY (2026-08-24, the incident this script is named after): the board drainer ran on schedule
 * for 30 hours and fixed NOTHING. Three permanently-stuck items consumed the entire per-run
 * blast-radius budget every run, so 34 other incidents sat behind them untouched. Every alarm
 * we owned asked "did it run?" — and it did, every time, so nothing ever went red. Roger found
 * it by reading the board himself.
 *
 * Liveness cannot see a loop that is alive and stuck. So this asserts four separate things:
 *
 *   1. STOPPED  — no run heartbeat at all, or the newest one is older than DRAINER_STALE_MIN,
 *                 OR the newest run ERRORED (runStats.error set). The drainer publishes a
 *                 heartbeat on EVERY run, including one that crashed; see writeRunHeartbeat in
 *                 board-drainer.mjs. A crashed read is a stopped fixer, never a clean board.
 *   2. STALLED  — runs are happening, work IS dispatchable, and yet nothing has been dispatched
 *                 for DRAINER_STALL_HOURS. That is the 30-hour failure, stated as an invariant.
 *   3. DISABLED — the run was skipped by the kill switch or the wired-but-off gate (runStats.skipped
 *                 set). A switch left on looks byte-identical to a clean board; it is not-ok.
 *   4. GIVEN UP  — the drainer has PARKED most of the board. Parked means it tried, hit the
 *                 attempt ceiling, and will never pick that item up again. See below.
 *
 * -- ASSERTION 4, AND WHY THE FIRST THREE WERE NOT ENOUGH (2026-09-01) -----------------------
 *
 * This file used to say, in this exact spot:
 *
 *     "A parked item is NOT dispatchable and never counts: parking is a deliberate suppression
 *      the drainer announces every run. The alarm fires on work the drainer is allowed to take
 *      and is not taking."
 *
 * That sentence let the drainer mark its own homework. `dispatchable` is a number the DRAINER
 * computes, after removing everything it has decided to stop trying. So the drainer could give
 * up on the entire board and this alarm would read green, because a board with nothing left to
 * dispatch and a board that is genuinely clean produce identical numbers.
 *
 * It was not hypothetical. Fed the LIVE heartbeat of 2026-09-01 18:08 —
 *     considered 38, dispatchable 1, dispatched 1, PARKED 36
 * — judgeDrainer returned `ok`, "The fleet auto-fixer is working". Thirty-six findings that no
 * machine will ever work again, and every alarm we owned said fine.
 *
 * This is the 2026-08-24 incident in its second costume. Then, three permanently-stuck items ate
 * the whole per-run budget and 34 incidents sat untouched behind them; the fix taught this script
 * to ask "is dispatchable work being dispatched?". The drainer now parks the stuck ones instead
 * of retrying them forever — which is the right behaviour — and the same 34 incidents sit
 * untouched on the other side of the same green alarm. The outcome never changed: incidents pile
 * up, the alarm reads green, Roger finds it by reading the board himself.
 *
 * PARKING IS NOT WRONG. Giving up QUIETLY is. A parked item is precisely an item the machine has
 * declared it cannot fix, so it is the one class that most needs a person told — and parked items
 * carry needs_human=false, so nothing pages and nothing reaches the work board either. They exist
 * only on a web page, and a web page is PULL.
 *
 * The threshold is a SHARE, not a count, so it scales with the board and cannot be tuned away by
 * a quiet week: parking is normal, parking most of the board is the fixer having stopped.
 *
 * Read-only against the board; the alarm itself is filed through signal-intake, so the page
 * policy, the self-heal window and the dedup all apply to it like any other signal.
 *
 * Contract:  node scripts/check-drainer-progress.mjs
 *   env: BOARD_SUPABASE_SECRET (or the BackOffice Credentials.txt path, same as the drainer)
 *        DRAINER_STALE_MIN   (default 180)
 *        DRAINER_STALL_HOURS (default 6)
 * Exit 0 = healthy or alarm filed successfully. Exit 1 = could not tell, which is never "fine".
 */
import { readFileSync } from 'fs'

const BO_REF = 'xoecpzfsskalvjrtcbbl'
const BO_BASE = `https://${BO_REF}.supabase.co`
const BO_CREDS = 'C:\\Business\\Internal Projects\\BackOffice\\docs\\Credentials.txt'
const NON_BROWSER_UA = 'drainer-progress-check/1.0'
const ALARM_KEY = 'stalled'

const STALE_MIN = Number(process.env.DRAINER_STALE_MIN || 180)
const STALL_HOURS = Number(process.env.DRAINER_STALL_HOURS || 6)
// Both must hold before "given up" fires. The FLOOR stops a two-item board reading as a crisis
// (1 of 2 parked is 50% and means nothing); the SHARE is what makes the rule un-tunable by a
// quiet week. At the 2026-09-01 measurement, 36 of 38 = 95%.
const PARK_FLOOR = Number(process.env.DRAINER_PARK_FLOOR || 5)
const PARK_SHARE = Number(process.env.DRAINER_PARK_SHARE || 0.5)

function readBoSecret() {
  // In CI this is the repo secret BACKOFFICE_SERVICE_ROLE_KEY (the same one factory-heartbeat
  // uses hourly); on the drainer's own box it falls back to the file, like the drainer itself.
  // The check must NOT live on that box only: an alarm hosted by the thing it watches dies with it.
  if (process.env.BOARD_SUPABASE_SECRET) return process.env.BOARD_SUPABASE_SECRET.trim()
  if (process.env.BACKOFFICE_SERVICE_ROLE_KEY) return process.env.BACKOFFICE_SERVICE_ROLE_KEY.trim()
  const txt = readFileSync(BO_CREDS, 'utf-8')
  const m = txt.match(/sb_secret_[A-Za-z0-9_]+/)
  if (!m) throw new Error(`no sb_secret_ key found in ${BO_CREDS}`)
  return m[0]
}

const minsSince = (iso, now) => (iso ? Math.round((now - new Date(iso).getTime()) / 60000) : null)

/**
 * The whole decision, pure and testable. `heartbeat` is the fleet_signals row (or null when the
 * drainer has never reported). Never returns 'ok' for an input it could not interpret.
 */
export function judgeDrainer({
  heartbeat, now = Date.now(), staleMin = STALE_MIN, stallHours = STALL_HOURS,
  parkFloor = PARK_FLOOR, parkShare = PARK_SHARE,
}) {
  if (!heartbeat) {
    return {
      verdict: 'stopped',
      severity: 'critical',
      title: 'The fleet auto-fixer has never reported a run',
      summary: 'No board-drainer heartbeat exists at all. Nothing is fixing incidents automatically, and nothing would tell you.',
    }
  }

  const age = minsSince(heartbeat.last_seen_at, now)
  if (age === null || Number.isNaN(age)) {
    return {
      verdict: 'stopped',
      severity: 'critical',
      title: 'The fleet auto-fixer heartbeat is unreadable',
      summary: `last_seen_at is not a usable timestamp (${String(heartbeat.last_seen_at)}), so its liveness cannot be established. Unknown is not healthy.`,
    }
  }
  if (age > staleMin) {
    return {
      verdict: 'stopped',
      severity: 'critical',
      title: 'The fleet auto-fixer has stopped running',
      summary: `Last board-drainer run was ${Math.round(age / 60)}h ago (threshold ${Math.round(staleMin / 60)}h). Incidents are no longer being worked automatically.`,
    }
  }

  const detail = heartbeat.detail || {}

  // A run that THREW still publishes a heartbeat, with runStats.error set on the failure path
  // (board-drainer.mjs) precisely so a dead run is visible. If the board read starts throwing
  // every run (rotated service-role secret, PostgREST 500), incidents pile up unworked — that is
  // a stopped fixer, not a clean board, and must go red. Reading only liveness here was the bug
  // this alarm was itself built to never make (see the header: never 'ok' for an uninterpretable input).
  if (detail.error) {
    return {
      verdict: 'stopped',
      severity: 'critical',
      title: 'The fleet auto-fixer crashed on its last run',
      summary: `The last board-drainer run errored and fixed nothing: ${String(detail.error).slice(0, 200)}. Incidents are no longer being worked automatically until this is resolved.`,
    }
  }

  // The kill switch (BOARD_DRAINER_DISABLED=1) and the wired-but-off gate (BOARD_DRAINER_ENABLED!=1)
  // both make main() return early, yet a heartbeat is still written with considered=0/dispatchable=0
  // — byte-identical to a genuinely clean board. A switch LEFT ON is exactly the "incidents pile up
  // and the alarm reads green" failure this script exists to catch, so a run that never looked is
  // not-ok, not clean. board-drainer.mjs stamps runStats.skipped on those early returns.
  if (detail.skipped) {
    return {
      verdict: 'disabled',
      severity: 'warning',
      title: 'The fleet auto-fixer is switched off',
      summary: `The board-drainer did not look at the board this run because it is switched off (${String(detail.skipped)}). Nothing is being fixed automatically; if this switch was left on, incidents are piling up unseen.`,
    }
  }

  // AN ABSENT `dispatchable` IS NOT ZERO (2026-09-01 audit), for exactly the reason the parked
  // counter below is not read as zero either: "the drainer stopped reporting how much work is
  // waiting" is not evidence that none is. `Number(x || 0)` turned a renamed field, a heartbeat
  // from an older drainer, or a run that died before it counted, into "no work waiting" - the one
  // value that makes the stall test on the next line unreachable. Measured before changing this:
  // the live heartbeat carries dispatchable, dispatched, started_at and last_dispatch_at, so an
  // absence really does mean something is wrong.
  const raw = detail.dispatchable
  if (raw === undefined || raw === null || !Number.isFinite(Number(raw))) {
    return {
      verdict: 'unknown',
      severity: 'warning',
      title: 'The fleet auto-fixer stopped saying how much work is waiting',
      summary: `The last board-drainer run published no usable count of dispatchable work (${String(raw)}), so whether it is working the board cannot be established. Unknown is not healthy, and the stall alarm cannot fire without this number.`,
    }
  }
  const dispatchable = Number(raw)
  const sinceDispatch = minsSince(detail.last_dispatch_at, now)

  // THE STALL CLOCK MUST NOT BE ONE THE DRAINER CAN RESTART. `last_dispatch_at` comes from a local
  // state file, and board-drainer.mjs seeds it to now whenever that file holds no value - which
  // includes every run after the file is deleted, moved with the machine, or left unparseable,
  // because loadState() swallows the parse error and returns a fresh-looking object. A drainer
  // that has dispatched nothing for a week then reports a dispatch "0 minutes ago" on every run
  // and the test below can never fire. A clock stamped inside THIS run by a run that dispatched
  // nothing was seeded, not earned.
  const seededThisRun = detail.started_at && detail.last_dispatch_at
    && Number(detail.dispatched || 0) === 0
    && Date.parse(detail.last_dispatch_at) >= Date.parse(detail.started_at)
  if (dispatchable > 0 && seededThisRun) {
    return {
      verdict: 'unknown',
      severity: 'warning',
      title: 'The fleet auto-fixer restarted its own progress clock',
      summary: `${dispatchable} incident(s) are waiting, none was picked up this run, and yet the last-pickup time is stamped inside this very run - so the drainer's local memory was missing or unreadable and it re-seeded the clock. While that keeps happening the stall alarm can never fire.`,
    }
  }
  if (dispatchable > 0 && (sinceDispatch === null || sinceDispatch > stallHours * 60)) {
    const howLong = sinceDispatch === null ? 'ever' : `${Math.round(sinceDispatch / 60)}h`
    return {
      verdict: 'stalled',
      severity: 'critical',
      title: 'The fleet auto-fixer is running but fixing nothing',
      summary: `${dispatchable} incident(s) are dispatchable and none has been picked up ${sinceDispatch === null ? 'ever' : `for ${howLong}`} (threshold ${stallHours}h). This is the 2026-08-24 failure: the loop is alive and stuck, so a liveness check reads green.`,
    }
  }

  // GIVEN UP. Deliberately AFTER the stall test, so a drainer that is both stalled and parked-out
  // reports the stall — that is the more actionable of the two. Read from the drainer's own
  // `parked` counter, which it publishes every run; an ABSENT counter is not read as zero,
  // because "the drainer stopped reporting how much it abandoned" is not evidence that it
  // abandoned nothing. That is the could-not-tell-reported-as-fine shape this file exists to
  // avoid, so it is graded as unknown below rather than folded into ok.
  const considered = Number(detail.considered || 0)
  const parkedRaw = detail.parked
  if (parkedRaw === undefined || parkedRaw === null) {
    if (considered > 0) {
      return {
        verdict: 'unknown',
        severity: 'warning',
        title: 'The fleet auto-fixer stopped saying how much it has given up on',
        summary: `The last run considered ${considered} incident(s) but published no parked count, so how much of the board has been abandoned cannot be established. Unknown is not healthy.`,
      }
    }
  } else {
    const parked = Number(parkedRaw)
    if (parked >= parkFloor && considered > 0 && parked / considered >= parkShare) {
      const pct = Math.round((parked / considered) * 100)
      return {
        verdict: 'given-up',
        severity: 'critical',
        title: 'The fleet auto-fixer has given up on most of the board',
        summary: `${parked} of ${considered} incidents (${pct}%) are PARKED: the auto-fixer tried them, hit its attempt ceiling and will not pick them up again. Parked findings carry needs_human=false, so nothing alerts on them and they never reach the work board either — they exist only on the /signals page. These need a person, and until now the alarm reported "the fleet auto-fixer is working" because parked items were excluded from the count the alarm looked at.`,
      }
    }
  }

  return {
    verdict: 'ok',
    severity: 'info',
    title: 'The fleet auto-fixer is working',
    summary: `Last run ${age}m ago; ${dispatchable} dispatchable, last dispatch ${sinceDispatch === null ? 'never' : `${sinceDispatch}m ago`}; ${Number(parkedRaw || 0)} of ${considered} parked.`,
  }
}

async function boGet(secret, path) {
  const res = await fetch(`${BO_BASE}/rest/v1/${path}`, {
    headers: { apikey: secret, Authorization: `Bearer ${secret}`, 'User-Agent': NON_BROWSER_UA },
  })
  if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.json()
}

async function fileSignal(secret, body) {
  const res = await fetch(`${BO_BASE}/functions/v1/signal-intake`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', 'User-Agent': NON_BROWSER_UA },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`signal-intake -> HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.json()
}

async function main() {
  const secret = readBoSecret()
  // --dry reads and judges but writes nothing. Used to prove the check against the LIVE board
  // without filing an alarm — the first run after deploy happens before the drainer has ever
  // written a heartbeat, and a check whose debut is a false alarm gets switched off.
  const dry = process.argv.includes('--dry')

  const [heartbeat] = await boGet(secret, 'fleet_signals?source=eq.board-drainer&key=eq.run&select=last_seen_at,detail&limit=1')
  const judgement = judgeDrainer({ heartbeat: heartbeat || null })
  console.log(`drainer: ${judgement.verdict} — ${judgement.summary}`)

  if (dry) { console.log('--dry: nothing written.'); return judgement.verdict === 'ok' ? 0 : 0 }

  const [existingAlarm] = await boGet(
    secret,
    `fleet_signals?source=eq.board-drainer&key=eq.${ALARM_KEY}&select=id,state&limit=1`,
  )

  if (judgement.verdict === 'ok') {
    // Only write on a TRANSITION. Re-posting "resolved" every hour would keep re-stamping a
    // row that already says the same thing, and the cockpit's "self-resolved in 24h" tile
    // counts resolutions — an alarm that resolves itself hourly is a lie about how often
    // something broke.
    if (existingAlarm && existingAlarm.state !== 'resolved') {
      await fileSignal(secret, {
        source: 'board-drainer', key: ALARM_KEY, kind: 'incident', severity: 'info',
        state: 'resolved', title: judgement.title, summary: judgement.summary,
        link: 'https://cockpit.predivo.ch/signals',
      })
      console.log('alarm cleared (the drainer is dispatching again).')
    }
    return 0
  }

  await fileSignal(secret, {
    source: 'board-drainer',
    key: ALARM_KEY,
    kind: 'incident',
    severity: judgement.severity,
    state: 'open',
    needs_human: true,
    title: judgement.title,
    summary: judgement.summary,
    detail: { verdict: judgement.verdict, heartbeat: heartbeat || null, checked_at: new Date().toISOString() },
    link: 'https://cockpit.predivo.ch/signals',
  })
  console.error(`::error::${judgement.title} — ${judgement.summary}`)
  return 0
}

// Set exitCode rather than process.exit(): on Windows, exiting while an undici handle is still
// closing aborts the process and reports 127, and an alarm with an ambiguous exit status is the
// exact failure class this script exists to catch.
if (import.meta.url === (await import('url')).pathToFileURL(process.argv[1] || '').href) {
  main().then(
    (code) => { process.exitCode = code },
    (e) => {
      // Could not read the board = could not tell. That is never reported as healthy.
      console.error(`::error::drainer progress check could NOT run (${e.message}). This is unknown, not fine.`)
      process.exitCode = 1
    },
  )
}
