/**
 * "This job stopped running" is a CLAIM, and it may only stand while nothing proves otherwise.
 *
 * These tests exist because the fleet's top alarm — healthchecks `my-first-check`, named
 * "production-monitor (hourly)" — sat CRITICAL for 10.7 hours on 2026-09-03 announcing that the
 * hourly monitor had stopped, while the hourly monitor was running every half hour and was in fact
 * the process re-stamping the alarm. See scripts/lib/alarm-state.mjs for the mechanism.
 *
 * THE TEST THAT MATTERS MOST IS NOT "the false red clears". It is the block headed A GENUINE
 * OUTAGE STILL GOES RED AND STAYS RED. A rule that clears a stuck alarm is worthless if it also
 * clears a real one, so every way the reprieve could be wrongly granted is asserted negatively.
 *
 * Run: node test/alarm-state.test.mjs   (exit 0 = all pass)
 */
import assert from 'node:assert'
import {
  livenessVerdict, partitionDownChecks, reprievedResolution, toleranceMinutes,
  beaconFor, LIVENESS_BEACONS, DEFAULT_TOLERANCE_MINUTES,
} from '../scripts/lib/alarm-state.mjs'
import { planRun, readBeaconReadings, ROLLUP_THRESHOLD } from '../scripts/check-healthchecks-down.mjs'

let n = 0
const t = (name, fn) => { fn(); n++; console.log(`  ok - ${name}`) }
const ta = async (name, fn) => { await fn(); n++; console.log(`  ok - ${name}`) }

const NOW = Date.parse('2026-09-03T06:36:00.000Z')
const ago = (mins) => new Date(NOW - mins * 60_000).toISOString()

/** The real check, with the real settings read from healthchecks on 2026-09-03. */
const MONITOR = (over = {}) => ({
  slug: 'my-first-check',
  name: 'production-monitor (hourly)',
  status: 'down',
  timeout: 3600,
  grace: 7200,
  last_ping: '2026-09-02T19:57:06+00:00',
  account: 'primary',
  ...over,
})

/** A check with no beacon: the genuine dead-man, which must behave exactly as it always has. */
const OTHER = (over = {}) => ({
  slug: 'nightly-backup', name: 'nightly-backup', status: 'down', timeout: 86400, grace: 3600,
  last_ping: ago(3000), account: 'primary', ...over,
})

// ── the tolerance comes from the check itself, never from a number typed here ──────────────────
t('tolerance is the check\'s own timeout + grace — 3600 + 7200 = the 180 min monitor.yml documents', () => {
  assert.equal(toleranceMinutes(MONITOR()), 180)
})

t('a cron check carries only grace, and that alone is used', () => {
  assert.equal(toleranceMinutes({ schedule: '*' + '/10 * * * *', grace: 5400 }), 90)
})

t('a check with neither falls back to the documented default, not to zero', () => {
  assert.equal(toleranceMinutes({}), DEFAULT_TOLERANCE_MINUTES)
  assert.equal(toleranceMinutes({ timeout: 0, grace: 0 }), DEFAULT_TOLERANCE_MINUTES)
})

// ── A GENUINE OUTAGE STILL GOES RED AND STAYS RED ─────────────────────────────────────────────
// Every one of these is a way the reprieve could be handed out wrongly. All must be refused.

t('GENUINE OUTAGE: the scheduler really stopped, so nothing wrote the beacon — alarm stands', () => {
  const v = livenessVerdict({ check: MONITOR(), beaconAt: ago(400), now: NOW })
  assert.equal(v.alive, false)
  assert.equal(v.verdict, 'stale')
  assert.match(v.why, /really has stopped/)
})

t('GENUINE OUTAGE: one minute past the check\'s own tolerance is already an outage', () => {
  assert.equal(livenessVerdict({ check: MONITOR(), beaconAt: ago(181), now: NOW }).alive, false)
  assert.equal(livenessVerdict({ check: MONITOR(), beaconAt: ago(179), now: NOW }).alive, true)
})

