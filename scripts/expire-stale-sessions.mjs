/**
 * Expire stale logins on every Supabase project, including the ones that cannot buy it.
 *
 * WHY: on 2026-08-29 no login on any product had ever expired. `sessions_timebox` and
 * `sessions_inactivity_timeout` read 0 on all 21 projects, which is how machine accounts
 * accumulated 113,284 abandoned sessions before anyone noticed. Supabase does expose both
 * settings, but they are gated: PATCH /config/auth answers
 *   402 "User sessions can only be configured on Pro Plans and up."
 * and only 2 of 21 projects are on Pro (ReplyFlow, SignalScore). Buying Pro for the other 19
 * to get one setting is not a sane trade, so this reproduces the behaviour with a scheduled
 * sweep instead.
 *
 * DO NOT SET THESE NATIVELY. On 2026-08-30 the policy below was also written natively onto
 * the two Pro projects as sessions_timebox=15552000 / sessions_inactivity_timeout=2592000
 * (the seconds in 180 and 30 days). The platform renders that value into GoTrue as
 * GOTRUE_SESSIONS_TIMEBOX="15552000h", which is past Go's maximum duration (~2562047h), so
 * auth died on its next restart with
 *   fatal: Failed to load configuration: ... time: invalid duration "15552000h"
 * and stayed dead. Customer logins on both products were down from 2026-08-31 ~00:00 UTC to
 * 2026-09-01 08:25 UTC. Nothing else on either project was affected, which is why it read
 * like a platform incident; ten project restarts could not fix it, because a service that
 * cannot parse its config crash-loops on every boot. Reverting both fields to 0 brought auth
 * back in under a minute. Both fields are 0 again on the two Pro projects, and only those
 * two can be set at all, so this sweep is the fleet's only session expiry — as designed.
 *
 * POLICY, one rule for the whole fleet so it can be reasoned about:
 *   idle     30 days  — a login not used for a month stops working
 *   absolute 180 days — no login survives longer than six months, used or not
 * These match what modern SaaS does. They are enforced ONLY by this sweep, never natively.
 * The short-lived part of the chain is already correct everywhere and is NOT touched here:
 * a 1-hour access token with refresh-token rotation and a 10-second reuse window, which is
 * Supabase's documented recommendation ("most applications should use the default").
 *
 * Deleting the row IS the expiry: GoTrue looks the session up when a refresh token is
 * presented, so a removed session cannot be refreshed. Same mechanism the native setting
 * uses, and the same one that cleared 113,284 rows on 2026-08-29 with nothing breaking.
 *
 * THE 2026-08-30 HOLE (this change): "a project could not be READ" was implemented as "any
 * token answered 401", and those are not the same statement. At 15:11 UTC this step reported
 * `21 projects, 1 unreadable` and red the whole hourly monitor — where the 1 was the dead
 * YTMIGRATION_SUPABASE_ACCESS_TOKEN whose only project (ChannelMover) had just been swept by
 * SUPABASE_TOKEN_CHANNELMOVER two lines above. All 20 expected projects WERE swept. The run
 * was red for a credential that cost us no coverage, and the remedy — deleting a secret — is
 * something the automation is not allowed to do, so the alarm could never be cleared by
 * anyone on duty. An alarm nobody can clear is one everybody learns to scroll past, which is
 * how the dangerous case gets missed.
 *
 * The mirror-image hole was the same one check-supabase-build-currency.mjs had: the sweep
 * only ever covered projects some token HANDED it, so a project no token could see was not
 * unreadable — it was ABSENT, and absent read as fine. That is a product whose logins are
 * never expired, and it would have exited 0.
 *
 * Both halves need the one missing fact, and it already exists: scripts/lib/
 * supabase-projects-baseline.json, read through scripts/lib/supabase-coverage.mjs (extracted
 * from the sibling check in this same change, so the two sweeps share one dialect):
 *   every baseline project swept by SOME token -> the sweep is COMPLETE. A dead token cost
 *     no coverage, so it is housekeeping (a board row), not an hourly alarm.
 *   a baseline project no token can see    -> genuinely unswept. RED, and it says which.
 *   no baseline file at all                -> coverage is UNPROVEN, and a dead token stays
 *     red, because nothing has established what the sweep should have found.
 *
 * Contract: node scripts/expire-stale-sessions.mjs [--dry]
 *   env: any SUPABASE_TOKEN_* / *_SUPABASE_ACCESS_TOKEN management tokens.
 * Exit 0 = the sweep was provably complete. Exit 1 = a project we expect was not swept, or
 * one we reached would not answer — which is never "nothing to do".
 */
