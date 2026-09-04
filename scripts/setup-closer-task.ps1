<#
  Registers "Board-Closer-Hourly" — the job that evaluates every work-board finish-test and
  closes the rows whose check passes.

  RUN THIS ON THE ALWAYS-ON LAPTOP (LAPTOP-88N97BGG) ONLY. It refuses on DESKTOP-124K6MV.
  Roger, 2026-08-25 and again 2026-09-03: "The work PC is for work only and not for anything
  else." A session put CI runners back on it on 2026-09-01 while fixing a red deploy, so this
  refuses rather than trusting whoever runs it to remember.

  ══ WHY THIS EXISTS, AND IT IS NOT A SMALL THING ═══════════════════════════════════════════

  `close-finished-items.mjs` has been built, tested and on master for days. Measured on the
  laptop 2026-09-03 by enumerating ALL 318 scheduled tasks by their actual command line:
  NOT ONE RUNS IT. And measured on the live board the same day: of the 93 rows that have ever
  carried a finish-test, ZERO have ever been evaluated — `done_checked_at` is null on every
  single one.

  That is the whole explanation for a board that would not go down. Rows were given a machine-
  checkable definition of "finished" and no machine ever checked. The work-board requirement's
  §7 says "a machine closes a machine-checkable row whose check passes, receipt attached, asking
  nobody" — the code existed, the rule existed, and the two had never been connected.

  ══ WHAT IT WILL AND WILL NOT DO ═══════════════════════════════════════════════════════════

  It evaluates each row's stated finish-test against the live system and closes only the ones
  that PASS, attaching the receipt. It NEVER closes a row owed to Roger (`isOwedToRoger`), never
  abandons anything, and caps itself at CLOSER_MAX (default 25) closures per run so a bad day
  cannot empty the board. A check it cannot execute is recorded as `unknown`, never as a pass.

  HOURLY, not more often: every run costs real reads against products and GitHub, and a finish
  -test that flips within the hour was not a finish-test.

  Kill switch: Disable-ScheduledTask -TaskName Board-Closer-Hourly
  Remove with:  Unregister-ScheduledTask -TaskName "Board-Closer-Hourly" -Confirm:$false
#>
$ErrorActionPreference = 'Stop'

$WORK_PC = 'DESKTOP-124K6MV'
if ($env:COMPUTERNAME -eq $WORK_PC) {
  throw ("REFUSED: $WORK_PC is Roger's work PC, not a CI host. He has had to say this twice " +
         "(2026-08-25, 2026-09-03). Run this on the always-on laptop instead.")
}

$taskName = 'Board-Closer-Hourly'
$node     = (Get-Command node).Source
$runner   = 'C:\Business\Internal Projects\production-monitor\scripts\close-finished-items.mjs'

if (-not (Test-Path $runner)) { throw "Runner not found: $runner" }

# CLOSER_CONFIRM=1 IS NOT OPTIONAL HERE, AND LEAVING IT OUT IS THE WHOLE JOKE. isDryRun() returns
# TRUE unless CLOSER_CONFIRM is set -- the closer is dry BY DEFAULT, deliberately, because "a first
# real run must not move a hundred rows unwatched". This script was written without it and would
# have registered an hourly task that runs, exits 0, prints "DRY RUN, nothing was closed" where
# nobody reads it, and closes NOTHING for ever. That is precisely the "a job that reports success
# for doing nothing" class this repo exists to catch, and it was caught by running the closer by
# hand and noticing it said DRY RUN when no flag had been passed.
#
# The quoting matters: `set "VAR=1" &&` not `set VAR=1 &&`, or the trailing space is captured into
# the value and the ==='1' check silently fails -- the same trap already documented in
# setup-board-drainer-task.ps1.
# CLOSER_TEST_ROOTS — WITHOUT THIS, THE FLEET'S OWN OPERATOR TOOLING CAN NEVER BE CHECKED.
# Measured 2026-09-04 across three parallel sweeps of the board: at least eight open rows are
# unclosable BY CONSTRUCTION, because their subject is a script under the Claude tree or
# C:\ClaudeShared\scripts and `testPathIsRunnable` refuses any path outside the roots. A refused
# path is recorded UNKNOWN, never FAIL — so a PERFECT test on one of those rows would still never
# clear it, and the row looks identical to one whose check genuinely could not run. Nothing said so.
#
# Built from $HOME rather than written out, because the two machines have different user folders
# (the laptop is not roger_rwjnmnz) and a hardcoded profile path here would silently cover nothing.
# `testRoots()` UNIONS this with C:\Business\Internal Projects rather than replacing it — it used
# to replace, which meant this very line would have turned every product row unevaluatable.
# THE PARENT FOLDERS, NOT THE `scripts` SUBFOLDER. First registered 2026-09-04 pointing at
# `.claude\scripts` and `ClaudeShared\scripts`, and the very next run still refused
# `C:/ClaudeShared/memory-tree-no-secrets.test.mjs` — which sits directly in ClaudeShared, not
# under scripts. A root that is one folder too deep fails EXACTLY like no root at all: the row
# is recorded UNKNOWN, never FAIL, and reads as "could not be checked" rather than "was not
# allowed to be checked". Widened to the two trees themselves.
$extraRoots = @((Join-Path $HOME '.claude'), 'C:\ClaudeShared') -join ';'

$cmd = ('/c set "CLOSER_CONFIRM=1" && set "CLOSER_TEST_ROOTS={2}" && "{0}" "{1}"' -f $node, $runner, $extraRoots)
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $cmd

$start   = (Get-Date).AddMinutes(3)
$trigger = New-ScheduledTaskTrigger -Once -At $start
$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At $start `
    -RepetitionInterval (New-TimeSpan -Hours 1) `
    -RepetitionDuration (New-TimeSpan -Days 3650)).Repetition

# Battery gates MUST be off. New-ScheduledTaskSettingsSet defaults them to True, which is how the
# brain tasks silently skipped for days on 2026-08-10 — and a closer that skips looks identical to
# a board with nothing ready to close.
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable `
    -DontStopOnIdleEnd -ExecutionTimeLimit (New-TimeSpan -Minutes 20) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

# S4U, NOT Interactive, and the account RESOLVED rather than assembled. Both were learned the hard
# way on 2026-09-03 registering the two reporting jobs on this same laptop: an Interactive task
# reports State=Ready and never fires while nobody is signed in, and "$env:USERDOMAIN\$env:USERNAME"
# fails 0x80070534 over SSH because USERDOMAIN is not populated in a non-interactive session.
$runAsUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $runAsUser -LogonType S4U -RunLevel Limited

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
    -Principal $principal -Description (
      'Work board, hourly: evaluates every row''s stated finish-test against the live system and ' +
      'closes the ones that pass, with the receipt attached. Never closes a row owed to Roger, ' +
      'never abandons anything, caps itself at CLOSER_MAX closures per run, and records a check it ' +
      'could not execute as unknown rather than as a pass. Built days ago; nothing ran it until ' +
      '2026-09-03, which is why 0 of 93 finish-tests had ever been evaluated.') | Out-Null

Write-Output "Registered '$taskName' (hourly, next ~$start, running as $runAsUser)."
Get-ScheduledTask -TaskName $taskName |
  ForEach-Object { '{0}: logon={1} runlevel={2} battery-ok={3}' -f $_.TaskName, $_.Principal.LogonType, $_.Principal.RunLevel, (-not $_.Settings.DisallowStartIfOnBatteries) }
