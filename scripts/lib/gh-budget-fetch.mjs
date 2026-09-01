// The retry-and-attribution loop for check-ci-budget's GitHub calls, lifted OUT of the script so a
// test can drive it with a stubbed fetch and assert WHERE a burned-out call is counted. That
// attribution - a rate-limit give-up vs an API error - is the load-bearing behaviour the 3fd13c6
// fix corrected, and it lived inline at the call site where nothing could exercise it: the only
// test read the pure giveUpKind() helper, which is stateless and therefore true of the buggy code
// too, so a regression back to a run-global flag would have stayed green (the whole reason this
// file now exists). By returning its counts through a shared `stats` object instead of mutating
// module globals, the exact call-site path is now importable and testable.
import { giveUpKind } from './ci-budget-giveup.mjs'

// GitHub answers 403 to TWO different things: an emptied rate-limit hour, and "this token may not
// read this repo". A 403 is a rate limit ONLY on positive evidence: 429, a Retry-After, or
// remaining == 0. (Unchanged from the inline version; moved here with the loop it guards.)
export const isRateLimited = (r) =>
  r.status === 429 ||
  r.headers.get('retry-after') !== null ||
  (r.status === 403 && r.headers.get('x-ratelimit-remaining') === '0')

// Build the gh() the sweep uses. `stats` = { apiErrors, rateLimitGiveUps, quotaResetAt } is mutated
// in place, so the caller keeps the same run-wide totals it read as module globals before. fetchImpl,
// sleepImpl and now are injected so a test can drive the loop deterministically and without real
// waits; production passes none of them and gets the real fetch / setTimeout / Date.now.
// ── THE CALL CAP (2026-09-01) ───────────────────────────────────────────────────────────────
// The GitHub REST allowance is 5000 requests an hour and it is SHARED BY THE WHOLE FLEET - every
// repo, every workflow, every local script, all on the one token. A full 7-day sweep here needs
// roughly 2400 of them, so THREE dispatches of this guard in one night on 2026-08-29 took the
// fleet's allowance to 0/5000 and everything else that needed the API that hour simply stopped.
// This guard exists to protect a budget; it must not be the thing that spends one.
//
// Two independent limits, because they fail for different reasons:
//
//   maxCalls - an absolute ceiling on how many calls ONE run may make, whatever the quota says.
//              This is the one that stops a runaway loop or a window_days someone typed as 90.
//   reserve  - a floor under the SHARED remaining quota, read from x-ratelimit-remaining on the
//              live responses. This is the one that stops a legitimate sweep from taking the last
//              of an hour that other jobs are already halfway through consuming. A cap counted
//              only against our own calls cannot see that, which is exactly the "a limit is only
//              as real as the key it counts against" trap: the number that matters is what is
//              LEFT on the shared key, not how many we personally have spent.
//
// Hitting either does NOT return partial numbers as if they were complete. It sets stoppedBy, and
// check-ci-budget turns that into a HARNESS failure, so a capped run can never print PASS. An
// incomplete sweep reporting a clean fleet is the precise failure this whole checker exists to
// avoid, and it would be worse coming from its own safety limit.
export function makeGh({
  headers,
  stats,
  // SIZED AGAINST A LEGITIMATE SWEEP, not against a round number. A 7-day window - the default
  // for a manual dispatch - examines roughly 2400 runs and therefore needs roughly 2400 calls, so
  // a ceiling of 2200 would have turned every honest 7-day run red. A gate that goes red on a
  // healthy run is one people learn to scroll past, which is worse than not having it. 3000
  // leaves headroom above the real worst case while still being well under the 5000 hour, and
  // `reserve` is the limit that actually does the protecting.
  maxCalls = Number(process.env.CI_BUDGET_MAX_CALLS || 3000),
  reserve = Number(process.env.CI_BUDGET_RESERVE || 1200),
  fetchImpl = fetch,
  sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
}) {
  // Initialised here rather than assumed of the caller's object, so an older caller that passes
  // the original three-field stats still gets working counters instead of NaN.
  stats.calls ??= 0
  stats.stoppedBy ??= null
  stats.lowestRemaining ??= null
  return async function gh(url) {
    // Once stopped, STAY stopped. Returning null here costs nothing and keeps the sweep's own
    // loops (5 repo pages, 20 run pages per repo, one jobs call per run) draining harmlessly to
    // completion rather than needing a bail-out at each of the three call sites.
    if (stats.stoppedBy) return null
    if (stats.calls >= maxCalls) {
      stats.stoppedBy = `maxcalls:${maxCalls}`
      console.error(`  STOPPED: this run has made ${stats.calls} API calls, its cap. Nothing further will be requested.`)
      return null
    }
    stats.calls++
    // Per-CALL evidence of a rate limit, so the give-up attribution below cannot be tainted by some
    // OTHER call earlier in the sweep. quotaResetAt (the refill time) stays run-wide; only WHY this
    // particular call gave up is local to this call.
    let sawRateLimit = false
    for (let attempt = 0; attempt < 6; attempt++) {
      let r
      try {
        r = await fetchImpl(url, { headers })
      } catch {
        await sleepImpl(2000)
        continue
      }
      if (r.status === 403 || r.status === 429) {
        if (!isRateLimited(r)) {
          // Not a quota problem: sleeping cannot fix it and retrying only burns wall clock.
          stats.apiErrors++
          console.error(`  forbidden (not rate limited): ${url}`)
          return null
        }
        const retryAfter = Number(r.headers.get('retry-after') || 0) * 1000
        const reset = Number(r.headers.get('x-ratelimit-reset') || 0) * 1000
        sawRateLimit = true
        if (reset > stats.quotaResetAt) stats.quotaResetAt = reset
        const need = retryAfter || (reset ? reset - now() + 3000 : 0)
        // The cap stays: the job's own timeout-minutes is 60, so sleeping out a full hour would be
        // killed mid-sleep and report nothing at all. Give up instead, and say WHY below.
        const wait = Math.min(Math.max(5000, need), 180000)
        console.error(`  rate limited, waiting ${Math.round(wait / 1000)}s`)
        await sleepImpl(wait)
        continue
      }
      // The shared-quota floor. Read on every answered call, including 404s and errors, because
      // GitHub charges for those too and a sweep over a repo it cannot see would otherwise burn
      // the hour while never touching this check.
      const remainingHeader = r.headers.get('x-ratelimit-remaining')
      if (remainingHeader !== null && remainingHeader !== '') {
        const remaining = Number(remainingHeader)
        if (Number.isFinite(remaining)) {
          if (stats.lowestRemaining === null || remaining < stats.lowestRemaining) {
            stats.lowestRemaining = remaining
          }
          if (remaining < reserve) {
            stats.stoppedBy = `reserve:${remaining}<${reserve}`
            console.error(
              `  STOPPED: only ${remaining} calls left on the shared GitHub hour (floor ${reserve}). ` +
                'Leaving the rest for the fleet rather than emptying it.',
            )
            return null
          }
        }
      }
      if (r.status === 404) return null
      if (!r.ok) {
        if (r.status >= 500) {
          await sleepImpl(2000)
          continue
        }
        stats.apiErrors++
        return null
      }
      return r.json()
    }
    // Ran out of attempts. Attribute it to whichever cause THIS call actually observed - not to a
    // run-global that any earlier rate-limited call would have set (see lib/ci-budget-giveup.mjs).
    if (giveUpKind(sawRateLimit) === 'ratelimit') stats.rateLimitGiveUps++
    else stats.apiErrors++
    return null
  }
}
