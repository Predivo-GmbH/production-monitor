/**
 * ONE ENTITY -> ONE WORK ITEM -> ONE CLOSURE.
 *
 * Three board defects, one missing mechanism — the signal<->work-item link was only ever written
 * forwards. These assertions cover all three through the REAL code path (routeToWorkBoard and
 * sweepFinishedWork against an injected board), not by reading the module:
 *
 *   A. a signal superseded onto an item, the item finished, the signal read back RESOLVED
 *      ("A complaint stays open after the work fixing it is finished")
 *   B. a signal whose KEY IS RENAMED keeps its task instead of minting a twin
 *      ("The board loses track of a task when a signal is renamed, and makes a second one")
 *   C. one fault arriving under two SOURCES gets one task, and finishing it closes BOTH rows
 *      ("One problem can show up twice on the monitoring board when two different alerts report it")
 *
 * And the refusals, which matter more than the features, because every one of them is a way this
 * change could have muted a live alarm:
 *   - a signal SEEN AGAIN after the item closed is a recurrence and stays open
 *   - a finished item is never an adoption target
 *   - a JOINED signal (visible on purpose, Roger 2026-08-28) is never adopted into a supersede
 *   - keys that merely SHARE A STEM are never treated as the same entity
 *
 * Run: node test/signal-closure.test.mjs   (exit 0 = all pass)
 */
import assert from 'node:assert'
import { routeToWorkBoard, sweepFinishedWork, workItemSlugFor, signalToIncident, classify } from '../scripts/board-drainer.mjs'
import { adoptionTarget, closurePlan, sameEntitySignals, resolvedPatch, closedAt } from '../scripts/lib/signal-closure.mjs'

let n = 0
const t = (name, fn) => { fn(); n++; console.log(`  ok - ${name}`) }
const pending = []
const ta = (name, fn) => { pending.push(fn().then(() => { n++; console.log(`  ok - ${name}`) })) }

const T = {
  opened: '2026-09-01T10:00:00.000Z',
  seenBeforeClose: '2026-09-02T09:00:00.000Z',
  closed: '2026-09-02T12:00:00.000Z',
  seenAfterClose: '2026-09-02T17:00:00.000Z',
}

/**
 * A fake BackOffice that behaves like the live one in the ways this change depends on:
 * fleet_signals rows addressed by (source,key), work_items addressed by slug, and — the part that
 * actually matters — a supersede that WRITES detail.work_item, because that written pointer is the
 * whole mechanism. A fake that skipped it would let every one of these tests pass against code that
 * cannot work.
 */
const fakeBoard = () => {
  const items = new Map()      // slug -> work item row
  const signals = new Map()    // `${source}|${key}` -> fleet_signals row
  const evidence = []
  let creates = 0
  let ids = 0

  const sigKey = (s, k) => `${s}|${k}`
  const api = {
    items, signals, evidence, creates: () => creates,

    addSignal(row) {
      const r = { id: `sig-${++ids}`, state: 'open', first_seen_at: T.opened, last_seen_at: T.seenBeforeClose, detail: {}, ...row }
      signals.set(sigKey(r.source, r.key), r)
      return r
    },
    getSignal(source, key) { return signals.get(sigKey(source, key)) || null },
    /** Rename a key the way the 2026-08-27 normalisation cutover did: the ROW survives, carrying
     *  its detail (and therefore its work_item pointer); only the key string changes. */
    renameKey(source, oldKey, newKey) {
      const r = signals.get(sigKey(source, oldKey))
      signals.delete(sigKey(source, oldKey))
      r.key = newKey
      signals.set(sigKey(source, newKey), r)
      return r
    },
    /** A work item reaches done/abandoned, exactly as work_close leaves it. */
    finishItem(slug, status = 'done', at = T.closed) {
      const it = items.get(slug)
      it.status = status
      it.closed_at = at
      return it
    },

    deps: {
      log() {},
      async findItem(slug) { return items.get(slug) || null },
      async createItem(row) { creates++; const it = { id: `id-${++ids}`, ...row }; items.set(row.slug, it); return it },
      async addEvidence(itemId, ev) { evidence.push({ itemId, ...ev }) },
      async listLiveItems() { return [] },
      async markSignalJoined() { return true },

      /** The real supersede's observable effect: state -> superseded, and detail.work_item set. */
      async supersedeSignal(inc, slug) {
        const r = signals.get(sigKey(inc.source, inc.key))
        if (!r) return false
        r.state = 'superseded'
        r.resolved_at = T.seenBeforeClose
        r.detail = { ...r.detail, work_item: slug }
        return true
      },

      /** Same two exact reads the live wiring does, served from the fake tables. */
      async findAdoptableItem(inc) {
        const pointerItem = inc?.joined_to ? (items.get(inc.joined_to) || null) : null
        const siblingItems = []
        for (const s of signals.values()) {
          if (s.key !== inc.key || s.source === inc.source) continue
          const it = s?.detail?.work_item ? items.get(s.detail.work_item) : null
          if (it) siblingItems.push({ signal: s, item: it })
        }
        return adoptionTarget(inc, { pointerItem, siblingItems })
      },

      async listPointedActiveSignals() {
        return [...signals.values()].filter((s) => s.state === 'open' || s.state === 'acknowledged')
      },
      async findItemsBySlugs(slugs) {
        return [...new Set(slugs)].map((s) => items.get(s)).filter(Boolean)
      },
      async resolveSignal(row, item, why) {
        const patch = resolvedPatch({ row, item, why })
        Object.assign(row, patch)
        return true
      },
    },
  }
  return api
}

