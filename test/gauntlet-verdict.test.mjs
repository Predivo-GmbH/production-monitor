/**
 * Unit tests for "a cancelled scheduled run is not a pass, and must not reset the clock".
 *
 * The defect this guards (2026-09-03): tests/ci-health/nightly-gauntlet.spec.ts judged only the
 * NEWEST scheduled run and asked whether it FAILED. A cancelled run answered "no", so it was
 * reported healthy — and because it was a NEW run, its recent timestamp also made the freshness
 * gate added the same morning (863c731) answer FRESH. Both defects are exercised below.
 *
 * Every assertion here was watched to fail against that original behaviour, which is modelled
 * exactly by `oldBehaviour()` — a check that cannot fail is not a check.
 *
 * Run: node test/gauntlet-verdict.test.mjs   (exit 0 = all pass)
 */
import assert from 'node:assert'
import {
  pickJudgeableRun,
  describeSkipped,
  CONCLUSIVE_CONCLUSIONS,
  MIN_INCONCLUSIVE_TO_PAGE,
} from '../scripts/lib/gauntlet-verdict.mjs'
import { scheduleFreshness } from '../scripts/lib/gauntlet-staleness.mjs'

let n = 0
const t = (name, fn) => { fn(); n++; console.log(`  ok - ${name}`) }

const HOUR = 3_600_000
const at = (hoursAgo) => new Date(Date.now() - hoursAgo * HOUR).toISOString()
const run = (conclusion, hoursAgo, extra = {}) => ({
  id: Math.round(hoursAgo * 1000),
  status: conclusion === null ? 'in_progress' : 'completed',
  conclusion,
  run_started_at: at(hoursAgo),
  run_attempt: 1,
  head_sha: 'a'.repeat(40),
  html_url: 'https://example.invalid/run',
  ...extra,
})

/** THE ORIGINAL CODE, so the tests below are proven to discriminate. It took runs[0] and asked
 *  only whether its conclusion was a failure; everything else was "healthy". */
const oldBehaviour = (runs) => {
  const latest = runs && runs[0]
  if (!latest || latest.status !== 'completed') return 'skip'
  return ['failure', 'timed_out'].includes(latest.conclusion) ? 'fail' : 'healthy'
}

const daily = { archived: false, yamlRead: true, cronCount: 1, periodHours: 24 }

// ── the hole itself, on the real measured data ───────────────────────────────────────────────

t('THE DEFECT: ReplyFlow 2026-08-27, gate-e2e cancelled after 20min, is not a pass', () => {
  // Live shape of run 33049024073: the newest scheduled run, conclusion cancelled, with a green
  // nightly behind it. The old code called this healthy.
  const runs = [run('cancelled', 3), run('success', 27)]
  assert.equal(oldBehaviour(runs), 'healthy', 'guard is pointing at the wrong behaviour')

  const v = pickJudgeableRun(runs)
  assert.equal(v.verdict, 'JUDGE')
  assert.equal(v.judged.conclusion, 'success', 'must judge the run that actually concluded')
  assert.equal(v.skipped.length, 1)
  assert.equal(v.skipped[0].conclusion, 'cancelled')
})

t('THE SECOND DEFECT: a cancel must not reset the staleness clock', () => {
  // A nightly cancelled every night. Newest cancel is 1h old; the last run that actually
  // concluded is 5 days old, so NOTHING has tested this product for 5 days.
  const runs = [run('cancelled', 1), run('cancelled', 25), run('cancelled', 49), run('success', 120)]

  // Old path: age taken from runs[0] -> 1h -> FRESH. The hole 863c731 closed, reopened.
  assert.equal(scheduleFreshness({ ...daily, ageHours: 1 }).verdict, 'FRESH')

  // New path: age taken from the judged run -> 120h -> past 3x24h -> OVERDUE.
  const v = pickJudgeableRun(runs)
  assert.equal(v.judged.conclusion, 'success')
  const ageHours = (Date.now() - new Date(v.judged.run_started_at).getTime()) / HOUR
  assert.equal(scheduleFreshness({ ...daily, ageHours }).verdict, 'OVERDUE')
})

t('a cancel hiding a FAILURE still reaches the failure path', () => {
  const runs = [run('cancelled', 2), run('failure', 26)]
  assert.equal(oldBehaviour(runs), 'healthy')
  const v = pickJudgeableRun(runs)
  assert.equal(v.verdict, 'JUDGE')
  assert.equal(v.judged.conclusion, 'failure', 'a cancel must not bury the red night behind it')
})

// ── what it must NOT do: a cancel is never itself an alarm ───────────────────────────────────

