/**
 * Unit tests for the drainer stall alarm's decision logic.
 *
 * The alarm exists because on 2026-08-24 the drainer ran on schedule for 30 hours and fixed
 * nothing, and every check we had said "it ran, so it is fine". Each case below is one way that
 * sentence can be wrong.
 *
 * Run: node test/check-drainer-progress.test.mjs   (exit 0 = all pass)
 */
import assert from 'node:assert'
import { judgeDrainer, summariseBoard } from '../scripts/check-drainer-progress.mjs'
import { NOT_A_FINDING_SOURCES } from '../scripts/board-drainer.mjs'

let n = 0
const t = (name, fn) => { fn(); n++; console.log(`  ok - ${name}`) }

const NOW = Date.parse('2026-08-24T20:00:00.000Z')
const ago = (mins) => new Date(NOW - mins * 60_000).toISOString()

// ── STOPPED: no run at all ─────────────────────────────────────────────────────
t('no heartbeat ever -> stopped (absence is the failure, never a pass)', () => {
  const j = judgeDrainer({ heartbeat: null, now: NOW })
  assert.equal(j.verdict, 'stopped')
  assert.equal(j.severity, 'critical')
})

t('heartbeat older than the staleness threshold -> stopped', () => {
  const j = judgeDrainer({ heartbeat: { last_seen_at: ago(400), detail: {} }, now: NOW, staleMin: 180 })
  assert.equal(j.verdict, 'stopped')
  assert.match(j.summary, /stopped|ago/)
})

t('an unreadable timestamp is stopped, not ok — unknown is never healthy', () => {
  const j = judgeDrainer({ heartbeat: { last_seen_at: 'not-a-date', detail: {} }, now: NOW })
  assert.equal(j.verdict, 'stopped')
})

// ── STALLED: the 2026-08-24 failure, stated as an invariant ────────────────────
t('runs recently, work IS dispatchable, nothing dispatched for 30h -> stalled', () => {
  const j = judgeDrainer({
    heartbeat: { last_seen_at: ago(20), detail: { dispatchable: 34, dispatched: 0, last_dispatch_at: ago(30 * 60) } },
    now: NOW, stallHours: 6,
  })
  assert.equal(j.verdict, 'stalled')
  assert.equal(j.severity, 'critical')
  assert.match(j.summary, /34 incident/)
})

t('dispatchable work but the drainer has NEVER dispatched -> stalled', () => {
  const j = judgeDrainer({
    heartbeat: { last_seen_at: ago(5), detail: { dispatchable: 2, dispatched: 0, last_dispatch_at: null } },
    now: NOW,
  })
  assert.equal(j.verdict, 'stalled')
})

// ── OK: the cases that must NOT cry wolf ───────────────────────────────────────
t('a clean board (nothing dispatchable) is ok, however long since the last dispatch', () => {
  const j = judgeDrainer({
    heartbeat: { last_seen_at: ago(10), detail: { dispatchable: 0, dispatched: 0, last_dispatch_at: ago(60 * 24 * 7) } },
    now: NOW,
  })
  assert.equal(j.verdict, 'ok')
})

t('a FEW parked items do not raise the alarm — parking is a deliberate suppression', () => {
  // `considered` is spelled out on purpose. This case used to omit it, so it passed because the
  // share worked out to 0/0 rather than because 3 of 40 is a normal amount of parking.
  const j = judgeDrainer({
    heartbeat: { last_seen_at: ago(10), detail: { considered: 40, dispatchable: 0, parked: 3, dispatched: 0, last_dispatch_at: ago(60 * 40) } },
    now: NOW,
  })
  assert.equal(j.verdict, 'ok')
})

t('dispatched within the window -> ok', () => {
  const j = judgeDrainer({
    heartbeat: { last_seen_at: ago(3), detail: { dispatchable: 4, dispatched: 3, last_dispatch_at: ago(3) } },
    now: NOW, stallHours: 6,
  })
  assert.equal(j.verdict, 'ok')
})

t('just inside the stall threshold is still ok; just outside is stalled (boundary)', () => {
  const inside = judgeDrainer({
    heartbeat: { last_seen_at: ago(5), detail: { dispatchable: 1, last_dispatch_at: ago(6 * 60 - 1) } },
    now: NOW, stallHours: 6,
  })
  const outside = judgeDrainer({
    heartbeat: { last_seen_at: ago(5), detail: { dispatchable: 1, last_dispatch_at: ago(6 * 60 + 1) } },
    now: NOW, stallHours: 6,
  })
  assert.equal(inside.verdict, 'ok')
  assert.equal(outside.verdict, 'stalled')
})