/** A signal the drainer will classify as needing a person, so it routes to the work board. */
const rogerSignal = (over = {}) => ({
  source: 'commit-review',
  key: 'BackOffice:e2492d9:health-monitor-has-no-page-policy-row',
  title: 'The health monitor has no page policy row',
  severity: 'warning',
  summary: 'the paging rule for health-monitor was never inserted',
  detail: { who_must_act: 'Roger - decide whether health-monitor may ring the phone' },
  ...over,
})
const inc = (row) => signalToIncident(row)

// ══ A. the reverse link: a finished item closes its own signal ════════════════════════════════

ta('A signal superseded onto an item is READ BACK RESOLVED once that item is finished', async () => {
  const b = fakeBoard()
  const sig = b.addSignal(rogerSignal())
  const i = inc(sig)

  // 1. the drainer routes it: an item is minted and the signal is superseded onto it
  const r = await routeToWorkBoard(i, classify(i), b.deps)
  assert.equal(r.created, true, 'the hand-off mints the work item')
  assert.equal(r.superseded, true, 'and supersedes the signal onto it')
  const live = b.getSignal(sig.source, sig.key)
  assert.equal(live.state, 'superseded')
  assert.equal(live.detail.work_item, r.slug, 'the forward pointer is written — this is what the reverse link walks')

  // 2. the signal's producer sees the problem again BEFORE the work finishes, so the row returns to
  //    the active band still carrying its pointer. This is the shape the live board is actually in:
  //    only 2 of 43 active rows carried a pointer when this was measured, and this is how.
  live.state = 'open'
  live.last_seen_at = T.seenBeforeClose

  // 3. Roger signs the work off
  b.finishItem(r.slug, 'done', T.closed)

  // 4. the sweep walks the link backwards
  const sw = await sweepFinishedWork(b.deps)
  assert.equal(sw.errors.length, 0, sw.errors.join('; '))
  assert.equal(sw.resolved.length, 1, 'the finished item closes its own signal')

  // 5. READ IT BACK. This is the assertion the whole item asks for.
  const after = b.getSignal(sig.source, sig.key)
  assert.equal(after.state, 'resolved', 'a fixed complaint must not sit open to be re-derived into a fresh question')
  assert.equal(after.detail.closed_by_work_item, r.slug, 'and it says WHICH finished item closed it')
  assert.equal(after.page_due_at, null, 'an armed page about signed-off work is cancelled')
  assert.ok(after.page_suppressed_reason.includes(r.slug), 'with the reason named, not silently')
})

ta('BOTH statuses count as finished: abandoned closes the signal exactly like done', async () => {
  for (const status of ['done', 'abandoned']) {
    const b = fakeBoard()
    const sig = b.addSignal(rogerSignal())
    const r = await routeToWorkBoard(inc(sig), classify(inc(sig)), b.deps)
    const live = b.getSignal(sig.source, sig.key)
    live.state = 'open'; live.last_seen_at = T.seenBeforeClose
    b.finishItem(r.slug, status, T.closed)
    await sweepFinishedWork(b.deps)
    assert.equal(b.getSignal(sig.source, sig.key).state, 'resolved', `${status} must close the signal`)
  }
})

