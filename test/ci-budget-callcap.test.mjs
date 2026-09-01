#!/usr/bin/env node
// Proves the CALL CAP added to lib/gh-budget-fetch.mjs on 2026-09-01.
//
// WHY THIS TEST AND NOT A DISPATCH. The thing being prevented is "one run empties the fleet's
// shared GitHub API hour", and the only way to observe that for real is to do it: three
// back-to-back dispatches of the CI Cost Guard on 2026-08-29 took the allowance to 0/5000 and
// stopped everything else that needed the API that hour. Verifying a rate-limit guard by
// exhausting the rate limit is the same mistake with extra steps, so the loop is driven here with
// a stubbed fetch that COUNTS calls - deterministic, free, and it can assert the one thing a live
// run cannot show you cheaply: that the sweep stops at the right number and refuses to certify.
//
// Run: node test/ci-budget-callcap.test.mjs
import assert from 'node:assert'
import { makeGh } from '../scripts/lib/gh-budget-fetch.mjs'

let pass = 0
const ok = (m) => { console.log('  ok -', m); pass++ }

const headerBag = (h) => {
  const m = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), String(v)]))
  return { get: (k) => (k.toLowerCase() in m ? m[k.toLowerCase()] : null) }
}
const res = (status, headers = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: headerBag(headers),
  json: async () => ({ ok: true }),
})
const freshStats = () => ({ apiErrors: 0, rateLimitGiveUps: 0, quotaResetAt: 0, calls: 0, stoppedBy: null, lowestRemaining: null })
const noSleep = async () => {}

// ── 1. THE PER-RUN CEILING ─────────────────────────────────────────────────────────────────
{
  let fetched = 0
  const stats = freshStats()
  const gh = makeGh({
    headers: {},
    stats,
    maxCalls: 10,
    reserve: 0,
    fetchImpl: async () => { fetched++; return res(200, { 'x-ratelimit-remaining': '4999' }) },
    sleepImpl: noSleep,
  })
  // Ask for far more than the cap, the way the real sweep does: one jobs call per run, and the
  // number of runs is whatever the window happens to contain.
  for (let i = 0; i < 50; i++) await gh(`https://api.github.com/x/${i}`)

  assert.equal(fetched, 10, `expected the network to be touched exactly 10 times, got ${fetched}`)
  ok('stops at maxCalls: 50 requests, only 10 reach the network')
  assert.equal(stats.calls, 10)
  ok('the call counter is the cap, not an estimate')
  assert.ok(String(stats.stoppedBy).startsWith('maxcalls:'), `stoppedBy was ${stats.stoppedBy}`)
  ok('records WHY it stopped, so the failure can name the remedy')
}

// ── 2. THE SHARED-QUOTA FLOOR ──────────────────────────────────────────────────────────────
// The limit that actually matters. A cap counted only against our own calls cannot see that other
// jobs have already spent most of the hour; this one reads what is LEFT on the shared key.
{
  let fetched = 0
  const stats = freshStats()
  // Remaining falls 5000, 4000, 3000, 1150 -> the 4th answer is under the 1200 floor.
  const remaining = ['5000', '4000', '3000', '1150', '1100', '1000']
  const gh = makeGh({
    headers: {},
    stats,
    maxCalls: 9999,
    reserve: 1200,
    fetchImpl: async () => res(200, { 'x-ratelimit-remaining': remaining[fetched++] ?? '900' }),
    sleepImpl: noSleep,
  })
  for (let i = 0; i < 20; i++) await gh(`https://api.github.com/x/${i}`)

  assert.equal(fetched, 4, `expected to stop on the 4th answer, made ${fetched} calls`)
  ok('stands down as soon as the SHARED hour drops below the reserve floor')
  assert.equal(stats.lowestRemaining, 1150)
  ok('remembers the lowest remaining quota it saw, so the run log can show it')
  assert.ok(String(stats.stoppedBy).startsWith('reserve:'), `stoppedBy was ${stats.stoppedBy}`)
  ok('distinguishes the quota floor from its own per-run ceiling')
}

// ── 3. ONCE STOPPED, STAY STOPPED ──────────────────────────────────────────────────────────
// The sweep has three separate call sites inside nested loops. If a stop only skipped one call the
// loops would keep firing and the cap would leak.
{
  let fetched = 0
  const stats = freshStats()
  const gh = makeGh({
    headers: {},
    stats,
    maxCalls: 3,
    reserve: 0,
    fetchImpl: async () => { fetched++; return res(200, { 'x-ratelimit-remaining': '4999' }) },
    sleepImpl: noSleep,
  })
  for (let i = 0; i < 5; i++) await gh(`https://api.github.com/a/${i}`)
  const afterFirstLoop = fetched
  for (let i = 0; i < 100; i++) await gh(`https://api.github.com/b/${i}`)

  assert.equal(afterFirstLoop, 3)
  assert.equal(fetched, 3, `a later loop leaked ${fetched - 3} extra calls past the cap`)
  ok('a stopped sweep makes no further calls from any later loop')
  const stopped = await gh('https://api.github.com/c/1')
  assert.equal(stopped, null)
  ok('returns null rather than throwing, so the caller drains harmlessly')
}

