/**
 * Unit tests for "a green scheduled run is only evidence while it is recent".
 *
 * The defect this guards (2026-09-03): tests/ci-health/nightly-gauntlet.spec.ts returned
 * healthy on ANY green scheduled run, however old, so a nightly gauntlet that stopped firing
 * reported healthy forever. Every assertion below was watched to fail against that original
 * behaviour — which is simply "green means FRESH" for every green run — because a check that
 * cannot fail is not a check.
 *
 * Run: node test/nightly-gauntlet-staleness.test.mjs   (exit 0 = all pass)
 */
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { scheduleFreshness, corroborateStopped, STOPPED_VERDICTS, OVERDUE_FACTOR, FRESH_FLOOR_HOURS } from '../scripts/lib/gauntlet-staleness.mjs'
import { extractCronSchedules, cronPeriodHours } from '../scripts/lib/cron-cadence.mjs'

let n = 0
const t = (name, fn) => { fn(); n++; console.log(`  ok - ${name}`) }

const daily = { archived: false, yamlRead: true, cronCount: 1, periodHours: 24 }

// ── the hole itself ──────────────────────────────────────────────────────────────────────────

t('THE DEFECT: a green nightly from 62 days ago is not healthy', () => {
  // The exact live shape measured on 2026-09-03: last scheduled run 2026-07-02, conclusion
  // success. The old code said healthy. If this ever returns FRESH the hole is back.
  const v = scheduleFreshness({ ...daily, ageHours: 62.5 * 24 })
  assert.equal(v.verdict, 'OVERDUE')
  assert.match(v.reason, /stopped firing/)
})

t('a nightly that missed one night is NOT an alarm (GitHub drops ticks)', () => {
  assert.equal(scheduleFreshness({ ...daily, ageHours: 47 }).verdict, 'FRESH')
})

t('two missed nights are still not an alarm — 3x the interval is the rule', () => {
  assert.equal(scheduleFreshness({ ...daily, ageHours: 71.9 }).verdict, 'FRESH')
})

t('past 3x its own interval it is overdue', () => {
  assert.equal(scheduleFreshness({ ...daily, ageHours: 72.1 }).verdict, 'OVERDUE')
})

t('the boundary is exactly OVERDUE_FACTOR x period, not a hardcoded number', () => {
  const p = 6
  assert.equal(scheduleFreshness({ ...daily, periodHours: p, ageHours: OVERDUE_FACTOR * p }).verdict, 'FRESH')
  assert.equal(scheduleFreshness({ ...daily, periodHours: p, ageHours: OVERDUE_FACTOR * p + 0.1 }).verdict, 'OVERDUE')
})

t('a period we KNOW beats the fresh floor — the floor never forgives a fast schedule', () => {
  // This caught a real bug in the first version of this fix: the floor was checked first, so a
  // 6-hourly workflow dead for 18h (already 3x its interval) was reported FRESH because 18 < 26.
  const p = 6
  const age = 18.5 // past 3x6=18, but inside the 26h floor
  assert.ok(age < FRESH_FLOOR_HOURS, 'the case only bites inside the floor')
  assert.equal(scheduleFreshness({ ...daily, periodHours: p, ageHours: age }).verdict, 'OVERDUE')
})

t('the floor is only used when the period is genuinely unknown', () => {
  const known = scheduleFreshness({ ...daily, periodHours: 2, ageHours: 20 })
  const unknown = scheduleFreshness({ ...daily, periodHours: null, ageHours: 20 })
  assert.equal(known.verdict, 'OVERDUE')
  assert.equal(unknown.verdict, 'FRESH')
})

t('a weekly workflow is judged against a week, not against a day', () => {
  // Judging a weekly cron by the daily floor would page every single week. The period must
  // come from the workflow's OWN cron.
  assert.equal(scheduleFreshness({ ...daily, periodHours: 168, ageHours: 200 }).verdict, 'FRESH')
  assert.equal(scheduleFreshness({ ...daily, periodHours: 168, ageHours: 505 }).verdict, 'OVERDUE')
})

// ── the cheap path ───────────────────────────────────────────────────────────────────────────

