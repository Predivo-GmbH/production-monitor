# Scheduled Task wrapper: Production Issue Auto-Fix (hourly)
# Runs headless Claude Code against the hourly production-check prompt.
# Versioned canonical copy (2026-08-18) — the live file deployed by the scheduled task is
# ~\.claude\scripts\run-hourly-production-check.ps1; keep the two in sync.
# Paths are parameterised on the current user (2026-08-25): the same file runs on the work PC
# (roger_rwjnmnz) and the automation laptop (roger_spfi4lz).
$ErrorActionPreference = 'Continue'
$scripts = Join-Path $env:USERPROFILE '.claude\scripts'
$lock    = Join-Path $scripts 'hourly-production-check.lock'
$log     = Join-Path $scripts 'logs\hourly-production-check.log'
$prompt  = Join-Path $scripts 'hourly-production-check-prompt.md'
$claude  = Join-Path $env:USERPROFILE '.local\bin\claude.exe'

# Platform preflight (2026-08-19): shared claude-auth check. If the claude platform is down
# (OAuth expired etc.), skip this run WITHOUT pinging this job's own check /fail - one platform
# outage = one red claude-platform check, not N red jobs. See AUTOMATIONS_RUNBOOK.md.
cmd /c "$scripts\_claude-preflight.cmd" 2>&1 | Add-Content $log
if ($LASTEXITCODE -eq 75) { Add-Content $log "[$(Get-Date -Format s)] PREFLIGHT platform-down - skipping run (platform alert already sent)"; exit 75 }

# Lockfile: skip this tick if a previous run (e.g. a long fix) is still going.
if (Test-Path $lock) {
    $age = (Get-Date) - (Get-Item $lock).LastWriteTime
    if ($age.TotalHours -lt 3) {
        Add-Content $log "[$(Get-Date -Format s)] SKIP - previous run still holds lock ($([int]$age.TotalMinutes) min old)"
        exit 0
    }
    Remove-Item $lock -Force  # stale lock (>3h) - previous run died
}
New-Item -ItemType File -Path $lock -Force | Out-Null

try {
    $text = Get-Content $prompt -Raw -Encoding UTF8
    Set-Location 'C:\Business\Internal Projects\production-monitor'

    # Upstream Anthropic API error signatures. Grounded in real log lines the Claude CLI emits when it
    # cannot reach the model: "API Error: 529 Overloaded", "API Error: Server error mid-response".
    # These mean the AGENT couldn't run - NOT that a monitored production system failed. On a persistent
    # one we soft-skip instead of pinging /fail (that binary /fail was the false-red monitor bug).
    $upstreamRe = 'API Error|Overloaded|overloaded_error|rate.?limit|\b429\b|\b529\b|\b500\b|\b502\b|\b503\b|\b504\b|Server error mid-response|Internal server error|Connection error|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up'

    # Attempt 1
    Add-Content $log "[$(Get-Date -Format s)] START"
    $out  = ($text | & $claude -p --dangerously-skip-permissions --add-dir 'C:\Business' --add-dir "$env:USERPROFILE\.claude" 2>&1 | Out-String)
    $code = $LASTEXITCODE
    Add-Content $log $out
    Add-Content $log "[$(Get-Date -Format s)] END (exit $code)"
    $isUpstream = ($code -ne 0) -and ($out -match $upstreamRe)

    # Retry once with backoff on a transient upstream API error (server error / 429 / 529 Overloaded).
    if ($isUpstream) {
        Add-Content $log "[$(Get-Date -Format s)] UPSTREAM-API-ERROR on attempt 1 - backing off 30s and retrying once"
        Start-Sleep -Seconds 30
        Add-Content $log "[$(Get-Date -Format s)] START (retry)"
        $out  = ($text | & $claude -p --dangerously-skip-permissions --add-dir 'C:\Business' --add-dir "$env:USERPROFILE\.claude" 2>&1 | Out-String)
        $code = $LASTEXITCODE
        Add-Content $log $out
        Add-Content $log "[$(Get-Date -Format s)] END (retry, exit $code)"
        $isUpstream = ($code -ne 0) -and ($out -match $upstreamRe)
    }

    # Heartbeat (2026-08-10 reliability plan): success ping / fail signal to healthchecks.io.
    # Persistent upstream API error => SOFT-SKIP: log it and DO NOT ping /fail (not a production failure).
    if ($code -eq 0) {
        try { Invoke-RestMethod -Uri 'https://hc-ping.com/4d8de2d0-addb-483d-954c-045a052b3fb0' -TimeoutSec 10 | Out-Null } catch {}
    } elseif ($isUpstream) {
        Add-Content $log "[$(Get-Date -Format s)] SOFT-SKIP - persistent upstream Anthropic API error after 1 retry; NOT pinging /fail (not a production failure)"
    } else {
        try { Invoke-RestMethod -Uri 'https://hc-ping.com/4d8de2d0-addb-483d-954c-045a052b3fb0/fail' -TimeoutSec 10 | Out-Null } catch {}
    }
} finally {
    Remove-Item $lock -Force -ErrorAction SilentlyContinue
}

# Trim log to last 4000 lines
$lines = Get-Content $log -ErrorAction SilentlyContinue
if ($lines.Count -gt 4000) { $lines[-4000..-1] | Set-Content $log -Encoding UTF8 }
