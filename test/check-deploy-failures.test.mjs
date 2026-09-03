/**
 * Unit tests for the "a deploy pipeline went red" producer.
 *
 * Almost every assertion here exists to stop a pager misbehaving in one of two directions:
 * ringing for something that is fine (a gate rejection, a staging blip, one commit that broke
 * five repos) or staying silent for something that is not (a workflow file so broken that the run
 * has no jobs to inspect). The second one is the reason the script exists at all.
 *
 * Run: node test/check-deploy-failures.test.mjs   (exit 0 = all pass)
 */
import assert from 'node:assert'
import {
  isDeployWorkflow, isProductionWorkflow, currentFailures, classifyFailure, isAlarm, isUnreadableFile,
  signalFor, planSignals, recoveredKeys, ROLLUP_KEY, ROLLUP_THRESHOLD, observedLaneKeys, deployKey,
  redForHours, STAGING_STUCK_HOURS,
} from '../scripts/check-deploy-failures.mjs'

let n = 0
const t = (name, fn) => { fn(); n++; console.log(`  ok - ${name}`) }

const run = (o = {}) => ({
  id: 1, path: '.github/workflows/deploy.yml', status: 'completed', conclusion: 'failure',
  event: 'push', head_sha: 'abc123', created_at: '2026-08-31T12:33:30Z',
  html_url: 'https://github.com/x/y/actions/runs/1', ...o,
})

// ── which files are deploy files ──────────────────────────────────────────────
t('deploy.yml and deploy-staging.yml are both deploy workflows', () => {
  assert.equal(isDeployWorkflow('.github/workflows/deploy.yml'), true)
  assert.equal(isDeployWorkflow('.github/workflows/deploy-staging.yml'), true)
  assert.equal(isDeployWorkflow('.github/workflows/deploy-edge-functions.yml'), true)
})

t('a test or lint workflow is not a deploy workflow', () => {
  assert.equal(isDeployWorkflow('.github/workflows/test.yml'), false)
  assert.equal(isDeployWorkflow('.github/workflows/gitleaks.yml'), false)
  assert.equal(isDeployWorkflow(undefined), false)
})

t('only the non-staging deploy file ships production', () => {
  assert.equal(isProductionWorkflow('.github/workflows/deploy.yml'), true)
  assert.equal(isProductionWorkflow('.github/workflows/deploy-staging.yml'), false)
})

// ── what is CURRENTLY red ─────────────────────────────────────────────────────
t('a failure with a newer green run after it is history, not an outage', () => {
  const red = currentFailures([
    run({ id: 2, conclusion: 'success', created_at: '2026-08-31T14:00:00Z' }),
    run({ id: 1, conclusion: 'failure', created_at: '2026-08-31T12:33:30Z' }),
  ])
  assert.equal(red.length, 0)
})

t('the newest completed run being red IS an outage', () => {
  const red = currentFailures([
    run({ id: 2, conclusion: 'failure', created_at: '2026-08-31T14:00:00Z' }),
    run({ id: 1, conclusion: 'success', created_at: '2026-08-31T12:33:30Z' }),
  ])
  assert.equal(red.length, 1)
  assert.equal(red[0].id, 2)
})

t('a run still in progress does NOT mask the older failure underneath it', () => {
  // A deploy running right now says nothing about whether the last one worked. Letting it count
  // as the newest result is how a permanently red pipeline reads as healthy on a busy repo.
  const red = currentFailures([
    run({ id: 3, status: 'in_progress', conclusion: null, created_at: '2026-08-31T15:00:00Z' }),
    run({ id: 2, conclusion: 'failure', created_at: '2026-08-31T14:00:00Z' }),
  ])
  assert.equal(red.length, 1)
  assert.equal(red[0].id, 2)
})

