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
  classifyAuth, authKeyEnvName, authKeyFor, authCoverageLine,
  isNoAnswer, failedWithoutAnswer, correlateOutage, correlatedSignal, mapPool, addressOf,
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

await at('probeAuth for a product with no Supabase project probes nothing and reports could-not-tell, never a pass', async () => {
  // TWO defects are guarded here, at the source rather than at the predicate.
  //
  // (1) Without the `if (!ref)` guard this fetches `https://.supabase.co/auth/v1/health` -- a real
  //     request, to a real hostname, that fails -- and returns ok:false. Five of the twelve would
  //     be filed unreachable on the first run and CRITICAL on the second. With the guard removed
  //     the `!== false` assertion below goes red.
  //
  // (2) F29, closed 2026-09-03. This branch used to return `ok: true`. In this file `true` means
  //     PROVEN healthy -- a customer can log in -- and `null` means could-not-tell, the value
  //     `classifyAuth` returns when the gateway answered but the service was never reached. Nothing
  //     is checked here, so `true` was a false green: BoatBuddy, Distribution-OS and arivioo each
  //     have a LIVE Supabase backend and a blank `supabase_ref` row, and this branch called their
  //     unmonitored login healthy. Revert the source line to `ok: true` and the `=== null`
  //     assertion below goes red. It is behaviourally neutral today (the coverage denominator and
  //     the `p.supabase_ref` guards in main() already exclude blank refs); this locks the value so
  //     a future reader that trusts `ok === true` cannot be handed an unchecked product as a proven one.
  for (const missing of [null, undefined, '']) {
    const r = await probeAuth(missing)
    assert.notEqual(r.ok, false, `probeAuth(${JSON.stringify(missing)}) must never report a failure`)
    assert.strictEqual(r.ok, null, `an unchecked backend is could-not-tell (null), not proven-healthy (true)`)
    assert.match(r.detail, /nothing was checked|proves nothing/)
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


// ── THE 2026-09-01 DEFECT: a keyless probe of /auth/v1/health can never see an outage ────────
//
// ReplyFlow and SignalScore auth was dead for twenty hours and this sensor printed "OK" on every
// hourly run. Both statuses below were measured on the live projects that morning, while every
// customer login was failing: keyless -> 401 from the gateway, keyed -> 503 from GoTrue. The old
// predicate was `status < 500`, so the keyless 401 read as healthy. Every assertion here fails
// against that version.

t('a keyless 401 is NOT health - the gateway answered, the auth service was never reached', () => {
  assert.equal(classifyAuth(401, { keyed: false }), null)
  assert.notEqual(classifyAuth(401, { keyed: false }), true, 'this exact `true` cost 20 hours of downtime')
})

t('a keyed 503 from GoTrue is the outage, and says so', () => {
  assert.equal(classifyAuth(503, { keyed: true }), false)
  const r = reasonsUnreachable({ site: { ok: true }, auth: { ok: false, detail: 'HTTP 503' }, brand: true })
  assert.equal(r.length, 1)
  assert.match(r[0], /database and login backend/)
})

t('a keyed 200 is the only thing allowed to mean healthy', () => {
  assert.equal(classifyAuth(200, { keyed: true }), true)
  assert.equal(classifyAuth(200, { keyed: false }), null, 'without a key even a 200 proves nothing about GoTrue')
})

t('could-not-tell never pages: an unproven auth verdict produces no reason', () => {
  assert.deepEqual(reasonsUnreachable({ site: { ok: true }, auth: { ok: null, detail: 'HTTP 401' }, brand: true }), [])
})

t('the anon key env name follows the convention monitor.yml already uses', () => {
  assert.equal(authKeyEnvName('ReplyFlow'), 'REPLYFLOW_ANON_KEY')
  assert.equal(authKeyEnvName('SignalScore'), 'SIGNALSCORE_ANON_KEY')
  assert.equal(authKeyEnvName('Distribution-OS'), 'DISTRIBUTIONOS_ANON_KEY')
  assert.equal(authKeyEnvName('Jass-Tour'), 'JASSTOUR_ANON_KEY')
  assert.equal(authKeyEnvName('ChannelMover'), 'YTMIGRATION_ANON_KEY', 'renamed product, secrets kept the old prefix')
})

t('a blank key is no key, so it can never be passed off as a keyed probe', () => {
  assert.equal(authKeyFor('ReplyFlow', { REPLYFLOW_ANON_KEY: '   ' }), null)
  assert.equal(authKeyFor('ReplyFlow', {}), null)
  assert.equal(authKeyFor('ReplyFlow', { REPLYFLOW_ANON_KEY: 'sb_publishable_x' }), 'sb_publishable_x')
})

t('a run that could not prove an auth backend says so instead of reading as watched', () => {
  assert.match(authCoverageLine(11, 12, ['Predivo']), /UNPROVEN for Predivo/)
  assert.match(authCoverageLine(11, 12, ['Predivo']), /watched by NOTHING/)
  assert.match(authCoverageLine(12, 12), /12 of 12 products/)
})

t('a full score over a partial fleet says how many products it never looked at', () => {
  // 7 of 7 probed, out of twelve products: the three with a live Supabase project and a blank
  // registry row are the ones nobody would have counted. Defect: printing only the ratio.
  const line = authCoverageLine(7, 7, [], 5)
  assert.match(line, /7 of 7 products with a registered backend/)
  assert.match(line, /5 more carry no backend in the registry/)
  assert.match(line, /no login is checked for them at all/)
})

// ── AN OUTAGE CLAIM MUST FIRST PROVE THE OBSERVER COULD SEE ──────────────────────────────────
//
// Every test below was watched to fail first against the shipped behaviour of 2026-09-03, which
// filed one independent outage per product no matter how many failed at once or how they failed.
// The run that prompted them, 33719854715, reported BackOffice, ReplyFlow, SignalScore,
// ChannelMover and ScoutCopilot all "DOWN ... (Timeout)" while every one of them was serving
// traffic; the previous run had them all OK ten seconds apart.

t('an HTTP status is an answer; a timeout is silence', () => {
  assert.equal(isNoAnswer('HTTP 503'), false)
  assert.equal(isNoAnswer('HTTP 200'), false)
  assert.equal(isNoAnswer('Timeout'), true)
  assert.equal(isNoAnswer('fetch failed'), true)
  assert.equal(isNoAnswer(undefined), true)
})

t('a product that ANSWERED 503 is a real outage and is never explained away as silence', () => {
  // The whole correlation only applies to products that told us nothing. A machine that replies
  // "503" has been reached, so its brokenness is a fact about it, not about our network.
  assert.equal(failedWithoutAnswer({ site: { ok: false, detail: 'HTTP 503' }, auth: { ok: true }, brand: true }), false)
})

t('a product that timed out is silence, not evidence about the product', () => {
  assert.equal(failedWithoutAnswer({ site: { ok: false, detail: 'Timeout' }, auth: { ok: null }, brand: null }), true)
})

t('a domain serving the wrong page is not silence — we reached it and read it', () => {
  assert.equal(failedWithoutAnswer({ site: { ok: true, detail: 'HTTP 200' }, auth: { ok: true }, brand: false }), false)
})

t('a healthy product is not silence either', () => {
  assert.equal(failedWithoutAnswer({ site: { ok: true, detail: 'HTTP 200' }, auth: { ok: true }, brand: true }), false)
})

t('ONE product timing out is still that product: nothing is correlated away', () => {
  const v = correlateOutage([{ name: 'ReplyFlow', addr: '149.126.4.148', noAnswer: true }])
  assert.equal(v.kind, 'independent')
  assert.deepEqual(v.names, [])
})

t('products that go silent together on ONE address are ONE machine, not N outages', () => {
  // Measured 2026-09-03: backoffice.predivo.ch, signalscore.ch and channelmover.com all resolve
  // to 80.74.145.155, and so does the mail host tertia.sui-inter.net.
  const v = correlateOutage([
    { name: 'BackOffice', addr: '80.74.145.155', noAnswer: true },
    { name: 'SignalScore', addr: '80.74.145.155', noAnswer: true },
    { name: 'ChannelMover', addr: '80.74.145.155', noAnswer: true },
  ])
  assert.equal(v.kind, 'shared-host')
  assert.equal(v.addr, '80.74.145.155')
  assert.equal(v.names.length, 3)
})

t('THE REGRESSION: run 33719854715 filed five outages for ONE unreachable machine', () => {
  // MEASURED 2026-09-03, not assumed. Every prod_url in fleet_projects resolves to 80.74.145.155
  // -- all twelve products and the mail host tertia.sui-inter.net are one Swiss box. The five the
  // run got through before it was killed were therefore five names for one event, and the shipped
  // code was one hour away from ringing Roger's phone five times about five healthy products.
  const v = correlateOutage([
    { name: 'BackOffice', addr: '80.74.145.155', noAnswer: true },
    { name: 'ReplyFlow', addr: '80.74.145.155', noAnswer: true },
    { name: 'SignalScore', addr: '80.74.145.155', noAnswer: true },
    { name: 'ChannelMover', addr: '80.74.145.155', noAnswer: true },
    { name: 'ScoutCopilot', addr: '80.74.145.155', noAnswer: true },
  ], 12)
  assert.equal(v.kind, 'shared-host')
  assert.equal(v.addr, '80.74.145.155')
  assert.equal(v.names.length, 5)
  assert.equal(v.wholeFleet, false, 'five of twelve is not the whole fleet')
})

t('the row for an unreachable machine never asserts that the machine is DOWN', () => {
  // We cannot tell a dead box from a dead route to it, and the scarier reading is not ours to pick.
  const row = correlatedSignal(
    { kind: 'shared-host', addr: '80.74.145.155', names: ['A', 'B'], wholeFleet: false },
    { confirmed: true },
  )
  assert.match(row.summary, /could not be REACHED - either it is down, or the path to it/)
  assert.equal(/\bis down\b/.test(row.title), false, 'the title states as fact what was never observed')
})

t('when the silent machine carries the WHOLE fleet, the row says the pager is on it too', () => {
  const v = correlateOutage(
    Array.from({ length: 12 }, (_, i) => ({ name: `P${i}`, addr: '80.74.145.155', noAnswer: true })),
    12,
  )
  assert.equal(v.wholeFleet, true)
  const row = correlatedSignal(v, { confirmed: true })
  assert.match(row.summary, /alert mailbox is on the same address/)
})

t('a fleet spread over several addresses can still produce the blind verdict', () => {
  // Synthetic today -- every product is single-homed on 80.74.145.155 -- and kept precisely
  // because that is a fact about 2026-09-03, not a property of the code. The day one product
  // moves hosts, simultaneous silence across two machines stops being a shared-host story.
  const v = correlateOutage([
    { name: 'A', addr: '80.74.145.155', noAnswer: true },
    { name: 'B', addr: '149.126.4.148', noAnswer: true },
  ], 12)
  assert.equal(v.kind, 'observer')
  assert.equal(v.addrs.length, 2)
})

t('silence we could not even resolve is never mistaken for one shared machine', () => {
  // Two on one address plus one that would not resolve is NOT "one host": the unresolved one is
  // unaccounted for, and calling it a host outage would name a machine we never reached.
  const v = correlateOutage([
    { name: 'A', addr: '80.74.145.155', noAnswer: true },
    { name: 'B', addr: '80.74.145.155', noAnswer: true },
    { name: 'C', addr: null, noAnswer: true },
  ])
  assert.equal(v.kind, 'observer')
})

t('a genuine 503 outage is not hidden by a simultaneous timeout elsewhere', () => {
  // Only the silent ones are eligible. One silent product does not reach the threshold, so the
  // product that ANSWERED 503 still gets its own row through the normal path.
  const v = correlateOutage([
    { name: 'Valrano', addr: '1.1.1.1', noAnswer: false },
    { name: 'ReplyFlow', addr: '2.2.2.2', noAnswer: true },
  ])
  assert.equal(v.kind, 'independent')
  assert.equal(v.names.includes('Valrano'), false)
})

t('an empty or missing down-list is never an event', () => {
  assert.equal(correlateOutage([]).kind, 'independent')
  assert.equal(correlateOutage(undefined).kind, 'independent')
})

// ── what the single correlated row is allowed to say and do ─────────────────────────────────

t('the FIRST blind run cannot ring, exactly like every other first sighting here', () => {
  const v = { kind: 'observer', addrs: ['a', 'b'], names: ['X', 'Y'] }
  const row = correlatedSignal(v, { confirmed: false })
  assert.equal(row.severity, 'warning')
  assert.equal(row.needs_human, false)
})

t('a SECOND consecutive blind run rings — this can never bury a real fleet outage', () => {
  const v = { kind: 'observer', addrs: ['a', 'b'], names: ['X', 'Y'] }
  const row = correlatedSignal(v, { confirmed: true })
  assert.equal(row.severity, 'critical')
  assert.equal(row.needs_human, true)
})

t('the blind row never claims a product is down — that is the whole point of it', () => {
  const row = correlatedSignal({ kind: 'observer', addrs: ['a'], names: ['BackOffice'] }, { confirmed: false })
  assert.match(row.summary, /nothing here proves any product is down/i)
  assert.equal(/is down for customers/i.test(row.title), false)
})

t('a shared-host row names the machine and counts the products, and rings on the second run', () => {
  const v = { kind: 'shared-host', addr: '80.74.145.155', names: ['BackOffice', 'SignalScore', 'ChannelMover'] }
  const first = correlatedSignal(v, { confirmed: false })
  assert.equal(first.severity, 'warning')
  assert.equal(first.needs_human, false)
  const second = correlatedSignal(v, { confirmed: true })
  assert.equal(second.severity, 'critical')
  assert.equal(second.needs_human, true)
  assert.match(second.title, /80\.74\.145\.155/)
  assert.match(second.summary, /BackOffice, SignalScore, ChannelMover/)
})

t('the correlated keys are stable across runs, or the two-run rule cannot work at all', () => {
  const a = correlatedSignal({ kind: 'observer', addrs: ['x'], names: ['A'] }, { confirmed: false })
  const b = correlatedSignal({ kind: 'observer', addrs: ['y'], names: ['A', 'B'] }, { confirmed: true })
  assert.equal(a.key, b.key)
  assert.equal(a.key, 'products-down:monitor-blind')
  const h = correlatedSignal({ kind: 'shared-host', addr: '80.74.145.155', names: ['A'] }, { confirmed: false })
  assert.equal(h.key, 'products-down:host:80.74.145.155')
})

// ── resolving the address, which is the evidence the verdict above rests on ─────────────────
//
// Nothing exercised this at first, and that gap cost real time: the addresses in the original
// version of the test above were resolved from domains GUESSED off product names (replyflow.ch,
// scoutcopilot.ch) rather than read from fleet_projects (replyflow.help, scoutcopilot.com). The
// guessed ones pointed at different machines and the registry's all point at one, which inverted
// the verdict. A hostname is not a thing to be inferred from a product name.

await at('the address comes from the URL host, not the URL', async () => {
  const seen = []
  const addr = await addressOf('https://backoffice.predivo.ch/some/path?x=1', async (h) => {
    seen.push(h)
    return ['80.74.145.155']
  })
  assert.deepEqual(seen, ['backoffice.predivo.ch'])
  assert.equal(addr, '80.74.145.155')
})

await at('a host that will not resolve is null, never a guess and never a throw', async () => {
  assert.equal(await addressOf('https://nope.invalid', async () => { throw new Error('ENOTFOUND') }), null)
  assert.equal(await addressOf('not a url at all', async () => ['1.2.3.4']), null)
  assert.equal(await addressOf('https://empty.example', async () => []), null)
})

// ── the probe pool: the thing that stopped the check from killing its own run ────────────────

await at('the pool returns results in INPUT order, whatever order they finish in', async () => {
  const delays = [50, 5, 30, 1, 20]
  const out = await mapPool(delays, 2, async (ms, i) => {
    await new Promise((r) => setTimeout(r, ms))
    return i
  })
  assert.deepEqual(out, [0, 1, 2, 3, 4])
})

await at('the pool never exceeds its limit — the 2026-08-24 boot-storm lesson stays honoured', async () => {
  let live = 0
  let peak = 0
  await mapPool(Array.from({ length: 12 }, (_, i) => i), 6, async () => {
    live++
    peak = Math.max(peak, live)
    await new Promise((r) => setTimeout(r, 5))
    live--
  })
  assert.equal(peak <= 6, true, `peak concurrency was ${peak}`)
  assert.equal(peak > 1, true, 'a pool that never runs two at once has not fixed the timeout')
})

await at('an empty fleet does not hang the pool', async () => {
  assert.deepEqual(await mapPool([], 6, async () => 1), [])
})

console.log(`\n${n} assertions passed.`)
