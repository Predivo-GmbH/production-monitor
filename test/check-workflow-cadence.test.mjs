/**
 * Unit tests for the "did the watchers themselves run" dead-man's switch.
 *
 * Every assertion here was watched to fail against the naive version it names, because the
 * whole reason this file exists is that checks which cannot fail were shipped as checks.
 *
 * Run: node test/check-workflow-cadence.test.mjs   (exit 0 = all pass)
 */
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import {
  intervalMinutes, cronsIn, verdictFor, coverageLine, OVERDUE_FACTOR,
} from '../scripts/check-workflow-cadence.mjs'

let n = 0
const t = (name, fn) => { fn(); n++; console.log(`  ok - ${name}`) }

const NOW = Date.parse('2026-09-01T12:00:00Z')
const agoMin = (m) => new Date(NOW - m * 60000).toISOString()

// ── reading a schedule ───────────────────────────────────────────────────────────────────────

t('the four cron shapes this fleet actually writes are understood', () => {
  assert.equal(intervalMinutes('*/10 * * * *'), 10)
  assert.equal(intervalMinutes('37 * * * *'), 60)
  assert.equal(intervalMinutes('43 4 * * *'), 60 * 24)
  assert.equal(intervalMinutes('0 6 * * 1'), 60 * 24 * 7)
})

t('a shape it does not understand is null, never a guess', () => {
  // Defect: returning a default interval for anything unparsed. A workflow whose schedule
  // nobody understands would then be judged against an invented window and pass.
  assert.equal(intervalMinutes('0 6 1 * *'), null)   // day-of-month
  assert.equal(intervalMinutes('0 6 * 3 *'), null)   // month
  assert.equal(intervalMinutes('nonsense'), null)
  assert.equal(intervalMinutes(''), null)
})

t('every cron in a file is found, including a commented one on the same line', () => {
  const yaml = [
    'on:',
    '  schedule:',
    "    - cron: '37 * * * *'  # hourly at :37",
    '    - cron: "0 8 * * *"',
    '  workflow_dispatch: {}',
  ].join('\n')
  assert.deepEqual(cronsIn(yaml), ['37 * * * *', '0 8 * * *'])
})

t('a workflow with no cron is not this check\'s business', () => {
  assert.deepEqual(cronsIn('on:\n  push:\n    branches: [master]\n'), [])
  assert.equal(verdictFor({ name: 'test.yml', crons: [], state: 'active', lastRunAt: null, now: NOW }), null)
})

// ── the verdict, which is the whole point ────────────────────────────────────────────────────

t('an hourly workflow that ran 20 minutes ago is fine', () => {
  const v = verdictFor({ name: 'monitor.yml', crons: ['37 * * * *'], state: 'active', lastRunAt: agoMin(20), now: NOW })
  assert.equal(v.ok, true)
})

t('an hourly workflow silent for a day is DEAD, and says how long', () => {
  const v = verdictFor({ name: 'monitor.yml', crons: ['37 * * * *'], state: 'active', lastRunAt: agoMin(60 * 24), now: NOW })
  assert.equal(v.ok, false)
  assert.match(v.why, /24h ago/)
})

t('one missed tick is not an outage - the window is 3x the interval', () => {
  // The alerting philosophy this fleet already keeps: only a PERSISTENTLY dead job fires.
  // GitHub drops scheduled ticks under load, measured in monitor.yml.
  const justInside = verdictFor({ name: 'x.yml', crons: ['37 * * * *'], state: 'active', lastRunAt: agoMin(60 * OVERDUE_FACTOR - 5), now: NOW })
  const justOutside = verdictFor({ name: 'x.yml', crons: ['37 * * * *'], state: 'active', lastRunAt: agoMin(60 * OVERDUE_FACTOR + 5), now: NOW })
  assert.equal(justInside.ok, true)
  assert.equal(justOutside.ok, false)
})

t('a weekly guard is judged against a week, not against an hour', () => {
  // Defect: one global window. The RLS and auth-email guards run Mondays; an hourly window
  // would report them dead six days out of seven and the alarm would be trained away.
  const v = verdictFor({ name: 'rls-grants-check.yml', crons: ['20 6 * * 1'], state: 'active', lastRunAt: agoMin(60 * 24 * 6), now: NOW })
  assert.equal(v.ok, true)
})

