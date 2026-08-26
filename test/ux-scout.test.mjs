/**
 * Unit tests for ux-scout's pure logic:
 *  - resolveProdRef(): the guard against the exact mistake this tool exists to not repeat,
 *    a whole analysis built on a STAGING ref that looked like production (2026-08-20).
 *  - classify():      authenticated user pain vs anonymous probe, and the dismissal filter.
 *  - buildDigest():   a quiet week must read as "correct answer", never as "broken run".
 * Run: node test/ux-scout.test.mjs   (exit 0 = all pass)
 */
import assert from 'node:assert'
import { resolveProdRef, classify, dismissKey, buildDigest, verdict, escapeLiteral, SOURCES_FOR_TEST } from '../scripts/ux-scout.mjs'

let n = 0
const t = (name, fn) => { fn(); n++; console.log(`  ok - ${name}`) }

// ── resolveProdRef ──────────────────────────────────────────────────────────────
// Shape taken verbatim from replyflow/.github/workflows/deploy.yml (staging step first,
// production step later), the ordering that made the staging ref look authoritative.
const REALISTIC_YML = `
jobs:
  staging:
    steps:
      - name: Deploy edge functions to staging
        run: |
          if supabase functions deploy $FNS --project-ref cuvqzwvyovxvvvuddtjd --use-api; then
            echo ok
          fi
  production:
    steps:
      - name: Deploy edge functions to production
        run: |
          if supabase functions deploy $FNS --project-ref dqmhsdzldkxngwjrxois --use-api; then
            echo ok
          fi
`

t('picks the PRODUCTION ref, not the staging one that appears first', () => {
  assert.equal(resolveProdRef(REALISTIC_YML), 'dqmhsdzldkxngwjrxois')
})

t('matches the SignalScore step wording ("Deploy ALL edge functions to PRODUCTION")', () => {
  const yml = `
      - name: Deploy edge functions to staging
        run: supabase functions deploy --project-ref blfnyxwcriyxvsaubiqb --use-api
      - name: Deploy ALL edge functions to PRODUCTION
        run: supabase functions deploy --project-ref ogdpgufptemcgyszmjek --use-api
`
  assert.equal(resolveProdRef(yml), 'ogdpgufptemcgyszmjek')
})

t('falls back to the LAST ref when no step name says production (prod job is always later)', () => {
  const yml = `
      - name: Deploy to the mirror
        run: supabase functions deploy --project-ref aaaaaaaaaaaaaaaaaaaa --use-api
      - name: Deploy to the live site
        run: supabase functions deploy --project-ref bbbbbbbbbbbbbbbbbbbb --use-api
`
  assert.equal(resolveProdRef(yml), 'bbbbbbbbbbbbbbbbbbbb')
})

t('returns null rather than guessing when the file has no ref at all', () => {
  assert.equal(resolveProdRef('jobs:\n  build:\n    steps:\n      - run: npm ci\n'), null)
})

t('never returns a ref that is not 20 chars (would silently query the wrong project)', () => {
  const yml = '      - name: production\n        run: supabase functions deploy --project-ref short --use-api\n'
  assert.equal(resolveProdRef(yml), null)
})

// ── classify ────────────────────────────────────────────────────────────────────
const row = (over = {}) => ({
  function_name: 'generate-reply', operation: 'claude-call', message_pattern: 'Missing reviewId',
  occurrences: 339, distinct_users: 0, authenticated: false,
  first_seen: '2026-08-06T00:00:00Z', last_seen: '2026-08-20T00:00:00Z', sample_evidence: {}, ...over,
})

t('a failure with a caller identity is USER PAIN, however few the occurrences', () => {
  const c = classify([row({ occurrences: 1, distinct_users: 1, authenticated: true })])
  assert.equal(c.authenticated.length, 1)
  assert.equal(c.anonymous.length, 0)
})

t('a high-volume failure with NO caller identity is a probe, not user pain', () => {
  const c = classify([row({ occurrences: 339, authenticated: false })])
  assert.equal(c.authenticated.length, 0)
  assert.equal(c.anonymous.length, 1)
})

t('volume never promotes a probe over a single real user', () => {
  const c = classify([
    row({ message_pattern: 'Missing authorization header', occurrences: 338, authenticated: false }),
    row({ message_pattern: 'Review not found', occurrences: 1, distinct_users: 1, authenticated: true }),
  ])
  assert.equal(c.authenticated.length, 1)
  assert.equal(c.authenticated[0].message_pattern, 'Review not found')
})

t('a pattern a human already judged is not re-surfaced WHILE IT STAYS ANONYMOUS', () => {
  // Was written as "never re-surfaced" and used an authenticated row. That encoded a real
  // flaw, corrected 2026-08-20: dismissals are almost always "unauthenticated probe", a
  // judgement that only holds while the pattern remains anonymous. See the reopen tests below.
  const r = row({ authenticated: false })
  const dismissed = new Set([dismissKey({ product: 'replyflow', ...r })])
  const c = classify([r], { dismissed, product: 'replyflow' })
  assert.equal(c.authenticated.length, 0)
  assert.equal(c.skipped.length, 1)
})

