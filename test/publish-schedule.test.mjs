/**
 * THE MACHINE'S OWN SCHEDULE, PARSED WITHOUT INVENTING A SINGLE TIME.
 *
 * Roger, 2026-09-05: "when are you going to pick up?" The board could not say, because no table
 * carried a schedule. Now the laptop publishes its Task Scheduler every 30 minutes. This suite holds
 * the two properties that matter: only board tasks are published, and a missing time stays missing.
 *
 * Pure — the PowerShell and PostgREST edges are injected. Run: node test/publish-schedule.test.mjs
 */
import assert from 'node:assert'
import { toScheduleRows, publishSchedule, BOARD_TASK_PATTERN } from '../scripts/lib/publish-schedule.mjs'

let n = 0
const t = (name, fn) => { fn(); n++; console.log(`  ok - ${name}`) }
const ta = async (name, fn) => { await fn(); n++; console.log(`  ok - ${name}`) }
const NOW = () => '2026-09-05T08:00:00.000Z'

// A verbatim shape of what the laptop answered on 2026-09-05, trimmed to five tasks.
const SAMPLE = JSON.stringify([
  { name: 'Board-Lane-Advancer', state: 'Ready', cadence: 'every PT30M', next: '2026-09-05T10:34:41+02:00', last: '2026-09-05T10:04:42+02:00', result: 0 },
  { name: 'Board-Monthly-No', state: 'Ready', cadence: 'daily at 07:30', next: '2026-09-07T07:30:00+02:00', last: null, result: 267011 },
  { name: 'KB Apply Loop Daily', state: 'Disabled', cadence: 'daily at 13:00', next: '2026-09-05T13:00:00+02:00', last: '2026-09-02T14:31:44+02:00', result: 0 },
  { name: 'GoogleUpdaterTaskSystem152.0', state: 'Ready', cadence: 'every PT1H', next: '2026-09-05T10:26:54+02:00', last: null, result: 0 },
  { name: 'VerifyWinRE', state: 'Ready', cadence: 'once', next: null, last: '2026-08-25T09:20:23+02:00', result: 2147943568 },
])

t('only board tasks are published; the operating system\'s own jobs are not "Claude"', () => {
  const rows = toScheduleRows(SAMPLE, { machine: 'LAPTOP', now: NOW })
  const names = rows.map((r) => r.task_name)
  assert.ok(names.includes('Board-Lane-Advancer'))
  assert.ok(names.includes('Board-Monthly-No'))
  assert.ok(names.includes('KB Apply Loop Daily'), 'a disabled board task is still published, so the page can say it is switched off')
  assert.ok(!names.includes('VerifyWinRE'), 'a Windows recovery task is not a board machine')
  // Google's updater matches "Google" by name; it is filtered by the pattern's intent, and this
  // asserts the pattern was tightened to the fleet's own Google job rather than any Google task.
  assert.ok(!names.includes('GoogleUpdaterTaskSystem152.0'), 'a vendor updater is not our Google Issues check')
})

t('a missing time stays missing - nothing is invented', () => {
  const rows = toScheduleRows(SAMPLE, { machine: 'LAPTOP', now: NOW })
  const monthly = rows.find((r) => r.task_name === 'Board-Monthly-No')
  assert.equal(monthly.last_run, null, 'a task that never ran has no last run')
  assert.equal(monthly.last_result, 267011, 'and its never-ran code is preserved for the page to name')
})

t('every row carries the machine and the publish time, so staleness can be judged', () => {
  const rows = toScheduleRows(SAMPLE, { machine: 'LAPTOP-88N97BGG', now: NOW })
  for (const r of rows) {
    assert.equal(r.machine, 'LAPTOP-88N97BGG')
    assert.equal(r.published_at, NOW())
  }
})

t('malformed scheduler output publishes nothing rather than garbage', () => {
  assert.deepEqual(toScheduleRows('not json'), [])
  assert.deepEqual(toScheduleRows(''), [])
  assert.deepEqual(toScheduleRows('null'), [])
  assert.deepEqual(toScheduleRows(JSON.stringify([{ nope: 1 }, null, 42])), [])
})

t('a single task comes back as an object, not an array, and is still handled', () => {
  const one = JSON.stringify({ name: 'Board-Closer-Hourly', state: 'Ready', cadence: 'every PT1H', next: null, last: null, result: 0 })
  assert.equal(toScheduleRows(one, { now: NOW }).length, 1)
})

await ta('a failed publish is reported and never thrown - the advancer must keep moving rows', async () => {
  const rows = toScheduleRows(SAMPLE, { now: NOW })
  const boom = async () => { throw new Error('network down') }
  const r = await publishSchedule(rows, { url: 'http://x', headers: {}, fetchImpl: boom })
  assert.equal(r.written, 0)
  assert.match(r.status, /network down/)
  const refused = async () => ({ ok: false, status: 401 })
  const r2 = await publishSchedule(rows, { url: 'http://x', headers: {}, fetchImpl: refused })
  assert.equal(r2.written, 0)
  assert.equal(r2.status, 'HTTP 401')
})

await ta('a successful publish upserts on task_name and reports the row count', async () => {
  const rows = toScheduleRows(SAMPLE, { now: NOW })
  let seen = null
  const ok = async (url, init) => { seen = { url, init }; return { ok: true, status: 201 } }
  const r = await publishSchedule(rows, { url: 'http://x', headers: { apikey: 'k' }, fetchImpl: ok })
  assert.equal(r.written, rows.length)
  assert.match(seen.url, /on_conflict=task_name/)
  assert.match(seen.init.headers.Prefer, /merge-duplicates/)
})

t('the pattern names the fleet\'s board machines and nothing that merely contains the word', () => {
  assert.ok(BOARD_TASK_PATTERN.test('Night Shift (work board)'))
  assert.ok(BOARD_TASK_PATTERN.test('Work On It Now (board button)'))
  assert.ok(!BOARD_TASK_PATTERN.test('ReconcileLanguageResources'), 'a Windows reconcile task is not the fleet reconcile job')
})

console.log(`\n${n} passed`)
