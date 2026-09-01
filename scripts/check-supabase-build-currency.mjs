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
 *
 * THE 2026-08-30 HOLE (this change): the sweep only ever reported on projects some token
 * HANDED it. A project that no token could see was not "unreadable" — it was ABSENT, and
 * absent reads as fine. The run printed "21 projects checked, 0 behind" and went green on
 * exactly the state this watchdog exists to catch: a product nobody is watching. Meanwhile
 * the same run went RED, every hour, because one stored token answered 401 — a credential
 * whose projects were all being read by other tokens anyway. The check was loud about the
 * harmless case and silent about the dangerous one.
 *
 * Both halves need the same missing fact: what the fleet is SUPPOSED to contain. That is
 * scripts/lib/supabase-projects-baseline.json, in the house style of scripts/lib/
 * mailer-baseline.json — a written-down expectation, so a gap is a fact instead of a guess.
 * With it, a dead token is decidable rather than merely alarming:
 *   every baseline project read by SOME token -> the sweep is COMPLETE. A dead token cost
 *     us no coverage, so it is housekeeping (a board row), not an hourly alarm.
 *   a baseline project no token can see    -> genuinely unwatched. RED, and it says which.
 *   no baseline file at all                -> coverage is UNPROVEN, and a dead token stays
 *     red, because nothing has established what the sweep should have found.
 */

import { boardSecret, fileSignal, signal } from "./lib/fleet-signal.mjs"
// Moved to scripts/lib/ on 2026-08-30 when expire-stale-sessions.mjs failed with the exact
// same signature and needed the same answer. Re-exported so this module's public surface
// (and its test) is unchanged by the move.
import { coverageGaps, coverageLine, loadBaseline, managementApiOnly, outOfManagementApiReach, outOfReachLine } from './lib/supabase-coverage.mjs'

