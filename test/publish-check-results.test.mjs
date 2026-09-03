/**
 * Unit tests for the publisher that turns the hourly Playwright report into product_check_run rows.
 *
 * The assertion this file exists for is "a product with NO login test reports 'not-tested', not
 * 'ok'". Everything else here is scaffolding around it. The defect it pins is not hypothetical:
 * the Cockpit page this table replaces rendered "Login OK / All clear" for LaunchReady on
 * 2026-09-01 while a needs-Roger board item said LaunchReady could not send its login emails.
 * A boolean, or a default of 'ok', reproduces that on day one.
 *
 * Offline by design, like every suite in this repo: no secrets, no network, no services. The
 * fixtures are Playwright-report SHAPED objects built in code — never a captured report, and
 * never a literal credential of any kind (gitleaks runs on this repo and headers are assembled,
 * not written out).
 *
 * Run: node test/publish-check-results.test.mjs   (exit 0 = all pass)
 */
import assert from 'node:assert'
import { readdirSync, writeFileSync, mkdtempSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  TEST_DIR_TO_SLUG, NON_PRODUCT_DIRS, CLASSIFIER_RULES, FIELDS, LOGIN_METHOD_STRENGTH,
  buildRows, collectChecks, classify, slugForFile, outcomeOf, messageOf, neverReachedTheProduct,
  loadResults, runUrlFrom, parseArgs, describeRow,
  NOT_TESTED, OK, FAILED, SOURCE, MAX_MESSAGE,
} from '../scripts/publish-check-results.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(REPO, 'scripts', 'publish-check-results.mjs')

let n = 0
const t = (name, fn) => { fn(); n++; console.log(`  ok - ${name}`) }

// ── fixture builders: a Playwright report shape, nested exactly as the reporter writes it ─────

const passed = (title) => ({ title, ok: true, tests: [{ status: 'expected', results: [{ status: 'passed' }] }] })
const flaky = (title) => ({ title, ok: true, tests: [{ status: 'flaky', results: [{ status: 'passed' }] }] })
const skipped = (title) => ({ title, ok: true, tests: [{ status: 'skipped', results: [] }] })
const failed = (title, message = 'expect(received).toBe(expected)') => ({
  title, ok: false, tests: [{ status: 'unexpected', results: [{ status: 'failed', errors: [{ message }] }] }],
})

/** file-suite > describe-suite > specs, which is what Playwright actually emits. */
const dirSuite = (dir, specs) => {
  const file = `${dir}/production-monitor.spec.ts`
  return {
    title: file.replace('/', '\\'),
    file,
    specs: [],
    suites: [{ title: 'Something — Production Monitor', file, specs: specs.map((s) => ({ ...s, file })) }],
  }
}
const report = (...suites) => ({ config: {}, suites, errors: [], stats: {} })
const rowFor = (rows, slug) => rows.find((r) => r.slug === slug)
/** The verbatim message every failure in run 33781865310 carried. */
const GOTO_TIMEOUT = 'TimeoutError: page.goto: Timeout 30000ms exceeded.'
/**
 * What a GENUINE mail failure actually says. Taken from the source that throws it,
 * lib/imap.ts:114 — `throw new Error(\`No OTP email received within ${timeoutMs}ms\`)` —
 * and NOT invented. The first draft of these tests used a plausible-sounding message that
 * the code never emits, which is the unrepresentative-fixture trap written up in
 * project_closer_lane_omits_awaiting_signoff_dedup_ambiguous_blocked_2026_09_03.md: a test
 * whose fixture cannot occur passes forever while proving nothing about the real case.
 */
const REAL_MAIL_FAILURE = 'Error: No OTP email received within 90000ms'

// ── A TEST THAT DIED AT THE FRONT DOOR NEVER TESTED ITS SUBJECT ─────────────────────────────

