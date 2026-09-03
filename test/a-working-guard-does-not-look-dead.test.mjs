/**
 * A GUARD THAT FOUND SOMETHING MUST NOT LOOK LIKE A GUARD THAT DIED.
 *
 * Every assertion here fails against the behaviour it replaces. Until 2026-09-03 three workflows
 * in this repo pinged healthchecks.io on `job.status`, and every guard here exits 1 on ANY
 * finding. So:
 *
 *   * ci-runner-watchdog  was status=down with last_ping six minutes old and 780 pings on the
 *                         clock, over a coverage warning about a repo served by one machine;
 *   * mailer-config-guard was status=down having just successfully emailed Roger that a dormant
 *                         Distribution-OS STAGING environment had grown a mailer;
 *   * ci-cost-guard       carried the same branch, unfired only because it runs weekly.
 *
 * The three halves of the fix are all tested here, because any one alone leaves the fault:
 *   1. the DECISION (decideHeartbeat) - findings are not silence, but a run that could not
 *      certify its population still is;
 *   2. the ESCAPE HATCH - an alert that could NOT be delivered must still ping /fail, because
 *      then healthchecks is the only channel left. That is why the mailer guard's heartbeat was
 *      written, and removing it while removing the noise would have been a regression;
 *   3. the WIRING, for all three workflows - a correct decision function nothing calls is the
 *      shape of miss this repo keeps finding, and a fourth workflow reintroducing the shell
 *      branch must fail this suite.
 *
 * Run: node test/a-working-guard-does-not-look-dead.test.mjs   (exit 0 = all pass)
 */
import assert from 'node:assert'
import { readFileSync, readdirSync } from 'node:fs'
import { decideHeartbeat, GUARDS, MAX_REPORT_AGE_MS, UP, FAIL } from '../scripts/lib/guard-heartbeat.mjs'

let n = 0
const t = (name, fn) => { fn(); n++; console.log(`  ok - ${name}`) }

const NOW = Date.parse('2026-09-03T08:03:04.000Z')
const stampedNow = () => new Date(NOW - 20_000).toISOString()

const watchdogReport = (extra = {}) => JSON.stringify({
  generated_at: stampedNow(), repos_with_runners: 12, flips: [], findings: [], ...extra,
})
const mailerReport = (extra = {}) => JSON.stringify({
  checked_at: stampedNow(), failures: [], warnings: [], rows: [{ product: 'BackOffice', env: 'production' }], ...extra,
})
const budgetReport = (extra = {}) => JSON.stringify({
  checked_at: stampedNow(), window_days: 3, runs_examined: 640, private_runs_examined: 210,
  billed_minutes: 88, api_calls: 900, harness_failures: [], findings: [], ...extra,
})

// ── 1. the incident, for each guard ───────────────────────────────────────────────────────────

t('THE INCIDENT (watchdog): a run that found something and exited 1 still pings UP', () => {
  const r = decideHeartbeat({
    reportRaw: watchdogReport({ findings: ['BoatBuddy: required gate "gate-integration" was CANCELLED, not failed'] }),
    jobStatus: 'failure',
    now: NOW,
  })
  assert.equal(r.ping, UP, 'a finding is the watchdog working, not the watchdog dying')
  assert.match(r.reason, /1 finding/)
})

t('THE INCIDENT (mailer): a staging environment growing a mailer is a finding, not a death', () => {
  const r = decideHeartbeat({
    guard: 'mailer-config-guard',
    reportRaw: mailerReport({ failures: [{ product: 'Distribution-OS', env: 'staging', what: 'a dormant environment has grown a mailer' }] }),
    jobStatus: 'failure',
    alertOutcome: 'success',
    now: NOW,
  })
  assert.equal(r.ping, UP)
  assert.match(r.reason, /examined 1 mailer environment/)
})

