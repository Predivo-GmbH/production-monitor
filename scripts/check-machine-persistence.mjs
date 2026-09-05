#!/usr/bin/env node
/**
 * MACHINE PERSISTENCE AUDIT — the detection backstop for the persistent-install guard.
 *
 * WHY (2026-09-01). A session installed 24 runner services + a scheduled task on Roger's work PC
 * and nothing recorded it; he found it in Task Manager. The PreToolUse guard
 * (ClaudeShared/hooks/persistent-install-guard.js) now refuses to CREATE one through a Claude
 * shell — but it cannot see a thing created out of band. This snapshots the machine's scheduled
 * tasks / services / auto-start items and reports anything present now that was absent from a
 * recorded baseline, through the same findings-file + send-*.mjs alert path the other guards use.
 *
 * USAGE
 *   node scripts/check-machine-persistence.mjs --record   capture THIS machine as the baseline
 *                                                          (a deliberate act — commit the file)
 *   node scripts/check-machine-persistence.mjs            diff against the baseline; exit 1 on any
 *                                                          new persistent thing, so the red run IS
 *                                                          the alert (house pattern)
 *
 * ABSENCE IS NOT SUCCESS. If the capture returns an empty snapshot (a broken read, not a clean
 * machine) or there is no baseline, that is its own loud finding — never a quiet pass.
 */
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { diffPersistence, KINDS } from './lib/machine-persistence.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const BASELINE_FILE = join(HERE, 'machine-persistence-baseline.json')
const MACHINE = process.env.COMPUTERNAME || process.env.HOSTNAME || 'unknown-machine'

// Known self-churning identities that appear "new" on their own and are not a session's doing.
// Every entry is a regex string and a HOLE — keep this list tiny and say why each is safe.
const IGNORE = [
  // Windows creates per-user/per-update tasks with a rotating GUID under these trees.
  '\\\\Microsoft\\\\Windows\\\\(?:UpdateOrchestrator|WindowsUpdate|.NET Framework)\\\\',
]

function ps(script) {
  return execSync(`powershell.exe -NoProfile -NonInteractive -Command "${script.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024 })
}

/** Capture this machine's persistent things. Windows-first (where the incident happened and where
 *  the automations run); a Linux fallback so the script is not broken off-Windows. */
function capture() {
  if (process.platform === 'win32') {
    const out = ps([
      '$ErrorActionPreference=\'Stop\';',
      '$t = @(Get-ScheduledTask | ForEach-Object { ($_.TaskPath + $_.TaskName) });',
      '$s = @(Get-CimInstance Win32_Service | ForEach-Object { $_.Name });',
      '$u = @(Get-CimInstance Win32_StartupCommand | ForEach-Object { \'{0} :: {1}\' -f $_.Name, $_.Command });',
      '[pscustomobject]@{ scheduledTasks=$t; services=$s; startup=$u } | ConvertTo-Json -Compress -Depth 4',
    ].join(' '))
    const j = JSON.parse(out)
    return normalise(j)
  }
  // Linux fallback: enabled systemd units, the user crontab, and enabled sysv/init services.
  const safe = (cmd) => { try { return execSync(cmd, { encoding: 'utf8', timeout: 30000 }) } catch { return '' } }
  const enabled = safe('systemctl list-unit-files --type=service --state=enabled --no-legend 2>/dev/null')
    .split(/\r?\n/).map((l) => l.trim().split(/\s+/)[0]).filter(Boolean)
  const cron = safe('crontab -l 2>/dev/null')
    .split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  return normalise({ scheduledTasks: cron, services: enabled, startup: [] })
}

function normalise(j) {
  const out = {}
  for (const k of KINDS) {
    const v = j[k]
    out[k] = (Array.isArray(v) ? v : v == null ? [] : [v]).map(String).map((s) => s.trim()).filter(Boolean)
  }
  return out
}

function loadBaselineFile() {
  try { return JSON.parse(readFileSync(BASELINE_FILE, 'utf8')) } catch { return {} }
}

// ── --record: write this machine as the trusted baseline ────────────────────────────────────────
if (process.argv.includes('--record')) {
  const snap = capture()
  const counts = KINDS.map((k) => `${k}=${snap[k].length}`).join(', ')
  if (snap.scheduledTasks.length === 0 && snap.services.length === 0) {
    console.error(`::error::refusing to record an empty baseline for ${MACHINE} (${counts}) — the capture failed`)
    process.exit(1)
  }
  const all = loadBaselineFile()
  all[MACHINE] = { ...snap, recorded_at: new Date().toISOString() }
  writeFileSync(BASELINE_FILE, JSON.stringify(all, null, 2) + '\n')
  console.log(`baseline recorded for ${MACHINE}: ${counts}`)
  console.log(`written to ${BASELINE_FILE} — commit it.`)
  process.exit(0)
}

// ── default: diff against the baseline and alert on anything new ──────────────────────────────────
const current = capture()
const baseline = loadBaselineFile()[MACHINE] || null
const { added, removed, alerts, brokenReason } = diffPersistence(baseline, current, { ignore: IGNORE, machine: MACHINE })

writeFileSync(join(process.cwd(), 'machine-persistence-findings.json'), JSON.stringify({
  generated_at: new Date().toISOString(),
  machine: MACHINE,
  broken_reason: brokenReason,
  counts: Object.fromEntries(KINDS.map((k) => [k, current[k].length])),
  added,
  removed,
  findings: alerts,
}, null, 2))

if (!alerts.length) {
  console.log(`machine-persistence: PASS — ${MACHINE} has nothing on it that was not in the baseline.`)
  for (const k of KINDS) console.log(`  ${k.padEnd(15)}: ${current[k].length}`)
  process.exit(0)
}
for (const a of alerts) console.log(`::warning::${a}`)
console.log(`\nmachine-persistence: ATTENTION on ${MACHINE} (${alerts.length})`)
// Exit 1 so the red run IS the alert, same model as the other fleet guards.
process.exit(1)
