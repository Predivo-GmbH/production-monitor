// Which counter a check-ci-budget call belongs to once it has burned all six of its retries. The
// decision is PER CALL: its only input is whether THIS call itself was ever rate-limited. By
// construction it cannot see any run-global state, which is the whole point of the fix.
//
// The bug this ends (commit 3fd13c6): the give-up was attributed with `if (quotaResetAt)`, a
// module-level global set once by ANY call that ever saw a rate limit and never cleared. So after a
// single transient rate-limited call - which a full ~2400-call sweep routinely causes against the
// 5000/hour limit, and which the guard's own alert text calls routine - every LATER call that
// exhausted its retries on repeated 5xx or on network errors was miscounted as a quota give-up. The
// run then emitted only the "the GitHub API hour ran out ... re-run after the reset" line and never
// the apiErrors line, so a GitHub outage or a network fault was reported as a scheduling problem
// with a wait-it-out remedy, and re-running after the reset reproduced the same failure - the exact
// misdiagnosis loop 3fd13c6 was written to end.
//
// quotaResetAt itself stays global on purpose: the refill timestamp in the alert is legitimately
// run-wide. Only the give-up ATTRIBUTION is per-call.
export const giveUpKind = (sawRateLimit) => (sawRateLimit ? 'ratelimit' : 'api')
