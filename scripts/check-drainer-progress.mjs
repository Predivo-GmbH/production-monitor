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
 * -- ASSERTION 5, AND WHY ASSERTION 4 WAS STILL THE DRAINER MARKING ITS OWN HOMEWORK (2026-09-02)
 *
 * Assertion 4 fixed the NUMERATOR (parked items now count) and left the DENOMINATOR exactly where
 * it was: `considered`, a number the drainer computes AFTER discarding every signal it has decided
 * it cannot write to. `readBoard()` in board-drainer.mjs ends with
 *
 *     return rows.filter(workableFinding)
 *
 * because the write still goes to `monitoring_incidents`, whose `source` CHECK accepts only six
 * values. Everything else is logged as HELD BACK and dropped before `considered` is taken.
 *
 * -- THAT FILTER WAS REMOVED THE SAME DAY (2026-09-02) ----------------------------------------
 *
 * The paragraph above is kept because it is the history of this assertion, not because it is still
 * true. `readBoard()` now filters on `workableFinding`, a DENY list of rows that are not findings
 * (the work board itself, the drainer's own heartbeat, drills, delivery receipts) — the write-target
 * constraint stopped applying on 2026-09-01 when migration 142 made `upsert_incident` an adapter
 * onto `upsert_signal`. Out-of-reach therefore drops to the non-finding sources only, which is the
 * true statement; the assertion is UNCHANGED and still recomputes the population itself, so it goes
 * red again the moment a filter of any shape starts hiding findings.
 *
 * Measured live 2026-09-02 20:04Z:
 *
 *     active signals on the board (open/acknowledged)   42
 *     the drainer even LOOKS at                         11   <- `considered`
 *     held back, never classified, never tried          31
 *     of those held back, not on the work board         ~12
 *     parked by the drainer's own count                  9
 *     rows publishing detail.parked = true               2   <- the page can name 2 of the 9
 *
 * So the 82%-parked alarm was measuring nine abandoned findings against a board of eleven, while
 * thirty-one others were not in the sum at all — the same shape as the bug assertion 4 removed,
 * one layer out. NEVER TRIED IS WORSE THAN GIVEN UP, and it was the quieter of the two.
 *
 * THE RULE THIS FILE NOW ENFORCES: the denominator is the BOARD, and the numerator is everything
 * NOBODY IS WORKING — parked (tried, abandoned) plus out-of-reach-and-unowned (never tried, and
 * not attached to a work item either). Both halves are read here, from the board, not taken from
 * the drainer's summary of itself. `workableFinding` is IMPORTED from the drainer rather
 * than copied, so the reach test cannot drift away from the filter it is testing; if that module
 * fails to load the alarm throws, and a throw here is already "could not tell", never "fine".
 *
 * -- ASSERTION 6: THE PRIVATE COUNT AND THE PAGE MUST AGREE ----------------------------------
 *
 * Parking lives in `C:\Business\_board-drainer\state.json` on one machine, and is PUBLISHED onto
 * the signal row as `detail.parked` exactly once, in the branch that first records an item stuck.
 * Nothing ever re-asserts it. On 2026-09-02 the drainer's heartbeat said 9 parked and 2 rows on
 * the whole board carried the flag: seven findings the machine had given up on could not be
 * identified by any reader — not by /signals, not by a query, not by Roger. A count that only the
 * abandoning process can see is not a report of an abandonment. Any gap is stated out loud.
 *
 * Contract:  node scripts/check-drainer-progress.mjs
 *   env: BOARD_SUPABASE_SECRET (or the BackOffice Credentials.txt path, same as the drainer)
 *        DRAINER_STALE_MIN   (default 180)
 *        DRAINER_STALL_HOURS (default 6)
 * Exit 0 = healthy or alarm filed successfully. Exit 1 = could not tell, which is never "fine".
 */
import { readFileSync } from 'fs'
import { sayVerdict, PASS, FAIL, UNKNOWN } from './lib/check-verdict.mjs'
import { workableFinding } from './board-drainer.mjs'

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

/** Sources whose rows are not findings to be fixed and must never be counted as abandoned:
 *  `work-board` rows ARE the work board (a person already has them by definition), `board-drainer`
 *  rows are this machinery's own heartbeat and this very alarm — counting either would make the
 *  alarm louder by measuring itself — and drills and delivery receipts are not faults.
 *
 *  STATED INDEPENDENTLY OF THE DRAINER, and deliberately so (2026-09-03, reverting the 2026-09-02
 *  `= NOT_A_FINDING_SOURCES` import). This is the alarm's DENOMINATOR filter, not the drainer's
 *  reach filter, and the whole point of `outOfReach` is the GAP between the two: findings this
 *  list still counts but `workableFinding` refuses. If the two populations are the SAME set, that
 *  gap is structurally empty for every well-formed row — a finding not in this list is, by
 *  construction, also not in the drainer's deny list, so `workableFinding` accepts it and it can
 *  never land in `outOfReach`. Importing the drainer's list made the "never tried" half vacuous:
 *  the one edit that most needs catching — someone adding a real fault source to the drainer's
 *  deny list to quiet a noisy producer — would drop that source from BOTH the numerator and the
 *  denominator in the same stroke, so the fixer stops working it AND the alarm stays green.
 *
 *  These two lists holding the same VALUES today is fine; they must not be the same OBJECT. Keep
 *  this narrow and hand-stated: the machinery's own rows, drills, and delivery receipts — the
 *  sources that are not findings by their nature. The drainer's deny list is then free to grow
 *  past this one, and every source it grows by shows up here as out-of-reach. The reach assertion
 *  still also imports the drainer's actual FUNCTION, so a divergence of any OTHER shape
 *  (`workableFinding` refusing a row for a new reason) fires too — both directions are covered now,
 *  the list-grows one by this independence and the function-diverges one by the imported function. */
const NOT_A_FINDING = new Set([
  'work-board', 'board-drainer',
  'test', 'probe', 'wrapper', '__drill__', '__migration_probe__',
  'report', 'closer-digest', 'notification-closer', 'notification-hc-up', 'notification-report',
])

/**
 * Turn the raw active board into the two numbers the verdict needs, and nothing else.
 *
 * Pure so it can be fault-injected: every case in the test file hands it rows it never saw live.
 *
 * `outOfReach` is the population the drainer's own `readBoard()` throws away — since 2026-09-02
 * that is the DENY list of non-finding sources, and before it was every source
 * `monitoring_incidents` would reject — MINUS the rows that already have a person: anything whose
 * source is the work board itself, and anything carrying `detail.work_item`, which is the pointer
 * the drainer writes when it hands a finding over. What remains is findings that no machine will
 * ever classify and no human has been given. That is the quietest failure on this page.
 */
export function summariseBoard(rows, { isWorkable = workableFinding } = {}) {
  const active = Array.isArray(rows) ? rows : []
  const findings = active.filter((r) => !NOT_A_FINDING.has(r.source))
  const inReach = findings.filter((r) => isWorkable(r))
  const outOfReach = findings.filter((r) => !isWorkable(r) && !r?.detail?.work_item)
  const parkedPublished = active.filter((r) => r?.detail?.parked === true)
  const nameOf = (r) => `${r.source}/${r.key}`
  return {
    active: active.length,
    findings: findings.length,
    inReach: inReach.length,
    outOfReach: outOfReach.map(nameOf),
    parkedPublished: parkedPublished.map(nameOf),
  }
}

/**
 * The whole decision, pure and testable. `heartbeat` is the fleet_signals row (or null when the
 * drainer has never reported). `board` is summariseBoard()'s output, or null when the board could
 * not be read — in which case every board-derived assertion is SKIPPED rather than guessed at, and
 * the ok-summary says so. Never returns 'ok' for an input it could not interpret.
 */
export function judgeDrainer({
  heartbeat, board = null, now = Date.now(), staleMin = STALE_MIN, stallHours = STALL_HOURS,
  parkFloor = PARK_FLOOR, parkShare = PARK_SHARE,
}) {
  if (!heartbeat) {
    return {
      verdict: 'stopped',
      // UNKNOWN, not FAIL: this branch is reached both when the drainer genuinely never ran and
      // when the heartbeat read came back empty because something upstream broke (a renamed
      // table, a revoked grant, a wrong project ref — all of which answer 200 with no rows).
      // The alarm is identical either way and stays critical; the flag only stops this being
      // printable as a pass. Measured 2026-09-03: with the API stubbed to answer `[]`, this exact
      // branch fired, filed correctly, and still exited 0 with nothing machine-readable saying so.
      unknown: true,
      severity: 'critical',
      title: 'The fleet auto-fixer has never reported a run',
      summary: 'No board-drainer heartbeat exists at all. Nothing is fixing incidents automatically, and nothing would tell you.',
    }
  }

  const age = minsSince(heartbeat.last_seen_at, now)
  if (age === null || Number.isNaN(age)) {
    return {
      verdict: 'stopped',
      unknown: true,   // "its liveness cannot be established" is by definition an unknown
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

  // A REHEARSAL IS NOT A REPORT (2026-09-02, caught live while this file was being changed).
  //
  // `writeRunHeartbeat` is called from board-drainer.mjs's top-level `main().then()` handler,
  // unconditionally — so a DRY run publishes over the production heartbeat, on whichever machine
  // it happens to be run, from whichever local state file that machine happens to have. There is
  // one row (`source=board-drainer, key=run`) and it is upserted, so the real run's report is not
  // shadowed, it is DESTROYED.
  //
  // Watched happening: at 19:36Z the live heartbeat said `considered 11, dispatchable 0, parked 9`
  // and this alarm returned given-up. At 20:06Z a dry run on a second machine — whose state file
  // was last written 2026-08-25 — replaced it with `dry: true, dispatchable 4, parked 4,
  // last_dispatch_at 2026-08-25`, and the same alarm returned `stalled ... none picked up for
  // 199h`. Neither the parked count nor the stall clock described the live fixer, and nothing in
  // the verdict said so. The flag needed to tell them apart was in the row all along: `dry`.
  //
  // A dry heartbeat is therefore not graded. It means the last thing the fixer published was a
  // rehearsal, so its real state is UNKNOWN — which is not healthy, and is also not a stall.
  if (detail.dry) {
    return {
      verdict: 'unknown',
      severity: 'warning',
      title: 'The fleet auto-fixer\'s last report was a rehearsal, not a run',
      summary: `The newest board-drainer heartbeat is marked dry=true, so it was published by a DRY run and has overwritten the real one. Its counts (${Number(detail.dispatchable ?? NaN)} dispatchable, ${Number(detail.parked ?? NaN)} parked, last pickup ${detail.last_dispatch_at || 'never'}) describe a rehearsal on whichever machine ran it, not the live fixer. Whether the board is being worked cannot be established until the next real run publishes, and unknown is not healthy.`,
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
    // THE DENOMINATOR IS THE BOARD WHEN THE BOARD IS KNOWN (assertion 5). `considered` is what the
    // drainer looked at after discarding every source it cannot write to, so measuring against it
    // asks "of the work it still attempts, how much has it abandoned?" — a question that stays
    // reassuring as the discarded pile grows. Measuring against the active board asks the question
    // the title claims to answer. When the board could not be read we fall back to `considered`
    // and say which basis was used, because a silent change of basis is its own lie.
    const neverTried = board ? board.outOfReach.length : 0
    const unworked = parked + neverTried
    const population = board ? board.findings : considered
    if (unworked >= parkFloor && population > 0 && unworked / population >= parkShare) {
      const pct = Math.round((unworked / population) * 100)
      const basis = board
        ? `${unworked} of the ${population} findings on the board (${pct}%) are being worked by nobody: ${parked} PARKED (the auto-fixer tried them, hit its attempt ceiling and will not pick them up again) and ${neverTried} NEVER TRIED (their source is one the fixer cannot write to, so it drops them before it classifies anything, and no work item has been opened for them either).`
        : `${parked} of ${population} incidents (${pct}%) are PARKED: the auto-fixer tried them, hit its attempt ceiling and will not pick them up again.`
      return {
        verdict: 'given-up',
        severity: 'critical',
        title: 'The fleet auto-fixer has given up on most of the board',
        summary: `${basis} These need a person. A parked or out-of-reach finding carries needs_human=false, so nothing pages on it and it never reaches the work board either — it exists only on the /signals page, and a page is PULL.${parkedGap(board, parked)}${board && board.outOfReach.length ? ` Never tried: ${board.outOfReach.slice(0, 12).join(', ')}${board.outOfReach.length > 12 ? `, +${board.outOfReach.length - 12} more` : ''}.` : ''}`,
        abandoned: board ? board.outOfReach : [],
      }
    }

    // ASSERTION 6, on its own. It sits after given-up because given-up is the more actionable
    // fact, and its summary already carries the same sentence via parkedGap() — so the gap can
    // never be hidden by a louder verdict, only re-reported under it.
    const gap = board ? parked - board.parkedPublished.length : 0
    if (board && gap > 0) {
      return {
        verdict: 'parks-unpublished',
        severity: gap >= parkFloor ? 'critical' : 'warning',
        title: 'The fleet auto-fixer cannot say WHICH findings it abandoned',
        summary: `The drainer's own count says ${parked} finding(s) are parked, and only ${board.parkedPublished.length} row(s) on the board publish detail.parked=true. The other ${gap} exist as abandoned only inside the drainer's local state file on one machine: no query, no page and no person can name them. The flag is written once, in the branch that first records an item stuck, and nothing ever re-asserts it — so a park whose write failed, or one made before the flag existed, is invisible for ever.`,
      }
    }
  }

  return {
    verdict: 'ok',
    severity: 'info',
    title: 'The fleet auto-fixer is working',
    summary: `Last run ${age}m ago; ${dispatchable} dispatchable, last dispatch ${sinceDispatch === null ? 'never' : `${sinceDispatch}m ago`}; ${Number(parkedRaw || 0)} of ${considered} considered are parked.`
      + (board
        ? ` Board: ${board.findings} active finding(s), ${board.inReach} within the fixer's reach, ${board.outOfReach.length} out of reach and unowned.`
        : ' The board itself could not be read this run, so only the drainer\'s own numbers were checked.'),
  }
}

/** One sentence, appended to any verdict that already knows `board`, so the publication gap of
 *  assertion 6 is never swallowed by a louder verdict firing first. */
function parkedGap(board, parked) {
  if (!board) return ''
  const gap = parked - board.parkedPublished.length
  if (gap <= 0) return ''
  return ` Worse: only ${board.parkedPublished.length} of those ${parked} parked findings publish detail.parked=true on their row, so ${gap} of them cannot even be NAMED from the board — they are abandoned only inside the drainer's local state file.`
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

  // THE SECOND READ IS THE POINT (assertion 5). Everything above this line came from the drainer's
  // own summary of itself. The board is read here, independently, with the SAME state filter the
  // drainer uses, so the denominator is the population and not the drainer's opinion of it.
  //
  // A failed board read is NOT fatal and must not be: the stall and stopped assertions are still
  // worth publishing without it. It downgrades to `board = null`, every board-derived assertion is
  // skipped, and the ok-summary says the board could not be read — an admitted gap, never a
  // silent one.
  let board = null
  try {
    const rows = await boGet(
      secret,
      'fleet_signals?select=source,key,severity,state,detail&state=in.(open,acknowledged)&limit=2000',
    )
    board = summariseBoard(rows)
    console.log(`board: ${board.findings} active finding(s), ${board.inReach} in the fixer's reach, ${board.outOfReach.length} out of reach and unowned, ${board.parkedPublished.length} publishing parked=true`)
  } catch (e) {
    console.error(`::warning::the active board could not be read (${String(e.message).slice(0, 160)}); judging on the drainer's own numbers alone this run`)
  }

  const judgement = judgeDrainer({ heartbeat: heartbeat || null, board })
  console.log(`drainer: ${judgement.verdict} — ${judgement.summary}`)
  // Three-valued, out loud (lib/check-verdict.mjs). The house rule is that a filed alarm exits 0,
  // so the exit code cannot distinguish "the fixer is working" from "I could not find out".
  sayVerdict(judgement.verdict === 'ok' ? PASS : judgement.unknown ? UNKNOWN : FAIL, judgement.summary)

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
    // The abandoned keys ride ON the alarm. Before this, the alarm said "9 of 13" and named none
    // of them, so the one row that DID reach Roger could not tell him which nine findings to pick
    // up — he had to go and derive the list himself, which is the pull-not-push failure again.
    detail: {
      verdict: judgement.verdict,
      heartbeat: heartbeat || null,
      board: board || null,
      never_tried: board ? board.outOfReach : null,
      parked_published: board ? board.parkedPublished : null,
      checked_at: new Date().toISOString(),
    },
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
