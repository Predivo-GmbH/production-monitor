// The regression this suite exists for: on 2026-09-01 a session installed persistent things
// (24 runner services + a scheduled task) on Roger's machine and nothing recorded it. This diff
// is the detection backstop. Every case pins a way the check must NOT quietly say "all clear".

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diffPersistence } from './machine-persistence.mjs'

const M = 'DESKTOP-124K6MV'

// A realistic-enough "known good" machine: it always has some tasks and services.
const baseline = {
  scheduledTasks: ['\\Microsoft\\Windows\\UpdateOrchestrator\\Reboot', '\\GoogleUpdateTaskMachineCore'],
  services: ['Dhcp', 'Dnscache', 'wuauserv'],
  startup: ['OneDrive :: C:\\Program Files\\OneDrive.exe'],
}

test('an unchanged machine is quiet', () => {
  const { alerts, added, brokenReason } = diffPersistence(baseline, baseline, { machine: M })
  assert.equal(brokenReason, null)
  assert.deepEqual(alerts, [])
  assert.deepEqual(added.scheduledTasks, [])
})

test('THE 2026-09-01 SHAPE: a scheduled task appears out of band and is named with how to remove it', () => {
  const current = {
    ...baseline,
    scheduledTasks: [...baseline.scheduledTasks, '\\GitHubRunner'],
  }
  const { added, alerts } = diffPersistence(current === baseline ? {} : baseline, current, { machine: M })
  assert.deepEqual(added.scheduledTasks, ['\\GitHubRunner'])
  assert.equal(alerts.length, 1)
  assert.match(alerts[0], /NEW scheduled task on DESKTOP-124K6MV: "\\GitHubRunner"/)
  assert.match(alerts[0], /schtasks \/delete \/tn "\\GitHubRunner" \/f/)
})

test('a new service is reported with sc delete, the way you would undo it', () => {
  const current = { ...baseline, services: [...baseline.services, 'actions.runner.Predivo-GmbH.cockpit'] }
  const { added, alerts } = diffPersistence(baseline, current, { machine: M })
  assert.deepEqual(added.services, ['actions.runner.Predivo-GmbH.cockpit'])
  assert.match(alerts[0], /NEW service on DESKTOP-124K6MV/)
  assert.match(alerts[0], /sc delete "actions\.runner\.Predivo-GmbH\.cockpit"/)
})

test('a new Run-key / Startup item is reported', () => {
  const current = { ...baseline, startup: [...baseline.startup, 'Agent :: C:\\a.exe'] }
  const { added, alerts } = diffPersistence(baseline, current, { machine: M })
  assert.deepEqual(added.startup, ['Agent :: C:\\a.exe'])
  assert.match(alerts[0], /NEW auto-start item on DESKTOP-124K6MV/)
})

test('several new things at once are all named, not summarised away', () => {
  const current = {
    scheduledTasks: [...baseline.scheduledTasks, '\\A', '\\B'],
    services: [...baseline.services, 'svcX'],
    startup: [...baseline.startup, 'Y :: y.exe'],
  }
  const { alerts } = diffPersistence(baseline, current, { machine: M })
  assert.equal(alerts.length, 4)
})

test('a removed item is recorded but is not itself an alert — the threat is what APPEARED', () => {
  const current = { ...baseline, services: baseline.services.filter((s) => s !== 'wuauserv') }
  const { added, removed, alerts } = diffPersistence(baseline, current, { machine: M })
  assert.deepEqual(removed.services, ['wuauserv'])
  assert.deepEqual(added.services, [])
  assert.deepEqual(alerts, [])
})

test('ABSENCE IS NOT SUCCESS: an empty current snapshot is a broken capture, never a clean machine', () => {
  const { alerts, brokenReason } = diffPersistence(baseline, { scheduledTasks: [], services: [], startup: [] }, { machine: M })
  assert.equal(brokenReason, 'empty current snapshot')
  assert.equal(alerts.length, 1)
  assert.match(alerts[0], /CAPTURE FAILED on DESKTOP-124K6MV/)
  assert.match(alerts[0], /NOT a clean machine/)
})

test('no baseline says so once, instead of flagging every item as new', () => {
  const current = { scheduledTasks: ['\\A', '\\B', '\\C'], services: ['s1', 's2'], startup: [] }
  const { alerts, brokenReason, added } = diffPersistence({ scheduledTasks: [], services: [], startup: [] }, current, { machine: M })
  assert.equal(brokenReason, 'no baseline')
  assert.equal(alerts.length, 1, 'one instruction to record a baseline, not five false "new" lines')
  assert.match(alerts[0], /NO BASELINE for DESKTOP-124K6MV/)
  assert.match(alerts[0], /--record/)
  assert.deepEqual(added.scheduledTasks, [])
})

test('the ignore list suppresses known self-churning names but nothing else', () => {
  const current = {
    ...baseline,
    // A Windows Update task carries a rotating GUID; it appears "new" every scan and is not a session.
    scheduledTasks: [...baseline.scheduledTasks, '\\Microsoft\\Windows\\.NET Framework\\.NET-4a1b2c3d', '\\GitHubRunner'],
  }
  const { added } = diffPersistence(baseline, current, {
    machine: M,
    ignore: ['\\\\Microsoft\\\\Windows\\\\\\.NET Framework\\\\'],
  })
  // The GUID task is ignored; the runner task is NOT — an ignore hole must be narrow.
  assert.deepEqual(added.scheduledTasks, ['\\GitHubRunner'])
})
