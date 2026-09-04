/**
 * Unit tests for the "Sentry must reach the board" producer.
 *
 * Every fixture below is REAL. The issues are the 13 unresolved Sentry issues read from the live
 * org on 2026-08-27 and the board rows are the `source=sentry` rows read from the production
 * BackOffice database the same afternoon, keys and states verbatim. Tests written against invented
 * data would have passed on all four of the defects this file pins, because all four are shaped by
 * history rather than by logic.
 *
 * Run: node test/check-sentry-issues.test.mjs   (exit 0 = all pass)
 */
import assert from 'node:assert'
import {
  isLiveEnvironment, liveEnvironments, candidateKeys, keyFor, severityFor, signalFor, reconcile,
  isCredentialRefusal,
  readWithRetry, READ_ATTEMPTS, FILED_BY,
  nextCursor,
  MAX_ISSUE_PAGES,
} from '../scripts/check-sentry-issues.mjs'

let n = 0
const t = (name, fn) => { fn(); n++; console.log(`  ok - ${name}`) }
const ta = async (name, fn) => { await fn(); n++; console.log(`  ok - ${name}`) }

// ── the live org, 2026-08-27 ──────────────────────────────────────────────────
const ORG_ENVIRONMENTS = [
  { name: '127.0.0.1' }, { name: 'production' }, { name: 'staging' },
  { name: 'staging.backoffice.predivo.ch' }, { name: 'staging.replyflow.help' },
  { name: 'staging.valrano.com' },
]

const issue = (o) => ({ environments: ['production'], level: 'error', count: 1, userCount: 0, ...o })

/** The eight unresolved issues seen in a live environment on 2026-08-27. */
const B7 = issue({
  id: '141893005', shortId: 'BACKOFFICE-7', project: 'backoffice', culprit: 'sync-outreach',
  title: 'Error: Smartlead HTTP 401: {"message":"Plan expired!"}',
  count: 33, userCount: 33, firstSeen: '2026-08-20T16:40:04Z', lastSeen: '2026-08-27T13:46:32Z',
  permalink: 'https://predivo-gmbh.sentry.io/issues/141893005/',
})
const RFEC = issue({
  id: '141988808', shortId: 'REPLYFLOW-EDGE-C', project: 'replyflow-edge', culprit: 'refresh-tokens',
  title: 'Error: Failed to query expiring tokens: JWT issued at future',
  count: 2, userCount: 2, firstSeen: '2026-08-21T07:00:04Z', lastSeen: '2026-08-26T21:00:02Z',
  environments: ['production', 'staging'],
})
const RFED = issue({
  id: '142824015', shortId: 'REPLYFLOW-EDGE-D', project: 'replyflow-edge', culprit: 'fetch-reviews',
  title: 'Error: Failed to fetch reviews: 503 {',
  count: 2, userCount: 2, firstSeen: '2026-08-25T16:02:11Z', lastSeen: '2026-08-26T07:46:10Z',
})
const CM2 = issue({
  id: '142639646', shortId: 'CHANNELMOVER-2', project: 'channelmover', culprit: 'postmark-webhook',
  title: 'Error: no profile for bounced address',
  count: 3, userCount: 3, firstSeen: '2026-08-24T21:02:42Z', lastSeen: '2026-08-25T09:57:31Z',
  environments: ['production', 'staging'],
})
const BA = issue({
  id: '142091323', shortId: 'BACKOFFICE-A', project: 'backoffice', culprit: 'support-send-due',
  title: 'InvalidData: received corrupt message of type InvalidContentType',
  count: 8, userCount: 7, firstSeen: '2026-08-21T14:50:01Z', lastSeen: '2026-08-24T15:50:01Z',
  environments: ['production', 'staging'],
})
/** Staging-only, and the sharpest one: the money defect the audit called a production loss. */
const B8 = issue({
  id: '141993436', shortId: 'BACKOFFICE-8', project: 'backoffice', culprit: 'stripe-webhook',
  title: 'Error: No USD->CHF reference rate for 2026-08-21 - invoice created without CHF amounts and NO journal posted',
  count: 1, userCount: 1, firstSeen: '2026-08-21T07:26:22Z', lastSeen: '2026-08-21T07:26:22Z',
  environments: ['staging'],
})

