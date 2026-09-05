import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classify, indexFingerprints, indexHints, normalizeName, matchByHint, isReportable, isReportableHostname,
  orphanBlockers, clearedFindings, findingRepos,
} from '../scripts/scan-external-tools.mjs'

// Tests for the pure half of the external-tools discovery scan.
// Plan: Cockpit/docs/PLAN-EXTERNAL-TOOLS-PAGE-2026-08-27.md
//
// Every case below is a real shape taken from the fleet, not an invented one — the calibration
// trail (BackOffice migrations 143 -> 147) went from 289 unrecognised fingerprints to 0, and
// these lock in the rules that got it there so a later "simplification" cannot quietly undo it.

const SENTRY = 'tool-sentry'
const SUPA = 'tool-supabase'
const ANTHROPIC = 'tool-anthropic'

const rows = [
  { id: 'f1', api_entry_id: SENTRY, kind: 'gha_secret', pattern: 'SENTRY_AUTH_TOKEN' },
  { id: 'f2', api_entry_id: SENTRY, kind: 'env_var', pattern: 'SENTRY_DSN' },
  { id: 'f3', api_entry_id: SUPA, kind: 'env_var', pattern: 'SUPABASE_URL' },
  { id: 'f4', api_entry_id: ANTHROPIC, kind: 'env_var', pattern: 'ANTHROPIC_API_KEY' },
  { id: 'f5', api_entry_id: null, kind: 'env_var', pattern: 'CRON_SECRET' },
  { id: 'h1', api_entry_id: SUPA, kind: 'name_contains', pattern: 'SUPABASE' },
  { id: 'h2', api_entry_id: SUPA, kind: 'name_contains', pattern: 'ANON' },
  { id: 'h4', api_entry_id: SUPA, kind: 'name_contains', pattern: 'ROLE' },
  { id: 'h3', api_entry_id: SENTRY, kind: 'name_contains', pattern: 'SENTRY' },
]
const known = indexFingerprints(rows)
const hints = indexHints(rows)
const run = (fps) => classify(fps, known, hints)
const fp = (kind, pattern, repo = 'r', path = 'p') => ({ kind, pattern, repo, path })

test('a workflow secret and an env var share one namespace', () => {
  // The first real run reported ANTHROPIC_API_KEY as unregistered purely because it was stored
  // as an env_var fingerprint and used as a workflow secret. The NAME identifies the vendor.
  const { sites, unknown } = run([fp('gha_secret', 'ANTHROPIC_API_KEY')])
  assert.equal(unknown.length, 0)
  assert.equal(sites[0].api_entry_id, ANTHROPIC)
})

test('framework and environment decoration is stripped on the second attempt', () => {
  for (const token of ['VITE_SENTRY_DSN', 'NEXT_PUBLIC_SENTRY_DSN', 'STAGING_SENTRY_DSN', 'EXPO_PUBLIC_SENTRY_DSN']) {
    const { sites, unknown } = run([fp('env_var', token)])
    assert.equal(unknown.length, 0, `${token} should resolve`)
    assert.equal(sites[0].api_entry_id, SENTRY)
  }
})

test('a PRODUCT prefix is never stripped', () => {
  // Stripping VALRANO_ would attribute one product's credential to another. Unmatched is a
  // visible question; wrongly matched is an invisible wrong answer.
  assert.equal(normalizeName('VALRANO_SUPABASE_URL'), 'VALRANO_SUPABASE_URL')
  assert.equal(normalizeName('VITE_SUPABASE_URL'), 'SUPABASE_URL')
})

test('the hint tier resolves a credential whose name never says the vendor', () => {
  const { sites, unknown } = run([fp('env_var', 'SIGNALSCORE_SERVICE_ROLE_KEY'), fp('gha_secret', 'REPLYFLOW_ANON_KEY')])
  assert.equal(unknown.length, 0)
  assert.deepEqual([...new Set(sites.map((s) => s.api_entry_id))], [SUPA])
})

test('two tools claiming the same token attributes NOTHING', () => {
  // The tie rule is what makes the hint tier safe to use at all.
  const tie = [...rows, { id: 'h9', api_entry_id: ANTHROPIC, kind: 'name_contains', pattern: 'ANON' }]
  const got = matchByHint('SOME_ANON_KEY', indexHints(tie))
  assert.equal(got, null)
})

test('the ignore list produces neither a site nor a finding', () => {
  const { sites, unknown } = run([fp('env_var', 'CRON_SECRET')])
  assert.equal(sites.length, 0)
  assert.equal(unknown.length, 0)
})

test('an unknown token becomes exactly one finding, with every path it was seen at', () => {
  const { unknown } = run([
    fp('env_var', 'BRAND_NEW_VENDOR_KEY', 'repoA', 'a.ts'),
    fp('env_var', 'BRAND_NEW_VENDOR_KEY', 'repoB', 'b.ts'),
  ])
  assert.equal(unknown.length, 1)
  assert.equal(unknown[0].pattern, 'BRAND_NEW_VENDOR_KEY')
  assert.deepEqual([...unknown[0].paths].sort(), ['repoA/a.ts', 'repoB/b.ts'])
})

