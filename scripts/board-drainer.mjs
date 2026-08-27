/**
 * Board Drainer — autonomous incident EXECUTE-loop (root fix, 2026-08-15).
 *
 * Closes the one structural gap the fleet had: detect -> diagnose -> prescribe was strong, but the
 * EXECUTE step depended on a human (Roger) opening a session. production-monitor's autonomous stack
 * (auto-fix / agent-triage / deploy-triage) is live but each only sees its own GitHub-Actions slice;
 * NONE reads the aggregated Monitoring Board. This runner does: it reads `fleet_signals` (BO
 * Supabase — the single store, since Plan A step 1 on 2026-08-27; it read `monitoring_incidents`
 * before that and could not see four active problems), works the owner=Claude items an autonomous
 * dev session may safely fix, escalates the rest, and writes the result back to
 * `monitoring_incidents` — so the board drains to zero without Roger in the loop.
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
import { join } from 'path'
import { homedir } from 'os'
import { pathToFileURL } from 'url'

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

// ── logging ─────────────────────────────────────────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`
  console.log(line)
  try { appendFileSync(LOG, line + '\n') } catch { /* noop */ }
}
function loadState() { try { return JSON.parse(readFileSync(STATE, 'utf-8')) } catch { return { attempts: {} } } }
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
 * THE WRITE DOES NOT MOVE. This is deliberately a read-only cutover: results still go to
 * `monitoring_incidents` through upsert_incident, and the mirror trigger carries them back into
 * fleet_signals. Step 2 of the plan dual-writes for a week before anything is retired.
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
  }
}

/**
 * monitoring_incidents.source CHECK, read back from BOTH live databases 2026-08-27:
 *   healthchecks | sentry | production-monitor | cron | silent-failure | commit-review
 * `fleet_signals` has NO such constraint and has carried `__drill__` and `board-drainer` rows.
 *
 * Since the WRITE still goes to monitoring_incidents (this step moves the read only), a signal
 * whose source that table rejects cannot be worked: upsertIncident would take a 400 and throw,
 * which is the exact fail-open class documented at isScoutDerived() above. So it is held back —
 * and NAMED in the log every single run, because a work item nobody can see is how this whole
 * defect started. Plan A step 2 (write to both stores) is what removes this limit.
 */
const INCIDENT_BOARD_SOURCES = new Set(['healthchecks', 'sentry', 'production-monitor', 'cron', 'silent-failure', 'commit-review'])
export function writableToIncidentBoard(inc) { return INCIDENT_BOARD_SOURCES.has(inc?.source) }

