// THE BACKSTOP: what persistent things exist on this physical machine that were NOT here when
// we last wrote the machine down?
//
// WHY THIS EXISTS (2026-09-01). A session installed 24 runner services + a scheduled task on
// Roger's work PC. The PreToolUse guard (ClaudeShared/hooks/persistent-install-guard.js) now
// refuses to CREATE one through a Claude tool — but that only covers installs that go through a
// Claude shell. It cannot see a thing created out of band: an installer Roger ran, a service a
// different tool registered, or anything that bypassed the guard. This is the detection half:
// snapshot the machine once (a deliberate `--record`), and thereafter report anything PRESENT
// NOW that was ABSENT from that snapshot, through the alert path that already reaches him.
//
// The rule this encodes is the same one runner-machines.mjs learned: ABSENCE IS NOT SUCCESS, and
// an alert must carry WHAT to do, not just that something changed. A new scheduled task named in
// an alert with no baseline behind it, or with an empty snapshot, is not "all clear" — it is a
// broken capture, and this file makes that its own loud finding instead of a quiet pass.

/**
 * The three kinds of persistence we watch. Each is a flat list of stable string identities.
 *   scheduledTasks : full task path, e.g. "\GitHubRunner" or "\Microsoft\Windows\...\Foo"
 *   services       : service Name, e.g. "actions.runner.Predivo-GmbH.cockpit"
 *   startup        : "<Name> :: <Command>" for a Run key / Startup shortcut
 * A snapshot is { scheduledTasks: string[], services: string[], startup: string[] }.
 */
export const KINDS = ['scheduledTasks', 'services', 'startup']

const LABEL = {
  scheduledTasks: 'scheduled task',
  services: 'service',
  startup: 'auto-start item',
}

// How to remove one of each kind, so the alert tells Roger what to actually do rather than only
// that something appeared. The identity is the task path / service name / startup id.
const REMOVE_HINT = {
  scheduledTasks: (id) => `if you did not create it, remove it: schtasks /delete /tn "${id}" /f`,
  services: (id) => `if you did not create it, remove it: sc delete "${id}"`,
  startup: (id) => 'if you did not add it, delete that Run value / Startup shortcut',
}

function matchesAny(id, patterns) {
  for (const p of patterns) {
    try { if (new RegExp(p).test(id)) return true } catch { if (id.includes(p)) return true }
  }
  return false
}

/**
 * @param {object} baseline  snapshot recorded by `--record` (the machine when it was known good)
 * @param {object} current   snapshot captured this run
 * @param {object} [opts]
 * @param {string[]} [opts.ignore]  identities (regex or substring) that churn on their own and are
 *   not a session's doing — e.g. Windows Update tasks whose names carry a rotating GUID. Kept
 *   deliberately small: every pattern here is a hole, so it names why it is safe.
 * @param {string}   [opts.machine] machine name, so the alert says WHERE.
 * @returns {{ added: object, removed: object, alerts: string[], brokenReason: string|null }}
 */
export function diffPersistence(baseline, current, { ignore = [], machine = 'this machine' } = {}) {
  // A real Windows machine has dozens of scheduled tasks and hundreds of services. A snapshot with
  // none of either did not "find nothing" — the capture failed, and diffing against it would report
  // every baseline item as "removed" and nothing as added, i.e. a false all-clear. Refuse it.
  const currentEmpty = (current?.scheduledTasks?.length || 0) === 0 && (current?.services?.length || 0) === 0
  if (currentEmpty) {
    return {
      added: emptyByKind(), removed: emptyByKind(),
      alerts: [
        `CAPTURE FAILED on ${machine}: the snapshot has no scheduled tasks and no services, which no ` +
        `real machine has. This is a broken read, NOT a clean machine — treat it as unknown, not safe.`,
      ],
      brokenReason: 'empty current snapshot',
    }
  }
  // No baseline is not "nothing changed" — it means we never wrote the machine down, so every item
  // would look new. Say that, once, instead of drowning the reader in hundreds of false "new" lines.
  const baselineEmpty = !baseline || KINDS.every((k) => !(baseline[k]?.length))
  if (baselineEmpty) {
    return {
      added: emptyByKind(), removed: emptyByKind(),
      alerts: [
        `NO BASELINE for ${machine}: nothing to compare against, so a newly-installed persistent thing ` +
        `is invisible here. Record one with \`node scripts/check-machine-persistence.mjs --record\` on a ` +
        `machine you trust right now, commit it, and this check starts watching.`,
      ],
      brokenReason: 'no baseline',
    }
  }

  const added = emptyByKind()
  const removed = emptyByKind()
  const alerts = []

  for (const kind of KINDS) {
    const base = new Set(baseline[kind] || [])
    const cur = new Set(current[kind] || [])
    for (const id of cur) {
      if (base.has(id)) continue
      if (matchesAny(id, ignore)) continue
      added[kind].push(id)
    }
    for (const id of base) {
      if (!cur.has(id)) removed[kind].push(id)
    }
    added[kind].sort()
    removed[kind].sort()
    for (const id of added[kind]) {
      alerts.push(
        `NEW ${LABEL[kind]} on ${machine}: "${id}" — it was not here when the baseline was recorded. ` +
        `A session, an installer, or another tool created it. ${REMOVE_HINT[kind](id)}. ` +
        `If it is meant to be there, re-record the baseline so it stops alerting.`,
      )
    }
  }

  return { added, removed, alerts, brokenReason: null }
}

function emptyByKind() {
  return { scheduledTasks: [], services: [], startup: [] }
}