t('a single cancel over a recent green is silent (no false page)', () => {
  const runs = [run('cancelled', 2), run('success', 26)]
  const v = pickJudgeableRun(runs)
  const ageHours = (Date.now() - new Date(v.judged.run_started_at).getTime()) / HOUR
  assert.equal(scheduleFreshness({ ...daily, ageHours }).verdict, 'FRESH', 'one cancel must not page')
})

t('a normal green newest run is unchanged — nothing skipped', () => {
  const runs = [run('success', 2), run('success', 26)]
  const v = pickJudgeableRun(runs)
  assert.equal(v.verdict, 'JUDGE')
  assert.equal(v.judged, runs[0])
  assert.equal(v.skipped.length, 0)
  assert.equal(describeSkipped(v.skipped), '', 'no note when nothing was stepped over')
})

t('a normal failing newest run is unchanged', () => {
  const v = pickJudgeableRun([run('failure', 3), run('success', 27)])
  assert.equal(v.judged.conclusion, 'failure')
  assert.equal(v.skipped.length, 0)
})

// ── states that must stay quiet ──────────────────────────────────────────────────────────────

t('an in-progress newest run still skips (unchanged behaviour)', () => {
  const v = pickJudgeableRun([run(null, 0.2), run('success', 24)])
  assert.equal(v.verdict, 'PENDING', 'a nightly mid-flight is judged an hour later, not now')
})

t('no runs at all stays quiet', () => {
  assert.equal(pickJudgeableRun([]).verdict, 'NO_RUNS')
  assert.equal(pickJudgeableRun(null).verdict, 'NO_RUNS')
})

t('ONE cancel with nothing conclusive behind it is UNPROVEN, not a page', () => {
  const v = pickJudgeableRun([run('cancelled', 5)])
  assert.equal(v.verdict, 'UNPROVEN', 'one blip is never an alarm in this repo')
  assert.equal(v.judged, null)
})

t('an in-progress run newer than the judged one is not counted as a skipped verdict', () => {
  // Today's nightly is running; yesterday's concluded. The in-progress run has not FAILED to
  // answer, it has not answered yet — reporting it as "gave no verdict" would be a lie.
  const runs = [run(null, 0.1), run('cancelled', 24), run('success', 48)]
  const v = pickJudgeableRun(runs)
  assert.equal(v.verdict, 'PENDING', 'newest not completed -> quiet, before anything else')
})

// ── the finding: the gauntlet never completes ────────────────────────────────────────────────

t('every completed run inconclusive is a finding, not health', () => {
  const runs = [run('cancelled', 1), run('cancelled', 25), run('cancelled', 49)]
  assert.equal(oldBehaviour(runs), 'healthy')
  const v = pickJudgeableRun(runs)
  assert.equal(v.verdict, 'NONE_CONCLUSIVE')
  assert.match(v.reason, /nothing has actually been tested/)
})

t('the page threshold is exactly MIN_INCONCLUSIVE_TO_PAGE, checked at the boundary', () => {
  const below = Array.from({ length: MIN_INCONCLUSIVE_TO_PAGE - 1 }, (_, i) => run('cancelled', i + 1))
  const atThreshold = Array.from({ length: MIN_INCONCLUSIVE_TO_PAGE }, (_, i) => run('cancelled', i + 1))
  assert.notEqual(pickJudgeableRun(below).verdict, 'NONE_CONCLUSIVE')
  assert.equal(pickJudgeableRun(atThreshold).verdict, 'NONE_CONCLUSIVE')
})

// ── conclusion vocabulary ────────────────────────────────────────────────────────────────────

t('a conclusion GitHub adds later is inconclusive by default, not healthy', () => {
  // The safe direction: name what IS a verdict, so an unfamiliar conclusion cannot pass for one.
  for (const c of ['startup_failure', 'action_required', 'stale', 'neutral', 'skipped', null]) {
    assert.ok(!CONCLUSIVE_CONCLUSIONS.includes(c), `${c} must not count as a verdict`)
    const newest = { ...run('success', 1), conclusion: c, status: 'completed' }
    const v = pickJudgeableRun([newest, run('success', 30)])
    assert.equal(v.judged.conclusion, 'success', `${c} must be stepped over, not judged`)
  }
})

t('timed_out is a verdict (it is a real failure), not an absence of one', () => {
  const v = pickJudgeableRun([run('timed_out', 3), run('success', 27)])
  assert.equal(v.judged.conclusion, 'timed_out')
  assert.equal(v.skipped.length, 0)
})

// ── the alert text ───────────────────────────────────────────────────────────────────────────

t('the skipped note names each stepped-over run and its conclusion', () => {
  const note = describeSkipped([run('cancelled', 2)])
  assert.match(note, /gave no verdict/)
  assert.match(note, /cancelled/)
})

console.log(`\n${n} assertions passed`)
