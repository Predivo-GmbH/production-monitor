#!/usr/bin/env node
/**
 * The invariant: when the alarm mailer cannot deliver, the alarm must still reach a channel that
 * works, the CONTENT must survive, and the caller must still fail.
 *
 * On 2026-09-02 the monitor detected 4 failures at 23:38Z and `send-alert.mjs` died at 23:44:18Z
 * on "Invalid login: 535 5.7.8". The send was a bare unguarded `await transporter.sendMail(...)`,
 * so the process aborted inside an already-red job and nobody was told anything.
 *
 * The last case is the ratchet: it re-derives the property over EVERY mail-sending script in
 * scripts/, so this cannot come back by being reintroduced in a different mailer. The unit cases
 * above it pin the rule itself, because a ratchet that silently matches nothing is not a gate.
 *
 * Run: node test/alert-fallback.test.mjs   (exit 0 = all pass)
 */
import assert from 'node:assert'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  redactSecrets,
  classifySendFailure,
  isStaleCredentialRace,
  buildUndeliverableSignal,
  deliverToBoard,
  sendOrEscalate,
  withdrawUndeliverable,
  UNDELIVERABLE,
  sendMailCallSites,
  unguardedMailers,
} from '../scripts/lib/alert-fallback.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPTS = join(HERE, '..', 'scripts')

let passed = 0
const t = (name, fn) => {
  try {
    const r = fn()
    if (r instanceof Promise) return r.then(() => { passed++; console.log(`  ok  ${name}`) },
      (e) => { console.error(`  FAIL ${name}: ${e.message}`); process.exitCode = 1 })
    passed++
    console.log(`  ok  ${name}`)
  } catch (e) {
    console.error(`  FAIL ${name}: ${e.message}`)
    process.exitCode = 1
  }
}

const quiet = { log: () => {}, errorLog: () => {} }

// ── redaction ────────────────────────────────────────────────────────────────────────────
await t('a secret value is removed from an error string before it is logged or filed', () => {
  const out = redactSecrets('535 rejected for hunter2hunter2', ['hunter2hunter2'])
  assert.ok(!out.includes('hunter2hunter2'), 'the password survived redaction')
  assert.ok(out.includes('[redacted]'))
})

await t('a too-short "secret" is ignored, so redaction cannot black out the whole diagnosis', () => {
  // A 1-char secret would otherwise replace every occurrence of that character.
  assert.strictEqual(redactSecrets('535 auth failed', ['5']), '535 auth failed')
})

// ── classification: the owner of the problem differs by kind ─────────────────────────────
await t('a 535 is reported as a REFUSAL, and explicitly not as proof the password is wrong', () => {
  const c = classifySendFailure('Invalid login: 535 5.7.8 authentication failed')
  assert.strictEqual(c.kind, 'refused')
  assert.match(c.meaning, /not proof the stored password is wrong/i)
})

await t('a timeout is reported as UNREACHABLE and proves nothing about the credential', () => {
  const c = classifySendFailure('connect ETIMEDOUT 80.74.145.155:465')
  assert.strictEqual(c.kind, 'unreachable')
  assert.match(c.meaning, /not about the password/i)
})

await t('an unrecognised error is not silently classed as a refusal', () => {
  assert.strictEqual(classifySendFailure('something else entirely').kind, 'unknown')
})

// ── the stale-credential race: a mid-run rotation is not a locked mailbox ─────────────────
await t('a 535 whose secret was rotated AFTER the job started is a stale-credential race', () => {
  assert.strictEqual(
    isStaleCredentialRace({ kind: 'refused', jobStartedAt: '2026-09-03T10:00:48Z', secretUpdatedAt: '2026-09-03T10:08:20Z' }),
    true,
  )
})

await t('a 535 whose secret was rotated BEFORE the job started is a REAL lockout, not a race', () => {
  // The run resolved the current secret at start and it was still refused → the mailbox is the problem.
  assert.strictEqual(
    isStaleCredentialRace({ kind: 'refused', jobStartedAt: '2026-09-03T11:00:00Z', secretUpdatedAt: '2026-09-03T10:08:20Z' }),
    false,
  )
})

await t('missing or unparseable timestamps are NOT a race → the alarm still pages (fail-safe)', () => {
  assert.strictEqual(isStaleCredentialRace({ kind: 'refused' }), false)
  assert.strictEqual(isStaleCredentialRace({ kind: 'refused', jobStartedAt: 'x', secretUpdatedAt: 'y' }), false)
  assert.strictEqual(isStaleCredentialRace({ kind: 'refused', jobStartedAt: '2026-09-03T10:00:00Z', secretUpdatedAt: undefined }), false)
})

