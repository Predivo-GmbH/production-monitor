#!/usr/bin/env node
/**
 * The invariant: a check that could not LOOK must never report a verdict about the
 * thing it did not look at.
 *
 * On 2026-09-02 the shared OTP test inbox began answering
 * `[AUTHENTICATIONFAILED] Authentication failed.` to every login. Measured from the
 * run logs: IMAP login succeeded at 19:57:42 (run 33674690649/33675914221, "cleared 0
 * messages from the shared OTP test inbox") and failed at 20:18:09 (run 33678404644)
 * and on every run after. `IMAP_PASS` was last set 2026-07-09, so nothing on our side
 * moved - the mail provider stopped accepting the password.
 *
 * What the monitor then told Roger, four times over:
 *     "OTP email NOT delivered within 90s - send-auth-email chain is broken.
 *      Check: pg_net Authorization header, edge function signature guard, SMTP credentials."
 * for ReplyFlow, SignalScore, Valrano and ChannelMover.
 *
 * Every clause of that was false. `waitForOtpEmail` threw at `client.connect()`, which
 * sits before the poll loop, so the tests died in 2.4s, 2.9s, 2.3s and 2.4s - the run had
 * not waited 90 seconds, had not opened an inbox, and had not sent Roger's attention
 * anywhere near the actual fault. The bare `catch {}` in all five specs discarded the
 * real error object and substituted an accusation.
 *
 * The arithmetic is the tell, and it was printed in the log every time: a 90-second
 * timeout cannot expire in 2.4 seconds. Nobody read it, because the sentence was
 * confident and named a plausible culprit.
 *
 * BackOffice failed the opposite way and was just as wrong: its two OTP specs caught
 * everything with `test.skip(true, 'OTP email not delivered within 90s - Supabase SMTP
 * delay (not a code bug)')`, so a total lockout scored as "skipped" and its OTP coverage
 * disappeared without a word.
 *
 * Cases 1-6 pin the behaviour in BOTH directions - a mailbox failure must NOT read as a
 * product failure, and a genuine non-delivery must STILL read as one. Case 7 is the
 * ratchet over every spec file including ones not written yet, because the wrong sentence
 * survived by being copy-pasted into five files at once: fixing four of five is the same
 * bug tomorrow.
 *
 * Run: node test/imap-fault-attribution.test.mjs   (exit 0 = all pass)
 */
import assert from 'node:assert'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MailboxUnreachableError, describeOtpFailure, imapCauseText } from '../scripts/lib/otp-failure.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
let passed = 0
const failures = []
function check(name, fn) {
  try {
    fn()
    passed++
  } catch (err) {
    failures.push(`${name}\n    ${err.message}`)
  }
}

// ── 1. A mailbox we could not open must not be reported as a product fault ──────
check('mailbox lockout does not accuse the product', () => {
  const err = new MailboxUnreachableError(
    'IMAP connect/login to mail.example failed',
    new Error('[AUTHENTICATIONFAILED] Authentication failed.'),
  )
  const msg = describeOtpFailure(err, 'ReplyFlow')

  // The exact sentence that misdirected four investigations must not appear.
  assert.ok(
    !/send-auth-email chain is broken/.test(msg),
    'a mailbox lockout still accuses the send-auth-email chain',
  )
  assert.ok(
    !/pg_net Authorization header/.test(msg),
    'a mailbox lockout still points at pg_net',
  )
  assert.ok(/MONITOR FAULT/.test(msg), 'the message does not name this as a monitor fault')
  assert.ok(/could not read its own/.test(msg), 'the message does not say we never looked')
})

// ── 2. …and it must carry the underlying cause, which is the actionable part ────
check('the real IMAP error survives into the message', () => {
  const err = new MailboxUnreachableError(
    'IMAP connect/login failed',
    new Error('[AUTHENTICATIONFAILED] Authentication failed.'),
  )
  const msg = describeOtpFailure(err, 'Valrano')
  assert.ok(
    /AUTHENTICATIONFAILED/.test(msg),
    'the underlying IMAP error was swallowed - this is exactly what the old bare catch{} did',
  )
  assert.ok(/IMAP_PASS/.test(msg), 'the message does not name the secret to fix')
})

// ── 3. The OPPOSITE direction: a real non-delivery must still ring loudly ───────
// A guard that only ever suppresses is not a guard; it is a mute button.
check('a genuine non-delivery still accuses the send chain', () => {
  const msg = describeOtpFailure(new Error('No OTP email received within 90000ms'), 'SignalScore')
  assert.ok(
    /send-auth-email chain is broken/.test(msg),
    'a real non-delivery no longer reports the send chain - the check has been muted',
  )
  assert.ok(/pg_net Authorization header/.test(msg), 'the actionable checklist was dropped')
  assert.ok(!/MONITOR FAULT/.test(msg), 'a real product failure is being blamed on the monitor')
})

