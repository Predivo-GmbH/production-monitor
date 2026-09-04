/**
 * THE SUITE FOR THE JOB THAT CLOSES OTHER PEOPLE'S WORK.
 *
 * scripts/close-finished-items.mjs is the highest-consequence script in this repository. Every
 * other check in here can, at worst, fail to tell somebody something. This one WRITES: a blind
 * evaluator does not merely stay quiet, it marks finished work that is not finished, and the
 * evidence trail it leaves behind says a machine checked.
 *
 * The failure it must be impossible to ship is therefore not "it closed the wrong item". It is:
 *
 *     THE DEPENDENCY STOPPED ANSWERING AND EVERY ROW CLOSED ANYWAY.
 *
 * That is not hypothetical, it is arithmetic. `query_returns_no_rows` passes on an EMPTY answer,
 * and a revoked grant, a renamed table, a wrong project ref, a rotated token and an intercepted
 * fetch all produce exactly an empty answer over HTTP 200. Eight jobs in this repo were caught
 * reporting success while blind on 2026-09-02 and six more on 2026-09-03 — none of them could
 * write. This one can.
 *
 * ── HOW THIS SUITE IS BUILT ──────────────────────────────────────────────────────────────────
 *
 * DEFECT INJECTION, not assertion counting. Every dependency of every kind is broken five ways —
 * netdown, unauth (401), server error (500), empty200, and a 200 carrying the wrong SHAPE — and
 * the assertion is the same each time and made twice over:
 *
 *   1. the finding is `unknown`, never pass and never fail; and
 *   2. `sweep()` offered NOTHING to the board — proved by a spy that records every call, so
 *      "closes nothing" is a measured fact about the code path and not a claim about a verdict.
 *
 * The fifth fault is the one worth naming. `empty200` is how the repo's own guard breaks a
 * dependency, and for four of these six kinds it produces a plainly wrong-shaped answer that any
 * reasonable code rejects. For `query_returns_no_rows` it produces THE PASSING ANSWER. The two
 * sentinels in the script exist for exactly that, and the two tests marked THE ONE THAT MATTERS
 * below are the ones that would go red if either sentinel were removed.
 *
 * Run: node test/close-finished-items.test.mjs   (exit 0 = all pass)
 */
import assert from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, parse, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// THE FILESYSTEM ROOT OF WHATEVER MACHINE IS RUNNING THIS (added 2026-09-03).
// 'C:/' on Windows, '/' on Linux. Every absolute fixture path below is built from it.
// It used to be a hardcoded Windows path throughout, which meant the whole
// suite could only ever pass on one developer's desktop: on the Linux runner 'C:/Business/...'
// is not an absolute path at all, so any containment check against it fails. Master was red on
// EVERY run from 09:10Z on 2026-09-03 for exactly this, and fixing only the first failing case
// simply revealed the next one - the suite stops at the first failure, so they hide behind
// each other. This closes the class rather than the instance.
const ROOT = parse(resolve('.')).root.replace(/\\/g, '/')
const PROJECTS = `${ROOT}Business/Internal Projects`

import {
  ACTIONABLE_STATUSES, UNTOUCHABLE_STATUSES, KINDS, SKIP,
  parseDoneWhen, evaluateDoneWhen, sweep, selectItems, verdict, receiptFor, offerToBoard,
  sqlIsReadOnly, testPathIsRunnable, testRoots, sentryStatusIsSettled, isDryRun, closureCap,
  loadBoardCredentials, boardProjectRef, SENTRY_ISSUE_PATHS, isOwedToRoger, silentRowsInHisLane, selfDocumentingRef, evaluationStamp, recordEvaluations,
} from '../scripts/close-finished-items.mjs'
import { PASS, FAIL, UNKNOWN, reportedPass, VERDICT_MARKER } from '../scripts/lib/check-verdict.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const SCRIPT = join(REPO, 'scripts', 'close-finished-items.mjs')

let n = 0
const pending = []
const t = (name, fn) => { fn(); n++; console.log(`  ok - ${name}`) }
const ta = (name, fn) => {
  const p = (async () => { await fn(); n++; console.log(`  ok - ${name}`) })()
  pending.push(p)
  return p
}

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────

const item = (o = {}) => ({
  id: 'aaaaaaaa-0000-0000-0000-000000000001', slug: 'a-real-item', title: 'A real item',
  status: 'next', documentation_ref: `${PROJECTS}/production-monitor/package.json`,
  done_when: null, opened_at: '2026-08-01T00:00:00Z', started_at: null, claim_paths: [], ...o,
})

/** A finish-test of each kind, in the nested `args` spelling. */
const DW = {
  sentry: { kind: 'sentry_resolved', args: { issue_id: '141893005' } },
  query: { kind: 'query_returns_no_rows', args: { sql: 'select id from work_items where status = \'stuck\'', project_ref: 'xoecpzfsskalvjrtcbbl' } },
  url: { kind: 'url_answers', args: { url: 'https://cockpit.predivo.ch/signals', status: 200 } },
  test: { kind: 'test_exits_zero', args: { path: `${PROJECTS}/production-monitor/test/close-finished-items.test.mjs` } },
  deploy: { kind: 'deploy_newer_than', args: { project_ref: 'xoecpzfsskalvjrtcbbl', function_slug: 'signal-intake', iso: '2026-08-01T00:00:00Z' } },
  metric: { kind: 'metric_below', args: { name: 'open_items', threshold: 100, days: 7 } },
  human: { kind: 'human', args: { question: 'Should we keep the Smartlead plan?' } },
}

/** Healthy dependencies: every kind reaches its thing and that thing says "finished". */
const healthy = () => ({
  sentryIssue: async () => ({ id: '141893005', status: 'resolved' }),
  proveQueryPath: async () => ({ ok: true }),
  runQuery: async () => ({ status: 200, rows: [] }),
  proveNetworkPath: async () => ({ ok: true }),
  probeUrl: async () => ({ status: 200 }),
  exists: () => true,
  testRoots: [`${PROJECTS}`],
  runTest: async () => ({ code: 0 }),
  deployedAt: async () => ({ updated_at: '2026-09-01T10:00:00.000Z' }),
})

/**
 * The five faults, each expressed at the boundary the script actually crosses.
 *
 * `shape200` is the fifth and is not in the repo's own injector: a dependency that answers 200
 * with a perfectly valid document of the WRONG shape. It is what a renamed field, an API version
 * bump and a proxy's error page all look like, and unlike a 401 it never announces itself.
 */