test('the same tool in the same file is one usage site, not many', () => {
  const { sites } = run([
    fp('env_var', 'SUPABASE_URL', 'r', 'x.ts'),
    fp('env_var', 'SUPABASE_URL', 'r', 'x.ts'),
    fp('gha_secret', 'SUPABASE_URL', 'r', 'x.ts'),
  ])
  assert.equal(sites.length, 1)
})

test('only endpoint-shaped hostnames are worth reporting', () => {
  // Otherwise every MDN and RFC link in the codebase becomes a finding and the list is unusable.
  assert.equal(isReportableHostname('api.newvendor.com'), true)
  assert.equal(isReportableHostname('app.newvendor.io'), true)
  assert.equal(isReportableHostname('developer.mozilla.org'), false)
  assert.equal(isReportableHostname('www.w3.org'), false)
  assert.equal(isReportableHostname('xyz.supabase.co'), false)      // covered by the Supabase row
})

test('RFC-reserved example/test hostnames are never a vendor, even when endpoint-shaped', () => {
  // app.example.com is the textbook placeholder — endpoint-shaped, so the app./api. rule would
  // otherwise report it. It can never resolve to a real service, and no tools-list row could
  // ever clear the finding, so it must not be reportable in the first place.
  assert.equal(isReportableHostname('app.example.com'), false)
  assert.equal(isReportableHostname('api.example.org'), false)
  assert.equal(isReportableHostname('example.com'), false)
  assert.equal(isReportableHostname('app.acme.test'), false)
  assert.equal(isReportableHostname('api.internal.localhost'), false)
  assert.equal(isReportableHostname('server.dev.invalid'), false)
  assert.equal(isReportableHostname('localhost'), false)
  // A real vendor whose name merely CONTAINS "example" as a label is still reported.
  assert.equal(isReportableHostname('api.example-vendor.com'), true)
})

test('npm packages never raise a finding, env vars and secrets always do', () => {
  assert.equal(isReportable({ kind: 'npm_package', pattern: 'left-pad' }), false)
  assert.equal(isReportable({ kind: 'env_var', pattern: 'NEW_THING_KEY' }), true)
  assert.equal(isReportable({ kind: 'gha_secret', pattern: 'NEW_THING_KEY' }), true)
})

// ── the anti-rot guard ──────────────────────────────────────────────────────
// Proven against staging on 2026-08-27 by defect injection in BOTH directions: ageing every
// scan timestamp by 48h flipped the check to a warning and 31 tools to "stale" in the view;
// re-running the scan cleared both. These lock the threshold in.
const { judge } = await import('../scripts/check-external-tools-freshness.mjs')

test('a scan that has never run is stale', () => {
  assert.equal(judge(null).stale, true)
})

test('inside the window is fresh, past it is stale, and the page uses the same 36h', () => {
  const now = Date.parse('2026-08-27T12:00:00Z')
  assert.equal(judge('2026-08-27T06:00:00Z', now).stale, false)   // 6h
  assert.equal(judge('2026-08-26T04:00:00Z', now).stale, false)   // 32h, still inside
  assert.equal(judge('2026-08-25T20:00:00Z', now).stale, true)    // 40h
})

// ── the absence guard ───────────────────────────────────────────────────────
// The 2026-08-31 false alarm: the page said "Nothing uses Zyte any more", the same for
// Browserless and the Google Search Console API. All three were live. The one thing those
// three shared was that each lives in exactly ONE repo — arivioo or pull-engine — and the host
// running the daily scan has neither checked out. The repo-COUNT floor cleared comfortably
// while the two repos that decided the answer were missing. These lock in the per-tool test.
const FLEET = new Set(['BackOffice', 'ChannelMover', 'replyflow', 'signalscore', 'Cockpit', 'production-monitor'])

test('a tool whose only repo was not scanned gets NO orphan verdict', () => {
  assert.deepEqual(orphanBlockers(new Set(['arivioo']), FLEET), ['arivioo'])
  assert.deepEqual(orphanBlockers(new Set(['pull-engine']), FLEET), ['pull-engine'])
})

test('a tool whose repos were all scanned CAN be judged', () => {
  assert.deepEqual(orphanBlockers(new Set(['BackOffice', 'Cockpit']), FLEET), [])
})

test('one missing repo out of several is still enough to withhold the verdict', () => {
  // Half a tool's usage sites being visible is the most dangerous case: it looks like partial
  // decommissioning and reads as evidence. It is not — the rest may be in the missing repo.
  assert.deepEqual(orphanBlockers(new Set(['BackOffice', 'arivioo']), FLEET), ['arivioo'])
})

