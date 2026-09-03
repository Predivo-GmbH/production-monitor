#!/usr/bin/env node
/**
 * A LIVE PRODUCT BEING UNREACHABLE MUST REACH ROGER. Nothing has ever filed one.
 *
 * WHY (2026-08-27, and this is the uncomfortable part). Roger's own audit of what should be
 * monitored, written the same day, puts "a live product is down" on the phone-and-email route
 * with "its own tile in the top screen, red when non-zero" (§6). Its §9 then says the thing this
 * script exists to fix:
 *
 *   "Money, a stuck customer and a dying credential are armed to ring your phone and have never
 *    received a single report, because nothing files one."
 *
 * `production-monitor` is armed in `signal_page_policy` — may_page, 900s self-heal delay,
 * wake_me — and has been since 2026-08-24 with the note "Confirmed production down. 15 min
 * self-heal window." Nothing has ever filed a confirmed production-down signal into it. The alarm
 * was wired to a sensor that did not exist. Meanwhile the only place the count appeared at all
 * was a tile on `/monitoring`, and that tile was lost in the merge into `/signals` on 2026-08-24
 * (see Cockpit/src/lib/fleetHealth.ts for how). So between 24 and 27 August the number of
 * products a customer could not use was on no page and in no alarm.
 *
 * This is the sensor. Built to the same shape as check-healthchecks-down.mjs on purpose: read
 * with a key, file through `signal-intake`, dedup on a stable key, and never report a failed read
 * as a clean result.
 *
 * ── THE PREDICATE IS A SUBSET OF THE TILE'S, NEVER A SUPERSET ───────────────────────────────
 *
 * The Cockpit tile (`Cockpit/src/lib/fleetHealth.ts`) counts four customer-facing failures: the
 * site does not load, the auth backend is 5xx, the login endpoint is failing, or the domain
 * serves something that is not our product. This script tests THREE of them and deliberately
 * drops the login-endpoint probe. That asymmetry is the safe direction and it is chosen:
 *
 *   * the tile is read when a person opens a page; this runs every hour, unattended, forever;
 *   * the login probe POSTs to `/auth/v1/otp`, which is rate-limited, and `health-monitor` reads
 *     a 429 back as HEALTHY. A pager whose own probe can trip the limit it then misreads is a
 *     pager that can cause the outage it reports. That is not a theoretical worry here: on
 *     2026-08-24 "Valrano: all deployed edge functions 503" turned out to be a boot storm caused
 *     by the probe's own parallel fan-out, not an outage.
 *
 * Subset, not superset, means this can never ring for something the tile does not show. A person
 * woken at 03:00 can always open the board and see the same fact.
 *
 * ── ONLY PERSISTENT FAILURE ALARMS, and it takes TWO HOURS to ring ──────────────────────────
 *
 * Fleet policy, stated in the audit's own "what I would NOT watch" table: "Single failures of
 * anything — already fleet policy and correct. Only persistent failure alarms." Two mechanisms,
 * because they catch different things:
 *
 *   1. WITHIN a run, a product that fails is probed CONFIRM_ATTEMPTS times, CONFIRM_GAP_MS apart.
 *      One TLS reset or one cold start is not an outage. All attempts must fail.
 *   2. ACROSS runs, the first confirmed sighting files the signal at `warning` /
 *      `needs_human: false`. `upsert_signal` records that as `not-eligible` and NOTHING RINGS —
 *      the paging branch requires `needs_human AND severity = 'critical'` (BackOffice migration
 *      126, line 234). Only when the NEXT hourly run finds the same product still unreachable is
 *      the row escalated to `critical` / `needs_human: true`, which arms the 900s self-heal delay
 *      and the phone. A product down for fifty minutes is on the board and never rings.
 *
 * ── WHY IT IS ALLOWED TO RING AT ALL, with the rate proven rather than asserted ─────────────
 *
 * Read off the live production board on 2026-08-27 before writing a line of this: `fleet_signals`
 * holds 305 rows and `monitoring_incidents` 268, both starting 2026-08-13 — the complete recorded
 * incident history of this fleet. The number of them in which a live product's site or auth was
 * unreachable to a customer is ZERO. Every row matching an outage word is internal machinery: a
 * CI runner host, a balance scraper, an Anthropic 529, an edge-function boot storm.
 *
 * Rare and serious is exactly the profile that earns an interruption, and Roger's measure is that
 * more than about two alerts a week means the alerts are wrong. On fourteen days of history this
 * adds zero. If that ever stops being true, the two-hour rule above means the fleet was genuinely
 * broken for two hours, which is worth a phone call by anyone's measure.
 *
 * The counter-argument, recorded because it is real: fourteen days is a short window and the
 * TRUE-positive rate is not the FALSE-positive rate. That is what the subset predicate, the
 * in-run reconfirmation and the two-run escalation are all for — and it is why this ships on a
 * branch. Merging it to `master` is what arms it, and that is Roger's to do.
 *
 * ── COVERAGE: the hole described here is CLOSED (re-measured 2026-09-01) ─────────────────────
 *
 * This block used to read: "`fleet_projects` has 12 active rows and only 7 carry `in_health =
 * true`. arivioo, Predivo, BoatBuddy, Distribution-OS and Jass-Tour are checked by nothing."
 * That was true when written and is now FALSE. Read from production on 2026-09-01: 12 active
 * rows, 12 with `in_health = true` — all five named products included, predivo.ch among them.
 * Roger's ruling of 2026-08-28 was "every product needs to be watched all the time", and the
 * seeding was corrected to match it.
 *
 * The old text is kept above deliberately, because it nearly caused the same wrong answer twice:
 * a session checking this coverage question read this comment, found it agreeing with the board
 * row, and almost confirmed a gap that no longer existed. A COMMENT IS A RECORD OF WHAT WAS TRUE
 * WHEN SOMEBODY TYPED IT. The table is the system. Re-read `fleet_projects` before believing any
 * sentence in this file about coverage, including this one.
 *
 * The run-time count is still logged every run, so a real regression shows up as a number rather
 * than as prose nobody re-checks.
 *
 * Contract:  node scripts/check-products-down.mjs [--dry]
 *   env: BOARD_SUPABASE_SECRET or BACKOFFICE_SERVICE_ROLE_KEY  (reads fleet_projects, files the
 *        signal). Falls back to BackOffice/docs/Credentials.txt when run locally.
 * Exit 0 = judged (all reachable, or an alarm filed). Exit 1 = could not tell, which is never
 * "fine": a registry read that fails, or that returns an empty fleet, fails the run rather than
 * reporting zero products down.
 */