// ── STOPPED: a run that crashed reports what it managed to do, and that is not a clean board ──
t('a run whose heartbeat carries an error -> stopped, not ok (a crashed read is never green)', () => {
  const j = judgeDrainer({
    heartbeat: { last_seen_at: ago(5), detail: { error: 'board read HTTP 500: PostgREST', dispatchable: 0, dispatched: 0 } },
    now: NOW,
  })
  assert.equal(j.verdict, 'stopped')
  assert.equal(j.severity, 'critical')
  assert.match(j.summary, /PostgREST/)
})

// ── DISABLED: the kill switch / wired-but-off gate, left on, must not read as a clean board ──
t('a switched-off run (runStats.skipped set) -> disabled, not ok — a switch left on is not clean', () => {
  const j = judgeDrainer({
    heartbeat: { last_seen_at: ago(5), detail: { skipped: 'kill switch (BOARD_DRAINER_DISABLED=1)', dispatchable: 0, dispatched: 0 } },
    now: NOW,
  })
  assert.equal(j.verdict, 'disabled')
  assert.notEqual(j.verdict, 'ok')
  assert.match(j.summary, /switched off/)
})

// ── GIVEN UP: the drainer abandoned the board and the alarm called that "working" ──────────
// Added 2026-09-01. Every case in this group was watched to FAIL against the previous version,
// which excluded parked items from its count by design and said so in its own header.

t('THE LIVE FAILURE: 36 of 38 parked reads as "working" no longer', () => {
  // Verbatim detail of the production board-drainer heartbeat, 2026-09-01 18:08:58Z. Fed to the
  // old judgeDrainer this returned: ok / "The fleet auto-fixer is working".
  const j = judgeDrainer({
    heartbeat: {
      last_seen_at: '2026-09-01T18:08:58.477793+00:00',
      detail: {
        dry: false, error: null, parked: 36, handoff: 1, skipped: null, escalated: 1,
        considered: 38, dispatched: 1, dispatchable: 1, parked_retry: null,
        last_dispatch_at: '2026-09-01T17:56:57.625Z',
      },
    },
    now: Date.parse('2026-09-01T18:20:00.000Z'),
  })
  assert.equal(j.verdict, 'given-up')
  assert.equal(j.severity, 'critical')
  assert.notEqual(j.verdict, 'ok')
  assert.match(j.summary, /36 of 38/)
})

t('the FLOOR stops a tiny board reading as a crisis', () => {
  // 2 of 3 parked is 67% and means nothing at all. A share alone would fire here every time the
  // board went quiet, and an alarm that cries wolf on a quiet board gets switched off.
  const j = judgeDrainer({
    heartbeat: { last_seen_at: ago(10), detail: { considered: 3, parked: 2, dispatchable: 0, last_dispatch_at: ago(30) } },
    now: NOW,
  })
  assert.equal(j.verdict, 'ok')
})

t('the SHARE is what fires, so a big board cannot hide a big abandonment', () => {
  const j = judgeDrainer({
    heartbeat: { last_seen_at: ago(10), detail: { considered: 100, parked: 60, dispatchable: 2, last_dispatch_at: ago(30) } },
    now: NOW,
  })
  assert.equal(j.verdict, 'given-up')
})

t('boundary: exactly at the floor AND the share fires; one under the floor does not', () => {
  const at = judgeDrainer({
    heartbeat: { last_seen_at: ago(10), detail: { considered: 10, parked: 5, dispatchable: 0, last_dispatch_at: ago(30) } },
    now: NOW,
  })
  assert.equal(at.verdict, 'given-up', '5 of 10 is exactly floor and exactly share')
  const under = judgeDrainer({
    heartbeat: { last_seen_at: ago(10), detail: { considered: 8, parked: 4, dispatchable: 0, last_dispatch_at: ago(30) } },
    now: NOW,
  })
  assert.equal(under.verdict, 'ok', '4 parked is under the floor of 5, however high the share')
})

