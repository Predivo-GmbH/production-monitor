/**
 * Unit tests for board-drainer's pure decision logic:
 *  - classify(): owner routing + hard-escalate gate (destructive/human classes never dispatch)
 *  - verdictToUpsert(): the receipt-guard (never close without a verified receipt)
 * Run: node test/board-drainer.test.mjs   (exit 0 = all pass)
 */
import assert from 'node:assert'
import { classify, verdictToUpsert, meetsThreshold, scoutReportToIncident, stuckWhoMustAct, stuckRootCause, isScoutDerived, selectWorkQueue, timeoutCostsAnAttempt, AGENT_TIMED_OUT, boardQueryUrl, signalToIncident, writableToIncidentBoard, workableFinding, parkedFields, gateFor, stripCode, actionOf, plainTitle, titleObjections, workItemSlugFor, handoffPrompt, routeToWorkBoard, prose, DEPLOY_DENY_TOOLS, agentToolFlags, signalObjects, signalPhrases, matchItem, findJoinTarget, joinMarker, expectedBusinessApplies, handedOverClearsCounter, parkedHandoverQueue, mintOpenedAt } from '../scripts/board-drainer.mjs'

let n = 0
const t = (name, fn) => { fn(); n++; console.log(`  ok - ${name}`) }

// ── the direct-deploy bypass is closed (2026-08-25 ChannelMover incident) ────────
// A dispatched fix agent must not be able to reach production by running
// `supabase functions deploy` directly from a stale checkout — the guard is the only path.
t('DEPLOY_DENY_TOOLS covers every direct edge-function deploy form', () => {
  for (const form of [
    'supabase functions deploy',
    'npx supabase functions deploy',
    'npm exec supabase functions deploy',
    'pnpm dlx supabase functions deploy',
    'yarn supabase functions deploy',
    'bunx supabase functions deploy',
  ]) {
    assert.ok(DEPLOY_DENY_TOOLS.includes(`Bash(${form}:*)`), `deny list must cover: ${form}`)
  }
})
t('agentToolFlags actually WIRES the deny list into the dispatch (--disallowedTools)', () => {
  const flags = agentToolFlags('Read,Edit,Bash(node:*)')
  const i = flags.indexOf('--disallowedTools')
  assert.ok(i >= 0, 'every dispatched agent must carry --disallowedTools')
  const deny = flags[i + 1]
  assert.ok(deny.includes('Bash(npx supabase functions deploy:*)'), 'npx deploy must be denied')
  assert.ok(deny.includes('Bash(supabase functions deploy:*)'), 'bare deploy must be denied')
  // the allow list still passes through untouched
  const a = flags.indexOf('--allowedTools')
  assert.ok(a >= 0 && flags[a + 1] === 'Read,Edit,Bash(node:*)', 'allow list must be preserved')
})

// ── classify (every incident is dispatched; mode = fix | verify) ────────────────
t('owner=Roger -> VERIFY-only (read-only: close-if-green or escalate)', () => {
  const c = classify({ who_must_act: 'Roger - Google OAuth re-auth', root_cause: '', title: '' })
  assert.equal(c.mode, 'verify'); assert.equal(c.owner, 'roger')
})
t('owner=Claude, plain infra fix -> FIX mode', () => {
  const c = classify({ who_must_act: 'Claude: fix stale spec assertion', root_cause: 'test drift', title: '' })
  assert.equal(c.mode, 'fix'); assert.equal(c.owner, 'claude')
})
t('Claude-owned but SECRET rotation -> VERIFY-only (hard-escalate class)', () => {
  const c = classify({ who_must_act: 'Claude - rotate the Supabase service key', root_cause: 'legacy key disabled', title: '' })
  assert.equal(c.mode, 'verify'); assert.equal(c.owner, 'roger')
})
t('Claude-owned but DESTRUCTIVE delete -> VERIFY-only', () => {
  const c = classify({ who_must_act: 'Claude - delete the stale connection row', root_cause: '', title: '' })
  assert.equal(c.mode, 'verify')
})
t('Claude-owned but PAYMENT -> VERIFY-only', () => {
  const c = classify({ who_must_act: 'Claude - issue a refund via Stripe dashboard', root_cause: '', title: '' })
  assert.equal(c.mode, 'verify')
})
t('unowned/unknown -> FIX mode (never park on Roger)', () => {
  const c = classify({ who_must_act: '', root_cause: 'CI step failed', title: 'build red' })
  assert.equal(c.mode, 'fix'); assert.equal(c.owner, 'claude')
})
t('vendor PLAN EXPIRED -> NOTE mode (upsert expected, never worked/escalated)', () => {
  const c = classify({ who_must_act: 'Roger - renew the Smartlead plan', root_cause: 'HTTP 401 Plan expired', title: 'BackOffice Outreach: sync failed (Smartlead plan expired)' })
  assert.equal(c.mode, 'note'); assert.equal(c.owner, 'none')
})

// ── verdictToUpsert receipt-guard ──────────────────────────────────────────────
const inc = { source: 'production-monitor', key: 'k1', title: 'x', severity: 'warning' }
t('fixed WITHOUT receipt -> downgraded to investigating (never a shallow close)', () => {
  const p = verdictToUpsert(inc, { class: 'C-CLOSED', status: 'fixed', action: 'looks fine', receipt: '' })
  assert.equal(p.p_status, 'investigating')
})
t('fixed WITH receipt -> closes as fixed', () => {
  const p = verdictToUpsert(inc, { class: 'A-INFRA', status: 'fixed', action: 'pushed abc123', receipt: 'monitor run 999 green' })
  assert.equal(p.p_status, 'fixed'); assert.equal(p.p_who_must_act, null)
})
t('blocked -> carries who_must_act for Roger', () => {
  const p = verdictToUpsert(inc, { class: 'D-ESCALATE', status: 'blocked', action: 'none', who_must_act: 'Roger - do X' })
  assert.equal(p.p_status, 'blocked'); assert.match(p.p_who_must_act, /Roger - do X/)
})

// ── "expected business state" must not silence a row whose own fix is undeployed ──────────
// Measured 2026-09-01: the /signals "App errors" tile read 0 while nine unresolved production
// errors sat in Sentry. Row sentry/141893005 had flip_count 12 - the wire reopening it hourly
// because Sentry saw the error again, and this classifier muting it hourly - while its own
// detail.actionTaken said "still-blocked". Every assertion below fails against the old rule,
// which was a bare EXPECTED_BUSINESS.test(text).

t('a lapsed vendor plan with NO outstanding remediation is still expected — unchanged', () => {
  const inc = { title: 'backoffice is throwing an error: Error: Smartlead HTTP 401: {"message":"Plan expired!"}', root_cause: '', who_must_act: '' }
  assert.equal(expectedBusinessApplies(inc), true, 'muting a lapsed vendor plan is correct and must not change')
  assert.equal(classify(inc).mode, 'note')
})

t('THE LIVE FAILURE: the same row is NOT expected once it reports still-blocked', () => {
  const inc = {
    title: 'backoffice is throwing an error: Error: Smartlead HTTP 401: {"message":"Plan expired!"}',
    root_cause: '', who_must_act: '', action_taken: 'still-blocked',
  }
  assert.equal(expectedBusinessApplies(inc), false, 'a row that says its own fix is undeployed is not a settled business state')
  assert.notEqual(classify(inc).mode, 'note', 'it must fall through to normal classification, not be muted')
})

t('the disarm is narrow: only still-blocked, and case/space tolerant', () => {
  const base = { title: 'Smartlead HTTP 401 Plan expired', root_cause: '', who_must_act: '' }
  for (const v of ['still-blocked', 'STILL-BLOCKED', '  Still-Blocked  ']) {
    assert.equal(expectedBusinessApplies({ ...base, action_taken: v }), false, `must disarm on ${JSON.stringify(v)}`)
  }
  // Anything else keeps the old behaviour exactly - the failure being fixed is a row that
  // ANNOUNCED it was stuck and got muted anyway, not a row nobody has looked at yet.
  for (const v of [null, undefined, '', 'fixed', 'deployed', 'no-action']) {
    assert.equal(expectedBusinessApplies({ ...base, action_taken: v }), true, `must NOT disarm on ${JSON.stringify(v)}`)
  }
})

t('a row with no vendor-plan wording is unaffected either way', () => {
  const inc = { title: 'checkout throws on empty basket', root_cause: '', who_must_act: '', action_taken: 'still-blocked' }
  assert.equal(expectedBusinessApplies(inc), false)
})

t('signalToIncident carries actionTaken through — it used to be dropped here', () => {
  // This is the whole reason the contradiction could persist for twelve consecutive hours:
  // the field existed on the signal and never reached the classifier.
  const inc = signalToIncident({
    source: 'sentry', key: '141893005', title: 'Plan expired', severity: 'warning',
    state: 'open', summary: null, first_seen_at: '2026-08-20T00:00:00Z',
    detail: { actionTaken: 'still-blocked', by: 'board-drainer', class: 'EXPECTED' },
  })
  assert.equal(inc.action_taken, 'still-blocked')
  assert.equal(expectedBusinessApplies(inc), false)
})

console.log(`\n${n} assertions passed.`)


// ── PHASE 4: severity threshold (Roger's call 2026-08-20, replacing a bare MAX_PER_RUN=3) ──
const RANK = { critical: 3, warning: 2, info: 1 }

t('threshold warning: critical and warning are worked, info is not', () => {
  assert.equal(meetsThreshold({ severity: 'critical' }, RANK.warning), true)
  assert.equal(meetsThreshold({ severity: 'warning' }, RANK.warning), true)
  assert.equal(meetsThreshold({ severity: 'info' }, RANK.warning), false)
})

t('threshold critical: only critical is worked', () => {
  assert.equal(meetsThreshold({ severity: 'critical' }, RANK.critical), true)
  assert.equal(meetsThreshold({ severity: 'warning' }, RANK.critical), false)
})

t('threshold info: everything is worked', () => {
  for (const sev of ['critical', 'warning', 'info']) {
    assert.equal(meetsThreshold({ severity: sev }, RANK.info), true)
  }
})

t('an UNKNOWN severity is never silently skipped', () => {
  // A row we cannot grade must go ABOVE the bar, not below. Skipping the ungradeable is how
  // a threshold quietly becomes a blind spot.
  assert.equal(meetsThreshold({ severity: null }, RANK.critical), true)
  assert.equal(meetsThreshold({ severity: 'nonsense' }, RANK.critical), true)
  assert.equal(meetsThreshold({}, RANK.critical), true)
})

// ── PHASE 4: scout reports enter through the SAME unchanged boundary ──────────────────
const rep = (o = {}) => ({
  id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', product: 'replyflow',
  function_name: 'connect-platform', operation: 'oauth',
  message_pattern: 'No stored tokens, restart OAuth flow',
  occurrences: 38, distinct_users: 4, authenticated: true,
  sample_evidence: { user_id: 'u1' }, narrative: 'users dead-end in OAuth',
  state_reason: 'confirmed by replay', ...o,
})

t('a scout report that hit a signed-in user maps to severity=warning', () => {
  assert.equal(scoutReportToIncident(rep()).severity, 'warning')
})

t('an anonymous-but-human-approved report maps to info, never critical', () => {
  const inc = scoutReportToIncident(rep({ authenticated: false }))
  assert.equal(inc.severity, 'info')
  assert.notEqual(inc.severity, 'critical')
})

t('a scout report carries its id so the loop can be closed back', () => {
  assert.equal(scoutReportToIncident(rep()).scoutReportId, rep().id)
})

t("a UX report about users dead-ending in OAuth is a PRODUCT-CODE fix, not Roger's OAuth hands", () => {
  // REWRITTEN 2026-08-27. This test used to assert verify-only "because OAuth is in HUMAN_HANDS",
  // and that sentence WAS the defect: the report describes customers failing to complete an OAuth
  // flow in `connect-platform`, which is a bug in our code and stops at staging like every other
  // product fix. Nothing here asks Roger to press anything. The autonomy boundary did not widen —
  // it is the same boundary, finally reading the request instead of counting the word "oauth".
  const c = classify(scoutReportToIncident(rep()))
  assert.equal(c.mode, 'fix')
  assert.equal(c.owner, 'claude')
  assert.equal(c.handoff, false)
})

