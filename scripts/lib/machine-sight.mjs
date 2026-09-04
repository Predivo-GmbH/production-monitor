/**
 * WHAT CAN THIS MACHINE ACTUALLY SEE?
 *
 * WHY THIS EXISTS. On 2026-09-04 the hourly board job ran on the laptop and wrote 42 unknown /
 * 14 fail / 2 pass. The same code, hand-run on the work PC half an hour earlier, produced far
 * fewer unknowns. The difference was not the board and not the code: it was keys. The laptop's own
 * output said so, one item at a time - "no management token on this disk opens
 * Predivo-GmbH/BoatBuddy" - and each of those was written to the board as an ordinary UNKNOWN.
 *
 * Measured 2026-09-05, the same enumeration on both machines:
 *   work PC   17 tokens -> 22 distinct Supabase projects reachable
 *   laptop    16 tokens ->  3
 * The machine that runs every automation every hour is structurally blind to 19 of 22 products.
 * Its tokens are not missing; 13 of its 16 are stale copies that open nothing, left behind by the
 * 2026-08-29 rotation, because credential files are deliberately excluded from the shared tree.
 *
 * THE POINT OF THIS FILE. "I could not judge this" and "this is unknown" are different facts, and
 * only one of them is about the product. A blind machine that reports unknowns looks exactly like
 * a machine reporting on a fleet that happens to be unknowable - which is how a permanent blind
 * spot survived as ordinary noise. This makes the blindness say its own name, once, at the top of
 * a run, instead of hiding inside per-item errors.
 *
 * It NEVER prints a token, only an 8-character SHA-256 fingerprint and the project refs a token
 * opens.
 */
import { discoverLocalTokens, projectsFor, fingerprint } from './local-management-tokens.mjs'

/**
 * Every project ref this machine's management tokens can actually open, checked against the live
 * API rather than inferred from which files exist.
 *
 * Returns { refs:Set, tokens:n, live:n, dead:[fingerprints], unreachable:boolean }.
 * `unreachable` is true when the API could not be asked at all - which is NOT the same as "this
 * machine sees nothing", and callers must not report it as blindness.
 */
export async function machineSight({ discover = discoverLocalTokens, projects = projectsFor } = {}) {
  let found
  try { found = discover() } catch { return { refs: new Set(), tokens: 0, live: 0, dead: [], unreachable: true } }
  const refs = new Set()
  const dead = []
  let live = 0
  let anyAnswered = false
  for (const entry of found) {
    let res
    try { res = await projects(entry.token) } catch { continue }
    if (res && res.status) anyAnswered = true
    const list = (res && res.projects) || []
    if (!list.length) { dead.push(fingerprint(entry.token)); continue }
    live++
    for (const p of list) { const r = p && (p.id || p.ref); if (r) refs.add(r) }
  }
  return { refs, tokens: found.length, live, dead, unreachable: found.length > 0 && !anyAnswered }
}

/**
 * The banner. `expected` is the set of refs the run is about to make judgements about.
 *
 * Deliberately prints even when nothing is blind: a stated "sees all of them" is a measurement,
 * while silence is something anyone can read as good news.
 */
export function sightBanner(sight, expected = []) {
  const want = [...new Set(expected)].filter(Boolean)
  const blind = want.filter((r) => !sight.refs.has(r))
  const lines = []
  if (sight.unreachable) {
    lines.push('SIGHT: could not ask the Supabase API at all, so what this machine can see is UNKNOWN.')
    lines.push('       That is not the same as seeing nothing - do not read the verdicts below as blindness.')
    return { lines, blind: [], unknown: true }
  }
  lines.push(`SIGHT: ${sight.live} of ${sight.tokens} management tokens on this machine are live, opening ${sight.refs.size} project(s).`)
  if (sight.dead.length) {
    lines.push(`       ${sight.dead.length} token(s) open nothing at all: ${sight.dead.join(', ')}`)
  }
  if (!want.length) return { lines, blind: [], unknown: false }
  if (!blind.length) {
    lines.push(`       All ${want.length} product(s) this run judges are reachable from here.`)
    return { lines, blind: [], unknown: false }
  }
  lines.push('')
  lines.push(`CANNOT JUDGE ${blind.length} OF ${want.length} PRODUCTS FROM THIS MACHINE - no token here opens them.`)
  lines.push('Everything reported about these is "I could not look", NEVER "unknown" - the difference')
  lines.push('is that one is about this machine and the other would be about the product:')
  for (const r of blind) lines.push('  ' + r)
  return { lines, blind, unknown: false }
}