t('an E2E OTP test that times out in page.goto does NOT report mail as failed', () => {
  // THE REAL INCIDENT, 2026-09-03, run 33781865310. Every one of BackOffice's failures carried
  // this identical message. The test is named "E2E OTP: ..." so CLASSIFIER_RULES routes it to
  // mail_delivery; the old code copied its fail across without reading WHY it failed, and the
  // dashboard rendered mail_delivery='failed' as "login codes and invoices are not arriving for
  // BackOffice — customers cannot get in". Meanwhile backoffice.predivo.ch answered HTTP 200 in
  // 0.049s from another machine. Nothing about mail had been tested at all.
  const rows = buildRows(report(dirSuite('backoffice', [
    failed('auth page loads with form', GOTO_TIMEOUT),
    failed('E2E OTP: request code → email delivery → enter code → dashboard', GOTO_TIMEOUT),
    failed('CRM page loads', GOTO_TIMEOUT),
  ])))
  const r = rowFor(rows, 'backoffice')
  assert.equal(r.mail_delivery, 'not-tested',
    'a test that never loaded a page cannot report on mail delivery')
  assert.equal(r.login, 'not-tested',
    'nor on whether anyone can sign in')
  assert.equal(r.login_method, 'none',
    'and it proves no login method, since it never reached one')
  // The SITE fact is the one thing such a failure really does establish, and it must survive:
  // silencing everything would turn an outage into a green run.
  assert.equal(r.site, 'failed', 'the page genuinely did not load, and that must still be said')
  // The run stays visibly red. Abstaining on a verdict is not the same as hiding the failure.
  assert.equal(r.checks_total, 3)
  assert.equal(r.checks_passed, 0)
  assert.equal(r.failures.length, 3, 'every failure is still listed for a human to read')
})

t('a REAL mail failure is still reported as failed', () => {
  // The other half of the contract, and the one that makes the test above safe: if the OTP test
  // fails for a reason that shows it actually ran, mail_delivery must still go red. Abstaining
  // on everything would be its own defect — a monitor that can never say "mail is broken".
  const rows = buildRows(report(dirSuite('backoffice', [
    passed('auth page loads with form'),
    failed('E2E OTP: request code → email delivery → enter code → dashboard', REAL_MAIL_FAILURE),
  ])))
  const r = rowFor(rows, 'backoffice')
  assert.equal(r.mail_delivery, 'failed',
    'a genuine mail failure must still red the mail field')
  assert.equal(r.site, 'ok')
})

t('the detector reads the reason, not the test name', () => {
  assert.equal(neverReachedTheProduct(GOTO_TIMEOUT), true)
  assert.equal(neverReachedTheProduct('page.goto: net::ERR_CONNECTION_REFUSED at https://x'), true)
  // A timeout LATER in a test is not a front-door failure: waiting for a mailbox is exactly the
  // shape of a real mail outage, and must not be swallowed.
  assert.equal(neverReachedTheProduct('TimeoutError: locator.click: Timeout 30000ms exceeded.'), false)
  assert.equal(neverReachedTheProduct(REAL_MAIL_FAILURE), false)
  assert.equal(neverReachedTheProduct(''), false)
  assert.equal(neverReachedTheProduct(null), false)
})

// ── THE ONE THAT MATTERS: an unrun check is never a pass ─────────────────────────────────────

t('a product with NO login test reports login "not-tested" — never "ok"', () => {
  // predivo.ch really has no sign-in of any kind, and BoatBuddy's own suite still reports
  // not-tested whenever its gate password is unset. This is the whole reason the schema has three
  // values and no booleans. A default of 'ok' passes every other test in this file and reproduces
  // the "Login OK" that was rendered for a product that could not send a login email at all.
  // (The fixture below is deliberately BoatBuddy's pre-2026-09-01 title list: those three titles
  // prove a site, not a sign-in, and must still classify as no login at all.)
  const rows = buildRows(report(dirSuite('boatbuddy', [
    passed('landing page loads'),
    passed('site identity — title contains BoatBuddy'),
    passed('root document is served (not 5xx / not paused)'),
  ])))
  const r = rowFor(rows, 'boatbuddy')
  assert.equal(r.login, NOT_TESTED)
  assert.notEqual(r.login, OK, 'a login nobody tested must never read as a login that works')
  assert.equal(r.login_method, 'none')
  assert.equal(r.site, OK)
  assert.equal(r.identity, OK)
})

t('every field with no matching test stays "not-tested", not just login', () => {
  const rows = buildRows(report(dirSuite('predivo', [passed('landing page loads')])))
  const r = rowFor(rows, 'predivo')
  assert.equal(r.site, OK)
  for (const f of ['login', 'mail_delivery', 'identity', 'backend']) {
    assert.equal(r[f], NOT_TESTED, `${f} had no test and must be not-tested`)
  }
})

t('a SKIPPED test is not an outcome: it can never make a field "ok"', () => {
  // test.skip(!IMAP_PASS), test.skip(!SUPABASE_URL) and the OTP rate-limit cooldown all fire on
  // ordinary runs. Counting a skip as a pass is the same defect wearing a different hat.
  const rows = buildRows(report(dirSuite('arivioo', [
    skipped('full login works and dashboard loads'),
    passed('landing page loads'),
  ])))
  const r = rowFor(rows, 'arivioo')
  assert.equal(r.login, NOT_TESTED)
  assert.equal(r.checks_total, 1, 'the skipped test counts in neither total nor passed')
  assert.equal(r.checks_passed, 1)
})