t("REGRESSION GUARD: a scout report that asks for ROGER'S OWN re-auth still escalates", () => {
  // The genuine version of the case above: the action needed is Roger reconnecting his account,
  // and no code change substitutes for it.
  const c = classify(scoutReportToIncident(rep({
    message_pattern: 'Roger must reconnect the Google account by hand before any sync can run',
    narrative: 'the refresh grant was revoked at the provider',
  })))
  assert.equal(c.mode, 'verify')
  assert.equal(c.owner, 'roger')
  assert.equal(c.gate, 'human-hands')
})

t('a plain UX copy fix from the scout is Claude-owned and fixable', () => {
  const c = classify(scoutReportToIncident(rep({
    message_pattern: 'empty state gives no guidance',
    narrative: 'the empty state text does not tell the user where to go',
    state_reason: 'copy only',
  })))
  assert.equal(c.owner, 'claude')
  assert.equal(c.mode, 'fix')
})

t('a scout report asking for a DB delete still hard-escalates', () => {
  const c = classify(scoutReportToIncident(rep({
    message_pattern: 'orphan rows should be deleted from the connections table',
    narrative: 'drop the orphaned rows',
  })))
  assert.equal(c.mode, 'verify')
})


// ── stuck-escalation ownership (incident board-drainer-stuck-escalates-to-roger, 2026-08-20) ──
// Roger's 2026-08-12 hard rule: a CODE fix must never end up sitting on him. The old block
// hardcoded "Roger - ..." on every stuck item and CONCATENATED onto the previous string.

t('a stuck CODE fix keeps Claude as the owner, it does not land on Roger', () => {
  const r = stuckWhoMustAct('Claude - fix the failing spec in gate-a-crawl.spec.ts')
  assert.equal(r.owner, 'Claude')
  assert.match(r.value, /^Claude - fix the failing spec/)
})

t("a stuck action that genuinely needs Roger's hands IS re-owned to Roger", () => {
  assert.equal(stuckWhoMustAct('Claude - reconnect the Google OAuth account').owner, 'Roger')
  assert.equal(stuckWhoMustAct('Claude - the vendor plan expired, renew the payment').owner, 'Roger')
})

t('the stuck prefix can NEVER compound across repeated passes', () => {
  // This is the exact shape observed live: the boilerplate was prepended again each pass.
  let v = 'Claude - fix the runner permissions'
  for (let i = 0; i < 5; i++) v = stuckWhoMustAct(v).value
  assert.equal(v, 'Claude - fix the runner permissions')
  assert.equal((v.match(/could not resolve/g) || []).length, 0)
})

t('an already-compounded string is CLEANED, not appended to', () => {
  const dirty = 'Roger - board-drainer could not resolve after 3 tries; Claude - fix kb-learning/RUNNER.md'
  const r = stuckWhoMustAct(dirty)
  assert.equal(r.priorAction, 'fix kb-learning/RUNNER.md')  // owner prefix stripped, re-added once
  assert.equal(r.owner, 'Claude')
})

t('an empty who_must_act degrades to a safe, ownable action', () => {
  const r = stuckWhoMustAct(null)
  assert.equal(r.value, 'Claude - investigate manually')
})

t('a closer-written Roger owner is KEPT when no gate fires — never re-derived back to Claude', () => {
  // The misroute behind board-drainer-human-hands-regex-matches-billing-nouns: a human-owned
  // task with no hard gate ("enter the figures only Roger knows") was demoted to Claude on
  // every stuck pass, so a write-enabled run kept grabbing work it could never finish.
  const r = stuckWhoMustAct('Roger - open the recurring_costs registry in BackOffice and enter the amount + renewal date for the 4 UNVERIFIED rows.')
  assert.equal(r.owner, 'Roger')
  assert.match(r.value, /^Roger - open the /)
})

t('a Roger prefix the sentence itself DISOWNS still goes back to Claude', () => {
  // Same split as classify(): "blocked only because that run had no write tools" is a fact
  // about the RUN, never about the owner — the row re-queues to a write-enabled run.
  const r = stuckWhoMustAct('Roger - re-dispatch to a write-authorized run — NOT a Roger gate: no decision/secret/payment/OAuth')
  assert.equal(r.owner, 'Claude')
  assert.match(r.value, /^Claude - re-dispatch/)
})


// ── a scout item must NEVER reach the incidents board ────────────────────────────────
// monitoring_incidents.source CHECK allows only
// healthchecks|sentry|production-monitor|cron|silent-failure. Writing scout-ux 400s, the
// throw escaped the loop, worked_at was never set, and the same report re-dispatched an
// Opus agent every tick forever with MAX_ATTEMPTS never tripping. The guard is now
// structural, not a convention. (incident ...scout-ux-source-violates-incident-check-constraint)

t('a scout-derived item is recognised by its report id', () => {
  assert.equal(isScoutDerived(scoutReportToIncident(rep())), true)
})

t('a scout-derived item is recognised by source alone, even without an id', () => {
  assert.equal(isScoutDerived({ source: 'scout-ux' }), true)
})

t('a normal incident is NOT scout-derived, so the board path is untouched', () => {
  for (const src of ['healthchecks', 'sentry', 'production-monitor', 'cron', 'silent-failure']) {
    assert.equal(isScoutDerived({ source: src }), false, src)
  }
  assert.equal(isScoutDerived(null), false)
  assert.equal(isScoutDerived(undefined), false)
})

t('CONSTRAINT GUARD: no scout source is one the incidents CHECK accepts', () => {
  // If anyone ever "fixes" this by renaming the source instead of keeping reports off the
  // board, this test fails and says why.
  const ALLOWED = ['healthchecks', 'sentry', 'production-monitor', 'cron', 'silent-failure']
  const inc = scoutReportToIncident(rep())
  assert.ok(!ALLOWED.includes(inc.source),
    'scout items must stay OFF monitoring_incidents; reports are free, alarms are not')
  assert.equal(isScoutDerived(inc), true, 'and must therefore be caught by the guard')
})

// ── selectWorkQueue: the head-of-line deadlock ────────────────────────────────────────────
//
// THE REGRESSION THESE GUARD. On 2026-08-24 the drainer was found to have dispatched ZERO fix
// agents since 2026-08-23T09:36:57Z while running every 20 minutes — ~90 runs, 138 no-op
// re-escalations on the final day alone. Cause: the board is read oldest-first, the eligible
// list was sliced to MAX_PER_RUN=3, and the three OLDEST items were all frozen at the attempt
// ceiling. They consumed the entire per-run budget on every run, forever, and the 31 fixable
// items behind them were never looked at. The tests below fail on that code and pass on this.

const wq = (key, over = {}) => ({ inc: { key, source: 'silent-failure', severity: 'warning', title: key, ...over }, cls: { mode: 'fix', owner: 'claude' } })
const atCeiling = { 'stuck-1': 3, 'stuck-2': 3, 'stuck-3': 3 }
// The deadlock tests below isolate ONE dimension: what a parked pile does to the dispatch budget.
// Since 2026-08-27 a second dimension exists — one parked item is revived every 24 hours (Plan B
// B3 part 2) — so these fixtures say "the scheduled retry already fired" to keep the two apart.
// The retry's own behaviour is pinned by its own block at the end of this file.
const justRetried = () => ({ lastParkedRetryAt: new Date().toISOString() })

t('DEADLOCK: three ceiling-stuck items at the head do NOT consume the dispatch budget', () => {
  const routed = [wq('stuck-1'), wq('stuck-2'), wq('stuck-3'), wq('fixable-a'), wq('fixable-b'), wq('fixable-c'), wq('fixable-d')]
  const state = { attempts: { ...atCeiling }, stuck: { 'stuck-1': {}, 'stuck-2': {}, 'stuck-3': {} }, ...justRetried() }
  const { toWork, parked } = selectWorkQueue({ routed, state })
  assert.equal(parked.length, 3, 'the three ceiling items are parked')
  assert.equal(toWork.length, 3, 'and the run still dispatches a full budget')
  assert.deepEqual(toWork.map((r) => r.inc.key), ['fixable-a', 'fixable-b', 'fixable-c'])
})

t('DEADLOCK: fresh work keeps its FULL budget even on the run that revives a parked item', () => {
  // The 2026-08-27 retry must not reintroduce the very starvation this block exists for.
  const routed = [wq('stuck-1'), wq('stuck-2'), wq('stuck-3'), wq('fixable-a'), wq('fixable-b'), wq('fixable-c'), wq('fixable-d')]
  const state = { attempts: { ...atCeiling }, stuck: { 'stuck-1': {}, 'stuck-2': {}, 'stuck-3': {} } }
  const { toWork } = selectWorkQueue({ routed, state })
  assert.deepEqual(toWork.slice(0, 3).map((r) => r.inc.key), ['fixable-a', 'fixable-b', 'fixable-c'])
  assert.equal(toWork.length, 4, 'the revived item is the 4th, not one of the three')
})

t('DEADLOCK: a board of NOTHING BUT stuck items dispatches nothing and parks everything', () => {
  const routed = [wq('stuck-1'), wq('stuck-2'), wq('stuck-3')]
  const state = { attempts: { ...atCeiling }, stuck: { 'stuck-1': {}, 'stuck-2': {}, 'stuck-3': {} }, ...justRetried() }
  const { toWork, parked, toEscalate } = selectWorkQueue({ routed, state })
  assert.equal(toWork.length, 0); assert.equal(parked.length, 3); assert.equal(toEscalate.length, 0)
})

t('a NEWLY stuck item is escalated exactly once, outside the dispatch budget', () => {
  // attempts at the ceiling but no parked marker yet = first time it goes stuck.
  const routed = [wq('newly-stuck'), wq('fixable-a'), wq('fixable-b'), wq('fixable-c')]
  const state = { attempts: { 'newly-stuck': 3 }, stuck: {} }
  const { toWork, toEscalate, parked } = selectWorkQueue({ routed, state })
  assert.deepEqual(toEscalate.map((r) => r.inc.key), ['newly-stuck'])
  assert.equal(toEscalate[0].why, 'stuck')
  assert.equal(parked.length, 0)
  assert.equal(toWork.length, 3, 'the escalation did not cost a dispatch slot')
})

t('an ALREADY-escalated stuck item is silent: parked, never re-written', () => {
  // This is the `board-drainer-stuck-stub-erases-root-cause` incident: the old code re-upserted
  // a stub over the real diagnosis on every run, 138 times in one day.
  const routed = [wq('stuck-1')]
  const state = { attempts: { 'stuck-1': 3 }, stuck: { 'stuck-1': { at: 'x', attempts: 3 } }, ...justRetried() }
  const { toEscalate, parked } = selectWorkQueue({ routed, state })
  assert.equal(toEscalate.length, 0, 'no second write')
  assert.equal(parked.length, 1)
})

t('escalating a stuck item PRESERVES the original diagnosis, appending the stuck note — never a bare stub', () => {
  // `board-drainer-stuck-stub-erases-root-cause`: the escalation write must not throw away
  // inc.root_cause. The real diagnosis survives; the note is added, not substituted.
  const diag = 'v_external_tools is readable by anyone with the public anon key — bypasses RLS.'
  const rc = stuckRootCause({ root_cause: diag }, 3)
  assert.ok(rc.includes(diag), 'the original diagnosis survives the escalation')
  assert.ok(rc.includes('auto-fix STUCK after 3 attempts'), 'the stuck note is appended')
})
t('stuckRootCause is idempotent — a re-escalation does not stack notes or bury the original', () => {
  const diag = 'checkout throws on empty basket'
  const once = stuckRootCause({ root_cause: diag }, 3)
  const twice = stuckRootCause({ root_cause: once }, 5)
  assert.ok(twice.includes(diag), 'the true original is still present after a second escalation')
  assert.equal(twice.match(/auto-fix STUCK after/g).length, 1, 'exactly one stuck note, not stacked')
  assert.ok(twice.includes('after 5 attempts'), 'the note reflects the latest attempt count')
})
t('stuckRootCause with no prior diagnosis is just the note (no leading blank lines)', () => {
  const rc = stuckRootCause({ root_cause: '' }, 3)
  assert.ok(rc.startsWith('[board-drainer] auto-fix STUCK'), 'bare note when there was nothing to preserve')
})

