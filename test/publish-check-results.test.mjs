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
  TEST_DIR_TO_SLUG, NON_PRODUCT_DIRS, CLASSIFIER_RULES, FIELDS,
  buildRows, collectChecks, classify, slugForFile, outcomeOf, messageOf,
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

// ── THE ONE THAT MATTERS: an unrun check is never a pass ─────────────────────────────────────

t('a product with NO login test reports login "not-tested" — never "ok"', () => {
  // BoatBuddy, Predivo and Valrano really do have no sign-in test. This is the whole reason the
  // schema has three values and no booleans. A default of 'ok' passes every other test in this
  // file and reproduces the "Login OK" that was rendered for a product that could not send a
  // login email at all.
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
  assert.ok(dirs.length >= 16, `expected the full tests/ tree, saw ${dirs.length}`)
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

t('the classifier reproduces the independently-counted 8 logins and 5 mailboxes', () => {
  // 082's header states, from a separate reading of the suite: "a real magic-link browser login
  // on 8 products ... and a real mailbox round trip on 5". Two methods agreeing is the point.
  const logins = ['arivioo', 'backoffice', 'distribution-os', 'launchready', 'replyflow', 'scoutcopilot', 'signalscore', 'ytmigration']
  const mail = ['backoffice', 'replyflow', 'signalscore', 'valrano', 'ytmigration']
  assert.equal(logins.length, 8)
  assert.equal(mail.length, 5)
  const rows = buildRows(report(
    ...logins.map((d) => dirSuite(d, [passed('full login works and dashboard loads')])),
    ...mail.map((d) => dirSuite(`${d}-x`, [])),
  ))
  assert.equal(rows.filter((r) => r.login === OK).length, 8)
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
      assert.ok(['magic-link-browser', 'otp-email'].includes(rule.loginMethod), 'login rules must declare how login was proven')
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
  assert.ok(['magic-link-browser', 'otp-email', 'none'].includes(r.login_method))
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