t('staging and production are judged separately, not as one pipeline', () => {
  const red = currentFailures([
    run({ id: 5, path: '.github/workflows/deploy-staging.yml', conclusion: 'success', created_at: '2026-08-31T15:00:00Z' }),
    run({ id: 4, path: '.github/workflows/deploy.yml', conclusion: 'failure', created_at: '2026-08-31T14:00:00Z' }),
  ])
  assert.equal(red.length, 1)
  assert.equal(red[0].path, '.github/workflows/deploy.yml')
})

t('a cancelled run is not a failure - somebody stopped it on purpose', () => {
  assert.equal(currentFailures([run({ conclusion: 'cancelled' })]).length, 0)
})

t('a non-deploy workflow going red is not this producer\'s business', () => {
  assert.equal(currentFailures([run({ path: '.github/workflows/test.yml' })]).length, 0)
})

// ── the ScoutCopilot shape: a run with NO jobs ────────────────────────────────
t('ZERO jobs means the deploy file itself is broken, and it is named as such', () => {
  // Run 33392350776, ScoutCopilot, red for 23 hours on 2026-08-31 with total_count 0. A watcher
  // that walks jobs looking for a failed step finds nothing here and reports nothing.
  const c = classifyFailure(run(), { total_count: 0, jobs: [] })
  assert.equal(c.kind, 'workflow-file')
  assert.match(c.why, /never started a single step/)
})

t('an explicit startup_failure conclusion is the same fault', () => {
  const c = classifyFailure(run({ conclusion: 'startup_failure' }), { total_count: 0, jobs: [] })
  assert.equal(c.kind, 'workflow-file')
})

t('the broken-file signal says nothing can ship, and it pages', () => {
  const s = signalFor({ product: 'ScoutCopilot', run: run(), classification: classifyFailure(run(), { total_count: 0, jobs: [] }) })
  assert.match(s.title, /the deploy file is broken, nothing can ship/)
  assert.equal(s.severity, 'critical')
  assert.equal(s.needs_human, true)
})

// ── a normal failed step ──────────────────────────────────────────────────────
t('a failed step is named by job and step', () => {
  const c = classifyFailure(run(), {
    total_count: 2,
    jobs: [
      { name: 'gate-security', conclusion: 'success', steps: [] },
      { name: 'deploy', conclusion: 'failure', steps: [{ name: 'Upload via FTP', conclusion: 'failure' }] },
    ],
  })
  assert.equal(c.kind, 'failed-step')
  assert.equal(c.job, 'deploy')
  assert.equal(c.step, 'Upload via FTP')
})

t('a job that fails without a failing step still names the job', () => {
  const c = classifyFailure(run(), { total_count: 1, jobs: [{ name: 'deploy', conclusion: 'failure', steps: [] }] })
  assert.equal(c.kind, 'failed-step')
  assert.equal(c.job, 'deploy')
  assert.equal(c.step, null)
})

// ── the gate doing its job is NOT an outage ───────────────────────────────────
t('a promotion the staging gate refused is not an alarm', () => {
  // Production is unchanged and healthy. The Deploy Status page already renders this calm; a
  // pager that rings for it is a pager that rings every time the safety gate works.
  const c = classifyFailure(run({ event: 'workflow_dispatch' }), {
    total_count: 1,
    jobs: [{ name: 'deploy', conclusion: 'failure', steps: [{ name: 'Verify staging gate', conclusion: 'failure' }] }],
  })
  assert.equal(c.kind, 'gate-rejection')
  assert.equal(isAlarm(c), false)
})

t('the SAME step failing on a push is still a real failure', () => {
  // Only a manual promotion can be a gate rejection. On a push it means the pipeline is broken.
  const c = classifyFailure(run({ event: 'push' }), {
    total_count: 1,
    jobs: [{ name: 'deploy', conclusion: 'failure', steps: [{ name: 'Verify staging gate', conclusion: 'failure' }] }],
  })
  assert.equal(c.kind, 'failed-step')
  assert.equal(isAlarm(c), true)
})

