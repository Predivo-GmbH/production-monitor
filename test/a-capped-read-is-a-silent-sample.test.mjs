#!/usr/bin/env node
/**
 * A CAPPED READ WITH NO ORDER IS A SILENT, ARBITRARY SAMPLE.
 *
 * WHY (2026-09-03 commit-review on 6d5b0c9). The board drainer asked
 * `fleet_signals?...&limit=2000` and the board measurers asked `work_items?...&limit=5000`, against
 * a PostgREST server that hard-caps a request at 1000 rows and returns HTTP 200 with NO error when
 * you ask for more. `board-drainer.mjs`'s own docblock promises "EVERY signal, in every state"; the
 * moment `fleet_signals` crosses 1000 rows (measured 731 and growing ~72/day on 2026-09-03) that
 * read silently drops the rest, `candidateIncidentsFor()` finds nothing for the dropped rows, and
 * the retirement pass reports success for retiring nothing — the exact failure the commit was
 * written to end. This suite holds the paging helper (scripts/lib/read-all-rows.mjs) in place.
 *
 * No secrets, no network, no services — the REST reader is injected.
 */
import assert from 'node:assert/strict'
import { readAllRows, withTiebreak } from '../scripts/lib/read-all-rows.mjs'

let failures = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ok - ${name}`) } catch (e) {
    failures++
    console.log(`  NOT OK - ${name}`)
    console.log(`      ${e.message.split('\n').slice(0, 4).join('\n      ')}`)
  }
}

// A fake PostgREST that honours order/limit/offset over a fixed population, and — like the real
// server — NEVER returns more than PAGE_CAP rows even if asked for more. Records every path it saw.
function fakeRest(rowCount, pageCap = 1000) {
  const all = Array.from({ length: rowCount }, (_, i) => ({ id: i + 1, v: `row-${i + 1}` }))
  const seen = []
  const rest = async (path) => {
    seen.push(path)
    const u = new URL('http://x/' + path)
    const limit = Math.min(Number(u.searchParams.get('limit') ?? rowCount), pageCap)
    const offset = Number(u.searchParams.get('offset') ?? 0)
    return all.slice(offset, offset + limit)
  }
  return { rest, seen, all }
}

console.log('\n1. PAGING — reads past the 1000-row server cap instead of stopping at it')

await (async () => {
  ok('a 2,344-row table comes back COMPLETE (the old limit=2000 would have returned 1000)', async () => {
    const { rest } = fakeRest(2344)
    const rows = await readAllRows(rest, 'fleet_signals?select=id', { order: 'id.asc' })
    assert.equal(rows.length, 2344, `expected all 2344 rows, got ${rows.length}`)
    // Prove it stitched the pages in order with no gap or repeat.
    assert.deepEqual(rows.map((r) => r.id).slice(0, 3), [1, 2, 3])
    assert.equal(rows[rows.length - 1].id, 2344)
    assert.equal(new Set(rows.map((r) => r.id)).size, 2344, 'a page boundary duplicated a row')
  })

  ok('exactly 1000 rows makes a SECOND request — only a short page proves the end', async () => {
    const { rest, seen } = fakeRest(1000)
    const rows = await readAllRows(rest, 'work_items?select=id', { order: 'id.asc' })
    assert.equal(rows.length, 1000)
    assert.equal(seen.length, 2, `a full page must be followed by one more read; made ${seen.length}`)
  })

  ok('a short first page ends after ONE request', async () => {
    const { rest, seen } = fakeRest(680)
    const rows = await readAllRows(rest, 'work_items?select=id', { order: 'id.asc' })
    assert.equal(rows.length, 680)
    assert.equal(seen.length, 1)
  })

  ok('every request carries limit=1000 and a growing offset', async () => {
    const { rest, seen } = fakeRest(2001)
    await readAllRows(rest, 'fleet_signals?select=id', { order: 'id.asc' })
    assert.ok(seen.every((p) => /[?&]limit=1000(&|$)/.test(p)), 'a page asked for something other than 1000')
    assert.deepEqual(seen.map((p) => Number(new URL('http://x/' + p).searchParams.get('offset'))), [0, 1000, 2000])
  })
})()

console.log('\n2. FAIL-SAFE — refuse rather than return a truncated sample quietly')

await (async () => {
  ok('a path that already caps itself is REFUSED (that shape is the bug this removes)', async () => {
    const { rest } = fakeRest(10)
    await assert.rejects(
      () => readAllRows(rest, 'work_items?select=id&limit=5000', { order: 'id.asc' }),
      /already caps itself/,
    )
  })

  ok('an absurd population THROWS past maxRows rather than returning an arbitrary sample', async () => {
    const { rest } = fakeRest(5000)
    await assert.rejects(
      () => readAllRows(rest, 'x?select=id', { order: 'id.asc', maxRows: 2000 }),
      /refused to keep paging past 2000/,
    )
  })

  ok('a non-function reader is rejected loudly', async () => {
    await assert.rejects(() => readAllRows(null, 'x?select=id'), /needs a rest reader/)
  })
})()

console.log('\n3. TOTAL ORDER — a unique tiebreaker so no page boundary falls inside a tie group')

ok('withTiebreak appends id when the caller did not name it', () => {
  assert.equal(withTiebreak('opened_at.asc'), 'opened_at.asc,id.asc')
})
ok('withTiebreak follows the last direction (desc stays newest-first all the way down)', () => {
  assert.equal(withTiebreak('ts.desc'), 'ts.desc,id.desc')
})
ok('withTiebreak is a no-op when the caller already named the unique column', () => {
  assert.equal(withTiebreak('id.asc'), 'id.asc')
})

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