t('a `note` item is recorded outside the budget too, never charged as a dispatch', () => {
  const routed = [
    { inc: { key: 'vendor', source: 'production-monitor', severity: 'warning', title: 'plan expired' }, cls: { mode: 'note', owner: 'none' } },
    wq('fixable-a'), wq('fixable-b'), wq('fixable-c'),
  ]
  const { toWork, toEscalate } = selectWorkQueue({ routed, state: { attempts: {}, stuck: {} } })
  assert.deepEqual(toEscalate.map((r) => r.why), ['note'])
  assert.equal(toWork.length, 3)
})

t('HAND TO CLAUDE hoists an item to the front, past oldest-first', () => {
  const routed = [wq('old-a'), wq('old-b'), wq('old-c'), wq('roger-picked')]
  const { toWork, hoisted } = selectWorkQueue({ routed, state: { attempts: {}, stuck: {} }, priorityKeys: ['roger-picked'] })
  assert.deepEqual(hoisted, ['roger-picked'])
  assert.equal(toWork[0].inc.key, 'roger-picked', 'the human override outranks queue position')
})

t('HAND TO CLAUDE overrides the attempt ceiling — the button is the escape hatch', () => {
  const routed = [wq('stuck-1'), wq('stuck-2'), wq('stuck-3')]
  const state = { attempts: { ...atCeiling }, stuck: { 'stuck-1': {}, 'stuck-2': {}, 'stuck-3': {} }, ...justRetried() }
  const { toWork, parked } = selectWorkQueue({ routed, state, priorityKeys: ['stuck-2'] })
  assert.equal(toWork[0].inc.key, 'stuck-2', 'Roger asking IS the new evidence')
  assert.equal(parked.length, 2)
})

t('the severity threshold still filters, and below-bar items are counted not lost', () => {
  const routed = [wq('quiet', { severity: 'info' }), wq('loud')]
  const { toWork, belowBar } = selectWorkQueue({ routed, state: { attempts: {}, stuck: {} } })
  assert.equal(belowBar, 1)
  assert.deepEqual(toWork.map((r) => r.inc.key), ['loud'])
})

t('an item one attempt BELOW the ceiling is still dispatched', () => {
  const routed = [wq('almost')]
  const { toWork, toEscalate } = selectWorkQueue({ routed, state: { attempts: { almost: 2 }, stuck: {} } })
  assert.equal(toWork.length, 1); assert.equal(toEscalate.length, 0)
})

console.log(`\n${n} assertions passed.`)

// ── timeoutCostsAnAttempt: a flaky machine must not park a fixable item ───────────────────
//
// Roughly 1 in 6 dispatches ends `spawnSync claude.exe ETIMEDOUT`. Before the parking fix that
// only wasted a run. With parking, a burned attempt is permanent, so a timeout must be free -
// but not infinitely free, or an item that genuinely cannot finish would retry forever.

t('a single timeout is FREE — it does not cost an attempt', () => {
  assert.equal(timeoutCostsAnAttempt(1), false)
})
t('two timeouts in a row are still free', () => {
  assert.equal(timeoutCostsAnAttempt(2), false)
})
t('the third consecutive timeout DOES cost an attempt — that is the item, not the machine', () => {
  assert.equal(timeoutCostsAnAttempt(3), true)
  assert.equal(timeoutCostsAnAttempt(9), true)
})
t('TRAP GUARD: the timeout sentinel is TRUTHY, so `!verdict` can never catch it', () => {
  // This is the actual bug risk in the wiring, not the policy. AGENT_TIMED_OUT is a Symbol;
  // `if (!verdict)` does NOT fire on it, so main() must test for the sentinel FIRST or it would
  // hand a Symbol to verdictToUpsert() as though it were a real verdict.
  assert.ok(AGENT_TIMED_OUT, 'a falsy sentinel would be silently swallowed by the !verdict branch')
  assert.equal(typeof AGENT_TIMED_OUT, 'symbol')
  assert.notEqual(AGENT_TIMED_OUT, null)
})
t('the free allowance is configurable and respected', () => {
  assert.equal(timeoutCostsAnAttempt(1, 1), true)
  assert.equal(timeoutCostsAnAttempt(0, 1), false)
})

// ══════════════════════════════════════════════════════════════════════════════════════════
// PLAN A STEP 1 — the work-list is read from fleet_signals, the single store
// (Cockpit/docs/PLAN-ONE-STORE-2026-08-27.md, approved 2026-08-27)
//
// THE DEFECT THESE GUARD. The healthchecks monitor writes DIRECT to signal-intake and never
// touches monitoring_incidents, so anything only that producer saw was invisible to the
// auto-fixer. Measured on production 2026-08-27: 45 active signals, 42 active incidents, and
// four active signals the drainer could not see at all — healthchecks/kb-learning-phase0,
// kb-learning-backfill, knowledge-apply-loop, kb-learning-loop.
// ══════════════════════════════════════════════════════════════════════════════════════════

t('READ MOVED: the work-list is fetched from fleet_signals, not monitoring_incidents', () => {
  const url = boardQueryUrl('https://example.supabase.co')
  assert.match(url, /\/rest\/v1\/fleet_signals\?/, 'the single store is the work-list')
  assert.ok(!/monitoring_incidents/.test(url), 'the old table is no longer the read path')
})

t('READ MOVED: the filter is state in (open,acknowledged) — not the old status vocabulary', () => {
  const url = boardQueryUrl('https://example.supabase.co')
  assert.match(url, /state=in\.\(open,acknowledged\)/)
  assert.ok(!/status=in\./.test(url), 'monitoring_incidents.status does not exist on fleet_signals')
})

t('READ MOVED: oldest-first is preserved, on the signal timestamp', () => {
  assert.match(boardQueryUrl('https://x'), /order=first_seen_at\.asc/)
})

t('READ MOVED: the select asks for every field the mapping needs, and no more', () => {
  const url = boardQueryUrl('https://x')
  for (const col of ['source', 'key', 'title', 'severity', 'state', 'summary', 'detail', 'first_seen_at']) {
    assert.match(url, new RegExp(`[?&=,]${col}[,&]`), `select must include ${col}`)
  }
})

// The four rows, exactly as production served them on 2026-08-27.
const kbSignal = (key) => ({
  source: 'healthchecks', key, title: 'Scheduled job stopped running', severity: 'critical',
  state: 'open', summary: 'Healthchecks reports this job DOWN (last ping 2026-08-26T11:00:06Z).',
  detail: { slug: key, status: 'down', last_ping: '2026-08-26T11:00:06+00:00', tags: 'fleet kb automation' },
  first_seen_at: '2026-08-26T12:00:00+00:00',
})
// A real mirrored row, production 2026-08-27, trimmed.
const mirroredSignal = {
  source: 'silent-failure', key: 'ChannelMover:fe87378:staging-assets-dir-not-preuploaded',
  title: 'Staging assets dir is never pre-uploaded', severity: 'critical', state: 'open',
  summary: 'The staging deploy publishes index.html before the hashed assets it references exist.',
  detail: { who_must_act: 'Claude - add a staging pre-upload pass for the hashed assets dir', incident_status: 'blocked' },
  first_seen_at: '2026-08-24T09:00:00+00:00',
}

t('THE FOUR INVISIBLE ROWS: a healthchecks signal maps onto the incident shape the loop speaks', () => {
  // The raw row is NOT an incident: the old field names simply do not exist on it. That is the
  // whole reason a mapping has to happen rather than the rows being passed through.
  const raw = kbSignal('kb-learning-phase0')
  assert.equal(raw.root_cause, undefined)
  assert.equal(raw.who_must_act, undefined)
  assert.equal(raw.opened_at, undefined)

  const inc = signalToIncident(raw)
  assert.equal(inc.source, 'healthchecks')
  assert.equal(inc.key, 'kb-learning-phase0')
  assert.equal(inc.severity, 'critical')
  assert.equal(inc.root_cause, raw.summary, 'summary -> root_cause')
  assert.equal(inc.opened_at, raw.first_seen_at, 'first_seen_at -> opened_at')
})

t('THE FOUR INVISIBLE ROWS: with no owner in detail, the item is CLASSIFIED, never crashed or dropped', () => {
  // These four rows have no detail.who_must_act at all on production, because migration 136
  // (detail merge) has not been promoted there yet. An unowned row must route to Claude/FIX —
  // never park on Roger, never throw.
  for (const key of ['kb-learning-phase0', 'kb-learning-backfill', 'knowledge-apply-loop', 'kb-learning-loop']) {
    const inc = signalToIncident(kbSignal(key))
    assert.equal(inc.who_must_act, null, `${key}: absent owner is null, not undefined`)
    const c = classify(inc)
    assert.equal(c.owner, 'claude', `${key} must be workable`)
    assert.equal(c.mode, 'fix', `${key} must be workable`)
  }
})

t('a MIRRORED signal carries its owner and its incident status through detail', () => {
  const inc = signalToIncident(mirroredSignal)
  assert.match(inc.who_must_act, /^Claude - add a staging pre-upload pass/, 'detail.who_must_act -> who_must_act')
  assert.equal(inc.status, 'blocked', 'detail.incident_status -> status')
  assert.equal(classify(inc).mode, 'fix')
})

t('status NEVER invents "open": with no incident behind it, the signal\'s own state is reported', () => {
  assert.equal(signalToIncident(kbSignal('k')).status, 'open')
  assert.equal(signalToIncident({ ...kbSignal('k'), state: 'acknowledged' }).status, 'acknowledged')
  // A fabricated status reads identically to a real one, which is how a board starts lying.
  assert.equal(signalToIncident({ ...mirroredSignal, state: 'acknowledged' }).status, 'blocked')
})

t('a null/absent detail does not throw — the mapping survives a row nothing has annotated', () => {
  assert.equal(signalToIncident({ source: 's', key: 'k', state: 'open', detail: null }).who_must_act, null)
  assert.equal(signalToIncident({ source: 's', key: 'k', state: 'open' }).status, 'open')
})

// ══════════════════════════════════════════════════════════════════════════════════════════
// FINDING GUARD (rewritten 2026-09-02, replacing the WRITE-TARGET GUARD)
//
// The old contract was "only the six sources monitoring_incidents.source accepts may be worked".
// It stopped being true on 2026-09-01, when migration 142 made upsert_incident an adapter onto
// upsert_signal: fleet_signals has no source CHECK, so nothing can 400 any more. Proved on
// BackOffice staging 2026-09-02 — a direct insert of source='monitoring-hygiene' into the retired
// table is still ERROR 23514, while upsert_incident with the same source answers 201 and lands the
// row open in fleet_signals.
//
// The population is now defined by WHAT A FINDING IS, and the list is a DENY list so that a source
// nobody has thought of yet is worked rather than silently dropped. That direction is the whole
// point and has its own test below.
// ══════════════════════════════════════════════════════════════════════════════════════════

t('FINDING GUARD: the twelve sources held back before are workable now', () => {
  // Exactly the sources measured as HELD BACK on production 2026-09-02, plus the six that were
  // always allowed. Every one of these is a real fault sensor.
  for (const source of [
    'healthchecks', 'sentry', 'production-monitor', 'cron', 'silent-failure', 'commit-review',
    'monitoring-hygiene', 'external-tools-scan', 'external-tools-freshness',
    'deploy', 'github', 'github-api-budget', 'health-monitor', 'monitor', 'store-merge',
  ]) {
    assert.equal(workableFinding({ source }), true, `${source} is a finding and must be worked`)
  }
})

t('FINDING GUARD: rows that are not findings stay out, each for its own reason', () => {
  // The work board IS a person's queue; board-drainer rows are this machine's own heartbeat;
  // the rest are drills and delivery receipts (migration 159: "a report IS a delivery").
  for (const source of [
    'work-board', 'board-drainer',
    'test', 'probe', 'wrapper', '__drill__', '__migration_probe__',
    'report', 'closer-digest', 'notification-closer', 'notification-hc-up', 'notification-report',
  ]) {
    assert.equal(workableFinding({ source }), false, `${source} is not a finding`)
  }
})

t('FINDING GUARD: an UNKNOWN source is worked, never silently dropped', () => {
  // The defect this replaced: an allow list makes every future producer invisible by default.
  // A source nobody has classified must reach the queue loudly, not vanish before `considered`.
  for (const source of ['kb-learning', 'pull-engine', 'a-producer-invented-next-month', 'stripe']) {
    assert.equal(workableFinding({ source }), true, `${source} must not be dropped for being unknown`)
  }
})