ta('THE GUARD: a signal SEEN AGAIN after the close is a recurrence and stays OPEN', async () => {
  // Measured on the live board while writing this: silent-failure/inbox-triage:labelled-threads-
  // leave-inbox pointed at monitor-inbox-triage-labelled-threads-leave-in-75530be1, done at
  // 2026-09-02T13:14:10Z, and its producer saw it again at 17:24:46Z. A blanket "the item is done,
  // resolve the signal" would have muted a LIVE fault whose only work item was already signed off.
  const b = fakeBoard()
  const sig = b.addSignal(rogerSignal())
  const r = await routeToWorkBoard(inc(sig), classify(inc(sig)), b.deps)
  const live = b.getSignal(sig.source, sig.key)
  live.state = 'open'
  b.finishItem(r.slug, 'done', T.closed)
  live.last_seen_at = T.seenAfterClose            // the problem came back AFTER the sign-off

  const sw = await sweepFinishedWork(b.deps)
  assert.equal(sw.resolved.length, 0, 'a recurrence must never be resolved by the sweep')
  assert.equal(sw.keptOpen.length, 1)
  assert.match(sw.keptOpen[0].why, /recurrence/i, 'and the log says why it was left standing')
  assert.equal(b.getSignal(sig.source, sig.key).state, 'open', 'the alarm is still on the board')
})

t('a signal with no readable last_seen_at is LEFT OPEN — an unorderable pair is never resolved', () => {
  const item = { slug: 'monitor-x', status: 'done', closed_at: T.closed }
  const plan = closurePlan({ item, signals: [{ id: 's1', source: 'a', key: 'k', state: 'open', detail: { work_item: 'monitor-x' }, last_seen_at: null }] })
  assert.equal(plan.resolve.length, 0)
  assert.equal(plan.keepOpen.length, 1)
})

t('an item with no readable close time resolves NOTHING', () => {
  const plan = closurePlan({ item: { slug: 'monitor-x', status: 'done' }, signals: [{ id: 's1', source: 'a', key: 'k', state: 'open', detail: { work_item: 'monitor-x' }, last_seen_at: T.seenBeforeClose }] })
  assert.equal(plan.resolve.length, 0)
  assert.match(plan.skipped, /close time/)
})

t('a LIVE item resolves nothing — only done/abandoned close their signals', () => {
  for (const status of ['next', 'blocked', 'in_progress', 'awaiting_signoff']) {
    const plan = closurePlan({ item: { slug: 'monitor-x', status, closed_at: null }, signals: [{ id: 's1', source: 'a', key: 'k', state: 'open', detail: { work_item: 'monitor-x' }, last_seen_at: T.seenBeforeClose }] })
    assert.equal(plan.resolve.length, 0, `${status} is not finished`)
    assert.ok(plan.skipped, `${status} is skipped explicitly`)
  }
})

t('closedAt falls back to state_since, and refuses an unparseable value', () => {
  assert.equal(closedAt({ closed_at: T.closed }), T.closed)
  assert.equal(closedAt({ state_since: T.closed }), T.closed)
  assert.equal(closedAt({ closed_at: 'not a date' }), null)
  assert.equal(closedAt({}), null)
})

// ══ B. a renamed key keeps its task instead of minting a twin ═════════════════════════════════

