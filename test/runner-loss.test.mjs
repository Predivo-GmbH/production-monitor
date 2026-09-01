// The regression this suite exists for: on 2026-09-01 ChannelMover's deploy-staging was destroyed
// at 19:59Z because the WSL2 VM holding that machine's 24 runners was torn down under it. Every
// watcher we had stayed green - they all ask "is a runner online", and the runner was online again
// seconds later. Roger found the red card himself.
//
// The first case below is the REAL job object from run 33551695250 attempt 1, read from the API
// rather than imagined, reduced to the fields the detector looks at.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  looksLikeRunnerLoss,
  confirmRunnerLoss,
  describeRunnerLoss,
  recentFailedRuns,
} from '../scripts/lib/runner-loss.mjs'

// Verbatim shape of the job that started all this.
const THE_REAL_ONE = {
  name: 'deploy-staging',
  conclusion: 'failure',
  runner_name: 'wsl-DESKTOP-124K6MV-ChannelMover',
  steps: [],
}

test('the job that actually broke is detected', () => {
  assert.equal(looksLikeRunnerLoss(THE_REAL_ONE), true)
})

test('an ordinary failure is NOT reported - it failed AT a step', () => {
  // This is the case that must never page Roger. Lint failed; the machine was fine.
  assert.equal(looksLikeRunnerLoss({
    name: 'deploy-staging',
    conclusion: 'failure',
    runner_name: 'wsl-DESKTOP-124K6MV-ChannelMover',
    steps: [
      { name: 'Set up job', status: 'completed', conclusion: 'success' },
      { name: 'Lint', status: 'completed', conclusion: 'failure' },
    ],
  }), false)
})

test('a job that died one step in is still a runner loss (nothing completed)', () => {
  assert.equal(looksLikeRunnerLoss({
    conclusion: 'failure',
    runner_name: 'wsl-LAPTOP-88N97BGG-ReplyFlow-2',
    steps: [{ name: 'Set up job', status: 'in_progress', conclusion: null }],
  }), true)
})

test('GitHub-hosted runners are out of scope - they cannot have this fault', () => {
  assert.equal(looksLikeRunnerLoss({
    conclusion: 'failure',
    runner_name: 'GitHub Actions 4',
    steps: [],
  }), false)
})

test('a skipped or cancelled job is not a loss, however empty its step list', () => {
  for (const conclusion of ['skipped', 'cancelled', 'success', null]) {
    assert.equal(looksLikeRunnerLoss({
      conclusion,
      runner_name: 'wsl-DESKTOP-124K6MV-ChannelMover',
      steps: [],
    }), false, `conclusion=${conclusion}`)
  }
})

test('a job that never got a runner is not a runner loss', () => {
  // The five skipped jobs in the same real run all look like this.
  assert.equal(looksLikeRunnerLoss({
    conclusion: 'failure',
    runner_name: null,
    steps: [],
  }), false)
})

test('junk in does not throw', () => {
  assert.equal(looksLikeRunnerLoss(null), false)
  assert.equal(looksLikeRunnerLoss(undefined), false)
  assert.equal(looksLikeRunnerLoss({}), false)
  assert.equal(looksLikeRunnerLoss({ conclusion: 'failure', runner_name: 'wsl-DESKTOP-124K6MV-x', steps: 'nope' }), true)
})

test('confirmation reads GitHub own words, and does not invent them', () => {
  assert.equal(confirmRunnerLoss([
    { message: 'The self-hosted runner lost communication with the server. Verify the machine is running...' },
  ]), true)
  assert.equal(confirmRunnerLoss([{ message: 'Process completed with exit code 1.' }]), false)
  assert.equal(confirmRunnerLoss([]), false)
  assert.equal(confirmRunnerLoss(null), false)
})

test('the sentence names the machine and clears the repo of blame', () => {
  const msg = describeRunnerLoss({
    repo: 'ChannelMover',
    run: { id: 33551695250, html_url: 'https://github.com/x/y/actions/runs/33551695250' },
    job: THE_REAL_ONE,
    confirmed: true,
  })
  assert.match(msg, /DESKTOP-124K6MV/)
  assert.match(msg, /Nothing is wrong with the code/)
  assert.match(msg, /33551695250/)
})

test('unconfirmed losses are worded as a shape, not as a fact', () => {
  const msg = describeRunnerLoss({ repo: 'x', run: {}, job: THE_REAL_ONE, confirmed: false })
  assert.match(msg, /what a runner dying mid-job looks like/)
  assert.doesNotMatch(msg, /lost communication with the server/)
})

test('only recent failures are worth an API call, and never more than the cap', () => {
  const now = Date.parse('2026-09-01T20:00:00Z')
  const at = (min) => new Date(now - min * 60_000).toISOString()
  const runs = [
    { id: 1, conclusion: 'failure', updated_at: at(5) },
    { id: 2, conclusion: 'success', updated_at: at(5) },
    { id: 3, conclusion: 'failure', updated_at: at(500) },   // too old
    { id: 4, conclusion: 'failure', updated_at: at(10) },
  ]
  const picked = recentFailedRuns(runs, { now, lookbackMinutes: 90 })
  assert.deepEqual(picked.map((r) => r.id), [1, 4])

  const many = Array.from({ length: 20 }, (_, i) => ({ id: i, conclusion: 'failure', updated_at: at(1) }))
  assert.equal(recentFailedRuns(many, { now, max: 5 }).length, 5)
})

test('a run with an unparseable date is skipped rather than assumed recent', () => {
  const now = Date.parse('2026-09-01T20:00:00Z')
  assert.equal(recentFailedRuns([{ conclusion: 'failure', updated_at: 'not a date' }], { now }).length, 0)
  assert.equal(recentFailedRuns([{ conclusion: 'failure' }], { now }).length, 0)
})