await t('only a REFUSED send can be a race; a timeout with a newer secret is not', () => {
  assert.strictEqual(
    isStaleCredentialRace({ kind: 'unreachable', jobStartedAt: '2026-09-03T10:00:00Z', secretUpdatedAt: '2026-09-03T10:08:00Z' }),
    false,
  )
})

await t('a mid-run rotation downgrades the signal off Roger\'s lane and never says "locked"', () => {
  const s = buildUndeliverableSignal({
    subject: '[ALERT] 4 failure(s)',
    failures: [{ project: 'BackOffice', test: 'OTP', error: 'refused' }],
    error: 'Invalid login: 535 5.7.8',
    jobStartedAt: '2026-09-03T10:00:48Z',
    secretUpdatedAt: '2026-09-03T10:08:20Z',
  })
  assert.strictEqual(s.severity, 'warning', 'a rotation race must not be critical')
  assert.strictEqual(s.needs_human, false, 'a rotation race must never route to Roger')
  assert.notStrictEqual(s.key, 'alert-email-undeliverable', 'must use a distinct key so it cannot mask a real lockout critical')
  assert.strictEqual(s.detail.credential_rotated_mid_run, true)
  assert.doesNotMatch(s.summary, /lock|suspend/i, 'must not claim the mailbox is locked/suspended')
  assert.match(s.summary, /replaced|rotat/i)
  assert.match(s.summary, /BackOffice/, 'the carried failure content must survive the downgrade')
})

await t('a REAL lockout (secret older than job start) still pages critical + needs_human', () => {
  const s = buildUndeliverableSignal({
    subject: '[ALERT] 4 failure(s)',
    failures: [],
    error: 'Invalid login: 535 5.7.8',
    jobStartedAt: '2026-09-03T11:00:00Z',
    secretUpdatedAt: '2026-09-03T10:08:20Z',
  })
  assert.strictEqual(s.severity, 'critical')
  assert.strictEqual(s.needs_human, true)
  assert.strictEqual(s.key, 'alert-email-undeliverable')
})

// ── the signal itself ────────────────────────────────────────────────────────────────────
await t('the signal can page: critical AND needs_human, on an armed source', () => {
  const s = buildUndeliverableSignal({ subject: '[ALERT] 4 failure(s)', failures: [] })
  assert.strictEqual(s.severity, 'critical')
  assert.strictEqual(s.needs_human, true, 'critical + needs_human=false is the contradiction check-alarm-reachability files an alarm about')
  assert.strictEqual(s.source, 'production-monitor', 'must be a source with may_page=true')
})

await t('the LOST CONTENT survives: the failures the email would have reported are in the signal', () => {
  const s = buildUndeliverableSignal({
    subject: '[ALERT] 2 failure(s)',
    failures: [
      { project: 'BackOffice', test: 'E2E OTP', error: 'mailbox refused' },
      { project: 'ReplyFlow', test: 'E2E OTP', error: 'mailbox refused' },
    ],
    error: 'Invalid login: 535 5.7.8',
  })
  assert.match(s.summary, /BackOffice/, 'the failing project is not named in the summary')
  assert.match(s.summary, /ReplyFlow/)
  assert.strictEqual(s.detail.failure_count, 2)
  // The whole point: a person reading ONLY the board learns what the email said, and learns it
  // from the headline rather than by opening a link.
  assert.match(s.title, /could not email you/i)
  assert.strictEqual(s.detail.failures.length, 2)
})

await t('the password never reaches the board, even when the server echoes it back', () => {
  const s = buildUndeliverableSignal({
    subject: 'x',
    failures: [{ project: 'p', test: 't', error: 'rejected creds sekret-value-123' }],
    error: 'Invalid login: 535 for sekret-value-123',
    secrets: ['sekret-value-123'],
  })
  const blob = JSON.stringify(s)
  assert.ok(!blob.includes('sekret-value-123'), 'the secret leaked into the signal body')
})

await t('a stable key, so an ongoing outage dedups instead of filing one signal per hour', () => {
  const a = buildUndeliverableSignal({ subject: 'a', failures: [] })
  const b = buildUndeliverableSignal({ subject: 'b', failures: [] })
  assert.strictEqual(a.key, b.key)
})

// ── sendOrEscalate: the behaviour that was missing ───────────────────────────────────────
await t('a successful send files nothing: with no open "could not email you" row, the board is only read, never written', async () => {
  let writes = 0
  const r = await sendOrEscalate(async () => 'sent', { subject: 's', failures: [] }, {
    secret: 'k',
    fetchImpl: async (_u, o) => {
      if (o?.method === 'POST') writes++
      return { ok: true, json: async () => [] }   // the read: no row under that key
    },
    ...quiet,
  })
  assert.strictEqual(r.delivered, 'smtp')
  assert.strictEqual(writes, 0, 'the board was written to on a healthy send')
  assert.deepStrictEqual(r.withdrawal, { withdrawn: false, reason: 'never filed' })
})

