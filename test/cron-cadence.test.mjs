/**
 * Unit test for the cadence-relative escalation threshold (scripts/lib/cron-cadence.mjs),
 * used by scripts/automation-status.mjs.
 *
 * The 2026-08-29 board incident "red-48h-escalator-ignores-workflow-cadence": a flat 48h
 * threshold paged on workflows that had not even RUN again since going red (weekly and
 * rarer schedules). These cases pin: the threshold is max(48h, 2x schedule period),
 * capped at 21 days; exotic cron fails OPEN to the 48h base; a workflow with no schedule
 * keeps 48h; and the shortest of several schedules wins.
 *
 * Run: node test/cron-cadence.test.mjs   (exit 0 = all pass)
 */
import assert from 'node:assert'
import {
  extractCronSchedules,
  cronPeriodHours,
  escalationThresholdHours,
  thresholdForWorkflowYaml,
  BASE_ESCALATION_HOURS,
  MAX_ESCALATION_HOURS,
} from '../scripts/lib/cron-cadence.mjs'

let passed = 0
let failed = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok   - ${name}`); passed++ }
  catch (e) { console.log(`  FAIL - ${name}: ${e.message}`); failed++ }
}

// A fixed UTC clock so the simulation is deterministic (2026-08-29 is a Saturday).
const T0 = Date.UTC(2026, 7, 29, 12, 0, 0)

check('extract: finds quoted and unquoted cron entries', () => {
  const yaml = 'on:\n  schedule:\n    - cron: "0 6 * * 1"\n    - cron: \'30 18 * * *\'\n  push:\n    branches: [main]\n'
  assert.deepStrictEqual(extractCronSchedules(yaml), ['0 6 * * 1', '30 18 * * *'])
})

check('extract: no schedule block → empty', () => {
  assert.deepStrictEqual(extractCronSchedules('on:\n  push:\n    branches: [main]\n'), [])
  assert.deepStrictEqual(extractCronSchedules(''), [])
  assert.deepStrictEqual(extractCronSchedules(null), [])
})

check('period: hourly cron → ~1h', () => {
  assert.strictEqual(cronPeriodHours('7 * * * *', T0), 1)
})

check('period: every-15-min cron → 0.25h', () => {
  assert.strictEqual(cronPeriodHours('*/15 * * * *', T0), 0.25)
})

check('period: daily cron → 24h', () => {
  assert.strictEqual(cronPeriodHours('0 6 * * *', T0), 24)
})

check('period: weekday cron (Mon-Fri) median gap is 24h, not the 72h weekend gap', () => {
  assert.strictEqual(cronPeriodHours('0 9 * * 1-5', T0), 24)
})

check('period: weekly cron (Mondays) → 168h', () => {
  assert.strictEqual(cronPeriodHours('0 6 * * 1', T0), 168)
})

check('period: twice-a-week cron list → 96h median (Mon+Thu: gaps 72h/96h)', () => {
  const p = cronPeriodHours('0 6 * * 1,4', T0)
  assert.ok(p === 72 || p === 96, `expected 72 or 96, got ${p}`)
})

check('period: monthly cron → ~30-31 days', () => {
  const p = cronPeriodHours('0 6 1 * *', T0)
  assert.ok(p >= 24 * 28 && p <= 24 * 32, `expected ~monthly, got ${p}`)
})

check('period: unparseable cron → null (fails open to base threshold)', () => {
  assert.strictEqual(cronPeriodHours('0 6 * * MON', T0), null)
  assert.strictEqual(cronPeriodHours('@weekly', T0), null)
  assert.strictEqual(cronPeriodHours('0 6 * *', T0), null)
  assert.strictEqual(cronPeriodHours('', T0), null)
})

check('period: DOM+DOW both restricted uses cron OR-semantics (1st of month OR Monday)', () => {
  const p = cronPeriodHours('0 6 1 * 1', T0)
  assert.ok(p !== null && p <= 168, `expected <= weekly, got ${p}`)
})

check('threshold: no schedule (push-only) → 48h base', () => {
  assert.strictEqual(escalationThresholdHours(null), BASE_ESCALATION_HOURS)
  assert.strictEqual(escalationThresholdHours(undefined), BASE_ESCALATION_HOURS)
  assert.strictEqual(escalationThresholdHours(0), BASE_ESCALATION_HOURS)
  assert.strictEqual(escalationThresholdHours(NaN), BASE_ESCALATION_HOURS)
})

check('threshold: hourly/daily schedules stay at the 48h floor', () => {
  assert.strictEqual(escalationThresholdHours(1), 48)
  assert.strictEqual(escalationThresholdHours(24), 48)
})

check('threshold: weekly schedule → 2x period = 336h', () => {
  assert.strictEqual(escalationThresholdHours(168), 336)
})

check('threshold: very rare schedule is capped at 21 days', () => {
  assert.strictEqual(escalationThresholdHours(24 * 90), MAX_ESCALATION_HOURS)
})

check('workflow yaml: shortest schedule wins (daily beats weekly)', () => {
  const yaml = 'on:\n  schedule:\n    - cron: "0 6 * * 1"\n    - cron: "0 6 * * *"\n'
  const { schedulePeriodHours, thresholdHours } = thresholdForWorkflowYaml(yaml, T0)
  assert.strictEqual(schedulePeriodHours, 24)
  assert.strictEqual(thresholdHours, 48)
})

check('workflow yaml: weekly-only workflow gets a 336h threshold', () => {
  const yaml = 'name: weekly-report\non:\n  schedule:\n    - cron: "0 6 * * 1"\n'
  const { thresholdHours } = thresholdForWorkflowYaml(yaml, T0)
  assert.strictEqual(thresholdHours, 336)
})

check('workflow yaml: push-only workflow keeps the 48h base', () => {
  const yaml = 'name: deploy\non:\n  push:\n    branches: [main]\n'
  const { schedulePeriodHours, thresholdHours } = thresholdForWorkflowYaml(yaml, T0)
  assert.strictEqual(schedulePeriodHours, null)
  assert.strictEqual(thresholdHours, 48)
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
