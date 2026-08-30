/**
 * Supabase build currency — the second half of the 2026-08-29 fix.
 *
 * ScoutCopilot sat on platform build supabase-postgres-17.6.1.084 while the current GA
 * build was 17.6.1.166. That old build was the cause of the Disk IO alarm: 74.1 KB read
 * per page fault before the upgrade, 32.3 KB after, and total disk traffic 0.67/7.74 =
 * 8.7% of what it had been. Nothing of ours was watching how far behind a project had
 * drifted, so the drift was invisible until the vendor billed us for it.
 *
 * Any management token in the environment is used, so a new account is covered by adding
 * its token as a secret and nothing else.
 */

import { boardSecret, fileSignal, signal } from "./lib/fleet-signal.mjs"

const TOKEN_KEYS = (env) => Object.keys(env).filter((k) => /^SUPABASE_TOKEN_|_SUPABASE_ACCESS_TOKEN$|^SUPABASE_ACCESS_TOKEN$/.test(k))

export async function checkBuildCurrency(env = process.env) {
  const seen = new Map()
  for (const key of TOKEN_KEYS(env)) {
    const pat = env[key]
    if (!pat) continue
    const H = { Authorization: `Bearer ${pat}` }
    let projects = []
    try {
      const r = await fetch('https://api.supabase.com/v1/projects', { headers: H })
      if (!r.ok) { seen.set(`token:${key}`, { product: key, level: 'unreadable', isToken: true, detail: `management API returned ${r.status} — token dead or rotated` }); continue }
      projects = await r.json()
    } catch { continue }
    for (const p of projects) {
      if (seen.has(p.ref)) continue
      let e = {}
      try { e = await (await fetch(`https://api.supabase.com/v1/projects/${p.ref}/upgrade/eligibility`, { headers: H })).json() } catch { /* reported below */ }
      const cur = e.current_app_version, latest = e.latest_app_version
      if (!cur || !latest) { seen.set(p.ref, { product: p.name, level: 'unreadable', detail: 'could not read build version' }); continue }
      const behind = cur !== latest
      seen.set(p.ref, {
        product: p.name,
        level: behind ? (e.eligible ? 'warn' : 'blocked') : 'ok',
        detail: behind
          ? `on ${cur.replace('supabase-postgres-', '')}, current is ${latest.replace('supabase-postgres-', '')}${e.eligible ? '' : ' (upgrade NOT eligible — needs a human)'}`
          : `current (${cur.replace('supabase-postgres-', '')})`,
      })
    }
  }
  return [...seen.values()]
}

/**
 * The board row for a watchdog that has gone BLIND, as opposed to one that found something.
 *
 * WHY: 986d205 moved the "we found something" path onto the signals board because a bare
 * exit(1) only reds the run, and send-alert.mjs reads Playwright's results.json — so the
 * email lists ZERO failures while the real fact appears nowhere a person looks. That fix
 * was applied to the `behind` path and NOT to the `unreadable` one, which is the path that
 * was actually red on 2026-08-30 (SUPABASE_TOKEN_CHANNELMOVER and YTMIGRATION_SUPABASE_
 * ACCESS_TOKEN both 401, arivioo-staging unversioned). So the monitor went red every hour
 * with the reason visible only in a workflow log.
 *
 * The run still exits non-zero after this is filed — the documented house rule in
 * fleet-signal.mjs is "a filed alarm exits 0, only a failed READ exits non-zero", and a
 * watchdog that could not read IS a failed read. Filing does not make it green; it makes
 * the red legible. Pure so the payload is unit-tested without the network.
 */
export function blindSignal(findings) {
  const blind = findings.filter((f) => f.level === 'unreadable')
  if (!blind.length) return null
  const tokens = blind.filter((f) => f.isToken)
  const projects = blind.filter((f) => !f.isToken)
  const parts = []
  if (tokens.length) parts.push(`${tokens.length} management token(s) no longer authenticate: ${tokens.map((f) => f.product).join(', ')}`)
  if (projects.length) parts.push(`${projects.length} project(s) would not report a build version: ${projects.map((f) => f.product).join(', ')}`)
  return signal({
    key: 'supabase-build-currency-blind',
    product: 'fleet',
    severity: 'critical',
    needsHuman: true,
    title: `The Supabase build watchdog is blind for ${blind.length} subject(s)`,
    summary: `${parts.join('. ')}. This is not an all-clear: for these subjects nobody is watching whether the project has drifted onto an out-of-date platform build. That drift is what caused the 2026-08-29 ScoutCopilot Disk IO alarm, where an old build read 74.1 KB from disk per page fault against 32.3 KB after the free upgrade. A dead token can only be replaced by a person — minting a Supabase Management token is not something the automation is allowed to do.`,
    detail: { blind: blind.map((f) => ({ subject: f.product, isToken: !!f.isToken, detail: f.detail })) },
  })
}

if (process.argv[1] && process.argv[1].endsWith('check-supabase-build-currency.mjs')) {
  const findings = await checkBuildCurrency()
  for (const f of findings) console.log(`${String(f.level).toUpperCase().padEnd(11)} ${String(f.product).slice(0, 32).padEnd(34)} ${f.detail}`)
  const behind = findings.filter((f) => f.level === 'warn' || f.level === 'blocked')
  const blind = findings.filter((f) => f.level === 'unreadable')
  console.log(`${findings.length} projects checked, ${behind.length} behind the current build, ${blind.length} unreadable`)

  // One board row for the whole sweep, not one per project: 19 of 21 were behind on
  // 2026-08-29 and nineteen separate rows would bury the board rather than inform it.
  // Filed as a warning with needs_human false, because an upgrade takes a product briefly
  // offline and is a decision, not something that should ring a phone at 03:00.
  if (behind.length) {
    const names = behind.map((f) => f.product).join(', ')
    await fileSignal(boardSecret(), signal({
      key: 'supabase-build-currency',
      product: 'fleet',
      severity: 'warning',
      needsHuman: false,
      title: `${behind.length} Supabase project(s) are running an out-of-date platform version`,
      summary: `Behind the current Supabase build: ${names}. Supabase never updates these on its own, so every project drifts until someone upgrades it. On 2026-08-29 an out-of-date build (17.6.1.084) was the cause of ScoutCopilot's Disk IO alarm: the machine read 74.1 KB from disk per page fault against 32.3 KB after the free upgrade, and total disk traffic fell to 0.67/7.74 = 8.7 percent of what it was. The upgrade is free and takes about ten minutes per project, but it does take the product offline while it runs, so it is a decision rather than something to automate.`,
      detail: { behind: behind.map((f) => ({ product: f.product, detail: f.detail })) },
    }))
    console.log('filed to the cockpit signals board: supabase-build-currency')
  }
  // Behind-but-eligible is now on the board, so it must not also red the run every hour.
  // A project that cannot be READ, or is behind and NOT eligible to upgrade, needs a human.
  // Blindness gets its OWN board row first: it is the reason this check was red on
  // 2026-08-30 and it was the one finding that reached nobody. A board outage while filing
  // must not swallow the original finding, so the failure is printed and the exit stands.
  if (blind.length) {
    const row = blindSignal(findings)
    try {
      await fileSignal(boardSecret(), row)
      console.log(`filed to the cockpit signals board: ${row.key}`)
    } catch (e) {
      console.error(`::error::could not file the blind finding to the board: ${e.message}`)
    }
  }
  if (blind.length || findings.some((f) => f.level === 'blocked')) process.exit(1)
}
