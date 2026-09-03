// The regression this suite exists for: on 2026-08-25 all 24 of the office PC's runners had their
// registrations deleted by GitHub. The CI runner watchdog counted ONLINE RUNNERS PER REPOSITORY,
// the laptop's runners kept every repository above zero, and the watchdog reported the fleet
// healthy for a week while half its CI capacity did not exist.
//
// Every case below is written so that the OLD per-repository count would pass it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { machineOf, auditRunnerMachines, loadExpectedMachines, loadRetiredMachines } from '../scripts/lib/runner-machines.mjs'

const EXPECTED = ['DESKTOP-124K6MV', 'LAPTOP-88N97BGG']

const online = (name) => ({ name, status: 'online' })
const offline = (name) => ({ name, status: 'offline' })

test('machineOf reads the machine out of our runner naming convention', () => {
  assert.equal(machineOf('wsl-LAPTOP-88N97BGG-cockpit'), 'LAPTOP-88N97BGG')
  assert.equal(machineOf('wsl-LAPTOP-88N97BGG-cockpit-2'), 'LAPTOP-88N97BGG')
  assert.equal(machineOf('wsl-DESKTOP-124K6MV-distribution-os'), 'DESKTOP-124K6MV')
  assert.equal(machineOf('wsl-DESKTOP-124K6MV-Cursor_Arivioo'), 'DESKTOP-124K6MV')
})

test('machineOf returns null rather than guessing at a name it does not recognise', () => {
  assert.equal(machineOf('some-hosted-runner'), null)
  assert.equal(machineOf('wsl-lowercase-host-cockpit'), null)
  assert.equal(machineOf(''), null)
  assert.equal(machineOf(undefined), null)
})

test('both machines everywhere is quiet', () => {
  const { alerts, machines } = auditRunnerMachines([
    { repo: 'cockpit', runners: [online('wsl-LAPTOP-88N97BGG-cockpit'), online('wsl-DESKTOP-124K6MV-cockpit')] },
    { repo: 'backoffice', runners: [online('wsl-LAPTOP-88N97BGG-backoffice'), online('wsl-DESKTOP-124K6MV-backoffice')] },
  ], { expected: EXPECTED })
  assert.deepEqual(alerts, [])
  assert.deepEqual(machines['LAPTOP-88N97BGG'], ['backoffice', 'cockpit'])
  assert.deepEqual(machines['DESKTOP-124K6MV'], ['backoffice', 'cockpit'])
})

test('THE 2026-08-25 REGRESSION: a whole machine deregistered, every repo still has an online runner', () => {
  // This is the exact shape of the fleet for the week nobody noticed. Every repository has an
  // online runner, so the old per-repository count reported PASS.
  const { alerts } = auditRunnerMachines([
    { repo: 'cockpit', runners: [online('wsl-LAPTOP-88N97BGG-cockpit'), online('wsl-LAPTOP-88N97BGG-cockpit-2')] },
    { repo: 'backoffice', runners: [online('wsl-LAPTOP-88N97BGG-backoffice')] },
    { repo: 'ReplyFlow', runners: [online('wsl-LAPTOP-88N97BGG-ReplyFlow')] },
  ], { expected: EXPECTED })
  assert.equal(alerts.length, 1)
  assert.match(alerts[0], /^MACHINE GONE: DESKTOP-124K6MV has no online runner in ANY repository/)
})

test('a machine that is registered but offline everywhere counts as gone, not as present', () => {
  const { alerts } = auditRunnerMachines([
    { repo: 'cockpit', runners: [online('wsl-LAPTOP-88N97BGG-cockpit'), offline('wsl-DESKTOP-124K6MV-cockpit')] },
  ], { expected: EXPECTED })
  assert.equal(alerts.length, 1)
  assert.match(alerts[0], /MACHINE GONE: DESKTOP-124K6MV/)
})

test('one repository losing a machine is caught even though the machine is alive elsewhere', () => {
  // The partial version of the same failure: cockpit is now a single point of failure and its
  // runner count did not change.
  const { alerts } = auditRunnerMachines([
    { repo: 'cockpit', runners: [online('wsl-LAPTOP-88N97BGG-cockpit')] },
    { repo: 'backoffice', runners: [online('wsl-LAPTOP-88N97BGG-backoffice'), online('wsl-DESKTOP-124K6MV-backoffice')] },
  ], { expected: EXPECTED })
  assert.equal(alerts.length, 1)
  assert.match(alerts[0], /^SINGLE MACHINE: cockpit is served only by LAPTOP-88N97BGG/)
})

test('with only one machine alive we say MACHINE GONE once, not "single machine" for every repo', () => {
  const { alerts } = auditRunnerMachines([
    { repo: 'a', runners: [online('wsl-LAPTOP-88N97BGG-a')] },
    { repo: 'b', runners: [online('wsl-LAPTOP-88N97BGG-b')] },
    { repo: 'c', runners: [online('wsl-LAPTOP-88N97BGG-c')] },
  ], { expected: EXPECTED })
  assert.equal(alerts.length, 1, 'one clear alert beats three that bury it')
  assert.match(alerts[0], /MACHINE GONE/)
})

test('a repository with no runners at all is left alone - it was never migrated', () => {
  const { alerts } = auditRunnerMachines([
    { repo: 'cockpit', runners: [online('wsl-LAPTOP-88N97BGG-cockpit'), online('wsl-DESKTOP-124K6MV-cockpit')] },
    { repo: 'production-monitor', runners: [] },
  ], { expected: EXPECTED })
  assert.deepEqual(alerts, [])
})