const FAULTS = {
  netdown: () => {
    const boom = () => { const e = new TypeError('fetch failed'); e.cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' }); throw e }
    return {
      sentryIssue: async () => boom(),
      proveQueryPath: async () => ({ ok: false, reason: 'sentinel query answered nothing (ECONNREFUSED)' }),
      runQuery: async () => boom(),
      proveNetworkPath: async () => ({ ok: true }),
      probeUrl: async () => ({ status: null, error: 'connect ECONNREFUSED' }),
      exists: () => true, testRoots: [`${PROJECTS}`],
      runTest: async () => ({ code: null, error: 'spawn ENOENT' }),
      deployedAt: async () => ({ updated_at: null, error: 'connect ECONNREFUSED' }),
    }
  },
  unauth: () => ({
    sentryIssue: async () => { throw new Error('Sentry GET /issues/141893005/ -> HTTP 401') },
    proveQueryPath: async () => ({ ok: false, reason: 'sentinel query answered HTTP 401' }),
    runQuery: async () => ({ status: 401, rows: null }),
    proveNetworkPath: async () => ({ ok: true }),
    probeUrl: async () => ({ status: 401 }),
    exists: () => true, testRoots: [`${PROJECTS}`],
    runTest: async () => ({ code: null, error: 'EACCES' }),
    deployedAt: async () => ({ updated_at: null, error: 'functions/signal-intake -> HTTP 401' }),
  }),
  server500: () => ({
    sentryIssue: async () => { throw new Error('Sentry GET /issues/141893005/ -> HTTP 500') },
    proveQueryPath: async () => ({ ok: false, reason: 'sentinel query answered HTTP 500' }),
    runQuery: async () => ({ status: 500, rows: null }),
    proveNetworkPath: async () => ({ ok: true }),
    probeUrl: async () => ({ status: 500 }),
    exists: () => true, testRoots: [`${PROJECTS}`],
    runTest: async () => ({ code: null, error: 'the test process was killed or timed out' }),
    deployedAt: async () => ({ updated_at: null, error: 'functions/signal-intake -> HTTP 500' }),
  }),
  // Everything answers HTTP 200 with `[]` — the repo's own injector, and the cruellest fault:
  // the dependency is UP, it answers successfully, and it says nothing.
  empty200: () => ({
    sentryIssue: async () => [],
    proveQueryPath: async () => ({ ok: false, reason: 'sentinel query returned 0 rows instead of one' }),
    runQuery: async () => ({ status: 200, rows: [] }),
    proveNetworkPath: async () => ({ ok: false, reason: 'a hostname that cannot exist answered HTTP 200' }),
    probeUrl: async () => ({ status: 200 }),
    exists: () => true, testRoots: [`${PROJECTS}`],
    runTest: async () => ({ code: null, error: 'no exit code' }),
    deployedAt: async () => ({ updated_at: null, error: 'functions/signal-intake answered HTTP 200 with no updated_at' }),
  }),
  // 200, valid JSON, wrong shape. A renamed field, an API version bump, a proxy error page.
  shape200: () => ({
    sentryIssue: async () => ({ id: '141893005', state: 'resolved' }),          // `state`, not `status`
    proveQueryPath: async () => ({ ok: true }),
    runQuery: async () => ({ status: 200, rows: { count: 0 } }),                // an object, not an array
    proveNetworkPath: async () => ({ ok: true }),
    probeUrl: async () => ({ statusCode: 200 }),                                // renamed field
    exists: () => true, testRoots: [`${PROJECTS}`],
    runTest: async () => ({ exit: 0 }),                                         // no `code`
    deployedAt: async () => ({ updated_at: 'yesterday afternoon' }),             // unparseable
  }),
}

/** Records every offer made to the board, so "closed nothing" is measured, not inferred. */
function boardSpy() {
  const calls = { evidence: [], close: [], offers: [] }
  return {
    calls,
    offer: async (it, f) => { calls.offers.push({ item: it.slug, state: f.state }); return { outcome: 'closed', item: it.slug, why: 'spy' } },
    workEvidence: async (payload) => { calls.evidence.push(payload); return { ok: true } },
    workClose: async (payload) => { calls.close.push(payload); return { ok: true, item: payload.item, status: 'done', production: 'spy proof' } },
  }
}

// ── parseDoneWhen: malformed is UNKNOWN, and it is never silently dropped ─────────────────────

t('a nested-args finish-test parses', () => {
  const p = parseDoneWhen(DW.sentry)
  assert.equal(p.ok, true); assert.equal(p.kind, 'sentry_resolved'); assert.equal(p.args.issue_id, '141893005')
})

t('a FLAT finish-test parses too — a cosmetic spelling must not mean a row that never closes', () => {
  const p = parseDoneWhen({ kind: 'sentry_resolved', issue_id: '141893005' })
  assert.equal(p.ok, true); assert.equal(p.args.issue_id, '141893005')
})

t('a finish-test stored as a JSON STRING parses (jsonb columns are read back either way)', () => {
  const p = parseDoneWhen(JSON.stringify(DW.url))
  assert.equal(p.ok, true); assert.equal(p.kind, 'url_answers')
})

t('every kind named in the brief is understood, and no others', () => {
  assert.deepEqual(Object.keys(KINDS).sort(), [
    'deploy_newer_than', 'human', 'metric_below', 'query_returns_no_rows',
    'sentry_resolved', 'test_exits_zero', 'url_answers',
  ])
})

for (const [label, raw] of [
  ['not JSON at all', '{kind: broken'],
  ['an empty string', '   '],
  ['an array', [{ kind: 'human' }]],
  ['a number', 7],
  ['no kind', { args: { url: 'https://x' } }],
  ['a kind nobody implemented', { kind: 'vibes_are_good', args: {} }],
  ['a kind that is not a string', { kind: 42 }],
  ['sentry_resolved with no issue_id', { kind: 'sentry_resolved', args: {} }],
  ['url_answers with no status', { kind: 'url_answers', args: { url: 'https://x' } }],
  ['deploy_newer_than missing the timestamp', { kind: 'deploy_newer_than', args: { project_ref: 'r', function_slug: 's' } }],
  ['test_exits_zero with an empty path', { kind: 'test_exits_zero', args: { path: '' } }],
]) {
  t(`a malformed finish-test (${label}) is refused, not accepted`, () => {
    assert.equal(parseDoneWhen(raw).ok, false)
  })
  ta(`a malformed finish-test (${label}) evaluates to UNKNOWN — never pass`, async () => {
    const f = await evaluateDoneWhen(raw, healthy())
    assert.equal(f.state, UNKNOWN, `expected unknown, got ${f.state}: ${f.reason}`)
    assert.notEqual(f.state, PASS)
  })
}

ta('THE MALFORMED ROW STILL CLOSES NOTHING, even with every dependency healthy', async () => {
  const spy = boardSpy()
  const s = await sweep([item({ slug: 'gibberish', done_when: '{oops' })], { deps: healthy(), offer: spy.offer })
  assert.equal(s.unknowns.length, 1)
  assert.equal(s.passes.length, 0)
  assert.equal(spy.calls.offers.length, 0, 'a row whose finish-test cannot be read must not be offered to the board')
})

// ── the happy path, one per kind ─────────────────────────────────────────────────────────────

ta('sentry_resolved passes when the issue is resolved, fails while it is unresolved', async () => {
  const p = await evaluateDoneWhen(DW.sentry, healthy())
  assert.equal(p.state, PASS)
  const f = await evaluateDoneWhen(DW.sentry, { ...healthy(), sentryIssue: async () => ({ status: 'unresolved' }) })
  assert.equal(f.state, FAIL)
})

t('Sentry is asked ORG-SCOPED FIRST — the bare /issues/<id>/ path 404s for our own issues', () => {
  // Probed live on 2026-09-03: /api/0/issues/141893005/ -> 404, and
  // /api/0/organizations/predivo-gmbh/issues/141893005/ -> 200 status "resolved", same token.
  // Written the obvious way round, every sentry_resolved row would be permanently unknown — a
  // quiet, plausible answer nobody would ever have a reason to investigate.
  const paths = SENTRY_ISSUE_PATHS('predivo-gmbh', '141893005')
  assert.equal(paths[0], '/organizations/predivo-gmbh/issues/141893005/')
  assert.equal(paths[1], '/issues/141893005/', 'the bare path is kept as a fallback, never as the first try')
  assert.equal(SENTRY_ISSUE_PATHS('o', 'a/b')[0].includes('a%2Fb'), true, 'the issue id is untrusted input and must be encoded')
})

t('an IGNORED Sentry issue counts as settled — muting one is a decision somebody took', () => {
  for (const s of ['resolved', 'ignored', 'muted', 'resolvedInNextRelease', 'RESOLVED']) assert.equal(sentryStatusIsSettled(s), true, s)
  for (const s of ['unresolved', '', null, undefined, 'reprocessing']) assert.equal(sentryStatusIsSettled(s), false, String(s))
})

ta('query_returns_no_rows passes on zero rows and fails while rows remain', async () => {
  const p = await evaluateDoneWhen(DW.query, healthy())
  assert.equal(p.state, PASS)
  const f = await evaluateDoneWhen(DW.query, { ...healthy(), runQuery: async () => ({ status: 200, rows: [{ id: 1 }, { id: 2 }] }) })
  assert.equal(f.state, FAIL)
  assert.match(f.reason, /2 row/)
})

ta('url_answers passes on the required status and fails on any other', async () => {
  const p = await evaluateDoneWhen(DW.url, healthy())
  assert.equal(p.state, PASS)
  const f = await evaluateDoneWhen(DW.url, { ...healthy(), probeUrl: async () => ({ status: 503 }) })
  assert.equal(f.state, FAIL)
  assert.match(f.reason, /503/)
})

ta('url_answers accepts a NON-2xx expectation (401 is a legitimate finish-test) but offers no proof', async () => {
  const dw = { kind: 'url_answers', args: { url: 'https://staging.cockpit.predivo.ch/', status: 401 } }
  const f = await evaluateDoneWhen(dw, { ...healthy(), probeUrl: async () => ({ status: 401 }) })
  assert.equal(f.state, PASS)
  assert.equal(f.production_ref, null,
    'a 401 proves the host answered, not that a product is live — handing work_close a receipt it would refuse is worse than handing it none')
})

ta('a 2xx url_answers hands work_close a production proof it can re-verify itself', async () => {
  const f = await evaluateDoneWhen(DW.url, healthy())
  assert.equal(f.production_ref, 'https://cockpit.predivo.ch/signals')
})

ta('test_exits_zero passes on exit 0, fails on any other exit code', async () => {
  const p = await evaluateDoneWhen(DW.test, healthy())
  assert.equal(p.state, PASS)
  assert.match(p.production_ref, /close-finished-items\.test\.mjs$/, 'the test path is itself a proof shape work_close accepts')
  const f = await evaluateDoneWhen(DW.test, { ...healthy(), runTest: async () => ({ code: 1 }) })
  assert.equal(f.state, FAIL)
})

ta('deploy_newer_than compares the LIVE updated_at against the stated moment', async () => {
  const p = await evaluateDoneWhen(DW.deploy, healthy())
  assert.equal(p.state, PASS)
  const f = await evaluateDoneWhen(DW.deploy, { ...healthy(), deployedAt: async () => ({ updated_at: '2026-07-01T00:00:00.000Z' }) })
  assert.equal(f.state, FAIL)
})

ta('deploy_newer_than refuses an unparseable timestamp on EITHER side rather than reading it as "not newer"', async () => {
  // NaN comparisons are always false, so an unparseable value reads as "not stale" — the quiet,
  // reassuring direction. check-edge-code-live.mjs was written after exactly this.
  const a = await evaluateDoneWhen({ kind: 'deploy_newer_than', args: { project_ref: 'r', function_slug: 's', iso: 'soon' } }, healthy())
  assert.equal(a.state, UNKNOWN)
  const b = await evaluateDoneWhen(DW.deploy, { ...healthy(), deployedAt: async () => ({ updated_at: 'soon' }) })
  assert.equal(b.state, UNKNOWN)
})

ta('metric_below is a declared stub: UNKNOWN always, with plausible args and healthy deps', async () => {
  const f = await evaluateDoneWhen(DW.metric, healthy())
  assert.equal(f.state, UNKNOWN)
  assert.equal(f.todo, true)
  assert.match(f.reason, /not implemented/i)
})

// ── `human` is never touched, and that is the only correct silence in this job ────────────────

ta('a human finish-test is SKIPPED — not evaluated, not unknown, not offered', async () => {
  const spy = boardSpy()
  const s = await sweep([item({ slug: 'ask-roger', done_when: DW.human })], { deps: healthy(), offer: spy.offer })
  assert.equal(s.skipped.length, 1)
  assert.equal(s.passes.length, 0)
  assert.equal(s.unknowns.length, 0, 'a question for Roger is not a broken sensor — counting it as unknown would cry wolf hourly')
  assert.equal(s.fails.length, 0)
  assert.equal(spy.calls.offers.length, 0)
  assert.equal(s.skipped[0].f.state, SKIP)
})

ta('a human finish-test is never touched even when every dependency is healthy AND it looks done', async () => {
  const spy = boardSpy()
  await sweep([
    item({ slug: 'ask-roger-1', done_when: { kind: 'human', question: 'ship it?' } }),
    item({ slug: 'ask-roger-2', done_when: DW.human }),
  ], { deps: healthy(), offer: spy.offer })
  assert.equal(spy.calls.offers.length, 0)
})

// ── DEFECT INJECTION: five broken dependencies, six kinds, nothing closes ─────────────────────

const NETWORK_KINDS = ['sentry', 'query', 'url', 'test', 'deploy', 'metric']

/**
 * What each fault SHOULD produce, stated per kind rather than assumed uniform.
 *
 * Everything is `unknown` except two honest exceptions, and writing them down is the point: under
 * a 401 or a 500 the target of a `url_answers` test really did answer, with a status that is not
 * the required one, so "not finished yet" is the true reading and the row correctly stays open.
 * Flattening those into "unknown" would make this table agree with itself rather than with the
 * program — and a test that asserts a uniform answer over a non-uniform reality is how a real
 * regression later gets edited away as noise. What is NEVER permitted, in any cell, is `pass`.
 */
const EXPECT = {
  netdown: {}, empty200: {}, shape200: {},
  unauth: { url: FAIL },
  server500: { url: FAIL },
}

for (const [faultName, makeDeps] of Object.entries(FAULTS)) {
  for (const kindKey of NETWORK_KINDS) {
    const want = EXPECT[faultName][kindKey] || UNKNOWN
    ta(`${DW[kindKey].kind} answers ${want} — never pass — when its dependency is broken (${faultName})`, async () => {
      const f = await evaluateDoneWhen(DW[kindKey], makeDeps())
      assert.notEqual(f.state, PASS,
        `${DW[kindKey].kind} PASSED while blind (${faultName}): ${f.reason}\n` +
        'This is the failure class this suite exists to close: the job could not look, and closed somebody\'s work anyway.')
      assert.equal(f.state, want, `${DW[kindKey].kind} under ${faultName}: expected ${want}, got ${f.state} (${f.reason})`)
    })
  }

  ta(`a whole board sweep closes NOTHING when the dependencies are broken (${faultName})`, async () => {
    const spy = boardSpy()
    const items = NETWORK_KINDS.map((k) => item({ slug: `item-${k}`, done_when: DW[k] }))
      .concat(item({ slug: 'item-human', done_when: DW.human }))
    const s = await sweep(items, { deps: makeDeps(), offer: spy.offer })
    assert.equal(s.passes.length, 0, `something passed while blind (${faultName})`)
    assert.equal(spy.calls.offers.length, 0, `the board was offered ${spy.calls.offers.length} item(s) while blind (${faultName})`)
    assert.equal(s.unknowns.length + s.fails.length, NETWORK_KINDS.length, 'every non-human row must have been judged, one way or the other')
    assert.equal(s.skipped.length, 1, 'and the human row must have been left alone')
  })
}

// ── THE TWO THAT MATTER: the sentinels ───────────────────────────────────────────────────────

ta('THE ONE THAT MATTERS — a stubbed query path cannot pass a query_returns_no_rows row', async () => {
  // The dependency answers HTTP 200 with `[]`, which IS the passing answer for this kind. Without
  // the sentinel, one revoked grant closes the entire board in a single run. The `runQuery` stub
  // here is deliberately the HEALTHY one: only the sentinel distinguishes the two situations.
  const spy = boardSpy()
  const deps = { ...healthy(), proveQueryPath: async () => ({ ok: false, reason: 'sentinel query returned 0 rows instead of one' }) }
  const s = await sweep([item({ slug: 'would-have-closed', done_when: DW.query })], { deps, offer: spy.offer })
  assert.equal(s.unknowns.length, 1)
  assert.equal(s.passes.length, 0)
  assert.equal(spy.calls.offers.length, 0)
  assert.match(s.unknowns[0].f.reason, /could not be proved/)
})

ta('THE ONE THAT MATTERS — an intercepted fetch cannot pass a url_answers row', async () => {
  // Same shape: probeUrl returns exactly the required 200. Only the network canary — a hostname
  // that cannot resolve, and did — says the 200 is a fiction.
  const spy = boardSpy()
  const deps = { ...healthy(), proveNetworkPath: async () => ({ ok: false, reason: 'a hostname that cannot exist answered HTTP 200' }) }
  const s = await sweep([item({ slug: 'would-have-closed', done_when: DW.url })], { deps, offer: spy.offer })
  assert.equal(s.passes.length, 0)
  assert.equal(spy.calls.offers.length, 0)
  assert.match(s.unknowns[0].f.reason, /network path could not be proved/)
})

ta('an evaluator that THROWS unexpectedly is unknown, and does not abort the sweep half-done', async () => {
  const spy = boardSpy()
  const deps = { ...healthy(), sentryIssue: async () => { throw new Error('undici socket hang up') } }
  const s = await sweep([
    item({ slug: 'boom', done_when: DW.sentry }),
    item({ slug: 'fine', done_when: DW.url }),
  ], { deps, offer: spy.offer })
  assert.equal(s.unknowns.length, 1)
  assert.equal(s.passes.length, 1, 'one exploding row must not stop the rest of the board being judged')
  assert.equal(spy.calls.offers.length, 1)
})

// ── done_when is untrusted input ─────────────────────────────────────────────────────────────

t('sqlIsReadOnly accepts a plain read and refuses everything that writes', () => {
  assert.equal(sqlIsReadOnly('select 1').ok, true)
  assert.equal(sqlIsReadOnly('  WITH x as (select 1) select * from x  ').ok, true)
  assert.equal(sqlIsReadOnly('select id from work_items where status = \'next\';').ok, true, 'one trailing semicolon is fine')
  for (const bad of [
    'delete from work_items',
    'select 1; drop table work_items',
    'update work_items set status = \'done\'',
    'truncate work_items',
    'insert into work_items (slug) values (\'x\')',
    'grant all on work_items to anon',
    'select 1 -- ok\n; drop table work_items',
    'select 1 /* sneaky */; alter table work_items drop column done_when',
    'do $$ begin perform 1; end $$',
    '',
  ]) {
    assert.equal(sqlIsReadOnly(bad).ok, false, `must refuse: ${bad}`)
  }
})

ta('a finish-test carrying a writing query is UNKNOWN — a refused test has not been asked', async () => {
  const spy = boardSpy()
  const dw = { kind: 'query_returns_no_rows', args: { sql: 'delete from work_items where status = \'next\'', project_ref: 'r' } }
  const s = await sweep([item({ slug: 'malicious', done_when: dw })], { deps: healthy(), offer: spy.offer })
  assert.equal(s.unknowns.length, 1)
  assert.equal(spy.calls.offers.length, 0)
  assert.match(s.unknowns[0].f.reason, /refused/)
})

// EVERY PATH HERE IS BUILT FROM THE RUNNING PLATFORM'S OWN ROOT (fixed 2026-09-03).
//
// It used to hardcode `C:/Business/Internal Projects`. That passes on a Windows desktop and can
// NEVER pass on the Linux runner, where `C:/Business/...` is not an absolute path at all, so the
// containment check cannot hold. Master's Tests workflow was red on every run from 09:10Z with
// this as the only failing suite - 65 others green either side of it - because a test encoded one
// developer's disk layout. Third time in a week this fleet has paid for that shape: a Windows
// `npm audit fix` pruned Linux-only lockfile entries, and a check compared two environments with
// two different harnesses and reported a regression that did not exist.
//
// THE SIBLINGS ARE BUILT FROM THE SAME BASE ON PURPOSE, and this is the part worth not breaking.
// The negative cases are load-bearing and each proves a different refusal:
//   - `<root>Evil/...`  proves that PREFIX-MATCHING a root is not being inside it. If the root is
//     rebuilt but this string is not, it stops being a prefix of the real root and silently
//     degrades into the trivially-outside case - the negative that matters most would then be
//     testing nothing while still passing. Flagged by a second session before this was written.
//   - an absolute path under no root at all proves outside-every-root.
//   - a relative path proves that relative is refused outright.
t('testPathIsRunnable refuses anything that is not an allow-listed test file', () => {
  // path.parse().root is 'C:\\' on Windows and '/' on POSIX; posix-style separators are used
  // throughout so the strings read the same on both and match how callers write them.
  const base = ROOT
  const roots = [`${base}Business/Internal Projects`]
  const inside = `${base}Business/Internal Projects/production-monitor/test/x.test.mjs`
  const exists = () => true
  assert.equal(testPathIsRunnable(inside, { roots, exists }).ok, true)
  for (const bad of [
    'test/x.test.mjs',                                            // relative
    `${base}Business/Internal Projects/x.sh`,                     // not a test file
    `${base}Business/Internal Projects/scripts/deploy.mjs`,       // not a test file
    `${base}somewhere/else/entirely/calc.exe`,                    // outside every root
    `${base}Business/Internal ProjectsEvil/x.test.mjs`,           // prefix-matching a root is not being inside it
    '',
  ]) {
    assert.equal(testPathIsRunnable(bad, { roots, exists }).ok, false, `must refuse: ${bad}`)
  }
  // The prefix case must remain a genuine prefix of a genuine root, or it degrades into the
  // trivially-outside case above and stops proving anything. Asserted, not assumed.
  assert.ok(`${base}Business/Internal ProjectsEvil/x.test.mjs`.startsWith(roots[0]),
    'the prefix-attack fixture must still start with the real root, or it tests nothing')
  assert.equal(testPathIsRunnable(`${base}Business/Internal Projects/production-monitor/test/gone.test.mjs`, { roots, exists: () => false }).ok, false,
    'a test file that is not there is a stale finish-test, not a passing one')
})

ta('a test_exits_zero pointing outside the allow-listed roots is UNKNOWN and never executed', async () => {
  let ran = 0
  const deps = { ...healthy(), runTest: async () => { ran++; return { code: 0 } } }
  const f = await evaluateDoneWhen({ kind: 'test_exits_zero', args: { path: `${ROOT}somewhere/else/entirely/calc.exe` } }, deps)
  assert.equal(f.state, UNKNOWN)
  assert.equal(ran, 0, 'a refused path must never reach the spawner at all')
})

// ── which rows this job may touch ────────────────────────────────────────────────────────────

t('awaiting_signoff is NEVER actionable — those rows are already a question addressed to Roger', () => {
  assert.equal(ACTIONABLE_STATUSES.includes('awaiting_signoff'), false)
  assert.equal(UNTOUCHABLE_STATUSES.includes('awaiting_signoff'), true)
  const { actionable, untouchable } = selectItems([
    item({ slug: 'a', status: 'next' }), item({ slug: 'b', status: 'in_progress' }), item({ slug: 'c', status: 'blocked' }),
    item({ slug: 'd', status: 'awaiting_signoff' }), item({ slug: 'e', status: 'done' }), item({ slug: 'f', status: 'abandoned' }),
    item({ slug: 'g', status: 'a_status_nobody_has_invented_yet' }),
  ])
  assert.deepEqual(actionable.map((r) => r.slug), ['a', 'b', 'c'])
  assert.deepEqual(untouchable.map((r) => r.slug), ['d', 'e', 'f', 'g'])
})

ta('an item with NO done_when is not evaluated and not counted — it simply cannot close itself', async () => {
  const spy = boardSpy()
  const s = await sweep([item({ slug: 'no-test', done_when: null }), item({ slug: 'no-test-2' })], { deps: healthy(), offer: spy.offer })
  assert.equal(s.results.length, 0)
  assert.equal(spy.calls.offers.length, 0)
})

// ── offerToBoard: the board decides, and the receipt goes on first ────────────────────────────

ta('the receipt is filed BEFORE the close, because sql/077 looks for it first', async () => {
  const spy = boardSpy()
  const order = []
  const o = await offerToBoard(item(), await evaluateDoneWhen(DW.url, healthy()), {
    workEvidence: async (p) => { order.push('evidence'); spy.calls.evidence.push(p) },
    workClose: async (p) => { order.push('close'); spy.calls.close.push(p); return { ok: true, status: 'done' } },
  })
  assert.deepEqual(order, ['evidence', 'close'])
  assert.equal(o.outcome, 'closed')
  assert.equal(spy.calls.evidence[0].kind, 'gate')
  assert.match(spy.calls.evidence[0].title, /Finish-test passed/)
  assert.match(spy.calls.evidence[0].detail, /answers HTTP 200/)
})

ta('an item with no documentation_ref is REFUSED, and work_close is never called', async () => {
  let closed = 0
  const o = await offerToBoard(item({ documentation_ref: null }), await evaluateDoneWhen(DW.url, healthy()), {
    workEvidence: async () => ({ ok: true }),
    workClose: async () => { closed++; return { ok: true, status: 'done' } },
  })
  assert.equal(o.outcome, 'refused')
  assert.equal(closed, 0)
  assert.match(o.why, /documentation_ref/)
})

ta('a done_when may carry its own documentation_ref and production_ref, and they are used', async () => {
  const dw = { ...DW.sentry, documentation_ref: 'C:/docs/thing.md', production_ref: 'https://github.com/o/r/actions/runs/1' }
  const f = await evaluateDoneWhen(dw, healthy())
  const seen = []
  await offerToBoard(item({ documentation_ref: null }), f, {
    workEvidence: async () => ({ ok: true }),
    workClose: async (p) => { seen.push(p); return { ok: true, status: 'done' } },
  })
  assert.equal(seen[0].documentation_ref, 'C:/docs/thing.md')
  assert.equal(seen[0].production_ref, 'https://github.com/o/r/actions/runs/1')
})

ta('if the receipt cannot be filed, nothing is closed', async () => {
  let closed = 0
  const o = await offerToBoard(item(), await evaluateDoneWhen(DW.url, healthy()), {
    workEvidence: async () => { throw new Error('REST work_evidence -> HTTP 500') },
    workClose: async () => { closed++; return { ok: true, status: 'done' } },
  })
  assert.equal(o.outcome, 'refused')
  assert.equal(closed, 0, 'a close whose reason was never written down is exactly the shallow close the gate refuses')
})

ta('CLOSED and HANDED TO ROGER are two different outcomes, never one number', async () => {
  const f = await evaluateDoneWhen(DW.url, healthy())
  const closed = await offerToBoard(item(), f, {
    workEvidence: async () => ({ ok: true }),
    workClose: async () => ({ ok: true, status: 'done', production: 'URL live (HTTP 200)' }),
  })
  assert.equal(closed.outcome, 'closed')
  const handed = await offerToBoard(item(), f, {
    workEvidence: async () => ({ ok: true }),
    workClose: async () => ({ ok: true, status: 'awaiting_signoff', why_he_is_being_asked: 'the production proof did not hold' }),
  })
  assert.equal(handed.outcome, 'handed', 'an item parked in Roger\'s lane has NOT closed, and reporting it as closed is this repo\'s other favourite lie')
})

ta('a work_close refusal is recorded as refused, not swallowed and not counted as closed', async () => {
  const o = await offerToBoard(item(), await evaluateDoneWhen(DW.url, healthy()), {
    workEvidence: async () => ({ ok: true }),
    workClose: async () => { throw new Error('REFUSED: cannot close "x" — documentation_ref does not resolve to a file that exists') },
  })
  assert.equal(o.outcome, 'refused')
  assert.match(o.why, /REFUSED/)
})

ta('CLOSER_MAX caps one run, and the remainder is reported rather than dropped', async () => {
  const spy = boardSpy()
  const items = Array.from({ length: 7 }, (_, i) => item({ slug: `p-${i}`, done_when: DW.url }))
  const s = await sweep(items, { deps: healthy(), offer: spy.offer, max: 3 })
  assert.equal(s.passes.length, 7)
  assert.equal(spy.calls.offers.length, 3)
  assert.equal(s.deferred, 4)
})

// ── the verdict, and therefore the exit code ─────────────────────────────────────────────────

t('a board that could not be read is UNKNOWN and exits 1', () => {
  const v = verdict({ boardRead: false, reason: 'HTTP 401' })
  assert.equal(v.state, UNKNOWN); assert.equal(v.code, 1)
})

t('AN EMPTY BOARD IS A BROKEN SENSOR, not a finished fleet', () => {
  // 229 open items on 2026-09-03, growing fifteen a day. Zero is a renamed column or a revoked
  // grant, and the reassuring branch is the one that must be hardest to reach.
  const v = verdict({ boardRead: true, open: 0 })
  assert.equal(v.state, UNKNOWN); assert.equal(v.code, 1)
})

t('a board where NOT ONE row carries a finish-test is a real finding: FAIL, exit 0', () => {
  const v = verdict({ boardRead: true, open: 229, evaluated: 0, skipped: 0 })
  assert.equal(v.state, FAIL); assert.equal(v.code, 0)
  assert.match(v.headline, /not one of 229/)
})

t('every finish-test unknown means nothing was reached at all: UNKNOWN, exit 1', () => {
  const v = verdict({ boardRead: true, open: 229, evaluated: 6, unknowns: 6 })
  assert.equal(v.state, UNKNOWN); assert.equal(v.code, 1)
})

t('SOME unknowns still forbid a clean sweep, but the run is not an error: UNKNOWN, exit 0', () => {
  const v = verdict({ boardRead: true, open: 229, evaluated: 10, passes: 3, fails: 5, unknowns: 2, closed: 3 })
  assert.equal(v.state, UNKNOWN); assert.equal(v.code, 0)
  assert.match(v.headline, /NOT a clean sweep/)
})

t('a fully evaluated sweep is a PASS, and the sentence carries every count', () => {
  const v = verdict({ boardRead: true, open: 229, evaluated: 10, skipped: 2, passes: 4, fails: 6, closed: 3, handed: 1 })
  assert.equal(v.state, PASS); assert.equal(v.code, 0)
  for (const s of ['10 finish-test', '229 open', '4 passed', '6 not finished', '0 could NOT', '2 left for Roger', '3 closed', '1 handed']) {
    assert.ok(v.headline.includes(s), `the headline must say "${s}": ${v.headline}`)
  }
})

t('a dry run says so in the same sentence as the number, so nobody reads it as work done', () => {
  const v = verdict({ boardRead: true, open: 229, evaluated: 5, passes: 2, fails: 3, dry: true })
  assert.match(v.headline, /DRY RUN, nothing was closed \(2 would have been offered/)
})

// ── dry is the default ───────────────────────────────────────────────────────────────────────

t('an accidental run is DRY: closing needs a deliberate CLOSER_CONFIRM, and no flag can grant it', () => {
  assert.equal(isDryRun(['node', 'x'], {}), true, 'no CLOSER_CONFIRM -> dry')
  assert.equal(isDryRun(['node', 'x'], { CLOSER_CONFIRM: '' }), true, 'an empty CLOSER_CONFIRM is not a confirmation')
  assert.equal(isDryRun(['node', 'x', '--dry'], { CLOSER_CONFIRM: '1' }), true, '--dry always wins')
  assert.equal(isDryRun(['node', 'x'], { CLOSER_CONFIRM: '1' }), false, 'the one way to close')
  assert.equal(isDryRun(['node', 'x', '--close', '--yes', '--force'], {}), true, 'no command-line flag may switch closing on')
})

t('the closure cap defaults to 25 and only a sane number overrides it', () => {
  assert.equal(closureCap({}), 25)
  assert.equal(closureCap({ CLOSER_MAX: '3' }), 3)
  assert.equal(closureCap({ CLOSER_MAX: '0' }), 0)
  assert.equal(closureCap({ CLOSER_MAX: 'lots' }), 25)
  assert.equal(closureCap({ CLOSER_MAX: '-4' }), 25)
})

// ── credentials are read, never spoken ───────────────────────────────────────────────────────

t('loadBoardCredentials returns key NAMES and never a value, and says so when the block is absent', () => {
  const env = {}
  const read = () => JSON.stringify({ mcpServers: { 'cockpit-mcp': { env: { SUPABASE_URL: 'https://ref123.supabase.co', SUPABASE_SERVICE_KEY: 'sb_secret_NEVER_PRINT_ME' } } } })
  const r = loadBoardCredentials({ read, env })
  assert.equal(r.ok, true)
  assert.deepEqual(r.applied, ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY'])
  assert.equal(JSON.stringify(r).includes('sb_secret_NEVER_PRINT_ME'), false, 'no returned field may carry a secret value, in whole or in part')
  assert.equal(env.SUPABASE_SERVICE_KEY, 'sb_secret_NEVER_PRINT_ME', 'it must still reach the process env, where db.mjs reads it')
  assert.equal(loadBoardCredentials({ read: () => '{}', env: {} }).ok, false)
  assert.equal(loadBoardCredentials({ read: () => { const e = new Error('x'); e.code = 'ENOENT'; throw e }, env: {} }).ok, false)
  assert.equal(loadBoardCredentials({ read: () => JSON.stringify({ mcpServers: { 'cockpit-mcp': { env: { SUPABASE_URL: 'https://x.supabase.co' } } } }), env: {} }).ok, false)
})

t('the board project ref is derived from its URL, and is not a secret', () => {
  assert.equal(boardProjectRef({ SUPABASE_URL: 'https://xoecpzfsskalvjrtcbbl.supabase.co' }), 'xoecpzfsskalvjrtcbbl')
  assert.equal(boardProjectRef({ SUPABASE_URL: 'not a url' }), null)
  assert.equal(boardProjectRef({}), null)
})

t('the receipt names what was evaluated and what it returned, and carries no secret', () => {
  const r = receiptFor(item(), { kind: 'url_answers', state: PASS, reason: 'https://x answers HTTP 200 as required', production_ref: 'https://x' })
  assert.equal(r.kind, 'gate')
  assert.match(r.detail, /url_answers/)
  assert.match(r.detail, /Result: PASS/)
  assert.match(r.detail, /close-finished-items\.mjs/)
})

// ── end to end: the script itself, blind, must not report a pass ─────────────────────────────

ta('THE HOUSE CONTRACT, end to end: the real script blind on its credentials says UNKNOWN and exits 1', () => {
  // This file is named close-* rather than check-*, so the glob in
  // a-check-cannot-pass-without-reaching-its-dependency.test.mjs does NOT sweep it. It is held to
  // the same contract here, by running the real script with its home directory replaced so
  // ~/.claude.json cannot be found — the exact shape of a rotated or moved MCP registration.
  const home = mkdtempSync(join(tmpdir(), 'closer-blind-'))
  try {
    const r = spawnSync(process.execPath, [SCRIPT, '--dry'], {
      cwd: REPO, encoding: 'utf-8', timeout: 120_000,
      env: { ...process.env, USERPROFILE: home, HOME: home, CLOSER_CONFIRM: '' },
    })
    const output = `${r.stdout || ''}\n${r.stderr || ''}`
    assert.equal(reportedPass({ exitCode: r.status, output }), false,
      `the closer reported a PASS while it could not even read its credentials.\n--- output ---\n${output.slice(0, 1200)}`)
    assert.ok(output.includes(`${VERDICT_MARKER}${UNKNOWN}`), `it must SAY unknown, not merely exit non-zero:\n${output.slice(0, 1200)}`)
    assert.equal(r.status, 1, 'a failed READ exits non-zero — the house rule in scripts/lib/fleet-signal.mjs')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

ta('a REAL test file that exits non-zero is "not finished yet", and one that exits 0 passes', async () => {
  // The one evaluator that runs a real subprocess gets a real subprocess, because a stub cannot
  // prove that the spawn arguments, the cwd walk and the exit-code reading are right.
  const dir = mkdtempSync(join(tmpdir(), 'closer-suite-'))
  try {
    const good = join(dir, 'green.test.mjs')
    const bad = join(dir, 'red.test.mjs')
    writeFileSync(good, 'process.exitCode = 0\n')
    writeFileSync(bad, 'process.exitCode = 3\n')
    const roots = [dir]
    const p = await evaluateDoneWhen({ kind: 'test_exits_zero', args: { path: good } }, { testRoots: roots })
    assert.equal(p.state, PASS, p.reason)
    const f = await evaluateDoneWhen({ kind: 'test_exits_zero', args: { path: bad } }, { testRoots: roots })
    assert.equal(f.state, FAIL, f.reason)
    assert.match(f.reason, /exits 3/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── A QUESTION OWED TO ROGER IS THE OTHER HALF OF HIS LANE (added 2026-09-03) ────────────────
// This file protected `awaiting_signoff` from the first commit and left `blocked` actionable, while
// the script did not mention `blocked_question` or `blocked_owner` once. sql/092 builds his list as
// `awaiting_signoff` OR a question recorded against him, so a blocked row is in his lane by exactly
// the same right — and sql/096 exists because such a question was once deleted by a side effect.
// Caught on the live board: two rows whose finish-test PASSED were sitting blocked on a question
// to him, and nothing in this script would have stopped it closing them.

t('a blocked row carrying a question owed to Roger is untouchable', () => {
  assert.equal(isOwedToRoger({ status: 'blocked', blocked_question: 'May I rotate the key?' }), true)
})

t('blocked_owner=roger is enough on its own, with no question text recorded', () => {
  assert.equal(isOwedToRoger({ status: 'blocked', blocked_owner: 'roger' }), true)
  assert.equal(isOwedToRoger({ status: 'blocked', blocked_owner: 'ROGER' }), true, 'case must not matter')
})

// ── A ROW IN HIS LANE THAT ASKS NOTHING ─────────────────────────────────────────────────────
// Measured on the live board 2026-09-03: 50 rows owed to Roger, 21 of them carrying no question,
// because upsert_signal replaced decision_question with null on every producer call (BackOffice
// migration 139; cause fixed by 167 the same day). The lane still said NEEDS ROGER on all 50.
t('a row owed to Roger with no question is counted — it asks him for nothing', () => {
  const rows = [
    { slug: 'a', status: 'awaiting_signoff', blocked_owner: 'roger', blocked_question: null },
    { slug: 'b', status: 'blocked', blocked_owner: 'roger', blocked_question: '   ' },
  ]
  assert.deepEqual(silentRowsInHisLane(rows).map((r) => r.slug), ['a', 'b'])
})

t('a row that DOES state its ask is not counted — that one is a real decision', () => {
  assert.deepEqual(silentRowsInHisLane([
    { slug: 'a', status: 'blocked', blocked_owner: 'roger', blocked_question: 'Approve the migration?' },
  ]), [])
})

t('a row waiting on a VENDOR is never counted — his lane is the only lane measured', () => {
  assert.deepEqual(silentRowsInHisLane([
    { slug: 'v', status: 'blocked', blocked_owner: 'vendor', blocked_question: null },
  ]), [], 'a vendor wait is not attention taken from Roger')
})

t('ordinary working rows are never counted, however empty their question field is', () => {
  assert.deepEqual(silentRowsInHisLane([
    { slug: 'n', status: 'next', blocked_question: null },
    { slug: 'p', status: 'in_progress', blocked_question: null },
  ]), [], 'a next row asks nobody anything; that is not a defect')
})

t('missing, empty and malformed input never throws — the count is a report, not a gate', () => {
  assert.deepEqual(silentRowsInHisLane(), [])
  assert.deepEqual(silentRowsInHisLane([]), [])
  assert.deepEqual(silentRowsInHisLane([null, undefined]), [])
})

t('a row blocked on a VENDOR or client stays closeable — nobody is being answered for', () => {
  assert.equal(isOwedToRoger({ status: 'blocked', blocked_owner: 'vendor', blocked_question: '' }), false)
})

t('an ordinary next or in_progress row is unaffected', () => {
  assert.equal(isOwedToRoger({ status: 'next' }), false)
  assert.equal(isOwedToRoger({ status: 'in_progress', blocked_question: null }), false)
  assert.equal(isOwedToRoger(null), false, 'a missing row is not owed to anyone')
})

t('DEFECT: selectItems must HOLD the owed row, not merely refuse it at the close', () => {
  const { actionable, untouchable } = selectItems([
    { slug: 'owed', status: 'blocked', blocked_question: 'yes or no?' },
    { slug: 'plain', status: 'next' },
    { slug: 'parked', status: 'awaiting_signoff' },
    { slug: 'vendor', status: 'blocked', blocked_owner: 'vendor' },
  ])
  assert.deepEqual(actionable.map((r) => r.slug), ['plain', 'vendor'])
  assert.deepEqual(untouchable.map((r) => r.slug).sort(), ['owed', 'parked'])
})

t('a row owed to Roger that carries a machine check is JUDGED, never closed', () => {
  // Measured on the live board 2026-09-04: 31 open rows carried a finish-test that had NEVER been
  // evaluated. 20 were kind:human and correctly none of a machine's business — but ELEVEN carried
  // a machine-checkable check and had never once been run, because selectItems dropped them before
  // sweep ever saw them. Judging is not acting. A verdict on a blocked row costs him nothing and
  // is the only way a lane of questions gets SHORTER without him answering every one of them.
  const { actionable, judgeOnly, untouchable } = selectItems([
    { slug: 'his-with-check', status: 'blocked', blocked_question: 'yes or no?', done_when: { kind: 'query_returns_no_rows' } },
    { slug: 'his-no-check', status: 'blocked', blocked_question: 'yes or no?' },
    { slug: 'his-null-check', status: 'blocked', blocked_owner: 'roger', done_when: null },
    { slug: 'plain', status: 'next', done_when: { kind: 'test_exits_zero' } },
    { slug: 'parked', status: 'awaiting_signoff', done_when: { kind: 'test_exits_zero' } },
  ])
  assert.deepEqual(actionable.map((r) => r.slug), ['plain'],
    'nothing owed to Roger may ever enter the list this job acts on')
  assert.deepEqual(judgeOnly.map((r) => r.slug), ['his-with-check'],
    'only his rows that actually have a machine check to run')
  assert.deepEqual(untouchable.map((r) => r.slug).sort(), ['his-no-check', 'his-null-check', 'parked'],
    'his rows with nothing to run stay untouched, and a parked row is still off-limits by status')
})

ta('judging his rows can never close one: sweep with no offer produces no outcome', async () => {
  const spy = boardSpy()
  const s = await sweep(
    [item({ slug: 'his-passing', done_when: { kind: 'url_answers', args: { url: 'https://example.invalid/', status: 200 } } })],
    { deps: healthy(), offer: null },
  )
  assert.equal(s.outcomes.length, 0, 'no offer, so nothing was ever handed to the board')
  assert.equal(s.deferred, 0)
  assert.equal(spy.calls.close.length, 0, 'and workClose was never reached')
  assert.equal(spy.calls.offers.length, 0, 'the offer path was not entered at all')
  assert.equal(s.results.length, 1, 'but the check WAS run, which is the whole point')
})

await Promise.all(pending)

console.log(`\n${n} tests passed.`)


// ══ A CHECK THAT IS ITSELF A RESOLVING ARTIFACT IS ITS OWN RECEIPT ═══════════════════════════
// Measured on the live board 2026-09-03: 19 finish-tests PASS and every one is refused here for
// a missing documentation_ref. Only 23 of 207 open rows carry one at all. But for two of the
// seven kinds the check IS a document, and one this run has just proven resolves.

t('a test that was executed and exited 0 is its own receipt', () => {
  assert.equal(selfDocumentingRef({ kind: 'test_exits_zero', path: 'test/a.test.mjs' }), 'test/a.test.mjs',
    'a test is the written record of what finished required — more precise than the prose note somebody would have typed')
})

t('a URL that answered is its own receipt', () => {
  assert.equal(selfDocumentingRef({ kind: 'url_answers', url: 'https://cockpit.predivo.ch/work' }),
    'https://cockpit.predivo.ch/work')
})

t('REFUSED: a SQL query is not a receipt — it is 41 of the 78 open checks and none can self-document', () => {
  assert.equal(selfDocumentingRef({ kind: 'query_returns_no_rows', sql: 'select 1 where false' }), null,
    'writing query text into documentation_ref is exactly the prose-as-receipt this gate refuses')
})

t('REFUSED: the other kinds cannot stand as their own receipt either', () => {
  for (const dw of [
    { kind: 'deploy_newer_than', project_ref: 'abc', function_slug: 'f', iso: '2026-09-03' },
    { kind: 'metric_below', metric: 'x', max: 1 },
    { kind: 'sentry_resolved', issue_id: '123' },
    { kind: 'human', act: 'log in and rotate the key' },
  ]) {
    assert.equal(selfDocumentingRef(dw), null, `${dw.kind} must not self-document`)
  }
})

t('REFUSED: a URL with PROSE GLUED ON — found on the live board by the first preview run', () => {
  // A real row's url reads "https://rlcsuqwqzoqjykdiqjye.supabase.co/rest/v1/ presenting the
  // leaked legacy service_role JWT". A prefix match accepts it; parsing rejects it. This is one
  // of the five ways the 112 fictional finish-tests failed, and it would have put the same
  // fiction into the receipt column.
  assert.equal(selfDocumentingRef({
    kind: 'url_answers',
    url: 'https://rlcsuqwqzoqjykdiqjye.supabase.co/rest/v1/ presenting the leaked legacy service_role JWT',
  }), null)
  assert.equal(selfDocumentingRef({ kind: 'url_answers', url: 'https://x.example/a b' }), null)
  assert.equal(selfDocumentingRef({ kind: 'url_answers', url: 'https://x.example/ok' }), 'https://x.example/ok',
    'a clean URL still works')
})

t('a url_answers whose url is not a real URL gets nothing', () => {
  assert.equal(selfDocumentingRef({ kind: 'url_answers', url: 'the dashboard loads fine' }), null,
    '8 of the 112 fictional finish-tests deleted on 2026-09-03 were prose where a URL belonged')
  assert.equal(selfDocumentingRef({ kind: 'url_answers', url: 'ftp://x.example/y' }), null)
})

t('a test_exits_zero with no path gets nothing', () => {
  assert.equal(selfDocumentingRef({ kind: 'test_exits_zero', path: '   ' }), null)
  assert.equal(selfDocumentingRef({ kind: 'test_exits_zero' }), null)
})

t('an unknown kind, and hostile input, never produce a reference', () => {
  for (const dw of [null, undefined, 'prose', 42, [], {}, { kind: 'vibes' }, { kind: '' }]) {
    assert.equal(selfDocumentingRef(dw), null, `${JSON.stringify(dw)} must not produce a reference`)
  }
})


// ══ WHAT THIS RUN DECIDED, WRITTEN DOWN ═════════════════════════════════════════════════════
// sql/098 added done_when, done_checked_at and done_check_result; grepped across this repo, only
// the first was ever written. Measured after the first real scheduled run on 2026-09-03: 96 rows
// have carried a finish-test and done_checked_at is null on every one. The requirement's §9 gate
// "nothing is fictional" reads done_check_result, so it was pinned at `unknown` for ever.
const NOW = () => '2026-09-03T22:00:00Z'

t('a judged check is stamped with its verdict', () => {
  for (const state of ['pass', 'fail', 'unknown']) {
    assert.deepEqual(evaluationStamp({ state }, NOW),
      { done_checked_at: '2026-09-03T22:00:00Z', done_check_result: state })
  }
})

t('a row LEFT FOR ROGER is not stamped — skip is not a verdict about the check', () => {
  assert.equal(evaluationStamp({ state: 'skip' }, NOW), null)
})

t('hostile input never produces a stamp', () => {
  for (const v of [null, undefined, 'pass', 42, [], {}, { state: 'vibes' }, { state: '' }]) {
    assert.equal(evaluationStamp(v, NOW), null, JSON.stringify(v))
  }
})

t('every judged row is written, and rows without an id are skipped rather than guessed at', async () => {
  const calls = []
  const fetchImpl = async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return { ok: true, status: 204 } }
  const stat = await recordEvaluations([
    { item: { id: 'A', slug: 'a' }, f: { state: 'pass' } },
    { item: { id: 'B', slug: 'b' }, f: { state: 'unknown' } },
    { item: { slug: 'no-id' }, f: { state: 'pass' } },
    { item: { id: 'C', slug: 'c' }, f: { state: 'skip' } },
  ], { env: { SUPABASE_URL: 'http://x', SUPABASE_SERVICE_KEY: 'k' }, fetchImpl, now: NOW })
  assert.equal(stat.written, 2)
  assert.equal(stat.skipped, 2, 'the id-less row and the skipped row')
  assert.equal(calls.length, 2)
  assert.equal(calls[0].body.done_check_result, 'pass')
  assert.equal(calls[1].body.done_check_result, 'unknown')
})

t('a board that refuses the bookkeeping does NOT undo the closing that already happened', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500 })
  const stat = await recordEvaluations([{ item: { id: 'A', slug: 'a' }, f: { state: 'pass' } }],
    { env: { SUPABASE_URL: 'http://x', SUPABASE_SERVICE_KEY: 'k' }, fetchImpl, now: NOW })
  assert.equal(stat.written, 0)
  assert.equal(stat.failed.length, 1, 'reported, never thrown')
  assert.match(stat.failed[0], /HTTP 500/)
})

t('a thrown network error is collected too, not propagated', async () => {
  const fetchImpl = async () => { throw new Error('socket hang up') }
  const stat = await recordEvaluations([{ item: { id: 'A', slug: 'a' }, f: { state: 'fail' } }],
    { env: { SUPABASE_URL: 'http://x', SUPABASE_SERVICE_KEY: 'k' }, fetchImpl, now: NOW })
  assert.equal(stat.failed.length, 1)
  assert.match(stat.failed[0], /socket hang up/)
})

t('an empty or missing result set writes nothing and never throws', async () => {
  const fetchImpl = async () => { throw new Error('should not be called') }
  for (const rs of [undefined, null, []]) {
    const stat = await recordEvaluations(rs, { env: {}, fetchImpl, now: NOW })
    assert.equal(stat.written, 0)
    assert.equal(stat.failed.length, 0)
  }
})

// ══ CLOSER_TEST_ROOTS UNIONS, IT DOES NOT REPLACE ══════════════════════════════════════════
//
// Measured 2026-09-04 across three parallel board sweeps: at least eight open rows are unclosable
// BY CONSTRUCTION because their subject is a script under ~/.claude/scripts or C:/ClaudeShared,
// which testPathIsRunnable refuses — producing UNKNOWN, never FAIL. The variable that was meant to widen the roots was NAMED `extra` and REPLACED them, so the one edit that
// widen the roots was named  and REPLACED them, so the one edit that would have unblocked
// those rows would silently have made every product row unevaluatable instead.
{
  const base = testRoots({})
  assert.ok(base.length >= 1, 'with nothing set there is still a default root')

  const widened = testRoots({ CLOSER_TEST_ROOTS: ['/x/claude-scripts', '/y/shared'].join(delimiter) })
  for (const r of base) {
    assert.ok(widened.includes(r),
      `setting CLOSER_TEST_ROOTS must never drop ${r} — dropping it turns every product row UNKNOWN`)
  }
  assert.ok(widened.includes('/x/claude-scripts'), 'the operator-tooling root is now runnable')
  assert.ok(widened.includes('/y/shared'), 'every listed root is added, not just the first')
  assert.equal(widened.length, base.length + 2, 'union, so nothing is invented either')

  // A root already covered by the default must not be stored twice: a duplicate root makes the
  // same path look like two permissions and is how a later reader miscounts the coverage.
  assert.deepEqual(testRoots({ CLOSER_TEST_ROOTS: base[0] }), base)

  // Blank, whitespace and empty segments are not roots. An empty root would match every path.
  assert.deepEqual(testRoots({ CLOSER_TEST_ROOTS: '' }), base)
  assert.deepEqual(testRoots({ CLOSER_TEST_ROOTS: ['', '   ', ''].join(delimiter) }), base)

  // Hostile input is survived rather than thrown on — this runs unattended, hourly.
  for (const v of [null, undefined, 0, 42, {}, []]) {
    assert.doesNotThrow(() => testRoots({ CLOSER_TEST_ROOTS: v }))
  }
}