t('THE LIVE SHAPE: an earlier gate fails and the prod deploy is SKIPPED - production untouched', () => {
  // The real shape this fleet produces, and the one the original step-name-only carve-out missed.
  // Verified live 2026-09-01: ReplyFlow run 33509332674, SignalScore 33509336490, Valrano
  // 33509341053 - workflow_dispatch on deploy.yml, gate-e2e=failure, deploy=skipped, prod healthy.
  const c = classifyFailure(run({ event: 'workflow_dispatch', path: '.github/workflows/deploy.yml' }), {
    total_count: 6,
    jobs: [
      { name: 'gate-security', conclusion: 'success', steps: [] },
      { name: 'gate-e2e', conclusion: 'failure', steps: [{ name: 'Run staging E2E tests', conclusion: 'failure' }] },
      { name: 'deploy-staging', conclusion: 'skipped', steps: [] },
      { name: 'deploy-fast', conclusion: 'skipped', steps: [] },
      { name: 'deploy', conclusion: 'skipped', steps: [] },
      { name: 'prod-smoke', conclusion: 'skipped', steps: [] },
    ],
  })
  assert.equal(c.kind, 'gate-rejection')
  assert.equal(isAlarm(c), false)
})

t('a scheduled gate failure that never reached a deploy is not an alarm either', () => {
  // A nightly gate run deploys nothing; a red gate there is not a "production is failing" page.
  const c = classifyFailure(run({ event: 'schedule', path: '.github/workflows/deploy.yml' }), {
    total_count: 3,
    jobs: [
      { name: 'gate-e2e', conclusion: 'failure', steps: [{ name: 'Run staging E2E tests', conclusion: 'failure' }] },
      { name: 'deploy', conclusion: 'skipped', steps: [] },
      { name: 'deploy-staging', conclusion: 'skipped', steps: [] },
    ],
  })
  assert.equal(c.kind, 'gate-rejection')
  assert.equal(isAlarm(c), false)
})

// ── production-vs-staging comes from the JOB, not the file name ────────────────
t('a red deploy-staging JOB inside deploy.yml is filed as STAGING, not production', () => {
  // deploy.yml holds both lanes; a push failing the staging deploy job must not page as production.
  const r = run({ event: 'push', path: '.github/workflows/deploy.yml' })
  const c = classifyFailure(r, { total_count: 1, jobs: [{ name: 'deploy-staging', conclusion: 'failure', steps: [] }] })
  // Pinned to a clock just after the run, because since 2026-09-03 a staging pipeline that stays
  // red past STAGING_STUCK_HOURS DOES escalate - a product that cannot ship is a human's problem
  // even while production is untouched. This case is about which LANE the failure is filed under,
  // which is unchanged; the stuck case has its own tests at the bottom of this file.
  const now = new Date('2026-08-31T13:00:00Z')
  const s = signalFor({ product: 'ReplyFlow', run: r, classification: c, now })
  assert.equal(s.severity, 'warning')
  assert.equal(s.needs_human, false)
  assert.match(s.title, /staging deploy is failing/)
  assert.match(s.key, /:staging$/)
})

t('the production deploy JOB failing in deploy.yml pages, and keeps the historical key', () => {
  const r = run({ event: 'workflow_dispatch', path: '.github/workflows/deploy.yml' })
  const c = classifyFailure(r, { total_count: 1, jobs: [{ name: 'deploy', conclusion: 'failure', steps: [{ name: 'Deploy via FTP', conclusion: 'failure' }] }] })
  const s = signalFor({ product: 'ReplyFlow', run: r, classification: c })
  assert.equal(s.severity, 'critical')
  assert.equal(s.needs_human, true)
  assert.equal(s.key, 'ReplyFlow:.github/workflows/deploy.yml')
})

