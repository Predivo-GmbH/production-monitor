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

const PS = [
  "Get-ScheduledTask | ForEach-Object {",
  "  $i = $_ | Get-ScheduledTaskInfo",
  "  $trig = ($_.Triggers | ForEach-Object { if ($_.Repetition.Interval) { 'every ' + $_.Repetition.Interval } elseif ($_.StartBoundary) { 'daily at ' + ([datetime]$_.StartBoundary).ToString('HH:mm') } else { 'once' } }) -join ' / '",
  "  [pscustomobject]@{ name=$_.TaskName; state=[string]$_.State; cadence=$trig; next=$(if ($i.NextRunTime) { $i.NextRunTime.ToString('o') } else { $null }); last=$(if ($i.LastRunTime -and $i.LastRunTime.Year -gt 2000) { $i.LastRunTime.ToString('o') } else { $null }); result=[int]$i.LastTaskResult }",
  "} | ConvertTo-Json -Compress",
].join('\n')

/** Ask the scheduler. Returns the raw JSON text; throws if PowerShell is not there or refuses. */
export function readSchedulerJson() {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS], { encoding: 'utf8', timeout: 60_000 })
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