t('a MISSING parked count on a non-empty board is unknown, never ok', () => {
  // "The drainer stopped reporting how much it abandoned" is not evidence that it abandoned
  // nothing. Reading an absent number as zero is the could-not-tell-reported-as-fine shape.
  const j = judgeDrainer({
    heartbeat: { last_seen_at: ago(10), detail: { considered: 30, dispatchable: 0, last_dispatch_at: ago(30) } },
    now: NOW,
  })
  assert.equal(j.verdict, 'unknown')
  assert.notEqual(j.verdict, 'ok')
})

t('a genuinely empty board is still ok, with or without a parked count', () => {
  // The one case that must NOT become noisy: nothing on the board is the healthy end state.
  for (const detail of [{ considered: 0, parked: 0, dispatchable: 0 }, { considered: 0, dispatchable: 0 }]) {
    const j = judgeDrainer({ heartbeat: { last_seen_at: ago(10), detail }, now: NOW })
    assert.equal(j.verdict, 'ok')
  }
})

t('a STALLED drainer that is also parked-out reports the stall — the more actionable fact', () => {
  const j = judgeDrainer({
    heartbeat: { last_seen_at: ago(10), detail: { considered: 38, parked: 36, dispatchable: 2, last_dispatch_at: ago(60 * 30) } },
    now: NOW,
  })
  assert.equal(j.verdict, 'stalled')
})

const iso = (minsAgo) => new Date(NOW + minsAgo * 60000).toISOString()
const hb = (detail) => ({ last_seen_at: iso(-1), detail })

// ── AN ABSENT COUNT IS NOT ZERO, AND A SELF-RESET CLOCK IS NOT PROGRESS (2026-09-01 audit) ──
// `Number(detail.dispatchable || 0)` turned a renamed field or a run that died before counting
// into "no work waiting", which is the one value that makes the stall test unreachable. And
// `last_dispatch_at` comes from the drainer's own local state file, which board-drainer.mjs
// re-seeds to now whenever that file is missing or unreadable - so a stalled drainer restarted its
// own stall clock on every run, for ever.

t('a heartbeat with no dispatchable count is unknown, never ok', () => {
  const j = judgeDrainer({ heartbeat: hb({ dispatched: 0, started_at: iso(-2) }), now: NOW })
  assert.equal(j.verdict, 'unknown')
  assert.notEqual(j.verdict, 'ok')
})

t('a last-pickup time stamped inside this very run, with work waiting and none picked up, is unknown', () => {
  const j = judgeDrainer({ heartbeat: hb({ dispatchable: 5, dispatched: 0, started_at: iso(-2), last_dispatch_at: iso(-1) }), now: NOW })
  assert.equal(j.verdict, 'unknown')
})

t('a real run that picked work up is still ok, and a real stall is still stalled', () => {
  const ok = judgeDrainer({ heartbeat: hb({ dispatchable: 2, dispatched: 2, started_at: iso(-4), last_dispatch_at: iso(-2) }), now: NOW })
  const stalled = judgeDrainer({ heartbeat: hb({ dispatchable: 5, dispatched: 0, started_at: iso(-2), last_dispatch_at: iso(-60 * 72) }), now: NOW })
  assert.equal(ok.verdict, 'ok')
  assert.equal(stalled.verdict, 'stalled')
})

// ── ASSERTION 5 + 6: THE DENOMINATOR IS THE BOARD, AND THE PAGE MUST BE ABLE TO NAME THE
//    ABANDONED (2026-09-02) ────────────────────────────────────────────────────────────────
// Assertion 4 taught the alarm to count parked items. It kept taking its denominator from
// `considered` — the drainer's count AFTER dropping every signal whose source it cannot write to.
// Every case below was watched to FAIL against that version.

const row = (source, key, detail = {}) => ({ source, key, severity: 'warning', state: 'open', detail })

t('summariseBoard: findings exclude the work board, the drainer own rows, drills and receipts', () => {
  const b = summariseBoard([
    row('commit-review', 'a'), row('production-monitor', 'b'),
    row('monitoring-hygiene', 'c'), row('external-tools-scan', 'd'),
    row('monitoring-hygiene', 'e', { work_item: 'some-slug' }),
    row('work-board', 'f'),                                           // IS the work board
    row('board-drainer', 'run'),                                      // this machinery's own rows
    row('report', 'nightly'),                                         // a delivery, not a fault
    row('__drill__', 'fire'),                                         // a drill
  ])
  assert.equal(b.active, 9)
  assert.equal(b.findings, 5, 'the work board, the drainer, drills and receipts are not findings')
  assert.equal(b.inReach, 5, 'THE FIX: every real finding is in reach now, whatever its source')
  assert.deepEqual(b.outOfReach, [], 'nothing real is dropped before the fixer ever looks at it')
})

