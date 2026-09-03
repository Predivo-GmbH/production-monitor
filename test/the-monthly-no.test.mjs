/**
 * The monthly "no" — the only way this board shrinks by decision instead of by work.
 *
 * The tests that matter are the REFUSALS. Everything this selects becomes a question in Roger's
 * lane, so a row selected wrongly costs him attention on work somebody is already doing, or asks
 * him to drop something nobody has even assessed.
 *
 * Pure: no credentials, no network. Run: node test/the-monthly-no.test.mjs
 */
import assert from 'node:assert'
import { selectForTheNoBundle, composeTheQuestion, alreadyOnHisPlate, UNTOUCHED_DAYS }
  from '../scripts/the-monthly-no.mjs'

let n = 0
const t = (name, fn) => { fn(); n++; console.log(`  ok - ${name}`) }
const NOW = Date.parse('2026-09-03T18:00:00Z')
const daysAgo = (d) => new Date(NOW - d * 86_400_000).toISOString()
const row = (o = {}) => ({ slug: 's', title: 'A small tidy-up nobody needs', status: 'next', priority: 'low', last_evidence_at: daysAgo(45), ...o })
const pick = (rows) => selectForTheNoBundle({ rows, now: NOW })

t('a low row untouched for longer than the window is bundled', () => {
  assert.equal(pick([row()]).length, 1)
})

t('a low row touched inside the window is left alone', () => {
  assert.equal(pick([row({ last_evidence_at: daysAgo(3) })]).length, 0)
})

// ── the refusals, which are the whole point ──────────────────────────────────────────────────
t('REFUSED: `unjudged` is never bundled — nobody has LOOKED at it yet', () => {
  assert.equal(pick([row({ priority: 'unjudged' })]).length, 0,
    'asking him to drop work nobody assessed is the opposite of the point')
})

t('REFUSED: normal, high and critical are never bundled at any age', () => {
  for (const p of ['normal', 'high', 'critical']) {
    assert.equal(pick([row({ priority: p })]).length, 0, `${p} must never be bundled`)
  }
})

t('REFUSED: a row somebody is working on is not abandoned work', () => {
  assert.equal(pick([row({ status: 'in_progress' })]).length, 0)
  assert.equal(pick([row({ owner_session: 'abc-123' })]).length, 0)
})

t('REFUSED: a row already in his lane — a second question about it is noise', () => {
  assert.equal(pick([row({ blocked_owner: 'roger' })]).length, 0)
  assert.equal(pick([row({ status: 'awaiting_signoff' })]).length, 0)
  assert.equal(alreadyOnHisPlate({ blocked_owner: 'ROGER' }), true, 'case must not matter')
  assert.equal(alreadyOnHisPlate({ blocked_owner: 'vendor' }), false)
})

t('REFUSED: an already-merged row has left the count', () => {
  assert.equal(pick([row({ merged_into: 'some-uuid' })]).length, 0)
})

t('REFUSED: a closed or abandoned row is never re-asked about', () => {
  assert.equal(pick([row({ status: 'done' }), row({ status: 'abandoned' })]).length, 0)
})

t('REFUSED: a row whose age cannot be read is left alone, never swept in', () => {
  assert.equal(pick([row({ last_evidence_at: null, state_since: null, opened_at: null })]).length, 0)
  assert.equal(pick([row({ last_evidence_at: 'not a date', state_since: null, opened_at: null })]).length, 0)
})

t('falls back through last_evidence -> state_since -> opened_at', () => {
  assert.equal(pick([row({ last_evidence_at: null, state_since: daysAgo(50) })]).length, 1)
  assert.equal(pick([row({ last_evidence_at: null, state_since: null, opened_at: daysAgo(50) })]).length, 1)
})

// ── the question itself ──────────────────────────────────────────────────────────────────────
t('the question is ONE act covering every row, and names them in his words', () => {
  const q = composeTheQuestion([
    { title: 'Tidy the old screenshots out of the repo' },
    { title: 'Rename the two badly named test files' },
  ])
  assert.match(q.title, /^2 small jobs nobody has touched in \d+ days/)
  assert.match(q.question, /Tidy the old screenshots/)
  assert.match(q.question, /Rename the two badly named/)
  assert.match(q.question, /DROP THEM/)
  assert.match(q.question, /KEEP/)
  assert.doesNotMatch(q.question, /slug|work_items|\.mjs|priority=/, 'no jargon in a question for him')
})

t('keeping is a real answer with the same cost as dropping', () => {
  assert.match(composeTheQuestion([{ title: 'x' }]).question, /the clock starts again/)
})

t('the window is a deliberate value', () => {
  assert.equal(UNTOUCHED_DAYS, 30, 'a month of nothing happening on a hygiene item')
})

t('empty and malformed input never throws', () => {
  assert.deepEqual(selectForTheNoBundle(), [])
  assert.deepEqual(pick([]), [])
  assert.deepEqual(pick([null, undefined]), [])
})

console.log(`\n${n} passed`)
