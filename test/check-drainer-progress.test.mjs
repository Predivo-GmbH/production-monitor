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
import { judgeDrainer } from '../scripts/check-drainer-progress.mjs'

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

console.log(`\n${n} tests passed.`)