// ── withdrawUndeliverable: a delivered mail is the recovery ─────────────────────────────
//
// 2026-09-05: send-alert.mjs filed alert-email-undeliverable (CRITICAL, needs_human) at 08:06Z when
// the runner could not route to the mail host; the next run's resolution mail was DELIVERED at
// 08:19:56Z and the row stayed open until the board-drainer on the laptop closed it at 08:23:46Z
// after its own live SMTP probe. Nothing in this repo wrote `resolved` because nothing here ever had;
// the producer that proved delivery is the one that should take the row back.

/** A board whose read returns `row` and records every write body. */
const boardWith = (row, opts = {}) => {
  const writes = []
  const fetchImpl = async (u, o) => {
    if (o?.method === 'POST') {
      writes.push(JSON.parse(o.body))
      return opts.writeFails ? { ok: false, status: 503, text: async () => 'down' } : { ok: true, json: async () => ({}) }
    }
    assert.match(String(u), /fleet_signals\?/, 'the read went somewhere other than the signals table')
    assert.match(String(u), /key=eq\.alert-email-undeliverable/, 'the read did not ask for the undeliverable row')
    if (opts.readFails) return { ok: false, status: 500, text: async () => 'boom' }
    return { ok: true, json: async () => (row ? [row] : []) }
  }
  return { writes, fetchImpl }
}

await t('an OPEN "could not email you" row is resolved by a successful send — same source, same key, state resolved', async () => {
  const b = boardWith({ id: 1, state: 'open', key: UNDELIVERABLE.key })
  const r = await sendOrEscalate(async () => 'sent', { subject: '[RESOLVED] All tests passing again', runUrl: 'https://x/run/1' },
    { secret: 'k', fetchImpl: b.fetchImpl, ...quiet })
  assert.strictEqual(r.delivered, 'smtp')
  assert.deepStrictEqual(r.withdrawal, { withdrawn: true })
  assert.strictEqual(b.writes.length, 1, `expected exactly one write, got ${b.writes.length}`)
  const w = b.writes[0]
  assert.strictEqual(w.source, UNDELIVERABLE.source)
  assert.strictEqual(w.key, UNDELIVERABLE.key, 'a resolve under a different key would open a NEW row instead of closing the old one')
  assert.strictEqual(w.state, 'resolved')
  assert.strictEqual(w.needs_human, false, 'a resolved row must not keep paging')
  assert.strictEqual(w.severity, 'info')
  assert.match(w.summary, /\[RESOLVED\] All tests passing again/, 'the withdrawal does not name the mail that proved delivery')
  assert.strictEqual(w.link, 'https://x/run/1')
})

await t('an ACKNOWLEDGED row is resolved too (acknowledged is still active on the board)', async () => {
  const b = boardWith({ id: 1, state: 'acknowledged', key: UNDELIVERABLE.key })
  const r = await withdrawUndeliverable({ secret: 'k', fetchImpl: b.fetchImpl, ...quiet })
  assert.deepStrictEqual(r, { withdrawn: true })
  assert.strictEqual(b.writes.length, 1)
})

await t('an already-RESOLVED row is left alone: re-stamping it every hour would pollute the self-resolved tile', async () => {
  const b = boardWith({ id: 1, state: 'resolved', key: UNDELIVERABLE.key })
  const r = await withdrawUndeliverable({ secret: 'k', fetchImpl: b.fetchImpl, ...quiet })
  assert.deepStrictEqual(r, { withdrawn: false, reason: 'already resolved' })
  assert.strictEqual(b.writes.length, 0, 'a settled row was written to again')
})

await t('a failed READ does not throw and does not turn a delivered mail into an undelivered one', async () => {
  const b = boardWith(null, { readFails: true })
  let warned = ''
  const r = await sendOrEscalate(async () => 'sent', { subject: 's', failures: [] },
    { secret: 'k', fetchImpl: b.fetchImpl, log: () => {}, errorLog: (m) => { warned += m } })
  assert.strictEqual(r.delivered, 'smtp', 'the send was reported as anything but delivered')
  assert.strictEqual(r.withdrawal.withdrawn, false)
  assert.strictEqual(r.withdrawal.reason, 'error')
  assert.match(warned, /HTTP 500/, 'the read failure was swallowed without a word')
  assert.strictEqual(b.writes.length, 0)
})

