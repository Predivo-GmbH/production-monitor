/**
 * A WATCHDOG THAT FOUND SOMETHING MUST NOT LOOK LIKE A WATCHDOG THAT DIED.
 *
 * Every assertion here fails against the behaviour it replaces. Until 2026-09-03 the heartbeat
 * step in .github/workflows/ci-runner-watchdog.yml pinged healthchecks.io on `job.status`, and
 * check-ci-runners.mjs exits 1 on ANY finding - a coverage warning about a repository served by
 * one machine is enough. So a working, reporting watchdog pinged `/fail`, the check went DOWN,
 * and the fleet filed "Scheduled job stopped running: ci-runner-watchdog" against a check whose
 * last ping was six minutes old.
 *
 * The two halves of the fix are both tested here, because either one alone leaves the fault:
 *   1. the DECISION (decideHeartbeat) - findings are not silence, but a run that could not
 *      certify the fleet still is;
 *   2. the WIRING - the workflow actually calls it, and no longer branches on job.status. A
 *      correct decision function nothing calls is the shape of miss this repo keeps finding.
 *
 * Run: node test/a-working-watchdog-does-not-look-dead.test.mjs   (exit 0 = all pass)
 */
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { decideHeartbeat, MAX_REPORT_AGE_MS, UP, FAIL } from '../scripts/lib/watchdog-heartbeat.mjs'

let n = 0
const t = (name, fn) => { fn(); n++; console.log(`  ok - ${name}`) }

const NOW = Date.parse('2026-09-03T08:03:04.000Z')
const fresh = (extra = {}) => JSON.stringify({
  generated_at: new Date(NOW - 20_000).toISOString(),
  repos_with_runners: 12,
  flips: [],
  findings: [],
  ...extra,
})

// ── 1. the incident itself ────────────────────────────────────────────────────────────────────

t('THE INCIDENT: a run that found something and exited 1 still pings UP', () => {
  const r = decideHeartbeat({
    reportRaw: fresh({ findings: ['BoatBuddy: required gate "gate-integration" was CANCELLED, not failed'] }),
    jobStatus: 'failure',
    now: NOW,
  })
  assert.equal(r.ping, UP, 'a finding is the watchdog working, not the watchdog dying')
  assert.match(r.reason, /1 finding/)
})

t('a run that moved the fleet to paid runners also pings UP - that is a bill, not a silence', () => {
  const r = decideHeartbeat({
    reportRaw: fresh({ flips: ['ScoutCopilot: cleared RUNNER_LABEL'], findings: ['office PC offline'] }),
    jobStatus: 'failure',
    now: NOW,
  })
  assert.equal(r.ping, UP)
})

t('a clean run pings UP', () => {
  assert.equal(decideHeartbeat({ reportRaw: fresh(), jobStatus: 'success', now: NOW }).ping, UP)
})

t('job.status alone never decides it, in either direction', () => {
  const green = decideHeartbeat({ reportRaw: null, jobStatus: 'success', now: NOW })
  assert.equal(green.ping, FAIL, 'a green job that wrote no report inspected nothing')
  const red = decideHeartbeat({ reportRaw: fresh({ findings: ['x'] }), jobStatus: 'failure', now: NOW })
  assert.equal(red.ping, UP)
})

// ── 2. what a dead-man is actually for: a run that could not certify the fleet ────────────────

t('no report at all pings /fail - it died before it inspected anything', () => {
  const r = decideHeartbeat({ reportRaw: null, jobStatus: 'failure', now: NOW })
  assert.equal(r.ping, FAIL)
  assert.match(r.reason, /never inspected the fleet/)
})

t('an unreadable report pings /fail', () => {
  assert.equal(decideHeartbeat({ reportRaw: '{not json', jobStatus: 'failure', now: NOW }).ping, FAIL)
})

t('an empty file pings /fail', () => {
  assert.equal(decideHeartbeat({ reportRaw: '   ', jobStatus: 'failure', now: NOW }).ping, FAIL)
})

t('a JSON array is not a report', () => {
  assert.equal(decideHeartbeat({ reportRaw: '[]', jobStatus: 'failure', now: NOW }).ping, FAIL)
})

