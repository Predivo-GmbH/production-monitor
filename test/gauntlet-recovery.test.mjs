/**
 * Unit tests for "a gate that has passed since is not persistently failing".
 *
 * The defect this guards (2026-09-03, monitor run 33731470295): nightly-gauntlet.spec.ts decided
 * "PERSISTENTLY FAILING" from the failed run's age and attempt count alone. It never asked
 * whether any of the NEWER stepped-over scheduled runs it was already holding — and already
 * printing in the alert's own NOTE clause — had since run that job green. BoatBuddy was paged
 * for `gate-security` at 08:10Z; `gate-security` had concluded SUCCESS at 05:28:31Z.
 *
 * `oldBehaviour()` below models the original rule exactly — it looks only at the failed run —
 * and every assertion that matters is run against it first, so the tests are proven to
 * discriminate. A check that cannot fail is not a check.
 *
 * Run: node test/gauntlet-recovery.test.mjs   (exit 0 = all pass)
 */
import assert from 'node:assert'
import { recoveredSince, failedJobNames, CONCLUSIVE_JOB_CONCLUSIONS } from '../scripts/lib/gauntlet-recovery.mjs'

let n = 0
const t = (name, fn) => { fn(); n++; console.log(`  ok - ${name}`) }

const job = (name, conclusion, steps) => ({ name, conclusion, ...(steps ? { steps } : {}) })
const entry = (id, jobs) => ({ run: { id, html_url: `https://example.invalid/runs/${id}` }, jobs })

/** THE ORIGINAL RULE. Given a failed run it pages, full stop: newer runs were never consulted.
 *  Expressed as the same shape as recoveredSince() so the tests can be pointed at either. */
const oldBehaviour = () => ({ recovered: false, reason: 'never looked', perJob: [] })

console.log('gauntlet-recovery: a gate that has passed since is not persistently failing')

// ---------------------------------------------------------------------------------------------
// THE LIVE CASE, with the real ids and the real job names measured on 2026-09-03.
// ---------------------------------------------------------------------------------------------

t('THE REGRESSION: BoatBuddy gate-security passed in the stepped-over run, so it is not persistent', () => {
  // Judged run 33591920887 (2026-09-02T04:43Z): gate-security FAILED, everything else green/skipped.
  const judgedJobs = [
    job('gate-integration', 'success'),
    job('gate-security', 'failure', [job('Dependency audit (blocking at high)', 'failure')]),
    job('deploy-staging', 'skipped'),
    job('gate-e2e', 'cancelled'),
    job('deploy', 'skipped'),
  ]
  const names = failedJobNames(judgedJobs)
  assert.deepStrictEqual(names, ['gate-security'], 'only gate-security failed in the judged run')

  // Stepped-over run 33718969126 (2026-09-03T05:28Z, on the fix commit dbb02d8). Overall
  // conclusion `cancelled` — gate-integration timed out — but gate-security concluded SUCCESS.
  const newer = [entry(33718969126, [
    job('gate-integration', 'cancelled'),
    job('gate-security', 'success', [job('Dependency audit (blocking at high)', 'success')]),
    job('deploy-staging', 'skipped'),
    job('gate-e2e', 'success'),
    job('deploy', 'skipped'),
  ])]

  const got = recoveredSince(names, newer)
  assert.strictEqual(got.recovered, true, 'gate-security passed at 05:28Z — the page must be cleared')
  assert.match(got.reason, /gate-security passed in a newer scheduled run/)
  assert.match(got.reason, /33718969126/, 'the alert must name the run that holds the pass')

  // ...and the old rule paged anyway. This is the assertion that makes the test a guard.
  assert.strictEqual(oldBehaviour().recovered, false, 'the original rule paged on the 27.4h-old failure')
})

// ---------------------------------------------------------------------------------------------
// THE FAIL-SAFE DIRECTION: everything that is not a positive job-level pass leaves the page up.
// ---------------------------------------------------------------------------------------------

t('a job that FAILED AGAIN in a newer run is still failing, not recovered', () => {
  const got = recoveredSince(['gate-security'], [entry(2, [job('gate-security', 'failure')])])
  assert.strictEqual(got.recovered, false)
  assert.match(got.reason, /still failing in a newer scheduled run: gate-security/)
})

t('NEWEST WINS: passed at 04:00 then failed at 05:00 is re-failed, not recovered', () => {
  // newest first — the failure is the current truth, and picking the pass would be choosing
  // the answer we like out of two.
  const got = recoveredSince(['gate-security'], [
    entry(5, [job('gate-security', 'failure')]),
    entry(4, [job('gate-security', 'success')]),
  ])
  assert.strictEqual(got.recovered, false, 'the newer observation of the job is the failure')
  assert.strictEqual(got.perJob[0].state, 'refailed')
})

t('NEWEST WINS the other way: failed at 04:00 then passed at 05:00 IS recovered', () => {
  const got = recoveredSince(['gate-security'], [
    entry(5, [job('gate-security', 'success')]),
    entry(4, [job('gate-security', 'failure')]),
  ])
  assert.strictEqual(got.recovered, true)
  assert.strictEqual(got.perJob[0].run.id, 5, 'credited to the run that actually holds the pass')
})

t('a job that was CANCELLED in the newer run has not answered, so the page stands', () => {
  const got = recoveredSince(['gate-e2e'], [entry(2, [job('gate-e2e', 'cancelled')])])
  assert.strictEqual(got.recovered, false)
  assert.match(got.reason, /no newer scheduled run gives a verdict on gate-e2e/)
})

