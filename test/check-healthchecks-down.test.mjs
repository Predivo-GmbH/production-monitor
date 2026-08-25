/**
 * Unit tests for the "a scheduled job went dark" producer.
 *
 * Run: node test/check-healthchecks-down.test.mjs   (exit 0 = all pass)
 */
import assert from 'node:assert'
import { fileURLToPath } from 'node:url'
import { classifyChecks, signalFor, readHcKeys } from '../scripts/check-healthchecks-down.mjs'

let n = 0
const t = (name, fn) => { fn(); n++; console.log(`  ok - ${name}`) }

const NOW = Date.parse('2026-08-25T08:00:00.000Z')
const ago = (mins) => new Date(NOW - mins * 60_000).toISOString()

// ── what counts as an outage ───────────────────────────────────────────────────
t('down is an outage', () => {
  const { down } = classifyChecks([{ name: 'nightly-backup', status: 'down', last_ping: ago(300) }], NOW)
  assert.equal(down.length, 1)
})

t('grace is NOT an outage — the job is late inside its own allowance', () => {
  const { down, quiet } = classifyChecks([{ name: 'hourly', status: 'grace', last_ping: ago(70) }], NOW)
  assert.equal(down.length, 0)
  assert.equal(quiet.length, 1)
})

t('paused is NOT an outage — somebody switched it off on purpose', () => {
  const { down, neverPinged } = classifyChecks([{ name: 'seasonal', status: 'paused', last_ping: null }], NOW)
  assert.equal(down.length, 0)
  assert.equal(neverPinged.length, 0)
})

t('configured but never pinged is called out separately, and does not page', () => {
  const { down, neverPinged } = classifyChecks([{ name: 'ci-cost-guard', status: 'new', last_ping: null }], NOW)
  assert.equal(down.length, 0)
  assert.equal(neverPinged.length, 1)
})

t('a mixed fleet splits into exactly three buckets, losing nothing', () => {
  const checks = [
    { name: 'a', status: 'down', last_ping: ago(600) },
    { name: 'b', status: 'up', last_ping: ago(5) },
    { name: 'c', status: 'new', last_ping: null },
    { name: 'd', status: 'grace', last_ping: ago(65) },
  ]
  const { down, neverPinged, quiet } = classifyChecks(checks, NOW)
  assert.equal(down.length + neverPinged.length + quiet.length, checks.length)
  assert.deepEqual(down.map((c) => c.name), ['a'])
  assert.deepEqual(neverPinged.map((c) => c.name), ['c'])
})

// ── what the cockpit actually reads ────────────────────────────────────────────
t('the signal names the job and how long it has been silent, in hours when it is hours', () => {
  const sig = signalFor({ name: 'nightly-backup', slug: 'nightly-backup', status: 'down', last_ping: ago(300) }, NOW)
  assert.equal(sig.severity, 'critical')
  assert.equal(sig.needs_human, true)
  assert.equal(sig.key, 'nightly-backup')
  assert.match(sig.title, /nightly-backup/)
  assert.match(sig.summary, /5 hours ago/)
})

t('a job that has never checked in says so, rather than printing a nonsense age', () => {
  const sig = signalFor({ name: 'never-ran', slug: 'never-ran', status: 'down', last_ping: null }, NOW)
  assert.match(sig.summary, /never checked in/)
})

t('the check description is used when there is one — it says what stopped happening', () => {
  const sig = signalFor({ name: 'x', slug: 'x', status: 'down', last_ping: ago(10), desc: 'Books the daily invoices.' }, NOW)
  assert.match(sig.summary, /Books the daily invoices\./)
})

// ── both accounts, never silently one ──────────────────────────────────────────
t('every account in the config is read, not just the first', () => {
  const keys = readHcKeys({}, fileURLToPath(new URL('./fixtures/hc-config.fixture.json', import.meta.url)))
  assert.equal(keys.length, 2)
  assert.deepEqual(keys.map((k) => k.label).sort(), ['ci', 'primary'])
})

t('the environment wins over the file, and a comma-separated list is two accounts', () => {
  const keys = readHcKeys({ HEALTHCHECKS_API_KEYS: 'aaa, bbb' })
  assert.deepEqual(keys.map((k) => k.key), ['aaa', 'bbb'])
})

// This script only ever LISTS checks. A write key would also hand it every check's pause_url,
// which is the one thing nobody reading a board should be able to do.
t('the read-only key is taken when an account has one, and the write key only when it does not', () => {
  const keys = readHcKeys({}, fileURLToPath(new URL('./fixtures/hc-config.fixture.json', import.meta.url)))
  const byLabel = Object.fromEntries(keys.map((k) => [k.label, k.key]))
  assert.equal(byLabel.primary, 'fixture-primary-readonly')
  assert.equal(byLabel.ci, 'fixture-ci')
})

console.log(`\n${n} tests passed.`)
