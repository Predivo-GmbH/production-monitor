#!/usr/bin/env node
// Tests the classifier that decides what the CI-runner watchdog's "could not complete" alert tells
// Roger to do. The load-bearing assertion is that a 403 RATE LIMIT is never reported as an auth
// failure: on 2026-08-29 the shared GitHub API hour emptied, the watchdog bailed, and the alert
// said "the DASHBOARD_PAT expired or lost its administration scope" - false, and the third time it
// had misattributed the cause. A rate limit self-heals at the reset; rotating the token does nothing.
// Run: node test/classify-watchdog-failure.test.mjs
import assert from 'node:assert'
import { classifyWatchdogFailure } from '../scripts/lib/classify-watchdog-failure.mjs'

let pass = 0
const ok = (m) => { console.log('  ok -', m); pass++ }

// 1) The exact reason check-ci-runners.mjs now bails with when the API hour is empty.
assert.equal(
  classifyWatchdogFailure(
    'GitHub API rate limit exhausted (core resets at 2026-08-29T23:34:28.000Z) - this is a RATE LIMIT, not an auth failure. The token is valid; an invalid token could not reach the API at all. Do NOT rotate the DASHBOARD_PAT.',
  ),
  'ratelimit',
  'the watchdog rate-limit bail reason must classify as ratelimit, even though it says "token"',
)
ok('rate-limit bail reason -> ratelimit (not auth, despite mentioning the token)')

// 2) The bare line from the run log that proved this was a rate limit (run 33279964574).
assert.equal(
  classifyWatchdogFailure('HTTP 403: API rate limit exceeded for user ID 251853205'),
  'ratelimit',
  '403 + "rate limit exceeded" is a rate limit, not auth',
)
ok('"HTTP 403: API rate limit exceeded" -> ratelimit (rate limit wins over the 403)')

// 3) A genuine expired / descoped / bad token is STILL auth - the one case we must not muffle.
for (const reason of [
  '401 Unauthorized - Bad credentials',
  '403 Forbidden - token missing the administration scope',
  'listed no private repositories. Broken token or broken harness - not a healthy fleet.',
]) {
  assert.equal(classifyWatchdogFailure(reason), 'auth', `should be auth: ${reason}`)
}
ok('expired / descoped / broken token -> auth (rotation advice still fires when it should)')

// 4) A crash / timeout / batch of failed API calls is neither - point at the logs, do not rotate.
for (const reason of [
  '3 API call(s) failed - this run cannot certify the fleet',
  'the watchdog wrote no report - it failed or crashed before it could inspect the fleet',
  'the watchdog left an unreadable report (see the run logs)',
]) {
  assert.equal(classifyWatchdogFailure(reason), 'other', `should be other: ${reason}`)
}
ok('crash / timeout / failed API calls -> other (no rotation advice)')

// 5) Empty / nullish input never throws and is treated as unknown.
assert.equal(classifyWatchdogFailure(''), 'other')
assert.equal(classifyWatchdogFailure(null), 'other')
assert.equal(classifyWatchdogFailure(undefined), 'other')
ok('empty / null / undefined -> other (never throws)')

console.log(`\n${pass} check(s) passed`)
