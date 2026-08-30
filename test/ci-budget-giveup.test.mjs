#!/usr/bin/env node
// Tests how check-ci-budget attributes a call that has burned all its retries. The load-bearing
// assertion reproduces the 3fd13c6 bug: a call that only ever saw 5xx or network faults is an API
// error, EVEN IN A RUN where some earlier call drained the API hour. The old code attributed with a
// module-level `quotaResetAt` global, so one transient rate-limited call made every later give-up
// read as a quota problem and hid GitHub outages behind a "re-run after the reset" message.
//
// The earlier version of this file only checked the pure giveUpKind() helper, which is stateless -
// so its "regression" case (giveUpKind(true) then giveUpKind(false)) was true of the buggy code
// too, because the bug never lived in the helper: it lived in WHICH value the CALL SITE passes.
// Nothing exercised the call site, so a revert there would have stayed green. This version drives
// the real retry/attribution loop (lib/gh-budget-fetch.mjs, the code check-ci-budget runs) with a
// stubbed fetch and asserts which run-wide counter each burned-out call lands in.
// Run: node test/ci-budget-giveup.test.mjs
import assert from 'node:assert'
import { giveUpKind } from '../scripts/lib/ci-budget-giveup.mjs'
import { makeGh } from '../scripts/lib/gh-budget-fetch.mjs'

let pass = 0
const ok = (m) => { console.log('  ok -', m); pass++ }

// --- Unit: the pure attribution helper (honest tests of what it is - a per-call classifier) ---
assert.equal(giveUpKind(true), 'ratelimit')
ok('helper: this call was rate-limited -> ratelimit')
assert.equal(giveUpKind(false), 'api')
ok('helper: this call only saw 5xx/network -> api (not a quota problem)')

// --- A minimal stub of the fetch Response surface gh() actually touches: status, ok, headers.get,
// json. Header lookups are case-insensitive, like the real Headers object. ---
const headerBag = (h) => {
  const m = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), String(v)]))
  return { get: (k) => (k.toLowerCase() in m ? m[k.toLowerCase()] : null) }
}
const res = (status, headers = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: headerBag(headers),
  json: async () => ({}),
})

// --- THE REGRESSION, now exercised at the call site. Drive a two-call sweep:
//   call to /A : always 429 with a reset header  -> burns 6 attempts -> a RATE-LIMIT give-up,
//                and it sets the run-wide quotaResetAt (this is the "earlier rate-limited call").
//   call to /B : always 500                       -> burns 6 attempts on pure 5xx -> an API ERROR.
// The 3fd13c6 bug attributed the give-up from the run-global set by /A, so /B was miscounted as a
// quota give-up. With the per-call flag, /B must land in apiErrors and /A in rateLimitGiveUps.
// fetch/sleep/now are injected so the loop runs instantly and deterministically (no real waits). ---
const RESET = 4102444800 // 2100-01-01 in epoch seconds; far future so `reset > quotaResetAt`
const stubFetch = async (url) =>
  String(url).includes('/A')
    ? res(429, { 'x-ratelimit-reset': RESET, 'x-ratelimit-remaining': '0' })
    : res(500)

const stats = { apiErrors: 0, rateLimitGiveUps: 0, quotaResetAt: 0 }
const gh = makeGh({ headers: {}, stats, fetchImpl: stubFetch, sleepImpl: async () => {}, now: () => 0 })
assert.equal(await gh('https://api.github.com/A'), null) // rate-limited call, earlier in the sweep
assert.equal(await gh('https://api.github.com/B'), null) // later call, exhausted purely on 5xx

assert.equal(stats.rateLimitGiveUps, 1, 'the call that kept hitting the rate limit is a quota give-up')
assert.equal(
  stats.apiErrors,
  1,
  'an earlier rate limit must NOT taint a later 5xx-only give-up (the 3fd13c6 misattribution)',
)
ok('call site: earlier rate limit does not taint a later 5xx give-up (the 3fd13c6 misattribution)')

console.log(`\n${pass} check(s) passed`)