test('a runner we cannot attribute is reported, never silently dropped', () => {
  const { alerts, unattributed } = auditRunnerMachines([
    { repo: 'cockpit', runners: [online('wsl-LAPTOP-88N97BGG-cockpit'), online('wsl-DESKTOP-124K6MV-cockpit'), online('mystery-runner')] },
  ], { expected: EXPECTED })
  assert.deepEqual(unattributed, ['cockpit: "mystery-runner"'])
  assert.equal(alerts.length, 1)
  assert.match(alerts[0], /UNREADABLE RUNNER NAME/)
})

test('a machine nobody wrote down is reported rather than quietly accepted', () => {
  const { alerts } = auditRunnerMachines([
    { repo: 'cockpit', runners: [online('wsl-LAPTOP-88N97BGG-cockpit'), online('wsl-DESKTOP-124K6MV-cockpit'), online('wsl-NEWBOX-99AAAAAA-cockpit')] },
  ], { expected: EXPECTED })
  const unknown = alerts.filter((a) => a.startsWith('UNKNOWN MACHINE'))
  assert.equal(unknown.length, 1)
  assert.match(unknown[0], /NEWBOX-99AAAAAA/)
})

test('the baseline file on disk is the one the watchdog will actually use', () => {
  const expected = loadExpectedMachines()
  assert.ok(Array.isArray(expected), 'baseline must be a list of machine names')
  assert.ok(expected.length >= 1, 'the baseline cannot be empty - with no machine listed, a lost machine is invisible')
  for (const m of expected) assert.match(m, /^[A-Z0-9]+-[A-Z0-9]+$/, `baseline entry "${m}" is not a machine name our runners can produce`)
})

// Roger, 2026-09-03: "Everything should be running on the laptop. The work PC is for work only
// and not for anything else." The work PC was retired on 2026-08-25, silently re-registered on
// 2026-09-01 by a session that read its absence as lost capacity, and removed again the same day
// he found out. This test is here so the next session has to argue with him, not with a file.
test('the work PC is not a CI machine and must not reappear in the baseline', () => {
  assert.ok(
    !loadExpectedMachines().includes('DESKTOP-124K6MV'),
    "DESKTOP-124K6MV is Roger's work PC. It must not host runners and must not be in the baseline.",
  )
})


// ---------------------------------------------------------------------------------------------
// 2026-09-03. Removing the work PC from the baseline was only half of it. The alert a future
// session actually READS said "UNKNOWN MACHINE: ... Add it or remove it" - it offered putting the
// machine back as an equally good option, which is precisely what happened on 2026-09-01. The
// decision has to reach the reader, not sit in a file the alerting code never opens.
const RETIRED = [{ machine: 'DESKTOP-124K6MV', decided: '2026-08-25', why: 'It is the work PC Roger uses, not a CI host.' }]
const ONE = ['LAPTOP-88N97BGG']

test('runners on a retired machine are an instruction to DELETE, never "add it or remove it"', () => {
  const { alerts } = auditRunnerMachines([
    { repo: 'cockpit', runners: [online('wsl-LAPTOP-88N97BGG-cockpit'), online('wsl-DESKTOP-124K6MV-cockpit')] },
  ], { expected: ONE, retired: RETIRED })
  const retired = alerts.filter((a) => a.startsWith('RETIRED MACHINE'))
  assert.equal(retired.length, 1)
  assert.match(retired[0], /DELETE those runners/)
  assert.match(retired[0], /Do NOT add DESKTOP-124K6MV to the baseline/)
  assert.match(retired[0], /work PC/, 'the alert must carry WHY, or the next reader re-decides it')
  assert.equal(alerts.filter((a) => a.startsWith('UNKNOWN MACHINE')).length, 0,
    'a retired machine must never be reported with the ambiguous "add it or remove it" wording')
})

test('a retired machine does not count as alive, so removing it raises no single-machine noise', () => {
  const { alerts } = auditRunnerMachines([
    { repo: 'cockpit', runners: [online('wsl-LAPTOP-88N97BGG-cockpit'), online('wsl-DESKTOP-124K6MV-cockpit')] },
    { repo: 'predivo', runners: [online('wsl-LAPTOP-88N97BGG-predivo')] },
  ], { expected: ONE, retired: RETIRED })
  assert.equal(alerts.filter((a) => a.startsWith('SINGLE MACHINE')).length, 0,
    'one real machine plus one retired one is the correct state, not 14 repositories of noise')
  assert.equal(alerts.length, 1, 'the only thing worth saying is: delete those runners')
})

test('a machine that is genuinely new is still reported the old way', () => {
  const { alerts } = auditRunnerMachines([
    { repo: 'cockpit', runners: [online('wsl-LAPTOP-88N97BGG-cockpit'), online('wsl-NEWBOX-99AAAAAA-cockpit')] },
  ], { expected: ONE, retired: RETIRED })
  const unknown = alerts.filter((a) => a.startsWith('UNKNOWN MACHINE'))
  assert.equal(unknown.length, 1)
  assert.match(unknown[0], /NEWBOX-99AAAAAA/)
})

test('the retired list on disk names the work PC and says why, not just that', () => {
  const retired = loadRetiredMachines()
  const desk = retired.find((r) => r.machine === 'DESKTOP-124K6MV')
  assert.ok(desk, "DESKTOP-124K6MV must be in `retired`: absence with no recorded reason is what a monitor reads as failure")
  assert.ok((desk.why || '').length > 40, 'a retired entry without a reason teaches the next reader nothing')
  assert.ok(desk.decided, 'record WHEN it was decided, so a later session can see it is not stale drift')
})
