/**
 * Unit tests for the "a customer was emailed the same thing twice" listener.
 *
 * The event this guards is ChannelMover's lifecycle-tick console.warn line (see the script header
 * and ChannelMover/docs/INCIDENTS.md). Each test drives a real branch of the parser, the finding
 * de-duplication, the signal shaping, and the read path — including the read path FAILING, because
 * a sensor that cannot read must never come back "no duplicates".
 *
 * Run: node test/check-lifecycle-duplicate-warnings.test.mjs   (exit 0 = all pass)
 */
import assert from 'node:assert'
import {
  logsSql, parseWarning, findDuplicateWarnings, duplicateSignal, readWarningLogs,
} from '../scripts/check-lifecycle-duplicate-warnings.mjs'

let n = 0
const t = (name, fn) => { fn(); n++; console.log(`  ok - ${name}`) }
const at = async (name, fn) => { await fn(); n++; console.log(`  ok - ${name}`) }

// The verbatim shape lifecycle-tick emits (index.ts: warnIfDuplicateAccountStep).
const REAL_LINE =
  '[lifecycle-tick] WARNING: duplicate account-level step "did_everything_arrive" sent to ' +
  'noelle@banek.net (user 7c1e-abc) a second time on 2026-08-25; the once-per-person guard did ' +
  'not stop it and the per-migration ledger index cannot. This is the signature of a stale deploy ' +
  'of lifecycle-tick.'

// ── the parser only speaks when it can read every fact ───────────────────────────────────────

t('parses step, email, user and day from the real warning line', () => {
  const f = parseWarning(REAL_LINE)
  assert.equal(f.step, 'did_everything_arrive')
  assert.equal(f.email, 'noelle@banek.net')
  assert.equal(f.userId, '7c1e-abc')
  assert.equal(f.day, '2026-08-25')
})

t('a line without the marker is not a finding', () => {
  assert.equal(parseWarning('[lifecycle-tick] sent did_everything_arrive to noelle@banek.net'), null)
  assert.equal(parseWarning(''), null)
  assert.equal(parseWarning(null), null)
})

t('the marker present but the fields unreadable is NOT a clean finding (returns null)', () => {
  // Contains the marker but no email/day — a truncated or reworded line must not invent a finding.
  assert.equal(parseWarning('[lifecycle-tick] WARNING: duplicate account-level step "x" happened'), null)
})

t('a user id is optional; step + email + day are not', () => {
  const line = 'WARNING: duplicate account-level step "ready_to_start" sent to a@b.co (user ) a second time on 2026-09-01;'
  const f = parseWarning(line)
  assert.equal(f.step, 'ready_to_start')
  assert.equal(f.email, 'a@b.co')
  assert.equal(f.day, '2026-09-01')
  assert.equal(f.userId, null)
})

// ── findings de-duplicate to one-per-customer-per-day-per-step ────────────────────────────────

t('two log rows for the same duplicate collapse to one finding', () => {
  const rows = [{ event_message: REAL_LINE }, { event_message: REAL_LINE }]
  assert.equal(findDuplicateWarnings(rows).length, 1)
})

t('different day / step / email are distinct findings; noise is dropped', () => {
  const other = REAL_LINE.replace('2026-08-25', '2026-08-26').replace('did_everything_arrive', 'paid_nothing_started')
  const rows = [
    { event_message: REAL_LINE },
    { event_message: other },
    { event_message: 'some unrelated info log' },
    { event_message: '[lifecycle-tick] ran; sent 3 skipped 0' },
  ]
  assert.equal(findDuplicateWarnings(rows).length, 2)
})

t('empty / missing input yields no findings, never a throw', () => {
  assert.deepEqual(findDuplicateWarnings([]), [])
  assert.deepEqual(findDuplicateWarnings(null), [])
})

// ── the signal rings like a product being down, and never self-resolves ──────────────────────