t('a product whose every test skipped reports zero checks and nothing proven', () => {
  const rows = buildRows(report(dirSuite('arivioo', [skipped('full login works and dashboard loads')])))
  const r = rowFor(rows, 'arivioo')
  assert.equal(r.checks_total, 0)
  assert.equal(r.checks_passed, 0)
  for (const f of FIELDS) assert.equal(r[f], NOT_TESTED)
})

// ── login, and how it was proven ─────────────────────────────────────────────────────────────

t('a product whose login test passed reports login "ok" with the magic-link method', () => {
  const rows = buildRows(report(dirSuite('replyflow', [
    passed('full login works and dashboard loads'),
    passed('site identity — title contains replyflow'),
  ])))
  const r = rowFor(rows, 'replyflow')
  assert.equal(r.login, OK)
  assert.equal(r.login_method, 'magic-link-browser')
})

t('an OTP sign-in reports the otp-email method, and also proves mail delivery', () => {
  // BackOffice's 'E2E OTP: request code → email delivery → enter code → dashboard' fetches a real
  // message out of a real mailbox AND signs in with the code it found. It proves both.
  const rows = buildRows(report(dirSuite('backoffice', [
    passed('E2E OTP: request code → email delivery → enter code → dashboard'),
  ])))
  const r = rowFor(rows, 'backoffice')
  assert.equal(r.login, OK)
  assert.equal(r.login_method, 'otp-email')
  assert.equal(r.mail_delivery, OK)
})

t('with both login tests present the browser magic link is the reported method', () => {
  const rows = buildRows(report(dirSuite('backoffice', [
    passed('E2E OTP: request code → email delivery → enter code → dashboard'),
    passed('full login works and dashboard loads'),
  ])))
  assert.equal(rowFor(rows, 'backoffice').login_method, 'magic-link-browser')
})

t('a method is only reported for a login test that actually RAN', () => {
  const rows = buildRows(report(dirSuite('backoffice', [
    skipped('full login works and dashboard loads'),
    passed('E2E OTP: request code → email delivery → enter code → dashboard'),
  ])))
  assert.equal(rowFor(rows, 'backoffice').login_method, 'otp-email', 'a skipped magic-link test proves no method')
})

t('a login FORM rendering is not a login working', () => {
  // 'login form: fields accept input and opacity > 0' never signs in. Valrano and ScoutCopilot
  // both have one. Classifying it as login would be a smaller copy of the /auth/v1/otp probe
  // this table replaces.
  assert.deepEqual(classify('login form: fields accept input and opacity > 0').map((r) => r.field), [])
  assert.deepEqual(classify('login page has form').map((r) => r.field), ['site'])
  const rows = buildRows(report(dirSuite('valrano', [passed('login form: fields accept input and opacity > 0')])))
  assert.equal(rowFor(rows, 'valrano').login, NOT_TESTED)
})

t('the site password gate reports login "ok" with the site-password method', () => {
  // BoatBuddy has no user accounts: typing the shared password into PasswordGate IS the sign-in a
  // real person performs, so it is a login and must be reported as one — with a method that says
  // plainly it was a shared secret and not an identity check.
  const rows = buildRows(report(dirSuite('boatbuddy', [
    passed('full site password login works and the app opens'),
    passed('wrong site password is refused'),
    passed('landing page loads'),
  ])))
  const r = rowFor(rows, 'boatbuddy')
  assert.equal(r.login, OK)
  assert.equal(r.login_method, 'site-password')
  assert.equal(r.checks_total, 3)
  assert.equal(r.checks_passed, 3)
})

t('the NEGATIVE gate test is not a login claim, but it still reds the run', () => {
  // 'wrong site password is refused' proves the gate REJECTS. That is not the claim "login
  // works", so it classifies to no field at all — but it still counts as a check, so a gate that
  // has started accepting anything fails the run and fires the alert.
  assert.deepEqual(classify('wrong site password is refused').map((r) => r.field), [])
  const rows = buildRows(report(dirSuite('boatbuddy', [
    passed('full site password login works and the app opens'),
    failed('wrong site password is refused', 'A WRONG PASSWORD OPENED THE APP'),
  ])))
  const r = rowFor(rows, 'boatbuddy')
  assert.equal(r.checks_total, 2)
  assert.equal(r.checks_passed, 1)
  assert.equal(r.failures.length, 1)
  assert.match(r.failures[0].message, /A WRONG PASSWORD OPENED THE APP/)
})