await t('a failed WRITE of the resolve does not throw either — the mail went out, the step stays green', async () => {
  const b = boardWith({ id: 1, state: 'open', key: UNDELIVERABLE.key }, { writeFails: true })
  const r = await withdrawUndeliverable({ secret: 'k', fetchImpl: b.fetchImpl, ...quiet })
  assert.strictEqual(r.withdrawn, false)
  assert.strictEqual(r.reason, 'error')
  assert.match(r.error, /HTTP 503/)
})

await t('with no board secret the send still succeeds and the board is not contacted at all', async () => {
  let calls = 0
  const r = await sendOrEscalate(async () => 'sent', { subject: 's', failures: [] },
    { secret: undefined, fetchImpl: async () => { calls++; return { ok: true, json: async () => [] } }, ...quiet })
  assert.strictEqual(r.delivered, 'smtp')
  assert.deepStrictEqual(r.withdrawal, { withdrawn: false, reason: 'no-secret' })
  assert.strictEqual(calls, 0)
})

await t('the withdrawal is skipped entirely when the send FAILED — a failed mail proves nothing about recovery', async () => {
  let reads = 0
  await assert.rejects(
    sendOrEscalate(async () => { throw new Error('Connection timeout') }, { subject: 's', failures: [] }, {
      secret: 'k',
      fetchImpl: async (u, o) => { if (o?.method !== 'POST') reads++; return { ok: true, json: async () => ({}) } },
      ...quiet,
    }),
    /alert email undeliverable/,
  )
  assert.strictEqual(reads, 0, 'the undeliverable row was read (and would have been resolved) on a FAILED send')
})

await t('a failed send files the alarm on the board AND still throws, so the step stays red', async () => {
  let body = null
  await assert.rejects(
    sendOrEscalate(
      async () => { throw new Error('Invalid login: 535 5.7.8') },
      { subject: '[ALERT] 4 failure(s)', failures: [{ project: 'BackOffice', test: 'OTP', error: 'refused' }] },
      { secret: 'k', fetchImpl: async (_u, o) => { body = JSON.parse(o.body); return { ok: true, json: async () => ({}) } }, ...quiet },
    ),
    /alert email undeliverable/,
  )
  assert.ok(body, 'nothing was filed to the board')
  assert.strictEqual(body.key, 'alert-email-undeliverable')
  assert.match(body.summary, /BackOffice/)
})

await t('a failure BUILDING the transport escalates too, not just a failure sending', async () => {
  // createMailTransport pins the MX A record, so DNS/connect failures throw before sendMail.
  let filed = false
  await assert.rejects(
    sendOrEscalate(async () => { throw new Error('getaddrinfo ENOTFOUND tertia.sui-inter.net') },
      { subject: 's', failures: [] },
      { secret: 'k', fetchImpl: async () => { filed = true; return { ok: true, json: async () => ({}) } }, ...quiet }),
    /alert email undeliverable/,
  )
  assert.ok(filed, 'a transport-construction failure was not escalated')
})

await t('when BOTH channels fail, both errors are reported and it still throws', async () => {
  const e = await sendOrEscalate(
    async () => { throw new Error('Invalid login: 535 5.7.8') },
    { subject: 's', failures: [] },
    { secret: 'k', fetchImpl: async () => ({ ok: false, status: 503, text: async () => 'down' }), ...quiet },
  ).then(() => null, (err) => err)
  assert.ok(e, 'a double failure resolved instead of throwing')
  assert.match(e.message, /535/, 'the original send error was swallowed')
  assert.match(e.message, /board fallback also failed/, 'the board failure was not reported')
  assert.strictEqual(e.escalated, false)
})

await t('a missing board credential is a reported failure, not a silent skip', async () => {
  const e = await sendOrEscalate(async () => { throw new Error('535') }, { subject: 's', failures: [] },
    { secret: undefined, ...quiet }).then(() => null, (err) => err)
  assert.match(e.boardError ?? '', /no board secret/)
})

await t('deliverToBoard rejects a non-2xx rather than returning quietly', async () => {
  await assert.rejects(
    deliverToBoard({ x: 1 }, { secret: 'k', fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'nope' }) }),
    /HTTP 401/,
  )
})

// ── the detector, proven both ways BEFORE it is trusted on the real tree ─────────────────
//
// The first version of this ratchet asked /try\s*{[\s\S]*?\.sendMail/ and reported ZERO
// violations on a tree that had eight, because `[\s\S]*?` reaches across the whole file: one
// unrelated `try {` near the top made every mailer look guarded. These cases exist so the
// detector is never again trusted on the strength of it agreeing with me.

