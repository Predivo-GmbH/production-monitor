#!/usr/bin/env node
// Tests how check-ci-budget attributes a call that has burned all its retries. The load-bearing
// assertion is the one that reproduces the 3fd13c6 bug: a call that only ever saw 5xx or network
// faults is an API error, EVEN IN A RUN where some earlier call drained the API hour. The old code
// attributed with a module-level `quotaResetAt` global, so one transient rate-limited call made
// every later give-up read as a quota problem and hid GitHub outages behind a "re-run after the
// reset" message. giveUpKind takes ONLY this call's own flag, so that cross-call taint is impossible
// by construction.
// Run: node test/ci-budget-giveup.test.mjs
import assert from 'node:assert'
import { giveUpKind } from '../scripts/lib/ci-budget-giveup.mjs'

let pass = 0
const ok = (m) => { console.log('  ok -', m); pass++ }

// 1) A call that itself hit the rate limit is a quota give-up.
assert.equal(giveUpKind(true), 'ratelimit')
ok('this call was rate-limited -> ratelimit')

// 2) A call that never saw a rate limit (exhausted on 5xx / network) is an API error.
assert.equal(giveUpKind(false), 'api')
ok('this call only saw 5xx/network -> api (not a quota problem)')

// 3) THE REGRESSION. Simulate a sweep: an earlier call was rate-limited (in the old code this set
//    the quotaResetAt global for the whole run), then a later call exhausted purely on 5xx. The
//    later call must STILL be an API error - the earlier call's rate limit cannot reach it, because
//    giveUpKind's only input is the per-call flag.
const earlierCallSawRateLimit = giveUpKind(true) // drains the hour earlier in the sweep
assert.equal(earlierCallSawRateLimit, 'ratelimit')
const laterCallOnly5xx = giveUpKind(false)
assert.equal(laterCallOnly5xx, 'api', 'an earlier rate limit must NOT taint a later 5xx give-up')
ok('earlier rate limit does not taint a later 5xx give-up (the 3fd13c6 misattribution)')

console.log(`\n${pass} check(s) passed`)