t('a SKIPPED gate test leaves login "not-tested" and never "ok"', () => {
  // test.skip(!GATE_PASSWORD) fires the moment the secret goes missing from monitor.yml. A
  // missing secret must read grey, never green: that is the entire premise of this table.
  const rows = buildRows(report(dirSuite('boatbuddy', [
    skipped('full site password login works and the app opens'),
    passed('wrong site password is refused'),
    passed('landing page loads'),
  ])))
  const r = rowFor(rows, 'boatbuddy')
  assert.equal(r.login, NOT_TESTED)
  assert.notEqual(r.login, OK, 'a sign-in nobody performed must never read as a sign-in that works')
  assert.equal(r.login_method, 'none')
  assert.equal(r.checks_total, 2, 'the skipped test counts in neither total nor passed')
  assert.equal(r.checks_passed, 2)
})

t('a product with BOTH a user sign-in and a gate reports the stronger method', () => {
  // THE PRIORITY RULE. A shared site password proves the door opens; it proves nothing about who
  // opened it. Reporting 'site-password' for a product that also has a per-user magic-link login
  // would understate what the run actually proved.
  const both = [
    passed('full site password login works and the app opens'),
    passed('full login works and dashboard loads'),
  ]
  assert.equal(rowFor(buildRows(report(dirSuite('valrano', both))), 'valrano').login_method, 'magic-link-browser')
  // ...and in the other listing order, because the rank must not depend on which test ran first.
  assert.equal(rowFor(buildRows(report(dirSuite('valrano', [...both].reverse()))), 'valrano').login_method, 'magic-link-browser')
})

t('otp-email outranks site-password, and a skipped stronger test yields to the weaker one', () => {
  const rows = buildRows(report(dirSuite('boatbuddy', [
    passed('full site password login works and the app opens'),
    passed('E2E OTP: request code → email delivery → enter code → dashboard'),
  ])))
  assert.equal(rowFor(rows, 'boatbuddy').login_method, 'otp-email')

  const stronger = buildRows(report(dirSuite('boatbuddy', [
    skipped('full login works and dashboard loads'),
    passed('full site password login works and the app opens'),
  ])))
  assert.equal(rowFor(stronger, 'boatbuddy').login_method, 'site-password',
    'a skipped magic-link test proves no method, so the gate is what was actually proven')
})

t('the reported method is ranked by LOGIN_METHOD_STRENGTH, not by rule order', () => {
  // The strength list exists as its own list precisely so a future readability edit to
  // CLASSIFIER_RULES cannot silently downgrade what a product reports. This asserts the two agree
  // today, and that the strength list holds every method the rules can produce.
  const declared = CLASSIFIER_RULES.filter((r) => r.field === 'login').map((r) => r.loginMethod)
  assert.deepEqual(declared, LOGIN_METHOD_STRENGTH, 'login rules are listed strongest-first')
  assert.deepEqual(LOGIN_METHOD_STRENGTH, ['magic-link-browser', 'otp-email', 'user-password', 'site-password'])
  assert.equal(new Set(LOGIN_METHOD_STRENGTH).size, LOGIN_METHOD_STRENGTH.length)
})

t('a real account signing in with its own password reports login "ok" via user-password', () => {
  // Jass-Tour, added 2026-09-01. Its Auth.tsx offers no magic link at all and its Supabase
  // project does not allow its production domain as a redirect target, so the fleet's usual
  // route cannot reach it — email + password through the product's own form IS the sign-in a
  // real person performs here, and it is a per-user identity check, not a shared door.
  const rows = buildRows(report(dirSuite('jass-tour', [
    passed('full password login works and dashboard loads'),
    passed('wrong site password is refused'),
    passed('landing page loads'),
  ])))
  const r = rowFor(rows, 'jass-tour')
  assert.equal(r.login, OK)
  assert.equal(r.login_method, 'user-password')
  assert.equal(r.checks_total, 3)
  assert.equal(r.checks_passed, 3)
})

t('user-password is a login method and never a site check, and is distinct from site-password', () => {
  // The two titles differ by one word. If 'full password login works' also matched the
  // site-password rule — or the loose site rule — one product's sign-in would be filed as
  // another kind of proof entirely, which is the whole reason these methods are named.
  assert.deepEqual(classify('full password login works and dashboard loads').map((r) => r.field), ['login'])
  assert.deepEqual(
    classify('full password login works and dashboard loads').map((r) => r.loginMethod),
    ['user-password'],
  )
  assert.deepEqual(
    classify('full site password login works and the app opens').map((r) => r.loginMethod),
    ['site-password'],
    'the shared-gate title must not be swallowed by the user-password rule',
  )
  assert.deepEqual(classify('full login works and dashboard loads').map((r) => r.loginMethod), ['magic-link-browser'])
})

