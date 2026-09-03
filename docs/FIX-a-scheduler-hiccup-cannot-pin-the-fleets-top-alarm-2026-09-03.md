# A scheduler hiccup can no longer pin the fleet's top alarm red

**2026-09-03** · board item `a-scheduler-hiccup-keeps-the-fleet-s-top-alarm-stuck-red` (critical)
· code: `scripts/lib/alarm-state.mjs`, `scripts/check-healthchecks-down.mjs`, `test/alarm-state.test.mjs`

## What was wrong, established from live state

The fleet's top-level dead-man's switch is healthchecks check `my-first-check`, whose name is
**"production-monitor (hourly)"**. On the morning of 2026-09-03 it had been CRITICAL and
`needs_human` for **10.7 hours**, announcing *"Scheduled job stopped running: production-monitor
(hourly)"*.

The job had not stopped running. Receipts, all taken at 06:36Z on 2026-09-03:

| Question | Answer | Where it came from |
|---|---|---|
| Does healthchecks say it is down? | yes, last ping `2026-09-02T19:57:06Z` | `node scripts/check-healthchecks-down.mjs --dry` |
| Was the alarm red on the board? | `open` / `critical` / `needs_human=true` | `fleet_signals` row `healthchecks/my-first-check` |
| **Did the job actually run?** | **yes — 02:05, 02:34, 03:01, 03:51, 05:28, 05:56, 06:34Z** | `gh run list --workflow=monitor.yml` |
| **Independent proof it ran to the end?** | **`machine_state.monitoring.updated_at = 06:36:53Z`** | written by monitor.yml's own `if: always()` step |
| The clincher | the stuck row's own `last_seen_at` was `06:36:02Z` | **the process re-stamping "production-monitor stopped running" WAS production-monitor**, 51 seconds before that same run proved itself alive |

## The mechanism

`monitor.yml`'s heartbeat step is **`if: success()`**. That welds two different facts onto one wire:

1. *the scheduler still fires this job* — the only thing a dead-man's switch ever watched; and
2. *the job was happy*.

So **any** finding by **any** of the ~20 sensors withholds the liveness ping and the top alarm goes
red about something that is not happening. It then **stays** red, because the recovery write *is*
that same gated ping: the only thing that could clear the alarm is the thing the hiccup skipped.

On 2026-09-03 the trigger was a late ten-minute cron tick judged dead by `check-workflow-cadence`
— while the watchdog it was judging had run 15/15 successfully.

### Why the previous attempt did not hold

Commit `90128ef` widened `check-workflow-cadence`'s tolerance. That removes **one trigger out of
twenty** and leaves the wire welded — and the proof is that the alarm was still red 2 hours after
that commit shipped, held by an unrelated red run.

### Why this is critical rather than cosmetic

An alarm stuck red is worse than an alarm switched off, because it teaches everybody to scroll past
the one row that is supposed to stop them. This fleet had already spent hours this week separating a
false red from a true one.

## The fix

New pure module **`scripts/lib/alarm-state.mjs`**. The rule it implements:

> **"This job stopped running" is a CLAIM. It may stand only while nothing proves the job ran.**

Before that claim is filed, `check-healthchecks-down.mjs` looks for an independent, **unconditional**
record of the job having executed — a *beacon* — and if the beacon is fresher than **the check's own
tolerance** (`timeout + grace`, read from healthchecks, not typed here: 3600 + 7200 = the 180 min
`monitor.yml` documents), the claim is false and the alarm **clears itself** with the reason written
onto the row.

The beacon for `my-first-check` is `machine_state.monitoring.updated_at`, upserted by
`scripts/factory-heartbeat.mjs monitoring` at `monitor.yml:719` under `if: always()`.

`planRun()` in `check-healthchecks-down.mjs` is now the whole run as one pure decision, so the tests
drive **the same code CI runs** rather than a re-implementation of it.

## Why this cannot mask a real outage