t('FINDING GUARD: a row with no source at all is refused — that is malformed, not new work', () => {
  assert.equal(workableFinding({ source: undefined }), false)
  assert.equal(workableFinding({ source: null }), false)
  assert.equal(workableFinding({ source: '' }), false)
  assert.equal(workableFinding({}), false)
  assert.equal(workableFinding(null), false)
  assert.equal(workableFinding(undefined), false)
})

t('FINDING GUARD: scout-ux is refused by isScoutDerived, not by this list', () => {
  // Deliberate: isScoutDerived also catches a scout-derived row filed under ANY other source,
  // and removing one guard must not quietly disarm the other. So scout-ux passes the source test
  // and is stopped one step later — the structural guard, not the naming one.
  assert.equal(workableFinding({ source: 'scout-ux' }), true, 'the source test does not own this')
  assert.equal(isScoutDerived({ source: 'scout-ux' }), true, 'the structural guard does')
  assert.equal(isScoutDerived({ source: 'production-monitor', scoutReportId: 'abc' }), true,
    'and it catches a scout report filed under a normal source, which a name list never could')
})

t('the deprecated writableToIncidentBoard alias still answers, and answers the NEW contract', () => {
  // Kept only so an out-of-tree caller does not break silently. It must not become a second,
  // divergent opinion about the population — that is how the two counts disagreed in the first place.
  assert.equal(writableToIncidentBoard, workableFinding)
  assert.equal(writableToIncidentBoard({ source: 'monitoring-hygiene' }), true)
})

// ══════════════════════════════════════════════════════════════════════════════════════════
// PLAN B B3 part 1 — parked state is PUBLISHED
// (Cockpit/docs/PLAN-QUIET-BOARD-2026-08-27.md, approved 2026-08-27)
//
// Parking lived only in C:\Business\_board-drainer\state.json on one machine. Nothing could see
// it, so 41 of 42 blocked incidents were indistinguishable from things breaking right now.
// These three key names are a CONTRACT with the cockpit lane being built against them.
// ══════════════════════════════════════════════════════════════════════════════════════════

t('PARKED CONTRACT: parking stamps parked / parked_at / parked_attempts', () => {
  const f = parkedFields({ parked: true, at: '2026-08-25T04:00:00.000Z', attempts: 3 })
  assert.deepEqual(f, { parked: true, parked_at: '2026-08-25T04:00:00.000Z', parked_attempts: 3 })
})

t('PARKED CONTRACT: not-parked is stated EXPLICITLY, never left unsaid', () => {
  // upsert_signal MERGES detail since migration 136, so an omitted key leaves the old value
  // standing. "Nothing said" would read as "still parked", forever.
  const f = parkedFields(null)
  assert.deepEqual(f, { parked: false, parked_at: null, parked_attempts: null })
  assert.ok('parked_at' in f && 'parked_attempts' in f, 'the cleared keys must be present, not absent')
  assert.deepEqual(parkedFields({ parked: false, at: 'x', attempts: 9 }), f, 'parked:false wins over stale fields')
})

t('PARKED CONTRACT: a normal write-back publishes parked=false, which is what un-parks a revived item', () => {
  const p = verdictToUpsert(inc, { class: 'D-ESCALATE', status: 'blocked', action: 'none', who_must_act: 'Roger - do X' })
  assert.equal(p.p_evidence.parked, false)
  assert.equal(p.p_evidence.parked_at, null)
  assert.equal(p.p_evidence.parked_attempts, null)
})

const mark = { at: '2026-08-20T06:00:00.000Z', attempts: 3, source: 'production-monitor' }

t('PARKED CONTRACT: a scheduled retry that did NOT close the item leaves it parked, timestamp intact', () => {
  const p = verdictToUpsert(inc, { class: 'D-ESCALATE', status: 'blocked', action: 'none' }, mark)
  assert.equal(p.p_evidence.parked, true, 'one more failed try is not progress')
  assert.equal(p.p_evidence.parked_at, '2026-08-20T06:00:00.000Z', 'the ORIGINAL park time — not now')
  assert.equal(p.p_evidence.parked_attempts, 3)
})

t('PARKED CONTRACT: a scheduled retry that CLOSED the item un-parks it', () => {
  const p = verdictToUpsert(inc, { class: 'A-INFRA', status: 'fixed', action: 'pushed abc123', receipt: 'run 999 green' }, mark)
  assert.equal(p.p_status, 'fixed')
  assert.equal(p.p_evidence.parked, false)
  assert.equal(p.p_evidence.parked_at, null)
})

t('PARKED CONTRACT: a receipt-less "fixed" is downgraded AND stays parked — the guard is not a way out', () => {
  const p = verdictToUpsert(inc, { class: 'C-CLOSED', status: 'fixed', action: 'looks fine', receipt: '' }, mark)
  assert.equal(p.p_status, 'investigating', 'still no shallow close')
  assert.equal(p.p_evidence.parked, true, 'and a downgraded close does not un-park anything')
})

t('PARKED CONTRACT: nothing else about the write-back changed shape', () => {
  const p = verdictToUpsert(inc, { class: 'A-INFRA', status: 'fixed', action: 'a', receipt: 'r' })
  assert.equal(p.p_evidence.by, 'board-drainer')
  assert.equal(p.p_evidence.class, 'A-INFRA')
  assert.equal(p.p_evidence.action, 'a')
  assert.equal(p.p_evidence.receipt, 'r')
})

// ══════════════════════════════════════════════════════════════════════════════════════════
// PLAN B B3 part 2 — a parked item is RETRIED on a schedule instead of never
//
// Before today a parked item cleared in exactly two ways: the incident left the board, or Roger
// pressed "Hand to Claude". Nothing retried on its own. Measured on production 2026-08-27:
// 41 of 42 active incidents were `blocked`, 36 of 45 signals named Claude, 2 rows were younger
// than a day. The board was a graveyard, and a graveyard looks exactly like an alarm going off.
// ══════════════════════════════════════════════════════════════════════════════════════════

const HOUR = 3600_000
const iso = (msAgo) => new Date(Date.UTC(2026, 7, 27, 12, 0, 0) - msAgo).toISOString()
const NOW = Date.UTC(2026, 7, 27, 12, 0, 0)
// Three parked items of different ages, plus four fixable ones behind them.
const parkedBoard = () => ({
  routed: [
    wq('parked-newest'), wq('parked-oldest'), wq('parked-middle'),
    wq('fixable-a'), wq('fixable-b'), wq('fixable-c'), wq('fixable-d'),
  ],
  state: {
    attempts: { 'parked-newest': 3, 'parked-oldest': 3, 'parked-middle': 3 },
    stuck: {
      'parked-newest': { at: iso(2 * HOUR), attempts: 3, source: 'silent-failure' },
      'parked-oldest': { at: iso(400 * HOUR), attempts: 5, source: 'silent-failure' },
      'parked-middle': { at: iso(50 * HOUR), attempts: 3, source: 'silent-failure' },
    },
  },
})

t('RETRY: a parked item is handed back to the agent — exactly ONE of them', () => {
  const { parkedRetry, parked } = selectWorkQueue({ ...parkedBoard(), now: NOW })
  assert.ok(parkedRetry, 'a parked pile that nothing ever retries is a graveyard')
  assert.equal(parked.length, 2, 'the other two stay parked, and the revived one is not double-counted')
})

t('RETRY: OLDEST parked first — not whichever happens to sort first', () => {
  const { parkedRetry } = selectWorkQueue({ ...parkedBoard(), now: NOW })
  assert.equal(parkedRetry.inc.key, 'parked-oldest')
})

t('RETRY: the retry does NOT consume the blast-radius cap for normal work', () => {
  // This is the whole point. Charging it to MAX_PER_RUN would let a parked pile starve fresh
  // problems — the same head-of-line failure selectWorkQueue was written to fix, in a new hat.
  const { toWork } = selectWorkQueue({ ...parkedBoard(), now: NOW, maxPerRun: 3 })
  assert.equal(toWork.length, 4, 'three normal items PLUS the revived one')
  assert.deepEqual(toWork.slice(0, 3).map((r) => r.inc.key), ['fixable-a', 'fixable-b', 'fixable-c'],
    'fresh work keeps its full budget and its FIFO order')
  assert.equal(toWork[3].inc.key, 'parked-oldest', 'the revived item is appended, never inserted')
})

t('RETRY: only ONE per interval — a retry 2 hours ago means no retry now', () => {
  const b = parkedBoard()
  b.state.lastParkedRetryAt = iso(2 * HOUR)
  const { parkedRetry, parked, toWork } = selectWorkQueue({ ...b, now: NOW })
  assert.equal(parkedRetry, null, 'the interval is a real gate, not decoration')
  assert.equal(parked.length, 3, 'all three stay parked and stay visible')
  assert.equal(toWork.length, 3, 'and the run is back to its plain blast-radius cap')
})

t('RETRY: 23h59m is still inside the window; 24h01m is not', () => {
  const b1 = parkedBoard(); b1.state.lastParkedRetryAt = iso(24 * HOUR - 60_000)
  assert.equal(selectWorkQueue({ ...b1, now: NOW }).parkedRetry, null)
  const b2 = parkedBoard(); b2.state.lastParkedRetryAt = iso(24 * HOUR + 60_000)
  assert.equal(selectWorkQueue({ ...b2, now: NOW }).parkedRetry.inc.key, 'parked-oldest')
})

t('RETRY: a clock that was never set retries immediately — everything parked has waited long enough', () => {
  const { parkedRetry } = selectWorkQueue({ ...parkedBoard(), now: NOW })
  assert.equal(parkedRetry.inc.key, 'parked-oldest')
})

t('RETRY: a parked marker with an unreadable timestamp is treated as the OLDEST, not skipped', () => {
  const b = parkedBoard()
  b.state.stuck['parked-newest'] = { attempts: 3 }   // no `at` at all (a marker written by an older build)
  const { parkedRetry } = selectWorkQueue({ ...b, now: NOW })
  assert.equal(parkedRetry.inc.key, 'parked-newest', 'an item whose bookkeeping we lost waits last, not forever')
})

t('RETRY: nothing parked means nothing is revived, and the cap is untouched', () => {
  const routed = [wq('fixable-a'), wq('fixable-b'), wq('fixable-c'), wq('fixable-d')]
  const { parkedRetry, toWork } = selectWorkQueue({ routed, state: { attempts: {}, stuck: {} }, now: NOW })
  assert.equal(parkedRetry, null)
  assert.equal(toWork.length, 3)
})

t('RETRY: "Hand to Claude" STILL revives immediately, inside the interval and past the ceiling', () => {
  // The button must not be demoted to "wait your turn, up to 24 hours". main() clears the parked
  // marker for a hoisted key before this runs, so the item arrives here as ordinary work.
  const b = parkedBoard()
  b.state.lastParkedRetryAt = iso(1 * HOUR)               // scheduled retry firmly closed
  delete b.state.stuck['parked-middle']                    // what main() does on a hand-off
  delete b.state.attempts['parked-middle']
  const { toWork, hoisted, parkedRetry } = selectWorkQueue({ ...b, now: NOW, priorityKeys: ['parked-middle'] })
  assert.deepEqual(hoisted, ['parked-middle'])
  assert.equal(toWork[0].inc.key, 'parked-middle', 'Roger asking outranks both the queue and the clock')
  assert.equal(parkedRetry, null, 'and it does not also burn the scheduled retry')
})

t('RETRY: a hand-off is not double-served — an item at the ceiling that Roger picked is never also the scheduled retry', () => {
  const b = parkedBoard()
  const { toWork, parkedRetry } = selectWorkQueue({ ...b, now: NOW, priorityKeys: ['parked-oldest'] })
  assert.equal(toWork[0].inc.key, 'parked-oldest', 'the human override takes it first')
  assert.notEqual(parkedRetry?.inc.key, 'parked-oldest', 'so the scheduler must not pick the same key')
})

t('RETRY: the interval is configurable, and a 1-hour dial behaves like a 1-hour dial', () => {
  const b = parkedBoard()
  b.state.lastParkedRetryAt = iso(2 * HOUR)
  assert.equal(selectWorkQueue({ ...b, now: NOW }).parkedRetry, null, 'closed at 24h')
  assert.ok(selectWorkQueue({ ...b, now: NOW, parkedRetryIntervalMs: HOUR }).parkedRetry, 'open at 1h')
})