// ── 4. The non-delivery message may only claim what was actually established ────
check('the non-delivery message states the mailbox was readable', () => {
  const msg = describeOtpFailure(new Error('No OTP email received within 90000ms'), 'ChannelMover')
  assert.ok(
    /mailbox was readable/.test(msg),
    'the message does not say the inbox was proven readable, so the claim is unsupported again',
  )
})

// ── 5. Every project name is carried through, never hardcoded ──────────────────
check('the failing project is named in both branches', () => {
  for (const project of ['ReplyFlow', 'SignalScore', 'Valrano', 'ChannelMover', 'BackOffice']) {
    const unreachable = describeOtpFailure(new MailboxUnreachableError('x', new Error('y')), project)
    const undelivered = describeOtpFailure(new Error('No OTP email received'), project)
    assert.ok(unreachable.includes(project), `mailbox message does not name ${project}`)
    assert.ok(undelivered.includes(project), `non-delivery message does not name ${project}`)
  }
})

// ── 6. A non-Error thrown value must not crash the reporter ────────────────────
check('a thrown non-Error is still described', () => {
  const err = new MailboxUnreachableError('x', 'socket hang up')
  assert.ok(describeOtpFailure(err, 'ReplyFlow').includes('socket hang up'))
  assert.ok(describeOtpFailure(undefined, 'ReplyFlow').includes('send-auth-email'))
  assert.ok(new MailboxUnreachableError('x').reason === 'unknown')
})

// ── 7. RATCHET: no spec may relabel a mailbox failure as a product failure ─────
function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.(ts|mjs|js)$/.test(entry)) out.push(full)
  }
  return out
}

check('every waitForOtpEmail catch routes through describeOtpFailure', () => {
  const files = walk(join(ROOT, 'tests'))
  const callers = files.filter((f) => readFileSync(f, 'utf8').includes('waitForOtpEmail('))

  // A ratchet that matches nothing passes vacuously and proves nothing. There were
  // five caller files on 2026-09-02; if that count collapses, this test is asleep.
  assert.ok(
    callers.length >= 5,
    `expected >=5 specs calling waitForOtpEmail, found ${callers.length} - the ratchet is scanning nothing`,
  )

  const violations = []
  for (const file of callers) {
    const src = readFileSync(file, 'utf8')
    const rel = relative(ROOT, file)

    // (a) The hardcoded accusation must not survive anywhere in a spec.
    if (/'OTP email NOT delivered within 90s\s*[-–—]\s*send-auth-email chain is broken/.test(src)) {
      violations.push(`${rel}: still hardcodes the send-chain accusation instead of calling describeOtpFailure`)
    }

    // (b) A bare `catch {` directly around a waitForOtpEmail await discards the error
    //     object, which is the only thing that can tell the two failures apart.
    const bare = /await waitForOtpEmail\([^;]*?\)\r?\n\s*\} catch \{/g
    if (bare.test(src)) {
      violations.push(`${rel}: bare catch{} on waitForOtpEmail - the error object is discarded`)
    }

    // (c) Whatever it does with the error, it must consult the attribution rules.
    if (!src.includes('describeOtpFailure')) {
      violations.push(`${rel}: calls waitForOtpEmail but never calls describeOtpFailure`)
    }

    // (d) A skip must never swallow a mailbox lockout - that is how BackOffice's OTP
    //     coverage vanished silently while reporting "skipped".
    if (/test\.skip\(true,\s*'OTP email not delivered/.test(src) && !src.includes('MailboxUnreachableError')) {
      violations.push(`${rel}: skips on OTP failure without excluding MailboxUnreachableError - a lockout would score as "skipped"`)
    }
  }
  assert.deepStrictEqual(violations, [], `\n  - ${violations.join('\n  - ')}\n`)
})

// ── 8. RATCHET: waitForOtpEmail may not claim non-delivery it did not observe ──
check('waitForOtpEmail proves the mailbox before reporting an empty inbox', () => {
  const src = readFileSync(join(ROOT, 'lib', 'imap.ts'), 'utf8')

  assert.ok(
    /await client\.connect\(\)\r?\n\s*\} catch/.test(src),
    'client.connect() is not wrapped - a login failure escapes as the email verdict again',
  )
  assert.ok(
    /if \(!mailboxProven\)/.test(src),
    'the "No OTP email received" throw is not gated on having actually read the inbox',
  )
  const provenAt = src.indexOf('mailboxProven = true')
  const searchAt = src.indexOf('await client.search(')
  assert.ok(provenAt > searchAt && searchAt !== -1, 'mailboxProven is not set by a completed search')
})