export { coverageGaps, loadBaseline, managementApiOnly, outOfManagementApiReach }

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
      // `ref` is carried on every project finding so coverage can be compared against the
      // baseline by ref. Names are what a person reads; refs are what actually identifies
      // a project, and a project gets renamed far more easily than it gets a new ref.
      if (!cur || !latest) { seen.set(p.ref, { ref: p.ref, product: p.name, level: 'unreadable', detail: 'could not read build version' }); continue }
      const behind = cur !== latest
      seen.set(p.ref, {
        ref: p.ref,
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

/** Coverage gaps rendered as ordinary unreadable findings, so one blindness path reports all of them. */
export function missingFindings(gaps) {
  return (gaps ?? []).map((p) => ({
    ref: p.ref,
    product: p.product,
    level: 'unreadable',
    detail: `no management token in this environment can see project ${p.ref} — it is expected by scripts/lib/supabase-projects-baseline.json but no token listed it`,
  }))
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
 *
 * A dead token reaches this row only while coverage is UNPROVEN. Once the baseline shows
 * the sweep was complete without it, the caller sends it to deadTokenSignal instead —
 * because claiming "nobody is watching" about a project that was read minutes ago is a
 * false statement, and a watchdog that cries about the harmless case gets ignored on the
 * dangerous one.
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

/**
 * The board row for a dead token that cost us NOTHING — every project we expect was read
 * this run by a token that still works.
 *
 * This is deliberately a warning with no red. The remedy is deleting or replacing a secret,
 * which the automation is not allowed to do, so reddening the hourly monitor for it creates
 * an alarm that literally cannot be cleared by anything on duty — and an alarm that can
 * never be cleared is one everybody learns to scroll past. Housekeeping still gets said out
 * loud, on the board, with the exact command, because a secret store full of dead
 * credentials misleads the next person who reads it.
 *
 * Returns null unless coverage is PROVEN complete — an unproven sweep has no business
 * calling a dead token harmless.
 */
export function deadTokenSignal(findings, gaps, baseline) {
  const dead = findings.filter((f) => f.level === 'unreadable' && f.isToken)
  if (!dead.length || gaps === null || gaps.length) return null
  const names = dead.map((f) => f.product)
  const expected = baseline?.projects?.length ?? 0
  return signal({
    key: 'supabase-dead-management-token',
    product: 'fleet',
    severity: 'warning',
    needsHuman: true,
    title: `${dead.length} stored Supabase management token(s) no longer work`,
    summary: `${names.join(', ')} answer 401 at api.supabase.com. Nothing is unwatched because of it: all ${expected} projects expected by scripts/lib/supabase-projects-baseline.json were read this run by tokens that still work, so the build-currency sweep was complete without these. What remains is housekeeping — a secret holding a dead credential lies to the next person who reads the secret list, and it hides the day it becomes the only route to something. Remove or replace it with: gh secret delete ${names[0]} -R Arivioo/production-monitor. This is filed as a warning and does not red the monitor on purpose: deleting a credential is not something the automation is allowed to do, so an hourly red here could never be cleared by anyone on duty and would only train everyone to ignore red.`,
    detail: { deadTokens: names, projectsExpected: expected, sweepComplete: true },
  })
}

/**
 * Whether this run exits non-zero, and why — pure, so the policy is testable without a network.
 *
 * Wired into the CLI below and pinned by a test that SPAWNS this script. 6f2fd93 is the
 * reason for that belt and braces: an exit policy here was exported, documented and unit
 * tested while the CLI had quietly stopped calling it, so a green test proved nothing about
 * what the product actually did.
 */
/**
 * The board row for a baseline project NO management token in this repo can reach.
 *
 * Filed here and NOT also from expire-stale-sessions.mjs: it is one fact about one missing
 * credential, and two scripts filing it would breed two rows for a single subject, which the
 * stable-`key` rule in fleet-signal.mjs exists to prevent. Both scripts still PRINT it, so
 * neither log can be read as an all-clear.
 *
 * Warning, not needs_human: the correct next action is "a person adds a management token",
 * which is not an outage and must not ring a phone at 03:00. It also deliberately does not
 * red the run — see managementApiOnly()'s note on why an uncloseable hourly red is worse
 * than no red at all.
 */
export function outOfReachSignal(unreachable) {
  if (!unreachable?.length) return null
  return signal({
    key: 'supabase-project-out-of-management-reach',
    product: unreachable.length === 1 ? unreachable[0].product : 'fleet',
    severity: 'warning',
    needsHuman: false,
    title: `${unreachable.length} live Supabase project(s) sit in an account this monitor has no token for`,
    summary: `${unreachable.map((p) => `${p.product} (${p.ref})`).join(', ')}: no SUPABASE_TOKEN_* / *_SUPABASE_ACCESS_TOKEN secret in Arivioo/production-monitor belongs to the owning account, so nothing checks how far behind its Postgres build is and nothing expires its stale logins. This is not an outage and the product is otherwise watched (its disk load is measured directly with its service-role key). It is a permanent hole in two fleet sweeps until someone adds the token.`,
    detail: `Beize Jass Tour is the case that created this row. Until 2026-09-01 the baseline named the OLD project dkxdlovwzsxnepoteebk, abandoned empty on 2026-08-22, so both sweeps reported a healthy result about a database with nothing in it. The live one is uyksotlmrlxhmyeopktl in account 11api@predivo.ch, proven by the deployed bundle at https://beize-jass-tour.mueller.ro and by jass-tour-ui-kit/docs/Credentials.txt, which also already holds a management PAT for that account (created 2026-08-22, expires 2027-08-21). Adding it as a repo secret named SUPABASE_TOKEN_JASSTOUR closes this permanently; the automation is not permitted to set credentials, so it is left to a person.`,
  })
}

export function exitDecision(findings, gaps) {
  const reasons = []
  const projectBlind = findings.filter((f) => f.level === 'unreadable' && !f.isToken)
  const blocked = findings.filter((f) => f.level === 'blocked')
  const deadTokens = findings.filter((f) => f.level === 'unreadable' && f.isToken)
  if (projectBlind.length) reasons.push(`${projectBlind.length} project(s) could not be read: ${projectBlind.map((f) => f.product).join(', ')}`)
  if (blocked.length) reasons.push(`${blocked.length} project(s) are behind and NOT eligible to upgrade: ${blocked.map((f) => f.product).join(', ')}`)
  if (deadTokens.length && gaps === null) reasons.push(`${deadTokens.length} management token(s) are dead and there is no project baseline, so the sweep cannot be shown to have been complete without them`)
  return { code: reasons.length ? 1 : 0, reasons }
}

if (process.argv[1] && process.argv[1].endsWith('check-supabase-build-currency.mjs')) {
  // Compared against the projects a management token could POSSIBLY see, not the whole
  // fleet — a project in an account we hold no PAT for is out of reach, not unswept-by-
  // accident, and is reported on its own line below instead of as a gap nobody can close.
  const fullBaseline = loadBaseline()
  const baseline = managementApiOnly(fullBaseline)
  const unreachable = outOfManagementApiReach(fullBaseline)
  const swept = await checkBuildCurrency()
  const gaps = coverageGaps(swept, baseline)
  const findings = [...swept, ...missingFindings(gaps)]

  for (const f of findings) console.log(`${String(f.level).toUpperCase().padEnd(11)} ${String(f.product).slice(0, 32).padEnd(34)} ${f.detail}`)
  const behind = findings.filter((f) => f.level === 'warn' || f.level === 'blocked')
  const blind = findings.filter((f) => f.level === 'unreadable')
  const projects = findings.filter((f) => !f.isToken)
  // Counted separately because the old line called a dead TOKEN one of the "projects
  // checked", which inflated the reassuring number using the very thing that was broken.
  console.log(`${projects.length} projects checked, ${behind.length} behind the current build, ${blind.length} unreadable`)
  console.log(coverageLine(gaps, baseline))
  const outOfReach = outOfReachLine(unreachable, 'read')
  if (outOfReach) console.log(outOfReach)

  // What the sweep actually saw, so the baseline is bootstrapped and audited from ground
  // truth (the API's own refs and names) instead of hand-copied out of Credentials.txt,
  // where dead and superseded refs sit next to live ones.
  console.log('::group::observed project inventory (ground truth for scripts/lib/supabase-projects-baseline.json)')
  console.log(JSON.stringify({ projects: projects.filter((f) => f.ref).map((f) => ({ ref: f.ref, product: f.product })).sort((a, b) => a.product.localeCompare(b.product)) }, null, 2))
  console.log('::endgroup::')

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
  // Blindness gets its OWN board row: it is the reason this check was red on 2026-08-30 and
  // it was the one finding that reached nobody.
  //
  // A dead token that cost no coverage is moved OUT of the blindness row and into the
  // housekeeping row — but only that token moves. Everything else still files as blindness,
  // because "one subject here is harmless" must never become "so say nothing about the
  // others"; a run can perfectly well have a redundant dead token AND a project that would
  // not report its version, and the second one is the whole job. A board outage while
  // filing must not swallow the finding, so failures are printed per row and the exit
  // below stands regardless.
  const housekeeping = deadTokenSignal(findings, gaps, baseline)
  const stillBlind = housekeeping ? findings.filter((f) => !(f.isToken && f.level === 'unreadable')) : findings
  for (const row of [housekeeping, outOfReachSignal(unreachable), stillBlind.some((f) => f.level === 'unreadable') ? blindSignal(stillBlind) : null].filter(Boolean)) {
    try {
      await fileSignal(boardSecret(), row)
      console.log(`filed to the cockpit signals board: ${row.key}`)
    } catch (e) {
      console.error(`::error::could not file the finding to the board: ${e.message}`)
    }
  }

  const { code, reasons } = exitDecision(findings, gaps)
  for (const r of reasons) console.error(`::error::${r}`)

  // NOT process.exit(). On Windows, exiting while undici still holds its keep-alive sockets
  // aborts the process with a libuv assertion (UV_HANDLE_CLOSING, src\win\async.c:76) and
  // reports 3221226505 instead of the exit code this check just decided — so anyone running
  // the watchdog on their own machine sees a crash rather than its verdict. Letting the loop
  // drain gives the real code on every platform; the unref'd backstop cannot hold the
  // process open by itself, and only fires if a stuck socket is keeping it alive anyway.
  process.exitCode = code
  setTimeout(() => process.exit(code), 10_000).unref()
}
