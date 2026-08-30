#!/usr/bin/env node
/**
 * A dead automation must ALERT, not merely be visible.
 *
 * WHY (2026-08-24/25, PLAN-ONE-BOARD step 4): healthchecks.io knows within minutes that a
 * scheduled job stopped checking in. Until now that fact only ever appeared on a screen — the
 * jobs grid, formerly on /monitoring and now on /signals, renders the check grey. Nobody is
 * told. If nobody opens the page that week, a dead automation stays dead, and the whole point
 * of the grid ("it is how a dead automation becomes visible" — Roger) depends on somebody
 * looking.
 *
 * This closes that: every hour, read the checks and file a DOWN one as a signal, so it lands in
 * the cockpit's "needs you" band and can page like anything else. `signal-intake` applies the
 * self-heal window, so a check that recovers before the page is due never rings at all.
 *
 * TWO ACCOUNTS, deliberately. The original healthchecks account is at its plan ceiling of 20
 * checks, so a second free one was added for CI heartbeats. A monitor that reads one of them
 * would report "nothing is down" while the other burns. Every configured key is read, and a key
 * that CANNOT be read fails the run — a failed read is not a clean result.
 *
 * WHAT IT DOES NOT DO: `grace` is not down (the job is late, inside its own allowance), and
 * `paused` is a deliberate human act. Only `down` files a signal. `new` — configured but never
 * pinged even once — is reported in the log as a warning but does not page: it is a wiring
 * mistake, not an outage, and it would fire forever until somebody fixed it.
 *
 * ELEVEN DARK JOBS ARE ONE FAULT, NOT ELEVEN (2026-08-29). `healthchecks` was armed to page on
 * 2026-08-29 (BackOffice migration 155), after the audit found it had never had a page policy at
 * all and so could not reach Roger by any route. Arming it as it stood would have been a
 * different failure: twice in three days the WHOLE local fleet stopped at once, because a code
 * freshness gate refused to start any Claude wrapper, and every job behind that gate went dark
 * inside its own grace window. Eleven pages for one blocked fleet is an alarm that gets muted,
 * and Roger's measure is that more than about two alerts a week means they are miscalibrated.
 *
 * So at ROLLUP_THRESHOLD or above this files ONE critical rollup, naming the count and, where it
 * can, the gate that caused it, and demotes the individual findings to warning/needs_human=false,
 * which upsert_signal records as 'not-eligible'. Every job is still on the board carrying its
 * full detail; exactly one of them may ring. Below the threshold nothing changes: one dead job is
 * one fault and pages on its own. The per-source batch cap in signal_page_policy stays as the
 * backstop for a producer that forgets to roll up.
 *
 * Contract:  node scripts/check-healthchecks-down.mjs [--dry]
 *   env: HEALTHCHECKS_API_KEYS  comma-separated READ-ONLY keys, `hcr_...` (CI). Falls back to
 *                               every account in ~/.claude/scripts/hc-config.json when running
 *                               locally, preferring each account's `api_key_readonly`.
 *        BOARD_SUPABASE_SECRET or BACKOFFICE_SERVICE_ROLE_KEY  to file the signal.
 * Exit 0 = judged (healthy or alarm filed). Exit 1 = could not tell, which is never "fine".
 */
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const BO_REF = 'xoecpzfsskalvjrtcbbl'
const BO_BASE = `https://${BO_REF}.supabase.co`
const BO_CREDS = 'C:\\Business\\Internal Projects\\BackOffice\\docs\\Credentials.txt'
const HC_CONFIG = join(homedir(), '.claude', 'scripts', 'hc-config.json')
const HC_API = 'https://healthchecks.io/api/v3/checks/'
const NON_BROWSER_UA = 'healthchecks-down-producer/1.0'
const SOURCE = 'healthchecks'

/** The one key the rollup owns. Fixed, so it dedups and self-resolves like any other signal. */
export const ROLLUP_KEY = 'many-jobs-dark'

/**
 * Three. Two jobs dying in the same hour is plausibly two unrelated faults and he should hear
 * about both; three is a pattern, and every real occurrence so far has been the whole fleet
 * stopping at once. Set deliberately low rather than at the observed eleven: the point is to
 * catch the pattern early, and a rollup of three still names all three in its summary.
 */