t('user-password outranks a shared gate but yields to a magic link', () => {
  const gateToo = buildRows(report(dirSuite('jass-tour', [
    passed('full site password login works and the app opens'),
    passed('full password login works and dashboard loads'),
  ])))
  assert.equal(rowFor(gateToo, 'jass-tour').login_method, 'user-password',
    'a per-user sign-in must never be understated as a shared door')

  const magicToo = buildRows(report(dirSuite('jass-tour', [
    passed('full password login works and dashboard loads'),
    passed('full login works and dashboard loads'),
  ])))
  assert.equal(rowFor(magicToo, 'jass-tour').login_method, 'magic-link-browser')
})

t('a SKIPPED user-password test leaves login "not-tested" and never "ok"', () => {
  // test.skip fires whenever JASSTOUR_TEST_PASSWORD (or the service-role key) is missing, which
  // is the state on the day this rule was written: the secret does not exist yet. Grey, not green.
  const rows = buildRows(report(dirSuite('jass-tour', [
    skipped('full password login works and dashboard loads'),
    passed('wrong site password is refused'),
    passed('landing page loads'),
    passed('site identity — title contains Beize Jass Tour'),
  ])))
  const r = rowFor(rows, 'jass-tour')
  assert.equal(r.login, NOT_TESTED)
  assert.equal(r.login_method, 'none')
  assert.equal(r.site, OK)
  assert.equal(r.identity, OK)
  assert.equal(r.checks_total, 3, 'the skipped test counts in neither total nor passed')
  assert.equal(r.checks_passed, 3)
})

t('site-password is a login method and never a site check', () => {
  // 'full site password login works and the app opens' contains the word "site", and the site
  // rule is a loose regex. A login test that also counted as a page-load check would let a green
  // `site` sit next to a red `login` for the same sentence.
  assert.deepEqual(classify('full site password login works and the app opens').map((r) => r.field), ['login'])
})

// ── failures ─────────────────────────────────────────────────────────────────────────────────

t('a failing test marks its field "failed" AND lands in failures with its message', () => {
  const rows = buildRows(report(dirSuite('signalscore', [
    failed('full login works and dashboard loads', 'Timeout 30000ms exceeded waiting for /dashboard'),
    passed('site identity — title contains signalscore'),
  ])))
  const r = rowFor(rows, 'signalscore')
  assert.equal(r.login, FAILED)
  assert.equal(r.identity, OK)
  assert.equal(r.failures.length, 1)
  assert.equal(r.failures[0].name, 'full login works and dashboard loads')
  assert.match(r.failures[0].message, /Timeout 30000ms exceeded/)
})

t('one failing check makes the field failed even when its siblings passed', () => {
  const rows = buildRows(report(dirSuite('replyflow', [
    passed('reviews page loads'),
    failed('analytics page loads', 'expected 200, got 500'),
    passed('settings page loads with tabs'),
  ])))
  assert.equal(rowFor(rows, 'replyflow').site, FAILED, 'failed is terminal for a field')
})

t('a failure message is trimmed to one line and capped for a card', () => {
  const long = 'x'.repeat(1000)
  const rows = buildRows(report(dirSuite('predivo', [failed('landing page loads', `${long}\nstack line`)])))
  const msg = rowFor(rows, 'predivo').failures[0].message
  assert.equal(msg.length, MAX_MESSAGE)
  assert.ok(!msg.includes('\n'))
})

t('a failed test with no error object still produces a named failure, not a crash', () => {
  const rows = buildRows(report(dirSuite('predivo', [
    { title: 'landing page loads', ok: false, tests: [{ status: 'unexpected', results: [] }] },
  ])))
  assert.equal(rowFor(rows, 'predivo').failures[0].message, 'Unknown error')
})

t('a flaky test counts as a pass — it held on the retry the config already allows', () => {
  const rows = buildRows(report(dirSuite('scoutcopilot', [flaky('full login works and dashboard loads')])))
  const r = rowFor(rows, 'scoutcopilot')
  assert.equal(r.login, OK)
  assert.equal(r.checks_passed, 1)
  assert.equal(r.checks_total, 1)
})

// ── counts ───────────────────────────────────────────────────────────────────────────────────

