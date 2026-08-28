/**
 * Unit tests for the "a live product is unreachable" producer.
 *
 * Every one of these was watched to FAIL first against the real defect it names — the naive
 * version of this script (probe once, file critical immediately, count anything health-monitor
 * calls `down`) passes none of the four that matter and would have put an expired internal
 * credential and a single dropped packet on Roger's phone.
 *
 * Run: node test/check-products-down.test.mjs   (exit 0 = all pass)
 */
import assert from 'node:assert'
import {
  reasonsUnreachable, brandMatches, signalFor, confirmUnreachable, CONFIRM_ATTEMPTS,
  probeAuth, assertFleetReadable, coverageLine,
} from '../scripts/check-products-down.mjs'

let n = 0
const t = (name, fn) => { fn(); n++; console.log(`  ok - ${name}`) }
const at = async (name, fn) => { await fn(); n++; console.log(`  ok - ${name}`) }

const up = { site: { ok: true, detail: 'HTTP 200' }, auth: { ok: true, detail: 'HTTP 200' }, brand: true }

// ── what counts as a customer being unable to use the product ────────────────────────────────

t('a reachable product produces no reasons at all', () => {
  assert.deepEqual(reasonsUnreachable(up), [])
})

t('a site that does not load is an outage', () => {
  const r = reasonsUnreachable({ ...up, site: { ok: false, detail: 'HTTP 503' } })
  assert.equal(r.length, 1)
  assert.match(r[0], /the site itself does not load/)
})

t('an auth backend that is 5xx is an outage — nobody can sign in or load their data', () => {
  const r = reasonsUnreachable({ ...up, auth: { ok: false, detail: 'HTTP 502' } })
  assert.match(r[0], /database and login backend/)
})

t('a domain serving something that is not our product is an outage', () => {
  assert.match(reasonsUnreachable({ ...up, brand: false })[0], /not this product/)
})

t('several failures are reported together, not just the first one', () => {
  const r = reasonsUnreachable({ site: { ok: false, detail: 'Timeout' }, auth: { ok: false, detail: 'HTTP 500' }, brand: false })
  assert.equal(r.length, 3)
})

// ── the things that must NEVER be called a product being down ────────────────────────────────

t('an unreadable brand check is unknown, NOT a mismatch', () => {
  // Defect: treating "we could not read the page" as "the wrong page is served" invents an
  // outage out of a slow response. The site probe already owns that failure.
  assert.equal(brandMatches('', 'ReplyFlow'), null)
  assert.equal(brandMatches(null, 'ReplyFlow'), null)
  assert.deepEqual(reasonsUnreachable({ ...up, brand: null }), [])
})

t('a product with no brand keyword configured is not accused of serving the wrong page', () => {
  assert.equal(brandMatches('<title>anything</title>', ''), null)
})

t('the brand check reads the title and the head of the body, case-insensitively', () => {
  assert.equal(brandMatches('<title>ReplyFlow — reply faster</title><body>x</body>', 'replyflow'), true)
  assert.equal(brandMatches('<title>This domain is for sale</title>', 'ReplyFlow'), false)
})

t('a product with no Supabase project is not counted as having a dead backend', () => {
  // A marketing site has no auth backend. Absence is not failure.
  assert.deepEqual(reasonsUnreachable({ site: { ok: true }, auth: { ok: true, detail: 'no Supabase project — nothing to check' }, brand: true }), [])
})

t('an expired MANAGEMENT token is not in this predicate at all', () => {
  // health-monitor folds configCheck.errors — which contains 'Management token expired' — into
  // its own overallStatus:'down'. A Supabase management PAT is an internal credential no
  // customer touches, and this fleet has had retired PATs more than once. Nothing this function
  // can be handed makes it say "down" for one, because it is not one of its inputs.
  assert.deepEqual(Object.keys(up).sort(), ['auth', 'brand', 'site'])
  assert.deepEqual(reasonsUnreachable(up), [])
})

