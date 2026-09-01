# The CI Cost Guard can no longer empty the fleet's GitHub API hour — 2026-09-01

**The guard that exists to protect a budget was spending one.**

---

## What happened

The GitHub REST allowance is **5000 requests an hour, shared by the whole fleet** — every repo,
every workflow, every local script, all against the one token. A full 7-day sweep by
`check-ci-budget.mjs` needs roughly **2400** of them: one call per page of runs, then one call per
run for its jobs, and there is no cheaper aggregate (`/actions/runs/{id}/timing` returns 0 on this
account).

On the night of **2026-08-29** the guard was dispatched three times in a row while someone was
investigating a red budget reading. Three sweeps × ~2400 calls against a 5000/hour limit took the
fleet's allowance to **0/5000**, and everything else that needed the GitHub API that hour simply
stopped. Nothing in the script had any idea how much of the shared hour it was consuming.

## What was added

A cap at the single chokepoint every call already passes through — `gh()` in
`scripts/lib/gh-budget-fetch.mjs`. **Two independent limits, because they fail for different
reasons:**

| Limit | Default | What it catches |
|---|--:|---|
| `CI_BUDGET_MAX_CALLS` | 3000 | A runaway: a bad loop, or a `window_days` someone typed as 90. Counted against **our own** calls. |
| `CI_BUDGET_RESERVE` | 1200 | The shared hour running low — read live from `x-ratelimit-remaining`. Counted against **what is left on the key**. |

The second one is the limit that actually does the protecting, and it is the reason there are two.
A cap counted only against our own calls cannot see that other jobs have already spent most of the
hour before this run even started; the number that matters is not how many we personally have
spent, it is **what is left for everyone else**.

Tripping either sets `stats.stoppedBy`, and `check-ci-budget.mjs` turns that into a **HARNESS
failure**. A capped run therefore **cannot print PASS**. An incomplete sweep that certifies a clean
fleet is the exact failure this whole checker exists to prevent, and it would be worst of all
coming from the checker's own safety limit.

Every run now also prints, pass or fail:

```
github api calls  : 1043   (lowest remaining on the shared 5000/hour: 3957)
```

so a number climbing towards the cap is readable **before** it trips, not only in the failure that
says it did.

## Sizing — the mistake that was nearly shipped

The cap was first written with `maxCalls = 2200`. That is **below** what an honest 7-day sweep
needs, so every legitimate manual dispatch would have gone red. A gate that goes red on a healthy
run is one people learn to scroll past, which is worse than not having the gate — this fleet's own
deploy workflow says so in as many words about its post-deploy probe.

`maxCalls` is therefore **3000**: comfortably above the ~2400 real worst case, still well under the
5000 hour. Two tests pin it from **both** sides, so a future edit that quietly raises the ceiling to
clear a red run fails in the test rather than in production:

- the default must clear a 2400-call sweep (no false red);
- the default must stay at or under 3000, and a runaway must stop with **at least 1000 calls still
  on the shared hour**.

## How it was verified — deliberately not by dispatching

`test/ci-budget-callcap.test.mjs`, **13 checks, all green**, driving the real retry/attribution loop
with a stubbed fetch that counts calls.

Verifying a rate-limit guard by exhausting the rate limit is the same mistake with extra steps, and
the work-board row carried an explicit warning not to re-dispatch this workflow for exactly that
reason. The stub also proves things a live run could not show cheaply: that the sweep stops at the
right number, that a *later* loop cannot leak calls past the stop, and that the flag which forbids
PASS is actually set.

```
$ node test/ci-budget-callcap.test.mjs
ci-budget call cap: 13/13 checks passed
```

`test/ci-budget-giveup.test.mjs` still passes unchanged.

## The other half of the row was already done

The row also asked for "the 13 undeclared workflows" to be declared in `ci-budget.json`. **They
already were** — commit `3fd13c6`, 2026-08-30, *"ci cost guard: declare the 13 new fleet workflows"*
— and the scheduled run on 2026-08-31 (`33368782302`) passed with no `UNDECLARED` lines at all. The
row was written on 2026-08-29 and nobody updated it. Checked, rather than assumed, before writing
anything.

## What was found on the way, and deliberately not acted on here

Nine of those thirteen are the fleet's AI review workflows — the `Code Review`, `Security Review`
and `Design Review` jobs on ChannelMover, ScoutCopilot, signalscore, predivo and Cursor_Arivioo.
They are wired to run a hosted review agent on every pull request, against a paid vendor key. A CI
review billing that key is precisely what Roger prohibited on 2026-08-29, after the second surprise
invoice.

**Checked before reporting, and the news is good: the key is gone.** The repository secret those
workflows depend on is absent from all seven repos — verified by listing secret *names* through the
API, with no value read, printed or stored anywhere. The 2026-08-29 lockdown is holding and **there
is no leak.**

What is left is cosmetic rather than financial: those nine workflows still start a runner on every
pull request and then stop immediately on the missing secret. They run on our own hardware, so it
costs nothing — it is noise in the run list, not spend. Removing or disabling them is a five-repo
change with its own blast radius and belongs in its own session, not bolted onto this one.
