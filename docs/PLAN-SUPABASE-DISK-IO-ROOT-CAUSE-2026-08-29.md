# Supabase Disk IO alarm 2026-08-29: cause, fix, and what now watches it

## What happened

Supabase emailed at 05:07 CEST that ScoutCopilot's project was running out of Disk IO
budget. The machine was doing 7.74 MB/s of disk traffic around the clock.

## Cause, proven by changing one thing at a time

The project was running Supabase platform build `supabase-postgres-17.6.1.084`. On that
build the machine read about 74 KB from disk for every page fault, roughly 96 times a
second, permanently. That traffic, not anything in the product, was the whole bill.

Measured on the same machine, 320-second window, one hour after the free upgrade to
`supabase-postgres-17.6.1.166`:

| | faults/s | read | total | KB per fault |
|---|---|---|---|---|
| before, `.084` | 96 | 7.11 MB/s | 7.74 MB/s | 7.11 ÷ 96 = **74.1** |
| after, `.166` | 20 | 0.66 MB/s | 0.67 MB/s | 0.66 ÷ 20 = **32.3** |

0.67 ÷ 7.74 = **8.7% of the previous disk traffic**. ScoutCopilot now sits with the quiet
machines (BackOffice 0.48 MB/s, ReplyFlow 0.30 MB/s).

## What it was NOT, each ruled out by measurement

| Theory | How it died |
|---|---|
| Abandoned health-check logins | Deleted 15,824 of them; swap rate went 1.05 -> 1.11 MB/s, i.e. unchanged |
| The database itself | Data disk 195 GB vs OS disk 29,251 GB over the same 31.9 days |
| Visitor traffic | BackOffice serves 15,906 requests/6h at 0.48 MB/s; ScoutCopilot 5,391 at 7.74 |
| The free plan / small machine | LaunchReady has the same 431 MB and runs at 0.06 MB/s |
| Number of edge functions | BackOffice has 55 and is quiet; ScoutCopilot has 16 and was not |
| Checkpoints | 66 in 6 hours, each writing 5-107 buffers |
| Disk nearly full | 76.0% ScoutCopilot vs 79.4% BackOffice; the quiet machines are fuller |
| A stuck machine | Restart changed 74.1 -> 74.4 KB per fault, i.e. nothing |
| Needing bigger machines | Recommended in the first draft of this plan, **withdrawn**, never bought |

## What was done

1. ScoutCopilot upgraded `.084` -> `.166`, confirmed by the table above.
2. DistributionOS, the only other machine on `.084`, upgraded and confirmed on `.166`.
3. All 9 staging projects upgraded first (Rule 63), then production, gated: `gated-prod.mjs`
   refuses to touch production unless every staging machine returns healthy on the new build.
4. 111,117 abandoned health-check sessions deleted fleet-wide and the monitor taught to sign
   out (`lib/revokeSessions.ts`). Real hygiene, but it was never the cause of this alarm and
   must not be described as the fix.

## What now watches it, so the vendor is never first again

- `scripts/check-supabase-machine-health.mjs` — sustained disk load per project, warns at
  2 MB/s, fails at 4 MB/s. ScoutCopilot was 7.74 when Supabase complained; the quiet fleet
  sits at 0.06-0.5.
- `scripts/check-supabase-build-currency.mjs` — how far behind the current platform build
  each project is. On the day of the incident, 19 of 21 projects were behind.

Both discover their targets from the environment, so a new product is covered without
editing either file, and both report a machine they cannot read rather than skipping it.
Wired into `monitor.yml` as `always()` steps.

## The process lesson

The first diagnosis (the logins) was asserted from a plausible story and shipped with a
confident report. Disproving it took five minutes: remove the suspected cause, measure the
effect again. Where an experiment is possible, run it before reporting, and put the
before-and-after in the report. A comparison that already exists in the fleet, SignalScore
holding the same junk with none of the symptom, beats any theory and was available from the
first hour.


## Fleet outcome, measured 2026-08-30

All 21 Supabase projects verified live: `ACTIVE_HEALTHY` and `current_app_version ==
latest_app_version == supabase-postgres-17.6.1.166`. Upgraded staging-first (9 projects,
gate passed 20:00:40 UTC), production behind the gate (12 projects, all healthy 20:10:52).

