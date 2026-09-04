/**
 * An unreachable runner is not six product outages.
 *
 *   node test/an-unreachable-runner-is-not-six-outages.test.mjs
 *
 * THE INCIDENT. On 2026-09-03 the hourly monitor tried to send:
 *
 *   [ALERT] 33 failure(s) — Arivioo (4), BackOffice (11), BoatBuddy (4),
 *           Distribution-OS (7), Jass-Tour (5), LaunchReady (2)
 *
 * Every one of those 33 carried the identical message `page.goto: Timeout 30000ms exceeded`.
 * The browser never loaded a page, so nothing downstream of the page load was exercised at all.
 * Measured minutes later from another machine: backoffice.predivo.ch 200 in 0.049s,
 * distributionos.predivo.ch 200, arivioo.com 200, predivo.ch 301, valrano.com 200,
 * channelmover.com 200. Six products had not broken; one runner could not see them.
 *
 * THE SAME DEFECT WAS ALREADY FIXED ONCE, IN THE OTHER CONSUMER. publish-check-results.mjs
 * (commit 51eeed1) made an unreached failure ABSTAIN on the dashboard fields, so /monitoring
 * stopped claiming "mail delivery failed" for a page that never loaded. The alert email counts
 * SPECS rather than fields, so it went on saying 33 failures after the dashboard had stopped.
 * One fault, two readers, and fixing the reader you happened to be looking at.
 *
 * WHAT THIS IS NOT. It is not a suppression. An unreachable host is worth telling him about —
 * it may be a real outage — so the mail still goes. Only the SENTENCE changes, from six invented
 * product outages to the one thing that is actually known: nothing could be reached.
 */
import assert from 'node:assert/strict'
import { isUnreachableRun, reachedAnyProduct } from '../scripts/lib/parse-failures.mjs'

let passed = 0
const check = (name, fn) => {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (e) {
    console.error(`  FAIL  ${name}\n        ${e.message}`)
    process.exitCode = 1
  }
}

/** The message every one of the 33 carried, verbatim. */
const GOTO = 'TimeoutError: page.goto: Timeout 30000ms exceeded.'
/** What a REAL mail failure says — from the source that throws it, lib/imap.ts:114. Not invented. */
const REAL_MAIL = 'Error: No OTP email received within 90000ms'

const fail = (error, project = 'BackOffice') => ({ project, test: 't', error, file: 'f' })

check('a run where every failure is a first-navigation timeout is unreachable', () => {
  assert.equal(isUnreachableRun([fail(GOTO), fail(GOTO), fail(GOTO)]), true)
  assert.equal(isUnreachableRun([fail('page.goto: net::ERR_CONNECTION_REFUSED at https://x')]), true)
})

check('ONE real failure among them and it is not unreachable — the important direction', () => {
  // This is the assertion that makes the whole change safe. If a genuine fault can hide behind a
  // reachability problem, the rewrite becomes a way to lose real alerts. A single non-goto failure
  // must drag the whole run back to the ordinary "N failure(s)" wording.
  assert.equal(isUnreachableRun([fail(GOTO), fail(REAL_MAIL), fail(GOTO)]), false)
  assert.equal(isUnreachableRun([fail(REAL_MAIL)]), false)
})

check('a timeout LATER in a test does not count as never-reached', () => {
  // page.goto is the FIRST navigation. A locator timing out means the page DID load and the test
  // got somewhere — that is a real failure and must keep its ordinary wording.
  assert.equal(isUnreachableRun([fail('TimeoutError: locator.click: Timeout 30000ms exceeded.')]), false)
  assert.equal(isUnreachableRun([fail('Timeout of 30000ms exceeded while waiting for element')]), false)
})

check('an empty run is not "unreachable" — absence of failures is not evidence', () => {
  // Guards against the inverted default. With zero failures there is nothing to classify, and
  // returning true here would relabel every clean run as an outage.
  assert.equal(isUnreachableRun([]), false)
  assert.equal(isUnreachableRun(null), false)
  assert.equal(isUnreachableRun(undefined), false)
})