t('a workflow GitHub has disabled is DEAD even though nothing ever failed', () => {
  // This is the case with no red run anywhere: the schedule simply stops. It is the reason
  // the file exists, and the naive "look at the last run" check passes it forever.
  const v = verdictFor({ name: 'drift-check.yml', crons: ['43 4 * * *'], state: 'disabled_inactivity', lastRunAt: agoMin(10), now: NOW })
  assert.equal(v.ok, false)
  assert.match(v.why, /disabled_inactivity/)
})

t('no scheduled run at all is DEAD, not "it has not fired yet"', () => {
  const v = verdictFor({ name: 'new.yml', crons: ['0 8 * * *'], state: 'active', lastRunAt: null, now: NOW })
  assert.equal(v.ok, false)
  assert.match(v.why, /no scheduled run at all/)
})

t('an unreadable cron fails the workflow instead of passing it', () => {
  const v = verdictFor({ name: 'weird.yml', crons: ['0 6 1 * *'], state: 'active', lastRunAt: agoMin(5), now: NOW })
  assert.equal(v.ok, false)
  assert.match(v.why, /not understood/)
})

t('with two crons the TIGHTER one decides, so a daily+hourly file is judged hourly', () => {
  const v = verdictFor({ name: 'both.yml', crons: ['0 8 * * *', '37 * * * *'], state: 'active', lastRunAt: agoMin(60 * 5), now: NOW })
  assert.equal(v.ok, false)
})

// ── coverage, because a count of what it read is not a count of what exists ───────────────────

t('the run says whether it judged everything it found', () => {
  assert.match(coverageLine(12, 12), /judged all 12/)
  assert.match(coverageLine(12, 9), /judged 9 of 12/)
  assert.match(coverageLine(12, 9), /not the same as fine/)
})


// ── a cron may fire more than once a day ──────────────────────────────────────────────────────

t('a comma list of hours is measured by its WIDEST gap, not its average', () => {
  // Regression for 2026-09-02: cron-heartbeat.yml went from '7 5 * * *' to '7 5,11 * * *'
  // to stop layer 2 being blind for eighteen hours a day, and this guard immediately and
  // correctly failed the monitor with "cron shape not understood" — it refuses to call a
  // schedule healthy when it cannot say when the schedule should fire. Teaching it the
  // shape is the fix; loosening it into a guess would not have been.
  assert.equal(intervalMinutes('7 5,11 * * *'), 18 * 60)      // 5->11 is 6h, 11->5 is 18h
  assert.equal(intervalMinutes('0 0,6,12,18 * * *'), 6 * 60)  // evenly spaced
  assert.equal(intervalMinutes('7 5,11,23 * * *'), 12 * 60)   // widest of 6h / 12h / 6h
  // The average would be 24/n and would call a normal overnight wait late: 5,11 averages
  // 12h, so a run arriving 17h after the last one — perfectly on time — would look overdue.
  assert.notEqual(intervalMinutes('7 5,11 * * *'), 12 * 60)
  // One hour in the list is the same statement as no list at all.
  assert.equal(intervalMinutes('7 5 * * *'), intervalMinutes('7 5,5 * * *'))
})

t('an hour outside 0-23 is still not understood, rather than averaged into something plausible', () => {
  assert.equal(intervalMinutes('0 5,25 * * *'), null)
  assert.equal(intervalMinutes('0 5, * * *'), null)
  assert.equal(intervalMinutes('0 5,11 1 * *'), null)   // day-of-month still unsupported
  assert.equal(intervalMinutes('0 5,11 * * 1'), null)   // weekly + list not claimed
})

t('THE LIVE SHAPE: the heartbeat schedule now on disk is one this guard can judge', () => {
  // Not a hypothetical string — the actual file, so editing the cron without teaching the
  // guard fails here instead of reddening the hourly monitor the way it did on 2026-09-02.
  const yaml = readFileSync(new URL('../.github/workflows/cron-heartbeat.yml', import.meta.url), 'utf8')
  const crons = cronsIn(yaml)
  assert.ok(crons.length > 0, 'cron-heartbeat.yml must still be a scheduled workflow')
  for (const c of crons) {
    assert.notEqual(intervalMinutes(c), null, `cadence guard cannot read cron '${c}'`)
  }
})

console.log(`\n${n} assertions passed.`)