import { boardSecret, fileSignal, signal } from './lib/fleet-signal.mjs'
import { coverageGaps, coverageLine, loadBaseline, managementApiOnly, outOfManagementApiReach, outOfReachLine } from './lib/supabase-coverage.mjs'
// ONE definition of "which environment variables are management tokens", shared with
// check-supabase-build-currency.mjs. See the note above TOKEN_KEYS below.
import { managementTokenKeys } from './lib/supabase-token.mjs'

export const IDLE_DAYS = Number(process.env.SESSION_IDLE_DAYS || 30)
export const ABSOLUTE_DAYS = Number(process.env.SESSION_ABSOLUTE_DAYS || 180)

/**
 * WHY THIS IS AN IMPORT AND NOT A REGEX (2026-09-02).
 *
 * This sweep and check-supabase-build-currency.mjs are graded against the SAME written-down
 * inventory, scripts/lib/supabase-projects-baseline.json, through the same coverageGaps() —
 * f11a065 unified that half on 2026-08-30 and left this half duplicated. Each script then
 * carried its own answer to "what is a management token", and the two answers differed:
 *
 *   this file                          /^SUPABASE_TOKEN_|_SUPABASE_ACCESS_TOKEN$/ && env[k]
 *   check-supabase-build-currency.mjs  /^SUPABASE_TOKEN_|_SUPABASE_ACCESS_TOKEN$|^SUPABASE_ACCESS_TOKEN$/
 *
 * The narrower list is the one being graded, and the inventory it is graded against is written
 * BY the wider one: only the build check prints the "observed project inventory (ground truth
 * for supabase-projects-baseline.json)" block, and the baseline's own `sourceOfTruth` /
 * `capturedFrom` fields name a build-currency workflow run.
 *
 * So the day anyone adds a bare `SUPABASE_ACCESS_TOKEN` — a name the sibling check already
 * supports — its projects enter the baseline through the build check and are invisible to this
 * one. This sweep would then report them as a coverage gap every hour: an alarm about products
 * it never looked at, caused entirely by its own narrower list, and pointing at nothing anyone
 * could fix. Latent when it was written up on 2026-08-30 (no bare token exists in the repo's 80
 * secrets today) and closed here before it could fire.
 *
 * managementTokenKeys() is the union, plus the emptiness guard this file already had — an unset
 * GitHub secret expands to '' and a blank Bearer token is not a token — plus a sort, so the
 * order a run reads tokens in does not depend on env ordering.
 */
const TOKEN_KEYS = (env) => managementTokenKeys(env)

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
      // `isToken` separates "a credential is dead" from "a product is unswept". They read
      // the same in a count and have opposite urgencies: one is a secret to tidy up, the
      // other is a product whose logins never expire.
      if (!r.ok) { seen.set(`token:${key}`, { product: key, ok: false, isToken: true, error: `management API returned ${r.status} — token dead or rotated` }); continue }
      projects = await r.json()
    } catch (e) { seen.set(`token:${key}`, { product: key, ok: false, isToken: true, error: `management API unreachable — ${e.message}` }); continue }
    for (const p of projects) {
      if (seen.has(p.ref)) continue
      // `ref` is carried on every project finding so coverage can be compared against the
      // baseline by ref. Names are what a person reads; refs are what actually identifies a
      // project, and a project gets renamed far more easily than it gets a new ref.
      try {
        const row = await query(p.ref, pat, sweepSql(IDLE_DAYS, ABSOLUTE_DAYS, dry))
        const after = dry ? {} : await query(p.ref, pat, "select count(*) remaining from auth.sessions")
        seen.set(p.ref, { ref: p.ref, product: p.name, ok: true, ...row, ...after })
      } catch (e) {
        seen.set(p.ref, { ref: p.ref, product: p.name, ok: false, error: e.message })
      }
    }
  }
  return [...seen.values()]
}

