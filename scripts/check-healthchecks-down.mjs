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

  if (dry) { console.log('--dry: nothing written.'); return 0 }

  const secret = readBoSecret()
  const open = await boGet(secret, `fleet_signals?source=eq.${SOURCE}&state=eq.open&select=key`)
  const openKeys = new Set(open.map((r) => r.key))
  const downKeys = new Set(down.map((c) => c.slug || c.name))

  for (const c of down) await fileSignal(secret, signalFor(c))

  // Recovered: resolve only what is actually open, so the cockpit's "self-resolved" count stays
  // a fact about the fleet rather than an artefact of this script running every hour.
  for (const key of openKeys) {
    if (downKeys.has(key)) continue
    await fileSignal(secret, {
      source: SOURCE, key, kind: 'incident', severity: 'info', state: 'resolved',
      title: `Scheduled job is running again: ${key}`,
      summary: 'It checked in again, so this cleared itself.',
      link: 'https://cockpit.predivo.ch/signals',
    })
    console.log(`  recovered: ${key} — signal resolved.`)
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