t('REGRESSION GUARD: re-introducing a source allow list makes out-of-reach non-empty again', () => {
  // The defect, reproduced as a mutation. summariseBoard() takes the drainer filter as an
  // injectable so this test can hand it the OLD guard -- the six values monitoring_incidents.source
  // accepted -- and watch the alarm go loud again. This is the whole reason assertion 5 exists.
  const oldAllowList = new Set(['healthchecks', 'sentry', 'production-monitor', 'cron', 'silent-failure', 'commit-review'])
  const b = summariseBoard([
    row('commit-review', 'a'), row('production-monitor', 'b'),
    row('monitoring-hygiene', 'c'), row('external-tools-scan', 'd'),
    row('monitoring-hygiene', 'e', { work_item: 'some-slug' }),
    row('work-board', 'f'),
  ], { isWorkable: (r) => oldAllowList.has(r?.source) })
  assert.equal(b.findings, 5)
  assert.equal(b.inReach, 2, 'the old guard reached only two of the five')
  assert.deepEqual(b.outOfReach, ['monitoring-hygiene/c', 'external-tools-scan/d'],
    'and the alarm names exactly the findings nobody would ever have looked at')
})

t('THE LIST-GROWS DIRECTION: adding a real fault source to the DRAINER deny list makes out-of-reach non-empty', () => {
  // The defect this incident opened on: when the alarm's denominator WAS the drainer's own
  // NOT_A_FINDING_SOURCES (`const NOT_A_FINDING = NOT_A_FINDING_SOURCES`), quieting a noisy
  // producer by adding its source to the deny list dropped it from BOTH populations at once, so
  // outOfReach stayed structurally [] and the alarm could not fire on the very findings the fixer
  // had just stopped working. This test drives the REAL default `workableFinding` — not an
  // injected substitute like the guard above — against a deny list that has grown by one real
  // source, and asserts the gap opens. It fails against `const NOT_A_FINDING = NOT_A_FINDING_SOURCES`.
  const GROWN = 'monitoring-hygiene'
  const had = NOT_A_FINDING_SOURCES.has(GROWN)
  NOT_A_FINDING_SOURCES.add(GROWN) // simulate the one-line "quiet the producer" edit on the drainer
  try {
    const b = summariseBoard([
      row('commit-review', 'a'),
      row('monitoring-hygiene', 'c'),                              // now refused by the drainer...
      row('monitoring-hygiene', 'e', { work_item: 'some-slug' }),  // ...but this one has an owner
    ]) // DEFAULT isWorkable = the real workableFinding, which reads the grown NOT_A_FINDING_SOURCES
    assert.equal(b.findings, 3, "the alarm's own list is unchanged, so the rows are still findings")
    assert.equal(b.inReach, 1, 'only commit-review is still in the drainer\'s reach')
    assert.deepEqual(b.outOfReach, ['monitoring-hygiene/c'],
      'the newly-denied, unowned finding surfaces as never-tried — the alarm can fire again')
  } finally {
    if (!had) NOT_A_FINDING_SOURCES.delete(GROWN) // leave the shared set exactly as found
  }
})

t('summariseBoard: parkedPublished counts exactly the rows carrying detail.parked=true', () => {
  const b = summariseBoard([
    row('commit-review', 'a', { parked: true }),
    row('commit-review', 'b', { parked: false }),
    row('commit-review', 'c'),
  ])
  assert.deepEqual(b.parkedPublished, ['commit-review/a'])
})

