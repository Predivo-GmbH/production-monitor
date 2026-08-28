# Board Drainer — Runbook (birth-certificate)

**What it is:** an autonomous local runner that reads the cockpit Monitoring Board
(`monitoring_incidents`, BO Supabase `xoecpzfsskalvjrtcbbl`), works the `owner=Claude` incidents a
dev session may safely fix, escalates the rest to Roger, and writes the result back — draining the
board to zero without Roger in the loop. Root fix for "Roger was the message bus between diagnosed
and fixed." Plan: `docs/PLAN-BOARD-DRAINER-2026-08-15.md`.

**Files:**
- `scripts/board-drainer.mjs` — the loop (read → classify → dispatch bounded headless Claude → write back).
- `test/board-drainer.test.mjs` — unit tests for the classifier + receipt-guard (`node test/board-drainer.test.mjs`).
- `scripts/setup-board-drainer-task.ps1` — registers the scheduled task (Stage 6; run only after review).

## Enable / disable
| State | How |
|---|---|
| **Enable** | scheduled task passes `BOARD_DRAINER_ENABLED=1` (+ `BOARD_DRAINER_LIVE=1` to actually act). |
| **Kill switch** | set machine env `BOARD_DRAINER_DISABLED=1` (overrides everything) OR `Disable-ScheduledTask -TaskName Board-Drainer-LocalRunner`. |
| **Dry-run** | `BOARD_DRAINER_ENABLED=1 node scripts/board-drainer.mjs` (no `LIVE`) → classify + print, touch nothing. |
| **Offline classifier test** | `BOARD_DRAINER_ENABLED=1 BOARD_DRAINER_FIXTURE=<path.json> node scripts/board-drainer.mjs`. |

Default posture is **wired-but-off**: with neither env set the script self-skips (exit 0), exactly like
the agent-triage paid-key gate. Nothing runs unattended until the task is registered (Stage 6).

## Autonomy boundary (Roger-approved 2026-08-15)
- **Autonomous:** monitor/spec/CI/config/pipeline fixes incl. **prod deploy of those classes**;
  closing verified false-reds; **staging** deploy of product-code fixes.
- **Always escalates (hard-blocked in `classify()` + absent from the agent's allowedTools):**
  destructive DB/DDL, secrets/keys, payments, customer comms, **prod promotion of product code**,
  business decisions, low-confidence diagnoses, Roger's OAuth hands.

## Guardrails
- **Blast radius:** `MAX_PER_RUN = 3` incidents worked per tick.
- **Dedup-stuck:** `MAX_ATTEMPTS = 3`; after that the incident is re-flagged `blocked` / `Action: Roger`
  ("auto-fix stuck") instead of looping a bad fix. State: `C:\Business\_board-drainer\state.json`.
- **Never a shallow close:** `verdictToUpsert()` downgrades a `fixed`/`self-healed` verdict that carries
  no `receipt` to `investigating` — a close REQUIRES a verified receipt (repro / live check / green run).
- **Reversible + logged:** every action logged to `C:\Business\_board-drainer\drainer.log`; the agent may
  only commit/push production-monitor + open PRs on target repos + deploy the permitted classes.

## Alarm (birth-cert)
- **Run errored → emails Roger immediately** via `send_report_email.py` (subject `[ALERT] Board Drainer run
  failed`), landing in his watched inbox. This is the primary alarm.
- **Silently stopped running → covered by proxy.** The sibling local runners on this same box
  (`agenttriage-localrunner`, `needs-roger-closer`) have healthchecks dead-man's-switches; if the machine
  dies they go dark and page Roger, which includes this drainer.
- **Dedicated dead-man check: not provisioned** — the healthchecks free plan is at its check limit
  (Add Check disabled, verified 2026-08-15). To add one, free a slot or upgrade, then set env
  `BOARD_DRAINER_HC=<ping_url>` (the script pings it on success / `/fail` on error automatically).

## Escalation contract
An escalated incident is written back with `status=blocked` + `who_must_act="Roger - <one-line>"`, so it
appears on the board as `Action: Roger` and the hourly Needs-Roger Closer keeps it unread in his inbox
until fixed — unchanged from today. The drainer only ever REMOVES the Claude-owned items from that pile.

### Routing to the work board, and JOINING a job already in progress
A signal that needs a *person* (a decision, a bank statement, Roger's OAuth hands) is not an alarm, it
is a task, so `routeToWorkBoard()` moves it to the cockpit work board (`work_items`) and supersedes the
signal off `/signals` (B3 part 3). **Before it mints a row, it looks for a LIVE in-progress item a
session is already working that is plainly about the same object, and attaches the signal to THAT as an
evidence note instead** — added 2026-08-28 after Roger asked, closing the external-tools work, "why
wasn't this added to the in-progress task in the first place?" One job had fragmented into the
in-progress item plus two monitor rows about the same object, each landing on him as blocked.

- **How the match is decided (`findJoinTarget` / `matchItem`, decreasing confidence):** (1) the signal
  names a file/identifier that appears in a live item's `claim_paths`; (2) it shares a distinctive
  directory with them; (3) a distinctive phrase from it appears in the live item's title. Repo roots and
  common dir names never count on their own.
- **Conservative on purpose.** An over-eager join hides a real signal on the wrong job, which is worse
  than an extra row — so if two live jobs match equally well, or the live-items read fails, it opens the
  row exactly as before.
- **A joined signal never sets `blocked_owner: roger`.** The session on the job owns it; the marker is a
  heads-up ("The machines spotted something about this while you were on it"), not a page. If the
  underlying check goes red again the signal returns on its own.
- "live in-progress" = the `work_board` view's `lane='in_progress'` (owner set + activity inside 45 min,
  Cockpit `sql/066`) — one definition of "live" for the whole fleet.

## First-live supervision (Stage 6, before trusting it unattended)
1. Register the task (`setup-board-drainer-task.ps1`), leave `BOARD_DRAINER_LIVE` UNSET for one cycle →
   confirm dry-run classifications in `drainer.log` look right against a real non-empty board.
2. Then set `LIVE=1` and watch the first real drains: verify each closed incident has a genuine receipt
   and each escalation is genuinely human-gated. Only then leave it unattended.
