/**
 * Board Drainer — autonomous incident EXECUTE-loop (root fix, 2026-08-15).
 *
 * Closes the one structural gap the fleet had: detect -> diagnose -> prescribe was strong, but the
 * EXECUTE step depended on a human (Roger) opening a session. production-monitor's autonomous stack
 * (auto-fix / agent-triage / deploy-triage) is live but each only sees its own GitHub-Actions slice;
 * NONE reads the aggregated Monitoring Board. This runner does: it reads `fleet_signals` (BO
 * Supabase — the single store, since Plan A step 1 on 2026-08-27; it read `monitoring_incidents`
 * before that and could not see four active problems), works the owner=Claude items an autonomous
 * dev session may safely fix, escalates the rest, and writes the result back through
 * `upsert_incident` — which since migration 142 (live on production 2026-09-01) is a thin adapter
 * onto `upsert_signal` and writes `fleet_signals`, not the retired store — so the board drains to
 * zero without Roger in the loop.
 *
 * Reuses the existing primitives (agent-triage.mjs's headless-Claude dispatch, Tier-B policy,
 * allowedTools allowlist, dedup-state, local-first, upsert_incident writer) — nothing rebuilt.
 *
 * SAFETY POSTURE (Roger-approved boundary, 2026-08-15):
 *   AUTONOMOUS  : monitor/spec/CI/config/pipeline fixes incl. prod deploy of THOSE classes;
 *                 closing verified false-reds; STAGING deploy of product-code fixes.
 *   ESCALATE    : destructive DB/DDL, secrets/keys, payments, customer comms, PROD promotion of
 *                 product code, business decisions, low-confidence diagnoses, Roger's OAuth hands.
 *
 * DEFAULTS SAFE: dry-run unless BOARD_DRAINER_LIVE=1, and self-skips entirely unless
 *   BOARD_DRAINER_ENABLED=1. Stage-6 go-live APPROVED 2026-08-18: the scheduled task now registers
 *   both ENABLED and LIVE (see scripts/setup-board-drainer-task.ps1). Global kill switch:
 *   BOARD_DRAINER_DISABLED=1.
 *
 * Env knobs:
 *   BOARD_DRAINER_ENABLED=1   on-switch (else self-skip loudly, exit 0)
 *   BOARD_DRAINER_DISABLED=1  kill switch (overrides ENABLED)
 *   BOARD_DRAINER_LIVE=1      actually dispatch + write back (else DRY-RUN: classify + print only)
 *   BOARD_DRAINER_FIXTURE=<path>  classify incidents from a local JSON array instead of the live board
 *                                 (offline classifier validation; never writes back)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, rmSync } from 'fs'
import { execFileSync } from 'child_process'
import { createHash } from 'crypto'
import { join } from 'path'
import { homedir } from 'os'
import { pathToFileURL } from 'url'
import { DEPLOY_DENY_TOOLS, agentToolFlags, DEPLOY_DENY_POLICY_NOTE } from './lib/deploy-deny-tools.mjs'
import { adoptionTarget, closurePlan, resolvedPatch, sameEntitySignals, ACTIVE_SIGNAL_STATES } from './lib/signal-closure.mjs'

// ── config ──────────────────────────────────────────────────────────────────────────────
const BO_REF = 'xoecpzfsskalvjrtcbbl'
const BO_BASE = `https://${BO_REF}.supabase.co`
const BO_CREDS = 'C:\\Business\\Internal Projects\\BackOffice\\docs\\Credentials.txt'
const STATE_DIR = process.env.BOARD_DRAINER_HOME || 'C:\\Business\\_board-drainer'
const STATE = join(STATE_DIR, 'state.json')
const LOG = join(STATE_DIR, 'drainer.log')
const VERDICT_PATH = join(STATE_DIR, 'drainer-verdict.json')
const SEND_EMAIL = join(homedir(), '.claude', 'scripts', 'send_report_email.py')

// Blast-radius cap, still a hard ceiling, but no longer the ONLY control.
const MAX_PER_RUN = Number(process.env.BOARD_DRAINER_MAX_PER_RUN || 3)

// Severity threshold (Roger's call 2026-08-20, replacing a bare hardcoded 3 whose reasoning
// nobody could reconstruct). Autonomy is now a POLICY you dial, the way PostHog's
// P0/P1+/P2+/P3+/All selector works, rather than a magic number.
//   'critical'  only critical
//   'warning'   critical + warning   <- default
//   'info'      everything
// Items below the threshold are still CLASSIFIED and logged every run, they are simply not
// dispatched, so lowering the dial never silently loses them.
const SEVERITY_RANK = { critical: 3, warning: 2, info: 1 }
const THRESHOLD = (process.env.BOARD_DRAINER_THRESHOLD || 'warning').toLowerCase()
const THRESHOLD_RANK = SEVERITY_RANK[THRESHOLD] ?? SEVERITY_RANK.warning

/**
 * MOVING A FINDING TO THE WORK BOARD IS NOT THE SAME AS TELLING ANYBODY.
 *
 * -- THE MEASUREMENT (production xoecpzfsskalvjrtcbbl, 2026-09-01) ---------------------------
 *
 * In the whole recorded history of the signals board, TWENTY-FOUR signals have ever asked to
 * ring Roger's phone -- `needs_human = true` AND `severity = 'critical'`, the only combination
 * upsert_signal will arm. TWENTY-ONE of them never rang. EIGHTEEN of those twenty-one carry
 * `page_suppressed_reason = 'routed-to-work-board'` with `paged_at IS NULL`: written by this
 * function, one hop before delivery.
 *
 * Among the eighteen, verbatim titles:
 *   "SignalScore production mailer silent >168h"                     -- a week of dead customer mail
 *   "Five products' Supabase management tokens are dead ..."
 *   "One dev branch with no upstream switched off all 24 scheduled jobs for 9.5 hours"
 *   "BackOffice share-link returns every column of project_access_requests to a token holder"
 *   "All 25 guard hooks are silently switched off on this laptop ..."
 *
 * -- HOW IT HAPPENED -------------------------------------------------------------------------
 *
 * upsert_signal does not deliver a page, it SCHEDULES one: `page_due_at = now() + 15 minutes`.
 * That delay is the self-heal window, and it is the rule that removed 235 of 236 alerts from
 * Roger's life. A separate 5-minute sweep delivers whatever has come due.
 *
 * The drainer runs hourly and routes findings to the work board. Routing PATCHed
 * `page_due_at = null` unconditionally. So any page still inside its own 15-minute window when
 * the drainer arrived was cancelled by us, before the sweep ever looked at it. The self-heal
 * window designed to absorb false alarms was being consumed by our own robot instead.
 *
 * The old header said so and thought it was fine: "upsert_signal treats both as closed for
 * paging, so the pending page is cancelled either way". The premise underneath that sentence is
 * that the work board is where Roger finds out. IT IS NOT. The work board is a PAGE HE HAS TO
 * OPEN, exactly like /signals. Both are PULL. The page was the only PUSH in the system, and the
 * hand-off deleted it, then recorded a reason that reads like a successful delivery.
 *
 * -- THE RULE ---------------------------------------------------------------------------------
 *
 *     A HAND-OFF CHANGES WHERE THE WORK LIVES. IT NEVER DECIDES THAT HE WAS TOLD.
 *
 * So: cancel the page only once it has actually been DELIVERED. "Delivered" is the same test the
 * sweep itself uses (migration 128): a page is still outstanding when `paged_at IS NULL` or when
 * `paged_at < page_due_at`, i.e. re-armed by something newer than the last send. Anything else,
 * and a signal that pages once could never page again -- the dead-code cooldown bug 128 fixed.
 *
 * Nothing is re-armed here and no new page is created: a row that was never armed
 * (`page_due_at` null -- the 47 warnings that were never eligible) is untouched and stays
 * unreachable. This closes the leak; it does not widen the alarm.
 *
 * @param {{page_due_at?: string|null, paged_at?: string|null}} row  the live signal
 * @returns {{page_due_at: string|null, page_suppressed_reason: string, kept: boolean}}
 */
export function pageFieldsOnSupersede(row) {
  const due = row?.page_due_at ?? null
  const paged = row?.paged_at ?? null
  const outstanding = due !== null && (paged === null || new Date(paged) < new Date(due))
  if (outstanding) {
    // Keep the schedule exactly as it stands. Not `now()`, not a fresh delay: the self-heal
    // window belongs to the producer that armed it, and re-stamping it here would push every
    // page 15 more minutes into the future on every hourly drainer run — a page that is always
    // about to be sent and never is.
    return { page_due_at: due, page_suppressed_reason: 'routed-to-work-board-page-still-due', kept: true }
  }
  return { page_due_at: null, page_suppressed_reason: 'routed-to-work-board', kept: false }
}

/** True when an incident is at or above the configured severity threshold.
 *  An UNKNOWN/absent severity is treated as ABOVE the bar, never below: a row we cannot
 *  grade is a row we must not silently skip. */
export function meetsThreshold(inc, thresholdRank = THRESHOLD_RANK) {
  const rank = SEVERITY_RANK[String(inc?.severity || '').toLowerCase()]
  if (rank === undefined) return true
  return rank >= thresholdRank
}
const MAX_FREE_TIMEOUTS = 3    // consecutive agent timeouts on one key that do NOT cost an attempt
const MAX_ATTEMPTS = 3         // dedup-stuck: after N failed attempts on a key, escalate as "auto-fix stuck"
// How many PARKED findings are handed to the work board per run (2026-09-02, see 3a-bis).
// Rate-limited so a backlog drains steadily instead of emptying onto Roger's board in one tick;
// nine items clear inside an hour at the 20-minute cadence. `0` turns the hand-over off and
// restores the pre-2026-09-02 behaviour, where a parked finding stayed a parked finding.
const MAX_PARKED_HANDOVER_PER_RUN = Number(process.env.BOARD_DRAINER_PARKED_HANDOVER_PER_RUN ?? 3)

/**
 * PLAN B, B3 part 2 (Cockpit/docs/PLAN-QUIET-BOARD-2026-08-27.md, approved 2026-08-27).
 *
 * Until today a parked item was parked FOREVER. It cleared in exactly two ways — the incident
 * left the board, or Roger pressed "Hand to Claude" — so nothing the drainer could not fix in
 * three tries was ever tried a fourth time. Measured on production 2026-08-27: 41 of 42 active
 * incidents were status `blocked`, 36 of 45 active signals named Claude as the owner, and only 2
 * rows were younger than a day. The board had become a graveyard, and a graveyard looks exactly
 * like an alarm going off.
 *
 * So: ONE parked item, oldest-parked first, gets one dispatch every 24 hours. Deliberately one,
 * and deliberately not a reset of its attempt counter — a permanently-broken item earns exactly
 * one agent run per day and never re-enters the normal queue to starve fresh work. It stays
 * parked unless that run actually closes it.
 */
const PARKED_RETRY_INTERVAL_MS = Number(process.env.BOARD_DRAINER_PARKED_RETRY_HOURS || 24) * 3600_000
const MODEL = 'claude-opus-4-8'
const MAX_TURNS = 40
const AGENT_TIMEOUT_MS = 12 * 60 * 1000
const NON_BROWSER_UA = 'board-drainer/1.0'   // sb_secret keys are 403'd under a browser UA (Mozilla/*)

const LIVE = process.env.BOARD_DRAINER_LIVE === '1'
const FIXTURE = process.env.BOARD_DRAINER_FIXTURE || null
// `--reconcile-parked`: publish the park set and do nothing else. See the branch in main().
const RECONCILE_ONLY = process.argv.includes('--reconcile-parked')
let reconcileOnly = false

// -- the one launcher every automation goes through (docs/CONTRACT-agent-run-2026-08-30.md) --
// The drainer no longer spawns `claude` itself: agent-run reads the cockpit's automation
// switches, strips the Anthropic env, picks the engine and enforces the wall-clock cap.
// ABSOLUTE path on purpose: this repo and Cockpit sit at the SAME absolute paths on the desktop
// and on the laptop, so an absolute path is the portable one; a path derived from cwd or $HOME
// is what would differ between the two machines.
const AGENT_RUN = 'C:/Business/Internal Projects/Cockpit/scripts/agent-run.mjs'
const AGENT_RUN_JOB = 'board-drainer'
// Exit 76 = Roger switched the automations off in the cockpit. A deliberate off, never a failure
// (contract section 7): no [ALERT] mail, no failure written back to the board, no ping, exit 0.
const SWITCHED_OFF_EXIT = 76
// 77 = BOTH ENGINES OUT OF CAPACITY AT ONCE (added 2026-09-01). Same family as 76 and
// treated identically everywhere below: a deliberate skip, never a failure. A caller that
// knew 76 and not 77 would turn an outage into a red run and an alarm mail - the exact
// outcome the skip exists to prevent.
const NO_CAPACITY = 77
let switchedOff = false

// ── logging ─────────────────────────────────────────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`
  console.log(line)
  try { appendFileSync(LOG, line + '\n') } catch { /* noop */ }
}
/**
 * A STATE FILE WE COULD NOT PARSE IS NOT A FRESH START (2026-09-01 audit). Returning
 * `{ attempts: {} }` for both cases made an unreadable file byte-identical to a first run, and the
 * bootstrap further down then re-stamped `lastDispatchAt` to now - every run, for ever - resetting
 * the very stall clock check-drainer-progress.mjs reads. Absence IS a first run; a file that is
 * present and unreadable is a fault, and it is marked so the bootstrap leaves the clock alone.
 */
function loadState() {
  if (!existsSync(STATE)) return { attempts: {} }
  try { return JSON.parse(readFileSync(STATE, 'utf-8')) } catch (e) {
    console.error(`::warning::the drainer's state file is unreadable (${String(e.message).slice(0, 120)}); the progress clock will not be re-seeded from it`)
    return { attempts: {}, unreadable: true }
  }
}
function saveState(s) { try { writeFileSync(STATE, JSON.stringify(s, null, 2)) } catch { /* noop */ } }

// ── BO secret (read from Credentials.txt at runtime — never inlined, never in env registration) ──
function readBoSecret() {
  if (process.env.BOARD_SUPABASE_SECRET) return process.env.BOARD_SUPABASE_SECRET.trim()
  const txt = readFileSync(BO_CREDS, 'utf-8')
  const m = txt.match(/sb_secret_[A-Za-z0-9_]+/)
  if (!m) throw new Error(`no sb_secret_ key found in ${BO_CREDS}`)
  return m[0]
}

// ── run heartbeat: what a stall alarm reads ──────────────────────────────────────────────
/**
 * WHY (2026-08-24): this drainer ran for 30 hours, on schedule, and fixed nothing — three stuck
 * items ate the whole per-run budget while 34 others waited behind them. Nothing alerted,
 * because every alarm we had asks "did it RUN?" and the answer was yes, every time.
 *
 * The existing coverage note says the box going dark is covered "by proxy" through the sibling
 * local runners' healthchecks dead-man switches. True, and irrelevant here: the machine was
 * fine. Liveness cannot see a loop that is alive and stuck.
 *
 * So every run publishes what it actually DID, and `check-drainer-progress.mjs` reads it and
 * asserts two different things: that a run happened recently at all, and that work which COULD
 * be dispatched is actually being dispatched. `last_dispatch_at` lives in the local state file
 * so it survives runs that dispatch nothing — which is exactly the state being watched for.
 */
const runStats = {
  started_at: new Date().toISOString(),
  considered: 0,      // open/acknowledged signals on the board (fleet_signals, since 2026-08-27)
  dispatchable: 0,    // passed the severity bar and not parked — work the drainer MAY take
  dispatched: 0,      // agents actually launched this run
  parked: 0,          // at the attempt ceiling: suppressed, deliberately (excludes the one revived below)
  parked_retry: null, // the one parked key handed back to the agent this run, or null (Plan B B3.2)
  parked_handed_over: 0, // parked findings routed to the work board this run (2026-09-02, 3a-bis).
                         // Without it, "parked: 0" cannot be told apart from a clean board, and
                         // "the fixer abandoned nothing" would be indistinguishable from "the
                         // fixer abandoned everything and gave it all away this hour".
  handoff: 0,         // items routed OFF the alarm surface onto the work board (Plan B B3.3)
  escalated: 0,       // recorded without an agent (notes + first-time stuck)
  dry: !LIVE || !!FIXTURE,
  last_dispatch_at: null,
  error: null,
  skipped: null,      // set to the switch name when a gate makes the run return without looking
}

/**
 * The heartbeat is a SIGNAL, not an incident: it is routine machine output, it must never look
 * like a problem, and `state: 'resolved'` keeps it out of every active band on /signals while
 * still bumping last_seen_at. The alarm that reads it is a separate signal with its own key.
 */
async function writeRunHeartbeat(secret) {
  try {
    const key = secret || readBoSecret()
    const res = await fetch(`${BO_BASE}/functions/v1/signal-intake`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'User-Agent': NON_BROWSER_UA,
      },
      body: JSON.stringify({
        source: 'board-drainer',
        key: 'run',
        kind: 'heartbeat',
        severity: 'info',
        state: 'resolved',
        title: 'Board drainer run',
        summary: runStats.error
          ? `run ERRORED: ${String(runStats.error).slice(0, 200)}`
          : `${runStats.considered} on the board, ${runStats.dispatchable} dispatchable, ${runStats.dispatched} dispatched, ${runStats.parked} parked${runStats.parked_retry ? `, 1 parked item revived (${runStats.parked_retry})` : ''}${runStats.dry ? ' (dry run)' : ''}`,
        detail: { ...runStats, finished_at: new Date().toISOString() },
        link: 'https://cockpit.predivo.ch/signals',
      }),
    })
    if (!res.ok) log(`  heartbeat NOT written (HTTP ${res.status}) — the stall alarm will read this run as a missed one.`)
  } catch (e) {
    // Never let the heartbeat take down the run it is reporting on.
    log(`  heartbeat NOT written (${String(e).slice(0, 120)}) — the stall alarm will read this run as a missed one.`)
  }
}

// ── board I/O (PostgREST; non-browser UA is mandatory) ───────────────────────────────────
/**
 * PLAN A STEP 1 (Cockpit/docs/PLAN-ONE-STORE-2026-08-27.md, approved 2026-08-27): the work-list
 * is read from `fleet_signals`, the single store, instead of `monitoring_incidents`.
 *
 * WHY. The healthchecks monitor writes DIRECT to signal-intake (check-healthchecks-down.mjs:131)
 * and never touches the old table, so any problem only that producer sees was invisible to the
 * auto-fixer. Measured on production 2026-08-27 ~10:00 CET: 45 active signals, 42 active
 * incidents, and FOUR active signals the drainer could not see at all —
 * healthchecks/kb-learning-phase0, kb-learning-backfill, knowledge-apply-loop and
 * kb-learning-loop, every one of them "Scheduled job stopped running".
 *
 * THE WRITE HAS SINCE MOVED TOO. This began as a read-only cutover, with results still going to
 * `monitoring_incidents` through upsert_incident and the mirror carrying them back. Migration 142
 * finished the move on 2026-09-01: `upsert_incident` is now an adapter onto `upsert_signal`, the
 * mirror is disabled and writing the retired store is refused outright (migration 156). Read and
 * write are both `fleet_signals`. The dual-write week in the original plan was dropped — see
 * PLAN-ONE-STORE-2026-08-27.md §3 for why it would have proved nothing.
 *
 * ORDER. `first_seen_at asc` preserves the oldest-first queue the old `opened_at asc` gave, so
 * the per-run cap keeps taking the head of the same queue.
 */
export function boardQueryUrl(base = BO_BASE) {
  return `${base}/rest/v1/fleet_signals`
    + `?select=source,key,title,severity,state,summary,detail,first_seen_at`
    + `&state=in.(open,acknowledged)&order=first_seen_at.asc`
}

/**
 * Map one fleet_signals row onto the incident shape every downstream function already speaks
 * (classify, selectWorkQueue, buildUserPrompt, verdictToUpsert). Field mapping verified against
 * live production rows 2026-08-27:
 *   summary               -> root_cause     (present on 45 of 45 active rows)
 *   detail.who_must_act   -> who_must_act   (written by the mirror, migrations 134/136)
 *   detail.incident_status-> status         (ditto)
 *   first_seen_at         -> opened_at
 *
 * Those two detail keys are only RELIABLE because migration 136_upsert_signal_detail_merge.sql
 * made upsert_signal MERGE detail instead of replacing it. Before that, a direct write from the
 * healthchecks producer (detail = {slug,status,last_ping,tags}) erased the owner and status the
 * mirror had put there — which is exactly why those four rows had neither.
 *
 * A row with no incident behind it has no `incident_status`, and then the SIGNAL'S OWN state is
 * the honest answer. Never invent 'open': a fabricated status reads identically to a real one.
 */
export function signalToIncident(sig) {
  const detail = (sig && typeof sig.detail === 'object' && sig.detail !== null) ? sig.detail : {}
  return {
    source: sig.source,
    key: sig.key,
    title: sig.title,
    severity: sig.severity,
    status: detail.incident_status || sig.state,
    root_cause: sig.summary ?? null,
    who_must_act: detail.who_must_act ?? null,
    opened_at: sig.first_seen_at,
    // What the LAST remediation attempt concluded, carried through so classify() can see it.
    // It was dropped here before, which is how a row could be stamped "expected business state"
    // while its own evidence field said the fix was written and never deployed. See
    // expectedBusinessApplies().
    action_taken: detail.actionTaken ?? null,
    // WHICH LIVE JOB THIS FINDING IS ALREADY ATTACHED TO, if any. Carried through since 2026-09-02,
    // when a joined signal stopped being superseded and started staying visible on /signals until a
    // person ticks it off (Roger's decision, 2026-08-28). That change means the drainer SEES the
    // same signal again every 20 minutes, so without this field it would bolt another identical
    // marker onto the item on every run - a marker flood in place of a mute. Attaching twice must
    // be a no-op, and this is what makes it one.
    joined_to: detail.work_item ?? null,
    // WHETHER THAT POINTER CAME FROM A JOIN OR FROM A SUPERSEDE, and the two must not be confused.
    // `joined_at` is stamped by markSignalJoined and by nothing else, so its presence is the only
    // honest way to tell "attached to a live job, deliberately still visible on /signals" (Roger,
    // 2026-08-28) from "handed over and muted". adoptionTarget() refuses to adopt a joined row for
    // exactly that reason: adopting routes it into supersedeSignal, which is the mute that decision
    // reversed. Without this field the two states are indistinguishable downstream.
    joined_at: detail.joined_at ?? null,
  }
}