check('a failure with no error text is not silently treated as unreachable', () => {
  // A missing message must not match the pattern by accident — the honest answer is "not proven
  // unreachable", which keeps the ordinary wording rather than inventing a diagnosis.
  assert.equal(isUnreachableRun([fail('')]), false)
  assert.equal(isUnreachableRun([{ project: 'X', test: 't' }]), false)
  assert.equal(isUnreachableRun([fail(GOTO), fail('')]), false)
})

check('the real incident shape: 33 failures across six products, all goto timeouts', () => {
  // Reconstructed from the alert that could not be delivered, in its real proportions.
  const counts = { Arivioo: 4, BackOffice: 11, BoatBuddy: 4, 'Distribution-OS': 7, 'Jass-Tour': 5, LaunchReady: 2 }
  const failures = Object.entries(counts).flatMap(([p, n]) => Array.from({ length: n }, () => fail(GOTO, p)))
  assert.equal(failures.length, 33, 'fixture must reproduce the 33 the mail claimed')
  assert.equal(new Set(failures.map((f) => f.project)).size, 6)
  assert.equal(isUnreachableRun(failures), true,
    'the run that produced "[ALERT] 33 failure(s)" across six products must classify as unreachable')
})

// ── BREADTH GATE (2026-09-04, board incident 160601d:unreachable-run-misreads-real-outage).
// The predicate above cannot, from the failure text alone, tell a runner with no network apart
// from a product that is genuinely down — so a REAL outage was being relabelled the monitor's own
// networking problem. The gate: only say "could not reach ANY product" when the run reached NONE.

check('ONE product down while the rest are reachable is a TARGETED outage, not a dead runner (shape a)', () => {
  // The 2026-09-04 gap: nginx/DNS drops one product, its specs all page.goto-timeout, the other
  // five products pass. list.every() is still true — but the runner clearly HAD a network, so this
  // must keep the ordinary "[ALERT] N failure(s) — <that product>" wording, not drop the name and
  // claim "This is NOT 1 product outages." reachedAnyProduct=true drags it back to ordinary wording.
  assert.equal(isUnreachableRun([fail(GOTO, 'BackOffice')], { reachedAnyProduct: true }), false)
  assert.equal(isUnreachableRun([fail(GOTO, 'BackOffice'), fail(GOTO, 'BackOffice')], { reachedAnyProduct: true }), false)
})

check('reached NOTHING (no product passed) still classifies as unreachable — shape b / the original', () => {
  // The shared host is down (or the runner has no network): six products, all goto, nothing passed.
  // We still flag it — an unreachable host matters — but the header wording no longer ASSERTS it is
  // NOT an outage, because from one vantage point it might be exactly that.
  const six = ['Arivioo', 'BackOffice', 'BoatBuddy', 'Distribution-OS', 'Jass-Tour', 'LaunchReady']
    .map((p) => fail(GOTO, p))
  assert.equal(isUnreachableRun(six, { reachedAnyProduct: false }), true)
})

check('an unknown reach signal (no/unparseable report) preserves the prior behaviour', () => {
  // Callers that cannot compute reachedAnyProduct pass nothing; the gate must not silently flip the
  // classification for them. Absent opts → the goto-only run is still unreachable as before.
  assert.equal(isUnreachableRun([fail(GOTO), fail(GOTO)]), true)
  assert.equal(isUnreachableRun([fail(GOTO), fail(GOTO)], {}), true)
})

// ── reachedAnyProduct(results): the breadth signal, computed from the FULL Playwright report.
const passedTest = { status: 'expected', results: [{ status: 'passed' }] }
const failedGoto = { status: 'unexpected', results: [{ status: 'failed', errors: [{ message: GOTO }] }] }
const productSuite = (folder, product, tests) => ({
  title: `${folder}/production-monitor.spec.ts`,
  suites: [{ title: `${product} — Production Monitor`, specs: tests.map((t, i) => ({ title: `spec ${i}`, tests: [t] })) }],
})

check('reachedAnyProduct is true when at least one product spec passed', () => {
  const results = { suites: [
    productSuite('backoffice', 'BackOffice', [failedGoto, failedGoto]),
    productSuite('arivioo', 'Arivioo', [passedTest]),
  ] }
  assert.equal(reachedAnyProduct(results), true)
})

