// Regression for monitor run 33810988565 (2026-09-03 22:19Z).
//
// The SAME sweep read backoffice fine at 22:04:58Z ("5 commit(s) have been waiting to go live for
// 33.5h") and called it UNREADABLE at 22:19:57Z, which exits 1 and reds the hourly monitor and
// mails Roger. Nothing about backoffice changed in those fifteen minutes.
//
// It searched ONE page of 30 runs of the whole repo. backoffice fires Sync Outreach, Secret Scan,
// Outreach IMAP Poll, edge-function deploys and staging gates continuously, so at 22:19 those 30
// runs reached back only to 17:47:42Z — and the last successful production `deploy` job was run
// 33786226567 at 17:43:23Z (sha 6f35d6c). It missed by FOUR MINUTES.
//
// The shapes below are the real ones measured that day: in a `Deploy` run triggered by a staging
// push the `deploy` job EXISTS and is SKIPPED (verified on runs 33800039519 / 33797511598 /
// 33793868640), while `deploy-staging` succeeds. So the one event being searched for is the rarest
// run in the repo, and a window counted in RUNS goes blind fastest on the repo that deploys most.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findLastDeployedSha, describeUnreadable } from '../scripts/check-promotion-backlog.mjs'
import { isAppDeployRun } from '../scripts/lib/auto-promote.mjs'

// A staging push: the production job is present in the run and skipped.
const STAGING_PUSH = [
  { name: 'validate-staging', conclusion: 'success' },
  { name: 'deploy', conclusion: 'skipped' },
  { name: 'deploy-staging', conclusion: 'success' },
  { name: 'e2e-staging', conclusion: 'success' },
]
// The real production deploy, run 33786226567: here the staging jobs are the skipped ones.
const PROD_DEPLOY = [
  { name: 'gate-security', conclusion: 'success' },
  { name: 'gate-coverage', conclusion: 'success' },
  { name: 'deploy-staging', conclusion: 'skipped' },
  { name: 'deploy', conclusion: 'success' },
]
const NOISE = ['Sync Outreach', 'Secret Scan (gitleaks)', 'Outreach IMAP Poll', 'Deploy edge functions', 'v11 Staging Gates']

/** A backoffice-shaped repo whose real production deploy sits `depth` runs back behind noise. */
function backofficeLike(depth) {
  const runs = []
  for (let i = 0; i < depth; i++) {
    runs.push(i % 4 !== 0
      ? { id: 1000 + i, name: NOISE[i % NOISE.length], head_sha: 'noise' + i, created_at: '2026-09-03T20:00:00Z' }
      : { id: 1000 + i, name: 'Deploy', head_sha: 'staging' + i, created_at: '2026-09-03T20:00:00Z' })
  }
  runs.push({ id: 33786226567, name: 'Deploy', head_sha: '6f35d6c', created_at: '2026-09-03T17:43:23Z' })
  return runs
}

function fetchersFor(runs, pageSize = 100) {
  const calls = { pages: 0, jobs: 0 }
  return {
    calls,
    getRunsPage: async (page) => { calls.pages++; return runs.slice((page - 1) * pageSize, page * pageSize) },
    getJobs: async (id) => { calls.jobs++; return id === 33786226567 ? PROD_DEPLOY : STAGING_PUSH },
  }
}

test('THE 22:19Z RED: a production deploy just past the old 30-run window is still found', async () => {
  const { getRunsPage, getJobs } = fetchersFor(backofficeLike(34))
  const r = await findLastDeployedSha({ getRunsPage, getJobs, isWanted: isAppDeployRun, jobName: 'deploy' })
  assert.equal(r.sha, '6f35d6c', 'the sensor went blind on the repo that deploys MOST, which is backwards')
  assert.equal(r.exhausted, false)
})

test('a SKIPPED `deploy` job is never mistaken for a deployment', async () => {
  const runs = [{ id: 1, name: 'Deploy', head_sha: 'aaa', created_at: '2026-09-03T20:03:40Z' }]
  const { getRunsPage, getJobs } = fetchersFor(runs)
  const r = await findLastDeployedSha({ getRunsPage, getJobs, isWanted: isAppDeployRun, jobName: 'deploy' })
  assert.equal(r.sha, null, 'a job that never ran shipped nothing')
  assert.equal(r.exhausted, true, 'the history genuinely ended - not the same as having stopped looking')
})

