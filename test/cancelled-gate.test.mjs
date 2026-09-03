// The regression this suite exists for: on 2026-09-02 ChannelMover's run 33680699080 ("Deploy to
// Production") had gate-security CANCELLED — its nine real steps passed in 2m06s, then setup-node's
// cache-save post-step ran eight minutes into the job's 10-minute limit and the job was killed. The
// production deploy needs gate-security, so the release was blocked, and NOTHING went red: the run
// page and the run's own conclusion looked clean. Every watcher the fleet had keys on `failure`.
//
// The job objects below are the REAL ones from run 33680699080, read from the API rather than
// imagined, reduced to the fields the detector looks at.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isRequiredGateJob,
  looksLikeCancelledGate,
  someJobSucceeded,
  cancelledRequiredGates,
  describeCancelledGate,
  recentCancelledRuns,
} from '../scripts/lib/cancelled-gate.mjs'

// Verbatim shape (reduced) of the six jobs in run 33680699080.
const THE_REAL_RUN_JOBS = [
  { name: 'gate-integration', conclusion: 'success', steps: Array(8).fill({ status: 'completed', conclusion: 'success' }) },
  { name: 'gate-e2e', conclusion: 'success', steps: Array(13).fill({ status: 'completed', conclusion: 'success' }) },
  {
    name: 'gate-security', conclusion: 'cancelled',
    steps: [
      ...Array(11).fill({ status: 'completed', conclusion: 'success' }),
      { name: 'Post Setup Node', status: 'completed', conclusion: 'cancelled' },
    ],
  },
  { name: 'deploy-staging', conclusion: 'skipped', steps: [] },
  { name: 'deploy', conclusion: 'skipped', steps: [] },
  { name: 'prod-smoke', conclusion: 'skipped', steps: [] },
]

const THE_CANCELLED_GATE = THE_REAL_RUN_JOBS[2]

test('the gate that actually got cancelled is detected', () => {
  assert.equal(looksLikeCancelledGate(THE_CANCELLED_GATE), true)
})

test('run-level: exactly the one cancelled required gate is returned', () => {
  const hits = cancelledRequiredGates(THE_REAL_RUN_JOBS)
  assert.deepEqual(hits.map((j) => j.name), ['gate-security'])
})

test('a gate that FAILED is not reported here — a failure is already red', () => {
  // The whole point: this module is for the INVISIBLE case. A failed gate shows up on its own.
  assert.equal(looksLikeCancelledGate({
    name: 'gate-security', conclusion: 'failure',
    steps: [{ status: 'completed', conclusion: 'failure' }],
  }), false)
})

test('a cancelled NON-gate job is out of scope — deploy is not a required gate', () => {
  assert.equal(looksLikeCancelledGate({
    name: 'deploy-staging', conclusion: 'cancelled',
    steps: [{ status: 'completed', conclusion: 'success' }],
  }), false)
})

test('a gate cancelled before it ever ran is not this fault (no completed step)', () => {
  // A queued gate killed when a newer run superseded it looks like this: cancelled, zero steps done.
  assert.equal(looksLikeCancelledGate({
    name: 'gate-security', conclusion: 'cancelled', steps: [],
  }), false)
  assert.equal(looksLikeCancelledGate({
    name: 'gate-e2e', conclusion: 'cancelled',
    steps: [{ status: 'in_progress', conclusion: null }],
  }), false)
})

test('a wholesale run cancellation is NOT reported — nothing succeeded, so it was superseded', () => {
  // A concurrency/supersede cancel takes the whole run: every in-flight job cancelled, none success.
  // That is a new push cancelling an old run, not a gate singled out — it must not page Roger.
  const superseded = [
    { name: 'gate-security', conclusion: 'cancelled', steps: [{ status: 'completed', conclusion: 'success' }] },
    { name: 'gate-e2e', conclusion: 'cancelled', steps: [{ status: 'completed', conclusion: 'success' }] },
    { name: 'gate-integration', conclusion: 'cancelled', steps: [] },
  ]
  assert.equal(someJobSucceeded(superseded), false)
  assert.deepEqual(cancelledRequiredGates(superseded), [])
})

test('all the gate names in these workflows are recognised as required gates', () => {
  for (const n of ['gate-security', 'gate-integration', 'gate-e2e', 'gate-coverage', 'gate-critical', 'gate-edge-typecheck']) {
    assert.equal(isRequiredGateJob(n), true, n)
  }
  for (const n of ['deploy', 'deploy-staging', 'prod-smoke', 'build', 'gatekeeper', 'navigate']) {
    assert.equal(isRequiredGateJob(n), false, n)
  }
})

test('junk in does not throw', () => {
  assert.equal(looksLikeCancelledGate(null), false)
  assert.equal(looksLikeCancelledGate(undefined), false)
  assert.equal(looksLikeCancelledGate({}), false)
  assert.equal(looksLikeCancelledGate({ name: 'gate-security', conclusion: 'cancelled', steps: 'nope' }), false)
  assert.deepEqual(cancelledRequiredGates(null), [])
  assert.equal(someJobSucceeded(null), false)
})

test('the sentence clears the code, names the gate, and says the release is blocked', () => {
  const msg = describeCancelledGate({
    repo: 'ChannelMover',
    run: { id: 33680699080, html_url: 'https://github.com/Predivo-GmbH/ChannelMover/actions/runs/33680699080' },
    job: THE_CANCELLED_GATE,
  })
  assert.match(msg, /CANCELLED, not failed/)
  assert.match(msg, /gate-security/)
  assert.match(msg, /Nothing is wrong with the code/)
  assert.match(msg, /33680699080/)
})

test('only recent cancelled runs are worth an API call, and never more than the cap', () => {
  const now = Date.parse('2026-09-02T21:00:00Z')
  const at = (min) => new Date(now - min * 60_000).toISOString()
  const runs = [
    { id: 1, conclusion: 'cancelled', updated_at: at(5) },
    { id: 2, conclusion: 'success', updated_at: at(5) },   // not cancelled
    { id: 3, conclusion: 'cancelled', updated_at: at(500) }, // too old
    { id: 4, conclusion: 'cancelled', updated_at: at(10) },
  ]
  assert.deepEqual(recentCancelledRuns(runs, { now, lookbackMinutes: 90 }).map((r) => r.id), [1, 4])

  const many = Array.from({ length: 20 }, (_, i) => ({ id: i, conclusion: 'cancelled', updated_at: at(1) }))
  assert.equal(recentCancelledRuns(many, { now, max: 5 }).length, 5)
})

test('a run with an unparseable date is skipped rather than assumed recent', () => {
  const now = Date.parse('2026-09-02T21:00:00Z')
  assert.equal(recentCancelledRuns([{ conclusion: 'cancelled', updated_at: 'not a date' }], { now }).length, 0)
  assert.equal(recentCancelledRuns([{ conclusion: 'cancelled' }], { now }).length, 0)
})
