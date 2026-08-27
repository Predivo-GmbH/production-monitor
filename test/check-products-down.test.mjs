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

console.log(`\n${n} assertions passed.`)