ta('A RENAMED KEY adopts the task it already has, instead of minting a second one', async () => {
  // The 2026-08-27 key-normalisation cutover, reproduced: the slug is sha1(source|key), so renaming
  // the key changes the hash, the drainer finds no item under the new hash, and mints a twin —
  // stranding the original (this is how 4cc5f100 and 48df96b6 were orphaned, with their live twins
  // d5157eb6 and 32f47fad carrying the current signals).
  const b = fakeBoard()
  const sig = b.addSignal(rogerSignal({ source: 'commit-review', key: 'BackOffice:62520d7:plus-tagged-emails-counted-as-internal-x' }))
  const first = await routeToWorkBoard(inc(sig), classify(inc(sig)), b.deps)
  assert.equal(b.creates(), 1)

  // the cutover renames the key; the ROW survives, still carrying detail.work_item
  const renamed = b.renameKey('commit-review', sig.key, 'BackOffice:62520d7:plus-tagged-emails-counted-as-internal')
  renamed.state = 'open'
  const i2 = inc(renamed)
  assert.notEqual(workItemSlugFor(i2), first.slug, 'the rename really does move the hash — otherwise this test proves nothing')

  const second = await routeToWorkBoard(i2, classify(i2), b.deps)
  assert.equal(b.creates(), 1, 'NO twin is minted: the task the signal already points at is adopted')
  assert.equal(second.created, false)
  assert.equal(second.slug, first.slug, 'and it is the ORIGINAL item, not a new one')
  assert.equal(second.adopted.via, 'stored-pointer', 'adopted by the exact pointer the drainer wrote itself')
  assert.equal(second.superseded, true, 'the renamed signal is handed over onto that same item')
  assert.equal(b.getSignal('commit-review', renamed.key).detail.work_item, first.slug)
})

ta('a renamed key whose task is already FINISHED is NOT adopted — that would be the sign-off mute', async () => {
  const b = fakeBoard()
  const sig = b.addSignal(rogerSignal({ key: 'BackOffice:abc:something' }))
  const first = await routeToWorkBoard(inc(sig), classify(inc(sig)), b.deps)
  b.finishItem(first.slug, 'done', T.closed)
  const renamed = b.renameKey(sig.source, sig.key, 'BackOffice:abc:something-normalised')
  renamed.state = 'open'
  const r = await routeToWorkBoard(inc(renamed), classify(inc(renamed)), b.deps)
  assert.equal(r.adopted, null, 'a finished item is never an adoption target')
  assert.equal(b.creates(), 2, 'a recurrence after sign-off is NEW work and gets its own row')
})

t('a pointer to an item that no longer exists is ignored, not followed', () => {
  assert.equal(adoptionTarget({ key: 'k', source: 's', joined_to: 'monitor-gone' }, { pointerItem: null }), null)
})

t('a JOINED signal is NEVER adopted — it stays visible on /signals until a person ticks it off', () => {
  // Roger, 2026-08-28: attaching a finding to a live job must not mute it. Adoption routes a signal
  // into supersedeSignal, which DOES mute it. joined_at is the only field that tells the two apart.
  const joined = { source: 'commit-review', key: 'k', joined_to: 'monitor-live-job', joined_at: T.seenBeforeClose }
  assert.equal(adoptionTarget(joined, { pointerItem: { slug: 'monitor-live-job', status: 'in_progress' } }), null)
  // the same row WITHOUT joined_at (i.e. superseded, already muted) is adoptable
  const superseded = { ...joined, joined_at: null }
  assert.equal(adoptionTarget(superseded, { pointerItem: { slug: 'monitor-live-job', status: 'in_progress' } }).via, 'stored-pointer')
})

t('signalToIncident carries joined_at, which is what makes that distinction possible', () => {
  assert.equal(inc({ source: 'a', key: 'k', detail: { work_item: 'w', joined_at: T.opened } }).joined_at, T.opened)
  assert.equal(inc({ source: 'a', key: 'k', detail: { work_item: 'w' } }).joined_at, null)
})

// ══ C. one fault, two sources: one task, and both rows close together ═════════════════════════

ta('ONE FAULT REPORTED TWICE gets ONE work item, not two', async () => {
  // upsert_incident deduplicates on the PAIR (source, key), so a fault reaching us by healthchecks
  // mail and by backoffice mail is two rows. Two rows hash to two slugs and became two tasks.
  const b = fakeBoard()
  const first = b.addSignal({ source: 'healthchecks', key: 'mailer-config-guard', title: 'Scheduled job stopped running: mailer-config-guard', severity: 'warning', summary: 'the guard lost access', detail: { who_must_act: 'Roger - restore the mailer guard credential' } })
  const r1 = await routeToWorkBoard(inc(first), classify(inc(first)), b.deps)
  assert.equal(b.creates(), 1)

  const second = b.addSignal({ source: 'production-monitor', key: 'mailer-config-guard', title: '[MAILERS] the guard lost access', severity: 'warning', summary: 'the guard lost access', detail: { who_must_act: 'Roger - restore the mailer guard credential' } })
  const r2 = await routeToWorkBoard(inc(second), classify(inc(second)), b.deps)

  assert.equal(b.creates(), 1, 'the second channel must not mint a second task for the same fault')
  assert.equal(r2.slug, r1.slug)
  assert.equal(r2.adopted.via, 'sibling-key', 'adopted on EXACT key equality, under a different source')
})