// ══════════════════════════════════════════════════════════════════════════════════════════
// PLAN B, B3 part 3 (2026-08-27) — the classifier decides on WHAT THE ITEM IS
//
// Incident: production-monitor/board-drainer-human-hands-regex-matches-billing-nouns.
// Every `who` string below is VERBATIM from the live production board on 2026-08-27, trimmed
// only where a sentence was irrelevant to the decision. That matters: the old gate was written
// against imagined text and passed its own tests while misrouting 12 of 18 real rows.
//
// MEASURED, production `fleet_signals`, 42 active signals, 2026-08-27:
//   old gate: 18 routed away from the fixer — 6 genuine, 12 keyword accidents
//   new gate:  7 routed away from the fixer — the same 6, plus one the OLD gate MISSED
// ══════════════════════════════════════════════════════════════════════════════════════════

const pending = []
const ta = (name, fn) => { pending.push(fn().then(() => { n++; console.log(`  ok - ${name}`) })) }

const live = (who, extra = {}) => ({ who_must_act: who, root_cause: '', title: '', key: 'k', source: 'silent-failure', ...extra })
const fixable = (name, who, extra) => t(name, () => {
  const c = classify(live(who, extra))
  assert.equal(c.mode, 'fix', `expected FIX, got ${c.mode} (${c.reason})`)
  assert.equal(c.owner, 'claude')
  assert.equal(c.handoff, false, 'a code fix must never become a work-board task')
})
const escalates = (name, who, gateId, extra) => t(name, () => {
  const c = classify(live(who, extra))
  assert.equal(c.mode, 'verify', `expected escalation, got ${c.mode} (${c.reason})`)
  assert.equal(c.owner, 'roger')
  assert.equal(c.handoff, true, 'something needing a person must reach the work board')
  if (gateId) assert.equal(c.gate, gateId, `expected the ${gateId} gate, got ${c.gate} (${c.reason})`)
})

// ── DIRECTION 1: the twelve keyword accidents, each one now a Claude fix ──────────────────

fixable('LIVE fe87378: `--delete` is an rsync FLAG in a prescribed command, not a database op',
  "Claude - in ChannelMover/.github/workflows/deploy.yml, after line 240 add a staging pre-upload pass for the hashed assets dir: 'mirror --reverse --verbose --no-perms ./dist/assets/ staging.channelmover.com/assets/' (same flags as the prod pass at :686-687, NO --delete). Commit, push, deploy staging, verify green.")

fixable('LIVE 3fea238: deleting a LINE OF CODE at a path is an edit, not a row delete',
  'Claude - delete the `if (pending.length === 1) return pending[0]` line at supabase/functions/github-invite-poller/index.ts:105 so ambiguous invites fall through to the safe \'unmatched\' branch (accept, email the operator, grant nothing).')

fixable('LIVE pull-engine: deleting a JSON FILE is not deleting a row',
  "Claude - fix the ROOT this time: widen NOT_INDEXED_RE at pull-engine/scripts/index-health.mjs:51 so 'URL is unknown to Google' is not counted as INDEXED, then delete data/circuit-breaker.json to resume channelmover.")

fixable('LIVE 4e2a4fe: "DELETE the variable" is a workflow edit',
  'Claude - in production-monitor scripts/check-ci-runners.mjs, treat `zero registered runners AND RUNNER_LABEL===LABEL` like the `online===0 && isSet` branch (alert + DELETE the variable), and only `continue` when no runner is registered.')

fixable('LIVE 47afebf: deleting an `if:` guard from a workflow, plus "drop" inside a commit MESSAGE',
  "Claude - class A one-line CI fix (workflow edit, NOT a prod deploy): delete `if: steps.playwright-cache.outputs.cache-hit != 'true'` at ReplyFlow .github/workflows/deploy.yml:886, then `git commit -m '[board-drainer] ci: drop stale Playwright cache-hit guard on prod-smoke'` and push.")

fixable('LIVE cde2cb2: "delete deploy.yml:864" — a file:line reference is not an object',
  "Claude - In C:/Business/Internal Projects/ChannelMover delete deploy.yml:864 (`if: steps.playwright-cache.outputs.cache-hit != 'true'`) from the prod-smoke 'Install Playwright chromium' step, commit, push, confirm deploy.yml green. CI/infra class, no gate needed - nothing here needs Roger's hands.")

fixable('LIVE f666a20: "Delete deploy-staging.yml L211"',
  "Claude - Delete deploy-staging.yml L211, carry across the 4-line 'No cache-hit guard' comment from test.yml:45-48, commit that one file, push, confirm deploy-staging.yml green.")

fixable('LIVE 632a349: "DROP the ... sentence" is prose editing',
  "Claude - apply the Class-A fix in production-monitor/scripts/lib/mailer-alert-copy.mjs: return colour '#dc2626' with guard-broken wording and DROP the 'Reserve action for a run that names a proven send failure' sentence; then commit, push, deploy to prod (low-blast-radius monitor class).")

fixable('LIVE b1ff1a4: "delete the two comments"',
  'Claude - in Predivo-GmbH/BackOffice pick one and ship it: either add a GitHub-hosted job that runs the specs on webkit, or delete the two comments that claim a Safari fallback exists - test.yml:85 and playwright.config.ts:10-13 - so nobody trusts coverage we do not have.')

fixable('LIVE actions-fanout-cost: "Drop confirmed -> close", and a SPEND decision named as the branch NOT taken',
  "Claude - this row's whole remaining action is a scheduled READING on/after 2026-08-26 compared against the pre-2026-08-24 baseline. Drop confirmed -> close. No drop -> re-diagnose the consumer and hand Roger ONE spend decision, never a reading task.")

fixable('LIVE the meta-incident: payment / OAuth / invoice / pay inside the sentence DESCRIBING this very bug',
  "Claude - (1) SPLIT THE LANE on the REASON, not the capability class: a row blocked by a real human gate (prod-deploy-guard allowlist, payment, OAuth, a decision) goes to Roger and says which gate. (4) Narrow HUMAN_HANDS (:397) to require a human VERB adjacent to its object so 'stripe dashboard'/'invoice'/'pay' inside a code description stops matching.",
  { key: 'board-drainer-human-hands-regex-matches-billing-nouns', source: 'production-monitor' })

fixable('LIVE 162c12b: support-article FILENAMES (refunds, payments-and-vat, pricing-and-plans) are a path, not a billing action',
  "Roger - re-dispatch to a WRITE-authorized board-drainer run (this is Class-A infra dev work, NOT a Roger gate: no decision/secret/payment/OAuth). In ChannelMover .github/workflows/deploy.yml push.paths-ignore, delete `- '**/*.md'` and replace `- 'docs/**'` with `- 'docs/*.md'`, so that docs/support-kb/en/{refunds,payments-and-vat,pricing-and-plans}.md reach the sync again.")

t('the accident is gone at the SOURCE: those nouns are simply not in the action any more', () => {
  // The mechanism, asserted directly rather than only through its consequence.
  assert.equal(stripCode('mirror ./dist/assets/ staging.channelmover.com/assets/ NO --delete'), 'mirror NO')
  assert.equal(stripCode('delete deploy.yml:864 from the step'), 'delete from the step')
  assert.equal(stripCode('set the staging edge secret AFFILIATE_ALERT_EMAIL to a non-personal address'),
    'set the staging edge secret to a non-personal address')
  assert.match(stripCode('read docs/support-kb/en/{refunds,payments-and-vat,pricing-and-plans}.md'), /^read\b/)
  assert.doesNotMatch(stripCode('read docs/support-kb/en/{refunds,payments-and-vat,pricing-and-plans}.md'), /refund|payment|pricing/i)
})

t('ONLY the prescribed action is read — a title full of billing nouns cannot escalate anything', () => {
  const c = classify({
    who_must_act: 'Claude - fix the stale assertion in the spec',
    title: 'Invoice page: the refund button charges the customer card twice',
    root_cause: 'The vendor dashboard shows a payment. Reconnect the Google account to see it.',
  })
  assert.equal(c.mode, 'fix', 'describing a billing bug is not a request to move money')
  assert.equal(c.gate, null)
})

// ── DIRECTION 2: the genuine escalations, all still escalating ────────────────────────────

escalates('LIVE sentry/142350725: Roger runs the release himself; the action names no automatable path',
  'Roger - a routine ReplyFlow release when it suits you, NOT an emergency. Run EXACTLY: `gh workflow run deploy.yml -f confirm=deploy` in the replyflow repo. The confirm flag is load-bearing.',
  'owner-roger')

escalates('LIVE 62520d7: "one decision, no code" is exactly what a human gate looks like',
  'Roger - one decision, no code: may a PRODUCT function (sync-growth-plan) be deployed to BackOffice PROD for this fix? Say yes and Claude does the rest in one pass. Say no and the fix stays on staging.',
  'business-decision')

escalates('LIVE b11c5d2: the same, after a re-ownership stamp',
  'Roger - RE-OWNED 2026-08-25T02:55Z. One decision, no code: may the PRODUCT function support-send-due be deployed to BackOffice PROD? prod-deploy-guard.mjs allows only monitoring-board + health-monitor there, by design, so no automated path exists.',
  'business-decision')

escalates('LIVE claude-weekly-limit: raising a plan costs money, and no code substitutes for it',
  'Roger - one decision: either raise the Claude plan so the weekly budget lasts the whole week, or say the word and the four knowledge loops get cut back.',
  'business-decision')

escalates('LIVE recurring-costs: the figures are on his bank statement and nowhere we can read',
  'Roger - open the recurring_costs registry in BackOffice and enter the amount + renewal date for the 4 UNVERIFIED rows.',
  'owner-roger')

escalates('LIVE 7b2867bf: SETTING an edge secret is still a secrets action, however plain the rest is',
  'Claude - in ReplyFlow monitor-sync-health, extend the readiness filter at index.ts:138 to ALSO drop refresh_token=null connections from the syncable set, AND set the staging edge secret AFFILIATE_ALERT_EMAIL to a non-personal address, then deploy monitor-sync-health to staging.',
  'secrets')

escalates('LIVE gh-cli-keyring: storing a new token as a repo secret — a hole the OLD noun list did not even cover',
  'Claude - a SEPARATE TOKEN for fleet automation is a browser+CLI credential flow, mine to create, scope narrowly, store as a repo/org secret and add to the credential inventory.',
  'secrets')

// The five hard classes, in their canonical form. These are the posture, and it does not move.
escalates('POSTURE: deleting rows from a table', 'Claude - delete the orphaned rows from the platform_connections table', 'destructive-db')
escalates('POSTURE: a migration applied to production', 'Claude - apply the pending migration to production once it is reviewed', 'destructive-db')
escalates('POSTURE: rotating a key', 'Claude - rotate the Supabase service key, the legacy one is disabled', 'secrets')
escalates('POSTURE: issuing a refund', 'Claude - issue a refund via the Stripe dashboard for the duplicate charge', 'payments')
escalates('POSTURE: emailing affected customers', 'Claude - email the affected customers to tell them the export was incomplete', 'customer-comms')
escalates('POSTURE: reconnecting a Google account', 'Roger - reconnect the Google account, the grant was revoked', 'human-hands')

t('a gate names the exact span that tripped it — "it escalated" is not evidence', () => {
  const g = gateFor(live('Claude - rotate the Supabase service key'))
  assert.equal(g.id, 'secrets')
  assert.match(g.evidence, /rotate the Supabase service key/i)
})

t('a DISCLAIMED gate does not fire, but a real one later in the same text still does', () => {
  // Both halves matter. The first sentence is verbatim from ChannelMover cde2cb2.
  assert.equal(gateFor(live('Claude - CI/infra class, no gate needed - nothing here needs Roger\'s hands.')), null)
  const g = gateFor(live("Claude - CI/infra class, nothing here needs Roger's hands. Then rotate the service key."))
  assert.equal(g?.id, 'secrets', 'a disclaimer must not shadow a genuine gate further down')
})

