/**
 * Unit tests for the "a scheduled job went dark" producer.
 *
 * Run: node test/check-healthchecks-down.test.mjs   (exit 0 = all pass)
 */
import assert from 'node:assert'
import { fileURLToPath } from 'node:url'
import {
  classifyChecks, signalFor, readHcKeys, planSignals, recoveredCheckKeys, ROLLUP_KEY, ROLLUP_THRESHOLD,
  checksFrom,
} from '../scripts/check-healthchecks-down.mjs'

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

// ── one blocked fleet is one alert ─────────────────────────────────────────────
// THE DEFECT THESE PIN. `healthchecks` was armed to page on 2026-08-29. On both days the fleet
// actually failed, ELEVEN jobs were dark at once because one gate refused to let anything start.
// Filing eleven pageable signals for that is an alarm that gets muted, and a muted alarm is
// strictly worse than the silence it replaced.

const dead = (name) => ({ name, slug: name, status: 'down', last_ping: ago(600) })

t('two dead jobs are two faults — each still pages on its own', () => {
  const { rollup, members } = planSignals([dead('a'), dead('b')], NOW)
  assert.equal(rollup, null)
  assert.equal(members.length, 2)
  assert.ok(members.every((m) => m.severity === 'critical' && m.needs_human === true))
})

t(`${ROLLUP_THRESHOLD} or more is ONE alert, and only that one may ring`, () => {
  const { rollup, members } = planSignals([dead('a'), dead('b'), dead('c')], NOW)
  assert.equal(rollup.key, ROLLUP_KEY)
  assert.equal(rollup.severity, 'critical')
  assert.equal(rollup.needs_human, true)
  assert.equal(members.length, 3)
  // warning + needs_human:false is the pair upsert_signal records as 'not-eligible'.
  assert.ok(members.every((m) => m.severity === 'warning' && m.needs_human === false))
})

t('eleven dark jobs produce exactly one pageable signal, not eleven', () => {
  const names = ['inbox-triage', 'gsc-daily-check', 'brain-processor', 'needs-roger-closer',
    'kb-learning-phase0', 'gemini-balance-scrape', 'inbox-daily-summary', 'ci-cost-guard',
    'knowledge-apply-loop', 'production-autofix-hourly', 'commit-review']
  const { rollup, members } = planSignals(names.map(dead), NOW)
  const pageable = [rollup, ...members].filter((s) => s && s.severity === 'critical' && s.needs_human)
  assert.equal(pageable.length, 1)
  assert.equal(members.length, 11)
})

t('every dark job is still named in the one alert — a rollup must not hide the list', () => {
  const { rollup } = planSignals([dead('a'), dead('b'), dead('c')], NOW)
  for (const name of ['a', 'b', 'c']) assert.match(rollup.summary, new RegExp(name))
  assert.deepEqual(rollup.detail.jobs, ['a', 'b', 'c'])
})

t('when a GATE is among the dead, the alert names the cause instead of counting symptoms', () => {
  const { rollup } = planSignals([dead('code-sync-laptop'), dead('inbox-triage'), dead('brain-processor')], NOW)
  assert.equal(rollup.detail.gate, 'code-sync-laptop')
  assert.match(rollup.title, /Nothing is running/)
  assert.match(rollup.summary, /does not match what was shipped/)
  // The consequence must be readable without knowing what a slug is.
  assert.doesNotMatch(rollup.title, /healthchecks|slug|hc-ping/)
})

t('no gate among the dead: it says "probably one cause" rather than inventing one', () => {
  const { rollup } = planSignals([dead('a'), dead('b'), dead('c')], NOW)
  assert.equal(rollup.detail.gate, null)
  assert.match(rollup.summary, /most likely one cause/)
})

