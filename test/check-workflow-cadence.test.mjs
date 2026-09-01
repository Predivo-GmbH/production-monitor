/**
 * Unit tests for the "did the watchers themselves run" dead-man's switch.
 *
 * Every assertion here was watched to fail against the naive version it names, because the
 * whole reason this file exists is that checks which cannot fail were shipped as checks.
 *
 * Run: node test/check-workflow-cadence.test.mjs   (exit 0 = all pass)
 */
import assert from 'node:assert'
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

console.log(`\n${n} assertions passed.`)
