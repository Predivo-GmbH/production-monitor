# Nothing stopped an AI session installing permanent things on Roger's PC — now two things do

**2026-09-05.** Work-board item *"An AI session can install permanent things on your PC, and nothing
asks you or tells you."*

## The incident this closes the general case of

On 2026-09-01 a Claude session installed 24 GitHub Actions runner **services** on Roger's personal
work PC (DESKTOP-124K6MV), gave them a Windows **scheduled task**, pinned the WSL VM open holding
~22 GB of RAM, and committed it under his git identity. He had retired that machine as a CI host on
2026-08-25 and it was written down **twice**. The session read neither and was never asked. He found
it himself on 2026-09-03 in Task Manager: *"So who decided that we made these changes? I never said
that."*

The runner case was already guarded (a watchdog that reads a `retired` machine list). **The class
was not**: nothing prevented, or even recorded, a session registering a scheduled task, creating a
service, enabling a boot item, or dropping a Startup shortcut. A rule in a document does not stop
this — that session had two documents. This delivers a **mechanism**, in two halves.

## Half 1 — prevention (fires on every tool call, no schedule needed)

`C:\ClaudeShared\hooks\persistent-install-guard.js` — a **PreToolUse** hook, registered in
`settings.shared.json` under the `Bash|PowerShell` matcher, alongside `block-paid-keys.js`. It
**denies** a command that CREATES something persistent on a physical machine and tells the session
to stop and ask Roger first:

| Family | Blocked forms |
|---|---|
| Windows scheduled task | `Register-ScheduledTask`, `Register-ScheduledJob`, `schtasks /create` |
| Windows service | `New-Service`, `sc create` / `sc.exe create` |
| Linux service | `systemctl enable`, `update-rc.d … enable`, `chkconfig … on` |
| Linux cron | installing a crontab (`… \| crontab -`, `crontab <file>`), writing `/etc/cron.d` |
| Linux systemd unit | writing into `/etc/systemd/system`, `/lib/systemd/system` |
| Windows auto-start | Startup-folder shortcut (`shell:startup`), a `…\CurrentVersion\Run` value |

**It never blocks reading, listing, DISABLING, DELETING or UNREGISTERING** — undoing a persistent
thing is exactly what a cleanup session must do. `Unregister-ScheduledTask` (which literally contains
`register-scheduledtask`), `schtasks /delete`, `sc delete`, `systemctl disable`, `crontab -r`,
`reg delete` all pass.

**Escape hatch:** prefix the command with `PERSIST_OK=1`. It may be added **only after Roger has
approved that specific install in the conversation**.

Tests: `C:\ClaudeShared\hooks\persistent-install-guard.test.js` — **42 cases, all green**
(`node persistent-install-guard.test.js`). Case 1 is the exact 2026-09-01 `schtasks /create` shape.

**Proven live this session:** a real `schtasks /create` issued through the PowerShell/Bash tool was
**denied** by the hook in the actual pipeline (not a unit test) — the message is the deny reason
above.

## Half 2 — detection (backstop for out-of-band installs)

The hook only sees commands that go through a Claude shell. It cannot see a thing created out of band
(an installer Roger ran, another tool, anything bypassing the hook). So:

- `scripts/lib/machine-persistence.mjs` — pure diff: given a recorded **baseline** snapshot and a
  **current** one, report every scheduled task / service / auto-start item present **now** that was
  absent from the baseline, each with how to remove it. **ABSENCE IS NOT SUCCESS:** an empty current
  snapshot is a *broken capture*, not a clean machine, and is its own loud finding; no baseline says
  so once instead of flagging every item as new.
- `scripts/check-machine-persistence.mjs` — captures this machine live (Windows: `Get-ScheduledTask`,
  `Win32_Service`, `Win32_StartupCommand`; Linux fallback: enabled units + crontab), diffs, writes
  `machine-persistence-findings.json`, exits 1 on any finding so the red run is the alert (house
  pattern). `--record` writes the baseline (a deliberate act — commit it).
- `scripts/machine-persistence-baseline.json` — baseline recorded live on **LAPTOP-88N97BGG**, the
  machine that runs the hourly automations (320 tasks, 301 services, 14 startup items).

Tests: `scripts/lib/machine-persistence.test.mjs` — **9 cases, all green**
(`node --test scripts/lib/machine-persistence.test.mjs`).

**Proven live this session, both directions:** recorded the baseline → clean PASS (exit 0); created a
harmless task `PM-persistence-selftest` out of band (via the approved `PERSIST_OK=1` hatch, since the
guard correctly blocked the un-approved attempt) → audit reported
`NEW scheduled task on LAPTOP-88N97BGG: "\PM-persistence-selftest" … schtasks /delete …` and exited 1
→ deleted the task → back to PASS.

## What is deliberately NOT done — Roger's decision

The detection audit is built, tested and proven, but it is **run by hand** right now. Making it run
on a **recurring schedule on the laptop is itself a persistent install** — the exact category this
item exists to keep out of an agent's hands. That is Roger's call, three ways:

1. a Windows scheduled task that runs `node scripts/check-machine-persistence.mjs` daily and mails on
   exit 1 (a persistent install — his to approve);
2. wire the check into an existing local hourly automation run (no new install);
3. leave it manual (run before/after any session that touched the machine).

Known gap, stated not hidden: neither half covers a session writing to **another** machine over SSH,
or pinning WSL RAM via `~/.wslconfig` — those are not shell-verb installs the guard keys on.
