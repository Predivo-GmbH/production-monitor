// Roger, 2026-09-03: "we still have an issue if this is still going on. This was the reason why we
// used the PC in the first place, because it's more capable, or am I mistaken here?"
//
// He was mistaken about the cause and right about the gap: every check we had asked whether a
// runner is PRESENT, none asked whether work is WAITING. Each case below is written so a
// presence-only check would pass it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { auditRunnerSaturation, busyFraction } from '../scripts/lib/runner-saturation.mjs'

const on = (busy = false) => ({ status: 'online', busy })
const off = () => ({ status: 'offline', busy: false })

test('a fleet with nothing waiting says nothing, however busy it is', () => {
  const { alerts, busy, online } = auditRunnerSaturation({
    perRepo: [{ repo: 'cockpit', runners: [on(true), on(true), on(true)] }],
    queued: { cockpit: 0 },
  })
  assert.deepEqual(alerts, [], 'busy is not a problem - waiting is')
  assert.equal(busy, 3)
  assert.equal(online, 3)
})

test('jobs waiting while the runners are full is reported as being out of capacity', () => {
  const { alerts } = auditRunnerSaturation({
    perRepo: [{ repo: 'cockpit', runners: [on(true), on(true)] },
              { repo: 'replyflow', runners: [on(true), on(true)] }],
    queued: { cockpit: 3, replyflow: 1 },
  })
  assert.equal(alerts.length, 1)
  assert.match(alerts[0], /CI IS SATURATED/)
  assert.match(alerts[0], /4 job\(s\) are waiting/)
  assert.match(alerts[0], /cockpit \(3\)/)
  assert.match(alerts[0], /NOT Roger's work PC/, 'the alert must close the door it was written for')
})

test('jobs waiting while runners sit idle is the opposite problem and must not read as capacity', () => {
  const { alerts } = auditRunnerSaturation({
    perRepo: [{ repo: 'cockpit', runners: [on(false), on(false), on(false), on(false)] }],
    queued: { cockpit: 2 },
  })
  assert.equal(alerts.length, 1)
  assert.match(alerts[0], /JOBS QUEUED WHILE RUNNERS ARE IDLE/)
  assert.match(alerts[0], /more hardware would not fix it/)
  assert.doesNotMatch(alerts[0], /SATURATED/, 'adding a machine here would fix nothing')
})

test('offline runners are not counted as capacity we have', () => {
  const { busy, online, alerts } = auditRunnerSaturation({
    perRepo: [{ repo: 'cockpit', runners: [on(true), off(), off()] }],
    queued: { cockpit: 1 },
  })
  assert.equal(online, 1, 'an offline runner cannot take a job')
  assert.equal(busy, 1)
  assert.match(alerts[0], /CI IS SATURATED/, '1 of 1 busy with a job waiting IS full')
})

test('a fleet with no runners at all does not divide by zero and does not claim to be full', () => {
  assert.equal(busyFraction({ busy: 0, total: 0 }), 0)
  const { alerts } = auditRunnerSaturation({ perRepo: [{ repo: 'cockpit', runners: [] }], queued: { cockpit: 1 } })
  assert.equal(alerts.length, 1)
  assert.match(alerts[0], /JOBS QUEUED WHILE RUNNERS ARE IDLE/,
    'no runners is a registration problem, not a capacity one - the existing checks already cover it')
})
