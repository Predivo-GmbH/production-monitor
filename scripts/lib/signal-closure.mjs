/**
 * ONE ENTITY -> ONE WORK ITEM -> ONE CLOSURE.
 *
 * The board-drainer supersedes a fleet signal onto a work item (routeToWorkBoard). That link is
 * written in ONE direction only, and three board defects all fall out of the same missing half:
 *
 *   1. "A complaint stays open after the work fixing it is finished."
 *      Nothing resolves the signal when the item reaches done/abandoned, so a fixed complaint sits
 *      in the active band for ever and anything that re-derives work from open signals mints a
 *      fresh question about a problem that no longer exists. It did exactly that on 2026-09-02:
 *      commit-review/BackOffice:e2492d9:health-monitor-has-no-page-policy-row was put back on
 *      Roger's lane at 04:07:39Z about a paging rule armed in production at 2026-09-01 20:45:30Z.
 *      A person had to resolve that row by hand at 06:08:36Z. -> closurePlan()
 *
 *   2. "The board loses track of a task when a signal is renamed, and makes a second one."
 *      workItemSlugFor() hashes source|key, so a signal's KEY IS ITS TASK IDENTITY. The 2026-08-27
 *      key-normalisation cutover renamed two commit-review keys; the next drainer run hashed the
 *      NEW keys, found no item, and minted twins (d5157eb6, 32f47fad), stranding the originals
 *      (4cc5f100, 48df96b6) whose keys no longer existed. -> adoptionTarget(), via 'stored-pointer'
 *
 *   3. "One problem can show up twice on the monitoring board when two different alerts report it."
 *      upsert_incident deduplicates on the PAIR (source, key), so one fault arriving through two
 *      channels becomes two signal rows -- measured 2026-09-02: 12 defect-shaped pairs in 659 rows
 *      (mailer-config-guard, ci-cost-guard, ci-runner-watchdog, kb-learning-loop, ...). Two rows
 *      then hash to two slugs and become TWO work items for one fault, and finishing one leaves the
 *      other open. -> adoptionTarget() via 'sibling-key', and sameEntitySignals()
 *
 * WHY EXACT POINTERS AND NEVER A FUZZY MATCH. The rejected fix for (2) was a key-STEM fallback
 * before minting. It is rejected here too, and deliberately: a stem match silently MERGES two
 * different signals whose keys share a prefix, and a silent merge on this board is worse than a
 * duplicate, because a duplicate is visible and a merge is not. Everything in this module matches
 * on an exact stored pointer (detail.work_item, written by the drainer itself) or on an EXACT,
 * whole-string key equality. There is no prefix, stem, substring or word-overlap matching anywhere
 * in this file, and test/signal-closure.test.mjs asserts that negatively.
 *
 * WHY A CLOSED ITEM IS NEVER A TARGET. Superseding a live signal onto a finished item is the silent
 * mute routeToWorkBoard already refuses ("recurred after sign-off - left open"). Adoption must not
 * re-open that hole through a side door, so a done/abandoned item is never adopted.
 */

/** Cockpit sql/055/062: once a row is here Roger has signed it off or dropped it. */
export const CLOSED_WORK_STATUSES = new Set(['done', 'abandoned'])

/** The states every board surface reads as "on the board right now". */
export const ACTIVE_SIGNAL_STATES = new Set(['open', 'acknowledged'])

/** The moment a work item stopped being live. `closed_at` is stamped by the close path; state_since
 *  is the fallback for rows closed before that column was populated. Null when neither is readable,
 *  and a null here means we refuse to resolve anything -- see closurePlan. */
export function closedAt(item) {
  const v = item?.closed_at || item?.state_since || null
  if (!v) return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? v : null
}

export function isClosedItem(item) {
  return Boolean(item && CLOSED_WORK_STATUSES.has(item.status))
}

/**
 * Every signal row that is about the SAME underlying entity as the work item `slug`.
 *
 * Two membership rules, both exact:
 *   DIRECT  - detail.work_item === slug. The drainer wrote that pointer itself when it superseded
 *             or joined the row, so it is a fact, not an inference.
 *   SIBLING - the row's `key` is character-for-character equal to a direct member's key, under any
 *             source. This is the (source,key) split from defect 3: one fault, two channels, two
 *             rows, and only one of them ever got the pointer.
 *
 * The sibling rule is why the brief says "resolve EVERY row for the same underlying entity, not
 * just one". It is bounded by exact key equality, so it can never reach a row that is not already
 * carrying the identical key of a row we hold a written pointer for.
 */
export function sameEntitySignals(slug, signals) {
  const rows = Array.isArray(signals) ? signals.filter(Boolean) : []
  if (!slug) return []
  const direct = rows.filter((r) => r?.detail?.work_item === slug)
  const keys = new Set(direct.map((r) => r.key).filter((k) => typeof k === 'string' && k.length))
  const out = []
  const seen = new Set()
  for (const r of rows) {
    const isDirect = r?.detail?.work_item === slug
    const isSibling = typeof r?.key === 'string' && keys.has(r.key)
    if (!isDirect && !isSibling) continue
    const id = r.id ?? `${r.source}|${r.key}`
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ row: r, via: isDirect ? 'pointer' : 'same-key' })
  }
  return out
}