Disk load across all 20 readable machines, 180-second window:

| machine | disk load | per fetch |
|---|---|---|
| BackOffice (highest now) | 1.67 MB/s | 19.0 KB |
| ReplyFlow | 1.05 MB/s | 27.2 KB |
| Valrano Production | 0.98 MB/s | 27.4 KB |
| ChannelMover | 0.16 MB/s | 14.4 KB |
| DistributionOS | 0.06 MB/s | 11.3 KB |
| ScoutCopilot | 0.02 MB/s | 6.3 KB |

Fleet total 6.33 MB/s across 20 machines. ScoutCopilot alone was 7.74 MB/s before the
upgrade, so the whole estate now moves less disk than that one machine did. 0 FAIL,
0 WARN, 0 unreadable.

## The watchdog was broken twice, both times as a false all-clear

Running it for real rather than trusting it found both:

1. The metric parser built its regex from an escaped JS string and matched nothing, so
   every machine reported "unreadable". A peer session found the same bug independently
   the same night; their exported regex version is upstream and was kept, mine dropped.
2. The 30-second sample window was shorter than Supabase's own counter refresh, so both
   samples read identical values and **all 20 machines scored a perfect 0.00 MB/s, OK**.
   Window raised to 180s; an unmoved counter pair is now reported as inconclusive.

Both are pinned by `test/check-supabase-machine-health.test.mjs` (19 cases, all passing).
A monitor reporting perfect zeros across a whole fleet is lying, and that is the specific
shape this file exists to stop.

## Cost