t('THE INCIDENT (budget): going over budget is the finding this guard exists to produce', () => {
  const r = decideHeartbeat({
    guard: 'ci-cost-guard',
    reportRaw: budgetReport({ findings: ['BUDGET: 4200 billed minutes in 3 days...'] }),
    jobStatus: 'failure',
    now: NOW,
  })
  assert.equal(r.ping, UP)
  assert.match(r.reason, /swept 640 run\(s\)/)
})

t('a clean run pings UP for every guard', () => {
  assert.equal(decideHeartbeat({ reportRaw: watchdogReport(), jobStatus: 'success', now: NOW }).ping, UP)
  assert.equal(decideHeartbeat({ guard: 'mailer-config-guard', reportRaw: mailerReport(), jobStatus: 'success', now: NOW }).ping, UP)
  assert.equal(decideHeartbeat({ guard: 'ci-cost-guard', reportRaw: budgetReport(), jobStatus: 'success', now: NOW }).ping, UP)
})

t('job.status alone never decides it, in either direction', () => {
  assert.equal(decideHeartbeat({ reportRaw: null, jobStatus: 'success', now: NOW }).ping, FAIL,
    'a green job that wrote no report inspected nothing')
  assert.equal(decideHeartbeat({ reportRaw: watchdogReport({ findings: ['x'] }), jobStatus: 'failure', now: NOW }).ping, UP)
})

// ── 2. the escape hatch: an alert that could not leave ────────────────────────────────────────

t('ESCAPE HATCH: an alert step that FAILED pings /fail even on a perfect report', () => {
  const r = decideHeartbeat({
    guard: 'mailer-config-guard',
    reportRaw: mailerReport({ failures: [{ product: 'ChannelMover', env: 'production', what: 'cannot send' }] }),
    jobStatus: 'failure',
    alertOutcome: 'failure',
    now: NOW,
  })
  assert.equal(r.ping, FAIL, 'if the finding could not be delivered, healthchecks is the only channel left')
  assert.match(r.reason, /could not deliver the finding/)
})

t('the escape hatch outranks everything else, including a clean certified report', () => {
  const r = decideHeartbeat({ reportRaw: watchdogReport(), jobStatus: 'success', alertOutcome: 'failure', now: NOW })
  assert.equal(r.ping, FAIL)
})

t('a SKIPPED alert step is not a delivery failure - there was nothing to deliver', () => {
  assert.equal(decideHeartbeat({ reportRaw: watchdogReport(), jobStatus: 'success', alertOutcome: 'skipped', now: NOW }).ping, UP)
})

t('a SUCCESSFUL alert step is not a delivery failure', () => {
  assert.equal(decideHeartbeat({
    guard: 'mailer-config-guard', reportRaw: mailerReport({ failures: [1] }), jobStatus: 'failure', alertOutcome: 'success', now: NOW,
  }).ping, UP)
})

t('an empty ALERT_STEP_OUTCOME (no such step in the workflow) is not a delivery failure', () => {
  assert.equal(decideHeartbeat({ guard: 'ci-cost-guard', reportRaw: budgetReport(), alertOutcome: '', now: NOW }).ping, UP)
})

// ── 3. what a dead-man is actually for ────────────────────────────────────────────────────────

