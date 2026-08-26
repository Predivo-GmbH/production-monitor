/**
 * Unit test for classifyMailerAlert (scripts/lib/mailer-alert-copy.mjs).
 *
 * The 2026-08-26 board finding: an unaudited-only mailer run (the send history could not be READ,
 * an outbound HTTP 500) was rendered as "2 products cannot send email ... customers get nothing".
 * A failure to read Postmark is not a proven outage. These cases pin that distinction, with no
 * network and no mail sent.
 *
 * Run: node test/mailer-alert-copy.mjs   (exit 0 = all pass)
 */
import assert from 'node:assert'
import { classifyMailerAlert } from '../scripts/lib/mailer-alert-copy.mjs'

let passed = 0
let failed = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok   - ${name}`); passed++ }
  catch (e) { console.log(`  FAIL - ${name}: ${e.message}`); failed++ }
}

// The incident, verbatim: BackOffice + ChannelMover went red ONLY because their Postmark send
// history could not be read (outbound HTTP 500). No proven send failure.
const incident = [
  { product: 'BackOffice', env: 'production', what: 'unaudited', detail: 'its send history could not be read (outbound HTTP 500), so whether Postmark server "X" has actually sent is unverified. Treated as unaudited, not OK.' },
  { product: 'ChannelMover', env: 'production', what: 'unaudited', detail: 'its send history could not be read (outbound HTTP 500), so whether Postmark server "Y" has actually sent is unverified. Treated as unaudited, not OK.' },
]

check('an unaudited-only run never says "cannot send email" and never says "get nothing"', () => {
  const r = classifyMailerAlert(incident)
  assert.ok(!/cannot send email/i.test(r.subject), `subject still claims an outage: ${r.subject}`)
  assert.ok(!/cannot send email/i.test(r.title), `headline still claims an outage: ${r.title}`)
  assert.ok(!/get nothing/i.test(r.lede), 'lede must not tell Roger customers get nothing when the history was merely unreadable')
  assert.match(r.subject, /unaudited/i)
  assert.match(r.title, /unaudited/i)
  assert.match(r.subject, /BackOffice/)
  assert.match(r.subject, /ChannelMover/)
  assert.notEqual(r.colour, '#dc2626', 'an unaudited-only run must not be red')
})

check('a proven send failure still reads as "cannot send email"', () => {
  const proven = [{ product: 'arivioo', env: 'production', what: 'the mailer is not configured at all', detail: 'none of SMTP_HOST/PORT/USER/PASS is set.' }]
  const r = classifyMailerAlert(proven)
  assert.match(r.subject, /cannot send email/)
  assert.match(r.title, /cannot send email/)
  assert.match(r.subject, /arivioo/)
  assert.equal(r.colour, '#dc2626')
})

check('a mixed run names only the proven outage in the subject and notes the unaudited count', () => {
  const mixed = [
    { product: 'arivioo', env: 'production', what: 'the mailer is not configured at all', detail: '...' },
    { product: 'BackOffice', env: 'production', what: 'unaudited', detail: '...' },
  ]
  const r = classifyMailerAlert(mixed)
  assert.match(r.subject, /cannot send email/)
  assert.match(r.subject, /arivioo/)
  assert.ok(!/BackOffice/.test(r.subject), 'an unaudited product must not be named as an outage in the subject')
  assert.match(r.title, /unaudited/, 'the headline should still note the unaudited product(s)')
})

console.log(`\n${passed} passed, ${failed} failed.`)
process.exit(failed ? 1 : 0)