t('a duplicate files critical + needs_human (it rings), open, never resolved', () => {
  const s = duplicateSignal(parseWarning(REAL_LINE))
  assert.equal(s.severity, 'critical')
  assert.equal(s.needs_human, true)
  assert.equal(s.state, 'open')
  assert.equal(s.product, 'ChannelMover')
  assert.equal(s.source, 'production-monitor')
})

t('the key is stable and carries the UTC day, so a new day is a new incident', () => {
  const a = duplicateSignal(parseWarning(REAL_LINE)).key
  const b = duplicateSignal(parseWarning(REAL_LINE)).key
  assert.equal(a, b)                       // same duplicate -> same row
  assert.match(a, /2026-08-25/)            // day in the key
  assert.match(a, /did_everything_arrive/) // step in the key
  assert.match(a, /noelle@banek\.net/)     // customer in the key
  const other = duplicateSignal(parseWarning(REAL_LINE.replace('2026-08-25', '2026-08-26'))).key
  assert.notEqual(a, other)
})

t('the human-facing text names the customer, the step and the incident cause', () => {
  const s = duplicateSignal(parseWarning(REAL_LINE))
  assert.match(s.title, /noelle@banek\.net/)
  assert.match(s.title, /twice/)
  assert.match(s.summary, /stale deploy/)
  assert.match(s.summary, /does not\s+self-resolve/)
  assert.equal(s.detail.step, 'did_everything_arrive')
  assert.equal(s.detail.email, 'noelle@banek.net')
})

// ── the SQL is dialect-safe and targets the console-output source ─────────────────────────────

t('logsSql selects only top-level columns from function_logs and matches the marker', () => {
  const sql = logsSql()
  assert.match(sql, /from function_logs/)
  assert.match(sql, /WARNING: duplicate account-level step/)
  assert.match(sql, /event_message, timestamp/) // no nested metadata -> works in both dialects
})

t('logsSql escapes single quotes so a marker cannot break out of the LIKE', () => {
  assert.match(logsSql("it's here"), /like '%it''s here%'/)
})

// ── the READ can fail, and a failed read is never a clean read ────────────────────────────────

await at('a 200 with a result array is a genuine read', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ result: [{ event_message: REAL_LINE }] }) })
  const r = await readWarningLogs('ref', 'tok', { fetchImpl })
  assert.equal(r.ok, true)
  assert.equal(r.rows.length, 1)
})

await at('a bare 200 array is also accepted', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => [{ event_message: REAL_LINE }] })
  const r = await readWarningLogs('ref', 'tok', { fetchImpl })
  assert.equal(r.ok, true)
})

await at('a 401 on BOTH endpoints is a failed read (ok:false) — this becomes UNKNOWN, not "clean"', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({ message: 'Unauthorized' }) })
  const r = await readWarningLogs('ref', 'tok', { fetchImpl })
  assert.equal(r.ok, false)
  assert.match(r.why, /401/)
})

await at('a network throw on both endpoints is a failed read', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED') }
  const r = await readWarningLogs('ref', 'tok', { fetchImpl })
  assert.equal(r.ok, false)
  assert.match(r.why, /ECONNREFUSED/)
})

await at('a 200 whose body has no result array is a failed read, not zero duplicates', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ error: 'bad sql' }) })
  const r = await readWarningLogs('ref', 'tok', { fetchImpl })
  assert.equal(r.ok, false)
  assert.match(r.why, /no result array/)
})

await at('a 404 on logs.all falls back to the plain logs endpoint', async () => {
  let calls = 0
  const fetchImpl = async (url) => {
    calls++
    if (url.includes('logs.all')) return { ok: false, status: 404, json: async () => ({}) }
    return { ok: true, status: 200, json: async () => ({ result: [] }) }
  }
  const r = await readWarningLogs('ref', 'tok', { fetchImpl })
  assert.equal(r.ok, true)
  assert.equal(calls, 2)
  assert.match(r.endpoint, /endpoints\/logs$/)
})

console.log(`\n${n} assertions passed.`)