check('reachedAnyProduct is FALSE when every product failed at the door — even if a self-test passed', () => {
  // The regression this guards: the monitor's own SMTP self-test (tests/self/*) can pass while the
  // runner cannot reach a single product. If that counted as "reached a product", every genuine
  // total outage would be relabelled back into "N failure(s) across N project(s)". self/ is excluded.
  const results = { suites: [
    productSuite('backoffice', 'BackOffice', [failedGoto]),
    productSuite('arivioo', 'Arivioo', [failedGoto]),
    { title: 'self/alert-transport.spec.ts', suites: [{ title: 'Alerting — SMTP transport', specs: [{ title: 'sends', tests: [passedTest] }] }] },
  ] }
  assert.equal(reachedAnyProduct(results), false,
    'a passing self-test must not be mistaken for having reached a product')
})

check('reachedAnyProduct is false for an empty or resultless report', () => {
  assert.equal(reachedAnyProduct({ suites: [] }), false)
  assert.equal(reachedAnyProduct({}), false)
  assert.equal(reachedAnyProduct(null), false)
})

check('a total blackout where only NETWORK-FREE infra specs pass is NOT "reached a product"', () => {
  // The 2026-09-04 defect (board add8152). reachedAnyProduct excluded only self/, so the three
  // infrastructure folders that exist in the REAL report — keepalive/ (asserts an env-built array,
  // no I/O), api-health/ (third-party hosts that answer during a product blackout), ci-health/
  // (GitHub API only) — counted as "a product was reached." Modelled here with the real suite-title
  // shape "<folder>/<file>.spec.ts": every PRODUCT suite failed at page.goto, and the only passes are
  // those three infra suites. reachedAnyProduct must be FALSE, or a total blackout reverts to
  // "N product outages" — the exact wording commit 37b7982 removed.
  const results = { suites: [
    productSuite('backoffice', 'BackOffice', [failedGoto]),
    productSuite('arivioo', 'Arivioo', [failedGoto]),
    { title: 'keepalive/supabase-keepalive.spec.ts', suites: [{ title: 'Keep-alive', specs: [{ title: '14 projects', tests: [passedTest] }] }] },
    { title: 'keepalive/keepalive-workflow-presence.spec.ts', suites: [{ title: 'Keep-alive presence', specs: [{ title: 'workflow', tests: [passedTest] }] }] },
    { title: 'api-health/external-apis.spec.ts', suites: [{ title: 'External APIs', specs: [{ title: 'brandfetch', tests: [passedTest] }] }] },
    { title: 'ci-health/nightly-gauntlet.spec.ts', suites: [{ title: 'Nightly gauntlet', specs: [{ title: 'gauntlet ran', tests: [passedTest] }] }] },
    { title: 'self/alert-transport.spec.ts', suites: [{ title: 'Alerting — SMTP transport', specs: [{ title: 'sends', tests: [passedTest] }] }] },
  ] }
  assert.equal(reachedAnyProduct(results), false,
    'passing infra/self suites in a product blackout must not count as breadth evidence')
  // …and end to end: the goto-only failure set must therefore still classify as unreachable.
  const fails = ['BackOffice', 'Arivioo'].map((p) => fail(GOTO, p))
  assert.equal(isUnreachableRun(fails, { reachedAnyProduct: reachedAnyProduct(results) }), true,
    'a blackout whose only passes are network-free infra specs must stay classified unreachable')
})

check('reachedAnyProduct stays TRUE when a real product passes alongside the infra suites', () => {
  // The safe direction: the fix must not over-exclude. One genuine product pass among the infra
  // suites still proves the runner had a network and saw a product → ordinary wording, not blackout.
  const results = { suites: [
    productSuite('backoffice', 'BackOffice', [failedGoto]),
    productSuite('arivioo', 'Arivioo', [passedTest]),
    { title: 'api-health/external-apis.spec.ts', suites: [{ title: 'External APIs', specs: [{ title: 'brandfetch', tests: [passedTest] }] }] },
  ] }
  assert.equal(reachedAnyProduct(results), true)
})

if (process.exitCode) console.error(`\n${passed} passed, and at least one failed.`)
else console.log(`\n${passed} checks passed - an unreachable runner no longer reads as six product outages.`)
