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

// The 2026-08-29 board finding, verbatim: the guard got HTTP 401 on the Supabase Management API,
// so it could not read the project - it knows NOTHING about whether the mailer can send. This is
// what check-mailer-config.mjs emits for that (`what` = 'the project could not be read'), and it
// must never render as a customer-facing outage.
const guardBlind401 = [
  { product: 'BackOffice', env: 'production', what: 'the project could not be read', detail: 'Supabase Management API: HTTP 401' },
  { product: 'replyflow', env: 'production', what: 'the project could not be read', detail: 'Supabase Management API: HTTP 401' },
]

check('a project the guard could not read (HTTP 401) is UNKNOWN, never "cannot send email"', () => {
  const r = classifyMailerAlert(guardBlind401)
  assert.ok(!/cannot send email/i.test(r.subject), `subject still claims an outage: ${r.subject}`)
  assert.ok(!/cannot send email/i.test(r.title), `headline still claims an outage: ${r.title}`)
  assert.ok(!/get nothing/i.test(r.lede), 'lede must not tell Roger customers get nothing when the guard merely lost access')
  assert.match(r.subject, /lost access/i)
  assert.match(r.title, /UNKNOWN/)
  assert.match(r.lede, /guard/i)
  assert.notEqual(r.colour, '#dc2626', 'a guard-blind run must not be red')
})

check('a source the guard could not read is also UNKNOWN, not an outage', () => {
  const r = classifyMailerAlert([
    { product: 'signalscore', env: 'repo', what: 'the mailer source could not be read', detail: 'no local checkout and GH_TOKEN is not set' },
  ])
  assert.ok(!/cannot send email/i.test(r.subject), `subject still claims an outage: ${r.subject}`)
  assert.match(r.subject, /lost access/i)
  assert.notEqual(r.colour, '#dc2626')
})

check('a proven outage still pages red even when another project is guard-blind', () => {
  const r = classifyMailerAlert([
    { product: 'arivioo', env: 'production', what: 'the mailer is not configured at all', detail: '...' },
    ...guardBlind401,
  ])
  assert.match(r.subject, /cannot send email/)
  assert.match(r.subject, /arivioo/)
  assert.ok(!/BackOffice/.test(r.subject), 'a guard-blind product must not be named as an outage in the subject')
  assert.equal(r.colour, '#dc2626')
  assert.match(r.title, /guard could not read/, 'the guard-blind products should still be counted in the headline')
})

// 2026-08-26 board finding, applied 2026-09-02: "unaudited" is amber because it is a MINORITY
// report - some products could not be read, the rest were. When EVERY declared product comes back
// unaudited the guard proved nothing at all, and amber + "Reserve action for a run that names a
// proven send failure" stands Roger down from the one run that most needs a look.
const unauditedFleet = (n) => Array.from({ length: n }, (_, i) => ({
  product: `product-${i}`, env: 'production', what: 'unaudited',
  detail: 'its send history could not be read (outbound HTTP 500)',
}))

check('an ALL-unaudited run is red and drops the "Reserve action" stand-down', () => {
  const r = classifyMailerAlert(unauditedFleet(8), { fleetProducts: 8 })
  assert.equal(r.colour, '#dc2626', 'a run that read nothing at all must not be amber')
  assert.ok(!/Reserve action/i.test(r.lede), 'a run that proved nothing must not tell Roger to reserve action')
  assert.ok(!/cannot send email/i.test(r.subject), 'still no proven send failure, so still no outage claim')
  assert.ok(!/cannot send email/i.test(r.title), 'still no proven send failure, so still no outage claim')
  assert.match(r.title, /8 of 8/, 'the headline must say how much of the fleet went unread')
  assert.match(r.lede, /nothing is confirming/i)
})

check('nearly-all unaudited is red too', () => {
  const r = classifyMailerAlert(unauditedFleet(7), { fleetProducts: 8 })
  assert.equal(r.colour, '#dc2626')
  assert.ok(!/Reserve action/i.test(r.lede))
  assert.match(r.subject, /nearly every/i)
})

