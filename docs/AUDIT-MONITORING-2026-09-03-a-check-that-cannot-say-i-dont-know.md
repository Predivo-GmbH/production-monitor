# Monitoring audit, 2026-09-03 — the checks that cannot say "I don't know"

Third pass, continuing [AUDIT-MONITORING-2026-09-01.md](./AUDIT-MONITORING-2026-09-01.md) and
[AUDIT-MONITORING-2026-09-02-jobs-that-report-success-for-doing-nothing.md](./AUDIT-MONITORING-2026-09-02-jobs-that-report-success-for-doing-nothing.md).

The two previous passes each found instances of one failure: **a check that cannot distinguish
"I looked and it is fine" from "I could not look" reports FINE.** Eight were found on 2026-09-02,
each fixed by a different agent who did not know the other seven existed. Every fix was correct and
every fix was local, which is exactly why this is a CLASS and not a task: nothing stopped the ninth.

**The method here is different, and the difference is the finding.** The previous pass closed with
*"every wrong claim corrected here was originally reached by reading or grepping, and every
correction came from asking the live system."* This pass never reads a check to judge it. It
**breaks the thing the check depends on and watches what the check says.**

---

## The population, stated before it was measured

A sweep that covers "the ones I found" is the failure this row describes, so the population is
named first and by construction, not by recall.