t('a run inside the fresh floor is FRESH without needing the cron at all', () => {
  // This is what keeps the hourly monitor from spending extra GitHub calls per repo per hour:
  // below the floor the answer cannot depend on the cron, so nothing is fetched.
  const v = scheduleFreshness({ ageHours: 23.7, archived: null, yamlRead: false, cronCount: 0, periodHours: null })
  assert.equal(v.verdict, 'FRESH')
})

t('the fresh floor is above a day so normal daily jitter never costs a fetch', () => {
  assert.ok(FRESH_FLOOR_HOURS > 24, 'floor must clear a daily cron plus GitHub jitter')
})

// ── what it refuses to call an alarm ─────────────────────────────────────────────────────────

t('an archived repo is retired, not broken', () => {
  // Measured live: SignalForgeAi / belegpilot / api-dashboard, archived 2026-07-02, silent 62
  // days. Paging on these would be three standing false alarms.
  const v = scheduleFreshness({ ...daily, archived: true, ageHours: 62.5 * 24 })
  assert.equal(v.verdict, 'RETIRED')
  assert.match(v.reason, /archived/)
})

t('an unreadable workflow file is UNPROVEN and says so — never "fresh"', () => {
  // An unread file implies an unknown period — the spec never supplies one it did not read.
  const v = scheduleFreshness({ ...daily, yamlRead: false, periodHours: null, ageHours: 500 })
  assert.equal(v.verdict, 'UNPROVEN')
  assert.match(v.reason, /could not be read/)
  assert.notEqual(v.verdict, 'FRESH')
})

t('a cron that is present but unparseable is UNPROVEN, not a guess and not an alarm', () => {
  const v = scheduleFreshness({ ...daily, cronCount: 2, periodHours: null, ageHours: 500 })
  assert.equal(v.verdict, 'UNPROVEN')
  assert.match(v.reason, /2 cron/)
})

t('an age that could not be computed is UNPROVEN, not FRESH', () => {
  assert.equal(scheduleFreshness({ ...daily, ageHours: NaN }).verdict, 'UNPROVEN')
})

// ── a readable file with no schedule is a finding, not an absence ────────────────────────────

t('a readable workflow with NO cron means the nightly was removed — that is a finding', () => {
  const v = scheduleFreshness({ ...daily, cronCount: 0, periodHours: null, ageHours: 500 })
  assert.equal(v.verdict, 'NO_SCHEDULE')
  assert.match(v.reason, /no cron at all/)
})

t('UNPROVEN and NO_SCHEDULE are different answers to different questions', () => {
  // "we could not look" and "we looked and the schedule is gone" must never collapse into one
  // verdict — the first must stay quiet, the second must page.
  const cantLook = scheduleFreshness({ ...daily, yamlRead: false, cronCount: 0, periodHours: null, ageHours: 500 })
  const gone = scheduleFreshness({ ...daily, yamlRead: true, cronCount: 0, periodHours: null, ageHours: 500 })
  assert.equal(cantLook.verdict, 'UNPROVEN')
  assert.equal(gone.verdict, 'NO_SCHEDULE')
})

// ── the verdicts the caller acts on ──────────────────────────────────────────────────────────

t('exactly two verdicts page, and they are the two that name a stopped schedule', () => {
  // Asserted against the set the SPEC actually routes on, not a copy typed in here. Until
  // 2026-09-03 this test held its own `new Set(['OVERDUE','NO_SCHEDULE'])`, so the code could
  // have started paging on a third verdict and this would still have gone green — the same
  // test-restates-the-assumption fault 1a49f49 fixed for the fresh floor.
  assert.deepEqual([...STOPPED_VERDICTS].sort(), ['NO_SCHEDULE', 'OVERDUE'])
  for (const v of ['FRESH', 'RETIRED', 'UNPROVEN', 'NO_SCHEDULE', 'OVERDUE']) {
    assert.equal(STOPPED_VERDICTS.includes(v), v === 'OVERDUE' || v === 'NO_SCHEDULE', v)
  }
})

t('every verdict carries a reason a person can act on', () => {
  const cases = [
    { ...daily, ageHours: 1 },
    { ...daily, ageHours: 62 * 24, archived: true },
    { ...daily, ageHours: 500, yamlRead: false, periodHours: null },
    { ...daily, ageHours: 500, cronCount: 0, periodHours: null },
    { ...daily, ageHours: 500 },
  ]
  for (const c of cases) {
    const v = scheduleFreshness(c)
    assert.ok(v.reason && v.reason.length > 20, `verdict ${v.verdict} has no usable reason`)
  }
})