check('an isolated unaudited minority stays amber and keeps the stand-down', () => {
  const r = classifyMailerAlert(unauditedFleet(2), { fleetProducts: 8 })
  assert.equal(r.colour, '#d97706', '2 of 8 unread is still a minority report')
  assert.match(r.lede, /Reserve action/i)
})

check('without a fleet size the classifier keeps its old amber behaviour', () => {
  const r = classifyMailerAlert(unauditedFleet(8))
  assert.equal(r.colour, '#d97706')
})

check('a proven failure still outranks an all-unaudited fleet', () => {
  const r = classifyMailerAlert([
    { product: 'arivioo', env: 'production', what: 'the mailer is not configured at all', detail: '...' },
    ...unauditedFleet(8),
  ], { fleetProducts: 9 })
  assert.equal(r.colour, '#dc2626')
  assert.match(r.subject, /cannot send email/)
  assert.match(r.subject, /arivioo/)
})

// 2026-09-03 board finding, verbatim: run 33730188124 had one failing row, Distribution-OS STAGING,
// what='a dormant environment has grown a mailer' (check-mailer-config.mjs:382) - the environment
// GREW a mailer (the inverse of losing one), yet it mailed "Distribution-OS cannot send email ...
// customers get nothing" while the same run's table printed that product's SMTP OK. That finding is
// neither unaudited nor guard-blind, so the old default-proven blocklist swept it into the outage
// bucket. It is config drift: amber, never a customer-facing outage.
const dormantDrift = [
  { product: 'Distribution-OS', env: 'staging', what: 'a dormant environment has grown a mailer', detail: 'recorded as deliberately unconfigured, but it now carries SMTP_HOST, SMTP_PORT. Either it started sending and the baseline is stale, or something was set here by mistake.' },
]

check('a dormant-drift-only run is NEVER the customer-outage lede', () => {
  const r = classifyMailerAlert(dormantDrift, { fleetProducts: 12 })
  assert.ok(!/cannot send email/i.test(r.subject), `subject still claims an outage: ${r.subject}`)
  assert.ok(!/cannot send email/i.test(r.title), `headline still claims an outage: ${r.title}`)
  assert.ok(!/get nothing/i.test(r.lede), 'lede must not tell Roger customers get nothing for a config-drift observation')
  assert.notEqual(r.colour, '#dc2626', 'config drift is not a red outage')
  assert.match(r.subject, /Distribution-OS/)
  assert.match(r.subject, /drift/i)
  assert.match(r.lede, /NOT a "cannot send email" notice/i)
  assert.match(r.title, /dormant environment has grown a mailer/)
})

check('a NEW finding type defaults to non-customer-facing drift wording, not to "cannot send email"', () => {
  // The whole point of the allowlist: an unforeseen finding type inherits the SAFE wording.
  const novel = [{ product: 'someproduct', env: 'production', what: 'a brand-new finding nobody has classified yet', detail: '...' }]
  const r = classifyMailerAlert(novel, { fleetProducts: 12 })
  assert.ok(!/cannot send email/i.test(r.subject), `a new finding type must not default to an outage claim: ${r.subject}`)
  assert.ok(!/get nothing/i.test(r.lede))
  assert.notEqual(r.colour, '#dc2626')
})

check('a proven outage still outranks a config-drift finding and names only the proven product', () => {
  const r = classifyMailerAlert([
    { product: 'arivioo', env: 'production', what: 'the mailer is not configured at all', detail: '...' },
    ...dormantDrift,
  ], { fleetProducts: 12 })
  assert.match(r.subject, /cannot send email/)
  assert.match(r.subject, /arivioo/)
  assert.ok(!/Distribution-OS/.test(r.subject), 'a config-drift product must not be named as an outage in the subject')
  assert.match(r.title, /config drift/, 'the drift product should still be counted in the headline')
  assert.equal(r.colour, '#dc2626')
})

console.log(`\n${passed} passed, ${failed} failed.`)
process.exit(failed ? 1 : 0)
