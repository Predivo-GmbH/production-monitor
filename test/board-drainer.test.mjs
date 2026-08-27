/**
 * Unit tests for board-drainer's pure decision logic:
 *  - classify(): owner routing + hard-escalate gate (destructive/human classes never dispatch)
 *  - verdictToUpsert(): the receipt-guard (never close without a verified receipt)
 * Run: node test/board-drainer.test.mjs   (exit 0 = all pass)
 */
import assert from 'node:assert'
import { classify, verdictToUpsert, meetsThreshold, scoutReportToIncident, stuckWhoMustAct, isScoutDerived, selectWorkQueue, timeoutCostsAnAttempt, AGENT_TIMED_OUT, boardQueryUrl, signalToIncident, writableToIncidentBoard, parkedFields } from '../scripts/board-drainer.mjs'

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

t('WRITE-TARGET GUARD: only sources monitoring_incidents accepts may be worked', () => {
  // Verified live against BOTH databases 2026-08-27: the source CHECK is
  // healthchecks|sentry|production-monitor|cron|silent-failure|commit-review. fleet_signals has
  // no such constraint and has carried __drill__ and board-drainer rows. Working one of those
  // would 400 on upsert_incident and throw the item out of its own run — the fail-open class
  // isScoutDerived() exists for.
  for (const source of ['healthchecks', 'sentry', 'production-monitor', 'cron', 'silent-failure', 'commit-review']) {
    assert.equal(writableToIncidentBoard({ source }), true, `${source} is on the incidents CHECK`)
  }
  for (const source of ['__drill__', 'board-drainer', 'scout-ux', 'kb-learning', undefined]) {
    assert.equal(writableToIncidentBoard({ source }), false, `${source} would 400 on upsert_incident`)
  }
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

console.log(`
${n} assertions passed.`)