t('a green staging PUSH does not erase a red production DISPATCH of the same deploy.yml', () => {
  // The latent second half of the bug: currentFailures used to keep only the newest run per path,
  // so a green push after a red promotion made the production failure vanish and self-resolve.
  const red = currentFailures([
    run({ id: 9, event: 'push', conclusion: 'success', created_at: '2026-09-01T15:00:00Z' }),
    run({ id: 8, event: 'workflow_dispatch', conclusion: 'failure', created_at: '2026-09-01T14:00:00Z' }),
  ])
  assert.equal(red.length, 1)
  assert.equal(red[0].id, 8)
  assert.equal(red[0].event, 'workflow_dispatch')
})

t('a run GitHub could not parse is recognised from its metadata alone', () => {
  // GitHub titles a run by the file PATH when it cannot read the file's `name:` key.
  assert.equal(isUnreadableFile(run({ name: '.github/workflows/deploy.yml' })), true)
  assert.equal(isUnreadableFile(run({ conclusion: 'startup_failure', name: 'Deploy to Production' })), true)
  assert.equal(isUnreadableFile(run({ name: 'Deploy to Production' })), false)
})

t('a fixed deploy FILE stops being red once any lane of it goes green again', () => {
  // ScoutCopilot, live 2026-09-01. deploy.yml is workflow_dispatch-only, so the only push runs are
  // the ones GitHub manufactured because the file was unparseable. Once the file is fixed no push
  // can ever create a deploy.yml run again, so without this the staging lane is red forever.
  const red = currentFailures([
    run({ id: 9, event: 'workflow_dispatch', conclusion: 'success', name: 'Deploy to Production',
          created_at: '2026-09-01T14:51:49Z' }),
    run({ id: 8, event: 'push', conclusion: 'failure', name: '.github/workflows/deploy.yml',
          created_at: '2026-08-31T12:33:30Z' }),
  ])
  assert.equal(red.length, 0)
})

t('an OLDER success does not forgive a NEWER broken file', () => {
  const red = currentFailures([
    run({ id: 9, event: 'workflow_dispatch', conclusion: 'success', name: 'Deploy to Production',
          created_at: '2026-08-27T13:29:27Z' }),
    run({ id: 8, event: 'push', conclusion: 'failure', name: '.github/workflows/deploy.yml',
          created_at: '2026-08-31T12:33:30Z' }),
  ])
  assert.equal(red.length, 1)
  assert.equal(red[0].id, 8)
})

t('the broken-file carve-out does NOT reopen the lane-erasure bug', () => {
  // Same shape as the lane test above, but with a REAL staging failure (readable file, so it has a
  // proper workflow name). A later green production dispatch must NOT clear it.
  const red = currentFailures([
    run({ id: 9, event: 'workflow_dispatch', conclusion: 'success', name: 'Deploy to Production',
          created_at: '2026-09-01T15:00:00Z' }),
    run({ id: 8, event: 'push', conclusion: 'failure', name: 'Deploy to Production',
          created_at: '2026-09-01T14:00:00Z' }),
  ])
  assert.equal(red.length, 1)
  assert.equal(red[0].id, 8)
})

t('every other failure IS an alarm', () => {
  assert.equal(isAlarm({ kind: 'workflow-file' }), true)
  assert.equal(isAlarm({ kind: 'failed-step' }), true)
  assert.equal(isAlarm({ kind: 'unknown' }), true)
})

// ── staging red is filed quietly AT FIRST, and rung once it is clearly stuck ──
// CHANGED 2026-09-03. This used to read "staging red is filed, not rung", full stop, and that is
// why ChannelMover sat red from 13:43 until Roger found it himself and asked "will you see it and
// try to fix it yourself." Production being untouched is not the same as the product being able
// to ship. Fresh stays quiet so nobody mid-repair is paged at; stuck rings.
t('a FRESH red staging deploy is visible but does not page', () => {
  const r = run({ path: '.github/workflows/deploy-staging.yml', created_at: '2026-08-31T12:33:30Z' })
  const now = new Date('2026-08-31T13:20:00Z') // 0.8h
  const s = signalFor({ product: 'ReplyFlow', run: r, classification: classifyFailure(r, { total_count: 1, jobs: [{ name: 'deploy-staging', conclusion: 'failure', steps: [] }] }), now })
  assert.equal(s.severity, 'warning')
  assert.equal(s.needs_human, false)
  assert.match(s.title, /staging deploy is failing/)
})