/** `source=sentry` rows on the PRODUCTION board, 2026-08-27, keys and states verbatim. */
const BOARD = [
  // Six key conventions for one source. This is what a hand-filed feed looks like.
  { key: '141893005', state: 'resolved', resolved_at: '2026-08-21T13:16:58.301272+00:00', detail: {}, title: "BACKOFFICE-7 - Smartlead HTTP 401 'Plan expired!' misclassified as a generic error" },
  { key: '141988808', state: 'resolved', resolved_at: '2026-08-21T08:01:45.569079+00:00', detail: {}, title: 'REPLYFLOW-EDGE-C - Failed to query expiring tokens' },
  { key: 'REPLYFLOW-EDGE-D', state: 'resolved', resolved_at: '2026-08-26T18:03:17.669271+00:00', detail: {}, title: 'REPLYFLOW-EDGE-D - Failed to fetch reviews: 503' },
  { key: 'sentry:142639646', state: 'resolved', resolved_at: '2026-08-24T21:53:53.424639+00:00', detail: {}, title: 'CHANNELMOVER-2 - postmark-webhook records a bounce for an address with no profile' },
  { key: '142091323', state: 'open', resolved_at: null, detail: {}, title: 'BACKOFFICE-A - support-send-due throws InvalidData in PROD' },
  { key: 'BACKOFFICE-9', state: 'open', resolved_at: null, detail: {}, title: '[not live] BACKOFFICE-9 - stripe-webhook leaves a sale unbooked when the ECB FX lookup blips' },
]

// ── the bar ───────────────────────────────────────────────────────────────────
t('production is live', () => assert.equal(isLiveEnvironment('production'), true))

t('every spelling of staging this org actually uses is not live', () => {
  for (const e of ['staging', 'staging.valrano.com', 'staging.backoffice.predivo.ch', 'staging.replyflow.help']) {
    assert.equal(isLiveEnvironment(e), false, e)
  }
})

t('a developer laptop is not live', () => {
  assert.equal(isLiveEnvironment('127.0.0.1'), false)
  assert.equal(isLiveEnvironment('localhost'), false)
  assert.equal(isLiveEnvironment('development'), false)
})

// The direction of the mistake matters more than the rule. An allow list would drop these.
t('an environment nobody taught this script about counts as LIVE, never as silence', () => {
  assert.equal(isLiveEnvironment('prod'), true)
  assert.equal(isLiveEnvironment('live'), true)
  assert.equal(isLiveEnvironment('www.replyflow.help'), true)
})

t('the live org resolves to exactly one live environment today, and it is production', () => {
  assert.deepEqual(liveEnvironments(ORG_ENVIRONMENTS), ['production'])
})

t('the staging-only money defect does NOT become a signal, and that is the bar working', () => {
  // BACKOFFICE-8 is the "invoice created without CHF amounts" error. The audit called it a
  // production loss; its only event is tagged environment `staging`, and the production invoices
  // table holds two rows, both from July. A bar that let it through would be filing a staging
  // test as a live money incident.
  assert.equal(B8.environments.every((e) => !isLiveEnvironment(e)), true)
  const plan = reconcile([B7, RFEC, RFED, CM2, BA], BOARD)
  const touched = [...plan.file, ...plan.reopen, ...plan.leave].map((x) => x.issue.shortId)
  assert.equal(touched.includes('BACKOFFICE-8'), false)
})

// ── dedup: one issue, one row, whatever the board called it before ────────────
t('all three historic key conventions are recognised as the same issue', () => {
  assert.deepEqual(candidateKeys(B7), ['BACKOFFICE-7', '141893005', 'sentry:141893005'])
})

t('a row filed by hand under the numeric id is ADOPTED, not duplicated', () => {
  assert.equal(keyFor(B7, BOARD), '141893005')
})

t('a row filed by hand under `sentry:<id>` is adopted too', () => {
  assert.equal(keyFor(CM2, BOARD), 'sentry:142639646')
})