await t('DETECTOR: a bare await sendMail is seen as unguarded', () => {
  assert.deepStrictEqual(unguardedMailers([{ name: 'x.mjs', src: 'await t.sendMail({ to })' }]), ['x.mjs'])
})

await t('DETECTOR: an UNRELATED earlier try{} does not make a bare send look guarded (the v1 bug)', () => {
  const src = `
    try { results = JSON.parse(readFileSync(p)) } catch { }
    const t = await createMailTransport(cfg)
    await t.sendMail({ to })
  `
  assert.deepStrictEqual(
    unguardedMailers([{ name: 'x.mjs', src }]), ['x.mjs'],
    'a try block that does not enclose the send was accepted as protection — this is exactly how v1 passed a broken tree',
  )
})

await t('DETECTOR: a send genuinely inside try{} is accepted', () => {
  const src = 'try {\n  await t.sendMail({ to })\n} catch (e) { console.error(e) }'
  assert.deepStrictEqual(unguardedMailers([{ name: 'x.mjs', src }]), [])
})

await t('DETECTOR: sendOrEscalate is accepted', () => {
  assert.deepStrictEqual(unguardedMailers([{ name: 'x.mjs', src: 'await sendOrEscalate(() => t.sendMail({}), c, d)' }]), [])
})

await t('DETECTOR: a file with two sends, only one guarded, is still unguarded', () => {
  const src = 'try { await t.sendMail({a:1}) } catch {}\nawait t.sendMail({b:2})'
  assert.deepStrictEqual(unguardedMailers([{ name: 'x.mjs', src }]), ['x.mjs'])
})

await t('DETECTOR: a file that sends no mail is not reported at all', () => {
  assert.deepStrictEqual(unguardedMailers([{ name: 'x.mjs', src: 'console.log("hi")' }]), [])
})

// ── the ratchet over the real tree ───────────────────────────────────────────────────────
//
// KNOWN DEBT, frozen 2026-09-03. Every one of these is an alarm mailer that dies silently when
// the mail account refuses it — the same defect that lost the 23:44Z alert. send-alert.mjs (the
// hourly monitor's own alarm, and the one that actually failed) is fixed; these eight are not,
// because each also needs a board credential wired into its own workflow, and doing eight of
// those blind in one unattended run is how you break the alerting you are trying to repair.
//
// The assertion is EQUALITY, not "no new ones": a name that gets fixed must leave this list, so
// the list cannot quietly rot into an allowlist that excuses everything.
const KNOWN_UNGUARDED = [
  'send-automation-alert.mjs',
  'send-automation-resolved.mjs',
  'send-ci-runner-alert.mjs',
  'send-dashboard-alert.mjs',
  'send-drift-alert.mjs',
  'send-heartbeat-alert.mjs',
  'send-mailer-alert.mjs',
  // send-resolved.mjs left this list 2026-09-05: wrapped in sendOrEscalate, BOARD_SUPABASE_SECRET wired.
]

const realFiles = readdirSync(SCRIPTS)
  .filter((n) => n.endsWith('.mjs'))
  .map((n) => ({ name: n, src: readFileSync(join(SCRIPTS, n), 'utf-8') }))

await t('RATCHET: the set of silently-dying mailers has not grown, and shrinks when one is fixed', () => {
  const actual = unguardedMailers(realFiles).sort()
  const added = actual.filter((f) => !KNOWN_UNGUARDED.includes(f))
  const fixed = KNOWN_UNGUARDED.filter((f) => !actual.includes(f))
  assert.deepStrictEqual(
    added, [],
    `NEW mailer(s) that die silently when the mail account is refused:\n  ${added.join('\n  ')}\n` +
      'Wrap the send in sendOrEscalate() from scripts/lib/alert-fallback.mjs and give the step BOARD_SUPABASE_SECRET.',
  )
  assert.deepStrictEqual(
    fixed, [],
    `these are now guarded — remove them from KNOWN_UNGUARDED so the list keeps meaning something:\n  ${fixed.join('\n  ')}`,
  )
})

await t('RATCHET is not vacuous: it found the real mailers, and send-alert.mjs is genuinely guarded', () => {
  const mailers = realFiles.filter((f) => sendMailCallSites(f.src).length > 0)
  assert.ok(mailers.length >= 10, `expected the fleet's mailers, found ${mailers.length} — the ratchet is matching nothing`)
  assert.ok(
    !unguardedMailers(realFiles).includes('send-alert.mjs'),
    'send-alert.mjs — the mailer that actually failed on 2026-09-02 — is still unguarded',
  )
})

console.log(`\n${passed} passed`)