t('a "Roger -" prefix that DISOWNS itself goes back to Claude — but a gate always outranks that', () => {
  const back = classify(live("Roger - re-dispatch to a WRITE-authorized run; NOT a Roger gate: no decision/secret/payment/OAuth. Delete the stale workflow step."))
  assert.equal(back.owner, 'claude')
  const still = classify(live("Roger - re-dispatch to a WRITE-authorized run, NOT a Roger gate. Then delete the orphaned rows from the sessions table."))
  assert.equal(still.owner, 'roger', 'the disclaimer is not a master key')
  assert.equal(still.gate, 'destructive-db')
})

t('a vendor plan expiring still wins over every gate — noted, never escalated', () => {
  const c = classify({ who_must_act: 'Roger - renew the Smartlead plan', root_cause: 'HTTP 401 Plan expired', title: 'sync failed' })
  assert.equal(c.mode, 'note')
  assert.equal(c.handoff, false)
})

t('a stuck CI edit is NOT re-owned to Roger by the stuck path either', () => {
  // stuckWhoMustAct shared the old noun list, so "delete deploy.yml:864" acquired a human owner
  // the moment it hit the attempt ceiling — the second half of the same defect.
  assert.equal(stuckWhoMustAct('Claude - delete deploy.yml:864 from the prod-smoke step').owner, 'Claude')
  assert.equal(stuckWhoMustAct('Claude - rotate the Supabase service key').owner, 'Roger')
})

// ══════════════════════════════════════════════════════════════════════════════════════════
// B3 part 3 — a signal that needs a person becomes a WORK-BOARD ITEM and leaves the board
// ══════════════════════════════════════════════════════════════════════════════════════════

const rogerInc = (o = {}) => ({
  source: 'production-monitor', key: 'backoffice-recurring-costs-unverified-rows',
  title: 'Fill the 4 UNVERIFIED rows in the recurring_costs registry',
  severity: 'warning', status: 'blocked', opened_at: '2026-08-19T10:00:00Z',
  who_must_act: 'Roger - open the recurring_costs registry in BackOffice and enter the amount + renewal date for the 4 UNVERIFIED rows.',
  root_cause: 'BackOffice prod recurring_costs still has 4 rows with no verified amount. Nobody but Roger holds these figures.',
  ...o,
})

// ── the one line Roger reads ──────────────────────────────────────────────────────────────

t('the title comes from what ROGER MUST DO, not from what the machine found', () => {
  const { title, from } = plainTitle(rogerInc())
  assert.equal(from, 'action')
  assert.equal(title, 'Open the recurring costs registry in BackOffice and enter the amount + renewal date for the 4 unverified rows')
})

t('every jargon class the board actually produces is caught by titleObjections', () => {
  const cases = {
    '[commit-review] BackOffice 62520d7: emails counted as internal': /bracket tag|commit id/,
    'delete deploy.yml:864 from the prod-smoke step': /filename|line number/,
    'fix supabase/functions/github-invite-poller/index.ts': /file path/,
    'set AFFILIATE_ALERT_EMAIL to a non-personal address': /identifier/,
    "remove `if: steps.playwright-cache.outputs.cache-hit != 'true'`": /backticks/,
    'run the deploy with --confirm=deploy': /flag/,
    'the fix is at 62520d7abc1234': /commit id/,
    'Do the thing. Then do the other thing.': /more than one sentence/,
  }
  for (const [bad, why] of Object.entries(cases)) {
    const objections = titleObjections(bad).join('; ')
    assert.match(objections, why, `"${bad}" should have been objected to (${why}); got: ${objections || 'nothing'}`)
  }
  assert.deepEqual(titleObjections('Open the recurring costs registry in BackOffice and enter the amounts'), [])
})

t('a bookkeeping stamp is never the title — b11c5d2 used to become "RE-owned 2026-08-25T02:55Z"', () => {
  const { title } = plainTitle(rogerInc({
    who_must_act: 'Roger - RE-OWNED 2026-08-25T02:55Z. One decision, no code: may the PRODUCT function support-send-due be deployed to BackOffice PROD?',
  }))
  assert.doesNotMatch(title, /^RE-?owned/i)
  assert.match(title, /one decision/i)
  // And a LONG stamp, which is the harder half: a short one is already skipped for being too
  // short to be a sentence, so only this case actually exercises the bookkeeping rule.
  const { title: long } = plainTitle(rogerInc({
    who_must_act: 'Roger - RE-VERIFIED at HEAD and re-owned by the closer on 2026-08-25 at 02:55Z. One decision, no code: may the function be deployed to production?',
  }))
  assert.doesNotMatch(long, /^RE-?verified/i)
  assert.match(long, /one decision/i)
})

t('a title that cannot be cleaned is still used, but it SAYS SO — it never passes silently', () => {
  const { title, objections } = plainTitle({
    who_must_act: 'Roger - confirm that count(*) = 0 for the affected view before anyone touches it',
    title: 'Roger - confirm that count(*) = 0 for the affected view before anyone touches it',
  })
  assert.ok(title.length, 'an item with an imperfect title still beats a problem rotting on the alarm board')
  assert.ok(objections.length, 'and the caller is told, so it can be recorded on the item')
})

t('the paste-ready prompt carries the ORIGINAL action and diagnosis verbatim, plus provenance', () => {
  const inc = rogerInc()
  const p = handoffPrompt(inc, classify(inc))
  assert.ok(p.includes(inc.who_must_act), 'the action goes in uncleaned — the title is for Roger, this is for the session')
  assert.ok(p.includes(inc.root_cause))
  assert.ok(p.includes('production-monitor/backoffice-recurring-costs-unverified-rows'))
  assert.match(p, /superseded, not resolved/)
})

t('the prompt names a working directory when the repo is knowable, and stays silent when it is not', () => {
  assert.match(handoffPrompt({ key: 'ChannelMover:abc:x', title: '' }, null), /Working directory: C:\/Business\/Internal Projects\/ChannelMover/)
  assert.doesNotMatch(handoffPrompt({ key: 'something-unmapped', title: 'no product named here' }, null), /Working directory/)
})

// ── idempotency ───────────────────────────────────────────────────────────────────────────

const fakeBoard = () => {
  const items = new Map()
  const evidence = []
  const superseded = []
  const joined = []   // signals ATTACHED to a live job — visible, not muted (Roger 2026-08-28)
  const live = []   // set live.push(anInProgressItem) to make a join target available
  let creates = 0
  return {
    items, evidence, creates: () => creates, superseded, joined, live,
    deps: {
      log() {},
      async findItem(slug) { return items.get(slug) || null },
      async createItem(row) { creates++; const it = { id: `id-${creates}`, ...row }; items.set(row.slug, it); return it },
      async addEvidence(itemId, ev) { evidence.push({ itemId, ...ev }) },
      async listLiveItems() { return live },
      async supersedeSignal(inc, slug) { superseded.push({ inc, slug }); return true },
      async markSignalJoined(inc, slug) { joined.push({ inc, slug }); return true },
    },
  }
}

ta('IDEMPOTENT: the same signal seen twice mints ONE item', async () => {
  const b = fakeBoard()
  const inc = rogerInc()
  await routeToWorkBoard(inc, classify(inc), b.deps)
  const second = await routeToWorkBoard(inc, classify(inc), b.deps)
  assert.equal(b.creates(), 1, 'a second sighting must not mint a second item')
  assert.equal(second.created, false)
  assert.equal(b.items.size, 1)
})

t('IDEMPOTENT across a REWORDING: the slug is keyed on the signal, never on the title', () => {
  // Rows on this board are re-owned and re-worded constantly — one has been rewritten four times
  // in three days. A title-derived slug would mint a fresh item on every edit.
  const a = workItemSlugFor(rogerInc())
  const b = workItemSlugFor(rogerInc({ title: 'Something completely different now', who_must_act: 'Roger - and a different action too' }))
  assert.equal(a, b)
  assert.notEqual(a, workItemSlugFor(rogerInc({ key: 'a-different-signal' })))
  assert.notEqual(a, workItemSlugFor(rogerInc({ source: 'cron' })), 'same key on another source is another problem')
})

ta('IDEMPOTENT: an item Roger already FINISHED is not re-minted', async () => {
  const b = fakeBoard()
  const inc = rogerInc()
  b.items.set(workItemSlugFor(inc), { id: 'old', slug: workItemSlugFor(inc), status: 'done' })
  const r = await routeToWorkBoard(inc, classify(inc), b.deps)
  assert.equal(b.creates(), 0)
  assert.equal(r.created, false)
})

ta('a RECURRENCE after sign-off is left OPEN, never superseded onto the finished item', async () => {
  // The silent mute this guards: item signed off to 'done', the underlying check goes red again weeks
  // later, its producer writes fleet_signals state='open'. Superseding the signal onto the finished
  // item would drop the alarm off /signals and the incident feed with NO live work item anywhere —
  // the problem is real and no surface shows it. So the signal is left OPEN and supersede is not called.
  for (const closed of ['done', 'abandoned']) {
    const b = fakeBoard()
    let supersedeCalls = 0
    b.deps.supersedeSignal = async () => { supersedeCalls++; return true }
    const inc = rogerInc()
    b.items.set(workItemSlugFor(inc), { id: `old-${closed}`, slug: workItemSlugFor(inc), status: closed })
    const r = await routeToWorkBoard(inc, classify(inc), b.deps)
    assert.equal(b.creates(), 0, `${closed}: the finished item is not re-minted`)
    assert.equal(r.created, false, `${closed}: nothing minted`)
    assert.equal(r.superseded, false, `${closed}: the recurrence is left OPEN`)
    assert.equal(supersedeCalls, 0, `${closed}: supersedeSignal is never called against a signed-off item`)
  }
})

ta('the prompt is attached to the item as evidence, once', async () => {
  const b = fakeBoard()
  const inc = rogerInc()
  await routeToWorkBoard(inc, classify(inc), b.deps)
  await routeToWorkBoard(inc, classify(inc), b.deps)
  const prompts = b.evidence.filter((e) => /PASTE THIS/.test(e.title))
  assert.equal(prompts.length, 1)
  assert.ok(prompts[0].detail.includes(inc.who_must_act))
})

ta('the signal is superseded EVERY time, not only on the run that minted the item', async () => {
  // A signal can be reopened by its producer after the hand-off. If supersede only ran on the
  // creating run, the row would come back and stay back — visible noise for work already queued.
  const b = fakeBoard()
  let calls = 0
  b.deps.supersedeSignal = async () => { calls++; return true }
  const inc = rogerInc()
  await routeToWorkBoard(inc, classify(inc), b.deps)
  await routeToWorkBoard(inc, classify(inc), b.deps)
  assert.equal(calls, 2)
})

ta('a hand-off that cannot be written NEVER supersedes the signal', async () => {
  // The one failure mode worse than a noisy board: a signal quietly removed into a task that
  // does not exist.
  const b = fakeBoard()
  b.deps.createItem = async () => { throw new Error('HTTP 500') }
  let superseded = false
  b.deps.supersedeSignal = async () => { superseded = true; return true }
  const inc = rogerInc()
  await assert.rejects(() => routeToWorkBoard(inc, classify(inc), b.deps), /HTTP 500/)
  assert.equal(superseded, false, 'the alarm stays up until the task provably exists')
})

// Mirror of Cockpit sql/062's lane derivation for a minted, UNOWNED hand-off row: needs_you is
// EXACTLY lane='your_turn', and for a row nobody is on that means status 'blocked'/'awaiting_signoff'
// owed to Roger. A 'next' row can never be your_turn. This is the contract the drainer must satisfy.
const needsYou = (row) =>
  ((row.status === 'blocked' || row.status === 'awaiting_signoff') &&
    String(row.blocked_owner || 'roger').toLowerCase() === 'roger')

ta('a hand-off is born unowned, from the monitor, and in the lane Roger can see', async () => {
  const b = fakeBoard()
  const inc = rogerInc()
  await routeToWorkBoard(inc, classify(inc), b.deps)
  const item = [...b.items.values()][0]
  // NOT 'next': a 'next' row derives lane='next', needs_you=false, so an item the drainer decided
  // needs Roger's hands would leave the alarm board and arrive nowhere he looks.
  assert.equal(item.status, 'blocked')
  assert.equal(item.blocked_owner, 'roger')
  assert.equal(item.source, 'monitor')
  assert.equal(item.kind, 'task')
  assert.equal(item.owner_session, undefined, 'nobody is on it yet — it carries no owner')
  assert.ok(needsYou(item), 'a handed-off item MUST be one work_board.needs_you can see (Cockpit sql/062)')
})

