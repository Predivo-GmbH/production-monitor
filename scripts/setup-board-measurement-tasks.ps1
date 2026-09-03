<#
  Registers the two work-board reporting jobs as Windows Scheduled Tasks.

    Board-Measurement-Weekly   Mondays 07:00 - scripts/measure-the-board.mjs
    Board-Monthly-No           1st of the month 07:30 - scripts/the-monthly-no.mjs --write

  RUN THIS ON THE ALWAYS-ON LAPTOP (LAPTOP-88N97BGG) ONLY.
  ==========================================================
  Roger, 2026-08-25 and again 2026-09-03, after finding 24 runners and 22 GB of his RAM in his
  own Task Manager: "The work PC is for work only and not for anything else." DESKTOP-124K6MV is
  not a CI host and never becomes one. This script REFUSES to register on it rather than trusting
  whoever runs it to remember - a rule enforced by attention is not enforced.

  WHY SCHEDULED TASKS AND NOT CI. Both scripts read the board through the cockpit-mcp registration
  in ~/.claude.json. A GitHub-hosted runner has no such file, so these cannot run in monitor.yml -
  the same reason close-finished-items.mjs lives here rather than in a workflow.

  WHAT THEY DO, AND WHAT THEY WILL NOT DO
  ---------------------------------------
  measure-the-board.mjs is READ-ONLY. It computes the work-board requirement's success gates and
  prints them. It never closes, moves, grades or edits a row. Weekly rather than daily because its
  headline gate is a 14-day flow rate, and a number that cannot move between runs invites the
  reader to stop looking at it.

  the-monthly-no.mjs files ONE question for Roger about every `low` row untouched for 30 days.
  --write is deliberate here: filing the question IS the whole job, and a dry run that files
  nothing would be a job reporting success for doing nothing, which this fleet has a name for. It
  still abandons NOTHING on its own - only Roger's answer closes those rows. It also refuses to
  file a second bundle while one is open, so a missed month cannot produce a pile.

  Kill switch: Disable-ScheduledTask -TaskName Board-Measurement-Weekly (or Board-Monthly-No).
  Remove with:  Unregister-ScheduledTask -TaskName "<name>" -Confirm:$false
#>
$ErrorActionPreference = 'Stop'

# ── the refusal that keeps the work PC out of this ───────────────────────────────────────────
$WORK_PC = 'DESKTOP-124K6MV'
if ($env:COMPUTERNAME -eq $WORK_PC) {
  throw ("REFUSED: $WORK_PC is Roger's work PC, not a CI host. He has had to say this twice " +
         "(2026-08-25, 2026-09-03). Run this on the always-on laptop instead.")
}

$node = (Get-Command node).Source
$repo = 'C:\Business\Internal Projects\production-monitor\scripts'

function Register-BoardTask {
  param([string]$Name, [string]$Script, [string]$ExtraArgs, $Trigger, [string]$Description)

  $runner = Join-Path $repo $Script
  if (-not (Test-Path $runner)) { throw "Runner not found: $runner" }

  $action = New-ScheduledTaskAction -Execute $node -Argument ('"{0}" {1}' -f $runner, $ExtraArgs).Trim()

  # Battery gates MUST be off. New-ScheduledTaskSettingsSet defaults them to True, which is
  # exactly how the brain tasks silently skipped for days on 2026-08-10 - and a reporting job
  # that skips looks identical to a board with nothing to report.
  $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable `
      -DontStopOnIdleEnd -ExecutionTimeLimit (New-TimeSpan -Minutes 15) `
      -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

  # S4U, NOT Interactive. A task registered with LogonType Interactive shows State=Ready in
  # Get-ScheduledTask and then never fires while nobody is signed in — which is the normal state
  # of an always-on headless laptop. It would look registered, look healthy, and do nothing: the
  # exact "a job that reports success for doing nothing" class this fleet is built to catch, and
  # the reason `Ready` alone is not proof. S4U runs without a stored password and without an
  # interactive session; RunLevel stays Limited because neither job needs elevation. Pattern taken
  # from C:/ClaudeShared/scripts/fix-gh-runner-anchor-at-startup.ps1, which registers the fleet's
  # runner tasks on this same laptop.
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited

  Unregister-ScheduledTask -TaskName $Name -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
  Register-ScheduledTask -TaskName $Name -Action $action -Trigger $Trigger -Settings $settings `
      -Principal $principal -Description $Description | Out-Null
  Write-Output "Registered '$Name'."
}

Register-BoardTask -Name 'Board-Measurement-Weekly' -Script 'measure-the-board.mjs' -ExtraArgs '' `
  -Trigger (New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At '07:00') `
  -Description 'Work board, weekly: computes the requirement''s success gates (does the board shrink, is debt ageing down, are rows workable, is weight real, is his lane small and honest, is anything fictional) with an anti-gaming companion on each. READ-ONLY - never closes, moves or grades a row.'

Register-BoardTask -Name 'Board-Monthly-No' -Script 'the-monthly-no.mjs' -ExtraArgs '--write' `
  -Trigger (New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At '07:30') `
  -Description 'Work board, monthly "no": bundles every low-weight row untouched for 30 days into ONE question for Roger - one answer, N rows off the board or N clocks reset. Abandons nothing on its own; refuses to file a second bundle while one is open. (Weekly trigger, monthly effect: the script itself is idempotent while a bundle is unanswered.)'

Get-ScheduledTask -TaskName 'Board-Measurement-Weekly', 'Board-Monthly-No' |
  Select-Object TaskName, State | Format-Table -AutoSize