/**
 * WHICH SIGNALS THE AUTO-FIXER MAY WORK — and why this is a DENY list, not an allow list.
 *
 * -- WHAT WAS HERE, AND WHY IT WAS WRONG -----------------------------------------------------
 *
 * Until 2026-09-02 this was an ALLOW list of the six values `monitoring_incidents.source` accepts
 * (healthchecks | sentry | production-monitor | cron | silent-failure | commit-review), because
 * the drainer's write-back went to that table and a rejected source would 400 and throw the item
 * out of its own run. That reason expired on 2026-09-01, when migration 142 went live on
 * production: `upsert_incident` no longer mentions `monitoring_incidents` at ALL — it is a thin
 * adapter onto `upsert_signal`, and `fleet_signals` has no source CHECK of any kind.
 *
 * Proved rather than read, on BackOffice staging 2026-09-02:
 *   insert into monitoring_incidents (source='monitoring-hygiene')  -> ERROR 23514, still refused
 *   select upsert_incident('monitoring-hygiene', ...)               -> HTTP 201, row lands OPEN
 *                                                                      in fleet_signals
 * and on production `pg_get_functiondef(upsert_incident)` contains `upsert_signal` and does not
 * contain `monitoring_incidents`.
 *
 * So the guard was holding work back to avoid an error that can no longer happen. Measured on
 * production the moment before it was removed: **12 of 25 active signals (48%) were being dropped
 * here**, before `considered` was taken — seven `monitoring-hygiene` faults in the monitoring
 * system itself, the drainer's own stall alarm, an `external-tools-freshness` staleness alarm and
 * three `work-board` rows. Nothing ever tried them and no count noticed, because a population
 * defined by what the tool can write is not the population that exists.
 *
 * -- WHY DENY AND NEVER ALLOW ------------------------------------------------------------------
 *
 * An allow list makes a NEW source invisible by default: a producer added next month is silently
 * outside the queue until somebody remembers this constant. That is the exact defect above, and it
 * would come back the same way. A deny list fails the other way — an unrecognised source is WORKED
 * (or at worst classified and handed to a person), which is loud.
 *
 * -- WHAT IS DENIED, EACH FOR ITS OWN REASON ---------------------------------------------------
 *
 * These are not "sources we cannot write". They are rows that are not FINDINGS:
 *
 *   work-board      the rows ARE the work board. A person already has them by definition, and
 *                   routing one would mint a second work item for the item it came from.
 *   board-drainer   this machinery's own heartbeat and its own stall alarm. Working it would make
 *                   the fixer measure and dispatch against itself.
 *                   (Both of the above match `NOT_A_FINDING` in check-drainer-progress.mjs, which
 *                   reached the same two names independently on 2026-09-02.)
 *   test, probe,    synthetic. Migration 159 dispositioned all three as "exercise the pipe, not a
 *   wrapper,        fault"; `__drill__` and `__migration_probe__` are the fleet's drill identities.
 *   __drill__,      A drill that dispatches a real agent is not a drill.
 *   __migration_probe__
 *   report,         deliveries and delivery bookkeeping — migration 159's own words: "a report IS
 *   closer-digest,  a delivery". There is nothing to fix in the record that something was sent.
 *   notification-closer, notification-hc-up, notification-report
 *
 * Everything else is a finding, INCLUDING sources this list has never seen. `scout-ux` is deliberately
 * absent: it is refused structurally by isScoutDerived() above, which also catches a scout-derived
 * row filed under any other source, and one guard removed must not quietly disarm the other.
 */
export const NOT_A_FINDING_SOURCES = new Set([
  'work-board', 'board-drainer',
  'test', 'probe', 'wrapper', '__drill__', '__migration_probe__',
  'report', 'closer-digest', 'notification-closer', 'notification-hc-up', 'notification-report',
])

/** True when this row is a finding the auto-fixer may take on. A row with NO source is denied:
 *  every producer sets one, so an absent source is a malformed row, not a new kind of work. */
export function workableFinding(inc) {
  const source = inc?.source
  return typeof source === 'string' && source.length > 0 && !NOT_A_FINDING_SOURCES.has(source)
}

/** @deprecated Kept ONLY so an out-of-tree caller does not break silently. The name is a lie since
 *  migration 142 — nothing is written to the incident board any more. Use workableFinding. */
export const writableToIncidentBoard = workableFinding

