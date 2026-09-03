// Roger approved this on 2026-09-03 with "Yes - auto-promote internal", after his deploy page
// spent the day showing rows that said "Promoting it is mine, not yours" while nothing promoted
// them. This code can ship to production with nobody present, so every test below is about a
// reason to REFUSE. The one that matters most is the first: a customer-facing product must never
// be shipped by a machine, because that is still his word and only his.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decide, pickOne, isAutoPromotable, AUTO_PROMOTABLE, REQUIRED_STAGING_JOBS } from '../scripts/lib/auto-promote.mjs'

const green = { 'deploy-staging': 'success', 'e2e-staging': 'success' }
const ok = (o = {}) => ({
  repo: 'backoffice', prodSha: 'aaaaaaa', stagingSha: 'bbbbbbb',
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
