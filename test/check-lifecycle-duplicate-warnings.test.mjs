/**
 * Unit tests for the "a customer was emailed the same thing twice" reader.
 *
 * Each names the defect a naive version would ship: parse only the happy string and silently drop
 * a warning whose format drifted; dedupe on the run that noticed instead of on the duplicate
 * itself, so one duplicated email pages every five minutes for a day; file `warning` instead of
 * `critical`, so upsert_signal never schedules a page.
 *
 * Run: node test/check-lifecycle-duplicate-warnings.test.mjs   (exit 0 = all pass)
 */
import assert from 'node:assert'
import {
  parseWarning, dedupKey, collectWarnings, signalFor, hashText, warningsSql, LOOKBACK_HOURS,
} from '../scripts/check-lifecycle-duplicate-warnings.mjs'

let n = 0
const t = (name, fn) => { fn(); n++; console.log(`  ok - ${name}`) }

// The exact string lifecycle-tick emits (index.ts:203).
const REAL = 'duplicate account-level step "did_everything_arrive" sent to noelle@banek.net ' +
  '(user 11111111-2222-3333-4444-555555555555) a second time on 2026-08-25; the once-per-person ' +
  'guard did not stop it and the per-migration ledger index cannot. This is the signature of a ' +
  'stale deploy of lifecycle-tick.'

const bodyWith = (...warnings) =>
  JSON.stringify({ ranAt: '2026-08-25T10:15:02.000Z', enabled: true, sent: {}, skipped: {}, warnings })

// ── parsing the identity of the duplicate ─────────────────────────────────────────────────────

t('parses step, email, user and day out of the real warning', () => {
  const p = parseWarning(REAL)
  assert.deepEqual(p, {
    step: 'did_everything_arrive',
    email: 'noelle@banek.net',
    userId: '11111111-2222-3333-4444-555555555555',
    day: '2026-08-25',
  })
})

t('a warning whose format drifted parses to null, it is NOT thrown away', () => {
  assert.equal(parseWarning('duplicate email, some new wording nobody predicted'), null)
})

// ── dedupe is on the duplicate, not on the run that saw it ─────────────────────────────────────

t('the key is the person+step+day, so the run that reported it does not matter', () => {
  const p = parseWarning(REAL)
  assert.equal(dedupKey('ChannelMover', p, REAL),
    'lifecycle-dup:ChannelMover:11111111-2222-3333-4444-555555555555:did_everything_arrive:2026-08-25')
})

t('an unparseable warning still gets a stable, repeatable key', () => {
  const a = dedupKey('ChannelMover', null, 'weird warning text')
  const b = dedupKey('ChannelMover', null, 'weird warning text')
  assert.equal(a, b)
  assert.match(a, /^lifecycle-dup:ChannelMover:raw:/)
  assert.equal(hashText('x'), hashText('x'))
  assert.notEqual(hashText('x'), hashText('y'))
})

// ── collecting across many persisted responses ────────────────────────────────────────────────

t('the same duplicate seen on 3 consecutive ticks collapses to ONE entry', () => {
  const rows = [
    { id: 3, created: '2026-08-25T10:25:00Z', content: bodyWith(REAL) },
    { id: 2, created: '2026-08-25T10:20:00Z', content: bodyWith(REAL) },
    { id: 1, created: '2026-08-25T10:15:00Z', content: bodyWith(REAL) },
  ]
  const out = collectWarnings(rows, 'ChannelMover')
  assert.equal(out.length, 1)
  // and it keeps the EARLIEST sighting — when the customer was actually emailed twice
  assert.equal(out[0].seenAt, '2026-08-25T10:15:00Z')
})

t('two different people duplicated on the same day are two entries', () => {
  const other = REAL.replace('noelle@banek.net', 'someone@else.com').replace(/user [^)]+/, 'user 99999999-0000-0000-0000-000000000000')
  const rows = [{ id: 1, created: '2026-08-25T10:15:00Z', content: bodyWith(REAL, other) }]
  assert.equal(collectWarnings(rows, 'ChannelMover').length, 2)
})

t('a clean run and an unparseable response body do not crash or produce entries', () => {
  const rows = [
    { id: 1, created: '2026-08-25T10:15:00Z', content: bodyWith() },      // warnings: []
    { id: 2, created: '2026-08-25T10:16:00Z', content: 'not json at all' },
  ]
  assert.deepEqual(collectWarnings(rows, 'ChannelMover'), [])
})

// ── the signal is armed to page ───────────────────────────────────────────────────────────────

t('the filed signal is critical + needs_human — what upsert_signal needs to schedule a page', () => {
  const [entry] = collectWarnings([{ id: 1, created: '2026-08-25T10:15:00Z', content: bodyWith(REAL) }], 'ChannelMover')
  const sig = signalFor(entry)
  assert.equal(sig.severity, 'critical')
  assert.equal(sig.needs_human, true)
  assert.equal(sig.source, 'production-monitor')
  assert.equal(sig.state, 'open')
  assert.match(sig.summary, /noelle@banek\.net/)
  assert.match(sig.summary, /did_everything_arrive/)
  assert.equal(sig.detail.day, '2026-08-25')
})

t('an unparseable warning still yields a critical, page-armed signal carrying the raw text', () => {
  const rows = [{ id: 1, created: '2026-08-25T10:15:00Z', content: bodyWith('a brand new kind of warning') }]
  const sig = signalFor(collectWarnings(rows, 'ChannelMover')[0])
  assert.equal(sig.severity, 'critical')
  assert.equal(sig.needs_human, true)
  assert.match(sig.summary, /a brand new kind of warning/)
})

// ── the query reads only non-empty warnings, within the retention window ──────────────────────

t('the SQL selects non-empty warnings only, scoped to lifecycle-tick and the lookback window', () => {
  const sql = warningsSql()
  assert.match(sql, /"warnings":\["/)     // non-empty array only
  assert.match(sql, /"ranAt"/)            // lifecycle-tick's unmistakable shape
  assert.match(sql, new RegExp(`interval '${LOOKBACK_HOURS} hours'`))
})

console.log(`\n${n} passed`)
