<#
  Registers "Board-Lane-Advancer" — the job that walks rows along the eight-lane track on their own.

  RUN THIS ON THE ALWAYS-ON LAPTOP (LAPTOP-88N97BGG) ONLY. It refuses on DESKTOP-124K6MV.
  Roger has had to say twice (2026-08-25, 2026-09-03) that his work PC is for work only, and a
  session put CI runners back on it on 2026-09-01 while fixing a red deploy. So this refuses rather
  than trusting whoever runs it to remember.

  ══ WHY THIS EXISTS ═══════════════════════════════════════════════════════════════════════════

  Roger, 2026-09-04: "this board still really lifts, and it's orchestrated by you. You pick up the
  tasks, and you go through every step or every lane by yourself, as far as you can, all the time,
  24/7. You only ask me to do anything if it's really needed."

  A track nothing walks is a diagram. `advance-lanes.mjs` reads each row's own gate and moves the
  ones whose reason is empty — but it had no scheduler, and on 2026-09-03 exactly that gap was the
  whole explanation for a board that would not go down: `close-finished-items.mjs` had been built,
  tested and on master for days while NOT ONE of 318 scheduled tasks ran it.

  ══ WHAT IT WILL AND WILL NOT DO ══════════════════════════════════════════════════════════════

  It advances a row ONE lane per run and only when the board's own `lane_gate_unmet` is empty. It
  can never perform `ready_for_release -> done`: that function has no code path for it, which is an
  absence rather than a flag, because a flag can be set wrongly. It never moves a row owed to Roger.
  It prints the reason for every row it did not move.

  Twice an hour rather than continuously: a gate that flips within half an hour was not a gate, and
  every run costs real reads against the board.

  Kill switch: Disable-ScheduledTask -TaskName Board-Lane-Advancer
  Remove with:  Unregister-ScheduledTask -TaskName "Board-Lane-Advancer" -Confirm:$false
#>
$ErrorActionPreference = 'Stop'

$WORK_PC = 'DESKTOP-124K6MV'
if ($env:COMPUTERNAME -eq $WORK_PC) {
  throw ("REFUSED: $WORK_PC is Roger's work PC, not a CI host. He has had to say this twice " +
         "(2026-08-25, 2026-09-03). Run this on the always-on laptop instead.")
}

$taskName = 'Board-Lane-Advancer'
$node     = (Get-Command node).Source
$runner   = 'C:\Business\Internal Projects\production-monitor\scripts\advance-lanes.mjs'

if (-not (Test-Path $runner)) { throw "Runner not found: $runner" }

# LANES_CONFIRM=1 IS NOT OPTIONAL, AND LEAVING IT OUT IS THE WHOLE JOKE. isDryRun() returns TRUE
# unless it is set — the advancer is dry BY DEFAULT, deliberately. Registered without it, the task
# would run twice an hour, exit 0, print "DRY RUN, nothing was written" where nobody reads it, and
# move NOTHING for ever: precisely the "reports success for doing nothing" class this repo exists
# to catch. The quoting matters too: `set "VAR=1" &&`, never `set VAR=1 &&`, or the trailing space
# is captured into the value and the check silently fails.
$cmd = ('/c set "LANES_CONFIRM=1" && "{0}" "{1}"' -f $node, $runner)
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $cmd

$start   = (Get-Date).AddMinutes(2)
$trigger = New-ScheduledTaskTrigger -Once -At $start
$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At $start `
    -RepetitionInterval (New-TimeSpan -Minutes 30) `
    -RepetitionDuration (New-TimeSpan -Days 3650)).Repetition

# Battery gates MUST be off. New-ScheduledTaskSettingsSet defaults them to True, which is how the
# brain tasks silently skipped for days on 2026-08-10 — and an advancer that skips looks identical
# to a board with nothing ready to move.
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable `
    -DontStopOnIdleEnd -ExecutionTimeLimit (New-TimeSpan -Minutes 15) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

# S4U, NOT Interactive, and the account RESOLVED rather than assembled. Both learned the hard way on
# 2026-09-03: an Interactive task reports State=Ready and never fires while nobody is signed in, and
# "$env:USERDOMAIN\$env:USERNAME" fails 0x80070534 over SSH because USERDOMAIN is not populated in a
# non-interactive session.
$runAsUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $runAsUser -LogonType S4U -RunLevel Limited

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
    -Principal $principal -Description (
      'Work board, every 30 minutes: walks each row one lane forward along the eight-lane track ' +
      'when the board''s own gate for that row is empty. Never crosses ready_for_release into done ' +
      '(that promotion is Roger''s for anything a customer touches, and this job has no code path ' +
      'for it), never moves a row owed to Roger, and prints the reason for every row it left alone.') | Out-Null

Write-Output "Registered '$taskName' (every 30 min, next ~$start, running as $runAsUser)."
Get-ScheduledTask -TaskName $taskName |
  ForEach-Object { '{0}: logon={1} runlevel={2} battery-ok={3}' -f $_.TaskName, $_.Principal.LogonType, $_.Principal.RunLevel, (-not $_.Settings.DisallowStartIfOnBatteries) }