t('checks_passed is never greater than checks_total, on any mix of outcomes', () => {
  // The DB constraint product_check_run_counts_chk rejects a row that breaks this; a row rejected
  // at 03:00 by a monitor nobody watches is a silent hole, so it is asserted here too.
  const rows = buildRows(report(
    dirSuite('replyflow', [passed('a page loads'), failed('b page loads'), skipped('c page loads'), flaky('d page loads')]),
    dirSuite('predivo', [failed('landing page loads')]),
    dirSuite('boatbuddy', [skipped('landing page loads')]),
  ))
  assert.equal(rows.length, 3)
  for (const r of rows) {
    assert.ok(r.checks_passed >= 0, `${r.slug}: passed must be >= 0`)
    assert.ok(r.checks_passed <= r.checks_total, `${r.slug}: ${r.checks_passed} passed of ${r.checks_total} total`)
    assert.equal(r.failures.length, r.checks_total - r.checks_passed, `${r.slug}: every failed check is named`)
  }
  assert.deepEqual(
    rows.map((r) => [r.slug, r.checks_passed, r.checks_total]),
    [['boatbuddy', 0, 0], ['predivo', 0, 1], ['replyflow', 2, 3]],
  )
})

// ── which directories become rows ────────────────────────────────────────────────────────────

t('a test directory that is not a product produces no row', () => {
  const rows = buildRows(report(
    dirSuite('self', [passed('every mail-sending script routes through lib/smtp.mjs')]),
    dirSuite('api-health', [failed('returns favicon for holcim.com', 'HTTP 500')]),
    dirSuite('ci-health', [failed('nightly-gauntlet: Arivioo/ReplyFlow last scheduled staging gauntlet is not failing')]),
    dirSuite('keepalive', [passed('keep-alive: at least 14 projects configured')]),
    dirSuite('grom-uploader', [passed('worker root is reachable (not 5xx)')]),
  ))
  assert.deepEqual(rows, [], 'the machinery that watches the fleet is not a product a customer opens')
})

t('an unmapped directory is dropped rather than guessed into a slug', () => {
  assert.equal(slugForFile('brand-new-product/production-monitor.spec.ts'), null)
  assert.deepEqual(buildRows(report(dirSuite('brand-new-product', [passed('landing page loads')]))), [])
})

t('the directory is read whether the report path is testDir- or repo-relative', () => {
  assert.equal(slugForFile('ytmigration/production-monitor.spec.ts'), 'channelmover')
  assert.equal(slugForFile('tests/ytmigration/production-monitor.spec.ts'), 'channelmover')
  assert.equal(slugForFile('tests\\ytmigration\\production-monitor.spec.ts'), 'channelmover')
  assert.equal(slugForFile(''), null)
  assert.equal(slugForFile(null), null)
})