// ── only PERSISTENT failure alarms ───────────────────────────────────────────────────────────

await at('one bad probe is not an outage: a later attempt that passes clears it', async () => {
  // The defect: probing once. On 2026-08-24 "Valrano: all edge functions 503" was a boot storm
  // caused by the probe's own parallel fan-out, and it reached the board as an outage.
  let calls = 0
  const flaky = async () => (++calls === 1 ? { site: { ok: false, detail: 'Timeout' }, auth: { ok: true }, brand: null } : up)
  const { reasons, attempts } = await confirmUnreachable({}, flaky, async () => {})
  assert.deepEqual(reasons, [])
  assert.equal(attempts, 2)
})

await at('a failure that repeats every attempt IS an outage', async () => {
  let calls = 0
  const dead = async () => { calls++; return { site: { ok: false, detail: 'HTTP 503' }, auth: { ok: true }, brand: null } }
  const { reasons, attempts } = await confirmUnreachable({}, dead, async () => {})
  assert.equal(reasons.length, 1)
  assert.equal(attempts, CONFIRM_ATTEMPTS)
  assert.equal(calls, CONFIRM_ATTEMPTS)
})

await at('a product that passes first time is probed once, not three times', async () => {
  let calls = 0
  const fine = async () => { calls++; return up }
  await confirmUnreachable({}, fine, async () => {})
  assert.equal(calls, 1)
})

// ── what may ring, and what may not ──────────────────────────────────────────────────────────

const PRODUCT = { name: 'ReplyFlow', prod_url: 'https://replyflow.help' }
const REASONS = ['the site itself does not load (HTTP 503)']

t('the FIRST sighting cannot ring: warning, needs_human false', () => {
  // upsert_signal pages only when needs_human AND severity = 'critical'
  // (BackOffice migration 126). Anything else is recorded 'not-eligible' and stays silent.
  const s = signalFor(PRODUCT, REASONS, { confirmed: false })
  assert.equal(s.severity, 'warning')
  assert.equal(s.needs_human, false)
  assert.match(s.summary, /NOT alerted/)
})

t('the SECOND consecutive sighting rings: critical, needs_human true', () => {
  const s = signalFor(PRODUCT, REASONS, { confirmed: true })
  assert.equal(s.severity, 'critical')
  assert.equal(s.needs_human, true)
  assert.equal(s.source, 'production-monitor', 'the armed policy source, or nothing can ever ring')
})

t('the key is stable across runs, or dedup and the two-run rule both break', () => {
  const a = signalFor(PRODUCT, REASONS, { confirmed: false }).key
  const b = signalFor(PRODUCT, ['something else entirely'], { confirmed: true }).key
  assert.equal(a, b)
  assert.equal(a, 'products-down:ReplyFlow')
})

t('the title says what a customer meets, and names the product', () => {
  const s = signalFor(PRODUCT, REASONS, { confirmed: true })
  assert.match(s.title, /ReplyFlow/)
  assert.match(s.title, /down for customers/)
  assert.match(s.summary, /replyflow\.help/)
  assert.deepEqual(s.detail.reasons, REASONS)
})

// -- EVERY PRODUCT IS WATCHED ALL THE TIME (2026-08-28, Roger's ruling) ----------------------
//
// `fleet_projects` had 12 active products and 7 carried `in_health = true`. All 12 do now, and the
// five that were added -- arivioo, BoatBuddy, Distribution-OS, Jass-Tour, Predivo -- have NO
// `supabase_ref`. They are websites. This producer rings Roger's phone, so the cost of reading
// "there is no backend here" as "the backend is down" is a 03:00 phone call about five products
// that are working perfectly.