t('a job that was SKIPPED in the newer run has not answered either', () => {
  // This is the exact trap that made the push run on the fix commit look like proof: BoatBuddy
  // push run 33711852607 ran deploy-staging and SKIPPED gate-security. A skip is not a pass.
  const got = recoveredSince(['gate-security'], [entry(2, [job('gate-security', 'skipped')])])
  assert.strictEqual(got.recovered, false)
  assert.match(got.reason, /no newer scheduled run gives a verdict on gate-security/)
})

t('a job ABSENT from the newer run is unproven, never assumed fine', () => {
  const got = recoveredSince(['gate-edge-typecheck'], [entry(2, [job('gate-security', 'success')])])
  assert.strictEqual(got.recovered, false)
  assert.strictEqual(got.perJob[0].state, 'unproven')
})

t('an UNREAD job list (jobs: null) is not an empty one', () => {
  // Two absences are not agreement — the repo's own keeper from the F31-F37 audit. A run whose
  // jobs we could not fetch must not be read as "the job is not there".
  const got = recoveredSince(['gate-security'], [
    entry(3, null),
    entry(2, [job('gate-security', 'success')]),
  ])
  assert.strictEqual(got.recovered, true, 'the unread run is skipped over, the readable one still counts')

  const onlyUnread = recoveredSince(['gate-security'], [entry(3, null)])
  assert.strictEqual(onlyUnread.recovered, false, 'nothing readable = nothing proven')
  assert.match(onlyUnread.reason, /no newer scheduled run gives a verdict/)
})

t('NO NAMED JOB never clears a page — "we did not look" is not "it passed"', () => {
  // Upstream falls back to "the failing job could not be read from GitHub" and says so in the
  // alert. That state must not be laundered into a suppression here.
  for (const names of [[], null, undefined]) {
    const got = recoveredSince(names, [entry(2, [job('gate-security', 'success')])])
    assert.strictEqual(got.recovered, false, `names=${JSON.stringify(names)} must not clear`)
    assert.match(got.reason, /no failing job was named/)
  }
})

t('NO NEWER RUN never clears a page — the ordinary case must behave exactly as before', () => {
  for (const newer of [[], null, undefined]) {
    const got = recoveredSince(['gate-security'], newer)
    assert.strictEqual(got.recovered, false, `newer=${JSON.stringify(newer)} must not clear`)
    assert.match(got.reason, /no newer scheduled run to check/)
  }
})

// ---------------------------------------------------------------------------------------------
// EVERY named job, not some of them.
// ---------------------------------------------------------------------------------------------

t('two gates failed and only one passed since — the gauntlet is still red', () => {
  const got = recoveredSince(['gate-security', 'gate-e2e'], [entry(2, [
    job('gate-security', 'success'),
    job('gate-e2e', 'failure'),
  ])])
  assert.strictEqual(got.recovered, false, 'one unrecovered gate is still a red gauntlet')
  assert.match(got.reason, /still failing in a newer scheduled run: gate-e2e/)
})

t('two gates failed and BOTH passed since — cleared, and both are named', () => {
  const got = recoveredSince(['gate-security', 'gate-e2e'], [entry(2, [
    job('gate-security', 'success'),
    job('gate-e2e', 'success'),
  ])])
  assert.strictEqual(got.recovered, true)
  assert.match(got.reason, /gate-security passed/)
  assert.match(got.reason, /gate-e2e passed/)
})

t('a re-failure is reported ahead of an unproven one — the worse news leads', () => {
  const got = recoveredSince(['gate-a', 'gate-b'], [entry(2, [job('gate-a', 'failure')])])
  assert.strictEqual(got.recovered, false)
  assert.match(got.reason, /still failing/, 'gate-a re-failed; that outranks gate-b being unseen')
})

// ---------------------------------------------------------------------------------------------
// failedJobNames: the names looked up here must be the names the alert showed Roger.
// ---------------------------------------------------------------------------------------------

t('failedJobNames picks failure and timed_out, and nothing else', () => {
  assert.deepStrictEqual(
    failedJobNames([
      job('a', 'success'), job('b', 'failure'), job('c', 'cancelled'),
      job('d', 'timed_out'), job('e', 'skipped'), job('f', null),
    ]),
    ['b', 'd'],
  )
})

t('failedJobNames survives junk without throwing, and yields nothing to clear on', () => {
  assert.deepStrictEqual(failedJobNames(null), [])
  assert.deepStrictEqual(failedJobNames(undefined), [])
  assert.deepStrictEqual(failedJobNames([null, {}, { conclusion: 'failure' }, { name: '', conclusion: 'failure' }]), [])
})

t('timed_out is conclusive for a job, cancelled and skipped are not', () => {
  assert.deepStrictEqual(CONCLUSIVE_JOB_CONCLUSIONS, ['success', 'failure', 'timed_out'])
  for (const c of ['cancelled', 'skipped', 'neutral', 'action_required', null]) {
    assert.ok(!CONCLUSIVE_JOB_CONCLUSIONS.includes(c), `${c} must not be a job verdict`)
  }
  const got = recoveredSince(['g'], [entry(2, [job('g', 'timed_out')])])
  assert.strictEqual(got.recovered, false, 'a timed-out job is a failing job, not an unproven one')
  assert.match(got.reason, /still failing/)
})

console.log(`\n${n} assertions passed`)