t('no report at all pings /fail - it died before it inspected anything', () => {
  for (const guard of Object.keys(GUARDS)) {
    const r = decideHeartbeat({ guard, reportRaw: null, jobStatus: 'failure', now: NOW })
    assert.equal(r.ping, FAIL, guard)
    assert.match(r.reason, /never inspected anything/)
    assert.match(r.reason, new RegExp(GUARDS[guard].file.replace('.', '\\.')), 'the reason must name the missing file')
  }
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

t('an unknown guard name pings /fail rather than guessing', () => {
  const r = decideHeartbeat({ guard: 'no-such-guard', reportRaw: watchdogReport(), now: NOW })
  assert.equal(r.ping, FAIL)
  assert.match(r.reason, /no heartbeat spec/)
})

t('watchdog bail() - watchdog_broken - pings /fail, and says which reason', () => {
  const r = decideHeartbeat({
    reportRaw: watchdogReport({ watchdog_broken: true, broken_reason: 'no repository has a self-hosted runner registered', repos_with_runners: null }),
    jobStatus: 'failure',
    now: NOW,
  })
  assert.equal(r.ping, FAIL, 'a blind watchdog IS the dead-man condition')
  assert.match(r.reason, /no repository has a self-hosted runner/)
})

t('budget HARNESS failures ping /fail - the sweep read too little to certify anything', () => {
  const r = decideHeartbeat({
    guard: 'ci-cost-guard',
    reportRaw: budgetReport({ harness_failures: ['HARNESS: the sweep was stopped early because this run hit its own per-run ceiling'] }),
    jobStatus: 'failure',
    now: NOW,
  })
  assert.equal(r.ping, FAIL)
  assert.match(r.reason, /stopped early/)
})

t('budget HARNESS and BUDGET findings together still ping /fail - unknown wins', () => {
  const r = decideHeartbeat({
    guard: 'ci-cost-guard',
    reportRaw: budgetReport({ harness_failures: ['HARNESS: 4 API calls failed'], findings: ['BUDGET: over the ceiling'] }),
    jobStatus: 'failure',
    now: NOW,
  })
  assert.equal(r.ping, FAIL, 'a figure produced from an incomplete sweep certifies nothing')
})

t('a watchdog report that certified no repositories pings /fail - absence is not success', () => {
  assert.equal(decideHeartbeat({ reportRaw: watchdogReport({ repos_with_runners: null }), jobStatus: 'success', now: NOW }).ping, FAIL)
})

t('a mailer report with an EMPTY rows list pings /fail - no failures means no observations', () => {
  const r = decideHeartbeat({ guard: 'mailer-config-guard', reportRaw: mailerReport({ rows: [] }), jobStatus: 'failure', now: NOW })
  assert.equal(r.ping, FAIL, 'the guard itself exits 1 on this, and it writes the report BEFORE that bail')
  assert.match(r.reason, /no observations/)
})

t('a budget report that swept zero runs pings /fail', () => {
  assert.equal(decideHeartbeat({ guard: 'ci-cost-guard', reportRaw: budgetReport({ runs_examined: 0 }), jobStatus: 'success', now: NOW }).ping, FAIL)
})

t('a report with no usable timestamp pings /fail - it cannot be tied to this run', () => {
  assert.equal(decideHeartbeat({ reportRaw: JSON.stringify({ repos_with_runners: 12 }), jobStatus: 'success', now: NOW }).ping, FAIL)
  assert.equal(decideHeartbeat({ guard: 'mailer-config-guard', reportRaw: JSON.stringify({ rows: [1] }), jobStatus: 'success', now: NOW }).ping, FAIL)
})

t('a STALE report from an earlier run pings /fail - unknown is never up', () => {
  const stale = JSON.stringify({
    generated_at: new Date(NOW - MAX_REPORT_AGE_MS - 60_000).toISOString(), repos_with_runners: 12, findings: [], flips: [],
  })
  const r = decideHeartbeat({ reportRaw: stale, jobStatus: 'success', now: NOW })
  assert.equal(r.ping, FAIL)
  assert.match(r.reason, /previous run/)
})

t('a report a few minutes old is still this run - clock skew must not manufacture a /fail', () => {
  const recent = JSON.stringify({
    generated_at: new Date(NOW - 5 * 60_000).toISOString(), repos_with_runners: 12, findings: [], flips: [],
  })
  assert.equal(decideHeartbeat({ reportRaw: recent, jobStatus: 'success', now: NOW }).ping, UP)
})

t('called with nothing at all it pings /fail rather than throwing', () => {
  assert.equal(decideHeartbeat().ping, FAIL)
})

// ── 4. the wiring, for every workflow that has one of these heartbeats ────────────────────────

const read = (p) => readFileSync(new URL(`../.github/workflows/${p}`, import.meta.url), 'utf-8')

const WIRED = [
  { file: 'ci-runner-watchdog.yml', guard: 'ci-runner-watchdog', secret: 'HC_PING_CI_WATCHDOG', alertStep: true },
  { file: 'mailer-config-check.yml', guard: 'mailer-config-guard', secret: 'HC_PING_MAILER_GUARD', alertStep: true },
  { file: 'ci-budget-check.yml', guard: 'ci-cost-guard', secret: 'HC_PING_CI_BUDGET', alertStep: false },
]

for (const w of WIRED) {
  const wf = read(w.file)
  const step = wf.slice(wf.indexOf('- name: Heartbeat'))

  t(`${w.file}: the heartbeat calls the shared decision script`, () => {
    assert.match(step, /node scripts\/guard-heartbeat\.mjs/)
    assert.match(step, new RegExp(`HEARTBEAT_GUARD:\\s*${w.guard}`), 'it must name which guard it is reporting for')
    assert.ok(Object.hasOwn(GUARDS, w.guard), `GUARDS must carry a spec for ${w.guard}`)
  })

  t(`${w.file}: no shell branch still pings /fail straight from job.status`, () => {
    assert.ok(!/\$\{\{\s*job\.status\s*\}\}"?\s*=\s*"success"/.test(wf),
      'branching the ping on job.status is the whole defect: any finding exits 1 and would ping /fail')
    assert.ok(!new RegExp(`curl[^\\n]*${w.secret}[^\\n]*\\/fail`).test(wf),
      'no shell branch may still curl the /fail endpoint behind the script')
  })

  t(`${w.file}: the heartbeat still runs on every outcome`, () => {
    assert.match(step, /if:\s*always\(\)/, 'a dead-man that only runs when the job is green is not a dead-man')
  })

  t(`${w.file}: the ping URL reaches the script through the environment, never argv`, () => {
    assert.match(step, new RegExp(`HC_PING_URL:\\s*\\$\\{\\{\\s*secrets\\.${w.secret}\\s*\\}\\}`))
    assert.ok(!/guard-heartbeat\.mjs[^\n]*secrets\./.test(step),
      'the ping URL must not be passed as an argument - this repository is public and argv is visible')
  })

  if (w.alertStep) {
    t(`${w.file}: the alert step is identified and its outcome reaches the heartbeat`, () => {
      assert.match(wf, /^\s+id: alert$/m, 'the escape hatch needs the alert step to have an id')
      assert.match(step, /ALERT_STEP_OUTCOME:\s*\$\{\{\s*steps\.alert\.outcome\s*\}\}/,
        'without this, an alert that could not be delivered would report the run as healthy')
    })
  }
}

t('monitor.yml is deliberately left alone - its if: success() heartbeat is a decision, not this bug', () => {
  const wf = read('monitor.yml')
  assert.ok(!/node scripts\/guard-heartbeat\.mjs/.test(wf),
    'monitor.yml documents why three consecutive red hourly runs SHOULD trip its check; do not "fix" it')
})

t('every workflow that curls a healthchecks ping URL is either wired here or monitor.yml', () => {
  // The regression catch: a fourth guard added with the old shell branch must fail this suite.
  const dir = new URL('../.github/workflows/', import.meta.url)
  const offenders = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.yml')) continue
    const wf = readFileSync(new URL(f, dir), 'utf-8')
    if (!/HC_PING_/.test(wf)) continue
    const wired = WIRED.some((w) => w.file === f)
    if (wired || f === 'monitor.yml') continue
    offenders.push(f)
  }
  assert.deepEqual(offenders, [],
    `these workflows ping healthchecks but are not covered by the shared heartbeat: ${offenders.join(', ')}`)
})

console.log(`\n${n} assertions passed`)