t('EVERY directory under tests/ is either mapped to a slug or explicitly not a product', () => {
  // THE GATE. A new product directory added to tests/ and not mapped here would be monitored
  // hourly and invisible on the page that reports monitoring — the same shape of miss as the
  // "products down" tile that was lost in a merge and noticed three days later. This test fails
  // until someone decides, in writing, which of the two tables the new directory belongs in.
  const dirs = readdirSync(join(REPO, 'tests'), { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name)
  assert.ok(dirs.length >= 17, `expected the full tests/ tree, saw ${dirs.length}`)
  // tests/jass-tour was the twelfth and last active product to get a directory (2026-09-01).
  // Named explicitly so that deleting the mapping fails HERE, with a sentence, rather than
  // silently turning the product's card blank again.
  assert.ok(dirs.includes('jass-tour'), 'tests/jass-tour must exist — it is a real product directory')
  assert.equal(TEST_DIR_TO_SLUG['jass-tour'], 'jass-tour', 'tests/jass-tour maps to fleet_projects.slug "jass-tour"')
  assert.ok(!NON_PRODUCT_DIRS.includes('jass-tour'))
  for (const dir of dirs) {
    const mapped = Object.prototype.hasOwnProperty.call(TEST_DIR_TO_SLUG, dir)
    const excluded = NON_PRODUCT_DIRS.includes(dir)
    assert.ok(mapped || excluded, `tests/${dir} is neither mapped to a fleet_projects slug nor listed as a non-product`)
    assert.ok(!(mapped && excluded), `tests/${dir} is in both tables — decide which`)
  }
  for (const dir of Object.keys(TEST_DIR_TO_SLUG)) {
    assert.ok(dirs.includes(dir), `TEST_DIR_TO_SLUG maps tests/${dir}, which does not exist`)
  }
  for (const dir of NON_PRODUCT_DIRS) {
    assert.ok(dirs.includes(dir), `NON_PRODUCT_DIRS names tests/${dir}, which does not exist`)
  }
})

// ── the classifier, held to the titles that actually exist ───────────────────────────────────

t('the classifier reproduces the independently-counted logins and mailboxes', () => {
  // 082's header states, from a separate reading of the suite: "a real magic-link browser login
  // on 8 products ... and a real mailbox round trip on 5". Two methods agreeing is the point.
  // Valrano became the 9th magic-link login on 2026-09-01, so the tally is now 9 — plus
  // BoatBuddy, whose sign-in is a site password and is counted separately below because it is a
  // different KIND of proof, not a ninth copy of the same one.
  const logins = ['arivioo', 'backoffice', 'distribution-os', 'launchready', 'replyflow', 'scoutcopilot', 'signalscore', 'valrano', 'ytmigration']
  const mail = ['backoffice', 'replyflow', 'signalscore', 'valrano', 'ytmigration']
  assert.equal(logins.length, 9)
  assert.equal(mail.length, 5)
  const rows = buildRows(report(
    ...logins.map((d) => dirSuite(d, [passed('full login works and dashboard loads')])),
    ...mail.map((d) => dirSuite(`${d}-x`, [])),
  ))
  assert.equal(rows.filter((r) => r.login === OK).length, 9)
  for (const title of ['E2E OTP: trigger email → verify IMAP delivery → check OTP format', 'E2E OTP: email contains valid links (no 404)']) {
    assert.deepEqual(classify(title).map((r) => r.field), ['mail_delivery'])
  }
})

t('real page titles classify as site, and real non-page titles do not', () => {
  const sites = [
    'landing page loads', 'site loads', 'auth page loads with form', 'CRM page loads',
    'root document is served (not 5xx / not paused)', 'login page has form', 'landing page has hero',
    'landing page has audit form', 'landing page sections all load', 'settings page loads with tabs',
    'public routes from manifest load and render (not 404/empty)', 'check history page loads after login',
  ]
  for (const s of sites) assert.ok(classify(s).some((r) => r.field === 'site'), `"${s}" should be a site check`)
  const notSites = [
    'site identity — title contains replyflow', 'dashboard loads after login',
    'no console errors on landing page', 'reviews interaction — list loads, filters work, detail panel opens',
    'check history: page structure, search input, and status filters render',
    'CSP connect-src includes correct Supabase ref',
  ]
  for (const s of notSites) assert.ok(!classify(s).some((r) => r.field === 'site'), `"${s}" should not be a site check`)
})

t('identity and backend match the titles that exist and nothing else', () => {
  assert.deepEqual(classify('site identity — title contains channelmover branding').map((r) => r.field), ['identity'])
  assert.deepEqual(classify('send-auth-email edge function is reachable').map((r) => r.field), ['backend'])
  assert.deepEqual(classify('all deployed edge functions are reachable (auto-discovered)').map((r) => r.field), ['backend'])
  assert.deepEqual(classify('no external data source is failing with zero successes (24h)').map((r) => r.field), ['backend'])
  assert.deepEqual(classify('dashboard KPI cards visible').map((r) => r.field), [])
})

t('every classifier rule names a real column and a legal login method', () => {
  for (const rule of CLASSIFIER_RULES) {
    assert.ok(FIELDS.includes(rule.field), `${rule.field} is not a product_check_run column`)
    if (rule.field === 'login') {
      assert.ok(LOGIN_METHOD_STRENGTH.includes(rule.loginMethod), 'login rules must declare how login was proven')
    } else {
      assert.equal(rule.loginMethod, undefined, 'only a login rule may declare a login method')
    }
  }
})

// ── the row as the database will see it ──────────────────────────────────────────────────────

t('a row carries only columns product_check_run has, with legal values', () => {
  const rows = buildRows(report(dirSuite('replyflow', [passed('full login works and dashboard loads')])), {
    runUrl: 'https://github.example/o/r/actions/runs/1',
  })
  const r = rows[0]
  assert.deepEqual(Object.keys(r).sort(), [
    'backend', 'checks_passed', 'checks_total', 'failures', 'identity', 'login', 'login_method',
    'mail_delivery', 'run_url', 'site', 'slug', 'source',
  ])
  assert.equal(r.source, SOURCE)
  assert.equal(r.run_url, 'https://github.example/o/r/actions/runs/1')
  for (const f of FIELDS) assert.ok([OK, FAILED, NOT_TESTED].includes(r[f]), `${f}=${r[f]} breaks the CHECK constraint`)
  assert.ok([...LOGIN_METHOD_STRENGTH, 'none'].includes(r.login_method))
  assert.ok(Array.isArray(r.failures))
  assert.ok(!('_loginRule' in r), 'internal bookkeeping must not reach the insert')
})

t('run_url is the GitHub run when the workflow provides one, and null otherwise', () => {
  assert.equal(runUrlFrom({
    GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'Arivioo/production-monitor', GITHUB_RUN_ID: '42',
  }), 'https://github.com/Arivioo/production-monitor/actions/runs/42')
  assert.equal(runUrlFrom({}), null)
  assert.equal(runUrlFrom({ GITHUB_SERVER_URL: 'https://github.com' }), null, 'a partial CI context is not a URL')
})

t('the log line names the product and every field it reports', () => {
  const line = describeRow(buildRows(report(dirSuite('boatbuddy', [passed('landing page loads')])))[0])
  assert.match(line, /boatbuddy/)
  for (const f of FIELDS) assert.ok(line.includes(`${f}=`), `${f} missing from the run log`)
})

// ── a report it cannot use must produce nothing, and must not be an error ────────────────────

t('a malformed or absent report yields no rows and does not throw', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pcr-'))
  const bad = join(dir, 'not-json.json')
  writeFileSync(bad, '{ this is not json')
  assert.equal(loadResults(bad), null)
  assert.equal(loadResults(join(dir, 'absent.json')), null)
  const notAReport = join(dir, 'wrong-shape.json')
  writeFileSync(notAReport, JSON.stringify({ hello: 'world' }))
  assert.equal(loadResults(notAReport), null, 'an object with no suites array is not a Playwright report')
  assert.deepEqual(buildRows({}), [])
  assert.deepEqual(buildRows({ suites: [] }), [])
  assert.deepEqual(collectChecks(null), [])
})