import { readFileSync } from 'fs'

const BO_REF = 'xoecpzfsskalvjrtcbbl'
const BO_BASE = `https://${BO_REF}.supabase.co`
const BO_CREDS = 'C:\\Business\\Internal Projects\\BackOffice\\docs\\Credentials.txt'
const NON_BROWSER_UA = 'products-down-producer/1.0'
const SOURCE = 'production-monitor'
const KEY_PREFIX = 'products-down'
const PROBE_TIMEOUT_MS = 10_000

/** A failure is re-probed this many times before it counts. All attempts must fail. */
export const CONFIRM_ATTEMPTS = 3
/** How long between those attempts. Long enough to outlast a cold start, short enough for CI. */
export const CONFIRM_GAP_MS = 10_000

function readBoSecret() {
  if (process.env.BOARD_SUPABASE_SECRET) return process.env.BOARD_SUPABASE_SECRET.trim()
  if (process.env.BACKOFFICE_SERVICE_ROLE_KEY) return process.env.BACKOFFICE_SERVICE_ROLE_KEY.trim()
  const txt = readFileSync(BO_CREDS, 'utf-8')
  const m = txt.match(/sb_secret_[A-Za-z0-9_]+/)
  if (!m) throw new Error(`no sb_secret_ key found in ${BO_CREDS}`)
  return m[0]
}

const withTimeout = (p, ms = PROBE_TIMEOUT_MS) =>
  Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('Timeout')), ms))])

// ── The probes. Each answers ONE customer-facing question, and each answers `null` for
//    "could not tell", which is never the same as "broken". ───────────────────────────────────

/** Does the site answer at all? A 5xx or a dead socket is what a visitor meets as a dead site. */
export async function probeSite(url) {
  try {
    const res = await withTimeout(fetch(url, { method: 'GET', redirect: 'follow', headers: { 'User-Agent': NON_BROWSER_UA } }))
    return { ok: res.status < 500, detail: `HTTP ${res.status}`, body: await res.text().catch(() => '') }
  } catch (err) {
    return { ok: false, detail: err.message, body: '' }
  }
}