// ── the real cron shapes this fix will actually be handed ────────────────────────────────────

t('the five tiered nightlies parse to 24h from their real cron text', () => {
  // The literal schedule blocks read from the five product deploy.yml files on 2026-09-03.
  for (const expr of ['30 4 * * *', '35 4 * * *', '40 4 * * *', '45 4 * * *', '50 4 * * *']) {
    const yaml = 'on:\n  schedule:\n    - cron: ' + JSON.stringify(expr) + '\n  workflow_dispatch:\n'
    assert.deepEqual(extractCronSchedules(yaml), [expr])
    assert.equal(cronPeriodHours(expr, Date.parse('2026-09-03T04:00:00Z')), 24)
  }
})

t('the fresh floor is sound for representative daily crons (parse check only)', () => {
  // NOTE — this proves the floor's precondition (OVERDUE_FACTOR x period >= floor) only for the
  // daily cron SHAPES typed below; it does NOT read the product repos' real deploy.yml, so it
  // will keep passing even if a real gauntlet is later made sub-daily. The precondition against
  // the LIVE schedules is enforced in tests/ci-health/nightly-gauntlet.spec.ts, which asserts it
  // against each real fetched period and fails loudly when 3x the interval no longer clears the
  // floor. This case just guards that the parse+arithmetic itself is correct for a daily cron.
  for (const expr of ['30 4 * * *', '35 4 * * *', '40 4 * * *', '45 4 * * *', '50 4 * * *']) {
    const p = cronPeriodHours(expr, Date.parse('2026-09-03T04:00:00Z'))
    assert.ok(OVERDUE_FACTOR * p >= FRESH_FLOOR_HOURS, `${expr}: 3x${p}h does not clear the ${FRESH_FLOOR_HOURS}h floor`)
  }
})

t('a deploy.yml with only workflow_dispatch yields no cron', () => {
  assert.deepEqual(extractCronSchedules('on:\n  workflow_dispatch:\n  push:\n'), [])
})

// ── the spec really uses this, and really acts on it ─────────────────────────────────────────

t('nightly-gauntlet.spec.ts imports this decision and does not re-implement it', () => {
  const src = readFileSync(new URL('../tests/ci-health/nightly-gauntlet.spec.ts', import.meta.url), 'utf8')
  assert.match(src, /scheduleFreshness/, 'spec must call the tested decision function')
  assert.match(src, /gauntlet-staleness/, 'spec must import it rather than copy the rule')
})

t('the spec no longer returns healthy on a green run without consulting freshness', () => {
  // The original line was a bare `test.skip(!isFail, "... healthy")` with nothing between it
  // and the age arithmetic. Freshness must be decided BEFORE any healthy skip.
  const src = readFileSync(new URL('../tests/ci-health/nightly-gauntlet.spec.ts', import.meta.url), 'utf8')
  const fresh = src.indexOf('scheduleFreshness')
  const healthy = src.indexOf('— healthy')
  assert.ok(fresh !== -1 && healthy !== -1, 'both markers must exist')
  assert.ok(fresh < healthy, 'freshness must be decided before the run is called healthy')
})


// ── SEEING THE ABSENCE TWICE ─────────────────────────────────────────────────────────────────
//
// The second hole in this gate, found the same day (2026-09-03) by monitor run 33723882661. The
// gate above did its arithmetic correctly on the run it was given; it was GIVEN THE WRONG RUN.
// GitHub answered 200 with a page whose newest scheduled run was 19 days stale, ChannelMover's
// nightly had actually run 2h earlier, and the alarm went out. Original behaviour, which every
// assertion below was watched to fail against, is "one read is enough" — i.e. corroborateStopped
// replaced by `() => ({ confirmed: true })`.

t('THE DEFECT: two reads naming different newest runs prove nothing, so no page', () => {
  // The exact live shape. Read 1 (06:37:49.645Z) judged run 31865853339 from 2026-08-15 and said
  // OVERDUE; read 2, 2.2s later, judged run 33719060817 from 05:29Z the same morning: FRESH.
  const v = corroborateStopped(
    { verdict: 'OVERDUE', newestRunId: 31865853339 },
    { ok: true, verdict: 'FRESH', newestRunId: 33719060817 },
  )
  assert.equal(v.confirmed, false)
  // Both ids must be in the text or a human cannot check which read was the liar.
  assert.match(v.reason, /31865853339/)
  assert.match(v.reason, /33719060817/)
})

