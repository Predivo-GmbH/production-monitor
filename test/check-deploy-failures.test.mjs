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
  isDeployWorkflow, isProductionWorkflow, currentFailures, classifyFailure, isAlarm,
  signalFor, planSignals, recoveredKeys, ROLLUP_KEY, ROLLUP_THRESHOLD,
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
  const s = signalFor({ product: 'ReplyFlow', run: r, classification: c })
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

t('every other failure IS an alarm', () => {
  assert.equal(isAlarm({ kind: 'workflow-file' }), true)
  assert.equal(isAlarm({ kind: 'failed-step' }), true)
  assert.equal(isAlarm({ kind: 'unknown' }), true)
})

// ── staging red is filed, not rung ────────────────────────────────────────────
t('a red STAGING deploy is visible but does not page', () => {
  const r = run({ path: '.github/workflows/deploy-staging.yml' })
  const s = signalFor({ product: 'ReplyFlow', run: r, classification: classifyFailure(r, { total_count: 1, jobs: [{ name: 'deploy-staging', conclusion: 'failure', steps: [] }] }) })
  assert.equal(s.severity, 'warning')
  assert.equal(s.needs_human, false)
  assert.match(s.title, /staging deploy is failing/)
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

t('staging failures never count toward the rollup', () => {
  // They cannot page on their own, so counting them would roll up a set that was never going to
  // ring and silence the one production row that was.
  const staging = (p, id) => ({
    product: p,
    run: run({ id, path: '.github/workflows/deploy-staging.yml' }),
    classification: { kind: 'failed-step', job: 'deploy-staging', step: 'e2e', why: 'x' },
  })
  const { rollup, members } = planSignals([staging('A', 1), staging('B', 2), staging('C', 3), prodFailure('D', 4)])
  assert.equal(rollup, null, 'three staging failures plus one production failure is not a fleet outage')
  assert.equal(members.filter((m) => m.needs_human).length, 1)
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

console.log(`\n${n} assertions passed.`)