ta('finishing that one item closes EVERY row for the entity, not just the one that was pointed at', async () => {
  const b = fakeBoard()
  const a = b.addSignal({ source: 'healthchecks', key: 'ci-cost-guard', title: 'Scheduled job stopped running: ci-cost-guard', severity: 'warning', summary: 'x', detail: { who_must_act: 'Roger - re-enable the cost guard' } })
  const r = await routeToWorkBoard(inc(a), classify(inc(a)), b.deps)
  // the twin arrives from the other channel and never gets a pointer of its own
  const twin = b.addSignal({ source: 'production-monitor', key: 'ci-cost-guard', title: 'ci-cost-guard is dark', severity: 'warning', summary: 'x' })
  const back = b.getSignal('healthchecks', 'ci-cost-guard')
  back.state = 'open'; back.last_seen_at = T.seenBeforeClose
  b.finishItem(r.slug, 'done', T.closed)

  const sw = await sweepFinishedWork(b.deps)
  assert.equal(sw.errors.length, 0, sw.errors.join('; '))
  assert.equal(sw.resolved.length, 2, 'both rows for one fault are closed together')
  assert.equal(b.getSignal('healthchecks', 'ci-cost-guard').state, 'resolved', 'the pointed row')
  assert.equal(b.getSignal('production-monitor', 'ci-cost-guard').state, 'resolved', 'and its twin, which carried no pointer of its own')
  assert.equal(twin.detail.closed_by_work_item, r.slug)
})

ta('but a twin SEEN AGAIN after the close is still left open, per row', async () => {
  const b = fakeBoard()
  const a = b.addSignal({ source: 'healthchecks', key: 'ci-cost-guard', title: 'x', severity: 'warning', summary: 'x', detail: { who_must_act: 'Roger - do a thing' } })
  const r = await routeToWorkBoard(inc(a), classify(inc(a)), b.deps)
  b.addSignal({ source: 'production-monitor', key: 'ci-cost-guard', title: 'y', severity: 'warning', summary: 'y', last_seen_at: T.seenAfterClose })
  const back = b.getSignal('healthchecks', 'ci-cost-guard')
  back.state = 'open'; back.last_seen_at = T.seenBeforeClose
  b.finishItem(r.slug, 'done', T.closed)

  const sw = await sweepFinishedWork(b.deps)
  assert.equal(sw.resolved.length, 1, 'the stale row closes')
  assert.equal(sw.keptOpen.length, 1, 'the row that fired again does not')
  assert.equal(b.getSignal('production-monitor', 'ci-cost-guard').state, 'open')
})

t('a same-key SIBLING carrying its OWN pointer to a still-live item is LEFT OPEN', () => {
  // The (source,key) split of defect 3, but the sibling points at a DIFFERENT work item that is NOT
  // finished. sameEntitySignals admits it on exact key equality alone; resolving it here would cancel
  // the alarm for work nobody finished and repoint the row at the wrong task. It must stand.
  const item = { slug: 'monitor-finished', status: 'done', closed_at: T.closed }
  const signals = [
    { id: 's1', source: 'healthchecks', key: 'k', state: 'open', detail: { work_item: 'monitor-finished' }, last_seen_at: T.seenBeforeClose },
    { id: 's2', source: 'production-monitor', key: 'k', state: 'open', detail: { work_item: 'monitor-other-still-open' }, last_seen_at: T.seenBeforeClose },
  ]
  const plan = closurePlan({ item, signals })
  assert.equal(plan.resolve.length, 1, 'the row pointing at the finished item still closes')
  assert.equal(plan.resolve[0].row.id, 's1')
  assert.equal(plan.keepOpen.length, 1, 'the sibling pointing at a live item is left standing')
  assert.equal(plan.keepOpen[0].row.id, 's2')
  assert.match(plan.keepOpen[0].why, /monitor-other-still-open/, 'and the why names the other task')
})

