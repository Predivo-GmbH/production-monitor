/**
 * Expire stale logins on every Supabase project, including the ones that cannot buy it.
 *
 * WHY: on 2026-08-29 no login on any product had ever expired. `sessions_timebox` and
 * `sessions_inactivity_timeout` read 0 on all 21 projects, which is how machine accounts
 * accumulated 113,284 abandoned sessions before anyone noticed. Supabase does expose both
 * settings, but they are gated: PATCH /config/auth answers
 *   402 "User sessions can only be configured on Pro Plans and up."
 * and only 2 of 21 projects are on Pro (ReplyFlow, SignalScore — both set natively to the
 * same policy below). Buying Pro for the other 19 to get one setting is not a sane trade,
 * so this reproduces the behaviour with a scheduled sweep instead.
 *
 * POLICY, one rule for the whole fleet so it can be reasoned about:
 *   idle     30 days  — a login not used for a month stops working
 *   absolute 180 days — no login survives longer than six months, used or not
 * These match what modern SaaS does and what is now set natively on the two Pro projects.
 * The short-lived part of the chain is already correct everywhere and is NOT touched here:
 * a 1-hour access token with refresh-token rotation and a 10-second reuse window, which is
 * Supabase's documented recommendation ("most applications should use the default").
 *
 * Deleting the row IS the expiry: GoTrue looks the session up when a refresh token is
 * presented, so a removed session cannot be refreshed. Same mechanism the native setting
 * uses, and the same one that cleared 113,284 rows on 2026-08-29 with nothing breaking.
 *
 * Contract: node scripts/expire-stale-sessions.mjs [--dry]
 *   env: any SUPABASE_TOKEN_* / *_SUPABASE_ACCESS_TOKEN management tokens.
 * Exit 0 = swept. Exit 1 = a project could not be READ, which is never "nothing to do".
 */
import { boardSecret, fileSignal, signal } from './lib/fleet-signal.mjs'

export const IDLE_DAYS = Number(process.env.SESSION_IDLE_DAYS || 30)
export const ABSOLUTE_DAYS = Number(process.env.SESSION_ABSOLUTE_DAYS || 180)

const TOKEN_KEYS = (env) => Object.keys(env).filter((k) => /^SUPABASE_TOKEN_|_SUPABASE_ACCESS_TOKEN$/.test(k) && env[k])

/**
 * Counts first, then deletes, so a dry run reports exactly what a real run would remove and
 * the log says what happened rather than "done".
 */
export function sweepSql(idleDays, absoluteDays, dry) {
  const stale = `created_at < now() - interval '${absoluteDays} days'
                 or coalesce(refreshed_at, updated_at, created_at) < now() - interval '${idleDays} days'`
  if (dry) {
    return `select count(*) would_delete, (select count(*) from auth.sessions) total from auth.sessions where ${stale}`
  }
  return `with doomed as (select id, user_id from auth.sessions where ${stale}),
   dt as (delete from auth.refresh_tokens rt using doomed d where rt.session_id = d.id returning 1),
   ds as (delete from auth.sessions s using doomed d where s.id = d.id returning 1)
   select (select count(*) from ds) deleted, (select count(*) from dt) tokens`
}

async function query(ref, pat, sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  })
  if (!res.ok) throw new Error(`query -> HTTP ${res.status}`)
  const json = await res.json()
  if (!Array.isArray(json)) throw new Error(`query -> ${JSON.stringify(json).slice(0, 120)}`)
  return json[0] || {}
}

export async function sweep(env = process.env, dry = false) {
  const seen = new Map()
  for (const key of TOKEN_KEYS(env)) {
    const pat = env[key]
    let projects = []
    try {
      const r = await fetch('https://api.supabase.com/v1/projects', { headers: { Authorization: `Bearer ${pat}` } })
      // A token that no longer authenticates must be RECORDED, not skipped. Skipping it
      // contributes zero projects, so every product under that account silently vanishes
      // from `seen` and the run goes green on a shrinking project count — the exact "a
      // project we cannot reach is not a swept project" failure the board signal below
      // exists to prevent, and how 113,284 abandoned sessions built up unnoticed. Mirrors
      // check-supabase-build-currency.mjs, which records the dead token as unreadable.
      if (!r.ok) { seen.set(`token:${key}`, { product: key, ok: false, error: `management API returned ${r.status} — token dead or rotated` }); continue }
      projects = await r.json()
    } catch (e) { seen.set(`token:${key}`, { product: key, ok: false, error: `management API unreachable — ${e.message}` }); continue }
    for (const p of projects) {
      if (seen.has(p.ref)) continue
      try {
        const row = await query(p.ref, pat, sweepSql(IDLE_DAYS, ABSOLUTE_DAYS, dry))
        const after = dry ? {} : await query(p.ref, pat, "select count(*) remaining from auth.sessions")
        seen.set(p.ref, { product: p.name, ok: true, ...row, ...after })
      } catch (e) {
        seen.set(p.ref, { product: p.name, ok: false, error: e.message })
      }
    }
  }
  return [...seen.values()]
}

if (process.argv[1] && process.argv[1].endsWith('expire-stale-sessions.mjs')) {
  const dry = process.argv.includes('--dry')
  const results = await sweep(process.env, dry)
  for (const r of results) {
    if (!r.ok) { console.log(`UNREADABLE  ${String(r.product).slice(0, 30).padEnd(32)} ${r.error}`); continue }
    console.log(dry
      ? `DRY         ${String(r.product).slice(0, 30).padEnd(32)} would delete ${r.would_delete} of ${r.total}`
      : `SWEPT       ${String(r.product).slice(0, 30).padEnd(32)} deleted ${r.deleted} stale sessions`)
  }
  const blind = results.filter((r) => !r.ok)
  const total = results.filter((r) => r.ok).reduce((s, r) => s + Number(dry ? r.would_delete : r.deleted || 0), 0)
  console.log(`${results.length} projects, ${blind.length} unreadable, ${total} stale sessions ${dry ? 'would be' : ''} removed (policy: idle ${IDLE_DAYS}d, absolute ${ABSOLUTE_DAYS}d)`)
  // A project we cannot reach is not a swept project. Say so on the board rather than
  // letting a shrinking sweep look like a healthy one.
  if (blind.length) {
    try {
      await fileSignal(boardSecret(), signal({
        key: 'session-expiry-unreadable',
        product: 'fleet',
        severity: 'warning',
        needsHuman: false,
        title: `${blind.length} project(s) could not be swept for expired logins`,
        summary: `Could not read: ${blind.map((b) => b.product).join(', ')}. Logins on those projects are not being expired, which is how 113,284 abandoned sessions built up before 2026-08-29.`,
        detail: { unreadable: blind },
      }))
    } catch (e) { console.error(`could not file the board signal: ${e.message}`) }
    process.exit(1)
  }
}