Money spent: **nothing**. Every step was a free platform upgrade. The advice to buy Micro
compute add-ons (~$9.68/month per project, from Supabase's billing catalogue) was written
into the first draft of this plan, disproven by LaunchReady running the same 431 MB machine
at 0.06 MB/s, and withdrawn before anything was bought.

## Still open, each its own subject

- BackOffice holds 1,688 non-healthcheck sessions, DistributionOS 486 — probably the IMAP
  OTP account, which the name filter on this sweep did not match.
- ScoutCopilot's `error_log` holds 2,865 rows of one repeated `generate-photo` auth error.
- `sessions_timebox` and `sessions_inactivity_timeout` are `0` on every project read, so no
  login on any product ever expires. Turning that on changes how long real customers stay
  signed in, so it is Roger's decision, not an engineering default.


---

# Closing record, 2026-08-30

Roger signed this off with "you can consider it the task is done". Everything below was
measured, not assumed, and every number has its arithmetic or its source next to it.

## 1. The cause, in one paragraph

ScoutCopilot's machine ran Supabase platform build `supabase-postgres-17.6.1.084`. On that
build it read ~74 KB from disk for every page fault, ~96 times a second, permanently. Nothing
we wrote was involved. The free upgrade to `17.6.1.166` fixed it. All 21 projects are now on
`17.6.1.166`, upgraded staging-first (9 staging, gate passed 20:00:40 UTC) with production
gated behind a clean staging result (12 projects, healthy 20:10:52 UTC).

## 2. Everything that was NOT the cause, each killed by measurement

| Theory | How it died |
|---|---|
| Abandoned health-check logins | Deleted 15,824; disk rate went 1.05 -> 1.11 MB/s, unchanged |
| The database itself | Data disk 195 GB vs OS disk 29,251 GB over the same 31.9 days |
| Visitor traffic | BackOffice: 15,906 requests/6h at 0.48 MB/s; ScoutCopilot: 5,391 at 7.74 |
| The free plan / small machine | LaunchReady, identical 431 MB, runs at 0.06 MB/s |
| Edge-function count | BackOffice has 55 and is quiet; ScoutCopilot had 16 and was not |
| Checkpoints | 66 in 6 hours, writing 5-107 buffers each |
| Disk nearly full | 76.0% ScoutCopilot vs 79.4% BackOffice; the quiet ones are fuller |
| A stuck machine | Restart moved it 74.1 -> 74.4 KB per fault, i.e. nothing |
| Needing bigger machines | Recommended in the first draft, **withdrawn**, never bought |

## 3. What was actually changed

| Change | Where | Result |
|---|---|---|
| Platform build `.084` -> `.166` | all 21 projects | ScoutCopilot 7.74 -> 0.67 MB/s (0.67/7.74 = 8.7%) |
| Monitor signs out after each run | `lib/revokeSessions.ts` | proven: 3 logins left 8 sessions, teardown took it to 0 |
| Abandoned sessions deleted | 7 products, then 2 more | 111,117 + 2,167 = **113,284** |
| Stale-login expiry, 30d idle / 180d absolute | 2 Pro projects natively, 19 by hourly sweep | first sweep removed 3,515 |
| Disk-load watch, warn 2 MB/s fail 4 | `check-supabase-machine-health.mjs` | 12 products |
| Build-currency watch | `check-supabase-build-currency.mjs` | every account, 15 tokens |
| Alarms reach the cockpit | `lib/fleet-signal.mjs` | proven: real signal filed, read back, deleted |

Fleet disk load after, all 20 readable machines, 180s window: highest BackOffice 1.67 MB/s,
ScoutCopilot 0.02 MB/s, **fleet total 6.33 MB/s**. ScoutCopilot alone was 7.74 MB/s before,
so the whole estate now moves less disk than that one machine did.

## 4. Session policy and why it is what it is

Supabase's docs: keep the 1-hour access token ("most applications should use the default"),
keep refresh-token rotation, keep the 10-second reuse window ("we do not recommend changing
this value"). All three were already correct on all 21 projects and were NOT touched.

OWASP's familiar figures (idle 15-30 min, absolute 4-8 h) are written for applications where
the session cookie IS the credential. With an hourly rotating token they would sign customers
out repeatedly for no gain. Deliberately not applied.

What was missing was the long stop: `sessions_timebox` and `sessions_inactivity_timeout` read
`0` on all 21. Now idle 30 days / absolute 180 days everywhere. Supabase gates the native
setting behind Pro (402 "User sessions can only be configured on Pro Plans and up") and only
2 of 21 are Pro, so the other 19 get the identical policy from `expire-stale-sessions.mjs`
hourly, at no cost.

## 5. My own guards were broken three times, always as a FALSE ALL-CLEAR

Every one found only by running them against the real fleet:

1. The metric parser built its regex from an escaped JS string and matched nothing, so every
   machine read as "unreadable" and the check exited 0. A peer session found the same bug the
   same night; their version is upstream and mine was dropped.
2. A 30-second sample window was shorter than Supabase's counter refresh, so both samples read
   identical values and **all 20 machines scored a perfect 0.00 MB/s, OK**. Window now 180s and
   an unmoved counter pair reports as inconclusive.
3. Both checks only called `process.exit(1)`, which reds the run and triggers `send-alert.mjs`
   — which reads Playwright's `results.json`. The email would have listed **zero** failures
   while the finding appeared nowhere. Both now file to `cockpit.predivo.ch/signals`.

Plus a fourth in the expiry sweep: the "remaining" count sat inside the delete statement, where
every CTE reads the pre-delete snapshot, so it printed "deleted 3384, 9401 remain" against a
pre-delete total of 9401. Caught by verifying against the live database instead of the script's
own output. 24 tests now cover these.

## 6. Cost

**Nothing, at any step.** Every fix was a free platform upgrade or code. The one spending
recommendation I made (~$9.68/month per project for Micro compute, from Supabase's billing
catalogue) was disproven by LaunchReady running the same 431 MB machine at 0.06 MB/s and
withdrawn before anything was bought.

## 7. Left open, each needing its own session

- `noreply@backoffice.predivo.ch` is STILL creating sessions inside BackOffice and never
  signing out (1,682 cleared today, was still adding at 11:10). Not the production-monitor,
  whose sign-out fix shipped in c55d376. The 30-day expiry now caps it, but the leak is real.
- ScoutCopilot's `error_log` holds 2,865 rows of one repeated `generate-photo` "Missing or
  invalid Authorization header", roughly 24/hour, steady.

## 8. The process lesson, which cost the most

The first diagnosis (abandoned logins) was asserted from a plausible story and shipped with a
confident report and a code fix. Disproving it took five minutes: remove the suspected cause,
measure again. **Where an experiment is possible, run it before reporting, and put the
before-and-after in the report.** And a comparison already sitting in the fleet beats any
theory: SignalScore held 11,956 of the same abandoned sessions with zero symptom, which killed
the login theory on hour one, and I did not look for it.
