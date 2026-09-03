# Every dead-man switch in this repo, and which of them lied

**2026-09-03.** The full enumeration behind a defect that was fixed four times in one day by three
different sessions, each of which believed it was fixing one job.

## The defect

A guard exits non-zero because it **found something** — in this house the red run *is* the alert.
The heartbeat step then branches on `job.status`, or is gated `if: success()`. So the dead-man is
pinged `/fail`, or not pinged at all. healthchecks.io marks the check DOWN and
`check-healthchecks-down.mjs` files *"Scheduled job stopped running: <name>"* against a job that
ran a minute ago.

**The more useful the guard was, the deader it looked**, and the louder the finding the more
certain the silence.

## The enumeration

Every workflow in `.github/workflows/`. `PING-ON-FINDING` = does a run that worked correctly and
found something still tell healthchecks it is alive?

| Workflow | Cron | Dead-man | Before | After | Fixed by |
|---|---|---|---|---|---|
| `ci-runner-watchdog.yml` | `*/10 * * * *` | yes | **no** — `job.status` | yes | `6b78091` |
| `mailer-config-check.yml` | `47 * * * *` | yes | **no** — `job.status` | yes | `0a81e22` |
| `ci-budget-check.yml` | `10 7 * * 1` | yes | **no** — `job.status` | yes | `0a81e22` |
| `monitor.yml` | `37 * * * *` | yes | **no** — `if: success()` | yes | **this change** |
| `auth-email-config-check.yml` | `0 6 * * *` | no | n/a | n/a | — |
| `rls-grants-check.yml` | `20 6 * * 1` | no | n/a | n/a | — |
| `gate-coverage-check.yml` | `40 6 * * 1` | no | n/a | n/a | — |
| `drift-check.yml` | `43 4 * * *` | no | n/a | n/a | — |
| `cron-heartbeat.yml` | `7 5,11 * * *` | no | n/a | n/a | Named "heartbeat", pings nothing; it audits pg_cron. |
| `dashboard-update.yml` | `0 21 * * *` | no | n/a | n/a | — |
| `external-tools-freshness.yml` | `23 9 * * *` | no | n/a | n/a | — |
| `flaky-retry.yml` | `*/30 * * * *` | no | n/a | n/a | — |
| `supabase-keep-alive.yml` | `0 8 * * *` | no | n/a | n/a | — |
| `gitleaks.yml` | not scheduled | no | n/a | n/a | Push/PR gate. |
| `test.yml` | not scheduled | no | n/a | n/a | Push/PR gate. |

**Thirteen scheduled workflows. Four feed a dead-man. All four were broken**, in two different
disguises, and each was found separately.

## Why monitor.yml was the last and the largest

It was explicitly ruled *out* of scope earlier the same day — `scripts/guard-heartbeat.mjs` said so
in its header, and `test/a-working-guard-does-not-look-dead.test.mjs` **asserted** it:

> `monitor.yml is deliberately left alone - its if: success() heartbeat is a decision, not this bug`

That took the workflow's own comment at face value. The comment argues that three consecutive red
hourly runs *should* trip the check, because "a monitor red for three hours is its own incident".

The run history refutes it. Measured over the last 30 scheduled runs on 2026-09-03:

* five consecutive failures on 09-02, `06:55Z` → `10:42Z`, and four more on 09-03;
* in the three most recent (`33720969205`, `33719012111`, `33712864833`) the failing steps were
  **"Run production monitor" *and* "Send alert on failure"**, with the Heartbeat step `skipped`.

So the monitor found something, **could not mail it**, and skipped its heartbeat too — every
channel silent at once. That is precisely the condition healthchecks.io exists to break, and
`if: success()` made the escape hatch unreachable in the one case it was written for.

A three-hour **product** outage already has its own alert, its own board rows and its own red runs.
Borrowing the dead-man to say it a fourth time costs the only alarm that means *"nobody is
watching"*. A monitor that genuinely **stops running** still trips the same 180-minute tolerance,
because a job that never starts writes no report and pings nothing at all.

## What decides it now

`scripts/lib/guard-heartbeat.mjs`, one decision function with **one spec per guard as data**. The
`monitor-hourly` spec reads the Playwright report the job has always written
(`test-results/results.json`) — no new artefact was invented:

| Condition | Ping |
|---|---|
| the alert step FAILED | `/fail` — found something, told nobody |
| no / unparsable / stale report | `/fail` — checkout, `npm ci` or the browser install died, or the job timed out |
| Playwright top-level `errors` | `/fail` — a global failure; it never got as far as a test |
| every check SKIPPED | `/fail` — "no failures" meaning "no observations" is not an all-clear |
| the sweep ran and found products down | **UP** — that is a finding, and findings are not silence |

The skipped-everything case is not hypothetical: a real `results.json` on disk from
`2026-09-02T12:45Z` reads **0 passed / 0 failed / 0 flaky / 13 skipped**.

Two small extensions to the shared library, both backwards compatible: a spec's `stamp` may now be
an accessor (Playwright nests its timestamp under `stats.startTime`), and `broken`/`certified` are
read from that report the same way the other three guards' are.

## Proof

`test/a-working-guard-does-not-look-dead.test.mjs`, **51 assertions**, green — the existing suite
extended rather than duplicated, because "one decision function, not three" applies to the tests
that guard it too. New: five `monitor-hourly` decision cases, the wiring assertions for
`monitor.yml`, and the reversal recorded **in place of** the assertion it overturns, with the
evidence that overturned it.

The ratchet was tightened twice:

1. the `monitor.yml` exemption is **gone** — it was the hole the largest instance was sitting in;
2. it now tests each workflow's **contents** rather than membership of a hand-kept list, because a
   list is a second place to remember and this repo keeps finding what falls out of one.

Both negative controls were **run**, not reasoned about: restoring `if: success()` on `monitor.yml`
fails the suite, and dropping in a new workflow with a raw `curl .../fail` fails the ratchet **by
filename**. `test.yml` globs `test/*.test.mjs`, so this gates every push.

## What is NOT done here

Nine scheduled workflows have no dead-man at all. That is a real gap, tracked in a `monitor.yml`
comment, and deliberately not widened here — it would have meant inventing nine healthchecks checks
inside a session fixing a different defect.