/** Coverage gaps rendered as ordinary unreadable findings, so one blindness path reports all of them. */
export function missingFindings(gaps) {
  return (gaps ?? []).map((p) => ({
    ref: p.ref,
    product: p.product,
    ok: false,
    error: `no management token in this environment can see project ${p.ref} — it is expected by scripts/lib/supabase-projects-baseline.json but no token listed it, so nothing is expiring its logins`,
  }))
}

/**
 * The board row for a sweep that went BLIND on a PRODUCT — the dangerous case.
 *
 * A project we cannot reach is not a swept project, and its logins never expire. Filed as
 * critical and needs_human because the remedy (a replacement token, or finding out where a
 * project went) can only come from a person.
 */
export function blindSignal(blind) {
  if (!blind.length) return null
  return signal({
    key: 'session-expiry-unreadable',
    product: 'fleet',
    severity: 'critical',
    needsHuman: true,
    title: `${blind.length} project(s) could not be swept for expired logins`,
    summary: `Could not sweep: ${blind.map((b) => b.product).join(', ')}. Logins on those projects are not being expired, which is how 113,284 abandoned sessions built up before 2026-08-29. This is not an all-clear for them — nobody is expiring a login on these products right now.`,
    detail: { unreadable: blind.map((b) => ({ subject: b.product, ref: b.ref, detail: b.error })) },
  })
}

/**
 * The board row for a dead token that cost us NOTHING — every project we expect was swept
 * this run by a token that still works.
 *
 * Deliberately a warning with no red, for the reason spelled out in the header: the remedy
 * is deleting a secret, which the automation may not do, so an hourly red here could never
 * be cleared by anyone on duty. Housekeeping is still said out loud, with the exact command,
 * because a secret store full of dead credentials lies to the next person who reads it.
 *
 * Returns null unless coverage is PROVEN complete — an unproven sweep has no business
 * calling a dead token harmless.
 */
export function deadTokenSignal(dead, gaps, baseline) {
  if (!dead.length || gaps === null || gaps.length) return null
  const names = dead.map((f) => f.product)
  const expected = baseline?.projects?.length ?? 0
  return signal({
    key: 'session-expiry-dead-management-token',
    product: 'fleet',
    severity: 'warning',
    needsHuman: true,
    title: `${dead.length} stored Supabase management token(s) no longer work`,
    summary: `${names.join(', ')} answer 401 at api.supabase.com. Nothing went unswept because of it: all ${expected} projects expected by scripts/lib/supabase-projects-baseline.json had their stale logins expired this run by tokens that still work. What remains is housekeeping — a secret holding a dead credential misleads the next person who reads the secret list, and it hides the day it becomes the only route to something. Remove or replace it with: gh secret delete ${names[0]} -R Arivioo/production-monitor. Filed as a warning that does not red the monitor on purpose: deleting a credential is not something the automation is allowed to do, so an hourly red here could never be cleared by anyone on duty and would only train everyone to ignore red.`,
    detail: { deadTokens: names, projectsExpected: expected, sweepComplete: true },
  })
}

/**
 * Whether this run exits non-zero, and why — pure, so the policy is testable without a
 * network. Wired into the CLI below and pinned by a test that SPAWNS this script, because
 * 6f2fd93 is the standing proof that an exported, documented, unit-tested exit policy can
 * quietly stop being called by the product.
 */