t('a row filed under the shortId is adopted as-is', () => {
  assert.equal(keyFor(RFED, BOARD), 'REPLYFLOW-EDGE-D')
})

t('an issue the board has never seen gets the shortId, which is stable per issue forever', () => {
  assert.equal(keyFor(RFEC, []), 'REPLYFLOW-EDGE-C')
})

t('filing the same issue twice targets the same key both times, so it can only ever upsert', () => {
  const first = signalFor(RFEC, keyFor(RFEC, []))
  const second = signalFor({ ...RFEC, count: 9, lastSeen: '2026-08-27T09:00:00Z' }, keyFor(RFEC, []))
  assert.equal(first.key, second.key)
  assert.equal(first.source, second.source)
})

// ── the disagreement, which already exists in both directions ─────────────────
t('resolved on the board, seen again since: Sentry wins and it REOPENS', () => {
  const plan = reconcile([B7], BOARD)
  assert.equal(plan.reopen.length, 1)
  assert.equal(plan.reopen[0].key, '141893005')
})

t('resolved on the board, nothing seen since: the board wins and it stays resolved', () => {
  // REPLYFLOW-EDGE-D last fired 08-26T07:46; the board closed it 08-26T18:03. A fix that worked
  // produces no new events, and "Sentry always wins" would reopen it for no reason at all.
  const plan = reconcile([RFED], BOARD)
  assert.equal(plan.reopen.length, 0)
  assert.equal(plan.leave.length, 1)
})

t('the whole live set, against the real board, splits the way the evidence says', () => {
  const plan = reconcile([B7, RFEC, RFED, CM2, BA], BOARD)
  assert.deepEqual(plan.reopen.map((x) => x.issue.shortId).sort(), ['BACKOFFICE-7', 'CHANNELMOVER-2', 'REPLYFLOW-EDGE-C'])
  assert.deepEqual(plan.leave.map((x) => x.issue.shortId), ['REPLYFLOW-EDGE-D'])
  assert.deepEqual(plan.file.map((x) => x.issue.shortId), ['BACKOFFICE-A'])
  assert.equal(plan.file[0].refresh, true)
})

t('an already-open row is refreshed, never filed a second time', () => {
  const plan = reconcile([BA], BOARD)
  assert.equal(plan.file.length, 1)
  assert.equal(plan.file[0].key, '142091323')
  assert.equal(plan.file[0].refresh, true)
})

// ── what it must never touch ──────────────────────────────────────────────────
t('a hand-filed row this producer did not create is NEVER auto-resolved', () => {
  // BACKOFFICE-9 is open on the board and staging-only in Sentry, so it is not in the live set.
  // Its title starts "[not live]" because a person judged it and said so. Tidying it away would
  // be a machine deleting that judgement.
  const plan = reconcile([B7, RFEC, RFED, CM2, BA], BOARD)
  assert.deepEqual(plan.resolve.map((x) => x.row.key), [])
})

t('a row THIS producer filed is resolved once Sentry stops listing the issue', () => {
  const mine = [{ key: 'REPLYFLOW-EDGE-D', state: 'open', resolved_at: null, detail: { filed_by: FILED_BY }, title: 'x' }]
  const plan = reconcile([], mine)
  assert.deepEqual(plan.resolve.map((x) => x.row.key), ['REPLYFLOW-EDGE-D'])
})

t('a row this producer filed is not resolved while the issue is still live', () => {
  const mine = [{ key: 'REPLYFLOW-EDGE-D', state: 'open', resolved_at: null, detail: { filed_by: FILED_BY }, title: 'x' }]
  assert.equal(reconcile([RFED], mine).resolve.length, 0)
})

// ── what the board is told ────────────────────────────────────────────────────
// ── what may ring a phone, and what may not (Roger's decision, 2026-09-04, option C) ──────────
//
// The rule this pins is the whole point of the 2026-09-02 post-mortem: this producer SAW the
// "Unregistered API key" outage and filed it, and the grading silenced it. B7 (`Smartlead HTTP
// 401: Plan expired!`) and RFEC (`JWT issued at future`) are REAL fixtures read from the live org
// on 2026-08-27, and both are refusals — so the old assertion "nothing here can ever ring a phone"
// was, on this very data, asserting the defect.