t('bail() - watchdog_broken - pings /fail, and says which reason', () => {
  const raw = JSON.stringify({
    generated_at: new Date(NOW - 20_000).toISOString(),
    watchdog_broken: true,
    broken_reason: 'no repository has a self-hosted runner registered',
    repos_with_runners: null,
    flips: [],
    findings: ['WATCHDOG COULD NOT COMPLETE'],
  })
  const r = decideHeartbeat({ reportRaw: raw, jobStatus: 'failure', now: NOW })
  assert.equal(r.ping, FAIL, 'a blind watchdog IS the dead-man condition')
  assert.match(r.reason, /no repository has a self-hosted runner/)
})

t('a report that certified no repositories pings /fail - absence is not success', () => {
  const raw = JSON.stringify({ generated_at: new Date(NOW - 20_000).toISOString(), repos_with_runners: null, findings: [], flips: [] })
  assert.equal(decideHeartbeat({ reportRaw: raw, jobStatus: 'success', now: NOW }).ping, FAIL)
})

t('a report with no usable generated_at pings /fail - it cannot be tied to this run', () => {
  const raw = JSON.stringify({ repos_with_runners: 12, findings: [], flips: [] })
  assert.equal(decideHeartbeat({ reportRaw: raw, jobStatus: 'success', now: NOW }).ping, FAIL)
})

t('a STALE report from an earlier run pings /fail - unknown is never up', () => {
  const raw = JSON.stringify({
    generated_at: new Date(NOW - MAX_REPORT_AGE_MS - 60_000).toISOString(),
    repos_with_runners: 12,
    findings: [],
    flips: [],
  })
  const r = decideHeartbeat({ reportRaw: raw, jobStatus: 'success', now: NOW })
  assert.equal(r.ping, FAIL)
  assert.match(r.reason, /previous run/)
})

t('a report a few minutes old is still this run - clock skew must not manufacture a /fail', () => {
  const raw = JSON.stringify({
    generated_at: new Date(NOW - 5 * 60_000).toISOString(),
    repos_with_runners: 12,
    findings: [],
    flips: [],
  })
  assert.equal(decideHeartbeat({ reportRaw: raw, jobStatus: 'success', now: NOW }).ping, UP)
})

t('called with nothing at all it pings /fail rather than throwing', () => {
  assert.equal(decideHeartbeat().ping, FAIL)
})

// ── 3. the wiring: a decision nothing calls is not a fix ──────────────────────────────────────

const WF = readFileSync(new URL('../.github/workflows/ci-runner-watchdog.yml', import.meta.url), 'utf-8')

t('the workflow heartbeat calls the decision script', () => {
  assert.match(WF, /node scripts\/ci-watchdog-heartbeat\.mjs/,
    'the heartbeat step must run the script that decides from the report')
})

t('the workflow no longer pings /fail straight from job.status', () => {
  assert.ok(!/\$\{\{\s*job\.status\s*\}\}"?\s*=\s*"success"/.test(WF),
    'branching the ping on job.status is the whole defect: any finding exits 1 and would ping /fail')
  assert.ok(!/curl[^\n]*HC_PING_CI_WATCHDOG[^\n]*\/fail/.test(WF),
    'no shell branch may still curl the /fail endpoint behind the script')
})

t('the heartbeat step still runs on every outcome', () => {
  const step = WF.slice(WF.indexOf('- name: Heartbeat'))
  assert.match(step, /if:\s*always\(\)/, 'a dead-man that only runs when the job is green is not a dead-man')
})

t('the ping URL reaches the script through the environment, never argv', () => {
  const step = WF.slice(WF.indexOf('- name: Heartbeat'))
  assert.match(step, /HC_PING_URL:\s*\$\{\{\s*secrets\.HC_PING_CI_WATCHDOG\s*\}\}/)
  assert.ok(!/ci-watchdog-heartbeat\.mjs[^\n]*secrets\./.test(step),
    'the ping URL must not be passed as an argument - this repository is public and argv is visible')
})

console.log(`\n${n} assertions passed`)