| family | size | how counted | fault-injected here |
|---|---|---|---|
| **Node check scripts** — `scripts/check-*.mjs` | **23** (22 tracked + 1 a peer's uncommitted work-in-progress) | `ls scripts/check-*.mjs` | **yes, all 23, individually, under 5 fault modes** |
| **Playwright specs** — `tests/**/*.spec.ts` | **21 files, 171 `test(...)` call-sites** (several expand ×N at runtime over repos/projects, so the executed count is higher) | `grep -c "  test("` per file | **no — named and handed over below** |
| **Other verdict emitters** — non-`check-*` scripts whose output a human or an alarm treats as a verdict | **13** | enumerated from `scripts/` | read, not injected; findings below |

**23 is the number this pass is accountable for**, and every one of the 23 was run under every
fault. The other two families are measured, named, and explicitly *not* closed here.

---

## How the faults were injected

A preload (`NODE_OPTIONS=--import`) replaces the outside world before the check's own module graph
loads, and the check is then run as a real child process. Five faults:

| fault | what it simulates |
|---|---|
| `netdown` | every `fetch` throws `ECONNREFUSED`; every `gh`/`git` subprocess fails. The host is gone. |
| `unauth` | every `fetch` answers 401. The token was withdrawn — the most likely real cause, and the one that looks most like nothing happening. |
| `http-500` | every `fetch` answers 500. The dependency is up and broken. |
| `empty-200` | every `fetch` answers **200 with `[]`**. The dependency is up, answers successfully, and says nothing. |
| `emptyinput` | the check's own committed baseline JSON — the file naming the population it sweeps — is emptied, and the check is run from a shadow copy of the repo. The dependency it could not reach is on its own disk. |

The last two earn their place. A renamed table, a changed PostgREST filter, a row-level grant that
was taken away, and a wrong project ref **all produce a successful 200 with no rows**, and every one
of them is indistinguishable from a healthy quiet fleet unless the check knows its population is
never empty. The empty-input fault is sharper still: three of the six defects found below handle a
broken network perfectly and lied only when their local input was empty.

*(One thing that did NOT work, recorded because it looks like it does: a `--import` preload can
replace `fs.readFileSync`, and every affected check uses `import { readFileSync } from 'node:fs'`,
whose binding is snapshotted when the builtin's ESM wrapper is instantiated. Measured — the patched
member answered `PATCHED`, the named import threw `ENOENT` straight past it. A fault injector that
silently fails to inject is the same class of bug as the one being hunted. The empty-input fault
therefore builds a real shadow directory.)*

---

## The results — all 23, and what each said with its dependency broken

**17 of 23 were already correct.** They are listed because a census that only prints the failures
is the same partial-population reporting this audit is about.

### Correct — refused to report a pass under every fault

`check-auth-email-config` · `check-ci-budget` · `check-ci-runners` · `check-ci-watchdog-alive` ·
`check-cron-heartbeats` · `check-deploy-failures` · `check-drift` · `check-github-api-budget` ·
`check-healthchecks-down` · `check-rls-grants` · `check-sentry-issues` ·
`check-supabase-machine-health` · `check-workflow-cadence`

Two are worth naming for the wording they already had, because the fixes below were written to match
them rather than invented:

* `check-ci-runners.mjs:63` — *"cannot check runners, **and will not pretend the fleet is
  healthy**"*, and it writes `watchdog_broken: true` into its findings file.
* `check-alarm-reachability.mjs` — *"The board is never empty, so this is a **failed read, not a
  quiet fleet**. Unknown is never healthy."* That sentence is the whole audit in one line, and it
  was already in the repo, eight rows from a check that got it wrong.

### The six defects — measured, then fixed

| # | check | fault | what it printed | exit |
|---|---|---|---|---|
| 1 | `check-edge-code-live` | empty input | `OK  every deployed edge function is at or ahead of its committed code (0 of 0 product(s) read)` | **0** |
| 2 | `check-mailer-config` | empty input | `All declared mailers OK (1 warning(s)).` — under a table with no rows | **0** |
| 3 | `check-supabase-build-currency` | empty input | `0 projects checked, 0 behind` + `coverage: UNPROVEN` | **0** |
| 4 | `check-external-tools-freshness` | 200 with no rows | `0 live tool(s)`, `the scan has never run`, `::warning::`, filed `severity: warning, needs_human: false` | **0** |
| 5 | `check-gate-coverage` | no fleet PAT in the environment | `gate-coverage check skipped: set FLEET_READ_TOKEN …` | **0** |
| 6 | `check-pipeline-drift` | no fleet PAT in the environment | `pipeline-drift check skipped: set the FLEET_READ_TOKEN secret …` | **0** |

Every one of those sentences is TRUE. **That is the trap: the lie is not in the words, it is in the
exit, and nobody reads the words of a green run.**

Three of them are worth their own paragraph.

**#3 is the sharpest instance in the repo.** It had already worked out that it was blind, printed
the word `UNPROVEN` in English, and then handed CI a zero. The check knew, said so, and the only
channel anything downstream reads said "fine".

**#4 was blind in two independent ways at once.** `judge(null)` cannot tell "the register is empty
because the scan never ran" from "the register is empty because I could not read it", and it
asserts the first — a claim about the WORLD made from an absence of DATA. (Measured 2026-09-01: 48
live tools. The register is never empty.) And it announced that conclusion at `severity: warning,
needs_human: false`, which by this fleet's own paging rule **can never reach anybody**, behind a
`::warning::` that leaves the workflow green. The sensor announced its own blindness into a channel
guaranteed not to deliver it.

**#5 and #6 are the class in its purest form: a guard that retires itself.** Both rationalised the
skip in a comment — *"skip cleanly rather than fail the nightly — the check activates the moment the
credential is added"*. That optimises for the one day the guard is being wired up and pays for it
every day afterwards, when the identical silence means the opposite thing. `drift-check.yml` records
that this had **already happened**: *"FLEET_READ_TOKEN was never created, so this check skipped
silently in CI (dormant safety net)"*. It was dormant, that was known, and the only thing that ever
said so was a person reading a workflow log. **A dormant guard has to be loud about being dormant,
because the only person who can arm it is the one who has stopped being told.**

### Two more, found by the guard rather than by hand

`check-alarm-reachability` and `check-drainer-progress` had the reasoning and the alarm exactly
right — verdict `unknown`, severity `critical`, `needs_human: true`, filed to the board — and still
exited 0 with **no machine-readable trace that they had been blind**, because this fleet has a real
and correct house rule that a filed alarm exits 0 so it does not double-report one event. Correct
prose in a log nobody is reading is not a channel. Both now declare the verdict as well as filing it.

---

## The third state

`scripts/lib/check-verdict.mjs` (new). Three answers, not two:

```
pass     I reached the thing I judge, and it is healthy.
fail     I reached the thing I judge, and it is not.
unknown  I did not reach it. Never 'pass'. It is an incident about the CHECK.
```

`sayVerdict(state, reason)` prints one canonical line, `::check-verdict::<state> <reason>`.

**It is a printed marker and not only an exit code, on purpose.** The house rule that a filed alarm
exits 0 means the exit code cannot carry the answer: `0` legitimately means both "healthy" and
"unhealthy, and I have already told somebody properly". The marker separates those two — exactly the
distinction the guard needs and exactly the one this failure class destroys. `::warning::` and
`::error::` are explicitly *not* a third state: they decorate a log line and leave the step green,
which is how #4 stayed invisible.

`unknown` reaches a human on the same wire a real finding uses, never a quieter one:

* **#4** now files `external-tools-register-unreadable` at **`severity: critical, needs_human: true`**
  — the staleness row keeps its existing warning severity, which is a separate and deliberate
  judgement about stale-vs-blind, not something this pass changed by accident.
* **#5** emails through the same SMTP path a real broken-gate finding uses, and exits 1.
* **#6** exits 1, which `drift-check.yml` already wires to `send-drift-alert.mjs` on `if: failure()`.
  The fix was to stop lying to a wire that already existed.
* **#1, #2, #3** exit 1. "Could not tell" is never "fine".

---

## The guard: `test/a-check-cannot-pass-without-reaching-its-dependency.test.mjs`

> **No check in this repository may report a pass without having reached its dependency.**

It enforces that the only way the failure can actually be caught: by breaking the dependency and
running the check. **100 assertions** — 23 tracked checks × 4 faults, plus the population
assertion, plus 7 on the primitive itself. (It was 96 over 22 checks when written; a peer committed
the twenty-third while this pass was finishing, and the guard picked it up and failed it without
anyone asking. See "The seventh defect" below.)

Three properties make it a class-closer rather than a seventh local fix:

1. **The population is a glob, not a list** (`git ls-files scripts/check-*.mjs`). The twenty-fourth
   check is covered on the day it is written, by somebody who has never read the guard and does not
   know it exists. A guard with a hand-maintained list of subjects *is* the bug it is guarding
   against: it reports success over the population it happens to know. Its first assertion is that
   the glob found at least 20 checks, so the guard cannot become an empty sweep either.
2. **Silence plus a zero exit counts as a pass**, deliberately — because that is how a person and a
   CI dashboard read it. A check that must exit 0 while blind satisfies the guard by SAYING so. It
   cannot satisfy it by being quiet.
3. **It is a test, not a lint.** The six defects had six different shapes; two of them have no
   syntactic tell at all. What they share is a behaviour, so the guard is behavioural.

The exemption list is empty today, and an entry in it is a claim the suite *verifies*: an exempt
check must make zero outbound calls under injection, or its exemption is void.

### Proven by defect injection, both families

A guard that has never been seen to fail is not evidence of anything.

| injected defect | result |
|---|---|
| `check-pipeline-drift.mjs` put back to `console.log('…skipped'); process.exit(0)` | **3 failing** (the three network faults), 71 passing |
| `check-edge-code-live.mjs` with the empty-population branch deleted from `verdict()` | **1 failing** (the empty-input fault), 95 passing |
| both removed | **96 passing, 0 failing** |

The second matters most: with the empty-input fault absent, that defect passes all three network
faults cleanly. **A network-only guard would have shipped green over three of the six defects** —
which is how they survived two previous audits. *The dependency a check fails to reach is not always
remote, and a guard that only knows one kind of dependency measures that kind, not coverage.*

**Whole repo: every unit suite green.**

---

## Not fixed here, deliberately, and each one is real

Scope was this repo's checks. These are named rather than touched.

### In this repo, held by other live sessions — hands off, not out of scope

* **`check-products-down.mjs:182`** — `if (!ref) return { ok: true, detail: 'no Supabase project — nothing to check' }`. **`ok`, not `null`**, where this same file uses `null` for "could not tell"
  everywhere else. Named as still-open in the 2026-09-02 pass (F29) and still open. A product added
  with a blank Supabase ref is silently green. Another session held this file during this session.

### In this repo, a different family — the 171 Playwright checks

The specs have their own "could not look" mechanism — `test.skip()` — and it makes the RUN GREEN.
The repo already knows this is dangerous and built the right counter-measure **once**: floor tests
asserting the fleet-read PAT is present in CI, so a dead credential cannot silently retire a whole
file.

* **There is no equivalent floor test for the IMAP mailbox login.** If that repository secret goes
  missing, **all E2E OTP email-delivery tests across BackOffice, ReplyFlow, SignalScore, Valrano and
  ChannelMover go grey forever**, with nothing enforcing that it is configured. Same shape as #5 and
  #6, one family over. This is the highest-value single item left.
* Three tests in `distribution-os` are permanently disabled by title (`test.skip('title', …)`), not
  conditionally — they never run at all, and nothing says so.
* `tests/signalscore/…:97-108` and `tests/ytmigration/…:42-53` still assert only
  `expect(url).not.toContain('/auth')`. Both products land on `/` after sign-in, so **a run where
  the session was never established passes.** Every other product's spec was rewritten after the
  2026-09-01 twenty-hour auth outage to read the real Supabase session and assert on a
  behind-auth element. These two were missed.

### In this repo, the other verdict emitters

* **`scripts/agent-triage.mjs`** — on any agent error or timeout that is not the deliberate
  switch-off, the catch block only logs and **does not set an exit code**, then writes
  `triage-results.json` with `ran: true` and `unresolvedEscalate: []`. That is indistinguishable
  from "the agent ran and found nothing needing Roger". **The repo already contains the fix**:
  `scripts/lib/triage-run-verdict.mjs`, which its sibling `deploy-failure-triage.mjs` imports and
  uses correctly. The fix was applied to one triage script and not the other.
* **`scripts/flaky-retry.mjs`** — never sets an exit code at all, so a broken retrier is
  indistinguishable from a working one from the outside.
* **`scripts/auto-heal.mjs`** — marks a project `healed` because `gh workflow run` did not throw.
  That proves a redeploy was *dispatched*, never that it completed or that the site came back. No
  post-redeploy probe exists.
* **`scripts/auto-fix.mjs`** — "fixes" flaky failures by widening the very timeouts and console-error
  filters that would have caught a regression, then auto-commits and pushes. It can report "fixed"
  having only made the test more lenient.

### Outside this repo

Nothing. The one item filed here while this pass was running — `scripts/check-edge-env-keys.mjs`,
a peer session's uncommitted work — was committed before this pass ended and became the seventh
defect, below.

---

## The seventh defect, found by the guard hours after the guard was written

**This is the only part of this pass nobody did by hand, and it is the part that matters most.**

`scripts/check-edge-env-keys.mjs` was uncommitted peer work when the census was taken, so it sat
outside the guard, which reads tracked files only. Its author committed it (`29e6c04`) while this
pass was finishing. The next run of the suite went red on it immediately, on all four faults, with
nobody looking for it.

Its judgement is **correct** — `summarise()` already returns `'inconclusive'` for a sweep that
judged nothing, with the comment *"A sweep that judged nothing is not a pass. It is a broken
sweep."* That is exactly the third state this pass is about, written independently and written well.

**None of it had ever been reached.** The main-module guard was:

```js
if (import.meta.url === `file:///${process.argv[1].replace(/\/g, '/')}`) {
```

`import.meta.url` percent-encodes the path. This repository lives under **"Internal Projects"**, so
the space becomes `%20` on one side of the comparison and stays a space on the other:

```
their comparison : file:///C:/Business/Internal Projects/.../check-edge-env-keys.mjs
import.meta.url  : file:///C:/Business/Internal%20Projects/.../check-edge-env-keys.mjs
MATCH?           : false

$ node scripts/check-edge-env-keys.mjs
exit 0, and zero lines of output
```

**A check that cannot run at all is the purest form of this class**, and it is invisible precisely
because there is no output to be suspicious of. There is no wrong sentence to catch, no misleading
count, no branch to review — just a silent zero. It would have reported a healthy fleet forever,
from a file whose own header documents the 93-minute ReplyFlow outage it was written to catch.

Fixed to use `pathToFileURL`, the idiom the neighbouring checks in this same directory already use.
With the network refused it now makes 17 outbound attempts and reports `INCONCLUSIVE`, exit 1. Its
own suite is untouched and green: 14 passed, including a live sweep over 22 projects and 63
credentials. Receipt: `9e82554`.

**Why this is the strongest evidence in the audit.** Every other finding here was found by a session
that went looking. This one was found by a machine, on a file written by somebody who had never read
the guard, minutes after it landed, with no human in the loop. That is the difference between fixing
seven instances and closing a class — and it is entirely a consequence of the population being a
glob rather than a list. A hand-maintained list would have said 22 and been right about 22.

Guard now: **100 assertions, 23 tracked checks × 4 faults, 0 failing. Whole repo green.**

---

## What this pass changes about the method

The 2026-09-02 pass concluded that reading finds the wrong answer and asking the live system finds
the right one. This pass narrows that:

**Asking the live system while it is HEALTHY only tells you what it says when it is healthy.** Every
one of these six checks answers correctly on a good day; that is what made them survivable for
months. The question a monitoring audit has to ask is not *what does this check report*, it is
*what does this check report when it cannot see*. The only way to find out is to blind it.

And the reason this is a guard and not a seventh fix: **six agents fixing six instances correctly is
still zero defence against the seventh.** The population has to be discovered by the machine, on
every run, or the audit is just a snapshot of what one session happened to look at.
