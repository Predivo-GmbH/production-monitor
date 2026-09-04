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
import { isUnreachableRun } from '../scripts/lib/parse-failures.mjs'

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

if (process.exitCode) console.error(`\n${passed} passed, and at least one failed.`)
else console.log(`\n${passed} checks passed - an unreachable runner no longer reads as six product outages.`)