t('an absent report exits 0 — a dashboard write can never red the monitor run', () => {
  // FIRE AND FORGET, asserted through the real process boundary rather than trusted. This path
  // reaches no network: loadResults returns null before any credential is read.
  const res = spawnSync(process.execPath, [SCRIPT, '--results', join(tmpdir(), 'definitely-absent-results.json')], { encoding: 'utf-8' })
  assert.equal(res.status, 0, `exited ${res.status}: ${res.stderr}`)
  assert.match(res.stdout, /Nothing published/)
})

t('a malformed report exits 0 and says why', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pcr-'))
  const bad = join(dir, 'results.json')
  writeFileSync(bad, '{ this is not json')
  const res = spawnSync(process.execPath, [SCRIPT, '--results', bad], { encoding: 'utf-8' })
  assert.equal(res.status, 0, `exited ${res.status}: ${res.stderr}`)
  assert.match(res.stdout, /could not read/)
})

t('a report of only non-product directories writes nothing and exits 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pcr-'))
  const file = join(dir, 'results.json')
  writeFileSync(file, JSON.stringify(report(dirSuite('self', [passed('every mail-sending script routes through lib/smtp.mjs')]))))
  const res = spawnSync(process.execPath, [SCRIPT, '--results', file], { encoding: 'utf-8' })
  assert.equal(res.status, 0, `exited ${res.status}: ${res.stderr}`)
  assert.match(res.stdout, /no product test directories/)
})

t('--dry prints the rows and writes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pcr-'))
  const file = join(dir, 'results.json')
  writeFileSync(file, JSON.stringify(report(dirSuite('boatbuddy', [passed('landing page loads')]))))
  const res = spawnSync(process.execPath, [SCRIPT, '--dry', '--results', file], { encoding: 'utf-8' })
  assert.equal(res.status, 0, `exited ${res.status}: ${res.stderr}`)
  assert.match(res.stdout, /nothing written/)
  assert.match(res.stdout, /"slug": "boatbuddy"/)
  assert.match(res.stdout, /"login": "not-tested"/)
})

t('the flags are parsed as documented', () => {
  assert.deepEqual(parseArgs([]), { dry: false, strict: false, resultsFile: 'test-results/results.json' })
  assert.deepEqual(parseArgs(['--dry', '--strict', '--results', 'x.json']), { dry: true, strict: true, resultsFile: 'x.json' })
  assert.equal(parseArgs(['--results']).resultsFile, 'test-results/results.json', 'a bare --results falls back, it does not read undefined')
})

// ── outcome mapping ──────────────────────────────────────────────────────────────────────────

t('Playwright statuses map to the three outcomes and nothing is assumed', () => {
  assert.equal(outcomeOf({ status: 'expected' }), 'passed')
  assert.equal(outcomeOf({ status: 'flaky' }), 'passed')
  assert.equal(outcomeOf({ status: 'unexpected' }), 'failed')
  assert.equal(outcomeOf({ status: 'skipped' }), 'skipped')
  assert.equal(outcomeOf({}), 'skipped', 'an unknown status proves nothing, so it counts as nothing')
  assert.equal(outcomeOf(null), 'skipped')
})

t('the error is taken from the result that actually failed, ANSI stripped', () => {
  assert.equal(messageOf({ results: [{}, { errors: [{ message: '[31mboom[0m\ndetail' }] }] }), 'boom')
  assert.equal(messageOf({ results: [{ error: { message: 'legacy shape' } }] }), 'legacy shape')
})

console.log(`\n${n} assertions passed.`)