t('a resolve NEVER changes detail.work_item — only the closed_by_work_item audit fields are added', () => {
  // Defensive twin of the guard above: even a legitimately resolved row must keep its own forward
  // pointer, so a resolve can never repoint a signal at the finishing item and strand the real task.
  const row = { source: 'production-monitor', key: 'k', detail: { work_item: 'monitor-someone-elses-task' } }
  const item = { slug: 'monitor-finished', status: 'done', closed_at: T.closed }
  const patch = resolvedPatch({ row, item, why: 'x' })
  assert.equal(patch.detail.work_item, 'monitor-someone-elses-task', 'the row keeps its own pointer, unchanged')
  assert.equal(patch.detail.closed_by_work_item, 'monitor-finished', 'the finishing item is recorded only in the audit field')
})

// ══ the refusals that stop this becoming a silent merge ═══════════════════════════════════════

t('NO STEM MATCHING: keys that share a prefix are NOT the same entity', () => {
  // This is the rejected fix, asserted as a refusal. A key-stem fallback would silently merge two
  // different signals whose keys share a prefix, and a silent merge is worse than a duplicate
  // because a duplicate is visible.
  const signals = [
    { id: '1', source: 'a', key: 'BackOffice:abc:mailer-guard', state: 'open', detail: { work_item: 'monitor-x' }, last_seen_at: T.seenBeforeClose },
    { id: '2', source: 'b', key: 'BackOffice:abc:mailer-guard-v2', state: 'open', detail: {}, last_seen_at: T.seenBeforeClose },
    { id: '3', source: 'b', key: 'BackOffice:abc:mailer', state: 'open', detail: {}, last_seen_at: T.seenBeforeClose },
  ]
  const members = sameEntitySignals('monitor-x', signals)
  assert.deepEqual(members.map((m) => m.row.id), ['1'], 'only the exact-key row belongs to the entity')
})

t('a sibling under a DIFFERENT key is never adopted', () => {
  const r = adoptionTarget({ source: 'healthchecks', key: 'mailer-config-guard' }, {
    siblingItems: [{ signal: { source: 'production-monitor', key: 'mailer-config-guard-v2' }, item: { slug: 'monitor-other', status: 'blocked' } }],
  })
  assert.equal(r, null)
})

t('TWO different live sibling items = ambiguous = mint, never guess', () => {
  const r = adoptionTarget({ source: 'healthchecks', key: 'k' }, {
    siblingItems: [
      { signal: { source: 'sentry', key: 'k' }, item: { slug: 'monitor-one', status: 'blocked' } },
      { signal: { source: 'cron', key: 'k' }, item: { slug: 'monitor-two', status: 'next' } },
    ],
  })
  assert.equal(r, null, 'gluing to the wrong task buries the signal; an extra row is visible')
})

t('two sibling rows pointing at the SAME item are not ambiguous', () => {
  const r = adoptionTarget({ source: 'healthchecks', key: 'k' }, {
    siblingItems: [
      { signal: { source: 'sentry', key: 'k' }, item: { slug: 'monitor-one', status: 'blocked' } },
      { signal: { source: 'cron', key: 'k' }, item: { slug: 'monitor-one', status: 'blocked' } },
    ],
  })
  assert.equal(r.slug, 'monitor-one')
})

t('a sibling whose item is FINISHED is not adopted', () => {
  const r = adoptionTarget({ source: 'healthchecks', key: 'k' }, {
    siblingItems: [{ signal: { source: 'sentry', key: 'k' }, item: { slug: 'monitor-one', status: 'done' } }],
  })
  assert.equal(r, null)
})

t('the row itself is never its own sibling', () => {
  const r = adoptionTarget({ source: 'healthchecks', key: 'k' }, {
    siblingItems: [{ signal: { source: 'healthchecks', key: 'k' }, item: { slug: 'monitor-one', status: 'blocked' } }],
  })
  assert.equal(r, null, 'same source + same key is the SAME row, not a second report of the fault')
})

// ══ the sweep does not report success for doing nothing ═══════════════════════════════════════

ta('a READ FAILURE is reported as an error, never as a clean zero', async () => {
  const b = fakeBoard()
  b.deps.listPointedActiveSignals = async () => { throw new Error('HTTP 503') }
  const sw = await sweepFinishedWork(b.deps)
  assert.equal(sw.errors.length, 1)
  assert.match(sw.errors[0], /503/)
  assert.equal(sw.resolved.length, 0)
})