ta('PARKED claude-owned finding routed through the queue NEVER mints blocked_owner=roger', async () => {
  // The mechanism behind board-drainer re-owning dev work to Roger (2026-08-20/23, and 09-03): the
  // parked-handover queue (:2634) calls routeToWorkBoard for ANY parked finding regardless of
  // cls.owner. A finding classify() decided is Claude's must be minted on 'next', not Roger's lane.
  const b = fakeBoard()
  const inc = {
    source: 'production-monitor', key: 'fleet-signals-list-detail-drops-who-must-act',
    title: 'The list view drops who_must_act, so the detail shows nobody to act',
    severity: 'warning', status: 'blocked', opened_at: '2026-09-01T10:00:00Z',
    who_must_act: 'Claude - re-queue to a non-concurrent engineering run and author the coercion migration',
    root_cause: 'The list->detail join drops the column.',
  }
  const cls = classify(inc)
  assert.equal(cls.owner, 'claude', 'precondition: classify() owns this to Claude')
  // Called EXACTLY as the parked-handover queue at :2634 does.
  await routeToWorkBoard(inc, { ...cls, reason: 'auto-fix gave up after 3 attempts' }, b.deps)
  const item = [...b.items.values()][0]
  assert.equal(item.status, 'next', "a claude-owned parked finding lands on 'next', not Roger's lane")
  assert.notEqual(String(item.blocked_owner || '').toLowerCase(), 'roger', 'it NEVER mints blocked_owner=roger')
  assert.ok(!needsYou(item), 'and it is not something work_board.needs_you shows Roger')
})

ta('blocked_question is the prescribed ACTION, never byte-identical to the title', async () => {
  // The board renders "Action: <blocked_question>". Set to the title it states the PROBLEM, not what
  // to DO. It comes from the prescribed action (actionOf), falling back to the title only when the
  // finding carries no action at all.
  const b = fakeBoard()
  const inc = rogerInc()
  await routeToWorkBoard(inc, classify(inc), b.deps)
  const item = [...b.items.values()][0]
  const { title } = plainTitle(inc)
  assert.notEqual(item.blocked_question, title, 'blocked_question is not a copy of the title')
  assert.equal(item.blocked_question, actionOf(inc), 'it is the prescribed action, prefix stripped')
})

// ── the queue: a hand-off costs no agent run and no blast-radius budget ───────────────────

t('QUEUE: hand-offs are recorded without an agent and do NOT eat the per-run cap', () => {
  const mk = (key, who) => ({ inc: { key, source: 's', severity: 'critical', who_must_act: who, title: '', root_cause: '' }, cls: classify({ key, who_must_act: who, title: '', root_cause: '' }) })
  const routed = [
    mk('needs-roger-1', 'Roger - one decision: raise the plan or cut the loops'),
    mk('needs-roger-2', 'Claude - rotate the Supabase service key'),
    mk('fix-a', 'Claude - delete deploy.yml:864 from the prod-smoke step'),
    mk('fix-b', 'Claude - delete the two comments that claim a Safari fallback exists'),
    mk('fix-c', 'Claude - DROP the stale sentence from the alert copy'),
  ]
  const { toWork, toEscalate } = selectWorkQueue({ routed, state: { attempts: {}, stuck: {} }, now: Date.now() })
  assert.equal(toEscalate.filter((e) => e.why === 'handoff').length, 2)
  assert.equal(toWork.length, 3, 'all three code fixes still get their dispatch slots')
  assert.deepEqual(toWork.map((w) => w.inc.key), ['fix-a', 'fix-b', 'fix-c'])
})

t('QUEUE: a BELOW-THRESHOLD item that needs a person is still handed over', () => {
  // Found by a dry run against the live board: `backoffice-recurring-costs-unverified-rows` is
  // severity `info`, so the severity bar filtered it out BEFORE the hand-off branch and it stayed
  // on the alarm surface — too quiet to be worked, too human to be fixed. The bar is a
  // blast-radius dial for agent dispatches; a hand-off dispatches nothing.
  const who = 'Roger - open the recurring costs registry and enter the amounts from the invoices'
  const routed = [{ inc: { key: 'quiet', source: 's', severity: 'info', who_must_act: who }, cls: classify({ key: 'quiet', who_must_act: who }) }]
  const { toEscalate, belowBar } = selectWorkQueue({ routed, state: { attempts: {}, stuck: {} }, now: Date.now() })
  assert.equal(toEscalate.filter((e) => e.why === 'handoff').length, 1)
  assert.equal(belowBar, 0, 'and it is not ALSO counted as skipped-below-the-bar')
})

t('QUEUE: "Hand to Claude" outranks the hand-off — Roger asking for it wins', () => {
  const who = 'Roger - one decision: raise the plan or cut the loops'
  const routed = [{ inc: { key: 'k', source: 's', severity: 'critical', who_must_act: who }, cls: classify({ key: 'k', who_must_act: who }) }]
  const { toWork, toEscalate, hoisted } = selectWorkQueue({ routed, state: { attempts: {}, stuck: {} }, now: Date.now(), priorityKeys: ['k'] })
  assert.equal(toEscalate.filter((e) => e.why === 'handoff').length, 0, 'it must not be filed away behind his back')
  assert.deepEqual(hoisted, ['k'])
  assert.equal(toWork.length, 1)
})

t('a long title is cut at a CLAUSE, and the objections describe the title actually used', () => {
  // Also found by the dry run: `commit-review/Cockpit:2d2415c` produced a 138-character candidate
  // that was recorded as "too long" and then silently shortened, so the complaint referred to a
  // string nobody would ever see.
  const inc = {
    who_must_act: '',
    title: 'Cockpit 2d2415c: work_open with the same title flips an awaiting_signoff row back to in_progress, silently removing it from Roger\'s sign-off queue',
  }
  const { title, objections } = plainTitle(inc)
  assert.ok(title.length <= 120, `title is ${title.length} chars`)
  assert.doesNotMatch(title, /\S$/u.test(title) ? /Roge$/ : /$^/, 'never cut mid-word')
  assert.deepEqual(objections, titleObjections(title), 'the objections are about THIS string, not a discarded one')
  assert.deepEqual(objections, [])
})

t('QUEUE: BOARD_DRAINER_HANDOFF=0 puts the old behaviour back, unchanged', () => {
  const who = 'Roger - one decision: raise the plan or cut the loops'
  const routed = [{ inc: { key: 'k', source: 's', severity: 'critical', who_must_act: who }, cls: classify({ key: 'k', who_must_act: who }) }]
  const off = selectWorkQueue({ routed, state: { attempts: {}, stuck: {} }, now: Date.now(), handoff: false })
  assert.equal(off.toEscalate.filter((e) => e.why === 'handoff').length, 0)
  assert.equal(off.toWork.length, 1, 'with the switch off it is dispatched read-only, exactly as before')
})

// ── the JOIN step: a signal about a job already in progress lands ON that job ──────────────
// Roger, closing the external-tools work: "But why wasn't this added to the in progress task in
// the first place?" One job had fragmented into the in-progress item plus two monitor rows about
// the same object, each landing on him as blocked. These prove the drainer now attaches instead.

// A faithful stand-in for the live external-tools item a session held while the two signals fired.
const liveExternalTools = () => ({
  id: 'live-1',
  slug: 'list-every-external-tool-we-use-and-why',
  title: 'The External Tools page and its self-updating register',
  status: 'in_progress',
  owner_session: 'work-now-xyz',
  claim_paths: [
    'Internal Projects/Cockpit/src/pages/ExternalTools.tsx',
    'Internal Projects/Cockpit/src/hooks/useExternalTools.ts',
    'Internal Projects/Cockpit/sql',
  ],
})

// The two REAL signals that fragmented the job (verbatim subjects from the closeout).
const securitySignal = () => ({
  source: 'silent-failure', key: 'BackOffice:v-external-tools-anon-readable',
  title: 'v external tools is readable by anyone with the public anon key',
  severity: 'critical', status: 'open', opened_at: '2026-08-27T09:00:00Z',
  who_must_act: 'Claude - put security_invoker on the view so it obeys the caller\'s row-level security.',
  root_cause: 'v_external_tools is readable by anyone with the public anon key — a view runs with its owner\'s rights and bypasses RLS on the table underneath.',
})
const currencySignal = () => ({
  source: 'commit-review', key: 'Cockpit:external-tools-currency',
  title: 'The external-tools cost currency fix is live and verified on staging',
  severity: 'warning', status: 'open', opened_at: '2026-08-27T11:00:00Z',
  who_must_act: 'Roger - confirm the external tools money column reads correctly on production.',
  root_cause: 'The external tools cost currency now derives from the bill, not a blanket USD.',
})

t('signalObjects pulls files, paths and snake_case identifiers out of a signal', () => {
  const objs = signalObjects({ who_must_act: 'fix src/hooks/useExternalTools.ts', root_cause: 'v_external_tools bypasses RLS on api_entries', title: 'deploy.yml is red' })
  assert.ok(objs.includes('src/hooks/useExternalTools.ts'))
  assert.ok(objs.includes('v_external_tools'))
  assert.ok(objs.includes('api_entries'))
  assert.ok(objs.includes('deploy.yml'))
})

t('matchItem TIER 1: a signal that names a file the item CLAIMS', () => {
  const m = matchItem({ who_must_act: 'Claude - fix the total in src/hooks/useExternalTools.ts' }, liveExternalTools())
  assert.equal(m?.tier, 1)
})
t('matchItem TIER 2: a shared distinctive DIRECTORY, no shared file', () => {
  const item = { title: 'x', claim_paths: ['ReplyFlow/supabase/functions/reply-scheduler'] }
  const m = matchItem({ who_must_act: 'Claude - the reply-scheduler/index.ts loop never exits' }, item)
  assert.equal(m?.tier, 2)
})
t('matchItem TIER 3: a distinctive PHRASE in the title (the real security signal)', () => {
  const m = matchItem(securitySignal(), liveExternalTools())
  assert.equal(m?.tier, 3, 'v_external_tools renders to "external tools", which is in the item title')
})
t('matchItem: a GENERIC-only overlap (both touch Cockpit/src) is NOT a match', () => {
  const item = { title: 'Some unrelated dashboard work', claim_paths: ['Internal Projects/Cockpit/src/index.css'] }
  const m = matchItem({ who_must_act: 'Claude - fix Internal Projects/Cockpit/src/pages/Other.tsx' }, item)
  assert.equal(m, null, 'sharing only repo/src/pages says nothing — a wrong glue hides the signal')
})

t('findJoinTarget: AMBIGUOUS when two live jobs match equally — open the row, do not guess', () => {
  const a = { ...liveExternalTools(), id: 'a', slug: 'a' }
  const b = { ...liveExternalTools(), id: 'b', slug: 'b' }
  const j = findJoinTarget(securitySignal(), [a, b])
  assert.equal(j?.ambiguous, true)
  assert.equal(j.count, 2)
})
t('findJoinTarget: an item nobody is on (no owner_session) is never a target', () => {
  const unowned = { ...liveExternalTools(), owner_session: null }
  assert.equal(findJoinTarget(securitySignal(), [unowned]), null)
})

ta('JOIN (real signal at a real in-progress item): the security signal ATTACHES, mints no row, touches no owner', async () => {
  const board = fakeBoard()
  board.live.push(liveExternalTools())
  const inc = securitySignal()
  const r = await routeToWorkBoard(inc, classify(inc), board.deps)
  assert.equal(r.joined, true, 'it joins the live item')
  assert.equal(r.slug, 'list-every-external-tool-we-use-and-why', 'onto the session\'s item, by its slug')
  assert.equal(board.creates(), 0, 'NO sibling row is minted')
  assert.equal(board.items.size, 0)
  const marker = board.evidence.find((e) => e.itemId === 'live-1')
  assert.ok(marker, 'the marker is attached to the LIVE item so the owning session sees it')
  assert.match(marker.title, /machines spotted something/i)
  assert.ok(marker.detail.includes('v_external_tools'), 'and it carries the verbatim finding')
  // ROGER'S DECISION, 2026-08-28: attaching must not be what mutes the finding. Until then this
  // line asserted the opposite — that joining SUPERSEDED the signal, taking it out of the
  // `state=in.(open,acknowledged)` band every board surface reads. The finding then lived only in
  // the item's evidence trail, so if the owning session never read that trail and closed the job, a
  // one-off observation was gone. He was told that cost and chose to keep it visible.
  assert.deepEqual(board.superseded, [], 'joining must NOT supersede: that is what used to mute it')
  assert.deepEqual(board.joined, [{ inc, slug: 'list-every-external-tool-we-use-and-why' }],
    'the signal is marked as attached to the item, and stays on /signals until a person ticks it off')
})