t('the rollup key is fixed, so a fleet that stays blocked dedups instead of re-filing', () => {
  const a = planSignals([dead('a'), dead('b'), dead('c')], NOW).rollup
  const b = planSignals([dead('a'), dead('b'), dead('c'), dead('d')], NOW).rollup
  assert.equal(a.key, b.key)
})

t('nothing dark: nothing filed, and no rollup to clear against', () => {
  const { rollup, members } = planSignals([], NOW)
  assert.equal(rollup, null)
  assert.equal(members.length, 0)
})

// ── recovery resolves ONLY real check slugs ────────────────────────────────────
// THE DEFECT THIS PINS. The recovery loop used to resolve every open row under source=healthchecks
// that was not currently down. A row that is not a check slug can never be in `downKeys`, so it was
// force-resolved by construction — erasing diagnosis/analysis rows the closer routes under this
// source within the hour. Recovery must intersect the FULL check set, never the whole source.
const set = (...xs) => new Set(xs)

t('a recovered check (a real slug, no longer down) is resolved', () => {
  const keys = recoveredCheckKeys({
    openKeys: set('nightly-backup'), allCheckKeys: set('nightly-backup'), downKeys: set(),
  })
  assert.deepEqual(keys, ['nightly-backup'])
})

t('a check still down is NOT resolved', () => {
  const keys = recoveredCheckKeys({
    openKeys: set('nightly-backup'), allCheckKeys: set('nightly-backup'), downKeys: set('nightly-backup'),
  })
  assert.deepEqual(keys, [])
})

t('a NON-CHECK row (a diagnosis routed under this source) is NEVER resolved — the core fix', () => {
  const keys = recoveredCheckKeys({
    openKeys: set('monitor-job-dark-work-items-not-released-on-recovery'),
    allCheckKeys: set('nightly-backup', 'inbox-triage'),   // real check slugs only
    downKeys: set(),
  })
  assert.deepEqual(keys, [])
})

t('a mixed board: only the recovered real checks come back, the analysis row is left alone', () => {
  const keys = recoveredCheckKeys({
    openKeys: set('inbox-triage', 'gsc-daily-check', 'closer-digest-board-link-points-at-superseded-rows'),
    allCheckKeys: set('inbox-triage', 'gsc-daily-check', 'brain-processor'),
    downKeys: set('gsc-daily-check'),   // still down
  })
  assert.deepEqual(keys.sort(), ['inbox-triage'])
})

t('the rollup key is never resolved here even if it is somehow a known slug — it is settled on its threshold', () => {
  const keys = recoveredCheckKeys({
    openKeys: set(ROLLUP_KEY), allCheckKeys: set(ROLLUP_KEY), downKeys: set(),
  })
  assert.deepEqual(keys, [])
})


// ── A 200 WITH NO CHECK LIST IS A FAILED READ (2026-09-01 audit) ─────────────────────────────
// The old line was `return (body.checks || []).map(...)`. Zero checks means nothing is down,
// which clears the rollup, and main() then files "Everything that was dark is checking in again".
// A malformed response wrote a positive all-clear over a live outage. Each assertion below fails
// against that version.

t('a 200 whose body has no check list THROWS instead of reporting an empty fleet', () => {
  assert.throws(() => checksFrom({}, 'primary'), /no check list/)
  assert.throws(() => checksFrom({ checks: null }, 'primary'), /no check list/)
  assert.throws(() => checksFrom({ result: [] }, 'primary'), /nothing could be judged/)
  assert.throws(() => checksFrom(null, 'primary'), /no check list/)
})

t('a genuinely empty check list is still a read, not a throw', () => {
  assert.deepEqual(checksFrom({ checks: [] }, 'primary'), [])
})

t('a real list is tagged with its account, unchanged', () => {
  const out = checksFrom({ checks: [{ name: 'x', status: 'down' }] }, 'ci')
  assert.equal(out.length, 1)
  assert.equal(out[0].account, 'ci')
  assert.equal(out[0].status, 'down')
})

console.log(`\n${n} tests passed.`)