t('UNREADABLE IS NOT ALIVE: a beacon that could not be read leaves the alarm red', () => {
  for (const bad of [null, undefined, '', 'not-a-date', {}]) {
    const v = livenessVerdict({ check: MONITOR(), beaconAt: bad, now: NOW })
    assert.equal(v.alive, false, `beaconAt=${JSON.stringify(bad)} must not reprieve`)
    assert.equal(v.verdict, 'unreadable')
  }
})

t('NO BEACON, NO REPRIEVE: a check nobody vouches for behaves exactly as it always has', () => {
  const v = livenessVerdict({ check: OTHER(), beaconAt: ago(1), now: NOW })
  assert.equal(v.alive, false)
  assert.equal(v.verdict, 'no-beacon')
})

t('A CORRUPT FUTURE-DATED BEACON CANNOT INSTALL A PERMANENT MUTE', () => {
  const v = livenessVerdict({ check: MONITOR(), beaconAt: new Date(NOW + 400 * 60_000).toISOString(), now: NOW })
  assert.equal(v.alive, false)
  assert.equal(v.verdict, 'unreadable')
  assert.match(v.why, /FUTURE/)
})

t('a beacon a few minutes ahead is ordinary clock skew, not corruption, and still counts', () => {
  assert.equal(livenessVerdict({ check: MONITOR(), beaconAt: new Date(NOW + 60_000).toISOString(), now: NOW }).alive, true)
})

t('a reprieve cannot leak from one job to another: a fresh beacon for a DIFFERENT job is not read', () => {
  const { dead, reprieved } = partitionDownChecks({
    down: [OTHER()],
    beaconReadings: { 'my-first-check': ago(1) },   // fresh, but belongs to another check entirely
    now: NOW,
  })
  assert.equal(reprieved.length, 0)
  assert.equal(dead.length, 1)
})

t('the beacon map is a closed list — only checks named in it can ever be reprieved', () => {
  assert.deepEqual(Object.keys(LIVENESS_BEACONS), ['my-first-check'])
  assert.equal(beaconFor('ci-runner-watchdog'), null)
  assert.equal(beaconFor(undefined), null)
  // and nothing inherited off Object.prototype can be mistaken for a beacon
  assert.equal(beaconFor('constructor'), null)
})

// ── the false red, and only the false red ─────────────────────────────────────────────────────
t('THE 2026-09-03 CASE: monitor ran 0 min ago, healthchecks says down for 10.7h — not an outage', () => {
  const v = livenessVerdict({
    check: MONITOR(),
    beaconAt: '2026-09-03T06:36:53+00:00',   // machine_state.monitoring.updated_at, read that morning
    now: Date.parse('2026-09-03T06:37:30Z'),
  })
  assert.equal(v.alive, true)
  assert.equal(v.verdict, 'ping-suppressed')
  assert.equal(v.toleranceMinutes, 180)
})

t('the row that replaces the false alarm resolves it, and cannot page', () => {
  const check = MONITOR()
  const verdict = livenessVerdict({ check, beaconAt: ago(2), now: NOW })
  const row = reprievedResolution({ check, key: 'my-first-check', verdict })
  assert.equal(row.state, 'resolved')
  assert.equal(row.severity, 'info')
  assert.equal(row.source, 'healthchecks')
  assert.equal(row.key, 'my-first-check')
  assert.equal(row.detail.liveness_verdict, 'ping-suppressed')
})

t('and it does NOT claim the job checked in — it did not; that is the whole point', () => {
  const check = MONITOR()
  const row = reprievedResolution({ check, key: 'my-first-check', verdict: livenessVerdict({ check, beaconAt: ago(2), now: NOW }) })
  assert.doesNotMatch(row.summary, /checked in again/i)
  assert.match(row.summary, /It never stopped/)
  assert.match(row.summary, /green run/)
})

