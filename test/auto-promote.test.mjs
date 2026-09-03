// Roger approved this on 2026-09-03 with "Yes - auto-promote internal", after his deploy page
// spent the day showing rows that said "Promoting it is mine, not yours" while nothing promoted
// them. This code can ship to production with nobody present, so every test below is about a
// reason to REFUSE. The one that matters most is the first: a customer-facing product must never
// be shipped by a machine, because that is still his word and only his.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  decide, pickOne, isAutoPromotable, isAppDeployRun, pipelineFor,
  AUTO_PROMOTABLE, REQUIRED_STAGING_JOBS, PIPELINES,
} from '../scripts/lib/auto-promote.mjs'

const green = { 'deploy-staging': 'success', 'e2e-staging': 'success' }
// refHeadSha === stagingSha: the branch tip IS the commit whose gates were proven. Anything else
// means the promoter would ship one commit while citing another - see the tests at the bottom.
const ok = (o = {}) => ({
  repo: 'backoffice', prodSha: 'aaaaaaa', stagingSha: 'bbbbbbb', refHeadSha: 'bbbbbbb',
  compareStatus: 'ahead', stagingJobs: green, fleetBusy: false, ...o,
})

test('THE LINE THAT MUST NOT MOVE: no customer-facing product is ever auto-promoted', () => {
  for (const repo of ['ReplyFlow', 'SignalScore', 'ChannelMover', 'ScoutCopilot', 'Valrano', 'arivioo', 'predivo']) {
    const d = decide(ok({ repo }))
    assert.equal(d.promote, false, `${repo} must never auto-promote`)
    assert.match(d.reason, /Roger's word/)
  }
})

test('an UNKNOWN product is refused - the list is an allowlist, not a blocklist', () => {
  for (const repo of ['brand-new-thing', '', undefined, 'backoffice-legacy', 'cockpit-www']) {
    assert.equal(decide(ok({ repo })).promote, false, `${String(repo)} must be refused`)
  }
})

test('the three Roger named ARE promotable when everything is green', () => {
  for (const repo of ['backoffice', 'cockpit', 'distribution-os']) {
    const d = decide(ok({ repo }))
    assert.equal(d.promote, true, `${repo}: ${d.reason}`)
  }
})

test('matching survives the owner prefix and casing', () => {
  assert.equal(isAutoPromotable('Predivo-GmbH/BackOffice'), true)
  assert.equal(isAutoPromotable('predivo-gmbh/DISTRIBUTION-OS'), true)
  assert.equal(isAutoPromotable('Predivo-GmbH/ReplyFlow'), false)
})

test('the allowlist stays exactly the three he named', () => {
  assert.deepEqual([...AUTO_PROMOTABLE].sort(), ['backoffice', 'cockpit', 'distribution-os'])
})

// ── every condition is a reason to refuse ──────────────────────────────────────────────────────
test('DIVERGED is never promoted - a promotion ships nothing and widens the split', () => {
  const d = decide(ok({ compareStatus: 'diverged' }))
  assert.equal(d.promote, false)
  assert.match(d.reason, /needs merging, not promoting/)
})

test('a fleet deploy in flight refuses - they share one host, and that cost 45 minutes once', () => {
  const d = decide(ok({ fleetBusy: true }))
  assert.equal(d.promote, false)
  assert.match(d.reason, /one at a time/)
})

test('an unreadable deployed state refuses rather than shipping blind', () => {
  assert.equal(decide(ok({ prodSha: null })).promote, false)
  assert.equal(decide(ok({ stagingSha: null })).promote, false)
  assert.match(decide(ok({ prodSha: null })).reason, /refusing to ship blind/)
})

test('an unreadable compare refuses too - "I could not check" is not "it is fine"', () => {
  for (const status of [null, undefined, 'weird']) {
    assert.equal(decide(ok({ compareStatus: status })).promote, false, `compare=${String(status)}`)
  }
})

test('nothing to promote when production already has the commit', () => {
  const d = decide(ok({ prodSha: 'ccc', stagingSha: 'ccc' }))
  assert.equal(d.promote, false)
  assert.match(d.reason, /already has it/)
})

test('DIRECTION: "behind" is REFUSED - staging behind production means nothing to promote', () => {
  // The compare is prod...staging, so "behind" = staging is behind production, i.e. production
  // already holds newer code. Promoting here would ship main HEAD the staging run never covered.
  const d = decide(ok({ compareStatus: 'behind' }))
  assert.equal(d.promote, false)
  assert.match(d.reason, /already ahead of staging/)
})

test('DIRECTION: only "ahead" promotes - staging ahead of production is the real promote case', () => {
  assert.equal(decide(ok({ compareStatus: 'ahead' })).promote, true)
})

test('THE FULL GATE SET, on the exact commit - a missing job is a refusal, not a pass', () => {
  for (const name of REQUIRED_STAGING_JOBS) {
    const jobs = { ...green }
    delete jobs[name]
    const d = decide(ok({ stagingJobs: jobs }))
    assert.equal(d.promote, false, `missing ${name} must refuse`)
    assert.match(d.reason, /missing, not success/)
  }
})

test('a skipped or failed gate refuses - "not failure" is not "success"', () => {
  for (const conclusion of ['skipped', 'failure', 'cancelled', 'neutral', null]) {
    const d = decide(ok({ stagingJobs: { ...green, 'e2e-staging': conclusion } }))
    assert.equal(d.promote, false, `e2e-staging=${String(conclusion)} must refuse`)
  }
})

test('no stagingJobs at all refuses', () => {
  assert.equal(decide(ok({ stagingJobs: undefined })).promote, false)
  assert.equal(decide(ok({ stagingJobs: {} })).promote, false)
})

test('junk in does not throw and does not promote', () => {
  for (const p of [undefined, null, {}, { repo: 'backoffice' }]) {
    assert.equal(decide(p).promote, false)
  }
})

// ── one at a time ──────────────────────────────────────────────────────────────────────────────
test('AT MOST ONE promotion per run, even when several qualify', () => {
  const all = ['backoffice', 'cockpit', 'distribution-os'].map((repo) => decide(ok({ repo })))
  assert.equal(all.filter((d) => d.promote).length, 3, 'all three qualify in this fixture')
  const picked = pickOne(all)
  assert.ok(picked && picked.promote, 'one is picked')
  assert.match(picked.reason, /^backoffice:/, 'the first qualifying one')
})

test('pickOne returns null when nothing qualifies, rather than something falsy-but-shaped', () => {
  assert.equal(pickOne([decide(ok({ repo: 'ReplyFlow' }))]), null)
  assert.equal(pickOne([]), null)
  assert.equal(pickOne(undefined), null)
})

test('the reason always names the product, so a log line is readable on its own', () => {
  for (const d of [decide(ok()), decide(ok({ repo: 'ReplyFlow' })), decide(ok({ fleetBusy: true }))]) {
    assert.match(d.reason, /^[A-Za-z-]+:/)
  }
})

// ── THE PROOF AND THE ACTION MUST BE ABOUT THE SAME THING (all four found 2026-09-03 21:40Z) ────
// Every test below is a measured production defect, not a hypothetical. The promoter guessed four
// separate facts about a product - which pipeline is production, which workflow to dispatch, which
// branch, which commit - and each guess could name something other than what it was reasoning
// about. The cockpit exit-1 that reddened the monitor hourly was the LOUD one; the backoffice
// false all-clear was the dangerous one.

test('SHIP ONLY WHAT YOU PROVED: a branch tip past the gated commit refuses', () => {
  // Measured: cockpit gated cc4935e while main stood at 5bf29fd; backoffice gated 9803714 while
  // main stood at 046d045. A dispatch takes a BRANCH, so both would have shipped a commit no gate
  // in this file had looked at, under a log line naming the gated one.
  const d = decide(ok({ stagingSha: 'cc4935e', refHeadSha: '5bf29fd' }))
  assert.equal(d.promote, false)
  assert.match(d.reason, /the proven commit is not the one that would ship/)
  assert.match(d.reason, /cc4935e/, 'names the commit that was proven')
  assert.match(d.reason, /5bf29fd/, 'and the different one that would actually go out')
})

test('an UNKNOWN branch tip refuses - not knowing what would ship is not permission to ship', () => {
  for (const v of [null, undefined, '']) {
    const d = decide(ok({ refHeadSha: v }))
    assert.equal(d.promote, false, `refHeadSha=${String(v)} must refuse`)
    assert.match(d.reason, /whose tip is unknown/)
  }
})

test('it still promotes when the tip IS the proven commit - the gate is not a blanket no', () => {
  assert.equal(decide(ok({ stagingSha: 'abc1234', refHeadSha: 'abc1234' })).promote, true)
})

test('AN EDGE-FUNCTIONS RUN IS NOT AN APP DEPLOY, though its job is also called "deploy"', () => {
  // The impostor that made backoffice read 9803714 (edge) instead of 6f35d6c (its own deploy.yml)
  // and Distribution-OS read 465ce6e instead of 7444255.
  assert.equal(isAppDeployRun('Deploy edge functions'), false)
  assert.equal(isAppDeployRun('deploy edge functions'), false)
  // ...while every real app-deploy run name in this fleet still matches. Measured across all nine
  // repos on 2026-09-03: these are the actual run names, and none of their shas changed.
  for (const name of ['Deploy', 'Deploy to Production', 'Deploy to Staging', 'Deploy Portal']) {
    assert.equal(isAppDeployRun(name), true, `${name} is a real app deploy and must still match`)
  }
  assert.equal(isAppDeployRun(''), false)
  assert.equal(isAppDeployRun(undefined), false)
})

test('THE PIPELINE IS PINNED TO A FILE, so evidence and dispatch cannot name different workflows', () => {
  // Cockpit is why: "Deploy" and "Deploy Portal" are both active and both match /deploy/i without
  // staging|edge|nightly, so the old name-matcher found two, refused, and exited 1 - reddening the
  // hourly monitor forever. "Deploy Portal" is a different application (client-portal ->
  // portal.predivo.ch, job `deploy-portal`), and had it been the only match it would have been
  // DISPATCHED while the log cited deploy.yml's staging gates.
  for (const repo of AUTO_PROMOTABLE) {
    const p = pipelineFor(repo)
    assert.ok(p, `${repo} must have a pinned pipeline or it can never promote`)
    assert.match(p.prod, /\.yml$/, `${repo}.prod must be a workflow FILE, not a name pattern`)
    assert.match(p.staging, /\.yml$/)
    assert.ok(p.ref, `${repo} must pin the branch production ships from`)
  }
})

test('THE BRANCH IS PER-PRODUCT: Distribution-OS is master, and "main" would have 422d forever', () => {
  // Verified against each repo's own default_branch on 2026-09-03.
  assert.equal(pipelineFor('distribution-os').ref, 'master')
  assert.equal(pipelineFor('backoffice').ref, 'main')
  assert.equal(pipelineFor('cockpit').ref, 'main')
})

test('Distribution-OS gates in a DIFFERENT file than it ships from, and the map says so', () => {
  const p = pipelineFor('distribution-os')
  assert.equal(p.prod, 'deploy.yml')
  assert.equal(p.staging, 'deploy-staging.yml')
  assert.notEqual(p.prod, p.staging, 'reading its staging gates out of deploy.yml would find none')
})

test('a product with no pinned pipeline is refused, like one absent from the allowlist', () => {
  for (const repo of ['ReplyFlow', 'brand-new-thing', '', undefined]) {
    assert.equal(pipelineFor(repo), null, `${String(repo)} must not resolve to a pipeline`)
  }
})

test('EVERY promotable product has a pipeline - the two lists cannot drift apart', () => {
  // Adding a name to AUTO_PROMOTABLE without pinning its pipeline would make it silently
  // unpromotable; pinning one not on the allowlist would imply a product may ship that may not.
  assert.deepEqual(Object.keys(PIPELINES).sort(), [...AUTO_PROMOTABLE].sort())
})

test('pipeline matching survives the owner prefix and casing, like the allowlist', () => {
  assert.equal(pipelineFor('Predivo-GmbH/BackOffice').ref, 'main')
  assert.equal(pipelineFor('predivo-gmbh/DISTRIBUTION-OS').ref, 'master')
})