t('THE 2026-09-02 LIVE BOARD: 9 parked of 11 "considered" while 31 were never in the sum', () => {
  // Verbatim heartbeat of 2026-09-02T19:36:57Z, and the board measured at 20:04Z the same evening.
  // The old judge said given-up "9 of 11 (82%)". True and far too small: the real statement is
  // 9 parked + 12 never tried out of 30 findings.
  const heartbeat = {
    last_seen_at: '2026-09-02T19:36:57.058996+00:00',
    detail: {
      dry: false, error: null, parked: 9, handoff: 1, skipped: null, escalated: 1,
      considered: 11, dispatched: 0, dispatchable: 0, parked_retry: null,
      last_dispatch_at: '2026-09-02T19:02:03.054Z',
    },
  }
  const board = {
    active: 42, findings: 24, inReach: 11,
    outOfReach: Array.from({ length: 13 }, (_, i) => `monitoring-hygiene/x${i}`),
    parkedPublished: ['commit-review/one', 'commit-review/two'],
  }
  const j = judgeDrainer({ heartbeat, board, now: Date.parse('2026-09-02T20:04:00.000Z') })
  assert.equal(j.verdict, 'given-up')
  assert.equal(j.severity, 'critical')
  assert.match(j.summary, /22 of the 24/, 'the numerator is parked PLUS never-tried, over the board')
  assert.match(j.summary, /9 PARKED/)
  assert.match(j.summary, /13 NEVER TRIED/)
  assert.match(j.summary, /cannot even be NAMED/, 'the 9-vs-2 publication gap rides along')
})

t('THE QUIET HALF ON ITS OWN: nothing parked, but the fixer cannot reach most of the board', () => {
  // parked = 0, so every assertion up to and including the old assertion 4 reads this as healthy.
  const j = judgeDrainer({
    heartbeat: { last_seen_at: ago(10), detail: { considered: 4, parked: 0, dispatchable: 0, dispatched: 0, last_dispatch_at: ago(30) } },
    board: { active: 30, findings: 30, inReach: 4, outOfReach: Array.from({ length: 26 }, (_, i) => `monitoring-hygiene/y${i}`), parkedPublished: [] },
    now: NOW,
  })
  assert.equal(j.verdict, 'given-up')
  assert.match(j.summary, /26 NEVER TRIED/)
  assert.match(j.summary, /never tried: monitoring-hygiene\/y0/i, 'the alarm NAMES them, so nobody has to derive the list')
})