t('a schedule that has really stopped is still paged — both reads agree', () => {
  // The alarm must survive this fix, or the fix is just a mute button.
  const v = corroborateStopped(
    { verdict: 'OVERDUE', newestRunId: 31865853339 },
    { ok: true, verdict: 'OVERDUE', newestRunId: 31865853339 },
  )
  assert.equal(v.confirmed, true)
  assert.match(v.reason, /seen twice/)
})

t('a removed cron seen twice on the same run still pages', () => {
  const v = corroborateStopped(
    { verdict: 'NO_SCHEDULE', newestRunId: 42 },
    { ok: true, verdict: 'NO_SCHEDULE', newestRunId: 42 },
  )
  assert.equal(v.confirmed, true)
})

t('a confirming read that never came back is not a confirmation', () => {
  // A 403/502/rate-limit on the second call must not be read as agreement. This repo's standing
  // rule: an API blip never reds the hourly monitor.
  const v = corroborateStopped({ verdict: 'OVERDUE', newestRunId: 7 }, { ok: false })
  assert.equal(v.confirmed, false)
  assert.match(v.reason, /did not come back/)
})

t('same newest run but disagreeing verdicts is a dispute, not a confirmation', () => {
  const v = corroborateStopped(
    { verdict: 'OVERDUE', newestRunId: 7 },
    { ok: true, verdict: 'UNPROVEN', newestRunId: 7 },
  )
  assert.equal(v.confirmed, false)
  assert.match(v.reason, /different verdicts/)
})

t('a new scheduled run starting between the two reads is NOT a stopped schedule', () => {
  // The benign race, and it must land on the quiet side: read 1 saw an overdue list, read 2 saw
  // the nightly that just fired. That is a schedule working, arriving late.
  const v = corroborateStopped(
    { verdict: 'OVERDUE', newestRunId: 100 },
    { ok: true, verdict: 'FRESH', newestRunId: 200 },
  )
  assert.equal(v.confirmed, false)
})

t('run ids are compared by value, not by JS type', () => {
  // GitHub ids exceed Number.MAX_SAFE_INTEGER's comfort zone and some clients hand them back as
  // strings. A type mismatch must not silently read as "the two reads disagree" and mute a real
  // stopped gauntlet forever.
  const v = corroborateStopped(
    { verdict: 'OVERDUE', newestRunId: 31865853339 },
    { ok: true, verdict: 'OVERDUE', newestRunId: '31865853339' },
  )
  assert.equal(v.confirmed, true)
})

t('RATCHET: every verdict scheduleFreshness can return is classified somewhere', () => {
  // The spec routes on three sets: FRESH passes, RETIRED/UNPROVEN skip quietly, STOPPED_VERDICTS
  // page. A verdict added to scheduleFreshness and classified nowhere would fall through to
  // "healthy" — which is the exact bug this whole file exists to close. Read the verdicts out of
  // the source so adding one without classifying it fails here.
  const src = readFileSync(new URL('../scripts/lib/gauntlet-staleness.mjs', import.meta.url), 'utf8')
  const body = src.slice(src.indexOf('export function scheduleFreshness'))
  const returned = new Set([...body.matchAll(/verdict:\s*'([A-Z_]+)'/g)].map((m) => m[1]))
  assert.ok(returned.size >= 5, `expected the real verdict set, found ${[...returned].join(',')}`)
  const classified = new Set(['FRESH', 'RETIRED', 'UNPROVEN', ...STOPPED_VERDICTS])
  const orphans = [...returned].filter((v) => !classified.has(v))
  assert.deepEqual(orphans, [], `unclassified freshness verdict(s): ${orphans.join(', ')}`)
})

t('STOPPED_VERDICTS does not quietly swallow the healthy or quiet verdicts', () => {
  for (const v of ['FRESH', 'RETIRED', 'UNPROVEN']) {
    assert.ok(!STOPPED_VERDICTS.includes(v), `${v} must never be treated as a page`)
  }
})

console.log('\n' + n + ' passed')
