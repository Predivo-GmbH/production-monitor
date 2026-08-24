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

t('parked items alone do not raise the alarm — parking is a deliberate suppression', () => {
  const j = judgeDrainer({
    heartbeat: { last_seen_at: ago(10), detail: { dispatchable: 0, parked: 3, dispatched: 0, last_dispatch_at: ago(60 * 40) } },
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

console.log(`\n${n} tests passed.`)