t('the dismissal key is per-product, so one product\'s judgement cannot mute another', () => {
  const r = row({ authenticated: true })
  const dismissed = new Set([dismissKey({ product: 'channelmover', ...r })])
  const c = classify([r], { dismissed, product: 'replyflow' })
  assert.equal(c.authenticated.length, 1, 'replyflow must still report it')
})

// ── buildDigest ─────────────────────────────────────────────────────────────────
t('a quiet week reads as the correct answer, not as a broken run', () => {
  const d = buildDigest([{ product: 'replyflow', table: 'error_log', ref: 'x', authenticated: [], anonymous: [], skipped: [] }], 7)
  assert.match(d, /That is the correct answer, not a broken run/)
})

t('probes are shown but labelled, never counted as user findings', () => {
  const d = buildDigest([{
    product: 'replyflow', table: 'error_log', ref: 'x', contextFixed: true,
    authenticated: [], anonymous: [row({ occurrences: 338 })], skipped: [],
  }], 7)
  assert.match(d, /\[probe\] 338 anonymous occurrence/)
  assert.doesNotMatch(d, /\[USER\]/)
})

t('a product that still double-encodes context is flagged as UNKNOWN, not proven-bot', () => {
  const d = buildDigest([{
    product: 'channelmover', table: 'error_log', ref: 'x', contextFixed: false,
    authenticated: [], anonymous: [row({ occurrences: 5 })], skipped: [],
  }], 7)
  assert.match(d, /means UNKNOWN, not proven-bot/)
})

t('an unreadable source is reported, never silently dropped', () => {
  const d = buildDigest([{ product: 'signalscore', table: 'api_request_logs', ref: 'x', error: 'query HTTP 401', authenticated: [], anonymous: [], skipped: [] }], 7)
  assert.match(d, /READ FAILED: query HTTP 401/)
})

// -- Measured -------------------------------------------------------------------
// This is the step that separates "the change was made" from "the problem stopped".
t('zero occurrences since the fix is GONE', () => {
  assert.equal(verdict(339, 0), 'gone')
})

t('a large drop is REDUCED, not gone (honest about a partial fix)', () => {
  assert.equal(verdict(100, 10), 'reduced')
})

t('a small drop is UNCHANGED, so a fix cannot claim credit for noise', () => {
  assert.equal(verdict(100, 90), 'unchanged')
})

t('more than before is WORSE, so a regression is named, not buried', () => {
  assert.equal(verdict(10, 25), 'worse')
})

t('exactly half is UNCHANGED, not reduced (the boundary is strict)', () => {
  assert.equal(verdict(100, 50), 'unchanged')
})

t('a measured verdict appears in the digest with both numbers', () => {
  const d = buildDigest(
    [{ product: 'replyflow', table: 'error_log', ref: 'x', authenticated: [], anonymous: [], skipped: [] }], 7,
    [{ product: 'replyflow', function_name: 'connect-platform', message_pattern: 'No stored tokens',
       occurrences: 38, after: 0, verdictResult: 'gone', state_changed_at: '2026-08-13T00:00:00Z' }],
  )
  assert.match(d, /GONE: replyflow\/connect-platform/)
  assert.match(d, /38 before the fix, 0 since/)
})

t('an apostrophe in a pattern cannot break the measurement query', () => {
  assert.equal(escapeLiteral("user's session"), "'user''s session'")
})

// -- coverage honesty ------------------------------------------------------------
// A scout that says "fleet-wide" while silently reading a third of the fleet manufactures
// false confidence. Coverage and non-coverage must both be stated every single week.
t('the digest states how many products were actually read', () => {
  const d = buildDigest([
    { product: 'replyflow', table: 'error_log', ref: 'x', authenticated: [], anonymous: [], skipped: [] },
    { product: 'valrano', table: 'error_log', ref: 'y', authenticated: [], anonymous: [], skipped: [] },
  ], 7)
  assert.match(d, /Coverage: 2 product\(s\) read\./)
})

t('an unreadable source is counted in the coverage line, not hidden', () => {
  const d = buildDigest([
    { product: 'replyflow', table: 'error_log', ref: 'x', authenticated: [], anonymous: [], skipped: [] },
    { product: 'valrano', table: 'error_log', ref: 'y', error: 'privileges', authenticated: [], anonymous: [], skipped: [] },
  ], 7)
  assert.match(d, /1 UNREADABLE/)
})

t('coverage is stated even when nothing is skipped', () => {
  // The NOT_COVERED list is empty since 2026-08-20 (every product with edge functions was
  // instrumented rather than excused). The digest must still SAY so; going quiet about
  // coverage is how a silent cap creeps back in.
  const d = buildDigest([{ product: 'replyflow', table: 'error_log', ref: 'x', authenticated: [], anonymous: [], skipped: [] }], 7)
  assert.match(d, /NOT watched|Nothing is skipped/)
})

t('backoffice is WATCHED, not excluded as an internal tool', () => {
  // Regression guard. It was excluded in the first build on the reasoning "its only user is
  // Roger", which hid 21 live Smartlead "Plan expired!" 401s. There is always a user.
  assert.ok(SOURCES_FOR_TEST.some((x) => x.product === 'backoffice'))
})