t('an ordinary application error still cannot ring a phone', () => {
  for (const i of [RFED, CM2, BA]) {
    const sig = signalFor(i, keyFor(i, BOARD))
    // upsert_signal is only eligible to page on needs_human AND critical. An application error is
    // code, so a machine owns it: "Needs you" on this board means it needs ROGER.
    assert.equal(sig.needs_human, false, i.shortId)
    assert.notEqual(sig.severity, 'critical', i.shortId)
  }
})

t('a REFUSED CREDENTIAL rings, because no machine here can mint a replacement key', () => {
  for (const i of [B7, RFEC]) {
    const sig = signalFor(i, keyFor(i, BOARD))
    assert.equal(sig.needs_human, true, i.shortId)
    assert.equal(sig.severity, 'critical', i.shortId)
    assert.match(sig.summary, /A key or login was REFUSED/, i.shortId)
  }
})

t('the outage that started this would now page — both halves of it', () => {
  const unregistered = (culprit) => ({
    id: '1', shortId: 'REPLYFLOW-EDGE-J', project: 'replyflow-edge', level: 'error',
    title: `Error: ${culprit}: Unregistered API key`, culprit, count: 35, userCount: 0,
    firstSeen: '2026-09-02T20:29:29Z', lastSeen: '2026-09-02T21:02:11Z', environments: ['production'],
  })
  for (const c of ['Failed to recover stale jobs', 'Failed to query expiring tokens']) {
    const sig = signalFor(unregistered(c), 'k')
    assert.equal(sig.severity, 'critical', c)
    assert.equal(sig.needs_human, true, c)
  }
})

t('a person saying "this is not live" is never overridden by the pattern', () => {
  // Both wordings are real board rows. Without this, option C would page for a defect that is not
  // in production and for one that was already fixed — the two false pages option B could not avoid.
  const staging = { id: '2', shortId: 'BACKOFFICE-9', project: 'backoffice', level: 'error', count: 15, userCount: 0, environments: [], title: '[not live] stripe-webhook returns HTTP 401 when the FX lookup blips' }
  const cleared = { id: '3', shortId: 'BACKOFFICE-4', project: 'backoffice', level: 'error', count: 15, userCount: 0, environments: [], title: 'Cleared in Sentry: backoffice is throwing an error: unauthorized' }
  for (const i of [staging, cleared]) {
    assert.equal(isCredentialRefusal(i), false, i.shortId)
    assert.equal(signalFor(i, 'k').needs_human, false, i.shortId)
  }
})

t('a token being READ is not a token being REFUSED', () => {
  // "Failed to query expiring tokens" alone is a table read, not a rejection. Matching bare
  // `token` would have paged for every customer-token query in the fleet.
  assert.equal(isCredentialRefusal({ title: 'Error: Failed to query expiring tokens: timeout' }), false)
  assert.equal(isCredentialRefusal({ title: 'Error: Failed to query expiring tokens: JWT expired' }), true)
})

t('the refusal is judged on the words, never on Sentry\'s level', () => {
  // severityFor() would call this one "warning"; the content is what decides.
  const i = { title: 'Error: Unregistered API key', level: 'warning', count: 1, userCount: 0, environments: [] }
  assert.equal(severityFor(i), 'warning')
  assert.equal(signalFor(i, 'k').severity, 'critical')
})

t('severity is Sentry\'s own level, not a guess', () => {
  assert.equal(severityFor({ level: 'fatal' }), 'critical')
  assert.equal(severityFor({ level: 'error' }), 'warning')
  assert.equal(severityFor({ level: 'info' }), 'info')
})

