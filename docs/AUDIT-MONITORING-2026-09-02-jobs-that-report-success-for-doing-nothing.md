# Monitoring audit, 2026-09-02 — the jobs that reported success for doing nothing

Continuation of [AUDIT-MONITORING-2026-09-01.md](./AUDIT-MONITORING-2026-09-01.md). Same method:
for every check, ask *what does it actually prove* and *what is the cheapest way it could be
lying*, and answer by injecting the failure the check claims to catch. Everything below that says
FIXED was watched to fail first.

---

## F23 — Pull request #2 is merged · DONE

Its only red check was the guard suite for paused healthchecks, failing on a real finding
(`knowledge-apply-loop` paused while its job still ran). That finding was repaired on `master`
separately on 2026-09-02 — and **not the way this session was told**. The story handed over was
"its grace was widened from 90 minutes to 12 hours". The actual fix, `1e96ccb`, removed the clock
from the rule altogether: *"It asked 'is a paused check still being pinged in the last 36h?' — the
JOB's pulse, not the ALARM's state."* Rule 68 in one line: the newest record wins, and the older
summary of it was wrong in the direction that mattered.

So the branch needed nothing of its own. `origin/master` merged in, all 45 unit suites green
locally, CI run 33675578363 green in the cloud with all 45 run (the retired-check guard among them,
with its real read-only key, so no silent skip). Merged 19:51:08Z as `8824dcd`.

---

## F24 — Four job wrappers could report a healthy job for an agent that did nothing · FIXED

`claude -p` exits 0 when it stopped on the weekly usage limit and when its login had expired. Every
wrapper that judged success by that exit code has been reporting a healthy job for a job that did
nothing — and the healthcheck it pings is the one thing that survives an unread inbox, so the false
green is the loudest lie in the system.

**The two local triage runners** decided their ping by whether `main()` resolved. `main()` resolves
whether or not the agent inside it did any work, because both of them deliberately swallow the
agent's failure so one broken run cannot loop every twenty minutes. The dedup is right and it
stays; what was wrong is that the swallowed failure then arrived at the healthcheck dressed as a
success. Measured: `agenttriage-localrunner` has 457 green pings, and an agent that timed out on
all 457 would have produced exactly the same 457.

The ping is now derived from a register of what each run *tried* to triage and whether each attempt
came back with the artefact that proves it happened:

* the guard sweep — `guard-triage-verdict.json`, which its own policy has always demanded as its
  FINAL ACTION and which nothing had ever read. Removed before the spawn, so a stale one cannot
  count, for the same reason the BackOffice loop runners pre-stamp `phase=pending`.
* the deploy path — the zero-verdict case that was already computed and already escalated in the
  alert mail, while this check stayed green.

A run with nothing to triage is still GREEN, deliberately: that is most runs, and an alarm that
fires on a quiet twenty minutes is one that gets muted. A deliberate off (exit 76/77) still pings
nothing at all.

**Two BackOffice loop wrappers** carried the asymmetric marker check:
`if not "%RC%"=="0" call :override_if_finished` — the marker could rescue a false RED and could
never catch a false GREEN, which is the direction that matters. `run-phase0.cmd` had one partial
guard, a match on the English string "You've hit your weekly limit"; the expired login and every
other no-op walked straight past it. Both now carry the same symmetric block as
`kb-learning\run-daily.cmd`, and the dead `:override_if_finished` routine is gone.

Run as a truth table in real `cmd.exe`, not described:

| CLI exit | marker | result |
|---|---|---|
| 0 | none | **126 FAIL** ← the case that was green before |
| 0 | `finish` | 0 SUCCESS |
| 1 | none | 1 FAIL |
| 1 | `finish` | 0 SUCCESS |
| 125 (weekly limit) | none | 125 FAIL, classification preserved |

`production-monitor 5279e93`, `BackOffice 643154d` and `f95799d`. New suite
`test/a-job-cannot-report-success-for-doing-nothing.test.mjs`, 23 assertions, four watched to fail
against injected regressions (the verdict letting an unproven run ping green; the runner going back
to "main() resolved"; two ways of removing the marker gate). All four caught, files restored, 47
suites green.

---

## F25 — The inbox summary now has to prove it reached the end · FIXED

`run-inbox-summary.ps1` pinged on `$code -eq 0` and nothing else. On 2026-08-25 it logged *"You've
hit your weekly limit"*, happened to exit 1 and went red; the same stop a minute earlier in the run
exits 0 and the check goes green with no summary sent and no trace anywhere.

The proof was already specified and already written, and nothing had ever read it:
`inbox-summary-prompt.md` Step 4 requires `inbox-triage-log\<YYYY-MM-DD>.summarized`. The gate now
demands **today's** marker, written **during this run** — a marker from yesterday, or from before
this run started, proves nothing. Missing or stale → exit 91, `/fail` ping.