async function readBoard(secret) {
  const res = await fetch(boardQueryUrl(), {
    headers: { apikey: secret, Authorization: `Bearer ${secret}`, 'User-Agent': NON_BROWSER_UA },
  })
  if (!res.ok) throw new Error(`board read HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const rows = (await res.json()).map(signalToIncident)
  const held = rows.filter((r) => !workableFinding(r))
  if (held.length) {
    log(`  ${held.length} active signal(s) are not findings (the work board itself, the drainer's own heartbeat, drills and delivery receipts) — not worked, by decision, not by a constraint: ${held.map((r) => `${r.source}/${r.key}`).join(', ')}`)
  }
  return rows.filter(workableFinding)
}

/** The ONLY manual control over an otherwise fully automatic queue.
 *
 *  The board is read `order=opened_at.asc` and the per-run cap takes the head of it, so without
 *  this there is no way for a human to say "that one, now" — the queue position of an item is
 *  decided entirely by when it was filed. `/signals` has had a "Hand to Claude" button and a
 *  `claude_queue()` function since 2026-08-23 and NOTHING read either of them: verified
 *  2026-08-24, `handed_to_claude_at` was non-null on 0 of 186 rows and `claude_queue()` had no
 *  caller anywhere in the fleet. A hand-off lane with no consumer is a lie to the user.
 *
 *  This is that consumer. A signal Roger hands to Claude is hoisted to the front of the work
 *  queue AND clears its stuck counter (see selectWorkQueue), which makes the button the escape
 *  hatch for an item the drainer has given up on.
 *
 *  Failure is NOT swallowed into "no priorities": that would silently demote a deliberate human
 *  instruction back into FIFO order and look identical to Roger never having pressed it. The
 *  caller logs the failure and, like the scout-queue fetch, records that the picture is partial.
 */
async function readPriorityKeys(secret) {
  const url = `${BO_BASE}/rest/v1/fleet_signals`
    + `?select=source,key,handed_to_claude_at`
    + `&handed_to_claude_at=not.is.null&state=eq.open&order=handed_to_claude_at.asc`
  const res = await fetch(url, {
    headers: { apikey: secret, Authorization: `Bearer ${secret}`, 'User-Agent': NON_BROWSER_UA },
  })
  if (!res.ok) throw new Error(`priority queue read HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return (await res.json()).map((r) => r.key)
}

// One-shot retry on a TRANSPORT error (fetch() throwing, e.g. `TypeError: fetch failed`) — NOT on an
// HTTP status (those are handled by !res.ok below and are real server rejections, never retried).
// Root cause (incident board-drainer-upsert-fetch-failed, 2026-08-19): readBoard() opens an undici
// keep-alive socket, then dispatchAgent()'s execFileSync blocks the event loop 6-8 min; the edge
// closes the idle socket but undici cannot reap it while the loop is blocked, so the first POST reuses
// a dead socket and throws. The retry gets a fresh connection (the dead socket is evicted once its
// error handler finally runs). Safe: upsert_incident is idempotent (keyed by source+key) and a
// transport throw means the server never received the request — a retry cannot double-write.
async function fetchWithTransportRetry(url, init) {
  try {
    return await fetch(url, init)
  } catch (e) {
    log(`  transport error on write-back (${(e?.message || e).toString().split('\n')[0]}) — one-shot retry on a fresh connection`)
    await new Promise((r) => setTimeout(r, 500))   // let undici evict the dead pooled socket first
    return fetch(url, init)
  }
}

/** HISTORICALLY this guard rode on the monitoring_incidents.source CHECK (healthchecks | sentry |
 *  production-monitor | cron | silent-failure), which REJECTED source='scout-ux' with a 400 and
 *  made upsertIncident throw. That CHECK is no longer in the write path (migration 142), so the
 *  400 is gone — and this guard is KEPT anyway, because the constraint was never the reason.
 *  What follows is what the 400 cost us when it was the only thing holding the line. Incident
 *  production-monitor:e9c8e44:scout-ux-source-violates-incident-check-constraint (2026-08-20)
 *  traced the consequence: the throw escapes the per-item loop, main() aborts BEFORE
 *  markScoutReport(), worked_at is never set, readScoutQueue() filters on worked_at is null,
 *  so the SAME report re-dispatches an Opus agent on every tick forever, and because
 *  saveState() is also past the throw the MAX_ATTEMPTS guard never trips either. The
 *  blast-radius guard failed OPEN.
 *
 *  The right fix is not to widen the constraint. A scout report is not an incident and must
 *  never become one: reports are free, alarms are not. Scout items write ONLY to
 *  scout_reports. This guard makes that structural rather than a convention. */
export function isScoutDerived(inc) {
  return Boolean(inc && (inc.scoutReportId || inc.source === 'scout-ux'))
}

/**
 * PLAN B, B3 part 1: PUBLISH parked state.
 *
 * Parking existed only in `C:\Business\_board-drainer\state.json` on one machine. No page, no
 * query and no person could see it, so a pile of things we had given up on was indistinguishable
 * on the board from things going wrong right now. These three keys are the CONTRACT the cockpit
 * lane is being built against — do not change their names or shapes:
 *
 *   detail.parked           true while suppressed, false once it is not
 *   detail.parked_at        ISO timestamp of the moment it was parked (null when not parked)
 *   detail.parked_attempts  how many failed tries earned the park (null when not parked)
 *
 * They ride in `p_evidence`, because upsert_incident stores evidence verbatim and the mirror
 * trigger merges it straight into fleet_signals.detail
 * (136_mirror_owner_from_prefix.sql: `p_detail => coalesce(new.evidence,'{}') || ...`).
 *
 * NOT-PARKED IS WRITTEN OUT EXPLICITLY, never omitted. upsert_incident does
 * `evidence = excluded.evidence` (a full replace), but upsert_signal MERGES detail since
 * migration 136 — so an absent key leaves the OLD value standing on the signal. "Nothing said"
 * would read as "still parked", forever.
 */
export function parkedFields(mark) {
  return mark && mark.parked
    ? { parked: true, parked_at: mark.at ?? null, parked_attempts: mark.attempts ?? null }
    : { parked: false, parked_at: null, parked_attempts: null }
}

/**
 * Clear the parked flag directly on the SIGNAL row.
 *
 * WHY NOT through upsert_incident like every other stamp: by the time an item leaves the board
 * its incident is already closed, and writing an incident row is precisely what REOPENS it
 * (upsert_incident sets status and nulls resolved_at). Clearing a bookkeeping flag must never
 * resurrect an alarm.
 *
 * AND IT CANNOT BE SKIPPED AS HARMLESS. fleet_signals is unique(source,key) and migration 136
 * made `detail` MERGE, so a `parked: true` left on a resolved row survives the resolve and comes
 * straight back the next time that same check goes down — the item would be born parked.
 *
 * detail is read-modify-written because a PostgREST PATCH replaces the whole jsonb column.
 * Every failure is logged and swallowed: this is bookkeeping, not the run.
 */
async function clearParkedOnSignal(secret, source, key) {
  const H = { apikey: secret, Authorization: `Bearer ${secret}`, 'User-Agent': NON_BROWSER_UA }
  const filter = `key=eq.${encodeURIComponent(key)}` + (source ? `&source=eq.${encodeURIComponent(source)}` : '')
  try {
    const cur = await fetch(`${BO_BASE}/rest/v1/fleet_signals?select=source,detail&${filter}`, { headers: H })
    if (!cur.ok) throw new Error(`read HTTP ${cur.status}`)
    const rows = await cur.json()
    if (rows.length === 0) return false
    if (rows.length > 1) {
      // Only possible for a legacy state entry recorded before the source was stored alongside
      // the key. Guessing which row to write is worse than saying so.
      log(`  parked flag NOT cleared for ${key}: ${rows.length} signals share that key and this parked marker predates source tracking — clear it by hand or let "Hand to Claude" do it.`)
      return false
    }
    if (rows[0].detail?.parked !== true) return false   // already agrees; do not write for nothing
    const res = await fetch(`${BO_BASE}/rest/v1/fleet_signals?${filter}`, {
      method: 'PATCH',
      headers: { ...H, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ detail: { ...(rows[0].detail || {}), ...parkedFields(null) } }),
    })
    if (!res.ok) throw new Error(`patch HTTP ${res.status}`)
    log(`  ${rows[0].source}/${key}: parked flag cleared on the signal row.`)
    return true
  } catch (e) {
    log(`  parked flag NOT cleared for ${key} (${String(e).slice(0, 120)}) — the row may still read parked on /signals until the next write.`)
    return false
  }
}

/**
 * RE-ASSERT THE PARK SET ON EVERY RUN — the flag is a STATE, not an event.
 *
 * WHY (board key production-monitor/board-drainer-stalled, verdict `parks-unpublished`, 2026-09-03).
 * `detail.parked = true` was written in exactly ONE place: the branch in main() that first records
 * an item stuck. Nothing ever wrote it again. That makes the published flag an EDGE — it exists on
 * a row only if one particular PATCH, on one particular run, on one particular machine, happened to
 * succeed. Measured on production 2026-09-02: the drainer's heartbeat said 9 findings were parked
 * and 2 rows on the board published the flag. The other 7 were abandoned only inside
 * `C:\Business\_board-drainer\state.json`, on whichever machine ran the task — no query, no page
 * and no person could name them. Three separate ways to arrive at that:
 *
 *   * the write failed (a 4xx, a dropped socket) and the item was parked anyway — parking is
 *     recorded LAST on purpose, so a failed escalation is retried, but a failed EVIDENCE write is
 *     not distinguishable from a successful one by anything that runs later;
 *   * the item was parked before the flag existed at all (every park older than Plan B B3 part 1);
 *   * something else rewrote `detail` — it MERGES (migration 136), but a producer that re-files the
 *     same key with its own detail still wins any key it names.
 *
 * So the drainer now RECONCILES instead of stamping: every run, it reads the active board, compares
 * it against its own `state.stuck`, and makes the board agree — publishing the flag on every item it
 * currently considers parked and CLEARING it on every item it does not. It is idempotent (a row that
 * already agrees is never written), it is cheap (one read, plus one PATCH per disagreement, and the
 * steady state is zero PATCHes), and it is self-healing: a park whose write failed is republished on
 * the next tick instead of being invisible for ever.
 *
 * MATCHING. A stuck marker recorded since 2026-09-02 carries the signal's `source`, and then the
 * match is exact. A legacy marker has only the key; if more than one active row shares that key the
 * reconcile REFUSES it by name rather than guessing which row to write — the same rule
 * clearParkedOnSignal follows, for the same reason.
 *
 * WHAT IT CANNOT SEE, and why that is right: a key in `state.stuck` with no row on the active board
 * is not republished — there is nothing on the board to publish onto. Those are cleared by the
 * stale-marker prune in main(), which calls clearParkedOnSignal() on the row wherever it now sits.
 *
 * @param {{readActive:Function, patchDetail:Function, log?:Function}} deps
 * @param {{state:object, dryRun?:boolean}} opts
 * @returns {Promise<{desired:number, published:number, asserted:string[], cleared:string[],
 *                    unmatched:string[], ambiguous:string[], errors:string[]}>}
 */
export async function reconcileParkedFlags(deps, { state, dryRun = false } = {}) {
  const say = deps.log || (() => {})
  const stuck = (state && state.stuck) || {}
  const out = { desired: 0, published: 0, asserted: [], cleared: [], unmatched: [], ambiguous: [], errors: [] }
  const rows = await deps.readActive()

  // Which live row does each parked marker belong to? Built once, both directions.
  const byKey = new Map()
  for (const r of rows) {
    if (!byKey.has(r.key)) byKey.set(r.key, [])
    byKey.get(r.key).push(r)
  }
  const wanted = new Map()   // row identity -> the marker that says it is parked
  const idOf = (r) => `${r.source}/${r.key}`
  for (const [key, mark] of Object.entries(stuck)) {
    const candidates = byKey.get(key) || []
    if (candidates.length === 0) { out.unmatched.push(key); continue }
    let row = null
    if (mark && mark.source) row = candidates.find((c) => c.source === mark.source) || null
    else if (candidates.length === 1) row = candidates[0]
    if (!row) {
      // Either a legacy marker whose key is shared by several rows, or a source that no longer
      // matches any of them. Both mean "we do not know which row this is about", and a wrong write
      // would mark a live finding as abandoned.
      out.ambiguous.push(key)
      continue
    }
    wanted.set(idOf(row), { at: mark.at ?? null, attempts: mark.attempts ?? null })
  }
  out.desired = wanted.size

  for (const row of rows) {
    const id = idOf(row)
    const detail = (row.detail && typeof row.detail === 'object') ? row.detail : {}
    const mark = wanted.get(id) || null
    if (detail.parked === true) out.published += 1
    // The full triple is compared, not just the boolean: a row that says parked=true with the wrong
    // timestamp or the wrong attempt count is publishing a fact we do not hold, and the cockpit
    // renders both (useFleetSignals: isParked / parkedAt / parkedAttempts).
    const target = parkedFields(mark ? { parked: true, at: mark.at, attempts: mark.attempts } : null)
    // AN ABSENT FLAG ALREADY MEANS NOT-PARKED, and it must not be rewritten to say so. The cockpit
    // renders a strict `detail.parked === true` (useFleetSignals), so a row that never carried the
    // key reads exactly like `parked: false`. Treating the two as different would PATCH every row
    // on the board on the first run after this shipped - a hundred writes that change nothing, and
    // a churn of noise that makes the real corrections impossible to spot.
    const agrees = mark
      ? detail.parked === true
        && (detail.parked_at ?? null) === target.parked_at
        && (detail.parked_attempts ?? null) === target.parked_attempts
      : detail.parked !== true
        && (detail.parked_at ?? null) === null
        && (detail.parked_attempts ?? null) === null
    if (agrees) continue
    const bucket = mark ? out.asserted : out.cleared
    if (dryRun) {
      say(`    would ${mark ? 'assert' : 'clear'} detail.parked on ${id} (the board says ${JSON.stringify(detail.parked ?? null)}, the drainer says ${JSON.stringify(target.parked)})`)
      bucket.push(id)
      continue
    }
    try {
      await deps.patchDetail(row, { ...detail, ...target })
      bucket.push(id)
      say(`    ${id}: detail.parked ${mark ? `RE-ASSERTED (parked since ${target.parked_at || 'an unrecorded time'}, ${target.parked_attempts ?? '?'} attempts)` : 'CLEARED (the drainer no longer considers it parked)'}`)
    } catch (e) {
      out.errors.push(`${id}: ${String(e).slice(0, 160)}`)
    }
  }
  return out
}

/** The live transport for reconcileParkedFlags. Reads the same active band the drainer works
 *  (`open`/`acknowledged`), NOT the writable-source subset: a parked flag has to be corrected on
 *  every row that carries one, including sources monitoring_incidents would reject. */
export function parkedReconcileDeps(secret, logFn = log) {
  const H = { apikey: secret, Authorization: `Bearer ${secret}`, 'User-Agent': NON_BROWSER_UA }
  return {
    log: logFn,
    readActive: async () => {
      const res = await fetch(`${BO_BASE}/rest/v1/fleet_signals?select=source,key,detail&state=in.(open,acknowledged)&limit=2000`, { headers: H })
      if (!res.ok) throw new Error(`board read for the parked reconcile HTTP ${res.status}`)
      return res.json()
    },
    patchDetail: async (row, detail) => {
      const filter = `key=eq.${encodeURIComponent(row.key)}&source=eq.${encodeURIComponent(row.source)}`
      const res = await fetch(`${BO_BASE}/rest/v1/fleet_signals?${filter}`, {
        method: 'PATCH',
        headers: { ...H, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ detail }),
      })
      if (!res.ok) throw new Error(`patch HTTP ${res.status}`)
    },
  }
}

/**
 * Run the reconcile and SAY WHAT IT DID, every run, including the boring one. A pass that only
 * speaks up when it changed something cannot be told apart from a pass that did not run — which is
 * the failure this file keeps re-learning.
 *
 * A failure here is announced and swallowed: publishing bookkeeping must never take the run down.
 */
async function runParkedReconcile(secret, state, { dryRun }) {
  if (FIXTURE || !secret) return null
  try {
    const r = await reconcileParkedFlags(parkedReconcileDeps(secret), { state, dryRun })
    log(`  ⏱ parked-flag reconcile${dryRun ? ' (DRY-RUN, nothing written)' : ''}: ${r.desired} item(s) the drainer considers parked, ${r.published} row(s) were publishing detail.parked=true`
      + ` — ${dryRun ? 'would re-assert' : 're-asserted'} ${r.asserted.length}, ${dryRun ? 'would clear' : 'cleared'} ${r.cleared.length}.`)
    if (r.asserted.length) log(`    re-asserted: ${r.asserted.join(', ')}`)
    if (r.cleared.length) log(`    cleared: ${r.cleared.join(', ')}`)
    if (r.unmatched.length) log(`    ${r.unmatched.length} parked marker(s) have no row on the active board, so there is nothing to publish onto (the stale-marker prune clears those): ${r.unmatched.join(', ')}`)
    if (r.ambiguous.length) log(`    ⚠ ${r.ambiguous.length} parked marker(s) could NOT be matched to exactly one row and were left alone rather than guessed at: ${r.ambiguous.join(', ')}`)
    for (const e of r.errors) log(`    ⚠ parked-flag reconcile error: ${e}`)
    return r
  } catch (e) {
    log(`  ⚠ the parked-flag reconcile could not run (${String(e).slice(0, 160)}) — the published flags may disagree with the drainer's own state until the next run.`)
    return null
  }
}

async function upsertIncident(secret, payload) {
  const res = await fetchWithTransportRetry(`${BO_BASE}/rest/v1/rpc/upsert_incident`, {
    method: 'POST',
    headers: {
      apikey: secret, Authorization: `Bearer ${secret}`,
      'User-Agent': NON_BROWSER_UA, 'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(`upsert_incident HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.text()
}

/**
 * PHASE 4 (Roger's call 2026-08-20: "staging, then stop").
 *
 * A scout report is NOT an incident and never becomes one. It lives in its own table because
 * reports are free and alarms are not. What Phase 4 adds is narrow: a report a HUMAN has
 * marked `real` becomes eligible for the same fix agent, through the SAME unchanged boundary.
 * Nothing about the autonomy limits moves. Product-code fixes still stop at staging and
 * escalate the prod promotion to Roger, exactly as they do for every other incident today.
 *
 * The gate is the human mark. A scout report nobody judged is never worked, no matter how
 * many users it hit or how confident the narrative sounds.
 */
async function readScoutQueue(secret) {
  const url = `${BO_BASE}/rest/v1/scout_reports`
    + `?select=id,product,function_name,operation,message_pattern,occurrences,distinct_users,authenticated,sample_evidence,narrative,state_reason`
    + `&state=eq.real&worked_at=is.null&order=distinct_users.desc,occurrences.desc`
  const res = await fetch(url, {
    headers: { apikey: secret, Authorization: `Bearer ${secret}`, 'User-Agent': NON_BROWSER_UA },
  })
  if (!res.ok) throw new Error(`scout queue read HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.json()
}

/** Shape a scout report so the EXISTING classifier and agent path can consume it unchanged.
 *  Severity is derived, never invented: a failure that hit a signed-in person is `warning`,
 *  an anonymous pattern a human still judged real is `info`. Neither is ever `critical`,
 *  because a UX finding is by definition not an outage. */
export function scoutReportToIncident(r) {
  return {
    source: 'scout-ux',
    key: `${r.product}:${r.function_name}:${String(r.message_pattern).slice(0, 60)}`,
    title: `[UX] ${r.product} ${r.function_name}: ${r.message_pattern}`,
    severity: r.authenticated ? 'warning' : 'info',
    status: 'open',
    root_cause: [
      r.narrative || '',
      `${r.occurrences} occurrence(s), ${r.distinct_users} distinct user(s), authenticated=${Boolean(r.authenticated)}.`,
      r.state_reason ? `Roger marked this real: ${r.state_reason}` : '',
      `Evidence: ${JSON.stringify(r.sample_evidence || {})}`,
    ].filter(Boolean).join(' '),
    // The report's OWN WORDS ride in who_must_act, and they have to. Since 2026-08-27 a gate reads
    // the prescribed action and nothing else (see stripCode/gateFor above), and a scout report has
    // no prescribed action of its own — every one of them would otherwise arrive carrying the same
    // generic sentence and no gate could ever fire on any of them. A report that says "orphan rows
    // should be deleted from the connections table" is asking for destructive database work, and
    // the only place it says so is here.
    who_must_act: `Claude - fix the user-facing failure, staging deploy only: ${r.message_pattern || ''}${r.narrative ? ` (${r.narrative})` : ''}`.trim(),
    scoutReportId: r.id,
  }
}

/** Close the loop on a worked report. Marking it `fixed` here is what arms the Measured
 *  re-check (ux-scout.mjs measurePass), so the receipt can eventually say the PROBLEM
 *  STOPPED rather than only that a change was made. */
async function markScoutReport(secret, id, patch) {
  const res = await fetch(`${BO_BASE}/rest/v1/scout_reports?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      apikey: secret, Authorization: `Bearer ${secret}`,
      'User-Agent': NON_BROWSER_UA, 'Content-Type': 'application/json', Prefer: 'return=minimal',
    },
    body: JSON.stringify(patch),
  })
  if (!res.ok) log(`  scout_reports patch failed for ${String(id).slice(0, 8)}: HTTP ${res.status}`)
}

// ── classifier: WHAT THE ITEM IS, not which nouns turn up in its text ────────────────────────
/**
 * REWRITTEN 2026-08-27 (Plan B, B3 part 3 — Cockpit/docs/PLAN-QUIET-BOARD-2026-08-27.md), against
 * incident `production-monitor/board-drainer-human-hands-regex-matches-billing-nouns`.
 *
 * THE DEFECT. The old gate was two flat noun lists tested against
 * `who_must_act || root_cause || title`, concatenated into one blob. A single occurrence of
 * `delete`, `drop`, `invoice`, `pay`, `payment`, `rotate` or `vendor` ANYWHERE in that blob pushed
 * the row out of the fixer's lane and into a lane named after Roger.
 *
 * MEASURED against the live production board 2026-08-27 — 42 active signals, 18 routed away from
 * the fixer, of which SIX genuinely need Roger and TWELVE were keyword accidents. The twelve, each
 * with the exact token that did it:
 *
 *   `--delete`, an rsync FLAG in a prescribed command      ChannelMover  fe87378
 *   "delete the `if (...)` line at index.ts:105"           BackOffice    3fea238
 *   "delete data/circuit-breaker.json"                     cron          pull-engine breaker
 *   "DELETE the variable"                                  prod-monitor  4e2a4fe
 *   "delete `if: ...`" in a workflow                       ReplyFlow     47afebf
 *   "delete deploy.yml:864"                                ChannelMover  cde2cb2
 *   "Delete deploy-staging.yml L211"                       Distribution  f666a20
 *   "DROP the '...' sentence"                              prod-monitor  632a349
 *   "delete the two comments"                              BackOffice    b1ff1a4
 *   "Drop confirmed -> close"                              prod-monitor  actions-fanout-cost
 *   `payment` / `OAuth` / `invoice` inside the sentence DESCRIBING THIS VERY BUG
 *   `{refunds,payments-and-vat,pricing-and-plans}.md` — support-article FILENAMES  ChannelMover 162c12b
 *
 * Not one is a payment, a secret or a database operation. Every one is a one-line code or workflow
 * edit the fixer is allowed to make, and each sat blocked for days waiting for a human who was
 * never coming. That is where a 41-of-42-blocked board comes from.
 *
 * THE FIX, three rules:
 *
 *  1. ONLY THE PRESCRIBED ACTION DECIDES. A gate reads `who_must_act` and nothing else. `title`
 *     and `root_cause` DESCRIBE the problem — a page title carrying the word "invoice", an error
 *     message quoted verbatim that says "reconnect the account" — and describing is not
 *     instructing. This one rule kills five of the twelve on its own.
 *  2. CODE IS NOT PROSE. Backticked spans, file paths, `file.yml:123` refs, CLI flags, commit ids
 *     and SCREAMING_SNAKE identifiers are removed before any gate reads the sentence. `--delete`
 *     is not a verb and `deploy.yml:864` is not an object.
 *  3. A GATE NEEDS A VERB AND ITS OBJECT, ADJACENT. "delete … row" is database work; "delete …
 *     comments" is an edit. The old list could not tell them apart because it never looked at the
 *     object at all.
 *
 * THE SAFETY POSTURE DOES NOT MOVE. Destructive database work, secrets, payments, customer
 * communication and Roger's own hands all still escalate — recognised now by what is being ASKED
 * FOR instead of by which nouns appeared. Two deliberate non-changes:
 *
 *  - PRODUCTION PROMOTION OF PRODUCT CODE is NOT a text gate here, and must not become one. It is
 *    enforced where it can actually be enforced: SYSTEM_POLICY class B (product fixes stop at
 *    staging) and prod-deploy-guard's hard-coded allowlist, which REFUSES any function not on it.
 *    A text rule cannot separate "deploy to prod (low-blast-radius monitor class)" — permitted,
 *    and on the board verbatim today — from a product promotion, which is not.
 *  - EXPECTED_BUSINESS still reads the whole row. It is a statement about STATE ("HTTP 401 Plan
 *    expired"), not about an action, and state legitimately lives in root_cause.
 */

// EXPECTED business state, not an incident: a vendor plan/subscription lapsed (e.g. Smartlead
// "HTTP 401 Plan expired"). These get upserted as status=expected (visible but muted on the board,
// not counted as open) instead of sitting in Open Incidents forever. Checked BEFORE every gate —
// a lapsed plan is noted, not escalated.
const EXPECTED_BUSINESS = /\b(plan expired|plan (?:lapsed|cancelled|canceled|cancellation)|subscription (?:expired|lapsed|inactive|cancelled|canceled)|payment required|upgrade required|billing suspended|account (?:suspended|paused))\b/i

/**
 * "THE VENDOR'S PLAN LAPSED" IS ONLY AN EXPECTED STATE IF WE ARE HANDLING IT.
 *
 * -- WHAT WAS WRONG (measured on production, 2026-09-01) -------------------------------------
 *
 * The "App errors" tile on /signals read ZERO while NINE unresolved production errors sat in
 * Sentry. The Sentry wire was not the fault: it runs hourly, reads Sentry correctly, and the
 * 2026-08-27 audit ranked building it the #1 fix. Its output was erased downstream, here.
 *
 * fleet_signals row `sentry/141893005`, live values:
 *
 *     title            backoffice is throwing an error: Error: Smartlead HTTP 401: {"Plan expired!"}
 *     state            resolved        occurrence_count 30        flip_count 12
 *     detail.filed_by  check-sentry-issues     <- the wire filed it
 *     detail.by        board-drainer           <- this function closed it
 *     detail.class     EXPECTED
 *     detail.actionTaken  still-blocked        <- the row saying the work is NOT done
 *
 * flip_count 12 is the shape of the bug: every hour the wire reopens the row because Sentry saw
 * the error again, and every hour the drainer mutes it again. The tile is non-zero only in the
 * minutes between. It was at 33 events when the 2026-08-27 audit named it and 51 five days later.
 *
 * -- WHY THE ORIGINAL RULE IS STILL RIGHT ----------------------------------------------------
 *
 * A lapsed vendor plan genuinely IS a business state and not an incident, and muting it is
 * correct: nobody should be paged because Smartlead wants paying. That is not what is being
 * changed. What was wrong is that the rule read the vendor's state and drew a conclusion about
 * OURS. Here our own edge function throws an UNHANDLED Error 51 times BECAUSE the plan lapsed.
 * The vendor's billing is expected; our service crashing on it is a defect, and the fix for it
 * (BackOffice 6145f52) is committed, pushed, and has never reached production.
 *
 * So the row's own record already said the problem was not gone, in the one field nobody read:
 * `detail.actionTaken = 'still-blocked'`. signalToIncident dropped it before classify() ever saw
 * it, which is why the contradiction could persist for twelve consecutive hours.
 *
 *     RESOLVED MEANS THE PROBLEM IS GONE. A ROW THAT SAYS ITS OWN FIX IS UNDEPLOYED IS NOT GONE.
 *
 * -- THE RULE --------------------------------------------------------------------------------
 *
 * The expected-business shortcut still applies to everything it always did. It stops applying to
 * a row whose last remediation attempt reported that it is STILL BLOCKED. Such a row falls
 * through to the normal classification, where "the fix is written and needs a production deploy"
 * is routed to a person — which is what it is.
 *
 * Deliberately narrow: only `still-blocked` disarms it. An absent field, a completed action, or
 * anything else keeps the old behaviour exactly, because the failure being fixed is a row that
 * ANNOUNCED it was stuck and got muted anyway, not a row nobody has looked at yet.
 */
export function expectedBusinessApplies(inc, text = `${inc?.who_must_act || ''} || ${inc?.root_cause || ''} || ${inc?.title || ''}`) {
  if (!EXPECTED_BUSINESS.test(text)) return false
  if (String(inc?.action_taken || '').trim().toLowerCase() === 'still-blocked') return false
  return true
}

/** The PRESCRIBED ACTION, with the owner prefix and any of the drainer's own stuck preambles
 *  stripped. This — and only this — is what a gate is allowed to read. */
export function actionOf(inc) {
  return String(inc?.who_must_act || '')
    .replace(/^(?:Roger|Claude)\s*[-:]\s*board-drainer could not resolve after \d+ tries;\s*/gi, '')
    .replace(/^(?:Roger|Claude)\s*[-:]\s*auto-fix stuck[^;]*;\s*/gi, '')
    .replace(/^(?:Roger|Claude)\s*[-:]\s*/i, '')
    .trim()
}

/**
 * Remove every span that is CODE rather than prose, so a token inside a command, a path or an
 * identifier can never cast a vote. Rule 2 above, made mechanical.
 *
 * Order matters: paths go BEFORE anything else, or
 * `docs/support-kb/en/{refunds,payments-and-vat,pricing-and-plans}.md` survives as loose nouns.
 *
 * A snake_case token is DELETED here, never unpacked into words. Unpacking it was tried first and
 * it re-created the exact defect one layer down: `client_email` became "client email" and tripped
 * the customer-comms gate on `silent-failure/BackOffice:87dc7c8`, whose action is an RLS policy
 * migration and touches no customer. An identifier is code; code is not prose. (plainTitle() uses
 * its own softer pass, `prose()`, because a HUMAN reading a title does want "recurring costs".)
 */
export function stripCode(s) {
  return String(s || '')
    .replace(/`[^`]*`/g, ' ')                                             // `backticked code`
    .replace(/\$\{[^}]*\}/g, ' ')                                         // ${template} holes
    .replace(/(?:^|[\s(])--?[A-Za-z][\w-]*(?:=\S+)?/g, ' ')               // CLI flags: --delete, -f confirm=deploy
    .replace(/\b[A-Za-z]:[\\/][^\s,;)'"]+/g, ' ')                         // C:/Business/Internal Projects/...
    .replace(/\b[\w.@-]+(?:[\\/][\w.@{}*,-]+)+(?::\d+(?:-\d+)?)?/g, ' ')  // a/b/c.ts:105, docs/**, {a,b}.md
    .replace(/\b[\w-]+\.(?:ts|tsx|js|mjs|cjs|json|ya?ml|sql|md|py|sh|html|css|toml)\b(?::\d+(?:-\d+)?)?/gi, ' ')  // deploy.yml:864
    .replace(/\b\w+(?:_\w+)+\b/g, ' ')                                    // snake_case / SCREAMING_SNAKE identifiers
    .replace(/\b[0-9a-f]{7,40}\b/g, ' ')                                  // commit ids
    .replace(/\bL\d+\b/g, ' ')                                            // L211
    .replace(/(?:^|\s)[.\\/]+(?=\s|$)/g, ' ')                             // the punctuation a stripped path leaves behind
    .replace(/\s+/g, ' ')
    .trim()
}

/** A NEGATED or DISCLAIMED mention is not an instruction.
 *
 *  Two rows on the board say, in as many words, that they are NOT a human gate — "CI/infra class,
 *  no gate needed - nothing here needs Roger's hands" and "it is a SPEND decision for Roger, not
 *  the fix" — and the first version of this rewrite escalated both ON THE STRENGTH OF THE SENTENCE
 *  DENYING IT. So a hit whose preceding ~40 characters carry a negation, uninterrupted by a
 *  sentence break, does not count. */
const NEGATOR = /\b(?:no|not|nothing|never|neither|without|nor)\b[^.;!?]{0,40}$/i
function negated(text, index) {
  return NEGATOR.test(text.slice(Math.max(0, index - 60), index))
}

/** VERB adjacent to its OBJECT, in either order, with at most three words between them.
 *  Whitespace between the two is REQUIRED — which is why `decision/secret/payment/OAuth`, a
 *  slash-run of nouns in a sentence about gates, matches nothing. */
function adjacent(verbs, objects) {
  const v = `(?:${verbs.join('|')})`
  const o = `(?:${objects.join('|')})`
  const gap = `(?:\\s+[\\w'’-]+){0,3}\\s+`
  return new RegExp(`\\b${v}\\b${gap}${o}\\b|\\b${o}\\b${gap}${v}\\b`, 'i')
}

/**
 * The escalate classes, each one a thing a fix session may not do. Every entry is a VERB+OBJECT
 * pair or an explicit phrase; no entry is a bare noun, and that is the whole point.
 */
const GATES = [
  {
    id: 'destructive-db',
    label: 'destructive database work',
    tests: [
      adjacent(
        ['delet(?:e|es|ing)', 'drop(?:s|ping)?', 'truncat(?:e|es|ing)', 'purg(?:e|es|ing)', 'destroy(?:s|ing)?', 'wip(?:e|es|ing)', 'eras(?:e|es|ing)', 'alter(?:s|ing)?', 'remov(?:e|es|ing)'],
        ['rows?', 'records?', 'tables?', 'columns?', 'indexes', 'schemas?', 'databases?', 'buckets?', 'tenants?', 'user accounts?', 'customer data', 'production data'],
      ),
      /\b(?:run|apply|push|ship)\b[^.]{0,60}\bmigrations?\b[^.]{0,60}\b(?:prod|production)\b/i,
      // Bare SQL. `delete from` needs the lookahead: once a path is stripped, "delete
      // deploy.yml:864 from the prod-smoke step" collapses to "delete from the prod-smoke step",
      // and a naked `delete from` would call a workflow edit a table wipe — the same accident one
      // layer down.
      /\b(?:ddl|drop table|truncate table)\b/i,
      /\bdelete\s+from\b(?!\s+(?:the|a|an|this|that|its|our|their|it|there|here)\b)/i,
    ],
  },
  {
    id: 'secrets',
    label: 'a secret, key or credential',
    tests: [adjacent(
      ['rotat(?:e|es|ing)', 'revok(?:e|es|ing)', 'regenerat(?:e|es|ing)', 're-?issu(?:e|es|ing)', 'sets?', 'setting', 'creat(?:e|es|ing)', 'updat(?:e|es|ing)', 'replac(?:e|es|ing)', 'stor(?:e|es|ing)', 'adds?', 'unsets?', 'chang(?:e|es|ing)'],
      ['secrets?', 'credentials?', 'api keys?', 'access tokens?', 'service keys?', 'service role keys?', 'passwords?', 'private keys?', 'signing keys?', 'edge secrets?', 'env(?:ironment)? secrets?'],
    )],
  },
  {
    id: 'payments',
    label: 'money movement or a billing action',
    tests: [
      adjacent(
        ['pays?', 'paying', 'process(?:es|ing)?', 'refunds?', 'refunding', 'charg(?:e|es|ing)', 'purchas(?:e|es|ing)', 'buy(?:s|ing)?', 'subscrib(?:e|es|ing)', 'renew(?:s|ing)?', 'cancel(?:s|ling|ing)?', 'upgrad(?:e|es|ing)', 'downgrad(?:e|es|ing)', 'settl(?:e|es|ing)', 'transfers?'],
        ['invoices?', 'payments?', 'subscriptions?', 'plans?', 'cards?', 'bank transfers?', 'billing', 'refunds?', 'the bill'],
      ),
      /\b(?:issue|process|send)\s+(?:a|an|the|that|this)?\s*refunds?\b/i,
      adjacent(['opens?', 'log(?:s|ging)? into', 'uses?', 'issues?'], ['stripe dashboard', 'paypal dashboard', 'bank portal']),
    ],
  },
  {
    id: 'customer-comms',
    label: 'a message to a customer or a third party',
    tests: [adjacent(
      ['e-?mails?', 'e-?mailing', 'mails?', 'messages?', 'messaging', 'contacts?', 'notif(?:y|ies|ying)', 'writ(?:e|es|ing) to', 'repl(?:y|ies|ying) to', 'calls?', 'phones?', 'apologis(?:e|es)', 'apologiz(?:e|es)'],
      ['customers?', 'clients?', 'subscribers?', 'prospects?', 'leads?', 'third part(?:y|ies)', 'the users?', 'affected users?'],
    )],
  },
  {
    id: 'human-hands',
    label: 'an account or vendor action only Roger can perform',
    tests: [
      adjacent(
        ['re-?auth(?:enticate|orise|orize)?', 're-?connects?', 'connects?', 'authoris(?:e|es)', 'authoriz(?:e|es)', 'logs? ?in(?:to)?', 'signs? ?in(?:to)?', 'grants?', 'links?', 'consents?'],
        ['oauth', 'google account', 'google workspace', 'the account', 'his account', 'your account', 'the vendor', 'vendor portal', 'the dashboard', 'the console'],
      ),
      /\b(?:open|raise|reply to|answer|chase)\s+(?:a|the)\s+support ticket\b/i,
    ],
  },
  {
    id: 'business-decision',
    label: 'a decision only Roger can make',
    tests: [
      // Deliberately NOT `spend|budget|pricing decision`. Two live rows use those exact words to
      // NAME A BRANCH THEY ARE NOT TAKING ("hand Roger ONE spend decision, never a reading task";
      // "that … is a SPEND decision for Roger, not the fix"). A phrase that describes the class of
      // a hypothetical is not a request for a decision.
      /\bbusiness decisions?\b/i,
      // NOT `Roger gate`: the row that says "NOT a Roger gate" is the one asking to be given BACK
      // to the fixer, and matching it would invert the sentence it appears in.
      /\broger'?s?\s+(?:call|decision|approval|sign-?off)\b/i,
      /\bneeds?\s+(?:your|roger'?s?)\s+(?:approval|decision|sign-?off|hands|answer)\b/i,
      /\bone decision\b/i,
    ],
  },
]

/**
 * The gate a prescribed action trips, or null. Exported so a test can name the class AND the exact
 * span that tripped it — "it escalated" is not evidence, "it escalated on `rotate … service key`"
 * is.
 */
export function gateFor(inc) {
  const action = stripCode(actionOf(inc))
  if (!action) return null
  for (const g of GATES) {
    for (const re of g.tests) {
      // Every occurrence, not just the first: a sentence that disclaims a gate ("nothing here
      // needs Roger's hands") must not shadow a later one that genuinely asks for it.
      const all = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
      for (const m of action.matchAll(all)) {
        if (negated(action, m.index)) continue
        return { id: g.id, label: g.label, evidence: m[0].trim() }
      }
    }
  }
  return null
}

/**
 * A `Roger - ` prefix that the sentence itself DISOWNS.
 *
 * Three rows on the board today read "Roger - re-dispatch to a WRITE-authorized run … NOT a Roger
 * gate: no decision/secret/payment/OAuth". They are addressed to Roger because the run that wrote
 * them had no write tools — a fact about that RUN's permissions, never about who owns the work —
 * and a human then re-owned two of them by hand, twice, only for the next run to flip them back.
 * So an explicit Roger prefix still escalates, UNLESS the action says in as many words that the
 * reason was capability, AND no gate fires on it independently. A gate always outranks this.
 */
const CAPABILITY_REASON = /\b(?:not a roger gate|no (?:decision|secret|payment|oauth)\b|re-?dispatch(?:ed)? to a write|write-authoriz|verify-?only|lack(?:ed|s|ing) write tools|had no write tools|class[- ]?a (?:infra|ci|monitor))/i

/**
 * Every open incident is RE-VERIFIED against the live source each run — the root fix for the class
 * that bit us (a self-healed false-red sitting blocked because the email-driven Closer never
 * re-visited it).
 *
 * Returns `{ owner, mode, reason, gate, handoff }`.
 *   mode 'fix'     Claude-owned and safely fixable: full tools (in LIVE).
 *   mode 'verify'  read-only: may close-if-green or escalate, never fix.
 *   mode 'note'    expected business state: one idempotent write, no agent.
 *   handoff        true when this needs a HUMAN SESSION, not an agent run — B3 part 3 turns those
 *                  into work-board items instead of leaving them on the alarm surface.
 */
function classify(inc) {
  const text = `${inc.who_must_act || ''} || ${inc.root_cause || ''} || ${inc.title || ''}`

  // Expected business state wins over every other class — it is noted, never worked or escalated.
  // Unless our own remediation is still outstanding: see expectedBusinessApplies().
  if (expectedBusinessApplies(inc, text)) {
    return { owner: 'none', mode: 'note', gate: null, handoff: false, reason: 'expected business state (vendor plan/subscription lapsed) — noted, no action' }
  }

  const ownerRoger = /^roger\b/i.test((inc.who_must_act || '').trim())
  const gate = gateFor(inc)

  if (gate) {
    return {
      owner: 'roger', mode: 'verify', gate: gate.id, handoff: true,
      reason: `${gate.label} — ${gate.id} gate on "${gate.evidence}"`,
    }
  }
  if (ownerRoger) {
    if (CAPABILITY_REASON.test(actionOf(inc))) {
      return {
        owner: 'claude', mode: 'fix', gate: null, handoff: false,
        reason: 'addressed to Roger only because an earlier run had no write tools — re-queued to Claude, no human gate in the action',
      }
    }
    return { owner: 'roger', mode: 'verify', gate: 'owner-roger', handoff: true, reason: 'owner=Roger, and the action names no automatable path' }
  }
  return { owner: 'claude', mode: 'fix', gate: null, handoff: false, reason: 'owner=Claude, fixable' }
}


// ── B3 part 3: a signal that needs a PERSON becomes a WORK-BOARD ITEM ────────────────────
/**
 * Plan B, B3 part 3 (Cockpit/docs/PLAN-QUIET-BOARD-2026-08-27.md, approved 2026-08-27):
 * "a signal that needs a human session is not a signal, it is a task."
 *
 * The signals board exists to say something is wrong RIGHT NOW. An item waiting on Roger's
 * decision, his bank statement or his OAuth hands is not wrong right now — it is queued. Leaving
 * it on the alarm surface trains the reader to ignore the alarm surface, which is precisely how
 * 42 rows came to sit there with only 9 of them younger than a day.
 *
 * So a gated item is MOVED, not muted:
 *   1. a work-board item (`work_items`, sql/055) with a title in plain words and source 'monitor',
 *   2. the ready-to-paste session prompt attached to it as evidence,
 *   3. the signal set to `superseded` — resolved_at stamped, pending page cancelled, and out of
 *      the `state=in.(open,acknowledged)` query every board surface reads.
 *
 * IT IS NOT A CLOSE. `superseded` says "this lives somewhere else now", and if the underlying
 * check goes red again its producer writes state='open' and the row comes straight back — which is
 * right, and is why this is not a mute. The work item is minted once and only once (see
 * workItemSlugFor), so a row that flaps produces one task, not one per flap.
 *
 * WHAT DELIBERATELY DOES NOT HAPPEN: the row is NOT re-written through `upsert_incident`. That
 * adapter maps `blocked` back to state `open` (migration 142's CASE, the mirror's mapping before
 * it), so the write would un-supersede the signal on the same tick. The only statuses that map to
 * resolved are fixed / self-healed / expected, and this item is none of the three. A status
 * meaning "handed to a human queue" is a schema change in BackOffice, which this session does not
 * own — it is written up as the one change needed there.
 */
const HANDOFF_ENABLED = process.env.BOARD_DRAINER_HANDOFF !== '0'

/** Repos we can name a working directory for. A prompt that guesses a path is worse than one that
 *  says nothing, so an unknown product simply gets no working-directory line. */
const REPO_DIRS = {
  backoffice: 'BackOffice', replyflow: 'ReplyFlow', channelmover: 'ChannelMover',
  signalscore: 'SignalScore', scoutcopilot: 'ScoutCopilot', predivo: 'predivo',
  valrano: 'Valrano', boatbuddy: 'BoatBuddy', cockpit: 'Cockpit',
  'distribution-os': 'Distribution-OS', 'production-monitor': 'production-monitor',
  'pull-engine': 'pull-engine', launchready: 'launchready', arivioo: 'arivioo',
}

/** The repo this incident belongs to, from its key's first segment or its title. Null when we
 *  cannot say — never a guess. */
export function repoOf(inc) {
  const first = String(inc?.key || '').split(':')[0].trim().toLowerCase()
  if (REPO_DIRS[first]) return REPO_DIRS[first]
  const t = String(inc?.title || '')
  for (const [k, dir] of Object.entries(REPO_DIRS)) {
    if (new RegExp(`\\b${k.replace('-', '[- ]?')}\\b`, 'i').test(t)) return dir
  }
  return null
}

/**
 * The `opened_at` a freshly minted work item should carry, as a spreadable fragment: `{opened_at}`
 * when the signal's own first sighting is usable, and `{}` — meaning "let the column default to
 * now()" — when it is not.
 *
 * ONE DIRECTION ONLY. It can move an item's clock BACK to when the fault was actually first seen;
 * it can never move it forward. A first_seen_at in the future, or one that will not parse, is
 * refused rather than trusted, because the failure mode being fixed here is items looking YOUNGER
 * than they are and a bad value must not be able to deepen that.
 */
export function mintOpenedAt(inc, now = Date.now()) {
  const raw = inc?.opened_at
  if (!raw) return {}
  const t = Date.parse(raw)
  if (!Number.isFinite(t)) return {}
  if (t > now) return {}
  return { opened_at: new Date(t).toISOString() }
}

/**
 * A STABLE identity for "the work item that belongs to this signal".
 *
 * Derived from source+key, never from the title: titles on this board are rewritten constantly
 * (one row has been re-owned and re-worded four times in three days), and a title-derived slug
 * would mint a fresh item on every rewording. The readable stub is for a human scanning /work; the
 * hash is what actually makes it unique and stable.
 */
export function workItemSlugFor(inc) {
  const h = createHash('sha1').update(`${inc?.source || ''}|${inc?.key || ''}`).digest('hex').slice(0, 8)
  const stub = String(inc?.key || 'signal').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 38).replace(/-+$/, '')
  return `monitor-${stub || 'signal'}-${h}`
}

/** Product names that stay capitalised when everything else shouting in a title is calmed down. */
const KEEP_CAPS = new Set(['BackOffice', 'ReplyFlow', 'ChannelMover', 'SignalScore', 'ScoutCopilot',
  'Predivo', 'Valrano', 'BoatBuddy', 'Cockpit', 'GitHub', 'Google', 'Stripe', 'Supabase', 'Sentry',
  'Claude', 'Roger', 'Smartlead', 'PostHog', 'Playwright', 'OAuth', 'VAT', 'AI', 'CI', 'UX', 'E2E',
  'REST', 'API', 'SQL', 'RLS', 'FTP', 'SMTP', 'URL', 'SEO', 'MCP', 'PDF', 'DNS', 'HTTP', 'JWT'])

/**
 * Turn machine text into a sentence a person reads.
 *
 * Softer than stripCode() on purpose and for a different consumer: stripCode DELETES identifiers
 * because a gate must not vote on them, while a human reading "the recurring costs registry" is
 * better served than one reading a gap. Same removals for genuinely unreadable things — paths,
 * commit ids, flags, backticked code — plus the shouting calmed down.
 */
export function prose(s) {
  let out = String(s || '')
    .replace(/^\s*\[[^\]]{1,40}\]\s*/, '')                       // [commit-review] / [live] / [UX]
    .replace(/^\s*[A-Z][A-Z0-9]+-\d+\s*[-:]\s*/, '')             // REPLYFLOW-3 -
    .replace(/`[^`]*`/g, ' ')
    .replace(/(?:^|[\s(])--?[A-Za-z][\w-]*(?:=\S+)?/g, ' ')
    .replace(/\b[A-Za-z]:[\\/][^\s,;)'"]+/g, ' ')
    .replace(/\b[\w.@-]+(?:[\\/][\w.@{}*,-]+)+(?::\d+(?:-\d+)?)?/g, ' ')
    .replace(/\b[\w-]+\.(?:ts|tsx|js|mjs|cjs|json|ya?ml|sql|md|py|sh|html|css|toml)\b(?::\d+(?:-\d+)?)?/gi, ' ')
    .replace(/\b[0-9a-f]{7,40}\b/g, ' ')
    .replace(/\b\w+(?:_\w+)+\b/g, (m) => m.replace(/_/g, ' '))   // recurring_costs -> recurring costs
    .replace(/\(\s*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  // Calm the shouting: SCREAMING words read as an emergency and most of them are just emphasis.
  out = out.replace(/\b[A-Z][A-Z0-9]{2,}\b/g, (w) => (KEEP_CAPS.has(w) ? w : w.toLowerCase()))
  return out.replace(/\s+([,.;:])/g, '$1').replace(/^[\s,.;:-]+/, '').trim()
}

/**
 * The first sentence that actually SAYS something.
 *
 * Not simply the first: half the rows on this board open with a bookkeeping stamp the closer or a
 * previous drainer run wrote — "RE-OWNED 2026-08-25T02:55Z.", "RESTORED 19:50Z.", "DOWNGRADED
 * critical -> warning." Taking the first sentence blindly produced the title "RE-owned
 * 2026-08-25T02:55Z" for `BackOffice:b11c5d2`, which tells a reader nothing at all. So a stamp is
 * skipped, as is anything too short to be a sentence, and the first real one wins.
 */
const BOOKKEEPING = /^(?:re-?owned|restored|re-?verified|verified|unchanged|corrected|downgraded|upgraded|updated|measured|confirmed|note|status|as of)\b/i
function firstSentence(s) {
  const parts = String(s || '').split(/(?<=[.?!])\s+/)
  for (const raw of parts) {
    const p = raw.trim().replace(/[.]$/, '').trim()
    if (!p) continue
    if (BOOKKEEPING.test(p)) continue
    if (p.split(/\s+/).length < 6) continue
    return p
  }
  return (parts[0] || '').trim().replace(/[.]$/, '')
}

/**
 * WHY THE TITLE MUST PASS A TEST.
 *
 * Roger's rule (memory: "never hand Roger a task that is mine, in my vocabulary"): the one line on
 * /work has to be understandable in three seconds with no context. Every objection below is a way
 * a machine-written title fails that, and each one has a real example on the board today:
 * `[commit-review] BackOffice 62520d7: …`, `deploy.yml:864`, `AFFILIATE_ALERT_EMAIL`,
 * `if: steps.playwright-cache.outputs.cache-hit != 'true'`.
 */
export function titleObjections(title) {
  const t = String(title || '')
  const out = []
  if (!t.trim()) out.push('empty')
  if (t.length > 120) out.push(`too long (${t.length} chars, max 120)`)
  if (/[.?!]\s+\S/.test(t)) out.push('more than one sentence')
  if (/`/.test(t)) out.push('contains code (backticks)')
  if (/\[[^\]]+\]/.test(t)) out.push('contains a bracket tag')
  if (/[\w.-]+[\\/][\w.-]+/.test(t)) out.push('contains a file path')
  if (/\b[\w-]+\.(?:ts|tsx|js|mjs|cjs|json|ya?ml|sql|md|py|sh|html|css|toml)\b/i.test(t)) out.push('contains a filename')
  if (/:\d+\b/.test(t)) out.push('contains a line number')
  if (/\b[0-9a-f]{7,40}\b/.test(t)) out.push('contains a commit id')
  if (/\b\w+_\w+\b/.test(t)) out.push('contains an identifier')
  if (/(?:^|\s)--?[A-Za-z]/.test(t)) out.push('contains a command-line flag')
  if (/[{}();=<>|]/.test(t)) out.push('contains code punctuation')
  return out
}

/**
 * THE ONE LINE ROGER READS.
 *
 * Built from the PRESCRIBED ACTION first, not from the incident title, and that ordering is the
 * whole idea: the title describes what the machine found ("[commit-review] BackOffice 62520d7:
 * plus-tagged customer emails are counted as internal"), the action describes what HE has to do
 * ("open the recurring costs registry in BackOffice and enter the amount and renewal date for the
 * 4 unverified rows"). The second is the one that is readable in three seconds.
 *
 * Both candidates are run through titleObjections and the first CLEAN one wins. If neither is
 * clean the least-objectionable is still used — an item with an imperfect title beats a problem
 * rotting on the alarm board — but the objections are returned so the caller can record them as
 * evidence rather than let a bad title pass silently.
 *
 * @returns {{title:string, objections:string[], from:'action'|'title'|'fallback'}}
 */
export function plainTitle(inc) {
  const candidates = [
    { from: 'action', text: cap(firstSentence(prose(actionOf(inc)))) },
    { from: 'title', text: cap(firstSentence(prose(inc?.title))) },
  ].filter((c) => c.text)
  if (!candidates.length) {
    const t = cap(`Something on the monitoring board needs you: ${inc?.source || 'unknown'}`)
    return { title: t, objections: titleObjections(t), from: 'fallback' }
  }
  // The objections MUST be computed on the string that is actually used. An earlier version
  // measured them on the raw candidate and then shortened it, so a 138-character title from
  // `commit-review/Cockpit:2d2415c` was recorded as "too long" while the item carried a
  // perfectly legal 88-character one. A complaint about a string nobody will ever see is noise.
  for (const c of candidates) {
    if (!titleObjections(c.text).length) return { title: c.text, objections: [], from: c.from }
  }
  const best = candidates.map((c) => ({ ...c, obj: titleObjections(c.text) }))
    .sort((a, b) => a.obj.length - b.obj.length)[0]
  return { title: best.text, objections: best.obj, from: best.from }
}

/** Sentence-case, and short enough to read at a glance.
 *  Over-length is cut at the last CLAUSE boundary rather than mid-word: a title that stops at a
 *  comma is a shorter true sentence, while one that stops at character 120 ends in "…from Roge". */
function cap(s) {
  let t = String(s || '').trim()
  if (t.length > 120) {
    const cut = t.slice(0, 121)
    const clause = Math.max(cut.lastIndexOf(', '), cut.lastIndexOf('; '), cut.lastIndexOf(' - '), cut.lastIndexOf(': '))
    const word = cut.lastIndexOf(' ')
    t = t.slice(0, clause > 60 ? clause : (word > 60 ? word : 120))
  }
  t = t.trim().replace(/[\s,;:-]+$/, '')
  return t ? t[0].toUpperCase() + t.slice(1) : t
}

/**
 * The prompt a session is opened with. Deliberately plain text and deliberately COMPLETE: the
 * whole point of the hand-off is that Roger never has to reconstruct the context, so the original
 * prescribed action and the original diagnosis go in VERBATIM, uncleaned. The title is for him;
 * this is for the session he pastes it into.
 */
export function handoffPrompt(inc, cls) {
  const repo = repoOf(inc)
  const lines = []
  if (repo) lines.push(`Working directory: C:/Business/Internal Projects/${repo}`, '')
  lines.push(
    `This came off the fleet signals board, which routed it to you because it needs a person:`,
    `${cls?.reason || 'it needs a human decision'}.`,
    '',
    'WHAT TO DO (verbatim, as the monitor wrote it):',
    inc?.who_must_act || '(no action was recorded — diagnose from the evidence below first)',
    '',
    'WHAT WAS FOUND (verbatim):',
    inc?.root_cause || '(no diagnosis recorded)',
    '',
    'PROVENANCE:',
    `- fleet signal: ${inc?.source}/${inc?.key}`,
    `- severity ${inc?.severity || 'unknown'}, first seen ${inc?.opened_at || 'unknown'}`,
    `- the signal is marked superseded, not resolved: if the underlying check goes red again it comes straight back.`,
    '',
    'RULES: verify against the live system before believing any of the text above — it can be days',
    'old. Stage explicit paths only when you commit. Do not promote product code to production.',
  )
  return lines.join('\n')
}

// The terminal work_item statuses (Cockpit sql/055/062): once a row is here Roger has SIGNED IT
// OFF or dropped it. A signal that recurs against one of these must not be superseded onto the dead
// row — that is the silent-mute this module exists to avoid. Every other status is a live, visible
// item the signal can safely fold into.
const CLOSED_WORK_STATUSES = new Set(['done', 'abandoned'])

// ── the JOIN step: a signal about a job already in progress lands ON that job ──────────────
/**
 * Roger, closing the external-tools work 2026-08-27: "But why wasn't this added to the in
 * progress task in the first place?" One piece of work had fragmented into three board rows —
 * the in-progress item a session held, plus two monitor rows the drainer opened about the very
 * same object ("the currency fix is live on staging", "v_external_tools is readable by the anon
 * key") — each addressed to Roger, each looking blocked on him, while a session worked it three
 * feet away. Both signals were CORRECT; the FILING was wrong.
 *
 * So before minting a sibling row, the drainer looks for a LIVE in-progress item plainly about
 * the same object and attaches the signal to THAT as evidence instead. The matcher is
 * deliberately CONSERVATIVE: an over-eager join glues a real signal onto the wrong job and it
 * vanishes, which is worse than one extra row. When the match is ambiguous, it opens the row.
 */

// Segments too common to identify a job: repo roots, product names, and the handful of
// directory names every repo shares. A path overlap that consists ONLY of these is not a match —
// "both touch Cockpit/src" says nothing.
const GENERIC_SEGMENTS = new Set([
  'internal projects', 'business', 'c:', 'cockpit', 'backoffice', 'replyflow', 'channelmover',
  'signalscore', 'scoutcopilot', 'predivo', 'valrano', 'boatbuddy', 'distribution-os',
  'production-monitor', 'pull-engine', 'launchready', 'arivioo', 'scoutcopilot',
  'src', 'scripts', 'docs', 'lib', 'test', 'tests', 'sql', 'app', 'pages', 'components',
  'hooks', 'types', 'functions', 'supabase', 'workflows', 'e2e', 'data', 'public', 'dist',
])

// Words too generic to identify a job by a title match alone.
const JOIN_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'are', 'be', 'by', 'with',
  'from', 'it', 'its', 'this', 'that', 'has', 'have', 'was', 'were', 'not', 'now', 'fix', 'fixes',
  'fixed', 'page', 'error', 'errors', 'failed', 'failing', 'check', 'checks', 'data', 'code',
  'live', 'staging', 'production', 'prod', 'update', 'updated', 'add', 'added', 'new', 'old', 'run',
  'runs', 'job', 'jobs', 'task', 'tasks', 'work', 'board', 'signal', 'signals', 'monitor', 'test',
  'tests', 'build', 'deploy', 'value', 'values', 'number', 'row', 'rows', 'anyone', 'public', 'key',
])