// ── the rollup still counts outages, and only outages ─────────────────────────────────────────
t('a reprieved check does not count toward the "everything is dark" rollup', () => {
  const checks = [MONITOR(), OTHER({ slug: 'a', name: 'a' }), OTHER({ slug: 'b', name: 'b' })]
  const plan = planRun({ checks, beaconReadings: { 'my-first-check': ago(2) }, now: NOW })
  assert.equal(plan.dead.length, 2)
  assert.equal(plan.reprieved.length, 1)
  assert.equal(plan.rollup, null, `two genuinely dark jobs is below the threshold of ${ROLLUP_THRESHOLD}`)
})

t('three genuinely dark jobs still roll up into one critical alert', () => {
  const checks = ['a', 'b', 'c'].map((s) => OTHER({ slug: s, name: s }))
  const plan = planRun({ checks, now: NOW })
  assert.equal(plan.dead.length, 3)
  assert.equal(plan.rollup.severity, 'critical')
  assert.equal(plan.rollup.needs_human, true)
})

// ── the beacon reader can only ever KEEP an alarm red ─────────────────────────────────────────
await ta('the beacon reader asks only about checks that have a beacon', async () => {
  const asked = []
  await readBeaconReadings('x', [MONITOR(), OTHER()], async (_s, path) => { asked.push(path); return [{ kind: 'monitoring', updated_at: ago(2) }] })
  assert.equal(asked.length, 1)
  assert.match(asked[0], /kind=in\.\(monitoring\)/)
})

await ta('no beaconed check among the dead means no board read happens at all', async () => {
  let called = 0
  const out = await readBeaconReadings('x', [OTHER()], async () => { called++; return [] })
  assert.equal(called, 0)
  assert.deepEqual(out, {})
})

await ta('a failed beacon read does not throw and reprieves nothing', async () => {
  const out = await readBeaconReadings('x', [MONITOR()], async () => { throw new Error('HTTP 503') })
  assert.deepEqual(out, {})
  assert.equal(partitionDownChecks({ down: [MONITOR()], beaconReadings: out, now: NOW }).dead.length, 1)
})

await ta('a missing machine_state row reads as null, which is unreadable, which stays red', async () => {
  const out = await readBeaconReadings('x', [MONITOR()], async () => [])
  assert.deepEqual(out, { 'my-first-check': null })
  assert.equal(partitionDownChecks({ down: [MONITOR()], beaconReadings: out, now: NOW }).dead.length, 1)
})

// ── THE FULL CYCLE, driven through planRun — the same function main() runs in CI ──────────────
// healthy -> genuinely fail -> red -> still red -> restore -> green ON ITS OWN.
console.log('\n  -- full cycle: healthy -> failed -> red -> restored -> green on its own --')

// 1. HEALTHY. The job runs and pings. Nothing is filed, nothing is on the board.
const phase1 = planRun({ checks: [MONITOR({ status: 'up', last_ping: ago(20) })], openKeys: new Set(), beaconReadings: { 'my-first-check': ago(20) }, now: NOW })
t('1 HEALTHY: no alarm filed, nothing to resolve', () => {
  assert.equal(phase1.dead.length, 0)
  assert.equal(phase1.members.length, 0)
  assert.equal(phase1.resolves.length, 0)
})

// 2. GENUINELY FAILS. The scheduler stops firing the workflow entirely, so the workflow never
//    starts, so its own `if: always()` step never runs and the beacon goes stale with it.
const phase2 = planRun({ checks: [MONITOR({ last_ping: ago(400) })], openKeys: new Set(), beaconReadings: { 'my-first-check': ago(400) }, now: NOW })
t('2 GENUINELY FAILS: filed as a critical outage that can ring a phone', () => {
  assert.equal(phase2.dead.length, 1)
  assert.equal(phase2.reprieved.length, 0)
  assert.equal(phase2.members.length, 1)
  assert.equal(phase2.members[0].severity, 'critical')
  assert.equal(phase2.members[0].needs_human, true)
  assert.match(phase2.members[0].title, /Scheduled job stopped running/)
})