t('the signal names the product, the consequence and where the fix starts', () => {
  const sig = signalFor(B7, keyFor(B7, BOARD))
  assert.match(sig.title, /^backoffice is throwing an error: /)
  assert.match(sig.summary, /Seen 33 times since 2026-08-20/)
  assert.match(sig.summary, /33 users affected/)
  assert.match(sig.summary, /sync-outreach/)
  assert.equal(sig.product, 'backoffice')
  assert.equal(sig.link, 'https://predivo-gmbh.sentry.io/issues/141893005/')
  assert.equal(sig.detail.filed_by, FILED_BY)
})

t('a one-off error reads as one, not as "Seen 1 times"', () => {
  assert.match(signalFor(RFED, 'k').summary, /Seen 2 times/)
  assert.match(signalFor({ ...RFED, count: 1, userCount: 0 }, 'k').summary, /Seen once/)
})

t('every environment the issue was seen in is on the row, so nobody has to guess', () => {
  assert.match(signalFor(CM2, 'k').summary, /in production, staging/)
  assert.deepEqual(signalFor(CM2, 'k').detail.environments, ['production', 'staging'])
})

// ── one bad second upstream is not our emergency (run 33539154299, 2026-09-01) ────────

/** A read that fails `failures` times with the given error, then succeeds. */
const flaky = (failures, err) => {
  let calls = 0
  const read = async () => {
    calls++
    if (calls <= failures) throw err()
    return { ok: calls }
  }
  return { read, calls: () => calls }
}
const transientErr = () => {
  const e = new Error('Sentry GET /x -> HTTP 500'); e.transient = true; return e
}
const noWait = { sleep: async () => {}, log: () => {} }

await ta('a single Sentry 500 is retried, not reported as an outage', async () => {
  const f = flaky(1, transientErr)
  assert.deepEqual(await readWithRetry(f.read, 'sentry', noWait), { ok: 2 })
  assert.equal(f.calls(), 2)
})

await ta('a 500 on every attempt still fails the run, and says it was every attempt', async () => {
  const f = flaky(99, transientErr)
  await assert.rejects(
    () => readWithRetry(f.read, 'sentry', noWait),
    (e) => e.message.endsWith('HTTP 500 (3 attempts, all transient failures)'),
  )
  assert.equal(f.calls(), READ_ATTEMPTS)
})

await ta('a dead token fails on the FIRST try - a 401 is an answer, not a hiccup', async () => {
  const f = flaky(99, () => new Error('Sentry GET /x -> HTTP 401'))
  await assert.rejects(
    () => readWithRetry(f.read, 'sentry', noWait),
    (e) => e.message === 'Sentry GET /x -> HTTP 401',
  )
  assert.equal(f.calls(), 1, 'a real credential failure must not be retried into a slow red')
})

await ta('the retry waits between attempts instead of hammering the upstream', async () => {
  const waits = []
  const f = flaky(2, transientErr)
  await readWithRetry(f.read, 'sentry', { sleep: async (ms) => { waits.push(ms) }, log: () => {} })
  assert.deepEqual(waits, [5000, 5000])
})

// ── ONE PAGE IS NOT THE POPULATION (2026-09-02 audit) ────────────────────────────────────────
// The issue query asked for limit=100 and read whatever came back with no cursor, so issue 101 was
// absent from `covered` - and reconcile() auto-resolves everything this producer filed and did not
// re-cover, writing "Sentry no longer lists this as an unresolved error" over a live one.

t('a Link header offering more results yields the cursor to follow', () => {
  const link = '<https://sentry.io/x>; rel="previous"; results="false"; cursor="0:0:1", '
    + '<https://sentry.io/x>; rel="next"; results="true"; cursor="0:100:0"'
  assert.equal(nextCursor(link), '0:100:0')
})

t('the last page yields no cursor, so the loop stops instead of spinning', () => {
  assert.equal(nextCursor('<https://x>; rel="next"; results="false"; cursor="0:200:0"'), null)
  assert.equal(nextCursor(null), null)
  assert.equal(nextCursor(''), null)
})

t('there is a hard page ceiling, so a runaway list fails rather than judging on part of it', () => {
  assert.ok(MAX_ISSUE_PAGES > 1 && MAX_ISSUE_PAGES <= 50, 'a ceiling must exist and be sane')
})

console.log(`\n${n} tests passed.`)