export const ROLLUP_THRESHOLD = 3

/**
 * Checks whose death does not mean "this job stopped" but "nothing may start".
 *
 * These are the fleet's two gates, and both have taken everything down without a word:
 *   code-sync-laptop  the laptop that runs the 22 automations checks that its code matches what
 *                     the work PC shipped. Past its stale budget _claude-preflight.cmd exits 75
 *                     and every wrapper skips, deliberately WITHOUT pinging its own /fail. One
 *                     red check by design, which is right, and is exactly why that one red check
 *                     has to be able to reach him.
 *   claude-platform   the shared auth and quota preflight. Same contract, same blast radius.
 *
 * When one of these is among the dead, the rollup stops counting symptoms and names the cause.
 */
export const GATE_CHECKS = {
  'code-sync-laptop': 'the automation laptop is running code that does not match what was shipped, so every scheduled job is refusing to start',
  'claude-platform': 'the shared Claude sign-in is not usable, so every scheduled job is refusing to start',
}

function readBoSecret() {
  if (process.env.BOARD_SUPABASE_SECRET) return process.env.BOARD_SUPABASE_SECRET.trim()
  if (process.env.BACKOFFICE_SERVICE_ROLE_KEY) return process.env.BACKOFFICE_SERVICE_ROLE_KEY.trim()
  const txt = readFileSync(BO_CREDS, 'utf-8')
  const m = txt.match(/sb_secret_[A-Za-z0-9_]+/)
  if (!m) throw new Error(`no sb_secret_ key found in ${BO_CREDS}`)
  return m[0]
}

/**
 * Every healthchecks account we own, as [{label, key}]. Never silently one of them.
 *
 * READ-ONLY BY PREFERENCE (2026-08-25). This script only ever lists checks, so it takes each
 * account's `api_key_readonly` (`hcr_...`) when the config has one. The write key (`hcw_...`)
 * additionally returns every check's `pause_url`, so a holder of it can silence the fleet's
 * monitoring — and monitoring that goes quiet reads exactly like monitoring that is happy.
 * The write key stays as the fallback so an account without a read-only key still works.
 */
export function readHcKeys(env = process.env, configPath = HC_CONFIG) {
  const fromEnv = (env.HEALTHCHECKS_API_KEYS || env.HEALTHCHECKS_API_KEY || '')
    .split(',').map((k) => k.trim()).filter(Boolean)
  if (fromEnv.length) return fromEnv.map((key, i) => ({ label: `key${i + 1}`, key }))

  const cfg = JSON.parse(readFileSync(configPath, 'utf-8'))
  const accounts = Object.entries(cfg.accounts || {})
    .map(([label, a]) => ({ label, key: a.api_key_readonly || a.api_key }))
    .filter((a) => a.key)
  if (accounts.length) return accounts
  if (cfg.api_key) return [{ label: 'default', key: cfg.api_key }]
  throw new Error(`no healthchecks API key in ${configPath}`)
}

const minsSince = (iso, now) => (iso ? Math.round((now - new Date(iso).getTime()) / 60000) : null)

/**
 * The whole decision, pure and testable: which checks are an outage, which are merely noisy.
 * `down` alone pages. Everything else is explained, never silently dropped.
 */
export function classifyChecks(checks, now = Date.now()) {
  const down = [], neverPinged = [], quiet = []
  for (const c of checks) {
    if (c.status === 'down') down.push(c)
    else if (c.status === 'new' || (!c.last_ping && c.status !== 'paused')) neverPinged.push(c)
    else quiet.push(c)
  }
  return { down, neverPinged, quiet }
}

/** What a DOWN check says on the cockpit, in words that name the consequence. */
export function signalFor(check, now = Date.now()) {
  const silent = minsSince(check.last_ping, now)
  const howLong = silent === null
    ? 'It has never checked in at all.'
    : silent < 120
      ? `Last checked in ${silent} minutes ago.`
      : `Last checked in ${Math.round(silent / 60)} hours ago.`
  return {
    source: SOURCE,
    key: check.slug || check.name,
    kind: 'incident',
    severity: 'critical',
    state: 'open',
    needs_human: true,
    title: `Scheduled job stopped running: ${check.name}`,
    summary: `${howLong} ${check.desc ? check.desc : 'Whatever this job does is not happening.'}`.trim(),
    detail: { slug: check.slug, status: check.status, last_ping: check.last_ping, tags: check.tags || '' },
    link: 'https://cockpit.predivo.ch/signals',
  }
}