**One branch is deliberately NOT red, and that is a judgement, not an oversight.** Measured on the
laptop that runs this job: **23 of the 24 markers ever written are zero bytes**, breaking the
prompt's own explicit rule that an empty marker is unacceptable. Turning that red today means a red
every morning for a job that *is* sending the mail, and a check that is red every day is one
somebody mutes — which is exactly what happened to `knowledge-apply-loop` this week. So the empty
case is named loudly in the log and carried as its own board item; the runner gets fixed first, and
then that branch becomes `$code = 91` like the two above it.

Six assertions in `inbox-summary-marker-gate.test.ps1`, which extracts the gate out of the live
wrapper rather than re-implementing it. Three injected regressions, all caught. **Proven on the
machine that runs it**: the wrapper and its suite were shipped to the laptop, byte-verified by
hash, and the suite passes there.

---

## F26 — `ci-runner-host` is not an orphan · CLAIM REFUTED

The standing claim was that this check has pinged over 2,200 times while its sender *"exists in no
repository, no scheduled task on the work PC (all 241 enumerated) and no crontab"*, and therefore
*"cannot be restored if that machine is rebuilt"*. Both halves are wrong, and the way they were
wrong is the point of this audit: the claim was reached by **grepping for the check's name**.

Asked healthchecks.io itself who pings it — every ping records the caller's address and user agent:

```
2582 | 2026-09-02T19:56:51 | success | 158.181.113.14 | GET | curl/8.18.0
2581 | 2026-09-02T19:51:51 | success | 158.181.113.14 | GET | curl/8.18.0
2580 | 2026-09-02T19:46:50 | success | 158.181.113.14 | GET | curl/8.18.0
```

One host, `curl`, every five minutes. The sender is
`Internal Projects/ci-runner/scripts/05-keepalive-loop.sh` line 52, running inside the WSL VM on
**the laptop**, not the work PC — `sleep 300` at line 58 matches the measured cadence exactly, and
`curl/8.18.0` matches the laptop's own user agent recorded in an earlier note. The name never
appears at the ping site because line 23 reads the URL out of a file at runtime,
`/opt/gh-runners/.hc-ping-url`. It is invisible to Task Scheduler because it is started from a
Startup-folder shortcut, which is documented in the repo's own README as the reason.

Restoring it is step 5 of that README's host-rebuild runbook: *"Move the heartbeat: copy the ping
URL into `/opt/gh-runners/.hc-ping-url` on the new box."* Nothing to fix. Two independent passes,
one measuring the ping log and one reading the repo, reached the same answer.

The one real hazard, already written down at `ci-runner/README.md:141`: two hosts pinging one check
breaks the dead-man's switch, and the work PC's runners are still registered.

---

## F27 — "Six jobs have no health check" is half right, and the wrong half is the important half · MEASURED

True: none of the night shift, board drainer, verify sweep, UX scout, factory engine or commit
review has a healthchecks.io check. Confirmed against the live account listing — 29 checks across
both accounts, none of them under any of those names.

False: *"nothing notices if they stop running."* Honest scoreboard:

| job | what actually watches it |
|---|---|
| **Board Drainer** | `check-drainer-progress.mjs`, hourly in `monitor.yml`, reads the drainer's own heartbeat row and can page. Covered. |
| **Night Shift** | `Cockpit/scripts/morning-report.mjs`, daily on GitHub Actions, deliberately off both machines. Emails a verdict. Covered. |
| **UX Scout, Factory Engine, Commit Review** | an SMTP failure email from the wrapper. **That is a failure alarm, not a dead-man.** If the task never fires, no process exists to send mail. |
| **Verify Sweep** | nothing. A local log line and a line in a daily digest. |

The Factory Engine is the sharpest of these: the ping code is present and correct at
`run-factory-engine.ps1:95-97`, and `factory-engine-config.json` has `"hc_ping_url": ""`, so both
guards are false and no ping is ever sent. It is disarmed by an empty string, with the free 20-check
cap given as the reason.

**That reason has expired.** Measured: the primary account is at 20 of 20, but the second free
account holds 9, so **eleven slots are free right now**. The standing rule is that a vendor cap
means another free account, never a paid plan and never designing around leftover slots. Four
checks are wanted — verify-sweep, factory-engine, commit-review, ux-scout — and they fit.

Not done here, deliberately: `provision-healthchecks.mjs` says it in its own header — *"an unpinged
check is worse than none because it goes DOWN and trains you to ignore the emails"* — so creating
the checks and wiring the four wrappers to ping them is one job, not two, and it belongs in a
session that can watch all four fire. On the board with a paste-ready prompt.

---

## F28 — The external-tools freshness check: confirmed, and understated · MEASURED

The parked claim was that the check is set to a time the scan does not run. True, and there are two
worse things behind it.

