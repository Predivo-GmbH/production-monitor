/**
 * File an alarm onto the Cockpit signals board (https://cockpit.predivo.ch/signals).
 *
 * WHY THIS EXISTS: the two Supabase watchdogs added on 2026-08-29 only exited non-zero when
 * they found something. That reds the workflow and triggers send-alert.mjs, which reads
 * Playwright's results.json — so the email would have listed ZERO failing tests while the
 * actual finding appeared nowhere a person looks. Every neighbouring sensor in monitor.yml
 * (products-down, sentry-issues, healthchecks-down, drainer-progress) instead files a signal
 * and exits 0, so the fact lands on the board Roger actually opens. These two now match.
 *
 * The house rule those sensors document, and this preserves: a filed alarm exits 0, only a
 * failed READ exits non-zero. An alarm that also reds the run double-reports one event.
 */
import { readFileSync } from 'fs'

const BO_REF = 'xoecpzfsskalvjrtcbbl'
const BO_BASE = `https://${BO_REF}.supabase.co`
const BO_CREDS = 'C:/Business/Internal Projects/BackOffice/docs/Credentials.txt'  // forward slashes on purpose: Node accepts them on Windows and they survive every shell

/** Same resolution order as check-products-down.mjs, so one secret drives every sensor. */
export function boardSecret(env = process.env) {
  if (env.BOARD_SUPABASE_SECRET) return env.BOARD_SUPABASE_SECRET.trim()
  if (env.BACKOFFICE_SERVICE_ROLE_KEY) return env.BACKOFFICE_SERVICE_ROLE_KEY.trim()
  try {
    const m = readFileSync(BO_CREDS, 'utf-8').match(/sb_secret_[A-Za-z0-9_-]+/)
    if (m) return m[0]
  } catch { /* falls through to the throw below */ }
  throw new Error('no board secret: set BOARD_SUPABASE_SECRET or BACKOFFICE_SERVICE_ROLE_KEY')
}

export async function fileSignal(secret, body) {
  const res = await fetch(`${BO_BASE}/functions/v1/signal-intake`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', 'User-Agent': 'supabase-watchdog/1.0' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`signal-intake -> HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`)
  return res.json()
}

/**
 * `key` must be stable per subject so repeat sightings update one row instead of breeding
 * duplicates. `needs_human` is what decides whether it can ring a phone, so only genuine
 * over-threshold findings set it; a warning is a board row nobody is woken for.
 */
export function signal({ key, product, severity, needsHuman, title, summary, detail }) {
  return {
    source: 'production-monitor',
    key,
    kind: 'incident',
    product,
    severity,
    needs_human: !!needsHuman,
    state: 'open',
    title,
    summary,
    detail,
    link: 'https://cockpit.predivo.ch/signals',
  }
}
