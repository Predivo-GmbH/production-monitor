/**
 * THE MACHINE THAT RUNS THE JOBS PUBLISHES WHAT IT WILL DO NEXT.
 *
 * Roger, 2026-09-05: "when are you going to pick up? what's next? what's going on?" — the board
 * could not answer, because nothing on it knew the schedule. Measured that morning: the jobs table
 * (`automation-jobs.mjs`) carries no schedule field and the generated job list carries names only.
 * The only truthful source is the laptop's own Task Scheduler, so the laptop reports it — every
 * 30 minutes, from inside the lane advancer, which already runs then. One task, no new job.
 *
 * A row nobody refreshed for 65 minutes reads as STALE on the page (sql/106), so a dead publisher
 * cannot leave a next-run time that has already passed looking like it is still coming.
 *
 * Pure parsing is exported and tested; the two edges (PowerShell, PostgREST) are injected.
 */
import { execFileSync } from 'node:child_process'
import { hostname } from 'node:os'

/** Only the tasks that touch the board or feed it. Everything else on the laptop is not "Claude". */
export const BOARD_TASK_PATTERN = /Board|Closer|Night|Drainer|Advancer|Verify Sweep|Triage|Inbox|Brain|KB|Commit|Measure|Monthly|Autofix|Engine|Google Issues|Work On It/i

// ONE BAD TASK MUST NOT BLANK THE SCHEDULE. The first two real runs on the laptop failed inside
// this script: a Windows task reports LastTaskResult 2147943568, which overflows an [int] cast and
// throws, and a throw anywhere ended the whole read with exit 1. So each task is read inside its own
// try, the result is a [long], and a task that still cannot be read is skipped - the board then
// shows the machines it could read rather than none.
const PS = [
  "$ErrorActionPreference = 'Continue'",
  "$out = @()",
  "foreach ($t in Get-ScheduledTask) {",
  "  try {",
  "    $i = $t | Get-ScheduledTaskInfo",
  "    $trig = ($t.Triggers | ForEach-Object { if ($_.Repetition.Interval) { 'every ' + $_.Repetition.Interval } elseif ($_.StartBoundary) { 'daily at ' + ([datetime]$_.StartBoundary).ToString('HH:mm') } else { 'once' } }) -join ' / '",
  "    $out += [pscustomobject]@{ name=$t.TaskName; state=[string]$t.State; cadence=$trig; next=$(if ($i.NextRunTime) { $i.NextRunTime.ToString('o') } else { $null }); last=$(if ($i.LastRunTime -and $i.LastRunTime.Year -gt 2000) { $i.LastRunTime.ToString('o') } else { $null }); result=[long]$i.LastTaskResult }",
  "  } catch { }",
  "}",
  "$out | ConvertTo-Json -Compress",
  "exit 0",
].join('\n')

/** Ask the scheduler. Returns the raw JSON text; throws if PowerShell is not there or refuses. */
export function readSchedulerJson() {
  // ENCODED, NOT -Command. The first real run on the laptop (2026-09-05) reported "scheduler
  // unreadable: Command failed: powershell.exe ... -Command Get-Scheduled" - a multi-line script
  // handed to -Command is cut at the first newline by the shell that spawns it. -EncodedCommand
  // carries the whole script as one base64 token, which is also how the same read already worked
  // over SSH the same morning. Quoting is not a detail; it is where three reads failed today.
  const encoded = Buffer.from(PS, 'utf16le').toString('base64')
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { encoding: 'utf8', timeout: 60_000 })
}

/**
 * Turn the scheduler's answer into rows for `automation_schedule`. Pure.
 * - keeps only board-related tasks (BOARD_TASK_PATTERN)
 * - never invents a time: a missing next/last stays null
 * - 267011 is kept as-is; the page reads it as "never ran" (sql/106 `never_ran`)
 */
export function toScheduleRows(json, { machine = hostname(), now = () => new Date().toISOString() } = {}) {
  let parsed
  try { parsed = JSON.parse(json) } catch { return [] }
  const list = Array.isArray(parsed) ? parsed : parsed ? [parsed] : []
  const at = now()
  return list
    .filter((t) => t && typeof t.name === 'string' && BOARD_TASK_PATTERN.test(t.name))
    .map((t) => ({
      task_name: t.name,
      machine,
      state: t.state ?? null,
      cadence: t.cadence || null,
      next_run: t.next || null,
      last_run: t.last || null,
      last_result: Number.isFinite(Number(t.result)) ? Number(t.result) : null,
      published_at: at,
    }))
}

/** Upsert the rows. Returns { written, status }. Never throws — a failed publish must not stop the advancer. */
export async function publishSchedule(rows, { url, headers, fetchImpl = fetch } = {}) {
  if (!rows.length) return { written: 0, status: 'nothing to publish' }
  try {
    const r = await fetchImpl(`${url}/rest/v1/automation_schedule?on_conflict=task_name`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(rows),
    })
    return { written: r.ok ? rows.length : 0, status: `HTTP ${r.status}` }
  } catch (e) {
    return { written: 0, status: String(e.message || e) }
  }
}