export function exitDecision(results, gaps) {
  const reasons = []
  const projectBlind = results.filter((r) => !r.ok && !r.isToken)
  const deadTokens = results.filter((r) => !r.ok && r.isToken)
  if (projectBlind.length) reasons.push(`${projectBlind.length} project(s) could not be swept for expired logins: ${projectBlind.map((r) => r.product).join(', ')}`)
  if (deadTokens.length && gaps === null) reasons.push(`${deadTokens.length} management token(s) are dead and there is no project baseline, so the sweep cannot be shown to have been complete without them`)
  return { code: reasons.length ? 1 : 0, reasons }
}

if (process.argv[1] && process.argv[1].endsWith('expire-stale-sessions.mjs')) {
  const dry = process.argv.includes('--dry')
  // Same reasoning as check-supabase-build-currency.mjs: compare against the projects a
  // management token could possibly see. A project in an account we hold no PAT for is out
  // of reach, printed on its own line below, and filed to the board by that script (one
  // fact, one row) rather than reported here as a gap nobody on duty could close.
  const fullBaseline = loadBaseline()
  const baseline = managementApiOnly(fullBaseline)
  const unreachable = outOfManagementApiReach(fullBaseline)
  const swept = await sweep(process.env, dry)
  const gaps = coverageGaps(swept, baseline)
  const results = [...swept, ...missingFindings(gaps)]

  for (const r of results) {
    if (!r.ok) { console.log(`UNREADABLE  ${String(r.product).slice(0, 30).padEnd(32)} ${r.error}`); continue }
    console.log(dry
      ? `DRY         ${String(r.product).slice(0, 30).padEnd(32)} would delete ${r.would_delete} of ${r.total}`
      : `SWEPT       ${String(r.product).slice(0, 30).padEnd(32)} deleted ${r.deleted} stale sessions`)
  }
  const blind = results.filter((r) => !r.ok)
  const total = results.filter((r) => r.ok).reduce((s, r) => s + Number(dry ? r.would_delete : r.deleted || 0), 0)
  // Projects counted separately from tokens: the old line called a dead TOKEN one of the
  // "projects", which inflated the reassuring number using the very thing that was broken.
  const projects = results.filter((r) => !r.isToken)
  console.log(`${projects.length} projects, ${blind.length} unreadable, ${total} stale sessions ${dry ? 'would be' : ''} removed (policy: idle ${IDLE_DAYS}d, absolute ${ABSOLUTE_DAYS}d)`)
  console.log(coverageLine(gaps, baseline, 'swept'))
  const outOfReach = outOfReachLine(unreachable, 'sweep')
  if (outOfReach) console.log(outOfReach)

  // A dead token that cost no coverage moves OUT of the blindness row and into the
  // housekeeping row — but only that token moves. Everything else still files as blindness,
  // because "one subject here is harmless" must never become "so say nothing about the
  // others": a run can perfectly well have a redundant dead token AND a product nobody is
  // sweeping, and the second one is the whole job. A board outage while filing must not
  // swallow the finding, so failures are printed per row and the exit below stands anyway.
  const housekeeping = deadTokenSignal(blind.filter((r) => r.isToken), gaps, baseline)
  const stillBlind = housekeeping ? blind.filter((r) => !r.isToken) : blind
  for (const row of [housekeeping, blindSignal(stillBlind)].filter(Boolean)) {
    try {
      await fileSignal(boardSecret(), row)
      console.log(`filed to the cockpit signals board: ${row.key}`)
    } catch (e) { console.error(`::error::could not file the finding to the board: ${e.message}`) }
  }

  const { code, reasons } = exitDecision(results, gaps)
  for (const r of reasons) console.error(`::error::${r}`)

  // NOT process.exit(). On Windows, exiting while undici still holds its keep-alive sockets
  // aborts the process with a libuv assertion (UV_HANDLE_CLOSING, src\win\async.c:76) and
  // reports 3221226505 instead of the exit code just decided — so anyone running the sweep
  // on their own machine sees a crash rather than its verdict. Letting the loop drain gives
  // the real code on every platform; the unref'd backstop cannot hold the process open by
  // itself and only fires if a stuck socket is keeping it alive anyway.
  process.exitCode = code
  setTimeout(() => process.exit(code), 10_000).unref()
}