ta('a WRITE failure on one row does not stop the others, and is named', async () => {
  const b = fakeBoard()
  const a = b.addSignal({ source: 'healthchecks', key: 'k1', title: 'x', severity: 'warning', summary: 'x', detail: { who_must_act: 'Roger - do a thing' } })
  const r = await routeToWorkBoard(inc(a), classify(inc(a)), b.deps)
  b.addSignal({ source: 'production-monitor', key: 'k1', title: 'y', severity: 'warning', summary: 'y' })
  const back = b.getSignal('healthchecks', 'k1')
  back.state = 'open'; back.last_seen_at = T.seenBeforeClose
  b.finishItem(r.slug, 'done', T.closed)
  let first = true
  const real = b.deps.resolveSignal
  b.deps.resolveSignal = async (row, item, why) => { if (first) { first = false; throw new Error('HTTP 409') } return real(row, item, why) }

  const sw = await sweepFinishedWork(b.deps)
  assert.equal(sw.errors.length, 1, 'the failure is named')
  assert.equal(sw.resolved.length, 1, 'and the other row still closes')
})

ta('DRY-RUN writes nothing', async () => {
  const b = fakeBoard()
  const a = b.addSignal(rogerSignal())
  const r = await routeToWorkBoard(inc(a), classify(inc(a)), b.deps)
  const back = b.getSignal(a.source, a.key)
  back.state = 'open'; back.last_seen_at = T.seenBeforeClose
  b.finishItem(r.slug, 'done', T.closed)
  const sw = await sweepFinishedWork(b.deps, { dryRun: true })
  assert.equal(sw.resolved.length, 1, 'it still REPORTS what it would close')
  assert.equal(b.getSignal(a.source, a.key).state, 'open', 'but nothing is written')
})

ta('the sweep is IDEMPOTENT: a second pass finds nothing left to do', async () => {
  const b = fakeBoard()
  const a = b.addSignal(rogerSignal())
  const r = await routeToWorkBoard(inc(a), classify(inc(a)), b.deps)
  const back = b.getSignal(a.source, a.key)
  back.state = 'open'; back.last_seen_at = T.seenBeforeClose
  b.finishItem(r.slug, 'done', T.closed)
  await sweepFinishedWork(b.deps)
  const again = await sweepFinishedWork(b.deps)
  assert.equal(again.resolved.length, 0, 'an already-resolved row is out of the active band')
})

// ══ nothing above changed the ordinary path ══════════════════════════════════════════════════

ta('REGRESSION: an ordinary signal with no pointer and no twin still mints its own item', async () => {
  const b = fakeBoard()
  const a = b.addSignal(rogerSignal())
  const r = await routeToWorkBoard(inc(a), classify(inc(a)), b.deps)
  assert.equal(r.created, true)
  assert.equal(r.adopted, null)
  assert.equal(r.slug, workItemSlugFor(inc(a)), 'the slug is still the hash of source|key')
  assert.equal(b.evidence.filter((e) => /PASTE THIS/.test(e.title)).length, 1, 'and it still carries its prompt')
})

ta('REGRESSION: adoption never spams the adopted item with a fresh prompt on every tick', async () => {
  const b = fakeBoard()
  const a = b.addSignal(rogerSignal({ key: 'BackOffice:zzz:thing' }))
  const first = await routeToWorkBoard(inc(a), classify(inc(a)), b.deps)
  const before = b.evidence.length
  const renamed = b.renameKey(a.source, a.key, 'BackOffice:zzz:thing-normalised')
  renamed.state = 'open'
  await routeToWorkBoard(inc(renamed), classify(inc(renamed)), b.deps)
  await routeToWorkBoard(inc(renamed), classify(inc(renamed)), b.deps)
  assert.equal(b.evidence.length, before, 'an adopted item gets no new evidence rows')
  assert.equal(b.creates(), 1)
  assert.ok(first.slug)
})

ta('REGRESSION: a board with no finished items resolves nothing and errors on nothing', async () => {
  const b = fakeBoard()
  const a = b.addSignal(rogerSignal())
  await routeToWorkBoard(inc(a), classify(inc(a)), b.deps)
  const sw = await sweepFinishedWork(b.deps)
  assert.equal(sw.resolved.length, 0)
  assert.equal(sw.errors.length, 0)
})

await Promise.all(pending)
console.log(`\n${n} assertions passed.`)