async function readBoard(secret) {
  const res = await fetch(boardQueryUrl(), {
    headers: { apikey: secret, Authorization: `Bearer ${secret}`, 'User-Agent': NON_BROWSER_UA },
  })
  if (!res.ok) throw new Error(`board read HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const rows = (await res.json()).map(signalToIncident)
  const held = rows.filter((r) => !writableToIncidentBoard(r))
  if (held.length) {
    log(`  ${held.length} active signal(s) HELD BACK — monitoring_incidents (still the write target) rejects their source, so working them would 400: ${held.map((r) => `${r.source}/${r.key}`).join(', ')}`)
  }
  return rows.filter(writableToIncidentBoard)
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

/** monitoring_incidents.source CHECK allows ONLY
 *  healthchecks | sentry | production-monitor | cron | silent-failure.
 *  A scout-derived item carries source='scout-ux', which the constraint REJECTS with a 400,
 *  and upsertIncident throws on a non-ok response. Incident
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
    who_must_act: 'Claude - fix the user-facing failure, staging deploy only',
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

// ── classifier: owner + hard-escalate gate (the nuanced fix decision is the agent's, under policy) ──
// A HARD-ESCALATE class is never dispatched to the agent — it needs Roger's hands or a forbidden verb.
const HUMAN_HANDS = /\b(oauth|re-?auth|reconnect|reconnect|google account|log ?in|sign ?in|vendor|support ticket|business decision|pricing|refund|new secret|new credential|new api key|rotate|payment|invoice|pay\b|charge|bank|stripe dashboard)\b/i
const DESTRUCTIVE_DB = /\b(delete|drop|truncate|purge|destroy|remove (?:the )?(?:row|record|connection|table)|ddl|migration to (?:prod|production))\b/i
// EXPECTED business state, not an incident: a vendor plan/subscription lapsed (e.g. Smartlead
// "HTTP 401 Plan expired"). These get upserted as status=expected (visible but muted on the board,
// not counted as open) instead of sitting in Open Incidents forever. Checked BEFORE HUMAN_HANDS —
// a lapsed plan is noted, not escalated.
const EXPECTED_BUSINESS = /\b(plan expired|plan (?:lapsed|cancelled|canceled|cancellation)|subscription (?:expired|lapsed|inactive|cancelled|canceled)|payment required|upgrade required|billing suspended|account (?:suspended|paused))\b/i

// Every open incident is RE-VERIFIED against the live source each run — this is the root fix for the
// class that bit us (a self-healed false-red that sat blocked because the email-driven Closer never
// re-visited it). Claude-owned, safely-fixable items get FIX mode (full tools). Everything else
// (owner=Roger, or a destructive/human-hands class) gets VERIFY mode: read-only, can ONLY close-if-green
// (auto-close a self-healed row, any owner) or leave it escalated. VERIFY never performs a fix.
function classify(inc) {
  const text = `${inc.who_must_act || ''} || ${inc.root_cause || ''} || ${inc.title || ''}`
  const who = (inc.who_must_act || '').trim().toLowerCase()

  // Expected business state wins over every other class — it is noted, never worked or escalated.
  if (EXPECTED_BUSINESS.test(text)) {
    return { owner: 'none', mode: 'note', reason: 'expected business state (vendor plan/subscription lapsed) — noted, no action' }
  }

  const ownerRoger = /^roger\b/i.test(who)
  const humanHands = HUMAN_HANDS.test(text)
  const destructive = DESTRUCTIVE_DB.test(text)
  const hardEscalate = ownerRoger || humanHands || destructive

  const reason = ownerRoger ? 'owner=Roger (verify/close-if-green, else escalate)'
    : humanHands ? 'human-hands class (verify-only)'
    : destructive ? 'destructive-DB class (verify-only)'
    : 'owner=Claude, fixable'

  return { owner: hardEscalate ? 'roger' : 'claude', mode: hardEscalate ? 'verify' : 'fix', reason }
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
The guard enforces: hard-coded allowlist (ReplyFlow monitor-sync-health; BackOffice monitoring-board + health-monitor — anything else is REFUSED), 2 real deploys/day cap, clean+in-sync repo, green CI, then a mandatory post-deploy probe with auto-rollback. Export SUPABASE_ACCESS_TOKEN (from that repo's docs/Credentials.txt) before calling it; run --dry-run first if unsure. Closing rule: an incident needing a prod deploy may only be closed status=fixed when the guard exits 0 AND its probe evidence is your receipt. Exit 2 = rolled back -> escalate, do NOT close. Exit 1 = refused/error -> do NOT deploy; if the function is not allowlisted, escalate to Roger instead.

FINAL ACTION (required): use the Write tool to write ${VERDICT_PATH.replace(/\\/g, '/')} as JSON:
{"class":"A-INFRA|B-PRODUCT-STAGED|C-CLOSED|D-ESCALATE","status":"fixed|self-healed|blocked|investigating","action":"what you did (commit sha / PR url / deploy run / none)","receipt":"the concrete verification that proves it (repro output / live check / green run id) — REQUIRED to set status=fixed/self-healed","who_must_act":"Roger - <one-line> (only if status=blocked, else null)","diagnosis":"1-3 sentences"}`

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

function dispatchAgent(inc, mode) {
  try { if (existsSync(VERDICT_PATH)) rmSync(VERDICT_PATH) } catch { /* noop */ }
  let timedOut = false
  // FIX mode + LIVE gets write/deploy verbs; VERIFY mode is read-only (can only close-if-green or escalate).
  const canWrite = LIVE && mode === 'fix'
  const allowedTools = (canWrite ? [...READ_ONLY, ...WRITE] : READ_ONLY).join(',')
  const VERIFY_NOTE = '\n\n🔎 VERIFY-ONLY mode: you may ONLY (C) confirm the source is GREEN now and CLOSE it (status=self-healed, with a real receipt), or (D) ESCALATE (status=blocked, who_must_act for Roger). You may NOT fix, edit, deploy, or open PRs — you have no write tools.'
  const DRY_NOTE = '\n\n⚠️ DRY RUN: investigate READ-ONLY. Do NOT edit/commit/push/deploy/open PRs. Write ONLY the verdict file, and in "action" describe what you WOULD do, prefixed "[DRY-RUN would] ".'
  let policy = SYSTEM_POLICY
  if (mode === 'verify') policy += VERIFY_NOTE
  if (!LIVE) policy += DRY_NOTE
  const CLAUDE_BIN = process.platform === 'win32' ? 'claude.exe' : 'claude'
  const args = [
    '-p', buildUserPrompt(inc),
    '--append-system-prompt', policy,
    '--allowedTools', allowedTools,
    '--max-turns', String(MAX_TURNS),
    '--model', MODEL,
    '--output-format', 'json',
  ]
  try {
    execFileSync(CLAUDE_BIN, args, {
      stdio: ['ignore', 'inherit', 'inherit'],
      timeout: AGENT_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_AUTHOR_NAME: 'Board Drainer', GIT_AUTHOR_EMAIL: 'noreply@predivo.ch', GIT_COMMITTER_NAME: 'Board Drainer', GIT_COMMITTER_EMAIL: 'noreply@predivo.ch' },
    })
  } catch (e) {
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
 *  Strips any previous stuck prefix (so it can never compound) and keeps the original owner
 *  unless the remaining action genuinely needs Roger's hands. */
export function stuckWhoMustAct(whoMustAct) {
  const priorAction = String(whoMustAct || 'investigate manually')
    .replace(/^(?:Roger|Claude)\s*[-:]\s*board-drainer could not resolve after \d+ tries;\s*/gi, '')
    .replace(/^(?:Roger|Claude)\s*[-:]\s*auto-fix stuck[^;]*;\s*/gi, '')
    .replace(/^(?:Roger|Claude)\s*[-:]\s*/i, '')   // strip the owner prefix; it is re-added below, so it must not double up
    .trim()
  const owner = HUMAN_HANDS.test(priorAction) ? 'Roger' : 'Claude'
  return { owner, priorAction, value: `${owner} - ${priorAction}` }
}

/** Returned by dispatchAgent when the agent never got to produce a verdict at all — a 12-minute
 *  execFileSync timeout or a spawn failure. Distinct from `null`, which means the agent RAN and
 *  chose to say nothing. */
export const AGENT_TIMED_OUT = Symbol.for('board-drainer.agent-timed-out')

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
  now = Date.now(), parkedRetryIntervalMs = PARKED_RETRY_INTERVAL_MS,
}) {
  const attempts = state?.attempts || {}
  const stuck = state?.stuck || {}
  const priority = new Set(priorityKeys)

  const eligible = routed.filter(({ inc }) => meetsThreshold(inc))
  const belowBar = routed.length - eligible.length

  const toEscalate = [], parked = [], workable = [], hoisted = []
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
  if (!state.lastDispatchAt) { state.lastDispatchAt = new Date().toISOString(); saveState(state) }
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
  if (incidents.length === 0) { log('nothing to drain — board is clean.'); return }

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
  if (toEscalate.length) log(`  ${toEscalate.length} item(s) to record without an agent (${toEscalate.filter((e) => e.why === 'stuck').length} newly stuck, ${toEscalate.filter((e) => e.why === 'note').length} expected-state) — these do NOT consume the blast-radius budget.`)
  // A parked item is a SUPPRESSED item, so it is named out loud every single run. Silence here
  // is what let 34 items rot behind 3 for 30 hours.
  if (parked.length) {
    log(`  PARKED at the attempt ceiling (${MAX_ATTEMPTS} failed tries), not dispatched and not re-escalated: ${parked.length}`)
    for (const { inc } of parked) log(`    ⏸ ${inc.source}/${inc.key} :: ${inc.title}`)
    log(`    Each is published as detail.parked=true on its signal row, and one of them is retried every ${PARKED_RETRY_INTERVAL_MS / 3600_000}h. To jump that queue: press "Hand to Claude" on /signals, or run with BOARD_DRAINER_RESET_STUCK=<key> (or =all).`)
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

  // In DRY-RUN or FIXTURE we stop here: classification only, nothing dispatched or written.
  if (!LIVE || FIXTURE) {
    const fixes = toWork.filter((r) => r.cls.mode === 'fix').length
    log(`DRY-RUN: would FIX ${fixes}, VERIFY ${toWork.length - fixes}, RECORD-without-agent ${toEscalate.length}, PARK ${parked.length}, REVIVE ${parkedRetry ? 1 : 0}. No agent run, no write-back.`)
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
  for (const { inc, why } of toEscalate) {
    try {
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
          p_source: inc.source, p_key: inc.key, p_title: inc.title, p_severity: 'critical', p_status: 'blocked',
          p_root_cause: `[board-drainer] auto-fix STUCK after ${attempts} attempts — the action below still stands, it just could not be applied automatically. It is retried automatically within ${PARKED_RETRY_INTERVAL_MS / 3600_000}h, or immediately with "Hand to Claude" on /signals.`,
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
      runStats.dispatched += 1
      runStats.last_dispatch_at = new Date().toISOString()
      state.lastDispatchAt = runStats.last_dispatch_at
      saveState(state)
      const verdict = dispatchAgent(inc, cls.mode)
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
      await writeRunHeartbeat(null)
      const hc = process.env.BOARD_DRAINER_HC; if (hc) fetch(hc).catch(() => {})
    },
    async (e) => {
      console.error(e)
      // A run that died still publishes what it managed to do. An alarm that only ever hears
      // from healthy runs is blind to precisely the runs worth hearing about.
      runStats.error = e?.message || String(e)
      await writeRunHeartbeat(null)
      alertFailure(e?.stack || e?.message || String(e))
      process.exitCode = 1
    },
  )
}
