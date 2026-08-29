// Classifies WHY the CI-runner watchdog could not complete, so the alert stops telling Roger to
// rotate the DASHBOARD_PAT for every possible failure. It had misattributed the cause three times:
// a 403 rate-limit reads to a naive check exactly like a 403 auth failure, and the watchdog's own
// bail messages contain the word "token", so the "renew the token" copy fired on failures that had
// nothing to do with the token.
//
// Three outcomes, because the right advice differs for each:
//   'ratelimit' - the shared GitHub API hour was emptied (403 + x-ratelimit-remaining:0, or the
//                 body "API rate limit exceeded"). The token is VALID; an invalid token could not
//                 have read the API at all. Do NOT rotate - it self-heals at the reset.
//   'auth'      - a genuine 401/403 auth/scope failure: an expired or descoped token. Rotate it.
//   'other'     - a crash, timeout, dropped socket, or a batch of failed API calls. Read the logs.
//
// Rate-limit MUST win over 'auth' even though a rate-limit reason mentions "token" (it says "the
// token is valid"): the misfire this exists to stop is precisely the auth heuristic tripping on an
// incidental "token" or "403" inside a message that is really about the rate limit.
export function classifyWatchdogFailure(reason) {
  const s = String(reason ?? '')
  if (/rate[\s-]?limit|x-ratelimit|secondary rate/i.test(s)) return 'ratelimit'
  if (/\b(401|403)\b|token|scope|unauthor|forbidden|permission|administration/i.test(s)) return 'auth'
  return 'other'
}