t('the SAME red staging deploy pages once it has been red too long', () => {
  const r = run({ path: '.github/workflows/deploy-staging.yml', created_at: '2026-08-31T12:33:30Z' })
  const now = new Date('2026-08-31T18:00:00Z') // 5.4h
  const s = signalFor({ product: 'ReplyFlow', run: r, classification: classifyFailure(r, { total_count: 1, jobs: [{ name: 'deploy-staging', conclusion: 'failure', steps: [] }] }), now })
  assert.equal(s.severity, 'critical')
  assert.equal(s.needs_human, true)
  assert.match(s.title, /cannot ship at all/)
})

t('a red PRODUCTION deploy pages', () => {
  const s = signalFor({ product: 'ReplyFlow', run: run(), classification: classifyFailure(run(), { total_count: 1, jobs: [{ name: 'deploy', conclusion: 'failure', steps: [] }] }) })
  assert.equal(s.severity, 'critical')
  assert.equal(s.needs_human, true)
})

t('the signal carries the run link, so the log is one click away', () => {
  const s = signalFor({ product: 'X', run: run(), classification: { kind: 'unknown', why: 'x' } })
  assert.equal(s.link, 'https://github.com/x/y/actions/runs/1')
  assert.equal(s.detail.run_id, 1)
})

// ── one cause is one alert ────────────────────────────────────────────────────
const prodFailure = (product, id) => ({
  product,
  run: run({ id, path: '.github/workflows/deploy.yml' }),
  classification: { kind: 'workflow-file', job: null, step: null, why: 'broken' },
})

t('below the threshold, each red pipeline may ring on its own', () => {
  const { rollup, members } = planSignals([prodFailure('A', 1), prodFailure('B', 2)])
  assert.equal(rollup, null)
  assert.equal(members.length, 2)
  assert.ok(members.every((m) => m.needs_human === true))
})

t('at the threshold, ONE rollup rings and the members are demoted to board-only', () => {
  // 2026-08-31: one commit ("lftp -f cannot combine with -u/URL") went out across the fleet at
  // once. Five pages for one bad commit is how a pager gets muted.
  const { rollup, members } = planSignals([prodFailure('A', 1), prodFailure('B', 2), prodFailure('C', 3)])
  assert.ok(rollup)
  assert.equal(rollup.key, ROLLUP_KEY)
  assert.equal(rollup.severity, 'critical')
  assert.match(rollup.title, /3 products cannot deploy to production/)
  assert.match(rollup.summary, /A, B, C/)
  assert.equal(members.length, 3)
  assert.ok(members.every((m) => m.needs_human === false && m.severity === 'warning'))
})

t('the threshold is what the constant says, not a number written twice', () => {
  const many = Array.from({ length: ROLLUP_THRESHOLD }, (_, i) => prodFailure(`P${i}`, i))
  assert.ok(planSignals(many).rollup)
  assert.equal(planSignals(many.slice(0, ROLLUP_THRESHOLD - 1)).rollup, null)
})

const stagingFailure = (p, id, createdAt = '2026-08-31T12:33:30Z') => ({
  product: p,
  run: run({ id, path: '.github/workflows/deploy-staging.yml', created_at: createdAt }),
  classification: { kind: 'failed-step', job: 'deploy-staging', step: 'e2e', why: 'x' },
})

t('FRESH staging failures never count toward the rollup', () => {
  // They cannot page on their own, so counting them would roll up a set that was never going to
  // ring and silence the one production row that was.
  const now = new Date('2026-08-31T13:20:00Z') // 0.8h - everyone still inside the threshold
  const { rollup, members } = planSignals(
    [stagingFailure('A', 1), stagingFailure('B', 2), stagingFailure('C', 3), prodFailure('D', 4)], now)
  assert.equal(rollup, null, 'three FRESH staging failures plus one production failure is not a fleet outage')
  assert.equal(members.filter((m) => m.needs_human).length, 1)
})

