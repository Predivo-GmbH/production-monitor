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