The workflow says `cron: '23 9 * * *'` with the comment *"five hours after the 04:17 scan"*. GitHub
crons are UTC; the scan is a Windows scheduled task registered with `/ST 04:17`, which is local wall
clock, so the real gap is **7h06m in summer and 6h06m in winter**, and it changes by an hour twice a
year with nothing recording that. The 04:17 figure is inherited from an abandoned design that would
have run the scan as a GitHub cron; that workflow does not exist.

Worse: `STALE_HOURS = 36` against a 24-hour cadence checked once a day means **one missed scan is
invisible**. Age at check time after one miss is 31h06m, under the threshold — so a dead scan is
reported roughly a day late, and that is caused by 36 > 24, not by the timezone slip. Worse again:
`newest` is a MAX over every live row, so one refreshed row anywhere makes the whole register look
fresh; and when the check *is* correctly red it files at `severity: warning, needs_human: false`,
which by the fleet's own paging rule can never reach anybody.

And the scheduled task is not registered on the work PC at all — the wrapper's log file has never
been created there, while 31 sibling logs have. Whether the laptop holds it is not determinable
from this disk and is stated as unknown, not as a negative.

---

## F29 — The three invisible product backends: fixed on 2026-09-01, and the audit doc never said so · CORRECTED

F5 of the previous audit still reads "PARKED, on the board". A fix was written and applied the same
day: `Cockpit/docs/FIX-three-logins-nobody-checked-2026-09-01.md`, migration
`sql/093_the_register_names_every_backend_it_watches.sql`, and a guard
`test/fleet-register-can-reach-every-backend.test.mjs` that does not merely assert `is not null` but
calls each project with its stored key.

Two things are still open, and both are real:

* **The migration is not on Cockpit `main`.** It exists only on branch worktrees; the highest
  numbered file in the main checkout is `091`. Whether the three rows are actually filled in the
  live registers is therefore not established from disk — the FIX doc asserts it, the migration is
  not merged, and that is exactly the gap between a fix written and a fix running.
* **The design fault under F5 is untouched.** `check-products-down.mjs:182` still returns
  `{ ok: true, detail: 'no Supabase project — nothing to check' }` for a blank ref — `ok`, not
  `null`, which is what this same file uses everywhere else for "could not tell". Filling the rows
  removed today's instance; the next product added with a blank row is silently green again. The
  FIX doc says so itself.

Also worth recording, because it is the same failure in miniature: three artifacts written on the
same day disagree about whether arivioo's Supabase project is paused, and only one of them was
measured.

---

## F30 — There are three copies of `~/.claude/scripts` and they have diverged · MEASURED, HANDED OVER

This is why the first act of the wrapper work was to find out which file the job actually executes,
and it very nearly went wrong.

**Every one of the 19 scheduled tasks behind these jobs is `Disabled` on the work PC.** They were
migrated to the laptop on 2026-08-25/26 and the work-PC copies are retired stubs. A fix written into
this machine's copy of a wrapper changes nothing that runs — unless something ships it.

Something does: `push-scripts-to-laptop.ps1`, every 15 minutes, work PC → laptop. Verified by
hashing `provision-healthchecks.mjs` in all three trees:

```
work PC ~/.claude/scripts : e4bca20d8d292980
C:\ClaudeShared\scripts   : b130ce29bb3b5e49   <- neither of the others
laptop  ~/.claude/scripts : e4bca20d8d292980
```

So the work PC's `~/.claude/scripts` is the authoring tree and it does reach the machine that runs
the jobs. **`C:\ClaudeShared\scripts` is a third copy that nothing executes for these wrappers, and
it is out of step with both** — and sessions are actively committing wrapper edits into it (one
landed at 21:30 today). An edit made there may never reach the laptop; an edit made here may
overwrite it. Neither direction is currently checked by anything.

**And the shipping channel is broken right now.** `push-scripts-to-laptop` last succeeded at 21:36
and has since logged `could not hash the source files`, `the push STALLED and was killed`, and
`the PREVIOUS push never finished`; its own alarm mail cannot go out either
(`SMTPAuthenticationError 535`). A stall guard was added to it today and another session is working
on it, so nothing here touches it. This session's two files were delivered over the same SSH channel
instead and verified by hash on arrival, and the suite was then run on the laptop.

---

## What this pass changes about the method

Every wrong claim corrected here — the orphan heartbeat, the six uncovered jobs, the three
invisible backends — was originally reached by **reading or grepping**, and every correction came
from **asking the live system**: the ping log that names its own caller, the account listing that
names its own checks, the scheduled-task table that says which machine is running anything at all.

The new one, and it is the sharpest of the session: **before fixing a file, prove it is the file
that runs.** Three copies existed, two of them stale in different directions, and the tasks were
disabled on the machine holding the copy that was easiest to edit.