/**
 * What to do with an entity's signal rows now that its work item has finished.
 *
 * THE LOAD-BEARING GUARD IS `keepOpen`. "The item is done, so resolve its signal" is wrong on its
 * own, and the live board proves it: at the time this was written,
 * silent-failure/inbox-triage:labelled-threads-leave-inbox pointed at work item
 * monitor-inbox-triage-labelled-threads-leave-in-75530be1, closed done at 2026-09-02T13:14:10Z --
 * and its producer had seen it AGAIN at 17:24:46Z, four hours after the close. The problem came
 * back. A blanket resolve would have muted a live fault while its only work item was signed off,
 * leaving nothing anywhere -- the exact silent mute this codebase keeps refusing.
 *
 * So a row is resolved ONLY when its producer has not seen it since the work finished. If it was
 * seen after the close, it is a genuine recurrence and stays exactly where it is, loud.
 *
 * A row with no readable last_seen_at, or an item with no readable close time, is left alone too:
 * we cannot order the two events, and the safe direction is always "leave the alarm standing".
 */
export function closurePlan({ item, signals, now = new Date().toISOString() }) {
  const resolve = []
  const keepOpen = []
  const slug = item?.slug || null

  if (!slug) return { slug: null, resolve, keepOpen, skipped: 'no work item slug' }
  if (!isClosedItem(item)) return { slug, resolve, keepOpen, skipped: `work item is ${item?.status || 'unknown'}, not finished` }

  const closed = closedAt(item)
  if (!closed) return { slug, resolve, keepOpen, skipped: 'work item carries no readable close time' }
  const closedMs = Date.parse(closed)

  for (const { row, via } of sameEntitySignals(slug, signals)) {
    if (!ACTIVE_SIGNAL_STATES.has(row.state)) continue        // already resolved/superseded: nothing to do
    const seenMs = Date.parse(row.last_seen_at || '')
    if (!Number.isFinite(seenMs)) {
      keepOpen.push({ row, via, why: 'the signal carries no readable last_seen_at, so it cannot be ordered against the close' })
      continue
    }
    if (seenMs > closedMs) {
      keepOpen.push({ row, via, why: `seen again at ${row.last_seen_at}, AFTER the work finished at ${closed} — this is a recurrence, not stale bookkeeping` })
      continue
    }
    resolve.push({ row, via, why: `work item ${slug} finished (${item.status}) at ${closed}, and the signal has not been seen since ${row.last_seen_at}` })
  }
  return { slug, status: item.status, closed, now, resolve, keepOpen }
}

/**
 * The PATCH body that closes one signal row against its finished work item.
 *
 * `resolved`, not `superseded`: superseded means "this lives somewhere else now", and the whole
 * point here is that it no longer lives anywhere -- the work is finished and the check has not
 * fired since. The page IS cancelled, with the reason written down: an undelivered page about work
 * Roger has already signed off is precisely the phone call this defect exists to stop.
 */
export function resolvedPatch({ row, item, why, now = new Date().toISOString() }) {
  return {
    state: 'resolved',
    resolved_at: now,
    page_due_at: null,
    page_suppressed_reason: `work item ${item.slug} finished (${item.status}) and the signal was not seen again`,
    detail: {
      ...(row.detail || {}),
      work_item: item.slug,
      closed_by_work_item: item.slug,
      closed_by_work_item_status: item.status,
      closed_by_work_item_at: closedAt(item),
      resolved_by: 'board-drainer/signal-closure',
      resolved_because: why,
      resolved_by_at: now,
    },
  }
}

/**
 * The work item this signal ALREADY belongs to, found before minting a new one -- or null to let
 * the caller carry on exactly as it does today.
 *
 * @param inc                     the incident shape (signalToIncident)
 * @param deps.pointerItem        the work_items row named by this signal's own detail.work_item
 * @param deps.siblingItems       [{ signal, item }] for signals whose key is EXACTLY this key,
 *                                under a different source, that carry a work_item pointer
 *
 * ORDER: the signal's own stored pointer beats everything, because the drainer wrote it about this
 * exact row. A sibling pointer is used only when there is exactly ONE live item among the siblings.
 *
 * REFUSALS, each of which is a test:
 *   - a signal in the JOINED state (detail.joined_at set) is never adopted. Roger's 2026-08-28
 *     decision keeps a joined signal VISIBLE on /signals until a person ticks it off; adopting it
 *     here would route it into supersedeSignal and mute it, which is the behaviour that decision
 *     reversed. The join branch in routeToWorkBoard owns that case.
 *   - a done/abandoned item is never adopted (that is the recurrence-after-sign-off mute).
 *   - two different live sibling items = ambiguous = mint, never guess.
 *   - a pointer to an item that does not exist is ignored, not followed.
 */
export function adoptionTarget(inc, { pointerItem = null, siblingItems = [] } = {}) {
  if (inc?.joined_at) return null                              // visible-not-muted: the join path owns it

  if (pointerItem && pointerItem.slug && !isClosedItem(pointerItem)) {
    return {
      slug: pointerItem.slug,
      item: pointerItem,
      via: 'stored-pointer',
      evidence: `this signal already carries detail.work_item=${pointerItem.slug} (status ${pointerItem.status}); its key was renamed, the task was not`,
    }
  }

  const key = typeof inc?.key === 'string' ? inc.key : null
  if (!key) return null
  const live = []
  const seen = new Set()
  for (const s of (siblingItems || [])) {
    const item = s?.item
    const sig = s?.signal
    if (!item?.slug || isClosedItem(item)) continue
    if (sig?.key !== key) continue                             // EXACT key equality. No stems, ever.
    if (sig?.source === inc.source) continue                   // that is the same row, not a sibling
    if (seen.has(item.slug)) continue
    seen.add(item.slug)
    live.push({ item, sig })
  }
  if (live.length !== 1) return null                           // 0 = nothing to adopt, >1 = ambiguous, mint
  const { item, sig } = live[0]
  return {
    slug: item.slug,
    item,
    via: 'sibling-key',
    evidence: `the identical key is already on the board under source "${sig.source}" and is filed as work item ${item.slug} (status ${item.status}); one fault reported twice is still one task`,
  }
}