function joinSegs(p) {
  return String(p || '').toLowerCase().split(/[\\/]+/).map((s) => s.trim()).filter(Boolean)
}

/** The segments of a path that could actually identify it: a filename (has a dot), a snake_case
 *  identifier (has an underscore), or a specifically-named directory. Repo roots and shared dir
 *  names are dropped, so a match on one of these means something. */
function distinctiveSegs(p) {
  return joinSegs(p).filter((s) => !GENERIC_SEGMENTS.has(s) && (s.includes('.') || s.includes('_') || s.length >= 5))
}

/** Object tokens named in a signal's text that can be matched against an item's claim_paths:
 *  file paths, bare filenames, and snake_case identifiers (tables/views/columns). */
export function signalObjects(inc) {
  const text = `${inc?.who_must_act || ''} ${inc?.root_cause || ''} ${inc?.title || ''} ${inc?.key || ''}`
  const out = new Set()
  for (const m of text.matchAll(/\b[\w.@-]+(?:[\\/][\w.@{}*,-]+)+(?::\d+(?:-\d+)?)?/g)) out.add(m[0])   // a/b/c.tsx, docs/**
  for (const m of text.matchAll(/\b[\w-]+\.(?:ts|tsx|js|mjs|cjs|json|ya?ml|sql|md|py|sh|html|css|toml)\b/gi)) out.add(m[0])  // deploy.yml
  for (const m of text.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)) out.add(m[0])                    // v_external_tools
  return [...out]
}

/** A signal object vs one claim_path: 1 = names the same FILE (or identical identifier segment),
 *  2 = shares a distinctive directory/identifier segment, 0 = no distinctive overlap. */
function pathMatchTier(o, c) {
  const od = distinctiveSegs(o), cd = new Set(distinctiveSegs(c))
  const shared = od.filter((s) => cd.has(s))
  if (!shared.length) return 0
  return shared.some((s) => s.includes('.') || s.includes('_')) ? 1 : 2
}

function normTitle(t) {
  return ` ${String(t || '').toLowerCase().replace(/[_-]+/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()} `
}

/** Distinctive two-word phrases from a signal, for a title match — plus any snake_case object
 *  rendered to words ("v_external_tools" -> "external tools"). Both words of a phrase must be
 *  content words, so a single common noun can never carry a match. */