t('arivioo resolves its prod ref from an audited source, not a deploy.yml it does not have', () => {
  // arivioo ships over FTP and has no .github/workflows/deploy.yml, so resolveProdRef() hit
  // ENOENT every run and its prod error_log went unread (incident 2026-08-26). It must carry
  // an explicit, audited ref instead — and it must be PROD, never the staging ref that also
  // lives in its credentials file.
  const a = SOURCES_FOR_TEST.find((x) => x.product === 'arivioo')
  assert.ok(a.ref && a.ref.value, 'arivioo must carry an explicit audited ref')
  assert.equal(a.ref.value, 'iooexkbuxmeryeuzpxau', 'must be the PROD ref')
  assert.notEqual(a.ref.value, 'xyqdyqpdjugevjmjbcdp', 'must not be the arivioo STAGING ref')
  assert.match(a.ref.because, /Credentials\.txt/)
})

t('the "nothing is skipped" reassurance never renders while a source is UNREADABLE', () => {
  // The report may not read as full coverage while a product could not be read at all;
  // that contradiction (blind spot rendered as reassurance) is what the incident was.
  const d = buildDigest([
    { product: 'replyflow', table: 'error_log', ref: 'x', authenticated: [], anonymous: [], skipped: [] },
    { product: 'arivioo', table: 'error_log', ref: 'y', error: 'ENOENT deploy.yml', authenticated: [], anonymous: [], skipped: [] },
  ], 7)
  assert.doesNotMatch(d, /Nothing is skipped/)
  assert.match(d, /blind spot/i)
  assert.match(d, /arivioo/)
})

t('the blind-spot warning still renders when NOT_COVERED is non-empty', () => {
  // Regression guard for the else-if chain (commit 7c5434a) that made the blind-spot line
  // mutually exclusive with the not-watched list: while NOT_COVERED held any product, an
  // unreadable source printed NO blind-spot disclosure and the digest read as full coverage.
  // The three earlier blind-spot tests all run against the currently-EMPTY NOT_COVERED, so
  // they cannot see this case; inject a non-empty list here to prove both lines coexist.
  const d = buildDigest([
    { product: 'replyflow', table: 'error_log', ref: 'x', authenticated: [], anonymous: [], skipped: [] },
    { product: 'arivioo', table: 'error_log', ref: 'y', error: 'ENOENT deploy.yml', authenticated: [], anonymous: [], skipped: [] },
  ], 7, [], [['scoutcopilot', 'no error-log helper in the repo']])
  assert.match(d, /NOT watched/)
  assert.match(d, /scoutcopilot/)
  assert.match(d, /blind spot/i)
  assert.match(d, /arivioo/)
  assert.doesNotMatch(d, /Nothing is skipped/)
})

t('with every source read, the full-coverage line is allowed again', () => {
  const d = buildDigest([{ product: 'replyflow', table: 'error_log', ref: 'x', authenticated: [], anonymous: [], skipped: [] }], 7)
  assert.match(d, /Nothing is skipped/)
})

t('every product with a failure table is watched, none silently dropped', () => {
  const want = ['replyflow', 'channelmover', 'signalscore', 'arivioo', 'valrano', 'backoffice',
                'scoutcopilot', 'distribution-os', 'launchready']
  for (const p of want) assert.ok(SOURCES_FOR_TEST.some((x) => x.product === p), `${p} must be watched`)
})

// -- a dismissal must not become a blind spot -------------------------------------
// Almost every dismissal reads "unauthenticated probe, has_auth=false on every occurrence".
// That is only true while the pattern STAYS anonymous. If it later hits a signed-in user it
// is no longer a probe, it is exactly the user pain this tool exists to find.

t('a dismissed pattern that is STILL anonymous stays skipped', () => {
  const r = row({ authenticated: false })
  const c = classify([r], { dismissed: new Set([dismissKey({ product: 'replyflow', ...r })]), product: 'replyflow' })
  assert.equal(c.skipped.length, 1)
  assert.equal(c.authenticated.length, 0)
})

t('a dismissed pattern that now hits a REAL USER is REOPENED, not skipped', () => {
  const r = row({ authenticated: true, distinct_users: 2 })
  const c = classify([r], { dismissed: new Set([dismissKey({ product: 'replyflow', ...r })]), product: 'replyflow' })
  assert.equal(c.skipped.length, 0, 'must not be silently skipped')
  assert.equal(c.reopened.length, 1)
  assert.equal(c.authenticated[0].reopenedFromDismissal, true)
})

t('a reopened finding is LABELLED so the old judgement is not inherited', () => {
  const d = buildDigest([{
    product: 'replyflow', table: 'error_log', ref: 'x', contextFixed: true,
    authenticated: [row({ authenticated: true, distinct_users: 2, reopenedFromDismissal: true })],
    anonymous: [], skipped: [],
  }], 7)
  assert.match(d, /REOPENED/)
  assert.match(d, /PREVIOUSLY DISMISSED as anonymous/)
})

console.log(`\n${n} tests passed`)