// ── 4. THE CAP MUST NOT BE ABLE TO CERTIFY A CLEAN FLEET ───────────────────────────────────
// The whole point. An incomplete sweep that prints PASS is worse than one that fails, and it would
// be worst of all coming from the guard's own safety limit. check-ci-budget pushes a HARNESS
// failure whenever stoppedBy is set; this asserts the flag it keys on is actually set, and that a
// normal run leaves it null so the cap cannot fail an honest sweep.
{
  const stats = freshStats()
  const gh = makeGh({
    headers: {},
    stats,
    maxCalls: 2,
    reserve: 0,
    fetchImpl: async () => res(200, { 'x-ratelimit-remaining': '4999' }),
    sleepImpl: noSleep,
  })
  await gh('https://api.github.com/x/1')
  await gh('https://api.github.com/x/2')
  assert.equal(stats.stoppedBy, null, 'a sweep that fits inside the cap must not be flagged')
  ok('a sweep that fits inside the cap is NOT flagged (no false red)')
  await gh('https://api.github.com/x/3')
  assert.ok(stats.stoppedBy, 'the run that exceeded the cap must be flagged so it cannot PASS')
  ok('the run that exceeded the cap IS flagged, so check-ci-budget turns it into a HARNESS failure')
}

// ── 5. THE SHIPPED DEFAULTS, SIZED BOTH WAYS ───────────────────────────────────────────────
// Two failure modes, opposite directions, and a cap has to miss both:
//   too high -> it does not protect anything and 2026-08-29 happens again;
//   too low  -> an honest 7-day sweep goes red every time, and a gate that cries wolf gets
//               scrolled past, which is worse than no gate.
// So the defaults are asserted against the real worst case, not against a round number. A future
// edit that quietly raises the ceiling to clear a red run fails here instead of in production.
const A_SEVEN_DAY_SWEEP = 2400 // measured: ~one jobs call per run, ~2400 runs in 7 days
{
  let fetched = 0
  const stats = freshStats()
  const gh = makeGh({
    headers: {},
    stats,
    // no maxCalls / reserve: take whatever the module ships with
    fetchImpl: async () => { fetched++; return res(200, { 'x-ratelimit-remaining': '5000' }) },
    sleepImpl: noSleep,
  })
  for (let i = 0; i < 5000; i++) {
    if (stats.stoppedBy) break
    await gh(`https://api.github.com/x/${i}`)
  }
  assert.ok(
    fetched > A_SEVEN_DAY_SWEEP,
    `the default ceiling stops at ${fetched}, below the ~${A_SEVEN_DAY_SWEEP} a real 7-day sweep needs: every honest run would go red`,
  )
  ok(`the default ceiling (${fetched}) clears a real 7-day sweep, so an honest run is never failed by it`)
  assert.ok(
    fetched <= 3000,
    `the default ceiling is ${fetched}; above 3000 one run could take most of the shared 5000/hour`,
  )
  ok('the default ceiling still leaves the majority of a fresh hour unreachable by one run')
}

// ── 6. THE HOUR CAN NEVER REACH ZERO ───────────────────────────────────────────────────────
// The actual requirement, stated as the invariant rather than as a number: whatever the window,
// whatever the loop, a run using the shipped defaults stands down while calls are still left for
// everything else on the shared token. This is the assertion that fails if someone sets the
// reserve floor to 0 to make a red run go away.
{
  let fetched = 0
  let remaining = 5000
  const stats = freshStats()
  const gh = makeGh({
    headers: {},
    stats,
    fetchImpl: async () => { fetched++; remaining--; return res(200, { 'x-ratelimit-remaining': String(remaining) }) },
    sleepImpl: noSleep,
  })
  // A deliberately runaway sweep: far more work than any real window would produce.
  for (let i = 0; i < 20000; i++) {
    if (stats.stoppedBy) break
    await gh(`https://api.github.com/x/${i}`)
  }
  assert.ok(stats.stoppedBy, 'a runaway sweep must be stopped by something')
  assert.ok(remaining >= 1000, `the run drove the shared hour down to ${remaining}; it must leave at least 1000`)
  ok(`a runaway sweep stops with ${remaining} calls still on the shared hour - it cannot empty it`)
}

console.log(`\nci-budget call cap: ${pass}/${pass} checks passed`)