t('but three products STUCK unable to ship IS a fleet condition, and rolls up as one alert', () => {
  // Added 2026-09-03 with the stuck-staging escalation. Once a staging pipeline can page, it must
  // also be able to join the rollup - otherwise the whole fleet could be unable to ship and file
  // three separate rows that each look like somebody else's small problem.
  const now = new Date('2026-08-31T18:00:00Z') // 5.4h - all three clearly abandoned
  const { rollup, members } = planSignals(
    [stagingFailure('A', 1), stagingFailure('B', 2), stagingFailure('C', 3)], now)
  assert.ok(rollup, 'three products that cannot ship is one fleet alert')
  assert.equal(members.filter((m) => m.needs_human).length, 0, 'members are demoted under the rollup')
})

// ── recovery ──────────────────────────────────────────────────────────────────
t('a pipeline that went green resolves its own row', () => {
  const got = recoveredKeys({
    openKeys: new Set(['A:deploy.yml', 'B:deploy.yml']),
    judgedKeys: new Set(['A:deploy.yml', 'B:deploy.yml']),
    redKeys: new Set(['B:deploy.yml']),
  })
  assert.deepEqual(got, ['A:deploy.yml'])
})

t('a row this run never judged is left completely alone', () => {
  // The 2026-08-30 lesson from the healthchecks producer: resolving "everything under this source
  // that is not red" erased root-cause rows that could never have appeared in the red set.
  const got = recoveredKeys({
    openKeys: new Set(['A:deploy.yml', 'some-diagnosis-row']),
    judgedKeys: new Set(['A:deploy.yml']),
    redKeys: new Set(),
  })
  assert.deepEqual(got, ['A:deploy.yml'])
})

t('the rollup is never resolved by the per-pipeline recovery loop', () => {
  const got = recoveredKeys({
    openKeys: new Set([ROLLUP_KEY]),
    judgedKeys: new Set([ROLLUP_KEY]),
    redKeys: new Set(),
  })
  assert.deepEqual(got, [])
})

t('a green NIGHTLY SCHEDULED run does not clear a red production DISPATCH', () => {
  // 2026-09-01 board finding. Every deploy.yml here gates its production job on
  // `if: github.event_name == 'workflow_dispatch'`, so the nightly cron runs the gates, SKIPS the
  // deploy, ships nothing - and still concludes green. Filed in the production lane it became the
  // newest result there and erased the red dispatch on the ~04:50Z cron, every night, silently.
  const red = currentFailures([
    run({ id: 11, event: 'schedule', conclusion: 'success', created_at: '2026-09-02T04:50:00Z' }),
    run({ id: 10, event: 'workflow_dispatch', conclusion: 'failure', created_at: '2026-09-01T14:00:00Z' }),
  ])
  assert.equal(red.length, 1, 'a run that deployed nothing must not clear a real production failure')
  assert.equal(red[0].id, 10)
  assert.equal(red[0].event, 'workflow_dispatch')
})

t('a red nightly scheduled run is still visible in its own lane', () => {
  const red = currentFailures([
    run({ id: 13, event: 'schedule', conclusion: 'failure', created_at: '2026-09-02T04:50:00Z' }),
    run({ id: 12, event: 'workflow_dispatch', conclusion: 'success', created_at: '2026-09-01T14:00:00Z' }),
  ])
  assert.equal(red.length, 1, 'its own lane means a broken nightly gate is not swallowed either')
  assert.equal(red[0].id, 13)
})

