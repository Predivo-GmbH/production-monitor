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
      if (!r.ok) { seen.set(`token:${key}`, { product: key, level: 'unreadable', detail: `management API returned ${r.status} — token dead or rotated` }); continue }
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

if (process.argv[1] && process.argv[1].endsWith('check-supabase-build-currency.mjs')) {
  const findings = await checkBuildCurrency()
  for (const f of findings) console.log(`${f.level.toUpperCase().padEnd(11)} ${String(f.product).slice(0, 32).padEnd(34)} ${f.detail}`)
  const behind = findings.filter((f) => f.level === 'warn' || f.level === 'blocked')
  console.log(`\n${findings.length} projects checked · ${behind.length} behind the current build`)
  // Behind-but-eligible is a warning, not a failure: the upgrade needs a maintenance window,
  // so this must not turn the whole monitor red every hour until someone runs it.
  if (findings.some((f) => f.level === 'blocked')) process.exit(1)
}