t('a board the fixer can fully reach, with a little parking, is still ok — and says its coverage', () => {
  const j = judgeDrainer({
    heartbeat: { last_seen_at: ago(10), detail: { considered: 40, parked: 3, dispatchable: 0, dispatched: 0, last_dispatch_at: ago(30) } },
    board: { active: 40, findings: 40, inReach: 40, outOfReach: [], parkedPublished: ['a/1', 'a/2', 'a/3'] },
    now: NOW,
  })
  assert.equal(j.verdict, 'ok')
  assert.match(j.summary, /40 within the fixer's reach, 0 out of reach/)
})

t('ASSERTION 6 alone: the drainer knows it parked 6 and the board can name 1', () => {
  // Nothing else is wrong — the board is fully in reach, 6 of 40 parked is a normal amount. The
  // only fault is that five of those six abandonments exist nowhere a reader can see them.
  const j = judgeDrainer({
    heartbeat: { last_seen_at: ago(10), detail: { considered: 40, parked: 6, dispatchable: 0, dispatched: 0, last_dispatch_at: ago(30) } },
    board: { active: 40, findings: 40, inReach: 40, outOfReach: [], parkedPublished: ['a/1'] },
    now: NOW,
  })
  assert.equal(j.verdict, 'parks-unpublished')
  assert.equal(j.severity, 'critical', 'a gap at or above the floor is critical, not a note')
  assert.match(j.summary, /only 1 row\(s\)|only 1 row/)
  assert.notEqual(j.verdict, 'ok')
})

t('a publication gap under the floor is a warning, not a crisis', () => {
  const j = judgeDrainer({
    heartbeat: { last_seen_at: ago(10), detail: { considered: 40, parked: 3, dispatchable: 0, dispatched: 0, last_dispatch_at: ago(30) } },
    board: { active: 40, findings: 40, inReach: 40, outOfReach: [], parkedPublished: ['a/1'] },
    now: NOW,
  })
  assert.equal(j.verdict, 'parks-unpublished')
  assert.equal(j.severity, 'warning')
})

t('THE 3-SECOND RACE (2026-09-04): a parked row the closer momentarily resolved still counts — no phantom gap', () => {
  // 2026-09-04T08:07:12.716Z: the closer resolved healthchecks/inbox-daily-summary (the ONLY row
  // publishing detail.parked=true) at 08:02, this check read the active (open/acknowledged) board,
  // and the row's producer re-opened it at 08:07:15.686Z — 2.97s too late to be in that read.
  // gap = drainer.parked(1) - openParked(0) = 1 fired parks-unpublished with needs_human=true on a
  // pure timing artefact. detail.parked=true survives a resolve (detail MERGES in board-drainer.mjs),
  // so the flag is on the row throughout; parkedPublished is now read across ALL states, closing it.
  const resolvedButFlagged = { source: 'healthchecks', key: 'inbox-daily-summary', state: 'resolved', detail: { parked: true } }
  // Reading only the active board (the pre-fix fallback) is what manufactured the gap:
  assert.deepEqual(summariseBoard([row('commit-review', 'a')]).parkedPublished, [],
    'nothing carrying parked=true is open during the bounce')
  // Counting parked=true across ALL states DOES see the resolved-but-flagged row:
  const board = summariseBoard([row('commit-review', 'a')], { parkedRows: [resolvedButFlagged] })
  assert.deepEqual(board.parkedPublished, ['healthchecks/inbox-daily-summary'])
  const j = judgeDrainer({
    heartbeat: { last_seen_at: ago(10), detail: { considered: 5, parked: 1, dispatchable: 0, dispatched: 0, last_dispatch_at: ago(30) } },
    board, now: NOW,
  })
  assert.equal(j.verdict, 'ok', 'the resolve/re-open bounce must not manufacture a parks-unpublished gap')
  assert.notEqual(j.verdict, 'parks-unpublished')
})

t('THE STALE-FLAG MASK (2026-09-04): a parked=true stranded on a departed row cannot hide a real unpublished park', () => {
  // 43a1c78 fixed the race by reading detail.parked=true across ALL states, but left assertion 6 as
  // a bare COUNT: `gap = parked - parkedPublished.length`. A stale flag on a resolved/closed row
  // (detail MERGES on resolve, board-drainer.mjs:582) then subtracts from the gap. Here: 2 active
  // parked, only 1 (commit-review/a) published its flag — the exact failed-flag-write assertion 6
  // exists to catch — plus 1 stale flag on a departed row (healthchecks/gone). By count,
  // parkedPublished=2 and 2-2=0, so the check would stay GREEN while commit-review/b is nameable to
  // nobody. Comparing KEYS (detail.parked_keys) is immune: the stale key matches no parked key.
  const parkedRows = [
    { source: 'commit-review', key: 'a', detail: { parked: true } },                        // published, still active
    { source: 'healthchecks', key: 'gone', state: 'resolved', detail: { parked: true } },   // STALE flag on a departed row
  ]
  const board = summariseBoard([row('commit-review', 'a'), row('commit-review', 'b')], { parkedRows })
  assert.equal(board.parkedPublished.length, 2, 'the stale flag inflates the published count to equal the parked count')
  const j = judgeDrainer({
    heartbeat: { last_seen_at: ago(10), detail: {
      considered: 5, parked: 2, parked_keys: ['commit-review/a', 'commit-review/b'],
      dispatchable: 0, dispatched: 0, last_dispatch_at: ago(30),
    } },
    board, now: NOW,
  })
  assert.equal(j.verdict, 'parks-unpublished', 'a stale flag on a departed row must NOT hide the real unpublished park')
  assert.match(j.summary, /commit-review\/b/, 'the park that cannot be named is reported by key')
  assert.doesNotMatch(j.summary, /commit-review\/a/, 'the published park is not falsely reported as un-nameable')
})

t('the pre-parked_keys count fallback still fires the honest direction (no keys published yet)', () => {
  // A heartbeat that predates parked_keys (older drainer, or the first run after this deploy) falls
  // back to the count comparison. It must still catch the plain case — more parked than published —
  // even though it cannot yet defeat the stale-flag mask. This self-heals the moment the drainer
  // publishes parked_keys on its next real run.
  const j = judgeDrainer({
    heartbeat: { last_seen_at: ago(10), detail: { considered: 40, parked: 6, dispatchable: 0, dispatched: 0, last_dispatch_at: ago(30) } },
    board: { active: 40, findings: 40, inReach: 40, outOfReach: [], parkedPublished: ['a/1'] },
    now: NOW,
  })
  assert.equal(j.verdict, 'parks-unpublished')
  assert.match(j.summary, /only 1 row/)
})

t('the page agreeing with the drainer is not an alarm', () => {
  const j = judgeDrainer({
    heartbeat: { last_seen_at: ago(10), detail: { considered: 40, parked: 2, dispatchable: 0, dispatched: 0, last_dispatch_at: ago(30) } },
    board: { active: 40, findings: 40, inReach: 40, outOfReach: [], parkedPublished: ['a/1', 'a/2'] },
    now: NOW,
  })
  assert.equal(j.verdict, 'ok')
})

t('MORE rows published than the drainer parked is not an alarm — a stale flag is a different bug', () => {
  // The drainer clears published flags on prune, and a row can legitimately still carry the flag
  // between the park leaving state and the clear landing. Only the direction that HIDES an
  // abandonment fires here.
  const j = judgeDrainer({
    heartbeat: { last_seen_at: ago(10), detail: { considered: 40, parked: 1, dispatchable: 0, dispatched: 0, last_dispatch_at: ago(30) } },
    board: { active: 40, findings: 40, inReach: 40, outOfReach: [], parkedPublished: ['a/1', 'a/2', 'a/3'] },
    now: NOW,
  })
  assert.equal(j.verdict, 'ok')
})

t('an unreadable board is skipped, never guessed at, and the ok-summary admits it', () => {
  const j = judgeDrainer({
    heartbeat: { last_seen_at: ago(10), detail: { considered: 11, parked: 9, dispatchable: 0, dispatched: 0, last_dispatch_at: ago(30) } },
    board: null,
    now: NOW,
  })
  // 9 of 11 still fires on the drainer's own numbers — losing the board must never make the
  // alarm quieter than it was before assertion 5 existed.
  assert.equal(j.verdict, 'given-up')
  assert.match(j.summary, /9 of 11/)
})

t('a stopped or crashed drainer still outranks every board-derived assertion', () => {
  const board = { active: 40, findings: 40, inReach: 2, outOfReach: Array.from({ length: 38 }, (_, i) => `x/${i}`), parkedPublished: [] }
  assert.equal(judgeDrainer({ heartbeat: { last_seen_at: ago(400), detail: {} }, board, now: NOW }).verdict, 'stopped')
  assert.equal(judgeDrainer({ heartbeat: { last_seen_at: ago(5), detail: { error: 'boom', dispatchable: 0 } }, board, now: NOW }).verdict, 'stopped')
  assert.equal(judgeDrainer({ heartbeat: { last_seen_at: ago(5), detail: { skipped: 'kill switch', dispatchable: 0 } }, board, now: NOW }).verdict, 'disabled')
})

// ── ASSERTION 7: A REHEARSAL IS NOT A REPORT (2026-09-02) ──────────────────────────────────
t('THE LIVE SWAP: a dry heartbeat is unknown, not the stall its own numbers describe', () => {
  // Verbatim, 2026-09-02T20:06:17Z. A dry run on a second machine replaced the 19:36Z real
  // heartbeat; its last_dispatch_at came from that machine's 2026-08-25 state file, so the old
  // judge returned `stalled ... none picked up for 199h` about a fixer that had dispatched an
  // hour earlier.
  const j = judgeDrainer({
    heartbeat: {
      last_seen_at: '2026-09-02T20:06:17.333578+00:00',
      detail: {
        dry: true, error: null, parked: 4, handoff: 1, skipped: null, escalated: 1,
        considered: 11, dispatched: 0, dispatchable: 4, started_at: '2026-09-02T20:06:16.124Z',
        parked_retry: 'commit-review/Cockpit:b4adebd:work-evidence-steals-claim',
        last_dispatch_at: '2026-08-25T13:17:01.947Z',
      },
    },
    now: Date.parse('2026-09-02T20:10:00.000Z'),
  })
  assert.equal(j.verdict, 'unknown')
  assert.notEqual(j.verdict, 'stalled')
  assert.notEqual(j.verdict, 'ok')
  assert.match(j.summary, /rehearsal|dry=true/)
})

t('dry=false is judged exactly as before — the flag only disarms a rehearsal', () => {
  const j = judgeDrainer({
    heartbeat: { last_seen_at: ago(10), detail: { dry: false, dispatchable: 34, dispatched: 0, last_dispatch_at: ago(30 * 60) } },
    now: NOW,
  })
  assert.equal(j.verdict, 'stalled')
})

t('a crashed dry run still reports the crash — the error outranks the rehearsal flag', () => {
  const j = judgeDrainer({
    heartbeat: { last_seen_at: ago(5), detail: { dry: true, error: 'board read HTTP 500', dispatchable: 0 } },
    now: NOW,
  })
  assert.equal(j.verdict, 'stopped')
})

console.log(`\n${n} tests passed.`)