t('only the lanes a repo actually RAN may be resolved by a recovery', () => {
  // Adding both lane keys for every deploy file let a production row be resolved by a repo whose
  // runs were all staging pushes: nothing looked at production, and the row cleared anyway.
  const stagingOnly = observedLaneKeys('ScoutCopilot', [
    run({ id: 20, event: 'push', conclusion: 'success', created_at: '2026-09-02T09:00:00Z' }),
  ])
  assert.ok(stagingOnly.has(deployKey('ScoutCopilot', '.github/workflows/deploy.yml', false)))
  assert.ok(!stagingOnly.has(deployKey('ScoutCopilot', '.github/workflows/deploy.yml', true)),
    'no production run was observed, so no production verdict may be claimed')

  const both = observedLaneKeys('ScoutCopilot', [
    run({ id: 21, event: 'push', conclusion: 'success', created_at: '2026-09-02T09:00:00Z' }),
    run({ id: 22, event: 'workflow_dispatch', conclusion: 'success', created_at: '2026-09-02T10:00:00Z' }),
  ])
  assert.ok(both.has(deployKey('ScoutCopilot', '.github/workflows/deploy.yml', true)))
  assert.ok(both.has(deployKey('ScoutCopilot', '.github/workflows/deploy.yml', false)))
})

t('a scheduled run certifies only ITSELF - never staging, never production', () => {
  const path = '.github/workflows/deploy.yml'
  const keys = observedLaneKeys('ReplyFlow', [
    run({ id: 23, event: 'schedule', conclusion: 'success', created_at: '2026-09-02T04:50:00Z' }),
  ])
  assert.ok(!keys.has(deployKey('ReplyFlow', path, true)), 'a green nightly gate must not resolve a production row')
  assert.ok(!keys.has(deployKey('ReplyFlow', path, false)), 'nor a staging row')
  assert.ok(keys.has(deployKey('ReplyFlow', path, false, 'scheduled')), 'but it must be able to clear its own')
})

t('EVERY ROW THE NIGHTLY LANE FILES IS A ROW IT CAN CLEAR', () => {
  // The regression the first version of this fix introduced: the scheduled lane got its own lane
  // for the newest-red decision but no key of its own, so a red nightly run filed under the
  // PRODUCTION key - which only a manual production dispatch could ever resolve. Production
  // promotions here are rare, so the row would have sat open indefinitely, paging.
  const scheduled = run({ id: 24, event: 'schedule', conclusion: 'failure', created_at: '2026-09-02T04:50:00Z' })
  const sig = signalFor({
    product: 'ReplyFlow', run: scheduled,
    classification: { kind: 'job', job: 'gate-e2e', step: null, why: 'it failed.' },
  })
  const clearable = observedLaneKeys('ReplyFlow', [scheduled])
  assert.ok(clearable.has(sig.key), `the nightly lane filed ${sig.key} but cannot clear it`)
  assert.notEqual(sig.key, deployKey('ReplyFlow', scheduled.path, true), 'it must not take the production key')
  assert.equal(sig.needs_human, false, 'a run that deploys nothing must not page as a production outage')
  assert.equal(sig.severity, 'warning')
  assert.match(sig.title, /nightly/i)
})

t('a broken deploy FILE found by the nightly run still cannot claim the production key', () => {
  // classifyFailure marks the zero-job shape production:true. That must not put a scheduled run
  // back on the production key by the back door.
  const scheduled = run({ id: 25, event: 'schedule', conclusion: 'failure', created_at: '2026-09-02T04:50:00Z' })
  const sig = signalFor({
    product: 'ReplyFlow', run: scheduled,
    classification: { kind: 'workflow-file', job: null, step: null, production: true, why: 'the file is broken.' },
  })
  assert.ok(observedLaneKeys('ReplyFlow', [scheduled]).has(sig.key))
  assert.notEqual(sig.key, deployKey('ReplyFlow', scheduled.path, true))
})

console.log(`\n${n} assertions passed.`)