/**
 * ANON KEY PER PRODUCT, because a keyless probe of this endpoint can NEVER see an outage.
 *
 * Env name is the product name upper-cased with everything non-alphanumeric removed, which is
 * the convention monitor.yml already uses for every other secret. ChannelMover is the one
 * product whose secrets predate its rename, so it is listed rather than guessed.
 */
const AUTH_KEY_ALIASES = { CHANNELMOVER: 'YTMIGRATION' }

export function authKeyEnvName(productName) {
  const slug = String(productName || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  return `${AUTH_KEY_ALIASES[slug] || slug}_ANON_KEY`
}

export function authKeyFor(productName, env = process.env) {
  const v = env[authKeyEnvName(productName)]
  return v && v.trim() ? v.trim() : null
}

/**
 * WHAT A STATUS FROM /auth/v1/health ACTUALLY MEANS — written after 2026-09-01, when this
 * function's predecessor reported "OK ReplyFlow" and "OK SignalScore" on every hourly run for
 * twenty hours while no customer of either product could log in.
 *
 * The old line was `ok: res.status < 500` on a fetch that sent no `apikey`. Supabase's gateway
 * rejects a keyless request itself, before it ever tries to reach GoTrue, and it answers
 * **401 "No API key found in request"**. 401 is under 500, so the probe answered healthy — and
 * it would answer healthy with the auth service deleted. Measured on both dead projects that
 * morning: keyless → 401, and the same URL with an anon key → 503 upstream connect error.
 *
 * So: only a KEYED probe can report health at all. A keyless or key-rejected probe is
 * `null` = could not tell, which is never a reason to page and never a reason to say fine.
 */
export function classifyAuth(status, { keyed }) {
  if (status >= 500) return false                 // GoTrue itself is failing. This is the outage.
  if (status === 401 || status === 403) return null // the gateway answered, not the service
  if (!keyed) return null                          // any keyless verdict is unproven by construction
  return true
}

/** Is the product's own auth backend up? Down means nobody can sign in or load their data. */
export async function probeAuth(ref, key = null) {
  // NO REGISTERED BACKEND IS "COULD NOT TELL", NOT "HEALTHY" (2026-09-03, closing F29 of the audit).
  // This used to return `ok: true`. `true` in this file means PROVEN healthy — a customer can log
  // in — and nothing was checked here, so that was a false green. It was masked because
  // `reasonsUnreachable` only acts on `ok === false` and the coverage denominator excludes blank
  // refs, but it is the exact F5 trap: BoatBuddy, Distribution-OS and arivioo each have a LIVE
  // Supabase backend and a blank `supabase_ref` row, so this branch was reporting their login as
  // healthy while nothing watched it. `null` is the value `classifyAuth` already uses for
  // could-not-tell, so a future reader that trusts `ok === true` as "login is up" can never be
  // handed an unchecked product dressed as a proven one.
  if (!ref) return { ok: null, detail: 'no Supabase project in the registry — nothing was checked, so this proves nothing' }
  const headers = { 'User-Agent': NON_BROWSER_UA }
  if (key) { headers.apikey = key; headers.Authorization = `Bearer ${key}` }
  try {
    const res = await withTimeout(fetch(`https://${ref}.supabase.co/auth/v1/health`, { headers }))
    const ok = classifyAuth(res.status, { keyed: Boolean(key) })
    const why = ok === null ? (key ? ' — the gateway answered, not the auth service' : ' — no anon key for this product, so this proves nothing') : ''
    return { ok, detail: `HTTP ${res.status}${why}` }
  } catch (err) {
    return { ok: false, detail: err.message }
  }
}

/**
 * Say out loud how many auth verdicts were actually proven. An unproven one must never read as fine.
 *
 * The denominator is products carrying a `supabase_ref` IN THE REGISTRY, not products that have a
 * backend, and those are not the same set: on 2026-09-01 BoatBuddy, Distribution-OS and arivioo
 * each had a live Supabase project in their own credentials file and a blank `supabase_ref` row,
 * so every layer treated them as site-only and nothing checked whether anyone could log in. This
 * line therefore reports BOTH numbers. A ratio that only counts what it was handed is how "7 of 7"
 * would read as full coverage over a fleet of twelve.
 */
export function authCoverageLine(proven, expected, unproven = [], noBackend = 0) {
  const tail = noBackend > 0
    ? `; ${noBackend} more carry no backend in the registry, so no login is checked for them at all`
    : ''
  if (proven === expected) return `auth: ${proven} of ${expected} products with a registered backend actually probed${tail}`
  return `auth: only ${proven} of ${expected} products with a registered backend could be probed — UNPROVEN for ${unproven.join(', ')} (missing anon key); their logins are watched by NOTHING here${tail}`
}

/**
 * Is the domain still serving OUR product? A lapsed domain, a misdirected deploy or a parking
 * page all answer 200 and all mean a customer arrives somewhere that is not us.
 *
 * A body we could NOT read is `null`, not a mismatch — that case is already probeSite's job, and
 * reading a timeout as "the wrong page is served" would invent an outage out of a slow response.
 */
export function brandMatches(html, keyword) {
  if (!keyword) return null
  if (typeof html !== 'string' || html === '') return null
  const title = (html.match(/<title[^>]*>(.*?)<\/title>/is) || [])[1] || ''
  return `${title} ${html.slice(0, 5000)}`.toLowerCase().includes(String(keyword).toLowerCase())
}

/**
 * The whole verdict for one product, pure and testable: probe results in, plain-English reasons
 * out. Empty array = reachable. This is the function the tests hold to the tile's definition.
 */
export function reasonsUnreachable({ site, auth, brand }) {
  const reasons = []
  if (site && site.ok === false) reasons.push(`the site itself does not load (${site.detail})`)
  if (auth && auth.ok === false) reasons.push(`its database and login backend is not answering (${auth.detail})`)
  if (brand === false) reasons.push('the domain is serving something that is not this product')
  return reasons
}

/** Probe once. Split out so the retry loop and the tests can both drive it. */
async function probeOnce(p) {
  const [site, auth] = await Promise.all([probeSite(p.prod_url), probeAuth(p.supabase_ref, authKeyFor(p.name))])
  const brand = site.ok ? brandMatches(site.body, p.brand_keyword) : null
  return { site, auth, brand }
}

/**
 * Probe, and only believe a FAILURE after it repeats. A pass on any attempt clears the product
 * immediately — we are looking for persistent breakage, not for one unlucky packet.
 */
export async function confirmUnreachable(p, probe = probeOnce, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
  let last = null
  for (let attempt = 1; attempt <= CONFIRM_ATTEMPTS; attempt++) {
    last = await probe(p)
    const reasons = reasonsUnreachable(last)
    if (reasons.length === 0) return { reasons: [], attempts: attempt, last }
    if (attempt < CONFIRM_ATTEMPTS) await sleep(CONFIRM_GAP_MS)
  }
  return { reasons: reasonsUnreachable(last), attempts: CONFIRM_ATTEMPTS, last }
}

/**
 * What a confirmed outage says on the cockpit, and whether it is allowed to ring.
 *
 * `confirmed` is the SECOND consecutive hourly sighting. Until then this is a board row that
 * `upsert_signal` files as `not-eligible` and no phone hears about.
 */
export function signalFor(product, reasons, { confirmed }) {
  const what = reasons.join('; ')
  return {
    source: SOURCE,
    key: `${KEY_PREFIX}:${product.name}`,
    kind: 'incident',
    product: product.name,
    severity: confirmed ? 'critical' : 'warning',
    needs_human: confirmed,
    state: 'open',
    title: confirmed
      ? `${product.name} is down for customers, and has been for over an hour`
      : `${product.name} looks unreachable — confirming on the next run`,
    summary: confirmed
      ? `${product.name} (${product.prod_url}) has failed every check on two consecutive hourly runs: ${what}. A customer trying to use it right now cannot.`
      : `${product.name} (${product.prod_url}) failed every attempt this run: ${what}. Filed but NOT alerted: a single bad hour is not an outage. If the next hourly run finds the same thing, this escalates and rings.`,
    detail: { url: product.prod_url, reasons, confirmed },
    link: 'https://cockpit.predivo.ch/signals',
  }
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

/**
 * AN EMPTY FLEET IS A FAILED READ, not a healthy one. `health-monitor` answers 200 with
 * `summary.down = 0` in this case and the Cockpit tile refuses to draw a zero from it; this
 * refuses to draw a green RUN from it, for the same reason. A monitor reporting "0 products down"
 * because it reached nothing is the worst outcome this script has available to it.
 *
 * Exported and separate from `main` so it can be tested. It could not be, and the rule the whole
 * script is built around was the one thing in it nothing asserted.
 */
export function assertFleetReadable(fleet) {
  if (!Array.isArray(fleet) || fleet.length === 0) {
    throw new Error('fleet_projects returned no health-monitored products — nothing was checked, so nothing can be reported as fine')
  }
  return fleet
}

/**
 * What the run says it covered. Since 2026-08-28 every active product carries `in_health = true`
 * (Roger: "Every product needs to be watched all the time"), so `uncovered` is 0 and the line
 * says so plainly. It is kept, not deleted: it is the sentence that made the gap visible in the
 * first place, and if a product is ever added to the registry without being switched on, this is
 * what says so on every hourly run instead of quietly checking eleven and calling it the fleet.
 */
export function coverageLine(checked, active) {
  const uncovered = active - checked
  return `products: checking ${checked} of ${active} active products` +
    (uncovered > 0
      ? ` — ${uncovered} carry in_health=false and are watched by NOTHING`
      : ' — every active product is watched')
}

async function main() {
  const dry = process.argv.includes('--dry')
  const secret = readBoSecret()

  const fleet = assertFleetReadable(await boGet(
    secret,
    'fleet_projects?in_health=eq.true&active=eq.true&select=name,supabase_ref,prod_url,brand_keyword&order=sort_order',
  ))
  const active = await boGet(secret, 'fleet_projects?active=eq.true&select=name')
  console.log(coverageLine(fleet.length, active.length))

  const open = await boGet(secret, `fleet_signals?source=eq.${SOURCE}&state=eq.open&key=like.${KEY_PREFIX}:*&select=key,severity`)
  const openKeys = new Map(open.map((r) => [r.key, r]))

  const down = []
  const authExpected = fleet.filter((p) => p.supabase_ref).map((p) => p.name)
  const authUnproven = []
  for (const p of fleet) {
    const { reasons, attempts, last } = await confirmUnreachable(p)
    if (p.supabase_ref && last && last.auth && last.auth.ok === null) authUnproven.push(p.name)
    if (reasons.length === 0) {
      const caveat = p.supabase_ref && last && last.auth && last.auth.ok === null ? `  (auth UNPROVEN: ${last.auth.detail})` : ''
      console.log(`  OK    ${p.name}${caveat}`)
      continue
    }
    console.log(`  DOWN  ${p.name} after ${attempts} attempt(s): ${reasons.join('; ')}`)
    down.push({ p, reasons })
  }
  console.log(authCoverageLine(authExpected.length - authUnproven.length, authExpected.length, authUnproven, fleet.length - authExpected.length))

  if (dry) { console.log('--dry: nothing written.'); return 0 }

  let ringing = 0
  for (const { p, reasons } of down) {
    // Already open from a previous run = this is the second consecutive sighting. That, and only
    // that, is what turns a board row into a phone call.
    const confirmed = openKeys.has(`${KEY_PREFIX}:${p.name}`)
    if (confirmed) ringing++
    await fileSignal(secret, signalFor(p, reasons, { confirmed }))
  }

  // Recovered: resolve only rows that are actually open, so "self-resolved" on the cockpit stays
  // a fact about the fleet rather than an artefact of this script running every hour.
  const downKeys = new Set(down.map(({ p }) => `${KEY_PREFIX}:${p.name}`))
  for (const key of openKeys.keys()) {
    if (downKeys.has(key)) continue
    await fileSignal(secret, {
      source: SOURCE, key, kind: 'incident', severity: 'info', state: 'resolved',
      title: `${key.slice(KEY_PREFIX.length + 1)} is reachable again`,
      summary: 'It answers, its backend is up and it is serving itself. This cleared without anyone doing anything.',
      link: 'https://cockpit.predivo.ch/signals',
    })
    console.log(`  recovered: ${key} — signal resolved.`)
  }

  if (ringing) console.error(`::error::${ringing} product(s) have now been unreachable for two consecutive runs. Filed as critical on /signals.`)
  else if (down.length) console.warn(`::warning::${down.length} product(s) look unreachable. Filed on /signals WITHOUT alerting; the next run decides.`)
  return 0
}

if (import.meta.url === (await import('url')).pathToFileURL(process.argv[1] || '').href) {
  main().then(
    (code) => { process.exitCode = code },
    (e) => {
      console.error(`::error::the product-reachability check could NOT run (${e.message}). Unknown is not healthy.`)
      process.exitCode = 1
    },
  )
}