/**
 * Which open rows a recovery run may resolve, pure and testable.
 *
 * SCOPED TO REAL CHECK SLUGS ONLY (2026-08-30). The recovery loop used to resolve every open row
 * under source=healthchecks that was not in `downKeys`. But a row that is NOT a check slug — a
 * diagnosis/analysis row the closer routes here, anything filed under this source that is not a
 * live check — can NEVER appear in `downKeys`, so it was force-resolved by construction: title,
 * summary and severity overwritten with "It checked in again". That erased root-cause rows within
 * the hour (proved by an accidental A/B: the healthchecks-sourced analysis row was wiped, its
 * production-monitor twin, written 0.17s apart, survived). Fix: resolve a key ONLY where it
 * intersects the FULL check set (`allCheckKeys`) and is not currently down. A non-check row is now
 * left completely alone. ROLLUP_KEY is not a check slug and is settled below on its own threshold,
 * so it is excluded here explicitly as well.
 */
export function recoveredCheckKeys({ openKeys, allCheckKeys, downKeys }) {
  return [...openKeys].filter((key) =>
    key !== ROLLUP_KEY && allCheckKeys.has(key) && !downKeys.has(key))
}

/**
 * The whole flood decision, pure and testable: given what is dark, what gets filed and what may
 * ring. Returns the exact bodies main() posts, in the order it posts them.
 *
 * @returns {{rollup: object|null, members: object[]}}
 */
export function planSignals(down, now = Date.now()) {
  if (down.length < ROLLUP_THRESHOLD) {
    // One or two dead jobs are one or two faults. Unchanged behaviour: each may page on its own.
    return { rollup: null, members: down.map((c) => signalFor(c, now)) }
  }

  const names = down.map((c) => c.slug || c.name)
  const gate = names.find((n) => GATE_CHECKS[n])

  // Plain words, consequence first. He should not have to know what a healthchecks slug is to
  // understand that nothing has run since yesterday.
  const title = gate
    ? `Nothing is running: ${down.length} scheduled jobs are dark`
    : `${down.length} scheduled jobs have stopped running`
  const summary = (gate
    ? `${GATE_CHECKS[gate]}. That is one fault, not ${down.length}, so this is the only alert for it. `
    : `They stopped inside the same window, so this is most likely one cause and not ${down.length}. `)
    + `Dark right now: ${names.join(', ')}.`

  return {
    rollup: {
      source: SOURCE,
      key: ROLLUP_KEY,
      kind: 'incident',
      severity: 'critical',
      state: 'open',
      needs_human: true,
      title,
      summary,
      detail: { count: down.length, jobs: names, gate: gate ?? null },
      link: 'https://cockpit.predivo.ch/signals',
    },
    // Still filed, still on the board, still carrying every detail, but not eligible to ring.
    // `warning` plus needs_human:false is the pair upsert_signal records as 'not-eligible'.
    members: down.map((c) => ({ ...signalFor(c, now), severity: 'warning', needs_human: false })),
  }
}

async function fetchChecks({ label, key }) {
  const res = await fetch(HC_API, { headers: { 'X-Api-Key': key, 'User-Agent': NON_BROWSER_UA } })
  if (!res.ok) throw new Error(`healthchecks account "${label}" -> HTTP ${res.status}`)
  const body = await res.json()
  return (body.checks || []).map((c) => ({ ...c, account: label }))
}

