/**
 * Unit tests for board-drainer's pure decision logic:
 *  - classify(): owner routing + hard-escalate gate (destructive/human classes never dispatch)
 *  - verdictToUpsert(): the receipt-guard (never close without a verified receipt)
 * Run: node test/board-drainer.test.mjs   (exit 0 = all pass)
 */
import assert from 'node:assert'
import { classify, verdictToUpsert, meetsThreshold, scoutReportToIncident, stuckWhoMustAct, isScoutDerived, selectWorkQueue, timeoutCostsAnAttempt, AGENT_TIMED_OUT } from '../scripts/board-drainer.mjs'

let n = 0
const t = (name, fn) => { fn(); n++; console.log(`  ok - ${name}`) }

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

t("REGRESSION GUARD: an OAuth scout report still hard-escalates, autonomy did NOT widen", () => {
  // Phase 4 must not smuggle a new autonomy class in. This report is exactly the kind the
  // scout surfaces, and OAuth is in HUMAN_HANDS, so it must still land in verify-only mode
  // owned by Roger, identical to before Phase 4 existed.
  const c = classify(scoutReportToIncident(rep()))
  assert.equal(c.mode, 'verify')
  assert.equal(c.owner, 'roger')
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

t('DEADLOCK: three ceiling-stuck items at the head do NOT consume the dispatch budget', () => {
  const routed = [wq('stuck-1'), wq('stuck-2'), wq('stuck-3'), wq('fixable-a'), wq('fixable-b'), wq('fixable-c'), wq('fixable-d')]
  const state = { attempts: { ...atCeiling }, stuck: { 'stuck-1': {}, 'stuck-2': {}, 'stuck-3': {} } }
  const { toWork, parked } = selectWorkQueue({ routed, state })
  assert.equal(parked.length, 3, 'the three ceiling items are parked')
  assert.equal(toWork.length, 3, 'and the run still dispatches a full budget')
  assert.deepEqual(toWork.map((r) => r.inc.key), ['fixable-a', 'fixable-b', 'fixable-c'])
})

t('DEADLOCK: a board of NOTHING BUT stuck items dispatches nothing and parks everything', () => {
  const routed = [wq('stuck-1'), wq('stuck-2'), wq('stuck-3')]
  const state = { attempts: { ...atCeiling }, stuck: { 'stuck-1': {}, 'stuck-2': {}, 'stuck-3': {} } }
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
  const state = { attempts: { 'stuck-1': 3 }, stuck: { 'stuck-1': { at: 'x', attempts: 3 } } }
  const { toEscalate, parked } = selectWorkQueue({ routed, state })
  assert.equal(toEscalate.length, 0, 'no second write')
  assert.equal(parked.length, 1)
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
  const state = { attempts: { ...atCeiling }, stuck: { 'stuck-1': {}, 'stuck-2': {}, 'stuck-3': {} } }
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

console.log(`
${n} assertions passed.`)