test('the edge-functions pipeline still never counts as the app deploy', async () => {
  const runs = [{ id: 9, name: 'Deploy edge functions', head_sha: 'edge123', created_at: '2026-09-03T20:21:54Z' }]
  const { getRunsPage, getJobs } = fetchersFor(runs)
  const r = await findLastDeployedSha({ getRunsPage, getJobs, isWanted: isAppDeployRun, jobName: 'deploy' })
  assert.equal(r.sha, null, 'c3e026a: an edge run satisfied both halves of the old match and won the scan')
})

test('the search STOPS at the first success - a repo that deploys often costs one page', async () => {
  const runs = [
    { id: 33786226567, name: 'Deploy', head_sha: '6f35d6c', created_at: '2026-09-03T17:43:23Z' },
    ...backofficeLike(300),
  ]
  const { getRunsPage, getJobs, calls } = fetchersFor(runs)
  const r = await findLastDeployedSha({ getRunsPage, getJobs, isWanted: isAppDeployRun, jobName: 'deploy' })
  assert.equal(r.sha, '6f35d6c')
  assert.equal(calls.pages, 1, 'paging must be driven by the answer, not walked to the cap every time')
  assert.equal(calls.jobs, 1, 'one jobs read, on an allowance shared by the whole fleet')
})

test('the search is BOUNDED - it cannot walk a busy repo for ever on a shared allowance', async () => {
  const runs = Array.from({ length: 5000 }, (_, i) => ({ id: i, name: 'Sync Outreach', head_sha: 'n' + i, created_at: '2026-09-03T20:00:00Z' }))
  const { getRunsPage, getJobs, calls } = fetchersFor(runs)
  const r = await findLastDeployedSha({ getRunsPage, getJobs, isWanted: isAppDeployRun, jobName: 'deploy', maxPages: 4 })
  assert.equal(r.sha, null)
  assert.equal(calls.pages, 4, 'the cap is what keeps this off the 5000-per-hour ceiling')
  assert.equal(r.exhausted, false, 'it ran out of BUDGET, not of history - those must not print the same sentence')
})

test('a FAILED history read is not an exhausted history', async () => {
  const r = await findLastDeployedSha({
    getRunsPage: async () => null,          // gh() returns null on HTTP 403 or a network error
    getJobs: async () => [],
    isWanted: isAppDeployRun,
    jobName: 'deploy',
  })
  assert.equal(r.sha, null)
  assert.equal(r.exhausted, false, 'claiming the history ended would launder a refused allowance into a fact')
})

test('the unreadable line says HOW FAR it looked, so an absence is never over-claimed', () => {
  const bounded = describeUnreadable({
    repo: 'backoffice', prod: false, staging: true, cause: null,
    searched: { scanned: 400, oldest: '2026-09-02T09:25:07Z', exhausted: false },
  })
  assert.match(bounded, /400 run\(s\)/, 'a bounded look printed as a flat absence is what cost the 22:19Z hour')
  assert.match(bounded, /back to 2026-09-02T09:25:07Z/)
  assert.doesNotMatch(bounded, /HTTP/, 'must not imply an API failure that did not happen')

  const exhausted = describeUnreadable({
    repo: 'backoffice', prod: false, staging: true, cause: null,
    searched: { scanned: 12, oldest: '2026-08-01T00:00:00Z', exhausted: true },
  })
  assert.match(exhausted, /entire run history/, 'this one has genuinely never deployed - a different problem, a different fix')
  assert.notEqual(bounded, exhausted)
})

test('a named API cause still wins over the span - the status is the whole diagnosis', () => {
  const line = describeUnreadable({
    repo: 'backoffice', prod: false, staging: false, cause: 'GET /repos/x -> HTTP 403',
    searched: { scanned: 400, oldest: '2026-09-02T09:25:07Z', exhausted: false },
  })
  assert.match(line, /HTTP 403/)
  assert.doesNotMatch(line, /400 run/, 'how far it got is noise next to "the allowance refused me"')
})
