/**
 * A HAND-OFF TO THE WORK BOARD MUST NOT SILENCE AN UNDELIVERED PAGE.
 *
 * Measured on production 2026-09-01: of the 24 signals that ever asked to ring Roger's phone,
 * 21 never rang, and 18 of those were cancelled by board-drainer's routeToWorkBoard() one hop
 * before delivery — `page_suppressed_reason = 'routed-to-work-board'`, `paged_at IS NULL`.
 *
 * EVERY ASSERTION BELOW WAS WATCHED TO FAIL against the old implementation, which was the
 * literal `page_due_at: null` in the PATCH body. Group 1 is the fix. Group 2 is the set of
 * things that must NOT change, because widening an alarm is how an alarm gets trained away.
 *
 * Run: node test/page-survives-handoff.test.mjs   (exit 0 = all pass)
 */
import assert from 'node:assert'
import { pageFieldsOnSupersede } from '../scripts/board-drainer.mjs'

let n = 0
const t = (name, fn) => { fn(); n++; console.log(`  ok - ${name}`) }

const iso = (msFromNow) => new Date(Date.now() + msFromNow).toISOString()

// ── 1. the leak, closed ────────────────────────────────────────────────────────────────────
// The exact live shape of all 18 lost pages: armed, inside its 15-minute self-heal window, and
// the hourly drainer arrives before the 5-minute sweep does.
t('a page still inside its self-heal window SURVIVES the hand-off', () => {
  const out = pageFieldsOnSupersede({ page_due_at: iso(+9 * 60000), paged_at: null })
  assert.equal(out.kept, true, 'an undelivered page must not be cancelled by a hand-off')
  assert.notEqual(out.page_due_at, null, 'page_due_at must survive')
})

t('the schedule is preserved EXACTLY, never pushed forward', () => {
  // The drainer runs hourly. Re-stamping page_due_at to "now + delay" on every run would make a
  // page that is permanently about to be sent and never is — the silent-forever failure wearing
  // a healthy-looking column.
  const due = iso(+9 * 60000)
  assert.equal(pageFieldsOnSupersede({ page_due_at: due, paged_at: null }).page_due_at, due)
})

t('a page that came due but has not been swept yet also survives', () => {
  // The sweep runs every 5 minutes, the drainer hourly: due-but-unswept is a real window.
  const out = pageFieldsOnSupersede({ page_due_at: iso(-2 * 60000), paged_at: null })
  assert.equal(out.kept, true)
})

t('a RE-ARMED page — delivered once, then scheduled again — survives', () => {
  // Migration 128's rule: due means page_due_at is NEWER than the last delivery. A signal that
  // paged on day one and got worse on day three must still be able to ring.
  const out = pageFieldsOnSupersede({ page_due_at: iso(+5 * 60000), paged_at: iso(-3 * 3600_000) })
  assert.equal(out.kept, true, 'paged_at older than page_due_at means outstanding, not delivered')
})

t('the marker is the one due_pages() admits, and only this path writes it', () => {
  // Migration 157 lets a superseded row back into the sweep ONLY on this exact string. If this
  // assertion and that migration ever disagree, the page is armed and undeliverable — which
  // reads as green. They are pinned to each other here on purpose.
  const out = pageFieldsOnSupersede({ page_due_at: iso(+9 * 60000), paged_at: null })
  assert.equal(out.page_suppressed_reason, 'routed-to-work-board-page-still-due')
})

// ── 2. nothing else changes ────────────────────────────────────────────────────────────────
t('an ALREADY-DELIVERED page is still cancelled, as before', () => {
  const out = pageFieldsOnSupersede({ page_due_at: iso(-30 * 60000), paged_at: iso(-20 * 60000) })
  assert.equal(out.kept, false)
  assert.equal(out.page_due_at, null)
  assert.equal(out.page_suppressed_reason, 'routed-to-work-board')
})

t('a signal that was NEVER armed stays unreachable — this widens nothing', () => {
  // The 47 open warnings are all needs_human=false and were never eligible. This fix restores
  // pages that were scheduled and stolen; it does not invent pages for findings that never
  // qualified. If this ever fails, the fix has turned into a flood.
  const out = pageFieldsOnSupersede({ page_due_at: null, paged_at: null })
  assert.equal(out.kept, false)
  assert.equal(out.page_due_at, null)
  assert.equal(out.page_suppressed_reason, 'routed-to-work-board')
})

t('a row with no paging columns at all is safe, not armed', () => {
  for (const row of [{}, null, undefined, { detail: {} }]) {
    const out = pageFieldsOnSupersede(row)
    assert.equal(out.kept, false, 'an absent schedule must never be read as an outstanding page')
    assert.equal(out.page_due_at, null)
  }
})

t('paged_at EQUAL to page_due_at counts as delivered, not outstanding', () => {
  // Boundary shared with due_pages(): the test there is `paged_at < page_due_at`, strictly. An
  // off-by-one in the other direction would re-page every delivered signal once more.
  const due = iso(-60000)
  const out = pageFieldsOnSupersede({ page_due_at: due, paged_at: due })
  assert.equal(out.kept, false)
})

console.log(`\n${n} assertions passed`)