ta('a JOINED signal is attached ONCE, however many times the drainer sees it again', async () => {
  // This matters ONLY because the signal now stays visible. While joining superseded the signal it
  // left the drainer's query after one run, so a second attach was unreachable; now the same
  // finding comes round every 20 minutes for as long as it is open, and without the guard the item
  // would collect an identical marker on every single run. The marker is worth having exactly once.
  const board = fakeBoard()
  board.live.push(liveExternalTools())
  const inc = securitySignal()
  const first = await routeToWorkBoard(inc, classify(inc), board.deps)
  assert.equal(first.marked, true, 'the first run attaches and marks')

  // Second run, exactly as the drainer would see it: the signal now carries the item it was
  // attached to (signalToIncident maps detail.work_item -> joined_to).
  const seenAgain = { ...inc, joined_to: 'list-every-external-tool-we-use-and-why' }
  const second = await routeToWorkBoard(seenAgain, classify(seenAgain), board.deps)
  assert.equal(second.joined, true, 'it is still reported as joined, not as new work')
  assert.equal(second.alreadyAttached, true, 'and it says why it did nothing')

  const markers = board.evidence.filter((e) => /machines spotted something/i.test(e.title))
  assert.equal(markers.length, 1, 'attaching twice must not put two identical markers on the item')
  assert.equal(board.creates(), 0, 'and still no row is minted on either run')
  assert.deepEqual(board.superseded, [], 'and it is never superseded on any run')
  assert.equal(board.joined.length, 1, 'nor is the signal re-marked once it already carries the item')
})

ta('a JOINED signal drops its auto-fix attempt counter — both the first attach and a later re-sighting', async () => {
  // b9f5ff2 moved the join path from returning `superseded` to `marked`/`alreadyAttached`, but the
  // consumer in main() cleared the counter only `if (r.superseded)` — unreachable on a join. So a
  // handed-over signal kept its counter forever and drifted toward the MAX_ATTEMPTS breaker. The
  // clear-decision is now handedOverClearsCounter(r); assert it fires on the ACTUAL return objects
  // routeToWorkBoard produces on both join branches, so the missing clear cannot come back.
  const board = fakeBoard()
  board.live.push(liveExternalTools())
  const inc = securitySignal()

  const first = await routeToWorkBoard(inc, classify(inc), board.deps)
  assert.equal(first.marked, true, 'the first run attaches and marks the signal')
  assert.equal(handedOverClearsCounter(first), true, 'a freshly-marked join clears the attempt counter')

  const seenAgain = { ...inc, joined_to: 'list-every-external-tool-we-use-and-why' }
  const second = await routeToWorkBoard(seenAgain, classify(seenAgain), board.deps)
  assert.equal(second.alreadyAttached, true, 'a re-sighting reports it is already attached')
  assert.equal(handedOverClearsCounter(second), true, 'an already-attached join also clears the counter')

  // The create/supersede contract is unchanged, and a genuine join-write FAILURE must NOT clear it.
  assert.equal(handedOverClearsCounter({ created: true, superseded: true }), true, 'a superseded create clears')
  assert.equal(handedOverClearsCounter({ joined: true, marked: false }), false, 'a failed join write leaves the counter armed')
  assert.equal(handedOverClearsCounter(null), false, 'a missing result never clears')
})

t('signalToIncident carries the item a finding is already attached to', () => {
  const withItem = signalToIncident({ source: 's', key: 'k', detail: { work_item: 'some-live-job' } })
  assert.equal(withItem.joined_to, 'some-live-job')
  const without = signalToIncident({ source: 's', key: 'k', detail: {} })
  assert.equal(without.joined_to, null, 'a signal attached to nothing must not read as attached to something')
})

ta("a JOINED signal keeps its findings and never lands in Roger's lane", async () => {
  // Quiet, not gone. The item carries the verbatim finding for the session that is on the job, and
  // nobody is paged, because the work is already being done. What changed on 2026-08-28 is only
  // that the SIGNAL is no longer taken off the page by the act of attaching.
  const board = fakeBoard()
  board.live.push(liveExternalTools())
  const inc = securitySignal()
  const r = await routeToWorkBoard(inc, classify(inc), board.deps)
  assert.equal(r.marked, true, 'the join path reports that the signal was marked, not superseded')
  assert.equal(r.superseded, undefined, 'and it no longer reports a supersede at all')
  const marker = board.evidence.find((e) => e.itemId === 'live-1')
  assert.ok(marker.detail.includes('v_external_tools'), 'the finding still reaches the working session verbatim')
  assert.equal(board.items.size, 0, 'no row exists to carry a blocked_owner')
})

ta('JOIN via TITLE (tier 3): the currency signal folds into the same live item', async () => {
  const board = fakeBoard()
  board.live.push(liveExternalTools())
  const inc = currencySignal()
  const r = await routeToWorkBoard(inc, classify(inc), board.deps)
  assert.equal(r.joined, true)
  assert.equal(board.creates(), 0)
})

ta('a signal that matches NOTHING still opens its own row, exactly as before', async () => {
  const board = fakeBoard()
  board.live.push(liveExternalTools())
  const inc = rogerInc()   // recurring_costs — unrelated to the external-tools item
  const r = await routeToWorkBoard(inc, classify(inc), board.deps)
  assert.equal(r.joined, undefined, 'not joined')
  assert.equal(board.creates(), 1, 'a fresh row is minted')
  const item = [...board.items.values()][0]
  assert.equal(item.blocked_owner, 'roger', 'and it lands in Roger\'s lane, unchanged')
})

ta('an AMBIGUOUS match opens the row rather than gluing to the wrong job', async () => {
  const board = fakeBoard()
  board.live.push({ ...liveExternalTools(), id: 'a', slug: 'a' })
  board.live.push({ ...liveExternalTools(), id: 'b', slug: 'b' })
  const inc = securitySignal()
  const r = await routeToWorkBoard(inc, classify(inc), board.deps)
  assert.equal(r.joined, undefined)
  assert.equal(board.creates(), 1, 'when two jobs match equally, mint a row — never guess which one')
})

ta('a JOINED signal never sets blocked_owner: the working session owns it, not Roger', async () => {
  const board = fakeBoard()
  board.live.push(liveExternalTools())
  const inc = securitySignal()
  await routeToWorkBoard(inc, classify(inc), board.deps)
  // nothing was minted, so no row carries blocked_owner; and the marker is a note, not a page.
  assert.equal(board.creates(), 0)
  const marker = board.evidence.find((e) => e.itemId === 'live-1')
  assert.equal(marker.kind, 'note')
})

t('joinMarker states the finding and is explicitly NOT a page for Roger', () => {
  const inc = securitySignal()
  const m = joinMarker(inc, classify(inc), { evidence: '“external tools” in title', tier: 3 })
  assert.ok(m.includes('v_external_tools'), 'the finding is verbatim')
  assert.ok(/instead of opening a separate row/i.test(m), 'it says why it landed here, not as a new row')
  assert.ok(/your call whether it is in scope/i.test(m), 'the owning session decides scope; it is not blocked on Roger')
})

// ── PARKING IS A HANDOVER, NOT A LANE (2026-09-02) ─────────────────────────────────────────
// A finding at the attempt ceiling is a finding three agent runs failed to close, which is the
// definition of `cls.handoff`. It is routed to the work board like any other item needing a
// person. These cases pin the ORDER and the CAP, because the order is the whole safeguard.
const parkedEntry = (key) => ({ inc: { source: 'commit-review', key, title: key }, cls: { reason: 'stuck' } })

t('parked findings are handed over OLDEST-PARKED FIRST, not in board order', () => {
  const parked = [parkedEntry('newest'), parkedEntry('oldest'), parkedEntry('middle')]
  const state = { stuck: {
    newest: { at: '2026-09-02T10:00:00Z' },
    oldest: { at: '2026-08-20T10:00:00Z' },
    middle: { at: '2026-08-28T10:00:00Z' },
  } }
  const q = parkedHandoverQueue({ parked, state, max: 3 })
  assert.deepEqual(q.map((e) => e.inc.key), ['oldest', 'middle', 'newest'])
})

t('an UNRECORDED park time sorts to the FRONT — it is the most neglected case, not the least', () => {
  const parked = [parkedEntry('dated'), parkedEntry('undated')]
  const state = { stuck: { dated: { at: '2026-08-20T10:00:00Z' }, undated: {} } }
  assert.equal(parkedHandoverQueue({ parked, state, max: 1 })[0].inc.key, 'undated')
})

t('the per-run cap holds, so a backlog drains steadily instead of flooding the board', () => {
  const parked = Array.from({ length: 9 }, (_, i) => parkedEntry(`k${i}`))
  const state = { stuck: Object.fromEntries(parked.map((e, i) => [e.inc.key, { at: `2026-08-${10 + i}T00:00:00Z` }])) }
  assert.equal(parkedHandoverQueue({ parked, state, max: 3 }).length, 3)
  assert.deepEqual(parkedHandoverQueue({ parked, state, max: 3 }).map((e) => e.inc.key), ['k0', 'k1', 'k2'])
})

t('the suppression ships with its own off switch: max 0 hands over nothing', () => {
  const parked = [parkedEntry('a')]
  assert.deepEqual(parkedHandoverQueue({ parked, state: { stuck: { a: {} } }, max: 0 }), [])
})

t('hand-off disabled globally disables the parked hand-over too — one switch, not two', () => {
  const parked = [parkedEntry('a')]
  assert.deepEqual(parkedHandoverQueue({ parked, state: { stuck: { a: {} } }, handoff: false, max: 3 }), [])
})

t('an empty parked list is not an error and hands nothing over', () => {
  assert.deepEqual(parkedHandoverQueue({ parked: [], state: {}, max: 3 }), [])
  assert.deepEqual(parkedHandoverQueue({ parked: undefined, state: undefined, max: 3 }), [])
})

// ── the clock an item is born with ────────────────────────────────────────────────────────

t('a minted item carries the FIRST SIGHTING of the signal, not the moment it was minted', () => {
  // Measured on production 2026-09-02: 18 of 36 open monitor-* items understated their own age,
  // by 93h on average and 348h at worst, because this field was left to default to now().
  assert.deepEqual(mintOpenedAt({ opened_at: '2026-08-19T10:00:00Z' }), { opened_at: '2026-08-19T10:00:00.000Z' })
})

t('NEVER FORWARD: a first sighting in the future is refused, not trusted', () => {
  const now = Date.parse('2026-09-02T12:00:00Z')
  assert.deepEqual(mintOpenedAt({ opened_at: '2026-09-09T00:00:00Z' }, now), {},
    'an item must never be made to look younger than the column default would make it')
})

t('an absent or unparseable first sighting falls back to the column default', () => {
  assert.deepEqual(mintOpenedAt({}), {})
  assert.deepEqual(mintOpenedAt({ opened_at: null }), {})
  assert.deepEqual(mintOpenedAt({ opened_at: 'not a date' }), {})
  assert.deepEqual(mintOpenedAt(undefined), {})
})

ta('routeToWorkBoard actually PUTS it on the row it inserts', async () => {
  const b = fakeBoard()
  const inc = rogerInc({ opened_at: '2026-08-19T10:00:00Z' })
  await routeToWorkBoard(inc, classify(inc), b.deps)
  const [item] = [...b.items.values()]
  assert.equal(item.opened_at, '2026-08-19T10:00:00.000Z',
    'the age the closer prints and the order the drainer works come from this column')
})

ta('REGRESSION: a signal with no first sighting still mints, with no opened_at key at all', async () => {
  const b = fakeBoard()
  const inc = rogerInc({ opened_at: null })
  await routeToWorkBoard(inc, classify(inc), b.deps)
  const [item] = [...b.items.values()]
  assert.ok(!('opened_at' in item), 'sending an explicit null would defeat the column default')
})

await Promise.all(pending)

console.log(`
${n} assertions passed.`)