test('missing repos are reported by name, sorted, so the log says WHERE it could not look', () => {
  assert.deepEqual(orphanBlockers(new Set(['pull-engine', 'arivioo', 'Valrano']), FLEET),
    ['Valrano', 'arivioo', 'pull-engine'])
})

test('a tool with no recorded usage sites is not blocked by this rule', () => {
  // It is held back by the separate `last_seen_in_code_at` test instead; this rule must not
  // silently become a second, permanent veto on every tool the scan has never matched.
  assert.deepEqual(orphanBlockers(undefined, FLEET), [])
  assert.deepEqual(orphanBlockers(new Set(), FLEET), [])
})

test('the exact 2026-08-31 false alarm cannot be filed again', () => {
  // The real recorded state: these are the only repos each of the three was ever seen in.
  const prior = { Zyte: new Set(['arivioo']), Browserless: new Set(['arivioo']), 'Google Search Console API': new Set(['pull-engine']) }
  const hostWithoutThem = new Set([...FLEET, 'Valrano', 'BoatBuddy', 'predivo', 'launchready',
    'Distribution-OS', 'ScoutCopilot', 'gate-kit', 'ci-runner', 'standards', 'APIs'])   // 16 repos: clears the count floor
  assert.ok(hostWithoutThem.size >= 14, 'the false-alarm host clears the repo-count floor')
  for (const [tool, repos] of Object.entries(prior)) {
    assert.ok(orphanBlockers(repos, hostWithoutThem).length > 0, `${tool} must not be judged on this host`)
  }
  // ...and on a complete checkout the scan regains its opinion.
  const complete = new Set([...hostWithoutThem, 'arivioo', 'pull-engine'])
  for (const repos of Object.values(prior)) assert.deepEqual(orphanBlockers(repos, complete), [])
})

// ── recovery: the half the scanner did not have until 2026-09-02 ────────────────────────────
// Three findings (BOARD_URL, BOARD_KEY, ALERT_EMAIL — our own board and our own alert address)
// sat `confirmed` on the External Tools page with three `open` rows on /signals, and nothing in
// this file could ever take them back. Registering or ignoring a token is the DESIGNED remedy and
// it closed nothing. These lock the recovery in, including the case where it must REFUSE to.

const openFinding = (over) => ({
  id: 'x', kind: 'unregistered', fingerprint: 'BOARD_URL', state: 'confirmed', seen_count: 2,
  evidence: { kind: 'gha_secret', paths: ['Cockpit/.github/workflows/morning-report.yml'] }, ...over,
})

test('a token that is no longer unrecognised clears its finding', () => {
  const cleared = clearedFindings([openFinding()], [], new Set(), new Set(['Cockpit', 'production-monitor']))
  assert.deepEqual(cleared.map((f) => f.fingerprint), ['BOARD_URL'])
})

test('a token still unrecognised this run is NOT cleared', () => {
  const cleared = clearedFindings([openFinding()], [{ pattern: 'BOARD_URL' }], new Set(), new Set(['Cockpit']))
  assert.deepEqual(cleared, [])
})

test('a finding is never cleared by a run that did not walk its repo', () => {
  // The 2026-08-31 orphan false alarm, re-run against the recovery path: a host without the repo
  // would otherwise "fix" every finding in it just by not looking. Absence is only evidence when
  // you looked where the thing was.
  const cleared = clearedFindings([openFinding()], [], new Set(), new Set(['production-monitor']))
  assert.deepEqual(cleared, [], 'Cockpit was not scanned, so this run has no opinion about it')
})

test('a finding that remembers no repo is never cleared', () => {
  const cleared = clearedFindings([openFinding({ evidence: {} })], [], new Set(), new Set(['Cockpit']))
  assert.deepEqual(cleared, [], '"I cannot tell where it was" is not "it is gone"')
})

test('a resolved or ignored finding is left exactly where a human put it', () => {
  for (const state of ['resolved', 'ignored']) {
    assert.deepEqual(clearedFindings([openFinding({ state })], [], new Set(), new Set(['Cockpit'])), [])
  }
})

test('an orphaned tool referenced again is cleared, and one still absent is not', () => {
  const orphan = { id: 'o', kind: 'orphaned', fingerprint: 'Zyte', api_entry_id: 'tool-zyte', state: 'confirmed', evidence: {} }
  assert.deepEqual(clearedFindings([orphan], [], new Set(['tool-zyte']), new Set()).map((f) => f.fingerprint), ['Zyte'])
  assert.deepEqual(clearedFindings([orphan], [], new Set(), new Set()), [])
})

test('findingRepos reads the repo out of a "<repo>/<path>" evidence line', () => {
  assert.deepEqual(findingRepos({ evidence: { paths: ['Cockpit/.github/workflows/a.yml', 'Cockpit/b.yml', 'replyflow/c.yml'] } }),
    ['Cockpit', 'replyflow'])
  assert.deepEqual(findingRepos({}), [])
})