// ── 9. THE REAL SHAPE: an imapflow login rejection, reproduced property-for-property ──
// Measured 2026-09-03 against a live IMAP server (one login with an invalid account):
//   message "Command failed" | response "3 NO [AUTHENTICATIONFAILED] Invalid credentials
//   (Failure)" | serverResponseCode "AUTHENTICATIONFAILED" | authenticationFailed true
// Case 2 above uses a hand-made Error whose .message carries the text, so it passed for a
// full day while every production run printed "Underlying IMAP error: Command failed".
function imapflowLoginRejection() {
  const err = new Error('Command failed') // <- imap-flow.js:747, constant for ALL NO/BAD
  err.response = '3 NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)'
  err.responseText = 'Invalid credentials (Failure)'
  err.responseStatus = 'NO'
  err.serverResponseCode = 'AUTHENTICATIONFAILED'
  err.authenticationFailed = true
  err.executedCommand = '3 LOGIN "monitor@example" "(* value hidden *)"'
  return err
}

check('the real imapflow rejection is not reduced to "Command failed"', () => {
  const msg = describeOtpFailure(
    new MailboxUnreachableError('IMAP connect/login failed', imapflowLoginRejection()),
    'ReplyFlow',
  )
  assert.ok(
    !/Underlying IMAP error: Command failed$/.test(msg),
    'the message still ends in "Command failed" - the diagnosis on the error object was dropped again',
  )
  assert.ok(/AUTHENTICATIONFAILED/.test(msg), 'the server response code was not carried through')
  assert.ok(/Invalid credentials/.test(msg), 'the server sentence was not carried through')
})

// ── 10. A refused login and an unreachable host must give OPPOSITE instructions ───
check('a refused password says reset it; anything else says do not', () => {
  const refused = describeOtpFailure(
    new MailboxUnreachableError('x', imapflowLoginRejection()),
    'Valrano',
  )
  assert.ok(/reset it at the mail provider/.test(refused), 'a refused login does not name the password reset')
  assert.ok(/IMAP_PASS/.test(refused), 'a refused login does not name the secret to update')
  assert.ok(
    !/not a wrong password/.test(refused),
    'a refused login is being described as "not a wrong password" - the branches are inverted',
  )

  const unreachable = describeOtpFailure(
    new MailboxUnreachableError('x', Object.assign(new Error('getaddrinfo ENOTFOUND mail.example'), { code: 'ENOTFOUND' })),
    'Valrano',
  )
  assert.ok(
    /not a wrong password/.test(unreachable),
    'an unreachable host still sends Roger to reset a password that is fine',
  )
  assert.ok(/ENOTFOUND/.test(unreachable), 'the errno that identifies the network fault was dropped')
})

// ── 11. A NO/BAD that is NOT an auth failure must not be read as one ──────────────
// Throttling arrives as the same `new Error('Command failed')`, and `response` is still the
// unparsed object here because only the LOGIN path stringifies it - hence the typeof guard.
check('a throttled mailbox is not reported as a bad password', () => {
  const err = new Error('Command failed')
  err.response = { command: 'BAD', attributes: [] } // object, NOT a string
  err.responseText = 'Request is throttled. Suggested Backoff Time: 92415 milliseconds'
  err.responseStatus = 'BAD'

  const wrapped = new MailboxUnreachableError('x', err)
  assert.strictEqual(wrapped.credentialsRejected, false, 'throttling was classified as a credential rejection')
  assert.ok(/Request is throttled/.test(wrapped.reason), 'the throttle text was dropped')
  assert.ok(
    !/\[object Object\]/.test(wrapped.reason),
    'the unparsed response object leaked into the message as [object Object]',
  )
  const msg = describeOtpFailure(wrapped, 'ChannelMover')
  assert.ok(!/reset it at the mail provider/.test(msg), 'throttling sends Roger to reset a working password')
})

// ── 12. The compiled LOGIN line must never be surfaced ────────────────────────────
check('the executed LOGIN command is never printed', () => {
  const msg = describeOtpFailure(new MailboxUnreachableError('x', imapflowLoginRejection()), 'SignalScore')
  assert.ok(!/LOGIN/.test(msg), 'err.executedCommand leaked into the operator-facing message')
})

// ── 13. Order ratchet: the server line outranks the constant .message ─────────────
check('imapCauseText prefers the server response over .message', () => {
  const err = new Error('Command failed')
  err.response = '5 NO [OVERQUOTA] Mailbox is full'
  assert.ok(
    !imapCauseText(err).includes('Command failed'),
    'the constant library message is winning over the actual server response again',
  )
  assert.ok(imapCauseText(err).includes('OVERQUOTA'), 'the server response was not used')
  // …and with nothing else available, .message is still better than nothing.
  assert.strictEqual(imapCauseText(new Error('socket hang up')), 'socket hang up')
  assert.strictEqual(imapCauseText(null), 'unknown')
})

console.log(`imap-fault-attribution: ${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.error('\nFAILURES:\n  ' + failures.join('\n  '))
  process.exit(1)
}