1. **A beacon is written by the job itself, from a step that runs unconditionally.** If the scheduler
   genuinely stops — GitHub disabling the cron, the runner never starting, the workflow file broken —
   the workflow never starts, so nothing writes the beacon, it goes stale, and the critical alarm
   stands untouched. *The failure mode the switch exists for is exactly the failure mode that cannot
   forge a beacon.* Verified fleet-wide: across all of `C:\Business`, exactly one code path can write
   `kind='monitoring'` — `factory-heartbeat.mjs`, invoked only from `monitor.yml`.
2. **No beacon, no reprieve.** Only checks named in `LIVENESS_BEACONS` (today: one) can ever be
   reprieved. All 28 other checks behave precisely as before.
3. **Unreadable is not alive.** A beacon that is missing, unreadable or unparseable leaves the alarm
   red. A failed beacon read cannot raise an alarm or clear one — it can only keep one.
4. **A future-dated beacon is not trusted.** A corrupt or clock-skewed write past the tolerance would
   otherwise be a permanent mute installed by accident.
5. **A reprieved check does not count toward the "everything is dark" rollup**, so the multi-job
   outage path keeps counting only genuine outages.

Nothing is hidden by this. Whatever made the run red is reported by the sensor that found it, on its
own row, under its own key — that is how every sensor in `monitor.yml` already works — plus
`send-alert.mjs` on `if: failure()` and the red GitHub run itself.

## Proof

**Unit + full cycle — 28 tests, `test/alarm-state.test.mjs`, all green.** The cycle is driven through
`planRun`, the real decision function: healthy → *genuinely* fails → red → still red an hour later →
restored → **green on its own with nobody clearing it** → no flapping → and red again when it stops
again. A real check-in is still described in the original words; the reprieve is not, because the job
did *not* check in and saying so would hide the mechanism.

**Live, against the real board.** `node scripts/check-healthchecks-down.mjs` at 07:02:54Z:

```
NOT DEAD  production-monitor (hourly) — the hourly monitor wrote its machine_state row 14 min ago,
          inside this check's own 180 min tolerance, so the job IS running and only its heartbeat
          ping was withheld
not dead after all: my-first-check — signal resolved (ping-suppressed).
::error::1 scheduled job(s) have stopped running. Filed on /signals.
```

| key | before | after |
|---|---|---|
| `healthchecks/my-first-check` | `open` / `critical` / `needs_human=true` / red 10.7h | **`resolved` / `info` / `page_due_at=null`** at 07:02:54Z |
| `healthchecks/ci-runner-watchdog` | `open` / `critical` / `needs_human=true` | **unchanged — still open, still critical** |

`ci-runner-watchdog` is the live genuine-failure control: it was really failing (its workflow pinged
`/fail` at 06:59) and it has no beacon, so it was untouched. **Both directions proved in one live
run.**

**Live genuine-outage branch.** The same real `planRun`, against the same live healthchecks data,
with only the beacon aged:

| beacon | filed | resolved |
|---|---|---|
| fresh (ran 5 min ago) | nothing | `resolved` "Scheduled job is running again" |
| stale (scheduler stopped 7h ago) | **`critical` / `needs_human=true` "Scheduled job stopped running"** | nothing |
| unreadable | **`critical` / `needs_human=true`** | nothing |

**No regressions:** every `test/*.test.mjs` in the repo passes (0 failing files), including the 27
pre-existing `check-healthchecks-down` tests.

## Left standing, deliberately

- **The `if: success()` gate on the heartbeat step in `monitor.yml` is untouched** — that file was
  held by another live session during this work. So **healthchecks.io itself still shows the check
  red** until a green run pings it; only the fleet board now self-corrects. Removing the weld at
  source (ping on `if: always()`, and let the sensors report unhappiness as they already do) is the
  cleaner end state and is a one-line change to that step.
- Found on the way, **not touched**, belongs to other items: `production-monitor/alert-email-undeliverable`
  and `alarms-cannot-reach-a-human` are both `superseded` onto work items; the monitor is genuinely
  red right now on an IMAP `AUTHENTICATIONFAILED` for the test mailbox; `ci-runner-watchdog` is
  genuinely failing.