async function boGet(secret, path) {
  const res = await fetch(`${BO_BASE}/rest/v1/${path}`, {
    headers: { apikey: secret, Authorization: `Bearer ${secret}`, 'User-Agent': NON_BROWSER_UA },
  })
  if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`)
  return res.json()
}

async function fileSignal(secret, body) {
  const res = await fetch(`${BO_BASE}/functions/v1/signal-intake`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', 'User-Agent': NON_BROWSER_UA },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`signal-intake -> HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`)
  return res.json()
}

async function main() {
  const dry = process.argv.includes('--dry')
  const accounts = readHcKeys()
  const checks = []
  for (const acc of accounts) checks.push(...await fetchChecks(acc))   // a throw here fails the run, by design

  const { down, neverPinged, quiet } = classifyChecks(checks)
  console.log(`healthchecks: ${checks.length} check(s) across ${accounts.length} account(s) — ${down.length} down, ${neverPinged.length} never pinged, ${quiet.length} fine`)
  for (const c of down) console.log(`  DOWN  ${c.name} (${c.account}) last ping ${c.last_ping ?? 'never'}`)
  for (const c of neverPinged) console.log(`  ::warning::configured but never pinged: ${c.name} (${c.account}) — wired, not proven`)

  if (dry) {
    const plan = planSignals(down)
    console.log(plan.rollup
      ? `--dry: would file ONE rollup ("${plan.rollup.title}") plus ${plan.members.length} board-only entries. Nothing written.`
      : `--dry: would file ${plan.members.length} individual signal(s), each able to page. Nothing written.`)
    return 0
  }

  const secret = readBoSecret()
  // 'superseded' is read alongside 'open' on purpose. board-drainer moves a signal that needs a
  // person onto the work board and stamps it superseded, and a check that recovers while it sits
  // there must still be resolved. Reading only 'open' left those rows behind, so the next outage
  // re-opened a row that had never been closed and the history read as one unbroken incident.
  const open = await boGet(secret, `fleet_signals?source=eq.${SOURCE}&state=in.(open,superseded)&select=key`)
  const openKeys = new Set(open.map((r) => r.key))
  const downKeys = new Set(down.map((c) => c.slug || c.name))
  // Every slug this account actually knows about — down, quiet or never-pinged. A recovery may only
  // resolve a row whose key is one of these; anything else filed under this source is not ours to touch.
  const allCheckKeys = new Set(checks.map((c) => c.slug || c.name))

  const { rollup, members } = planSignals(down)

  // The rollup goes FIRST. It is the one that may ring, and if this process dies half way through,
  // the alert Roger actually needs is the one already sent.
  if (rollup) {
    const res = await fileSignal(secret, rollup)
    console.log(`  ROLLUP: ${down.length} jobs dark, filed as one alert - ${res.will_page ? `page due ${res.page_due_at}` : `not paging (${res.suppressed})`}`)
  }
  for (const m of members) await fileSignal(secret, m)

  // Recovered: resolve only rows that are (a) real check slugs and (b) no longer down, so the
  // cockpit's "self-resolved" count stays a fact about the fleet rather than an artefact of this
  // script running every hour — and, critically, so a non-check row filed under this source (a
  // diagnosis the closer routed here, say) is NEVER erased by a recovery it can never be part of.
  // The rollup is settled below on its own threshold, not here.
  for (const key of recoveredCheckKeys({ openKeys, allCheckKeys, downKeys })) {
    await fileSignal(secret, {
      source: SOURCE, key, kind: 'incident', severity: 'info', state: 'resolved',
      title: `Scheduled job is running again: ${key}`,
      summary: 'It checked in again, so this cleared itself.',
      link: 'https://cockpit.predivo.ch/signals',
    })
    console.log(`  recovered: ${key} — signal resolved.`)
  }

  // The fleet came back below the threshold: clear the rollup. Resolving cancels any page still
  // inside its self-heal window, so a blockage that clears itself in fifteen minutes never rings.
  // That is the delay doing its job, applied to the rollup exactly as it is to anything else.
  if (!rollup && openKeys.has(ROLLUP_KEY)) {
    await fileSignal(secret, {
      source: SOURCE, key: ROLLUP_KEY, kind: 'incident', severity: 'info', state: 'resolved',
      title: 'The scheduled jobs are running again',
      summary: down.length
        ? `Down to ${down.length} dark job(s), each now reported on its own.`
        : 'Everything that was dark is checking in again.',
      link: 'https://cockpit.predivo.ch/signals',
    })
    console.log('  rollup cleared: back below the threshold.')
  }

  if (down.length) console.error(`::error::${down.length} scheduled job(s) have stopped running. Filed on /signals.`)
  return 0
}

if (import.meta.url === (await import('url')).pathToFileURL(process.argv[1] || '').href) {
  main().then(
    (code) => { process.exitCode = code },
    (e) => {
      console.error(`::error::the scheduled-jobs check could NOT run (${e.message}). Unknown is not healthy.`)
      process.exitCode = 1
    },
  )
}