// 3. AN HOUR LATER, still dead. The row is now open on the board. It must NOT be cleared.
const phase3 = planRun({ checks: [MONITOR({ last_ping: ago(460) })], openKeys: new Set(['my-first-check']), beaconReadings: { 'my-first-check': ago(460) }, now: NOW })
t('3 STAYS RED: an open row for a job that is still dead is never resolved', () => {
  assert.equal(phase3.dead.length, 1)
  assert.deepEqual(phase3.resolves, [])
  assert.equal(phase3.members[0].severity, 'critical')
})

// 4. RESTORED. The scheduler fires again and the workflow runs to the end — but the run is RED
//    (one sensor found something), so `if: success()` withholds the ping and healthchecks still
//    says down. Nobody touches anything. The alarm must clear itself.
const phase4 = planRun({ checks: [MONITOR({ last_ping: ago(460) })], openKeys: new Set(['my-first-check']), beaconReadings: { 'my-first-check': ago(3) }, now: NOW })
t('4 RESTORED: goes green ON ITS OWN, with nobody clearing it', () => {
  assert.equal(phase4.dead.length, 0)
  assert.equal(phase4.members.length, 0, 'and it does not re-file the alarm it just cleared')
  assert.equal(phase4.reprieved.length, 1)
  assert.equal(phase4.resolves.length, 1)
  assert.equal(phase4.resolves[0].key, 'my-first-check')
  assert.equal(phase4.resolves[0].body.state, 'resolved')
  assert.equal(phase4.resolves[0].body.severity, 'info')
})

// 5. AND IT DOES NOT FLAP. Next hour, same situation, but the row is no longer open: nothing is
//    filed and nothing is resolved, so the board does not oscillate red/green every hour.
const phase5 = planRun({ checks: [MONITOR({ last_ping: ago(520) })], openKeys: new Set(), beaconReadings: { 'my-first-check': ago(3) }, now: NOW })
t('5 NO FLAPPING: with the row already closed, the next run writes nothing at all', () => {
  assert.equal(phase5.members.length, 0)
  assert.equal(phase5.resolves.length, 0)
})

// 6. AND A REAL RECOVERY IS STILL DESCRIBED AS A REAL RECOVERY. When the ping does arrive, the
//    pre-existing wording is used, untouched by any of this.
const phase6 = planRun({ checks: [MONITOR({ status: 'up', last_ping: ago(5) })], openKeys: new Set(['my-first-check']), beaconReadings: { 'my-first-check': ago(5) }, now: NOW })
t('6 A REAL CHECK-IN is still reported as one, in the original words', () => {
  assert.equal(phase6.resolves.length, 1)
  assert.equal(phase6.resolves[0].reprieved, null)
  assert.match(phase6.resolves[0].body.summary, /checked in again/)
})

// 7. THE OUTAGE COMES BACK. The scheduler stops again; the beacon goes stale again; it reds again.
const phase7 = planRun({ checks: [MONITOR({ last_ping: ago(600) })], openKeys: new Set(), beaconReadings: { 'my-first-check': ago(600) }, now: NOW })
t('7 AND IT CAN GO RED AGAIN: the switch was widened, not disarmed', () => {
  assert.equal(phase7.dead.length, 1)
  assert.equal(phase7.members[0].severity, 'critical')
  assert.equal(phase7.members[0].needs_human, true)
})

// ── the pre-existing invariant this change must not break ─────────────────────────────────────
t('a non-check row filed under this source is still never touched by any of this', () => {
  const plan = planRun({
    checks: [MONITOR({ status: 'up', last_ping: ago(5) })],
    openKeys: new Set(['my-first-check', 'diagnosis/why-the-fleet-went-dark']),
    beaconReadings: { 'my-first-check': ago(5) },
    now: NOW,
  })
  assert.deepEqual(plan.resolves.map((r) => r.key), ['my-first-check'])
})

console.log(`\n${n} tests passed.`)