export function signalPhrases(inc) {
  const base = `${prose(inc?.title || '')} ${prose(inc?.root_cause || '')} ${prose(inc?.who_must_act || '')}`
  const words = base.toLowerCase().replace(/[_-]+/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean)
  const phrases = new Set()
  for (let i = 0; i < words.length - 1; i++) {
    const a = words[i], b = words[i + 1]
    if (a.length < 3 || b.length < 3 || JOIN_STOPWORDS.has(a) || JOIN_STOPWORDS.has(b)) continue
    phrases.add(`${a} ${b}`)
  }
  for (const o of signalObjects(inc)) {
    if (!o.includes('_')) continue
    const p = o.replace(/^[a-z]_/, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim()
    if (p.split(' ').filter((w) => w.length >= 3 && !JOIN_STOPWORDS.has(w)).length >= 2) phrases.add(p)
  }
  return [...phrases]
}

/** The strongest way one signal matches one item, or null. Tier 1 (names a file/identifier it
 *  claims) > Tier 2 (shares a distinctive directory) > Tier 3 (a distinctive phrase in its title). */
export function matchItem(inc, item) {
  const claims = Array.isArray(item?.claim_paths) ? item.claim_paths : []
  let secondBest = null
  for (const o of signalObjects(inc)) {
    for (const c of claims) {
      const tier = pathMatchTier(o, c)
      if (tier === 1) return { tier: 1, evidence: `${o} ↔ ${c}` }
      if (tier === 2 && !secondBest) secondBest = { tier: 2, evidence: `${o} ↔ ${c}` }
    }
  }
  if (secondBest) return secondBest
  const title = normTitle(item?.title)
  for (const p of signalPhrases(inc)) {
    if (title.includes(` ${p} `)) return { tier: 3, evidence: `“${p}” in title` }
  }
  return null
}

/**
 * The single live in-progress item this signal should join, or null to open a row.
 *
 * `liveItems` is the set of items a session is actively working (the work_board view's
 * lane='in_progress', i.e. owner + activity inside 45 minutes). Only such items are ever a join
 * target — attaching to a blocked or queued row would just be a differently-shaped sibling.
 *
 * The ambiguity guard is load-bearing: if two live jobs match equally well, gluing to either one
 * could bury the signal on the wrong job, so it returns {ambiguous:true} and the caller opens the
 * row exactly as today.
 */
export function findJoinTarget(inc, liveItems) {
  const matches = []
  for (const item of (liveItems || [])) {
    if (!item || !item.owner_session || CLOSED_WORK_STATUSES.has(item.status)) continue
    const m = matchItem(inc, item)
    if (m) matches.push({ item, tier: m.tier, evidence: m.evidence })
  }
  if (!matches.length) return null
  const bestTier = Math.min(...matches.map((m) => m.tier))
  const top = matches.filter((m) => m.tier === bestTier)
  if (top.length !== 1) return { ambiguous: true, tier: bestTier, count: top.length }
  return top[0]
}

/** The evidence note a joined signal leaves on the in-progress item — the "the machines found
 *  something about this" marker the owning session sees without being paged. Deliberately NOT a
 *  page and NOT a blocked_owner: it is a heads-up on work already owned. */
export function joinMarker(inc, cls, join) {
  return [
    'The fleet monitor found something about the work you are on right now, and attached it here',
    'instead of opening a separate row addressed to Roger.',
    '',
    'WHAT IT FOUND (verbatim — verify it against the live system, it can be days old):',
    inc?.root_cause || inc?.title || '(no detail recorded)',
    inc?.who_must_act ? `\nPRESCRIBED ACTION (a lead): ${inc.who_must_act}` : '',
    '',
    `Why it landed on this item: ${join?.evidence || 'same subject'}.`,
    `Provenance: fleet signal ${inc?.source}/${inc?.key}, severity ${inc?.severity || 'unknown'}, first seen ${inc?.opened_at || 'unknown'}.`,
    'Your call whether it is in scope. If the underlying check goes red again, the signal returns on its own.',
  ].filter(Boolean).join('\n')
}

/**
 * Move one gated incident onto the work board. Every side effect arrives as an injected function,
 * so the decisions here are testable without a database and without a network.
 *
 * @param deps.findItem       (slug) => item|null
 * @param deps.createItem     (row)  => item
 * @param deps.addEvidence    (itemId, ev) => void
 * @param deps.supersedeSignal(inc, slug) => boolean
 * @returns {{created:boolean, slug:string, title:string, superseded:boolean, objections:string[], reason:string}}
 */
/**
 * WHICH PARKED FINDINGS ARE HANDED TO THE WORK BOARD THIS RUN, and in what order. Pure, because
 * the ordering is the whole safeguard and an ordering nobody can test is an ordering nobody knows.
 *
 * OLDEST-PARKED FIRST, deliberately, and for the same reason the 24-hour retry picks that end: the
 * one abandoned longest ago is the most neglected, not the one that happens to sort first by key.
 * An item whose park time is missing or unparseable sorts to the very front — an unrecorded park
 * is the most neglected case of all, so it must not sort to the back where nobody reaches it.
 *
 * `max = 0` (BOARD_DRAINER_PARKED_HANDOVER_PER_RUN=0) restores the old behaviour exactly: parked
 * findings stay parked. The suppression ships with the switch that turns it off, like every other
 * one in this file.
 */
export function parkedHandoverQueue({ parked, state, handoff = HANDOFF_ENABLED, max = MAX_PARKED_HANDOVER_PER_RUN }) {
  if (!handoff || !(max > 0) || !parked?.length) return []
  const stuck = state?.stuck || {}
  const parkedAtOf = (k) => { const t = Date.parse(stuck[k]?.at || ''); return Number.isNaN(t) ? 0 : t }
  return [...parked].sort((a, b) => parkedAtOf(a.inc.key) - parkedAtOf(b.inc.key)).slice(0, max)
}

export function handedOverClearsCounter(r) {
  // A signal that was HANDED OVER — superseded onto a freshly-minted item, freshly marked as
  // attached to a live job, or already attached to it on an earlier run — is off the drainer's
  // auto-fix hook, so its attempt counter and parked marker must be dropped. b9f5ff2 moved the
  // join path from returning `superseded` to returning `marked`/`alreadyAttached`, but the consumer
  // in main() still read only `superseded`, so a joined signal's counter was never cleared and
  // drifted toward the MAX_ATTEMPTS breaker on a later run instead of starting clean.
  return Boolean(r && (r.superseded || r.marked || r.alreadyAttached))
}

export async function routeToWorkBoard(inc, cls, deps) {
  const hashSlug = workItemSlugFor(inc)
  let slug = hashSlug
  const { title, objections, from } = plainTitle(inc)
  const existing = await deps.findItem(slug)

  let created = false
  let itemId = existing?.id ?? null
  let adopted = null
  if (existing && CLOSED_WORK_STATUSES.has(existing.status)) {
    // A RECURRENCE AFTER SIGN-OFF is new work, not the old item. Two wrong moves are possible here
    // and this branch refuses both: re-minting under the same slug would break idempotence and pile
    // duplicate rows onto a finished item; superseding the signal against that finished item would
    // MUTE a live problem — the producer set state='open' because the underlying check is red RIGHT
    // NOW, and there is no open work item anywhere to catch it, so the alarm would vanish from
    // /signals and the incident feed with nothing left standing. So do NOT supersede: return early
    // and leave the signal OPEN and loud. That restores the invariant handoffPrompt() promises —
    // "if the underlying check goes red again it comes straight back". Roger re-handles it from a
    // live, visible signal rather than from silence.
    deps.log?.(`    work item "${existing.slug}" is already ${existing.status} — this signal RECURRED after sign-off; leaving it OPEN, not superseding`)
    return { created: false, slug, title, superseded: false, objections, reason: 'recurred after sign-off — left open' }
  }
  if (existing) {
    // IDEMPOTENCE, and it is checked against the SLUG rather than the title precisely because the
    // title moves. An OPEN item (blocked/next/in_progress/awaiting_signoff) is left as-is and the
    // signal is superseded onto it — the work is already queued and visible. Only a CLOSED item is
    // handled above, because superseding onto a finished item is a silent mute.
    deps.log?.(`    already on the work board as "${existing.slug}" (${existing.status}) — not minting a second item`)
  } else {
    // ── ADOPT BEFORE MINTING ────────────────────────────────────────────────────────────────
    // No row exists under THIS hash. That is normally correct — but two known board defects make
    // it a lie, and both of them mint a duplicate task for work that already has one:
    //
    //   * A RENAMED KEY. The slug is sha1(source|key), so a signal's key IS its task identity. The
    //     2026-08-27 key-normalisation cutover renamed two commit-review keys and the next run
    //     minted twins under the new hashes, stranding the originals (4cc5f100, 48df96b6) that no
    //     producer could ever close again. The signal ROW survived that rename, and it is still
    //     carrying detail.work_item — an exact pointer the drainer wrote itself.
    //   * ONE FAULT, TWO CHANNELS. upsert_incident deduplicates on (source, key), so the same fault
    //     arriving by healthchecks mail and by backoffice mail is two rows, two hashes, two items.
    //     Measured 2026-09-02: 12 such pairs among 659 rows.
    //
    // So follow the pointer that already exists rather than guessing at a new one. This is
    // deliberately NOT the key-stem fallback that was proposed and rejected: a stem match silently
    // merges signals whose keys merely share a prefix, and a silent merge is worse than a duplicate
    // because a duplicate is visible. adoptionTarget matches only an exact stored pointer or an
    // exact whole-key equality, and refuses when the answer is ambiguous or the item is finished.
    if (deps.findAdoptableItem) {
      adopted = await deps.findAdoptableItem(inc)
      if (adopted?.slug) {
        slug = adopted.slug
        itemId = adopted.item?.id ?? null
        deps.log?.(`    ADOPTING existing work item "${adopted.slug}" instead of minting "${hashSlug}" (${adopted.via}: ${adopted.evidence})`)
      }
    }
    if (adopted?.slug) {
      // Fall through to the supersede at the bottom: the task already exists and is live, so the
      // signal is handed over onto it exactly as if this run had minted it. Nothing new is created
      // and the adopted item's own evidence trail is not spammed on every 20-minute tick.
    } else {
    // No row exists for THIS signal yet. Before minting a sibling on Roger's lane, look for a
    // LIVE in-progress item a session is already working that is plainly about the same object,
    // and attach the signal to THAT instead — this is the whole reason this step exists.
    const liveItems = deps.listLiveItems ? await deps.listLiveItems() : []
    const join = findJoinTarget(inc, liveItems)
    if (join && join.item && !join.ambiguous) {
      deps.log?.(`    joining live in-progress item "${join.item.slug}" (tier ${join.tier}: ${join.evidence}) — attaching as evidence, minting NO row and NOT touching its owner`)
      // ALREADY ATTACHED TO THIS EXACT JOB: say nothing more. Since a joined signal now stays in the
      // active band rather than being superseded, this code path runs again every 20 minutes for as
      // long as the finding is open, and re-attaching would put an identical marker on the item on
      // every run. The whole value of the marker is that the working session reads it once.
      if (inc.joined_to === join.item.slug) {
        deps.log?.('    already attached to that item on an earlier run — leaving it alone')
        return { created: false, joined: true, slug: join.item.slug, title: join.item.title, tier: join.tier, marked: false, alreadyAttached: true, objections: [], reason: `already attached to a live in-progress item (${join.evidence})` }
      }
      if (join.item.id) {
        await deps.addEvidence(join.item.id, {
          kind: 'note',
          title: 'The machines spotted something about this while you were on it',
          detail: joinMarker(inc, cls, join),
          verified: false,
        })
      }
      // QUIET, BUT STILL VISIBLE — Roger's decision, 2026-08-28, taken with the cost stated.
      //
      // This line used to call supersedeSignal, so ATTACHING was what muted the finding: state went
      // to 'superseded' and the signal dropped out of the `state=in.(open,acknowledged)` band every
      // board surface reads. From then on it lived only inside the item's evidence trail, and if the
      // owning session never read that trail and closed the job, a one-off observation was gone -
      // only a repeating check would ever bring it back. He was told exactly that and chose the
      // option that keeps it on /signals until a PERSON marks it handled.
      //
      // 'acknowledged', not 'open': it is in the active band, so it is still on the page, but it
      // reads as known and in hand rather than new and unclaimed. The page is suppressed the same
      // way superseding did it (pageFieldsOnSupersede), so nobody is woken - the whole point of the
      // join is that the work is already being done. Visible and silent are different properties,
      // and this is the line where they were being confused.
      const marked = await deps.markSignalJoined(inc, join.item.slug)
      return { created: false, joined: true, slug: join.item.slug, title: join.item.title, tier: join.tier, marked, objections: [], reason: `joined a live in-progress item (${join.evidence})` }
    }
    if (join && join.ambiguous) {
      deps.log?.(`    ${join.count} live in-progress items match at tier ${join.tier} — too ambiguous to join safely, opening a row instead`)
    }
    // The lane this minted item lands in is DERIVED from the classification, never hardcoded.
    // classify() already decided who this finding belongs to. The SECOND call site — the parked-
    // handover queue at :2634 — routes EVERY parked finding here regardless of cls.owner, so a
    // claude-owned dev task the auto-fixer merely gave up on would otherwise be re-minted onto
    // Roger's lane: work we own landing on his list. Mint from cls.owner instead:
    //   owner 'claude' -> status 'next', no blocked_owner (Cockpit sql/061 strips owner cols on 'next');
    //   anything else   -> status 'blocked' / blocked_owner 'roger', the lane Cockpit sql/062 shows him.
    // The safe default is Roger's lane: an unknown or absent owner is one a person should see, not one
    // silently parked on 'next' where nobody looks.
    const mintForClaude = String(cls?.owner || '').toLowerCase() === 'claude'
    // The board asks the reader to DO something, so blocked_question is the prescribed ACTION, not a
    // restatement of the problem. actionOf() strips the 'Roger -'/'Claude -' prefix; fall back to the
    // title only when the finding carries no action at all.
    const action = actionOf(inc)
    const laneFields = mintForClaude
      ? { status: 'next', blocked_question: action || title }
      : { status: 'blocked', blocked_owner: 'roger', blocked_question: action || title }
    const item = await deps.createItem({
      slug,
      title,
      kind: 'task',
      // THE CLOCK STARTS WHEN THE FAULT WAS FIRST SEEN, NOT WHEN THIS ROW WAS MINTED.
      //
      // work_items.opened_at defaults to now(), and this call omitted it, so a signal first seen
      // days ago produced an item that looked minted-this-minute. Two things read that column and
      // both were wrong because of it: the closer prefixes `[AGING Nh]` from opened_at (its own
      // prompt says "aging is computed from the board row's opened_at, so it survives inbox
      // churn"), and the drainer reads its queue `order=opened_at.asc`, so the oldest complaints
      // sorted as the newest.
      //
      // Measured on production 2026-09-02 before this line existed: of 36 open `monitor-*` items
      // that still had their signal, 18 understated their own age, by 93 hours on average and by
      // 348 hours — a fortnight — at worst. That is the defect filed as
      // monitoring-hygiene/closer-age-basis-reset-by-drainer-reminting, whose own measurements
      // were gemini 47.96h and recurring-costs 90.39h true against a much smaller reported age.
      //
      // NEVER FORWARD. `least(first_seen, now)` in effect: a first_seen_at in the future, or an
      // unparseable one, falls back to the column default rather than making an item look younger
      // than it is. Ageing an item is safe; rejuvenating one is the bug being fixed.
      ...mintOpenedAt(inc),
      // The lane is DERIVED (see laneFields above), not hardcoded. Cockpit sql/062 derives the lane
      // from `status`: only 'blocked'/'awaiting_signoff' reach 'your_turn' (needs_you=true) — where a
      // finding that genuinely needs Roger's hands must land (Dashboard tile, session-start NEEDS
      // ROGER, work_board). A claude-owned finding handed here by the parked-handover queue instead
      // gets 'next' (lane='next', needs_you=false), which is correct: the machine still owns it and it
      // must NOT sit on Roger's list. Nothing is lost either way: this item is minted with no
      // owner_session/claimed_at, and sql/061 only strips the owner columns on 'next' rows.
      source: 'monitor',
      opened_by: 'board-drainer',
      ...laneFields,
    })
    itemId = item?.id ?? null
    created = true
    deps.log?.(`    minted work item "${slug}": ${title}`)
    if (itemId) {
      await deps.addEvidence(itemId, {
        kind: 'note',
        title: 'PASTE THIS into a new session',
        detail: handoffPrompt(inc, cls),
        verified: false,
      })
      if (objections.length) {
        // A title that failed its own readability test says so ON THE ITEM. Silently shipping a
        // title full of file paths is the failure this guard exists to make visible.
        await deps.addEvidence(itemId, {
          kind: 'note',
          title: 'This title is not yet in plain words',
          detail: `Derived from the ${from}. Objections: ${objections.join('; ')}. Rename it with work_retitle.`,
          verified: false,
        })
      }
    }
    }
  }

  const superseded = await deps.supersedeSignal(inc, slug)
  return {
    created,
    slug,
    title,
    superseded,
    objections,
    // The slug this signal WOULD have minted under, kept so a log line can name both sides of an
    // adoption. Equal to `slug` on every ordinary run.
    hashSlug,
    adopted: adopted ? { via: adopted.via, evidence: adopted.evidence, slug: adopted.slug } : null,
    reason: adopted ? `adopted the existing work item (${adopted.via})` : (cls?.reason || 'needs a person'),
  }
}

/**
 * The LIVE wiring of those four injected functions.
 *
 * The work board (Cockpit sql/055: `work_items` + `work_evidence`) lives in the same BackOffice
 * Supabase as `fleet_signals`, so the drainer's existing secret reaches it and no new credential
 * is introduced — the same rule the work-board session hooks keep.
 *
 * Every one of these swallows its own failure and returns a falsy value. A hand-off that cannot be
 * written must leave the signal exactly where it was, LOUDLY: the failure mode to avoid above all
 * others is a signal quietly superseded into a work item that does not exist.
 */
export function workBoardDeps(secret, base = BO_BASE) {
  const H = { apikey: secret, Authorization: `Bearer ${secret}`, 'User-Agent': NON_BROWSER_UA, 'Content-Type': 'application/json' }
  return {
    log,
    async findItem(slug) {
      const res = await fetch(`${base}/rest/v1/work_items?slug=eq.${encodeURIComponent(slug)}&select=id,slug,status&limit=1`, { headers: H })
      if (!res.ok) throw new Error(`work_items read HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`)
      const rows = await res.json()
      return rows[0] || null
    },
    /**
     * The work item this signal already belongs to, read from EXACT stored pointers only.
     *
     * Two reads, both cheap, both by equality:
     *   1. this row's own detail.work_item (carried through as inc.joined_to) — survives a key
     *      rename, because renaming a key does not delete the row that holds the pointer;
     *   2. rows with the IDENTICAL key under a different source — the (source,key) split — and the
     *      items their pointers name.
     *
     * Every failure returns null, which means "mint a row exactly as before". That is the safe
     * direction and the only one: a read we could not complete must never be able to fold a live
     * signal into somebody else's task.
     */
    async findAdoptableItem(inc) {
      try {
        let pointerItem = null
        if (inc?.joined_to) {
          const r = await fetch(`${base}/rest/v1/work_items?slug=eq.${encodeURIComponent(inc.joined_to)}&select=id,slug,status,title&limit=1`, { headers: H })
          if (r.ok) pointerItem = (await r.json())[0] || null
          else log(`    could not read the stored work_item pointer (HTTP ${r.status}) — will mint rather than guess`)
        }
        const siblingItems = []
        if (inc?.key) {
          const r = await fetch(`${base}/rest/v1/fleet_signals?key=eq.${encodeURIComponent(inc.key)}&select=source,key,state,detail`, { headers: H })
          if (r.ok) {
            const rows = await r.json()
            const wanted = [...new Set(rows
              .filter((s) => s.source !== inc.source && s?.detail?.work_item)
              .map((s) => s.detail.work_item))]
            if (wanted.length) {
              const q = wanted.map((x) => `"${x}"`).join(',')
              const ri = await fetch(`${base}/rest/v1/work_items?slug=in.(${encodeURIComponent(q)})&select=id,slug,status,title`, { headers: H })
              if (ri.ok) {
                const items = await ri.json()
                const bySlug = new Map(items.map((i) => [i.slug, i]))
                for (const s of rows) {
                  const it = bySlug.get(s?.detail?.work_item)
                  if (it) siblingItems.push({ signal: s, item: it })
                }
              }
            }
          } else log(`    could not read same-key sibling signals (HTTP ${r.status}) — will mint rather than guess`)
        }
        return adoptionTarget(inc, { pointerItem, siblingItems })
      } catch (e) {
        log(`    adoption lookup failed (${String(e).slice(0, 120)}) — minting a row, which is the safe direction`)
        return null
      }
    },

    /** Active signal rows that carry a work-item pointer — the input to the closure sweep. The
     *  select carries last_seen_at, which boardQueryUrl does not: the whole sweep turns on being
     *  able to order "seen again" against "work finished". */
    async listPointedActiveSignals() {
      const res = await fetch(`${base}/rest/v1/fleet_signals`
        + `?select=id,source,key,title,state,detail,first_seen_at,last_seen_at`
        + `&state=in.(${[...ACTIVE_SIGNAL_STATES].join(',')})`, { headers: H })
      if (!res.ok) throw new Error(`fleet_signals read HTTP ${res.status}`)
      return await res.json()
    },

    /** The work_items rows for a set of slugs, in one read. */
    async findItemsBySlugs(slugs) {
      const list = [...new Set((slugs || []).filter(Boolean))]
      if (!list.length) return []
      const q = list.map((x) => `"${x}"`).join(',')
      const res = await fetch(`${base}/rest/v1/work_items?slug=in.(${encodeURIComponent(q)})&select=id,slug,status,title,closed_at,state_since`, { headers: H })
      if (!res.ok) throw new Error(`work_items read HTTP ${res.status}`)
      return await res.json()
    },

    /** Close one signal against its finished work item. PATCHed by primary key, so it can never
     *  touch a second row by accident the way a (source,key) filter could after a rename. */
    async resolveSignal(row, item, why) {
      const res = await fetchWithTransportRetry(`${base}/rest/v1/fleet_signals?id=eq.${encodeURIComponent(row.id)}`, {
        method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
        body: JSON.stringify(resolvedPatch({ row, item, why })),
      })
      if (!res.ok) throw new Error(`signal resolve HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`)
      return true
    },

    /**
     * The items a session is ACTIVELY working — read from the work_board VIEW, whose lane logic
     * (sql/066) already encodes "in progress right now" as owner_session set AND activity inside
     * 45 minutes. Reading the view rather than re-deriving that window keeps one definition of
     * "live" for the whole fleet. A read failure returns [] and is swallowed: a join we could not
     * check simply falls through to minting a row, which is the safe direction — never the reverse.
     */
    async listLiveItems() {
      try {
        const res = await fetch(`${base}/rest/v1/work_board?lane=eq.in_progress&select=id,slug,title,status,owner_session,claim_paths`, { headers: H })
        if (!res.ok) { log(`    could not read live in-progress items (HTTP ${res.status}) — will mint a row rather than risk a wrong join`); return [] }
        return await res.json()
      } catch (e) {
        log(`    could not read live in-progress items (${String(e).slice(0, 120)}) — will mint a row rather than risk a wrong join`)
        return []
      }
    },
    async createItem(row) {
      const res = await fetchWithTransportRetry(`${base}/rest/v1/work_items`, {
        method: 'POST', headers: { ...H, Prefer: 'return=representation' }, body: JSON.stringify(row),
      })
      if (!res.ok) throw new Error(`work_items insert HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
      const rows = await res.json()
      return rows[0] || null
    },
    async addEvidence(itemId, ev) {
      const res = await fetchWithTransportRetry(`${base}/rest/v1/work_evidence`, {
        method: 'POST', headers: { ...H, Prefer: 'return=minimal' },
        body: JSON.stringify({ item_id: itemId, kind: ev.kind, title: ev.title, detail: ev.detail, verified: false }),
      })
      if (!res.ok) log(`    evidence NOT attached (HTTP ${res.status}) — the item exists but carries no prompt yet`)
    },
    /**
     * `superseded`, never `resolved`. Resolved means the problem is gone; this problem is very
     * much still here, it simply lives on the work board now. The distinction is not cosmetic:
     * a person reading /signals can tell "fixed" from "handed over".
     *
     * Written as a direct PATCH rather than through upsert_incident because writing the INCIDENT
     * row fires the mirror trigger, which maps `blocked` back to `open` and would un-supersede the
     * signal on the same tick.
     *
     * THE PAGE IS NOT CANCELLED HERE ANY MORE — see pageFieldsOnSupersede.
     */
    async supersedeSignal(inc, slug) {
      const filter = `source=eq.${encodeURIComponent(inc.source)}&key=eq.${encodeURIComponent(inc.key)}`
      const cur = await fetch(`${base}/rest/v1/fleet_signals?select=id,state,detail,page_due_at,paged_at&${filter}`, { headers: H })
      if (!cur.ok) throw new Error(`signal read HTTP ${cur.status}`)
      const rows = await cur.json()
      if (!rows.length) { log(`    signal ${inc.source}/${inc.key} not found — nothing superseded`); return false }
      const page = pageFieldsOnSupersede(rows[0])
      if (page.kept) log(`    page for ${inc.source}/${inc.key} was still undelivered — LEFT ARMED, the hand-off does not silence it`)
      const res = await fetchWithTransportRetry(`${base}/rest/v1/fleet_signals?${filter}`, {
        method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
        body: JSON.stringify({
          state: 'superseded',
          resolved_at: new Date().toISOString(),
          page_due_at: page.page_due_at,
          page_suppressed_reason: page.page_suppressed_reason,
          detail: {
            ...(rows[0].detail || {}),
            ...parkedFields(null),
            work_item: slug,
            routed_to_work_board_at: new Date().toISOString(),
          },
        }),
      })
      if (!res.ok) throw new Error(`signal supersede HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`)
      return true
    },

    /**
     * ATTACHED TO A LIVE JOB, AND STILL ON THE PAGE. Roger's decision, 2026-08-28: "attach it to the
     * job as it does now, but the signal stays open on /signals until a person marks it handled."
     *
     * The difference from supersedeSignal, and it is the only difference: `acknowledged` instead of
     * `superseded`, and no resolved_at. Every board surface reads
     * `state=in.(open,acknowledged)`, so an acknowledged signal is still THERE - it simply reads as
     * known and in hand rather than new and unclaimed. Superseding removed it from that band, which
     * is why attaching used to be what muted the finding.
     *
     * IT STILL DOES NOT PAGE. The page fields are computed by exactly the same helper the supersede
     * path uses, so an undelivered page stays armed on its original schedule and a delivered one
     * stays cancelled. Nobody is woken because the work is already being done - that was never the
     * part in question. Visible and silent are different properties.
     *
     * IDEMPOTENT. Two drainer runs that both attach the same finding to the same item write the
     * same row twice and change nothing: the state is already `acknowledged`, `work_item` is
     * already this slug, and `joined_at` is only stamped when it is not already set, so re-running
     * does not keep moving the clock on how long this has been sitting there.
     */
    async markSignalJoined(inc, slug) {
      const filter = `source=eq.${encodeURIComponent(inc.source)}&key=eq.${encodeURIComponent(inc.key)}`
      const cur = await fetch(`${base}/rest/v1/fleet_signals?select=id,state,detail,page_due_at,paged_at&${filter}`, { headers: H })
      if (!cur.ok) throw new Error(`signal read HTTP ${cur.status}`)
      const rows = await cur.json()
      if (!rows.length) { log(`    signal ${inc.source}/${inc.key} not found — nothing to mark as joined`); return false }
      const page = pageFieldsOnSupersede(rows[0])
      if (page.kept) log(`    page for ${inc.source}/${inc.key} was still undelivered — LEFT ARMED, joining does not silence it`)
      const detail = rows[0].detail || {}
      const res = await fetchWithTransportRetry(`${base}/rest/v1/fleet_signals?${filter}`, {
        method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
        body: JSON.stringify({
          state: 'acknowledged',
          page_due_at: page.page_due_at,
          page_suppressed_reason: page.page_suppressed_reason,
          detail: {
            ...detail,
            ...parkedFields(null),
            work_item: slug,
            joined_at: detail.joined_at || new Date().toISOString(),
            routed_to_work_board_at: new Date().toISOString(),
          },
        }),
      })
      if (!res.ok) throw new Error(`signal join HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`)
      log(`    signal ${inc.source}/${inc.key} marked as attached to "${slug}" — still on /signals until a person ticks it off`)
      return true
    },
  }
}

/**
 * THE REVERSE LINK: a finished work item closes the signal(s) it was handed.
 *
 * routeToWorkBoard writes the forward link — signal -> work item — and until now nothing ever
 * walked it back. So a complaint stayed in the active band after the work fixing it was signed off,
 * and anything that re-derives work from open signals could mint a fresh question about a problem
 * that no longer existed. That is not hypothetical: on 2026-09-02 at 04:07:39Z an overnight session
 * put commit-review/BackOffice:e2492d9:health-monitor-has-no-page-policy-row back on Roger's lane,
 * opening with a clause that stopped being true when the paging rule went live at
 * 2026-09-01 20:45:30Z. A person resolved that row by hand at 06:08:36Z.
 *
 * EVERY ROW FOR THE ENTITY, NOT JUST ONE. Because upsert_incident deduplicates on (source, key),
 * one fault reported through two channels is two rows and only one of them carries the pointer.
 * Closing that one would leave its twin sitting open saying the same thing. sameEntitySignals()
 * gathers both, by exact key equality.
 *
 * WHAT IT REFUSES TO DO. It never resolves a row whose producer has seen it AFTER the work
 * finished — that is a recurrence and it stays loud. See closurePlan(), which is where that guard
 * lives and where it is tested.
 *
 * SCOPE, chosen deliberately: the ACTIVE band only (open + acknowledged). A `superseded` row is
 * already off every board surface and costs nobody anything, so sweeping the several hundred
 * historical ones would be a bulk rewrite of rows that are not hurting anyone — and this defect is
 * specifically about a complaint that stays VISIBLE and gets re-derived. The rows that are both
 * pointed and active are exactly the two populations that matter: a signal its producer re-opened
 * after the hand-off, and a signal ATTACHED to a live job. The second is worth spelling out,
 * because Roger's 2026-08-28 decision was that a joined signal stays on /signals "until a person
 * marks it handled" — and a person signing off the work item it is attached to IS that person
 * marking it handled. This closes it on his own terms rather than around them.
 */
export async function sweepFinishedWork(deps, { dryRun = false } = {}) {
  const out = { checked: 0, entities: 0, resolved: [], keptOpen: [], errors: [] }
  let signals
  try {
    signals = await deps.listPointedActiveSignals()
  } catch (e) {
    // A read failure is reported, never swallowed into a green "nothing to do" — a sweep that
    // reports success for doing nothing is worse than one that fails.
    out.errors.push(`could not read active signals: ${String(e).slice(0, 160)}`)
    return out
  }
  const pointed = signals.filter((s) => s?.detail?.work_item)
  out.checked = pointed.length
  const slugs = [...new Set(pointed.map((s) => s.detail.work_item))]
  if (!slugs.length) return out

  let items
  try {
    items = await deps.findItemsBySlugs(slugs)
  } catch (e) {
    out.errors.push(`could not read work items: ${String(e).slice(0, 160)}`)
    return out
  }

  const handled = new Set()
  for (const item of items) {
    const plan = closurePlan({ item, signals })
    if (plan.skipped) continue
    out.entities++
    for (const k of plan.keepOpen) {
      if (handled.has(k.row.id)) continue
      handled.add(k.row.id)
      out.keptOpen.push({ source: k.row.source, key: k.row.key, item: item.slug, why: k.why })
      deps.log?.(`    LEFT OPEN ${k.row.source}/${k.row.key} — ${k.why}`)
    }
    for (const r of plan.resolve) {
      if (handled.has(r.row.id)) continue
      handled.add(r.row.id)
      if (dryRun) {
        out.resolved.push({ source: r.row.source, key: r.row.key, item: item.slug, via: r.via, dryRun: true })
        deps.log?.(`    would RESOLVE ${r.row.source}/${r.row.key} (${r.via}) — ${r.why}`)
        continue
      }
      try {
        await deps.resolveSignal(r.row, item, r.why)
        out.resolved.push({ source: r.row.source, key: r.row.key, item: item.slug, via: r.via })
        deps.log?.(`    RESOLVED ${r.row.source}/${r.row.key} (${r.via}) — ${r.why}`)
      } catch (e) {
        out.errors.push(`${r.row.source}/${r.row.key}: ${String(e).slice(0, 160)}`)
      }
    }
  }
  return out
}

// ── Tier-B agent policy (the boundary is enforced here + in allowedTools) ─────────────────
const SYSTEM_POLICY = `You are the Board Drainer remediation agent for a fleet of production SaaS apps (ReplyFlow, ChannelMover, SignalScore, ScoutCopilot, Predivo, BackOffice, Valrano, BoatBuddy, etc.). You are handed ONE open incident from the cockpit Monitoring Board. Diagnose it against the LIVE system and remediate it WITHIN STRICT policy, then write a verdict. You run headless with real write access; act conservatively and deterministically. Global rules in ~/.claude/CLAUDE.md apply (verify before claiming; full deploy pipeline; never guess).

STEP 1 — DIAGNOSE from the live system, never from the incident text alone. Read the relevant repo under C:/Business/Internal Projects/<project>/, check recent git log, query the live DB/API/site, inspect the failing CI run. The incident's root_cause is a LEAD.

STEP 2 — CLASSIFY and take ONLY the permitted action:
  A. MONITOR/SPEC/CI/CONFIG/PIPELINE fix (stale test assertion, broken CI step, missing committed file, stale threshold, gitignored-path crash, a recurring false-red = a monitor bug): FIX it in the owning repo, commit (message prefixed "[board-drainer] "), push, and DEPLOY IT (incl. production for these low-blast-radius classes). Verify green after.

     HOW TO COMMIT (hard rule, added 2026-08-20). You are very often NOT alone in that repo: a human-driven session may be working in it at the same moment. Therefore:
       - Stage EXPLICIT PATHS ONLY: 'git add <the exact files you edited>'. NEVER 'git add -A', 'git add .', or 'git commit -a'. On 2026-08-20 a session used 'git add -A' in production-monitor and silently swept another session's in-progress file into its commit; the commit message then described work it did not contain.
       - NEVER commit a file you did not yourself modify in this run. If 'git status' shows changes you did not make, they belong to someone else. Leave them.
       - If a file you NEED to change already has uncommitted changes you did not make, STOP and ESCALATE (class D). Do NOT stash, do NOT reset, do NOT overwrite: that destroys work in progress that exists nowhere else.
       - 'git pull --rebase' before pushing if the push is rejected. Never force-push.
     A push may cancel another run's in-flight CI via concurrency groups. That is acceptable and self-correcting (it costs a re-run). Absorbing or destroying someone else's uncommitted work is NOT.
  B. PRODUCT-CODE behavior fix (the app itself is genuinely wrong): fix it and deploy to STAGING only. Then ESCALATE the production promotion — do NOT promote product code to prod. (For staging-first projects prod promotion is 'gh workflow run deploy.yml -f confirm=deploy' — you must NEVER run that form for a product repo; that is Roger's gate.)
  C. FALSE-RED / SELF-HEALED (the source is GREEN now): confirm green with a real receipt (repro / live check / observed green run), then CLOSE it. NEVER close on a shallow "looks fine".
  D. LOW-CONFIDENCE / AMBIGUOUS root cause, OR the fix needs a destructive DB op / secret / payment / customer email / a business decision / Roger's OAuth hands: DO NOT act. ESCALATE with a written root-cause hypothesis and the exact one-line action for Roger.

HARD RULES (never violate):
- NEVER a destructive DB/DDL op (delete/drop/update prod rows, migrations to prod). Escalate instead.
- NEVER rotate/set a secret or key; NEVER a payment; NEVER email/message a customer or third party.
- NEVER promote PRODUCT code to production (staging is the ceiling for product fixes). Monitor/infra classes may deploy to prod.
- Bound your work; do not loop. If unsure between two classes, prefer the more conservative (escalate).

PROD EDGE-FUNCTION DEPLOYS (the ONLY permitted path — guarded, Roger-approved 2026-08-20): if the fix requires deploying a Supabase edge function to PROD, you MUST use the guard, never the supabase CLI directly:
  node scripts/prod-deploy-guard.mjs --project <ref> --function <name> --repo <abs repo path> --probe-url <url> [--probe-expect <substring>] [--probe-header "Name: value"] [--note "<what+why>"]
The guard enforces: hard-coded allowlist (ReplyFlow monitor-sync-health; BackOffice monitoring-board — anything else, health-monitor now included, is REFUSED), 2 real deploys/day cap, clean+in-sync repo (local HEAD == origin, so it can only ship the committed, pushed, CI-green commit — never a stale checkout), green CI, then a mandatory post-deploy probe with auto-rollback. Export SUPABASE_ACCESS_TOKEN (from that repo's docs/Credentials.txt) before calling it; run --dry-run first if unsure. Closing rule: an incident needing a prod deploy may only be closed status=fixed when the guard exits 0 AND its probe evidence is your receipt. Exit 2 = rolled back -> escalate, do NOT close. Exit 1 = refused/error -> do NOT deploy; if the function is not allowlisted, escalate to Roger instead.
${DEPLOY_DENY_POLICY_NOTE.trim()}

FINAL ACTION (required): use the Write tool to write ${VERDICT_PATH.replace(/\\/g, '/')} as JSON:
{"class":"A-INFRA|B-PRODUCT-STAGED|C-CLOSED|D-ESCALATE","status":"fixed|self-healed|blocked|investigating","action":"what you did (commit sha / PR url / deploy run / none)","receipt":"the concrete verification that proves it (repro output / live check / green run id) — REQUIRED to set status=fixed/self-healed","who_must_act":"required when status=blocked, else null — and the OWNER PREFIX must name the real blocker: 'Roger - <one-line naming the human gate>' ONLY when a genuine human gate blocks it (prod-deploy-guard allowlist, payment, OAuth, a secret, a business decision); 'Claude - <the reason, named>' when the blocker is THIS RUN's missing tools or permissions (a capability block re-queues to a write-enabled run — it is never Roger's)","diagnosis":"1-3 sentences"}`

function buildUserPrompt(inc) {
  return [
    'Remediate this Monitoring Board incident per policy. Diagnose from the live system first.\n',
    `- source: ${inc.source}`,
    `- key: ${inc.key}`,
    `- title: ${inc.title}`,
    `- severity: ${inc.severity}`,
    `- status: ${inc.status}`,
    `- opened_at: ${inc.opened_at}`,
    `- prescribed action (a LEAD): ${inc.who_must_act || '(none)'}`,
    `- root_cause (a LEAD): ${inc.root_cause || '(none)'}`,
  ].join('\n')
}

// Read-only investigation + Write(verdict). Live mode adds edit/commit/push/PR/deploy verbs.
// NOTE: no destructive DB / secret / payment verb is ever in this list; those classes escalate.
const READ_ONLY = [
  'Read', 'Grep', 'Glob', 'Write',
  'Bash(gh api:*)', 'Bash(gh run view:*)', 'Bash(gh run list:*)', 'Bash(gh pr list:*)',
  'Bash(curl:*)', 'Bash(cat:*)', 'Bash(ls:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git diff:*)', 'Bash(git status:*)',
]
const WRITE = [
  'Edit', 'Bash(git:*)', 'Bash(gh pr:*)', 'Bash(gh workflow run:*)', 'Bash(node:*)', 'Bash(npm:*)', 'Bash(npx:*)',
]

/**
 * The deny list that keeps this agent off a production edge function now lives in ONE
 * place, scripts/lib/deploy-deny-tools.mjs, because three sibling dispatchers
 * (deploy-failure-triage, agent-triage, local-triage-runner) hand out the same WRITE
 * verbs and need the same block. Re-exported here so the drainer's own test suite keeps
 * importing it from the script it guards. Read that module for the full why.
 */
export { DEPLOY_DENY_TOOLS, agentToolFlags }

function dispatchAgent(inc, mode) {
  try { if (existsSync(VERDICT_PATH)) rmSync(VERDICT_PATH) } catch { /* noop */ }
  let timedOut = false
  // FIX mode + LIVE gets write/deploy verbs; VERIFY mode is read-only (can only close-if-green or escalate).
  const canWrite = LIVE && mode === 'fix'
  const allowedTools = (canWrite ? [...READ_ONLY, ...WRITE] : READ_ONLY).join(',')
  const VERIFY_NOTE = '\n\n🔎 VERIFY-ONLY mode: you may ONLY (C) confirm the source is GREEN now and CLOSE it (status=self-healed, with a real receipt), or (D) ESCALATE (status=blocked). You may NOT fix, edit, deploy, or open PRs — you have no write tools. When you escalate, name the OWNER honestly: if the blocker is that THIS run lacks write tools, who_must_act is "Claude - <what a write-enabled run must do>" — a capability block re-queues to a write-enabled run, it is NOT a Roger gate. Only a genuine human gate (payment, OAuth, a secret, a decision, the prod-deploy-guard allowlist) earns "Roger - <which gate>".'
  const DRY_NOTE = '\n\n⚠️ DRY RUN: investigate READ-ONLY. Do NOT edit/commit/push/deploy/open PRs. Write ONLY the verdict file, and in "action" describe what you WOULD do, prefixed "[DRY-RUN would] ".'
  let policy = SYSTEM_POLICY
  if (mode === 'verify') policy += VERIFY_NOTE
  if (!LIVE) policy += DRY_NOTE
  // process.execPath is the node already running this file, so nothing hard-codes a node path;
  // everything after `--` is the engine's own argv, unchanged.
  const args = [
    AGENT_RUN, '--job', AGENT_RUN_JOB, '--',
    '-p', buildUserPrompt(inc),
    '--append-system-prompt', policy,
    ...agentToolFlags(allowedTools),
    // agent-run builds the Kimi write roots (KIMI_JOB_WRITE_ROOTS) from these and REFUSES a Kimi
    // launch without at least one (2026-08-31, the board-drainer Kimi profile): the repos it may
    // fix, plus its own verdict/state directory. On Claude they are advisory; on Kimi they are
    // the boundary the profile's Write/Edit tools are bounded by.
    '--add-dir', 'C:/Business/Internal Projects',
    '--add-dir', 'C:/Business/_board-drainer',
    '--max-turns', String(MAX_TURNS),
    '--model', MODEL,
    '--output-format', 'json',
  ]
  try {
    execFileSync(process.execPath, args, {
      stdio: ['ignore', 'inherit', 'inherit'],
      timeout: AGENT_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      // ALWAYS the subscription CLI, never a metered key. Roger's standing rule, 2026-08-29:
      // the API key is only for work a customer triggers inside a product. This drainer can run
      // for hours unattended, so a stray key here is the most expensive one in the fleet.
      env: (() => {
        const e = { ...process.env, GIT_AUTHOR_NAME: 'Board Drainer', GIT_AUTHOR_EMAIL: 'noreply@predivo.ch', GIT_COMMITTER_NAME: 'Board Drainer', GIT_COMMITTER_EMAIL: 'noreply@predivo.ch' }
        delete e.ANTHROPIC_API_KEY
        delete e.ANTHROPIC_AUTH_TOKEN
        delete e.ANTHROPIC_BASE_URL
        return e
      })(),
    })
  } catch (e) {
    // execFileSync THROWS on a non-zero exit; the code is on err.status. 76 is not an error at
    // all: the cockpit switch is off, so nothing was spawned. Return the sentinel and let the
    // caller stop the run - do NOT fall through to the timeout bookkeeping below.
    if ((e?.status === SWITCHED_OFF_EXIT || e?.status === NO_CAPACITY)) {
      log('  automations are switched off in the cockpit - no agent dispatched (a deliberate off, not a failure)')
      return AGENT_SWITCHED_OFF
    }
    log(`  agent errored/timed out: ${(e.message || '').split('\n')[0]}`)
    timedOut = true
  }
  if (existsSync(VERDICT_PATH)) {
    // An agent that timed out MAY still have written a verdict before it was killed. A real
    // verdict always wins over the timeout: it is the work actually done.
    try { return JSON.parse(readFileSync(VERDICT_PATH, 'utf-8')) } catch { /* malformed */ }
  }
  return timedOut ? AGENT_TIMED_OUT : null
}

// ── write-back: turn the agent verdict into a board state transition ──────────────────────
/**
 * @param {object} parkedBefore  the item's parked marker (`state.stuck[key]`) at the moment the
 *   agent was dispatched, or null when it was not parked. Only the 24-hour scheduled retry ever
 *   passes a non-null one. The rule it encodes: a retry that CLOSED the item un-parks it; a retry
 *   that did not leaves it parked, because one more failed try is not progress. Everything else
 *   publishes `parked: false` — which is what un-parks a revived item, and what keeps a stale
 *   flag from surviving on a merged detail (see parkedFields).
 */
function verdictToUpsert(inc, verdict, parkedBefore = null) {
  // Guard: fixed/self-healed REQUIRES a receipt — never close on a shallow verdict.
  let status = verdict.status
  if ((status === 'fixed' || status === 'self-healed') && !(verdict.receipt || '').trim()) {
    status = 'investigating'   // no receipt -> refuse to close; leave visible with progress
  }
  const sev = status === 'blocked' ? (inc.severity || 'warning') : 'warning'
  const closed = status === 'fixed' || status === 'self-healed'
  const stillParked = Boolean(parkedBefore) && !closed
  return {
    p_source: inc.source,
    p_key: inc.key,
    p_title: inc.title,
    p_severity: sev,
    p_status: status,
    p_root_cause: `[board-drainer ${new Date().toISOString().slice(0, 16)}] ${verdict.diagnosis || ''} | ${verdict.action || ''}${verdict.receipt ? ' | receipt: ' + verdict.receipt : ''}`.slice(0, 2000),
    p_who_must_act: status === 'blocked' ? (verdict.who_must_act || inc.who_must_act || null) : null,
    p_evidence: {
      by: 'board-drainer', class: verdict.class, action: verdict.action, receipt: verdict.receipt || null,
      ...parkedFields(stillParked ? { parked: true, at: parkedBefore.at, attempts: parkedBefore.attempts } : null),
    },
  }
}

/** Pure form of the stuck-escalation ownership decision, exported for tests.
 *  Strips any previous stuck prefix (so it can never compound) and then KEEPS a closer-written
 *  owner prefix instead of re-deriving one — a human who wrote "Roger - …" meant it, and the
 *  old re-derivation flipped those rows back to Claude on every stuck pass, so a write-enabled
 *  run kept grabbing work it could never finish. Two exceptions, both mirroring classify():
 *  a hard GATE always outranks any prefix (a secret rotation is Roger's no matter what the
 *  prefix says — the old noun list re-owned "delete deploy.yml:864" to Roger every time an item
 *  went stuck, which is how a one-line CI edit acquired a human owner), and a Roger prefix the
 *  sentence itself DISOWNS ("…NOT a Roger gate: no decision/secret/payment/OAuth") means the
 *  block was that RUN's missing write tools, so the row goes back to Claude. Only when there is
 *  no explicit owner at all is one derived from the gates. */
export function stuckWhoMustAct(whoMustAct) {
  const stripped = String(whoMustAct || 'investigate manually')
    .replace(/^(?:Roger|Claude)\s*[-:]\s*board-drainer could not resolve after \d+ tries;\s*/gi, '')
    .replace(/^(?:Roger|Claude)\s*[-:]\s*auto-fix stuck[^;]*;\s*/gi, '')
    .trim()
  const pm = stripped.match(/^(Roger|Claude)\s*[-:]\s*/i)
  const explicitOwner = pm ? pm[1][0].toUpperCase() + pm[1].slice(1).toLowerCase() : null
  const priorAction = (pm ? stripped.slice(pm[0].length) : stripped).trim()
  // Same gate as classify(), for the same reason.
  const gate = gateFor({ who_must_act: priorAction })
  const owner = gate ? 'Roger'
    : explicitOwner === 'Roger' && CAPABILITY_REASON.test(priorAction) ? 'Claude'
    : explicitOwner || 'Claude'
  return { owner, priorAction, value: `${owner} - ${priorAction}` }
}

/** The root_cause written when an item is escalated as auto-fix-stuck. The ORIGINAL diagnosis is
 *  PRESERVED verbatim and the stuck note is APPENDED — replacing it with a bare stub was the
 *  `board-drainer-stuck-stub-erases-root-cause` bug (a human landed on the row and the real
 *  diagnosis was gone). Idempotent: a previously-appended note is stripped before re-appending, so
 *  a RESET_STUCK re-escalation cannot stack notes or lose the true original underneath them. */
export function stuckRootCause(inc, attempts, intervalMs = PARKED_RETRY_INTERVAL_MS) {
  const note = `[board-drainer] auto-fix STUCK after ${attempts} attempts — the action below still stands, it just could not be applied automatically. It is retried automatically within ${intervalMs / 3600_000}h, or immediately with "Hand to Claude" on /signals.`
  const original = String(inc?.root_cause || '')
    .replace(/\n*\[board-drainer\] auto-fix STUCK after \d+ attempts[\s\S]*$/, '')
    .trim()
  return (original ? `${original}\n\n${note}` : note).slice(0, 2000)
}

/** Returned by dispatchAgent when the agent never got to produce a verdict at all — a 12-minute
 *  execFileSync timeout or a spawn failure. Distinct from `null`, which means the agent RAN and
 *  chose to say nothing. */
export const AGENT_TIMED_OUT = Symbol.for('board-drainer.agent-timed-out')

/** Returned by dispatchAgent when agent-run exited 76: Roger has switched the automations off in
 *  the cockpit. Nothing ran, so this is neither a timeout nor a failed attempt - the run stops
 *  where it is, charges nobody an attempt, alarms nothing, and ends at exit 0. */
export const AGENT_SWITCHED_OFF = Symbol.for('board-drainer.automations-switched-off')

/**
 * Should a timed-out dispatch cost the item one of its MAX_ATTEMPTS tries?
 *
 * WHY THIS EXISTS (2026-08-24). Roughly 1 in 6 dispatches ends `spawnSync claude.exe ETIMEDOUT`
 * (open item since 2026-08-15). Before today that only wasted a run: a stuck item was
 * re-escalated forever, so it would be tried again. Now that stuck items are PARKED — which is
 * the fix for the 30-hour deadlock — burning an attempt on infrastructure flakiness can park a
 * perfectly fixable item that was never actually diagnosed. The deadlock fix must not introduce
 * a quieter version of the same failure.
 *
 * So a timeout is FREE, but not infinitely free: after `maxFree` CONSECUTIVE timeouts on the
 * same key it starts counting. An item whose fix cannot finish inside 12 minutes three times
 * running is telling us something about the item, not about the machine. A single completed
 * dispatch resets the counter.
 */
export function timeoutCostsAnAttempt(consecutiveTimeouts, maxFree = MAX_FREE_TIMEOUTS) {
  return consecutiveTimeouts >= maxFree
}

/**
 * Decide what this run actually works. Split out as a pure function on 2026-08-24 because the
 * inline version deadlocked the whole loop for 30 hours and nothing noticed.
 *
 * ── THE BUG THIS FIXES ──────────────────────────────────────────────────────────────────
 * The board is read `order=opened_at.asc` (oldest first), the eligible list was sliced to
 * MAX_PER_RUN=3, and each of those 3 then hit `attempts > MAX_ATTEMPTS` and `continue`d. The
 * three oldest unfixable items therefore consumed the ENTIRE per-run budget on every run,
 * forever, and no agent was ever dispatched again. Measured in `_board-drainer/drainer.log`:
 * last real dispatch 2026-08-23T09:36:57Z, then 0 dispatches and 138 re-escalations on
 * 2026-08-24 alone, across ~90 runs. 31 fixable items were never even looked at.
 *
 * ── WHY THE CAP WAS BEING SPENT ON NOTHING ──────────────────────────────────────────────
 * MAX_PER_RUN is a BLAST-RADIUS cap: it bounds how many autonomous code changes one run may
 * make. A stuck-escalation changes no code — it is one idempotent DB write. Charging it against
 * the blast-radius budget was the category error. So: the cap now applies to AGENT DISPATCHES
 * only, and escalations are handled outside it.
 *
 * ── AND IT ONLY ESCALATES ONCE ──────────────────────────────────────────────────────────
 * The old code re-escalated every stuck item on every run, overwriting `root_cause` with a stub
 * each time — 138 overwrites in one day, which is the separately-filed incident
 * `board-drainer-stuck-stub-erases-root-cause`. An item is now escalated the first time it goes
 * stuck, recorded in `state.stuck`, and thereafter PARKED: no write, no dispatch, no cost.
 *
 * ── PARKED IS A SUPPRESSION, SO IT HAS A CLEARING PATH AND IT ANNOUNCES ITSELF ───────────
 * Four ways out (the rule: a suppression flag ships with the thing that clears it, and a default
 * nobody chose must announce itself):
 *   1. the key leaves the board            -> pruned with the attempt counter (see main)
 *   2. Roger presses "Hand to Claude"      -> priorityKeys clears stuck AND attempts, so the
 *                                             item gets a fresh run of tries at the FRONT
 *   3. BOARD_DRAINER_RESET_STUCK=all|<key> -> manual reset for an operator
 *   4. the 24-hour scheduled retry         -> added 2026-08-27, Plan B B3 part 2, below
 * and every run logs the parked count and keys, so a parked item can never be a silent one.
 *
 * ── THE SCHEDULED RETRY (2026-08-27) ────────────────────────────────────────────────────
 * Ways 1-3 all needed something to HAPPEN — the problem to go away by itself, or a person to
 * press a button. Nothing retried on its own, which is how 41 of 42 incidents came to sit
 * blocked. So exactly ONE parked item, the one parked longest, is handed back to the agent every
 * PARKED_RETRY_INTERVAL_MS.
 *
 * It is appended AFTER the maxPerRun slice on purpose: MAX_PER_RUN is the blast-radius budget for
 * NORMAL work, and charging the retry to it would let a parked pile starve fresh problems — the
 * same head-of-line failure this function was written to fix, wearing a different hat. One run in
 * twenty-four therefore dispatches maxPerRun + 1, and that +1 is the whole mechanism.
 *
 * The revived item is REMOVED from `parked` so the run log cannot call it suppressed and revived
 * in the same breath.
 *
 * @returns {{toWork:Array, toEscalate:Array, parked:Array, belowBar:number, hoisted:string[],
 *            eligible:number, parkedRetry:object|null}}
 */
export function selectWorkQueue({
  routed, state, maxPerRun = MAX_PER_RUN, maxAttempts = MAX_ATTEMPTS, priorityKeys = [],
  now = Date.now(), parkedRetryIntervalMs = PARKED_RETRY_INTERVAL_MS, handoff = HANDOFF_ENABLED,
}) {
  const attempts = state?.attempts || {}
  const stuck = state?.stuck || {}
  const priority = new Set(priorityKeys)

  // ── B3 part 3, taken out FIRST and deliberately ahead of the severity bar ───────────────
  // The threshold is a blast-radius dial: it decides how much AUTONOMOUS CODE CHANGE a run may
  // make. A hand-off changes no code — it is one insert and one state flip, the same category as
  // `note`, which is likewise not charged to MAX_PER_RUN. Leaving hand-offs behind the bar was
  // measured on the live board and it lost one: `backoffice-recurring-costs-unverified-rows` is
  // severity `info`, needs Roger's bank statements and nothing else, and sat on the alarm surface
  // precisely because it was too quiet to be worked and too human to be fixed.
  // "Hand to Claude" still outranks everything: if Roger asks for it, he is overriding the
  // routing, and the item goes to the agent rather than to his own queue.
  const priorityFirst = (e) => priority.has(e.inc.key)
  const handoffs = handoff ? routed.filter((e) => e.cls.handoff && !priorityFirst(e)) : []
  const remaining = handoffs.length ? routed.filter((e) => !handoffs.includes(e)) : routed

  const eligible = remaining.filter(({ inc }) => meetsThreshold(inc))
  const belowBar = remaining.length - eligible.length

  const toEscalate = handoffs.map((e) => ({ ...e, why: 'handoff' }))
  const parked = [], workable = [], hoisted = []
  for (const entry of eligible) {
    const key = entry.inc.key
    // A human override outranks the breaker. Roger asking for an item IS the new evidence that
    // makes another attempt worth making; refusing him because a machine gave up three times is
    // the failure mode, not the safeguard.
    if (priority.has(key)) { hoisted.push(key); workable.unshift(entry); continue }
    // `mode: 'note'` is a cheap idempotent write (vendor plan expired -> status=expected), not an
    // agent run. It must not be charged to the blast-radius budget either, or a handful of noted
    // items would starve the queue the same way the stuck ones did.
    if (entry.cls.mode === 'note') { toEscalate.push({ ...entry, why: 'note' }); continue }
    if ((attempts[key] || 0) >= maxAttempts) {
      if (stuck[key]) parked.push(entry)
      else toEscalate.push({ ...entry, why: 'stuck' })
      continue
    }
    workable.push(entry)
  }

  // ── way 4 out of parked: the scheduled retry ──────────────────────────────────────────
  // A never-yet-recorded clock retries immediately. That is the intended first behaviour, not an
  // oversight: on the run this ships, everything parked has been parked for days already.
  const lastAt = Date.parse(state?.lastParkedRetryAt || '')
  const due = Number.isNaN(lastAt) || (now - lastAt) >= parkedRetryIntervalMs
  let parkedRetry = null
  if (due && parked.length) {
    // Oldest parked FIRST — the one we gave up on longest ago, not the one that happens to sort
    // first. A marker with no readable timestamp counts as the oldest of all: an item whose
    // bookkeeping we lost is the last one that should keep waiting.
    const parkedAt = (k) => { const t = Date.parse(stuck[k]?.at || ''); return Number.isNaN(t) ? 0 : t }
    parkedRetry = [...parked].sort((a, b) => parkedAt(a.inc.key) - parkedAt(b.inc.key))[0]
  }

  return {
    toWork: parkedRetry ? [...workable.slice(0, maxPerRun), parkedRetry] : workable.slice(0, maxPerRun),
    toEscalate,
    parked: parkedRetry ? parked.filter((e) => e !== parkedRetry) : parked,
    belowBar,
    hoisted,
    eligible: workable.length,
    parkedRetry,
  }
}

// ── main ────────────────────────────────────────────────────────────────────────────────
async function main() {
  // gates
  // A skipped run still publishes a heartbeat (from the .then() handler below), so it MUST say it
  // was skipped — otherwise considered=0/dispatchable=0 reads as a clean board and the stall alarm
  // reports the fixer as "working" while a switch is left on. check-drainer-progress.mjs reads
  // runStats.skipped and treats it as not-ok.
  if (process.env.BOARD_DRAINER_DISABLED === '1') {
    log('KILL SWITCH set (BOARD_DRAINER_DISABLED=1) — exiting.')
    runStats.skipped = 'kill switch (BOARD_DRAINER_DISABLED=1)'
    return
  }
  if (process.env.BOARD_DRAINER_ENABLED !== '1') {
    log('⏭️  SKIP: BOARD_DRAINER_ENABLED != 1 (wired-but-off until Roger enables it).')
    runStats.skipped = 'wired-but-off (BOARD_DRAINER_ENABLED != 1)'
    return
  }
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true })
  const state = loadState()
  state.attempts = state.attempts || {}
  state.stuck = state.stuck || {}
  state.timeouts = state.timeouts || {}
  // Bootstrap the progress clock on the very first run that ever records one. Without this the
  // stall alarm reads "never dispatched" — which is true and useless — and cries wolf for its
  // first six hours of life, which is how an alarm gets switched off in week one. We can only
  // honestly measure non-progress from the moment we started measuring it.
  // Bootstrap ONCE, on a genuine first run only: re-seeding on an unreadable file is what let a
  // stalled drainer restart its own stall clock on every run.
  if (!state.lastDispatchAt && !state.unreadable) { state.lastDispatchAt = new Date().toISOString(); saveState(state) }
  runStats.last_dispatch_at = state.lastDispatchAt || null
  log(`Board Drainer start — mode=${LIVE ? 'LIVE' : 'DRY-RUN'}${FIXTURE ? ' [FIXTURE]' : ''}`)

  // Clearing path 3 of 4 for the parked suppression: an operator reset. Runs before anything
  // reads state.stuck, and says out loud what it cleared. It clears the LOCAL marker only; the
  // published `detail.parked` flag is corrected by the write-back of the dispatch that follows
  // immediately (verdictToUpsert stamps parked:false), which is the same run.
  const reset = (process.env.BOARD_DRAINER_RESET_STUCK || '').trim()
  if (reset) {
    const keys = reset === 'all' ? Object.keys(state.stuck) : [reset]
    for (const k of keys) { delete state.stuck[k]; delete state.attempts[k]; delete state.timeouts[k] }
    saveState(state)
    log(`  BOARD_DRAINER_RESET_STUCK=${reset} — cleared ${keys.length} parked item(s): ${keys.join(', ') || '(none)'}`)
  }

  // ── `--reconcile-parked`: the park set, published, and NOTHING else ─────────────────────────
  // Two uses. It REPAIRS a board whose flags drifted from the drainer's own state without waiting
  // for the next scheduled run, and it PROVES the publication contract end to end from any machine
  // (point BOARD_DRAINER_HOME at a scratch state file, delete the flag on a row, run this, read the
  // row back). It stops before classification, so no agent runs and nothing is dispatched.
  //
  // It deliberately writes NO heartbeat (see the .then handler at the bottom): a heartbeat from a
  // run that never looked at the board would publish considered=0 over the real one, and
  // check-drainer-progress.mjs would read a rehearsal as the live fixer — the exact failure its
  // `dry` flag was added for on 2026-09-01.
  if (RECONCILE_ONLY) {
    reconcileOnly = true
    const reconcileSecret = readBoSecret()
    log(`RECONCILE-ONLY: ${Object.keys(state.stuck).length} parked marker(s) in ${STATE}${LIVE ? '' : ' — DRY-RUN, nothing will be written (set BOARD_DRAINER_LIVE=1 to write)'}`)
    await runParkedReconcile(reconcileSecret, state, { dryRun: !LIVE })
    log('Board Drainer done (reconcile-only).')
    return
  }

  // 1. read the work-list
  let secret = null, incidents = [], priorityKeys = []
  // Did EVERY work-list source load this run? The prune below must never run on a partial
  // picture (see the comment there).
  let allSourcesLoaded = true
  if (FIXTURE) {
    incidents = JSON.parse(readFileSync(FIXTURE, 'utf-8'))
    log(`FIXTURE: ${incidents.length} synthetic incident(s) loaded from ${FIXTURE}`)
  } else {
    secret = readBoSecret()
    incidents = await readBoard(secret)
    // Phase 4: human-approved scout reports join the same work-list, through the same
    // classifier and the same unchanged autonomy boundary.
    try {
      const scout = await readScoutQueue(secret)
      if (scout.length) {
        log(`  scout queue: ${scout.length} report(s) marked real by Roger, awaiting a fix`)
        incidents = incidents.concat(scout.map(scoutReportToIncident))
      }
    } catch (e) {
      allSourcesLoaded = false
      log(`  scout queue unavailable (${String(e).slice(0, 120)}); continuing with the board only`)
    }
    // The "Hand to Claude" lane. A read failure is announced, never treated as "nobody handed
    // anything over" — those two look identical in FIFO order and only one of them is true.
    try {
      priorityKeys = await readPriorityKeys(secret)
      if (priorityKeys.length) log(`  priority queue: ${priorityKeys.length} signal(s) handed to Claude on /signals — worked first`)
    } catch (e) {
      allSourcesLoaded = false
      log(`  ⚠ priority queue unavailable (${String(e).slice(0, 120)}) — a "Hand to Claude" pressed since the last good run will NOT jump the queue this run`)
    }
  }
  // Prune stale attempt counters (added 2026-08-20). state.attempts was only ever cleared on
  // a successful fix, so a key closed ANY other way (self-healed, expected, closed by a human
  // or another session) kept its counter forever. If that same key ever came back it would
  // start life at attempts=3 == MAX_ATTEMPTS and be parked as "auto-fix stuck" on its FIRST
  // sighting, never dispatched, never diagnosed. Found live: 4 of 5 surviving counters
  // belonged to incidents that were already fixed/expected/self-healed.
  // The board is the source of truth: a key that is not open does not need a counter.
  //
  // FAIL-SAFE (incident production-monitor:c2dd965:attempt-prune-wipes-scout-counters-on-fetch-failure,
  // filed against the first version of this very prune, 2026-08-20). The first version pruned
  // against `incidents` unconditionally. But the scout-queue fetch above SWALLOWS its own
  // failure and continues "with the board only", so on any run where that fetch throws,
  // `incidents` holds the board alone and EVERY scout-derived counter looks stale and gets
  // deleted. That resets the MAX_ATTEMPTS breaker, so an unfixable scout report is
  // re-dispatched from attempt 1 instead of parking as auto-fix-stuck - and each dispatch is a
  // blocking multi-minute agent run. A merely flaky endpoint would have become an expensive
  // loop. Exactly the fail-OPEN class this file was fixed for earlier the same day,
  // reintroduced by the fix for a different fail-open.
  //
  // So: prune ONLY when the full work-list actually loaded. A missed prune is harmless (the
  // next healthy run does it); a wrong prune disarms a safety limit.
  if (!FIXTURE && allSourcesLoaded) {
    const live = new Set(incidents.map((i) => i.key))
    const stale = Object.keys(state.attempts).filter((k) => !live.has(k))
    // Clearing path 1 of 4: state.stuck rides the SAME prune as state.attempts and under the
    // same fail-safe. If it did not, an item could leave the board, come back, and be parked on
    // sight forever — which is the exact bug this prune was written for in the first place.
    const staleStuck = Object.keys(state.stuck).filter((k) => !live.has(k))
    if (stale.length || staleStuck.length) {
      for (const k of stale) { delete state.attempts[k]; delete state.timeouts[k] }
      for (const k of staleStuck) {
        // The PUBLISHED flag has to be cleared too, and it has to be cleared HERE. detail merges
        // (migration 136), so a parked:true left on a row that resolved is still there when the
        // same check goes down again — the item would come back already parked.
        if (LIVE) await clearParkedOnSignal(secret, state.stuck[k]?.source, k)
        delete state.stuck[k]
      }
      saveState(state)
      log(`  pruned ${stale.length} stale attempt counter(s) and ${staleStuck.length} parked marker(s) for incidents no longer open`)
    }
  }

  // Clearing path 2 of 4: a human override. Pressing "Hand to Claude" on /signals is Roger
  // saying "try again", so it resets BOTH the attempt counter and the parked marker — otherwise
  // the button would hoist an item to the front of a queue it is still forbidden to enter.
  // Unchanged by the 24-hour scheduled retry: the button still revives IMMEDIATELY, and it is
  // still the only path that also wipes the attempt counter.
  const revived = priorityKeys.filter((k) => state.stuck[k] || state.attempts[k])
  if (revived.length) {
    for (const k of revived) {
      if (LIVE && state.stuck[k]) await clearParkedOnSignal(secret, state.stuck[k]?.source, k)
      delete state.stuck[k]; delete state.attempts[k]; delete state.timeouts[k]
    }
    saveState(state)
    log(`  ${revived.length} item(s) revived by "Hand to Claude" — attempt counter and parked marker cleared: ${revived.join(', ')}`)
  }

  if (!FIXTURE && !allSourcesLoaded) log('  prune SKIPPED this run: a work-list source failed to load, so a stale counter cannot be told from an unfetched one')

  log(`board: ${incidents.length} open/acknowledged signal(s) on fleet_signals`)
  runStats.considered = incidents.length
  if (incidents.length === 0) {
    // STILL RECONCILE. A clean board is exactly when a stale `parked: true` is most misleading:
    // the page would name an abandoned finding that the drainer no longer holds any record of.
    await runParkedReconcile(secret, state, { dryRun: !LIVE })
    log('nothing to drain — board is clean.')
    return
  }

  // 2. classify all (every open incident is re-verified), then work up to the per-run cap
  const routed = incidents.map((inc) => ({ inc, cls: classify(inc) }))
  for (const { inc, cls } of routed) {
    log(`  • [${cls.owner}/${cls.mode.toUpperCase()}] ${inc.source}/${inc.key} (${cls.reason}) :: ${inc.title}`)
  }
  const { toWork, toEscalate, parked, belowBar, hoisted, eligible, parkedRetry } = selectWorkQueue({ routed, state, priorityKeys })
  // Published in the heartbeat: `dispatchable > 0` with nothing dispatched, run after run, is
  // the exact 30-hour failure, and it is invisible to any alarm that only asks "did it run?".
  runStats.dispatchable = eligible
  runStats.parked = parked.length
  runStats.parked_retry = parkedRetry ? `${parkedRetry.inc.source}/${parkedRetry.inc.key}` : null
  runStats.escalated = toEscalate.length
  if (belowBar) log(`  severity threshold '${THRESHOLD}': ${belowBar} item(s) below the bar, classified and logged above but not dispatched.`)
  if (hoisted.length) log(`  hoisted to the front by "Hand to Claude": ${hoisted.join(', ')}`)
  if (eligible > MAX_PER_RUN) log(`  blast-radius cap: ${eligible} dispatchable, taking ${MAX_PER_RUN} this run.`)
  const handoffs = toEscalate.filter((e) => e.why === 'handoff')
  runStats.handoff = handoffs.length
  if (toEscalate.length) log(`  ${toEscalate.length} item(s) to record without an agent (${toEscalate.filter((e) => e.why === 'stuck').length} newly stuck, ${toEscalate.filter((e) => e.why === 'note').length} expected-state, ${handoffs.length} needing a person) — these do NOT consume the blast-radius budget.`)
  // B3 part 3. Named individually and every run, for the same reason parked items are: an item
  // that LEAVES the alarm surface must be more visible on its way out, not less.
  if (handoffs.length) {
    log(`  ${LIVE && !FIXTURE ? 'HANDING OVER' : 'would HAND OVER'} ${handoffs.length} item(s) to the work board — these need a person, so no agent run can close them:`)
    for (const { inc, cls } of handoffs) log(`    → ${inc.source}/${inc.key} (${cls.reason})`)
  }
  // A parked item is a SUPPRESSED item, so it is named out loud every single run. Silence here
  // is what let 34 items rot behind 3 for 30 hours.
  if (parked.length) {
    log(`  PARKED at the attempt ceiling (${MAX_ATTEMPTS} failed tries), not dispatched and not re-escalated: ${parked.length}`)
    for (const { inc } of parked) log(`    ⏸ ${inc.source}/${inc.key} :: ${inc.title}`)
    // This line has now been wrong twice, in opposite directions, so it says exactly what the code
    // does. It first claimed "each is published as detail.parked=true on its signal row" while the
    // flag was written ONCE at the moment of parking and never again — false for 7 of 9 rows on
    // 2026-09-02. It then said so honestly. Since 2026-09-03 the run ENDS with a reconcile that
    // re-derives the published set from state.stuck, so the original claim is true again — and it is
    // true because something asserts it every tick, not because one write once succeeded.
    log(`    Each is re-published as detail.parked=true at the end of EVERY run (the reconcile below), one is retried every ${PARKED_RETRY_INTERVAL_MS / 3600_000}h, and up to ${MAX_PARKED_HANDOVER_PER_RUN} are handed to the work board per run, oldest-parked first. To jump that queue: press "Hand to Claude" on /signals, or run with BOARD_DRAINER_RESET_STUCK=<key> (or =all).`)
  }
  // Clearing path 4 of 4, and the reason the board can now drain on its own. Named loudly with
  // WHY it was chosen, because "the machine picked one" is not an explanation anybody can audit.
  if (parkedRetry) {
    const mark = state.stuck[parkedRetry.inc.key] || {}
    const sinceH = mark.at ? Math.round((Date.now() - Date.parse(mark.at)) / 3600_000) : null
    log(`  ⏵ ${LIVE && !FIXTURE ? 'REVIVING' : 'would REVIVE'} 1 parked item — the OLDEST parked, one per ${PARKED_RETRY_INTERVAL_MS / 3600_000}h: ${parkedRetry.inc.source}/${parkedRetry.inc.key}`)
    log(`      why: parked ${mark.at ? `since ${mark.at}${sinceH === null ? '' : ` (${sinceH}h)`}` : 'at an unrecorded time, which makes it the most neglected of all'} after ${mark.attempts ?? MAX_ATTEMPTS} failed attempts; last scheduled retry ${state.lastParkedRetryAt || 'never'}.`)
    log(`      it is dispatched OUTSIDE the blast-radius cap (${MAX_PER_RUN} + 1 this run), so reviving it never displaces fresh work.`)
  }

  // ── close the signals whose work has finished, BEFORE anything is derived from the board ────
  // Deliberately ahead of the dry-run return so a DRY-RUN still REPORTS what it would close: this
  // sweep is the half of the signal<->work-item link that was missing, and a fix nobody can see
  // running is how the forward link went a fortnight without anyone noticing the reverse one was
  // absent. FIXTURE runs read canned data and have no live board, so they skip it entirely.
  if (!FIXTURE) {
    const sweepDeps = workBoardDeps(secret)
    log('  ⏵ closing signals whose work item has finished (the reverse of the hand-off link)')
    const sw = await sweepFinishedWork(sweepDeps, { dryRun: !LIVE })
    log(`    ${sw.checked} active signal(s) carry a work-item pointer; ${sw.entities} of those items are finished`
      + ` — ${LIVE ? 'resolved' : 'would resolve'} ${sw.resolved.length}, left open ${sw.keptOpen.length} (seen again since the close)`)
    // Errors are NAMED, never folded into the count. A sweep that reports success for doing nothing
    // is worse than one that fails.
    for (const e of sw.errors) log(`    ⚠ closure sweep error: ${e}`)
  }

  // In DRY-RUN or FIXTURE we stop here: classification only, nothing dispatched or written.
  if (!LIVE || FIXTURE) {
    const fixes = toWork.filter((r) => r.cls.mode === 'fix').length
    const wouldHandOverParked = parkedHandoverQueue({ parked, state })
    log(`DRY-RUN: would FIX ${fixes}, VERIFY ${toWork.length - fixes}, RECORD-without-agent ${toEscalate.length} (of which HAND OVER to the work board ${handoffs.length}), PARK ${parked.length}, HAND OVER PARKED ${wouldHandOverParked.length}, REVIVE ${parkedRetry ? 1 : 0}. No agent run, no write-back.`)
    for (const { inc } of wouldHandOverParked) log(`  DRY-RUN would hand the PARKED finding ${inc.source}/${inc.key} to the work board as ${workItemSlugFor(inc)} (parked ${state.stuck?.[inc.key]?.at || 'at an unrecorded time'})`)
    for (const { inc, cls } of handoffs) {
      const { title, objections } = plainTitle(inc)
      log(`  DRY-RUN would mint ${workItemSlugFor(inc)} :: ${title}${objections.length ? `  ⚠ title objections: ${objections.join('; ')}` : ''}`)
    }
    // A dry run REPORTS the disagreement between the drainer's park set and the published flags
    // and writes nothing. That report is the cheapest way to see the defect from any machine.
    await runParkedReconcile(secret, state, { dryRun: true })
    saveState(state)
    return
  }

  // The retry clock is stamped at the moment the DECISION is made, not after the agent returns:
  // a dispatch that crashes has still spent this window's retry, and re-spending it on the next
  // tick would turn "one per 24 hours" into "every 20 minutes" against the most broken item we
  // have.
  if (parkedRetry) {
    state.lastParkedRetryAt = new Date().toISOString()
    saveState(state)
  }

  // 3a. Record-only pass: notes and first-time stuck escalations. Neither runs an agent, so
  // neither is charged against MAX_PER_RUN — that cap bounds autonomous CODE CHANGES, and the
  // old code spending it on three permanently-stuck items is precisely what killed the loop.
  const wbDeps = workBoardDeps(secret)
  for (const { inc, why, cls } of toEscalate) {
    try {
      // B3 part 3: a signal that needs a person is a TASK. It becomes a work-board item and leaves
      // the alarm surface. Scout-derived rows are excluded on the same principle that keeps them
      // off the incidents board: a report is not an alarm and must not become a task either.
      if (why === 'handoff') {
        if (isScoutDerived(inc)) { log(`  ${inc.key}: scout-derived — recorded on the report, never handed to the work board`); continue }
        log(`  ${inc.key}: needs a person (${cls.reason}) — routing to the work board.`)
        const r = await routeToWorkBoard(inc, cls, wbDeps)
        if (r.joined) {
          log(`    joined live in-progress item ${r.slug} (tier ${r.tier}) — no new row, no owner touched; signal ${(r.marked || r.alreadyAttached) ? 'marked as attached — still on /signals until a person ticks it off' : 'NOT MARKED (join write failed)'}`)
        } else {
          const how = r.adopted ? `ADOPTED (${r.adopted.via}, no second row minted; would have been ${r.hashSlug})` : (r.created ? 'created' : 'already existed')
          log(`    ${how}: ${r.slug} — signal ${r.superseded ? 'superseded (off the alarm surface)' : 'LEFT OPEN (supersede failed)'}`)
        }
        if (handedOverClearsCounter(r)) { delete state.attempts[inc.key]; delete state.stuck[inc.key]; saveState(state) }
        continue
      }
      if (why === 'note') {
        log(`  ${inc.key}: expected business state — upserting status=expected (noted, no action).`)
        if (isScoutDerived(inc)) { log('    (scout-derived: recorded on the report, never on the incidents board)'); continue }
        await upsertIncident(secret, {
          p_source: inc.source, p_key: inc.key, p_title: inc.title, p_severity: 'info', p_status: 'expected',
          p_root_cause: `[board-drainer] ${inc.root_cause || inc.title} — vendor plan expired — noted, no action`.slice(0, 2000),
          p_who_must_act: null,
          // parked:false because this branch un-parks the item two lines below. detail merges, so
          // saying nothing would leave a stale parked:true standing on the signal.
          p_evidence: { by: 'board-drainer', class: 'EXPECTED', note: 'vendor plan expired — noted, no action', ...parkedFields(null) },
        })
        delete state.attempts[inc.key]
        delete state.stuck[inc.key]
        saveState(state)
        continue
      }
      // why === 'stuck': escalate ONCE, then park. The old code rewrote this row on every run
      // (138 times on 2026-08-24), stamping a stub over the real diagnosis each time — incident
      // `board-drainer-stuck-stub-erases-root-cause`. Writing it once is the fix for that too.
      const attempts = state.attempts[inc.key] || MAX_ATTEMPTS
      const { owner: stuckOwner, priorAction, value: stuckWho } = stuckWhoMustAct(inc.who_must_act)
      const needsRogersHands = stuckOwner === 'Roger'
      // One timestamp for both the published flag and the local marker, so /signals and
      // state.json can never disagree about when this item was given up on.
      const parkedAt = new Date().toISOString()
      log(`  ${inc.key}: ${attempts} failed attempts — escalating ONCE as auto-fix-stuck (owner ${stuckOwner}), then parking (published as detail.parked=true, retried in ≤${PARKED_RETRY_INTERVAL_MS / 3600_000}h).`)
      if (isScoutDerived(inc)) {
        await markScoutReport(secret, inc.scoutReportId, { state: 'real', state_reason: `auto-fix stuck after ${attempts} attempts: ${priorAction}`.slice(0, 500), worked_at: new Date().toISOString() })
      } else {
        await upsertIncident(secret, {
          // Carry the incident's own severity through: being stuck is a fact about the FIX,
          // not a promotion of the PROBLEM to critical — a warning item that could not be
          // auto-fixed is still a warning.
          p_source: inc.source, p_key: inc.key, p_title: inc.title, p_severity: inc.severity || 'warning', p_status: 'blocked',
          p_root_cause: stuckRootCause(inc, attempts),
          p_who_must_act: stuckWho,
          p_evidence: {
            by: 'board-drainer', stuck: true, attempts, stuckOwner, needsRogersHands,
            ...parkedFields({ parked: true, at: parkedAt, attempts }),
          },
        })
      }
      // Mark parked LAST, so a failed escalation is retried next run instead of being
      // silently swallowed into the parked set. `source` rides along because clearParkedOnSignal
      // needs it later, when the row itself is gone from the work-list.
      state.stuck[inc.key] = { at: parkedAt, attempts, source: inc.source }
      state.attempts[inc.key] = attempts
      saveState(state)
    } catch (e) {
      log(`  ${inc.key}: ERRORED while recording (${String(e).slice(0, 160)}) — will retry next run, not parked.`)
    }
  }

  // ── 3a-bis. PARKING IS A HANDOVER, NOT A LANE (2026-09-02) ───────────────────────────────
  //
  // Everything above this block was about making parking VISIBLE — publish the flag, name the
  // keys in the log, count them in the heartbeat, alarm on the share. All of it true, and all of
  // it still PULL: a parked finding sat on /signals carrying needs_human=false, so nothing paged,
  // nothing reached the work board, and the only way anybody learned about it was by going and
  // looking. Roger did, on 2026-09-02, and the top item on the page was the alarm saying 9 of 13
  // findings had been abandoned — with no way to act on any of them.
  //
  // The class already exists and this file already routes it correctly. `cls.handoff` means "no
  // agent run can close this; it needs a person", and such an item is minted on the work board in
  // Roger's lane with a paste-ready prompt and then leaves the alarm surface. An item at the
  // attempt ceiling has PROVED it belongs to that class: three separate agent runs were dispatched
  // and none of them closed it. So it is routed the same way, for the same reason.
  //
  // WHAT THIS REPLACES, and why the replacement is better than what it removes: the 24-hour
  // scheduled retry (B3 part 2) existed because a parked item had no other way out. A handed-over
  // item has a better one — a person — and if that person concludes the machine should try again,
  // "Hand to Claude" on /signals gives it straight back with the attempt counter reset. The retry
  // is NOT deleted here: it still runs for whatever is parked at the moment a run starts, and it
  // stays the safety net for any item whose hand-over fails.
  //
  // RATE-LIMITED, OLDEST-PARKED FIRST. Not because minting is expensive but because a queue that
  // empties itself onto Roger's board in one tick is the graveyard moved, not drained. Three per
  // run drains a nine-item backlog inside an hour and can never flood.
  //
  // THE CEILING ITSELF IS NOT THE BUG AND IS NOT CHANGED. Retrying forever is the 2026-08-24
  // deadlock, where three unfixable items ate the whole per-run budget for 30 hours. Three failed
  // autonomous attempts is enough evidence that this particular fault is not one the machine can
  // close. What was wrong was never the giving up — it was giving up QUIETLY. Giving up is now the
  // loudest thing the drainer does with an item: it hands it to a person and says so.
  const handedOverParked = []
  const queue = parkedHandoverQueue({ parked, state, handoff: HANDOFF_ENABLED })
  if (queue.length) {
    log(`  ⏏ handing ${queue.length} of ${parked.length} PARKED finding(s) to the work board (oldest-parked first, max ${MAX_PARKED_HANDOVER_PER_RUN} per run) — the fixer gave up on these, so a person gets them:`)
    for (const { inc, cls } of queue) {
      try {
        // Same exclusion as the handoff branch above: a scout REPORT is not an alarm and must not
        // become a task either. It is recorded on the report itself and stays there.
        if (isScoutDerived(inc)) { log(`    ${inc.key}: scout-derived — left on the report, not handed to the work board`); continue }
        const r = await routeToWorkBoard(inc, { ...cls, reason: `auto-fix gave up after ${state.stuck[inc.key]?.attempts ?? MAX_ATTEMPTS} attempts` }, wbDeps)
        if (r.joined) {
          log(`    ${inc.key}: joined live in-progress item ${r.slug} (tier ${r.tier}) — signal ${(r.marked || r.alreadyAttached) ? 'marked as attached' : 'NOT MARKED (join write failed)'}`)
        } else {
          const how = r.adopted ? `ADOPTED (${r.adopted.via}, no second row minted)` : (r.created ? 'created' : 'already existed')
          log(`    ${inc.key}: ${how} ${r.slug} — signal ${r.superseded ? 'superseded (off the alarm surface, now a task)' : 'LEFT OPEN (supersede failed — it stays parked and visible, which is the safe direction)'}`)
        }
        // Only a hand-over that actually landed un-parks the item. A mint that failed, or a
        // supersede that failed, leaves BOTH the local marker and the published flag exactly where
        // they were: a signal quietly un-parked into a work item that does not exist is the one
        // outcome worse than leaving it parked.
        if (handedOverClearsCounter(r)) {
          // The PUBLISHED flag has to go too, and it has to go here. `detail` merges (migration
          // 136), and the prune that normally clears it only fires for keys still in state.stuck —
          // which this one is about to leave. A `parked: true` left standing on a superseded row
          // comes straight back the next time the same check goes down, and the item would be born
          // parked: it would never be dispatched even once. Same reasoning as the prune's own call.
          await clearParkedOnSignal(secret, inc.source, inc.key)
          delete state.attempts[inc.key]; delete state.stuck[inc.key]
          saveState(state)
          handedOverParked.push(`${inc.source}/${inc.key}`)
        }
      } catch (e) {
        log(`    ${inc.key}: ERRORED while handing over (${String(e).slice(0, 160)}) — still parked, retried next run.`)
      }
    }
  }
  // Published in the heartbeat so the alarm can tell "nothing is parked because the board is
  // clean" from "nothing is parked because everything was handed to a person this hour".
  runStats.parked_handed_over = handedOverParked.length
  runStats.parked = Math.max(0, parked.length - handedOverParked.length)

  // 3b. LIVE: dispatch + write back. Only genuinely workable items reach here — the `note`
  // and stuck-escalation branches that used to live inline now run in 3a, OUTSIDE the
  // blast-radius cap, because neither of them runs an agent. Keeping them in here is what
  // let three permanently-stuck items eat the entire per-run budget on every run.
  //
  // Each item is isolated. Previously a single throw anywhere in here (e.g. a rejected
  // upsert) propagated out of main(), skipping every REMAINING item, skipping saveState()
  // so the attempt counter never advanced, and skipping the scout write-back so the same
  // report re-dispatched forever. The blast-radius guard failed OPEN. One bad item must cost
  // exactly one item.
  for (const { inc, cls } of toWork) {
    try {
      const attempts = (state.attempts[inc.key] || 0) + 1
      // Captured BEFORE the agent runs. A parked item reaching this loop is the 24-hour retry,
      // and whether it stays parked afterwards depends on what the agent achieves, not on what
      // the state file happens to say twelve minutes later.
      const parkedBefore = state.stuck[inc.key] || null
      log(`  dispatching agent [${cls.mode}] for ${inc.source}/${inc.key} (attempt ${attempts})${parkedBefore ? ' — SCHEDULED RETRY of a parked item, outside the blast-radius cap' : ''}...`)
      // Counted at DISPATCH, not at success: the alarm asks whether the loop is moving, and a
      // dispatch that fails is still a loop that moved. Persisted, because the run that
      // dispatches nothing is the one whose "when did we last move" has to survive.
      const lastDispatchBefore = state.lastDispatchAt || null
      runStats.dispatched += 1
      runStats.last_dispatch_at = new Date().toISOString()
      state.lastDispatchAt = runStats.last_dispatch_at
      saveState(state)
      const verdict = dispatchAgent(inc, cls.mode)
      // Handled FIRST: the cockpit switch is off, so no agent ran. Undo the dispatch we counted
      // optimistically above (a count must name what actually happened), leave the attempt
      // counters and the board untouched, and stop - the switch is fleet-wide, so the remaining
      // items would only re-learn the same thing.
      if (verdict === AGENT_SWITCHED_OFF) {
        runStats.dispatched -= 1
        runStats.last_dispatch_at = lastDispatchBefore
        state.lastDispatchAt = lastDispatchBefore
        // The heartbeat's own vocabulary for 'this run did not work the board, on purpose':
        // check-drainer-progress.mjs reads runStats.skipped and reports it as switched-off
        // rather than as a stalled fixer. Without it, dispatchable>0 with dispatched=0 would
        // read as a red stall - a deliberate off must never look like a failure.
        runStats.skipped = 'automations switched off in the cockpit (agent-run exit 76)'
        switchedOff = true
        saveState(state)
        log(`  ${inc.key}: not dispatched - automations are switched off in the cockpit. Nothing recorded; it is picked up when they are switched back on.`)
        break
      }
      // A TIMEOUT is infrastructure, not a failed diagnosis. Note that AGENT_TIMED_OUT is a
      // Symbol and therefore TRUTHY, so this must be tested BEFORE the `!verdict` branch below
      // or it would be handed to verdictToUpsert() as if it were a real verdict.
      if (verdict === AGENT_TIMED_OUT) {
        const consecutive = (state.timeouts[inc.key] || 0) + 1
        state.timeouts[inc.key] = consecutive
        if (timeoutCostsAnAttempt(consecutive)) {
          state.attempts[inc.key] = attempts
          log(`  ${inc.key}: timed out ${consecutive}x in a row — that is no longer flakiness, recording attempt ${attempts}.`)
        } else {
          log(`  ${inc.key}: agent TIMED OUT (${consecutive} of ${MAX_FREE_TIMEOUTS} free) — attempt NOT charged, it will be retried.`)
        }
        saveState(state)
        continue
      }
      // The agent ran to completion and chose to say nothing. That IS a failed attempt.
      delete state.timeouts[inc.key]
      if (!verdict) {
        state.attempts[inc.key] = attempts
        log(`  no verdict for ${inc.key} — recorded attempt ${attempts}.`)
        saveState(state)
        continue
      }
      const payload = verdictToUpsert(inc, verdict, parkedBefore)
      // Scout-derived items never reach the incidents board (see isScoutDerived above).
      if (!isScoutDerived(inc)) await upsertIncident(secret, payload)
      log(`  ${inc.key}: verdict=${verdict.class} -> board status=${payload.p_status}${payload.p_status === 'blocked' ? ' (escalated)' : ''}`)
      // Phase 4: close the loop back on the scout report this came from.
      // `fixed` here ARMS the Measured re-check (ux-scout.mjs measurePass): 7 days later the
      // scout re-runs that exact signal and records gone/reduced/unchanged/worse. Note that
      // `fixed` on a product-code change means "fixed and deployed to STAGING"; the prod
      // promotion is escalated to Roger, unchanged from every other incident.
      if (inc.scoutReportId) {
        const done = payload.p_status === 'fixed' || payload.p_status === 'self-healed'
        await markScoutReport(secret, inc.scoutReportId, done
          ? { state: 'fixed', state_reason: `board-drainer: ${verdict.action || verdict.class}`.slice(0, 500),
              worked_at: new Date().toISOString(),
              measure_after: new Date(Date.now() + 7 * 86400_000).toISOString() }
          : { state_reason: `board-drainer could not close it: ${verdict.diagnosis || verdict.class}`.slice(0, 500),
              worked_at: new Date().toISOString() })
        log(`    scout report ${String(inc.scoutReportId).slice(0, 8)} -> ${done ? 'fixed, Measured re-check armed for 7 days' : 'left open, reason recorded'}`)
      }
      // clear the attempt counter only when we reached a terminal, non-stuck state
      if (payload.p_status === 'fixed' || payload.p_status === 'self-healed') {
        delete state.attempts[inc.key]
        // A scheduled retry that CLOSED the item un-parks it, locally and on the published row
        // (verdictToUpsert already wrote parked:false into the evidence the mirror merges).
        if (parkedBefore) { delete state.stuck[inc.key]; log(`    ${inc.key}: un-parked — the scheduled retry closed it.`) }
      } else {
        state.attempts[inc.key] = attempts
        // The retry did not close it, so it goes straight back to parked with its ORIGINAL
        // timestamp. One more failed try is not progress, and it must not jump the oldest-first
        // queue ahead of items that have waited longer.
        if (parkedBefore) log(`    ${inc.key}: STILL PARKED (parked since ${parkedBefore.at}) — the scheduled retry did not close it; next retry in ${PARKED_RETRY_INTERVAL_MS / 3600_000}h.`)
      }
      saveState(state)
      } catch (e) {
      // Record the attempt so a repeatedly-failing item still reaches MAX_ATTEMPTS and gets
      // escalated, rather than retrying unbounded.
      state.attempts[inc.key] = (state.attempts[inc.key] || 0) + 1
      saveState(state)
      log(`  ${inc.key}: ERRORED mid-work (${String(e).slice(0, 160)}) — attempt recorded, continuing with the next item.`)
    }
  }

  // ── LAST, and unconditionally: make the BOARD agree with the drainer's own park set ─────────
  // Every branch above that parks, un-parks or hands over an item writes its own flag inline. This
  // pass exists because those writes are EDGES: one PATCH, one run, one machine, and a park whose
  // write failed — or one made before the flag existed — is otherwise invisible for ever. Running
  // it here, after every state mutation of the run, means the published set is re-derived from
  // `state.stuck` every single tick.
  await runParkedReconcile(secret, state, { dryRun: false })
  log('Board Drainer done.')
}

// Pure fns exported for unit tests (test/board-drainer.test.mjs). Importing must NOT run main().
export { classify, verdictToUpsert }

// ── ALARM (birth-cert): a run that ERRORS emails Roger's watched inbox immediately. The
// "silently stopped running" case is covered by proxy — the sibling local runners on this same
// box (agenttriage-localrunner, needs-roger-closer) have healthchecks dead-man's-switches, so if
// the machine dies they go dark and page Roger, which includes this drainer. Optional HC ping if
// BOARD_DRAINER_HC is ever set (a check freed up / account upgraded).
function alertFailure(msg) {
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true })
    const body = join(STATE_DIR, '_drainer_fail.txt')
    writeFileSync(body, `Board Drainer run FAILED at ${new Date().toISOString()}\n\n${msg}\n\nLog: ${LOG}`)
    execFileSync('python', [SEND_EMAIL, '[ALERT] Board Drainer run failed', body], { timeout: 60_000, stdio: 'ignore' })
  } catch { /* already logged; do not throw from the alarm path */ }
  const hc = process.env.BOARD_DRAINER_HC
  if (hc) fetch(`${hc}/fail`).catch(() => {})
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().then(
    async () => {
      // A reconcile-only run publishes no heartbeat: it never looked at the board as work, and a
      // considered=0 heartbeat would overwrite the live fixer's own meter.
      if (!reconcileOnly) await writeRunHeartbeat(null)
      // Contract section 7: on a deliberate off the caller pings NOTHING - not success, not /fail.
      const hc = process.env.BOARD_DRAINER_HC; if (hc && !switchedOff) fetch(hc).catch(() => {})
    },
    async (e) => {
      console.error(e)
      // A run that died still publishes what it managed to do. An alarm that only ever hears
      // from healthy runs is blind to precisely the runs worth hearing about.
      runStats.error = e?.message || String(e)
      if (!reconcileOnly) await writeRunHeartbeat(null)
      alertFailure(e?.stack || e?.message || String(e))
      process.exitCode = 1
    },
  )
}
