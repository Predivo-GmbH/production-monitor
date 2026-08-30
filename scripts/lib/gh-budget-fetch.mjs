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
export function makeGh({
  headers,
  stats,
  fetchImpl = fetch,
  sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
}) {
  return async function gh(url) {
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
