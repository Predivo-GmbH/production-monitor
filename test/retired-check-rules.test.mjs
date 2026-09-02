#!/usr/bin/env node
/**
 * The retirement rule, offline. No network, no credential, no healthchecks account.
 *
 * The live suite (`a-retired-job-stays-quiet.test.mjs`) can only run where a key exists, and it
 * SKIPS everywhere else — so on a laptop with no key the rule itself was never exercised at all.
 * This file exercises it against made-up checks, which means the case that matters most can be
 * tested on demand instead of waiting for a job to die: A PAUSED ALARM OVER A JOB THAT HAS ALREADY
 * STOPPED. That is the one the previous rule reported as fine.
 *
 *   node test/retired-check-rules.test.mjs
 */
import assert from 'node:assert'
import { auditRetirement, keyOf } from '../scripts/lib/retired-check-rules.mjs'

let n = 0
const ok = (m) => { console.log('  ok   -', m); n++ }

const HOUR = 3600 * 1000
const NOW = Date.parse('2026-09-02T19:00:00Z')
const ago = (h) => new Date(NOW - h * HOUR).toISOString()

const RETIRED = [{ check: 'kb-learning-phase0', job: 'KB Phase0 Daily', why: 'Retired 2026-08-27.' }]
// Blocks that exercise the "nothing declared it" rule declare NOTHING, so the only thing under test
// is the paused check in front of us — otherwise every fixture also trips the missing-declaration rule.
const NONE = []
const kinds = (f) => f.map((x) => `${x.kind}:${x.check}`).sort()

// ---------------------------------------------------------------- the healthy fleet
{
  const checks = [
    { slug: 'kb-learning-phase0', status: 'paused', last_ping: ago(150) },
    { slug: 'production-monitor-hourly', status: 'up', last_ping: ago(1) },
    { slug: 'something-late', status: 'grace', last_ping: ago(2) },
    { slug: 'something-broken', status: 'down', last_ping: ago(40) },
  ]
  assert.deepEqual(auditRetirement(checks, RETIRED), [])
  ok('a declared retirement that is paused is accepted, and up/grace/down are never this rule\'s business')
}

// ---------------------------------------------------------------- THE REGRESSION
// The old rule was `paused && last_ping within 36h`. Both checks below are paused with their alarm
// off; the only difference is whether the job behind them is still breathing. The old rule caught
// the first and cleared the second. The second is the disaster.
{
  const alive = [{ slug: 'knowledge-apply-loop', status: 'paused', last_ping: ago(6) }]
  const dead = [{ slug: 'knowledge-apply-loop', status: 'paused', last_ping: ago(400) }]
  const neverRan = [{ slug: 'knowledge-apply-loop', status: 'paused', last_ping: null }]

  assert.deepEqual(kinds(auditRetirement(alive, NONE)), ['undeclared:knowledge-apply-loop'])
  ok('paused + job pinged 6h ago -> finding (the case the old rule already caught)')

  assert.deepEqual(kinds(auditRetirement(dead, NONE)), ['undeclared:knowledge-apply-loop'])
  ok('THE HOLE: paused + job silent for 400h -> STILL a finding, where the old 36h rule went green')

  assert.deepEqual(kinds(auditRetirement(neverRan, NONE)), ['undeclared:knowledge-apply-loop'])
  ok('paused + never pinged at all -> still a finding, no last_ping to lean on')

  const msg = auditRetirement(dead, NONE)[0].message
  assert.match(msg, /cannot go down/)
  assert.match(msg, /resume the check|add it to RETIRED/)
  ok('the message names the consequence and BOTH ways out, so it can never be cleared by waiting')
}

// ---------------------------------------------------------------- time cannot fix it
{
  const paused = [{ slug: 'knowledge-apply-loop', status: 'paused', last_ping: ago(6) }]
  const first = auditRetirement(paused, NONE)
  const muchLater = auditRetirement(paused, NONE)
  assert.deepEqual(kinds(first), kinds(muchLater))
  assert.equal(auditRetirement(paused, NONE).length, 1)
  ok('the rule takes no clock at all — the same fleet reads the same way forever until somebody acts')
}

// ---------------------------------------------------------------- resuming clears it
{
  const resumed = [{ slug: 'knowledge-apply-loop', status: 'new', n_pings: 50, last_ping: null }]
  assert.deepEqual(auditRetirement(resumed, NONE), [])
  ok('a resumed check sitting at "new" is NOT claimed here — the producer already warns on it hourly')

  const armed = [{ slug: 'knowledge-apply-loop', status: 'up', last_ping: ago(1) }]
  assert.deepEqual(auditRetirement(armed, NONE), [])
  ok('once the job pings and the check goes up, the finding is gone for the right reason')
}

// ---------------------------------------------------------------- declaring it clears it too
{
  const paused = [{ slug: 'knowledge-apply-loop', status: 'paused', last_ping: ago(6) }]
  const declared = [{ check: 'knowledge-apply-loop', job: 'KB apply loop', why: 'Retired on purpose.' }]
  assert.deepEqual(auditRetirement(paused, declared), [])
  ok('writing the retirement down clears it — the decision is recorded, not merely obeyed')
}

// ---------------------------------------------------------------- the declaration must stay true
{
  const rearmed = [{ slug: 'kb-learning-phase0', status: 'up', last_ping: ago(1) }]
  assert.deepEqual(kinds(auditRetirement(rearmed, RETIRED)), ['rearmed:kb-learning-phase0'])
  ok('a retired job whose watch somebody re-armed is reported — that is the nightly false page returning')

  assert.deepEqual(kinds(auditRetirement([], RETIRED)), ['missing:kb-learning-phase0'])
  ok('a retired check that was DELETED is reported — deleting it throws away the record of why')
}

// ---------------------------------------------------------------- several at once
{
  const messy = [
    { slug: 'kb-learning-phase0', status: 'down', last_ping: ago(1) },
    { slug: 'knowledge-apply-loop', status: 'paused', last_ping: ago(400) },
    { slug: 'another-muted-one', status: 'paused', last_ping: null },
  ]
  assert.deepEqual(kinds(auditRetirement(messy, RETIRED)),
    ['rearmed:kb-learning-phase0', 'undeclared:another-muted-one', 'undeclared:knowledge-apply-loop'])
  ok('every offender is named, never just the first — three faults report as three')
}

// ---------------------------------------------------------------- identity
{
  assert.equal(keyOf({ slug: 'my-first-check', name: 'production-monitor (hourly)' }), 'my-first-check')
  assert.equal(keyOf({ name: 'no-slug-here' }), 'no-slug-here')
  const noSlug = [{ name: 'renamed-but-paused', status: 'paused', last_ping: ago(3) }]
  assert.deepEqual(kinds(auditRetirement(noSlug, NONE)), ['undeclared:renamed-but-paused'])
  ok('a check with no slug is matched by name, so it cannot hide from the rule by lacking an id')
}

console.log(`\n${n} passed, 0 failed`)
