// Roger, 2026-09-03: "we still have an issue if this is still going on. This was the reason why we
// used the PC in the first place, because it's more capable, or am I mistaken here?"
//
// He was mistaken about the cause and right about the gap: every check we had asked whether a
// runner is PRESENT, none asked whether the work is MOVING. Each case below is written so a
// presence-only check would pass it.
//
// The regression that matters most is the FIRST version of this file, which shipped and was wrong
// within four minutes: it compared queued jobs against the FLEET's busy runners and called a real
// Valrano backlog "not a capacity problem" because 22 runners were idle in other repositories.
// A runner belongs to one repository. The last two tests exist so that cannot come back.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { auditRunnerSaturation } from '../scripts/lib/runner-saturation.mjs'

const on = (busy = false) => ({ status: 'online', busy })
const off = () => ({ status: 'offline', busy: false })

test('a fleet with nothing waiting says nothing, however busy it is', () => {
  const { alerts, busy, online } = auditRunnerSaturation({
    perRepo: [{ repo: 'cockpit', runners: [on(true), on(true), on(true)] }],
    queuedOurs: { cockpit: 0 },
  })
  assert.deepEqual(alerts, [], 'busy is not a problem - waiting is')
  assert.equal(busy, 3)
  assert.equal(online, 3)
})

test('a repository whose own runners are all busy while its jobs wait is out of capacity', () => {
  const { alerts } = auditRunnerSaturation({
    perRepo: [{ repo: 'Valrano', runners: [on(true), on(true)] }],
    queuedOurs: { Valrano: 2 },
  })
  assert.equal(alerts.length, 1)
  assert.match(alerts[0], /CI IS SATURATED: Valrano has 2 job\(s\) waiting/)
  assert.match(alerts[0], /all 2 of its own runners are busy/)
  assert.match(alerts[0], /NOT Roger's work PC/, 'the alert must close the door it was written for')
})

// THE REGRESSION. This is the exact live shape that caught the first version out: Valrano full,
// the rest of the fleet idle. A fleet-wide denominator reports "not a capacity problem" here.
test('idle runners in OTHER repositories never excuse a full one', () => {
  const { alerts } = auditRunnerSaturation({
    perRepo: [
      { repo: 'Valrano', runners: [on(true), on(true)] },
      { repo: 'cockpit', runners: [on(false), on(false)] },
      { repo: 'backoffice', runners: [on(false), on(false), on(false)] },
    ],
    queuedOurs: { Valrano: 2 },
  })
  assert.equal(alerts.length, 1, 'only the full repository has anything wrong with it')
  assert.match(alerts[0], /SATURATED/,
    '22 idle runners in other repositories cannot take Valrano work - a runner belongs to ONE repo')
  assert.doesNotMatch(alerts[0], /more hardware would fix nothing/)
})

test('jobs waiting while that repository own runners sit idle is the opposite problem', () => {
  const { alerts } = auditRunnerSaturation({
    perRepo: [{ repo: 'cockpit', runners: [on(false), on(false), on(false), on(false)] }],
    queuedOurs: { cockpit: 2 },
  })
  assert.equal(alerts.length, 1)
  assert.match(alerts[0], /OWN RUNNERS ARE IDLE/)
  assert.match(alerts[0], /more hardware would fix nothing/)
  assert.doesNotMatch(alerts[0], /SATURATED/, 'adding a machine here would fix nothing')
})

test('offline runners are not counted as capacity we have', () => {
  const { online, alerts } = auditRunnerSaturation({
    perRepo: [{ repo: 'cockpit', runners: [on(true), off(), off()] }],
    queuedOurs: { cockpit: 1 },
  })
  assert.equal(online, 1, 'an offline runner cannot take a job')
  assert.match(alerts[0], /CI IS SATURATED/, '1 of 1 busy with a job waiting IS full')
})

test('a repository with no runners at all is a registration problem, not a capacity one', () => {
  const { alerts } = auditRunnerSaturation({
    perRepo: [{ repo: 'cockpit', runners: [] }],
    queuedOurs: { cockpit: 1 },
  })
  assert.equal(alerts.length, 1)
  assert.match(alerts[0], /OWN RUNNERS ARE IDLE/)
  assert.match(alerts[0], /no runner registered at all/)
})