// ── A STAGING PIPELINE STUCK RED MUST REACH A HUMAN ─────────────────────────────────────────────
// The regression these exist for: on 2026-09-03 ChannelMover's staging went red at 13:43 and this
// watcher SAW it, filed the row, and printed "not paging (not-eligible)" - because needs_human was
// `production`, full stop. It could have stayed red for a week without telling anyone. Roger found
// it himself and asked the only question that matters: "will you see it and try to fix it
// yourself." Production being untouched is not the same as the product being able to ship.
t('THE ONE ROGER FOUND HIMSELF: staging red past the threshold pages, and says it cannot ship', () => {
  const now = new Date('2026-09-03T17:00:00Z')
  const r = { ...run(), created_at: '2026-09-03T11:43:00Z' } // 5.3h red
  const c = classifyFailure(r, { total_count: 1, jobs: [{ name: 'deploy-staging', conclusion: 'failure', steps: [] }] })
  const s = signalFor({ product: 'ChannelMover', run: r, classification: c, now })
  assert.equal(s.needs_human, true, 'must page')
  assert.equal(s.severity, 'critical')
  assert.match(s.title, /cannot ship at all/)
  assert.match(s.title, /5\.3h/)
})

t('a staging failure INSIDE the threshold still does not page - no crying wolf mid-repair', () => {
  const now = new Date('2026-09-03T12:30:00Z')
  const r = { ...run(), created_at: '2026-09-03T11:43:00Z' } // 0.8h
  const c = classifyFailure(r, { total_count: 1, jobs: [{ name: 'deploy-staging', conclusion: 'failure', steps: [] }] })
  const s = signalFor({ product: 'ChannelMover', run: r, classification: c, now })
  assert.equal(s.needs_human, false, 'an agent mid-fix must not be paged at')
  assert.equal(s.severity, 'warning')
})

t('AN UNREADABLE AGE PAGES rather than qualifying as fresh', () => {
  // The quiet path is how a thing sits forever.
  for (const bad of [null, undefined, '', 'not a date']) {
    const r = { ...run(), created_at: bad }
    const c = classifyFailure(r, { total_count: 1, jobs: [{ name: 'deploy-staging', conclusion: 'failure', steps: [] }] })
    const s = signalFor({ product: 'X', run: r, classification: c, now: new Date('2026-09-03T17:00:00Z') })
    assert.equal(s.needs_human, true, `created_at=${String(bad)} must escalate`)
    assert.match(s.title, /unknown length of time/)
  }
})

t('a PRODUCTION failure still pages immediately, at any age', () => {
  const now = new Date('2026-09-03T11:44:00Z')
  const r = { ...run(), created_at: '2026-09-03T11:43:00Z' } // 1 minute old
  const c = classifyFailure(r, { total_count: 1, jobs: [{ name: 'deploy', conclusion: 'failure', steps: [] }] })
  const s = signalFor({ product: 'X', run: r, classification: c, now })
  assert.equal(s.needs_human, true)
  assert.equal(s.severity, 'critical')
})

t('the escalation is time-based, so the SAME red run flips once it has sat long enough', () => {
  const r = { ...run(), created_at: '2026-09-03T11:43:00Z' }
  const c = classifyFailure(r, { total_count: 1, jobs: [{ name: 'deploy-staging', conclusion: 'failure', steps: [] }] })
  const early = signalFor({ product: 'X', run: r, classification: c, now: new Date('2026-09-03T13:00:00Z') })
  const late = signalFor({ product: 'X', run: r, classification: c, now: new Date('2026-09-03T15:00:00Z') })
  assert.equal(early.needs_human, false, '1.3h — still somebody\'s live work')
  assert.equal(late.needs_human, true, '3.3h — nobody is on it')
})

t('redForHours measures from the run, and refuses to guess', () => {
  assert.equal(redForHours({ created_at: '2026-09-03T09:00:00Z' }, new Date('2026-09-03T12:00:00Z')), 3)
  assert.equal(redForHours({ created_at: 'rubbish' }, new Date()), null)
  assert.equal(redForHours({}, new Date()), null)
})