await at('probeAuth does not call anything for a product with no Supabase project', async () => {
  // THE DEFECT, at its source rather than at the predicate: without the `if (!ref)` guard this
  // fetches `https://.supabase.co/auth/v1/health` -- a real request, to a real hostname, that
  // fails -- and returns ok:false. Five of the twelve would be filed as unreachable on the first
  // run and CRITICAL on the second. Proven by injecting exactly that: with the guard removed this
  // assertion goes red, and so do the two below it.
  for (const missing of [null, undefined, '']) {
    const r = await probeAuth(missing)
    assert.equal(r.ok, true, `probeAuth(${JSON.stringify(missing)}) must not report a failure`)
    assert.match(r.detail, /nothing to check/)
  }
})

await at('a whole fleet of backend-less websites produces zero outages', async () => {
  // The end-to-end shape of the ruling: twelve watched, zero down. Not five down.
  const fleet = [
    { name: 'arivioo', supabase_ref: null, prod_url: 'https://arivioo.com' },
    { name: 'Predivo', supabase_ref: null, prod_url: 'https://predivo.ch' },
    { name: 'BoatBuddy', supabase_ref: null, prod_url: 'https://boatbuddy.predivo.ch' },
    { name: 'Distribution-OS', supabase_ref: null, prod_url: 'https://distributionos.predivo.ch' },
    { name: 'Jass-Tour', supabase_ref: null, prod_url: 'https://beize-jass-tour.mueller.ro' },
  ]
  for (const p of fleet) {
    const auth = await probeAuth(p.supabase_ref)
    // Site and brand are the real checks for these, and both pass here by construction. The point
    // of the assertion is that the ABSENT backend contributes nothing, either way.
    assert.deepEqual(reasonsUnreachable({ site: { ok: true }, auth, brand: true }), [], p.name)
  }
})

t('a backend-less website is still down when its SITE is dead', () => {
  // Making the five safe must not make them unwatchable. This is what they were switched on for.
  const noBackend = { ok: true, detail: 'no Supabase project - nothing to check' }
  const r = reasonsUnreachable({ site: { ok: false, detail: 'HTTP 503' }, auth: noBackend, brand: true })
  assert.equal(r.length, 1)
  assert.match(r[0], /the site itself does not load/)
})

t('a backend-less website is still down when its domain serves somebody else', () => {
  // The lapsed-domain case, which is the real risk for a site with nothing behind it: a parking
  // page, an expired domain and a misdirected deploy all answer HTTP 200.
  const noBackend = { ok: true, detail: 'no Supabase project - nothing to check' }
  const r = reasonsUnreachable({ site: { ok: true }, auth: noBackend, brand: false })
  assert.match(r[0], /not this product/)
})

// -- unknown is never zero -------------------------------------------------------------------

t('an EMPTY fleet read fails the run - it is never "no products are down"', () => {
  // The rule this whole script is built around, and until now the one thing in it that nothing
  // asserted, because it lived un-exported inside main(). Defect: `if (fleet.length)` or no check
  // at all, at which point a registry read that returned nothing reports a green run over a fleet
  // it never looked at. `health-monitor` answers 200 with down:0 in exactly this case, so this is
  // not a hypothetical failure mode.
  assert.throws(() => assertFleetReadable([]), /nothing was checked/)
  assert.throws(() => assertFleetReadable(null), /nothing was checked/)
  assert.throws(() => assertFleetReadable(undefined), /nothing was checked/)
  assert.throws(() => assertFleetReadable({ error: 'permission denied' }), /nothing was checked/)
  assert.deepEqual(assertFleetReadable([{ name: 'x' }]), [{ name: 'x' }])
})

t('the run says how much of the fleet it covered, both ways', () => {
  // It reads "every active product is watched" now, and it has to be able to say the opposite the
  // day somebody adds a product to the registry without switching it on.
  assert.match(coverageLine(12, 12), /checking 12 of 12/)
  assert.match(coverageLine(12, 12), /every active product is watched/)
  assert.match(coverageLine(7, 12), /5 carry in_health=false and are watched by NOTHING/)
})

console.log(`\n${n} assertions passed.`)
