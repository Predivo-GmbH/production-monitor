# Monitoring audit, 2026-09-01

Opened because ReplyFlow and SignalScore logins were dead for twenty hours and **three separate
checks reported both products healthy the whole time**. Roger: *"I do not believe that this system
is working properly as it is supposed to work."*

**Method.** For every check, ask two questions: *what does it actually prove*, and *what is the
cheapest way it could be lying?* Answers are proven by injecting the failure the check claims to
catch, never by reading the code and forming an opinion. Reading the code is how these three
passed review in the first place.

Status of this document: **partial.** What has been audited is listed under Findings; what has not
is listed under Not yet audited, and that list is the honest measure of how much of the system is
still unproven.

---

## The pattern behind all of it

Every confirmed finding is one of three shapes:

1. **The probe measures the wrong layer.** A request with no credentials is answered by the
   gateway, so the check proves the gateway is alive and says the service is.
2. **An exact comparison where a range was meant.** `status === 500` and `status !== 500` both
   pass on 502, 503 and 504, which is what a service that cannot be reached actually returns.
3. **A failed read reported as a clean result.** "Could not tell" rendered as "fine", or a
   denominator built from what the check happened to find rather than what exists.

The fleet already knows about all three shapes; several checks are carefully built against them
and say so in their own headers. The failures are where the discipline was not applied.

---

## Findings

### F1 — The pager could not see an auth outage · FIXED
`scripts/check-products-down.mjs` is the sensor armed to ring Roger's phone. It probed
`/auth/v1/health` **with no apikey** and judged `status < 500`. Supabase's gateway rejects a
keyless request itself with 401, before it reaches GoTrue. Measured 2026-09-01 on both dead
projects: keyless 401, keyed 503. It printed `OK ReplyFlow` and `OK SignalScore` on every hourly
run for twenty hours, and would print OK with the auth service deleted.
Fixed in `78a93bc`: keyed probe, three-valued verdict (5xx = outage, 401/403 or keyless = could
not tell, keyed non-5xx = healthy), 7 tests each watched to fail against the old predicate.

### F2 — The monitoring page was blind the same way, twice · FIXED
`BackOffice supabase/functions/health-monitor` had the identical keyless probe, and its login test
asked `res.status === 500` while the endpoint answered 503, so it reported `working: true` hourly.
Fixed in `5a6b67c` and `85f40c1`, deployed to staging then production. Both rules now live in the
tested `verdict.ts` module, with the two new groups watched to fail against the originals.

### F3 — Five specs let any 5xx pass as "reachable" · FIXED
`status !== 404 && status !== 500` in the backoffice, replyflow, signalscore, valrano and
ytmigration specs passes on 502/503/504. `lib/edgeFunctions.ts` had this right for the
auto-discovered functions; the hand-written test beside it did not. Fixed in `a3be48f`.

### F4 — "Can a customer log in" had no name of its own · FIXED
The suite had `full login works and dashboard loads`, but auth died inside the fixture, so
Playwright attributed the failure to the first test in the file (`public routes from manifest load
and render`) and **skipped** the login test, reporting it as neither pass nor fail. The alert
therefore pointed at the frontend, which is where a whole night of restarts went.
Fixed in `a3be48f`: `tests/api-health/auth-backends.spec.ts` probes every discovered project's
auth backend with its key, before any browser or fixture, and names what it means. Proven both
ways locally: healthy projects pass; a deliberately wrong key produces *"answered 401 ... this
probe lost its key and is proving nothing"*.

### F5 — Three products have backends nothing watches · PARKED, on the board
BoatBuddy, Distribution-OS and arivioo each have a live Supabase project in their own
`docs/Credentials.txt` and a blank `supabase_ref` in `fleet_projects`, so every layer treats them
as site-only. Board item: *"Three products have logins nobody checks, because their register row
is blank"*, with a paste-ready prompt.

### F6 — 48 findings are filed where nothing can reach a human
Measured 2026-09-01 from `fleet_signals`: **52 open signals, 48 of them `warning` /
`needs_human=false`**, which by the documented paging rule (`needs_human AND severity='critical'`)
can never ring and appear only if someone opens `/signals`. The oldest is 7.9 days. Two of them
are themselves monitoring gaps that have sat there for eight days:
`production-monitor/staging-gates-failures-produce-no-alert-mail` and
`Cockpit:ce9961c:dashboard-green-when-monitoring-board-request-fails`.
This is not a bug in any one check. It is the reason a system that detects things still feels
blind: detection is not the bottleneck, arrival is.

### F7 — A critical signal is blocked on a credential that works
`silent-failure/signalscore/production-mailer-silence` is `critical` with **`needs_human=false`**,
so it cannot page even though it is critical. Its auto-fix parked it as *"Roger - provide a
working SignalScore Supabase management PAT"* after concluding *"both sbp tokens returned 401"*.
The PAT in `signalscore/docs/Credentials.txt` works: used 2026-09-01 it lists 18 deployed edge
functions. Measured with it, `send-auth-email` had **10 successful invocations in the last 24
hours, the most recent at 09:34 UTC today**, so the signal's premise of a week-long silence is
contradicted for that function. Whether the signal meant a different mailer is unsettled.

### F8 — One failure hides the rest
In the 2026-09-01 08:57 run, the first `nightly-gauntlet` failure left the other repos' gauntlet
tests reported as skipped rather than run. A red that stops looking cannot tell you how wide the
problem is.

### F9 — Two security guards have been emailing nobody · FIXED
`check-rls-grants.mjs` and `check-auth-email-config.mjs` send their alert only
`if (violations.length && process.env.ALERT_SMTP_HOST)`, and their workflows fed that from
`secrets.ALERT_SMTP_*` and `secrets.ALERT_TO`. **None of those secrets exist in the repo** -
`gh secret list` shows `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, which is what monitor.yml sends
with. The 2026-08-31 run log shows `ALERT_SMTP_HOST:` empty, so the condition was false and the
only trace of the finding was a red workflow nothing watches.
That run was not a false alarm: it found three SECURITY DEFINER RPCs on BackOffice executable by
`authenticated` with a spoofable slug argument, plus over-broad anon grants on 129 and 22 tables.
Fixed in `d6cbae3`: both workflows now use the secrets that exist, and both scripts print an
explicit `NOT EMAILED` line when they find something with no channel configured. Proven by
dispatching the guard: the run at 09:54 shows `ALERT_SMTP_HOST: ***` and no send error.
The finding itself is parked on the board as *"Three work-board database functions can be run by
any logged-in user"*, deliberately not fixed here because those functions are what the cockpit
calls as an authenticated user.

### F10 — Nothing asked whether our own guards still run · FIXED
Thirteen workflows in this repo are on a cron and only four ping healthchecks.io. For the other
nine - the auth-email guard, the RLS guard, the drift check, the daily keep-alive that stops free
Supabase projects being paused, and five more - a schedule that silently stopped looks exactly
like a guard that runs and finds nothing wrong. GitHub disables schedules on its own after repo
inactivity, a cron can be dropped in an edit, and a workflow can be disabled by hand; none of
those produce a red run, because they produce no run.
Fixed in `d29816e`: `scripts/check-workflow-cadence.mjs` reads every cron in the repo, derives the
expected interval, and compares it with the newest scheduled run GitHub reports. Overdue is 3x the
interval, the same "only a persistently dead job fires" rule the pg_cron heartbeat uses. An
unparseable cron, a workflow GitHub will not answer for, and a workflow with no scheduled run are
each DEAD, never fine. 13 assertions, watched to fail against the naive version. It runs hourly
inside the monitor, and its first live run judged all 13 workflows inside their windows.

### F11 — A customer-facing guard on a weekly clock · FIXED
`auth-email-config-check` is the guard that catches a product unable to send login or
password-reset emails, and it ran on Mondays. A regression made on Monday afternoon was invisible
until the following Monday. It is a handful of read-only API calls, so it is now daily. The RLS
guard stays weekly on purpose: it currently has a real open finding, and a daily mail about a
finding already on the board is the kind of noise that trains an alarm away.

### F12 — A third guard promised an alert it did not have, and then could not send it · FIXED
`check-gate-coverage.mjs` labels its findings *"enrolled but gates red -> exit 1 + alert"* and contained
no mail code at all (grep for sendMail/SMTP returned 0), while `gate-coverage-check.yml` carried neither
an alert step nor a heartbeat. Fixed in `0e5ed8e`. The first dispatched run then failed with
`alert email failed: Cannot find package 'nodemailer'` because that workflow never installed
dependencies, and I wrongly reported the mail as sent, having read a grep window instead of counting
the error across the whole log. A parallel session added the dependency install (`f2b5b85`). Re-proven
on run 33509893706: the finding is reported and the full log contains **zero** occurrences of
`alert email failed`, `NOT EMAILED` or the nodemailer error.

### F13 — Two checks were skipped by the failure of the check before them · FIXED
The hourly monitor's layer-2 watchdog ("CI runner watchdog is still alive") inherited GitHub's default
`if: success()`, so it was skipped on every hour an earlier step failed, which is the hour it matters.
Proven on run 33483510991 (2026-09-01 07:43Z): that step reports `skipped` while the products-down
sensor, which carries `if: always()`, ran; and because a skipped step's outcome is `skipped` and never
`failure`, its own dedicated email could not fire either. The same defect skipped the deploy-pipeline
conformance check in `drift-check.yml` whenever the schema-drift check above it failed. Both fixed in
`262e718`. This is the same shape as the outage that opened this audit, where a fixture failure hid the
test that would have named the cause.

### F14 — Distribution-OS was releasing without its release checks, and F12 is why nobody knew · RESOLVED
The gate-coverage guard reported `*** FAIL *** Distribution-OS — staging-gates enrolled but latest run =
failure (broken gates)`. Cause of that failure, read from run 33366376127 of 2026-08-31: the gate spec's
Supabase Management API call returned `mgmt query 401: Unauthorized`, i.e. a dead management token, the
same class of dead credential replaced across the fleet that morning. The gates went green again on run
33510229696 at 2026-09-01 12:54:01Z. Verified after that: gate-coverage run 33514677706 reports
`Coverage: 7/10 required apps enrolled + green, 3 pending, 0 broken` and `All ENROLLED gate harnesses
green`. The finding is closed; what made it dangerous was not the token but F12, which meant a product
released unchecked for a day with the only trace a red weekly run nobody watches.


### F15 — A malformed reply cancelled a live outage alarm · FIXED
`check-healthchecks-down.mjs` ended its read with `return (body.checks || []).map(...)`. Any 200
whose body carried no check list produced ZERO checks, which means nothing is down, which clears
the rollup, and `main()` then FILES a signal reading *"The scheduled jobs are running again /
Everything that was dark is checking in again"*. A bad read did not go quiet: it wrote a positive
all-clear over a live outage and cancelled any page still inside its self-heal window. This is one
of the few sources permitted to ring the phone. Fixed in `a8ec07a`: `checksFrom()` throws, which is
the file's own documented behaviour for an unreadable account. Three assertions, watched to fail
against the old line, 27 green.

### F16 — Two daily jobs could report success for doing nothing · FIXED
`kb-learning\run-daily.cmd` requires the runner's own `phase=finish` marker before pinging green,
because `claude -p` exits 0 even when it did no work; a weekly-limit stop and an expired login both
exited 0 and falsely showed UP. Its two siblings, `knowledge-apply\run-daily.cmd` and
`kb-learning\run-backfill.cmd`, called that check only when the exit code was NON-zero
(`if not "%RC%"=="0" call :override_if_finished`), so the marker could rescue a false RED and could
never catch a false GREEN. Fixed in BackOffice `1792873`, symmetric now, dead routine removed, and
the decision block was run as a truth table: exit 0 with no marker returns 126 and pings failure
(the case that was green before), exit 0 with marker 0, exit 1 with marker 0, exit 1 without 1.

### F17 — Of the 24 alarms that ever asked to ring the phone, 21 never rang · FIXED

Everything above audits SENSORS. This is the first measurement of the ARRIVAL path, and it is the
answer to the question that opened this document. Read from production `fleet_signals`, not code:

* **24** signals have EVER qualified to page — `needs_human = true` AND `severity = 'critical'`,
  the only combination `upsert_signal` will arm.
* **21 of the 24 never rang.**
* **18** of those carry `page_suppressed_reason = 'routed-to-work-board'` with `paged_at IS NULL`.

Verbatim titles from the 18: *"SignalScore production mailer silent >168h"* (a week of dead
customer mail), *"Five products' Supabase management tokens are dead"*, *"One dev branch with no
upstream switched off all 24 scheduled jobs for 9.5 hours"*, *"BackOffice share-link returns every
column of project_access_requests to a token holder"*, *"All 25 guard hooks are silently switched
off on this laptop"*.

`upsert_signal` does not send a page, it SCHEDULES one at `now() + 15 min` — the self-heal window
that removed 235 of 236 alerts from Roger's life — and a 5-minute sweep delivers it. The
board-drainer runs HOURLY, and when it handed a finding to the work board it PATCHed
`page_due_at = null` unconditionally, with no test for whether the page had ever been delivered.
Any page still inside its own window was cancelled BY US, one hop before delivery, and stamped
with a reason that reads like a successful hand-off. The old code said so and thought it was fine:
*"upsert_signal treats both as closed for paging, so the pending page is cancelled either way."*

The premise under that sentence is that the work board is where Roger finds out. It is not. The
work board is a page he has to open, exactly like `/signals`. **Both are pull. The page was the
only push in the system, and the hand-off deleted it.**

> **A hand-off changes where the work lives. It never decides that he was told.**

Fixed in `9915d75` (`pageFieldsOnSupersede`) — 9 assertions, 5 watched to fail against the old
code. **The code fix alone does nothing**, and believing otherwise is how this gets "fixed" while
staying broken: `due_pages()` filters `state in ('open','acknowledged')`, so a superseded row
would keep a `page_due_at` no sweep ever looks at — armed-looking, forever, and silent, which is
worse than the bug because it reads as green. The other half is BackOffice migration
`157_a_handoff_is_not_a_delivery.sql`, which readmits exactly the one marker this path writes.
Roger's own dismissals stay silent: he has already seen those.

### F18 — The alarm on the auto-fixer called a 95%-abandoned board "working" · FIXED
`check-drainer-progress.mjs` asserts three things and its own header excluded a fourth by design:
*"A parked item is NOT dispatchable and never counts."* `dispatchable` is a number the DRAINER
computes after removing everything it has decided to stop trying — so the drainer marked its own
homework, and a board it had given up on entirely produced the same numbers as a clean one.

Proven by injection with the LIVE heartbeat of 2026-09-01 18:08 (`considered 38, dispatchable 1,
dispatched 1, parked 36`): the old `judgeDrainer` returned `ok` — *"The fleet auto-fixer is
working"* — with 36 findings no machine will ever touch again. Parked items carry
`needs_human=false`, so they cannot page and never reach the work board either; they exist only on
`/signals`.

This is the 2026-08-24 incident in a second costume. Then three stuck items ate the per-run budget
and 34 incidents waited behind them; the fix taught this script to ask *"is dispatchable work being
dispatched?"*. The drainer now PARKS stuck items instead of retrying them — correct behaviour — and
the same incidents sit untouched on the other side of the same green alarm. Parking is not wrong;
giving up **quietly** is. New `given-up` verdict on a SHARE rather than a count (so a quiet week
cannot tune it away), plus `unknown` when the drainer stops publishing the number at all — an
absent count is never read as zero. 7 new cases, each watched to fail.

### F19 — Nothing ever asked whether an alarm could reach anybody · FIXED
Every sensor in this repo asks whether the thing it watches is healthy. None asked whether, having
found something, it could TELL anyone. That question has now failed three separate ways — F17, F7,
and this — and every one was found by a person reading the database.

`upsert_signal`'s first suppressor is `if pol.source is null or not pol.may_page then reason :=
'policy-off'`. A source nobody added to `signal_page_policy` is muted absolutely, and the column
then reads like a decision somebody made. Migration 155 found `healthchecks` in exactly this state
— eleven scheduled jobs dark for two days, the phone never rang once — and wrote *"Not switched
off: NEVER ADDED."* Measured across every signal ever filed: **17 of the 23 sources that have
written to this board still have no row**, and six have already filed something page-worthy
(rows / asked to page / stamped policy-off):

| source | rows | asked to page | policy-off |
|---|---|---|---|
| `commit-review` | 132 | 3 | 70 |
| `sentry` | 34 | 1 | 13 |
| `cron` | 29 | 2 | 12 |
| `monitoring-hygiene` | 18 | 0 | 18 |
| `store-merge` | 4 | 3 | 4 |
| `board-drainer` | 1 | 0 | 0 |

`sentry` is the feed of errors real customers are hitting. It has never once been able to reach
anybody.

New hourly sensor `check-alarm-reachability.mjs` (11 assertions). It reports a source that has
filed something critical needing a person while unarmed, and any OPEN critical carrying
`needs_human=false` — a contradiction, not a threshold: the producer graded it the worst class of
thing and simultaneously said nobody need be told. It files under `production-monitor`, which is
armed, **never under the source it is reporting on**: an alarm about a mute source, filed into that
mute source, is silent by construction. A read that fails exits non-zero; an empty board is
`unknown`, never `ok`, because this board is never empty.

**It arms nothing, deliberately.** What rings Roger's phone is his choice, made with the two
buttons on `/signals` that call `set_page_policy`, and an agent arming sources on his behalf is the
default-nobody-chose failure the design exists to prevent. The design assumed he would SEE the
question; the finding of this audit is that he does not. So the question now arrives by push and he
still decides.

### F20 — The fleet health monitor's edge-function check could not fail, ever · FIXED

Found on 2026-09-02 by trying to make it fail. The whole point of the "Raise a cockpit signal on
failure" step added in BackOffice `e2492d9` was that its predecessor had detected the real outage
twice and could not tell anybody. That step had still never run against a real failure, so the
first act of this pass was to inject one: a branch with one extra probe target that does not exist,
dispatched for real. **The run came back green and the alert step was skipped.**

The reason is four characters:

```bash
STATUS=$(curl -sf -o /dev/null -w "%{http_code}" ... || echo "000")
if [[ "$STATUS" == "500" || "$STATUS" == "000" ]]; then
```

With `-f`, curl still writes the write-out and *also* exits non-zero on an HTTP error, so
`|| echo "000"` appends to the code curl already printed. Measured against the live projects:

| what happened | STATUS actually contained | flagged? |
|---|---|---|
| function does not exist (404) | `404000` | no |
| host does not resolve | `000000` | no |
| function crashed (5xx) | `500000` | no |
| healthy function | `400000` | no |

Every branch is unreachable. This step has printed `All edge functions healthy.` for ten functions
across four products on every six-hourly run since it was written, and it would have printed it
with all four projects deleted. It is the F1 shape — a probe that cannot see the failure it names —
in its purest form: not a wrong threshold, a check with **no** reachable failure state at all.

Two things follow from that, and the second is worse than the first.

**Its list had rotted, invisibly.** With the verdict repaired, three of the ten slugs answer the
platform's `NOT_FOUND`: ScoutCopilot `search-players` (the function is `search`), ChannelMover
`check-quota` (no such slug among 35 deployed), ReplyFlow `check-new-reviews` (it is
`fetch-reviews`). Read from each project's deployed-function list through the Management API. A
third of what this monitor claimed to watch had not existed for an unknown length of time, and
nothing could say so because nothing could fail.

**And the "healthy" answers prove less than they look.** The probe sends no key, so `400`/`401` mean
the function booted and rejected us — which is the honest, documented rule in
`lib/edgeFunctions.ts`, not a defect. It is recorded here so the log line is read as what it is.

Fixed on BackOffice `main`. The verdict rule is no longer hand-rolled: it is the fleet's canonical
one from `production-monitor/lib/edgeFunctions.ts`, which this loop was always a copy of — no
answer is DOWN, a 5xx that survives three attempts is DOWN (one 5xx is a cold isolate, not an
outage), a 404 carrying the *platform's* NOT_FOUND body means the function is not deployed and is
DOWN, a bare 404 from the function itself is ambiguous and is not a failure, and 400/401/403/422
mean it booted. The step also counts its probes against its targets, because a loop that quietly
probes nothing looks exactly like a loop where everything passed. The three dead slugs are
corrected, and the next one to be renamed makes the step go red instead of vanishing.

**Proven in both directions, live.** Corrected list against the real projects: 9 of 9 answered,
exit 0. Injected missing function on a branch, run 33631348072: the step reports
`Edge functions DOWN: BackOffice/drill-injected-failure-not-a-real-outage(not deployed)`, the job
goes red, and — the thing that had never been shown — the alert step **ran**.

### F21 — The alert path out of the health monitor works, and this is the first proof of it · PROVEN

Same run, 33631348072. The raise-on-failure step answered:

```json
{"ok":true,"state":"open","occurrence_count":7,"will_page":true,
 "page_due_at":"2026-09-02T12:57:39Z","suppressed":null}
```

Accepted, armed, and fifteen minutes from Roger's phone — through the real secrets, the real intake
and the real key, on a failure that was really there. The drill branch then cleared the same key
inside the same run:

```json
{"ok":true,"state":"resolved","page_due_at":null,"suppressed":"self-healed"}
```

so nothing rang and nothing was left standing on the board — the designed self-heal, doing exactly
what a fault that repaired itself in under fifteen minutes would do. Read back from production
`fleet_signals` afterwards: `state=resolved`, `paged_at=null`, `page_suppressed_reason=self-healed`.

Worth stating plainly, because it is the one thing this whole audit was opened to establish: on
2026-09-01 the monitor was right and mute. On 2026-09-02 the monitor is right and it can speak, and
that sentence is now backed by a run rather than by a diff.

### F22 — The one PUSH channel we have was describing a queue that was not his · FIXED

F17 named the shape: the work board and `/signals` are both PULL, and a fact that only lives on a
page reaches nobody. Measured again on 2026-09-02, the push side is now genuinely working — four
open signals qualified to page and all four carry a real `paged_at`, including
`check-alarm-reachability`'s own "2 critical finding(s) cannot ring your phone" at 21:57 the night
before. Open signals are down from 52 to 38. Arrival is no longer the hole it was.

Which moves the question one step along: the push channel exists, so **is what it pushes true?**
Two numbers in the morning email were not.

* *"The night shift started 48 items and finished none of them"* — the sentence Roger was handed on
  2026-09-01, which became a fleet signal and the work-board row `monitor-night-shift-10ef8471`.
  Run 33551468807 sent it with a 20-hour window; in that exact window the board holds 48
  `work_evidence` rows titled "Started by the night shift" and **all 48 are on one item**
  (`4cc9ed70`, the parked-branch item). One item was claimed overnight and none closed, so the
  number matched nothing he could see. The label mattered more than the arithmetic: 48 items tried
  and none finished is a bad night's throughput, while the same item picked up 48 times is a stuck
  loop spending a full agent session every half hour — a different problem needing a different
  answer, and the label hid it.
* *"Still waiting for you: 154"* — every item in `next` plus every blocked one, whoever it was
  blocked on. Twenty-three were actually his (16 blocked on him, 1 blocked on nobody, 7 awaiting his
  sign-off); the other 131 are the queue agents pick from. And `awaiting_signoff`, the clearest case
  of something waiting for his yes, was not in the query at all.

Both fixed on Cockpit `main`, in `scripts/morning-report.mjs`. An item count is now a count of
distinct items on both sides, the mail prints pick-ups under their own label and names the
repetition when they exceed items, and the board section prints what he owes separately from what
the queue holds. Six new defect-injected cases built from the measured nights, every one watched to
fail against the previous version, and one of them reproduces the exact sentence that was sent.

> **A number reaching him by push is not an improvement on a number he had to go and find, unless
> its label names what it counts. The email is now the only thing that arrives without him asking;
> that makes every word in it load-bearing.**

---

## Open leads from the 2026-09-01 parallel sweep

Four agents read every sensor script, all 21 spec files, all 13 workflow alert paths and all 28
scheduled-job checks. They produced roughly sixty leads, most anchored to a quoted line. **A lead is
not a finding: each one is verified against the source before anything is changed** — that discipline
is why F15 was fixed within minutes and why nothing else in this list has been touched yet. Grouped:

**Sensor logic, about 22 leads.** The sharpest: the CI-runner watchdog alerts on the TRANSITION to
paid runners and is green forever after, so the fleet can sit on paid minutes indefinitely; the
layer-2 watchdog reads a queued backlog as fresh liveness, which is the exact failure its own header
was written against; the GitHub-allowance guard cannot see a fast burn because both alarm branches
require a projection window a burst never satisfies; the Sentry check fetches 100 issues without
pagination and then auto-resolves anything it did not fetch.

**Test assertions that cannot fail, about 25 leads.** The highest-leverage: the probe behind every
product's "all deployed edge functions are reachable" test sends no key, so the gateway answers 401
before the function is ever invoked, which is the 2026-09-01 mechanism on a different endpoint. Also
four products assert a successful login by checking the URL does not contain `/auth` while their
login page is `/login`, an assertion that cannot fail; and eight BackOffice page tests assert only
that an `<h1>` is visible, which the file itself records two deleted routes once satisfied via the
not-found page's own heading.

**Scheduled-job checks, about 13 leads.** Of 28 checks, only about nine are gated on the work
succeeding; the rest ping green on an exit code from a headless CLI call that exits 0 having done
nothing. Two structural gaps stand out: one check has pinged 2,240 times and no script, task or
crontab anywhere sends it, so it exists in no repository and cannot be restored; and the night shift
at the centre of the August incident has no check at all, along with the board drainer, verify sweep,
UX scout, factory engine and commit review.


---

## What is built correctly, and should not be changed while fixing the above

- `lib/edgeFunctions.ts` `isFunctionReachable`: retries, distinguishes a platform NOT_FOUND from a
  function's own 404, treats a surviving 5xx as down, and explains why in its header.
- `check-products-down.mjs` escalation discipline: three in-run reconfirmations, and a first
  sighting that files a board row without ringing. Only the second consecutive hour pages.
- `supabase-keepalive.spec.ts` asserts a floor on how many projects it checked, so a lost secret
  cannot silently shrink coverage. `expire-stale-sessions.mjs` and `check-supabase-build-currency`
  do the same through `lib/supabase-coverage.mjs`.
- `health-monitor/verdict.ts` had a defect-injected test suite before today. The two rules that
  failed were the two that lived outside it.

---

## Not yet audited

**The alert-to-inbox path is no longer on this list.** F6 named it as the weak one and F17-F19
measured it end to end; that was the right instinct and it was worse than F6 described. What
remains:

* **11 of the 18 `scripts/check-*.mjs` sensors** have not been put one by one against the two
  questions. Audited so far: `check-products-down`, `check-auth-email-config`, `check-rls-grants`,
  `check-cron-heartbeats`, `check-gate-coverage`, `check-workflow-cadence`,
  `check-healthchecks-down`, `check-supabase-machine-health`, `check-drainer-progress`. The
  parallel sweep produced ~22 unverified leads against the rest (see Open leads); **a lead is not
  a finding.**
* **The 22 healthchecks.io checks**, mapped to what each one actually proves.
* **The remaining Cockpit tiles and their feeds.**
* **Delivery itself** — that an armed page reaches Roger's phone and inbox — is proven WEEKLY by
  `BackOffice/.github/workflows/alert-drill.yml`, not by anything here. Last scheduled run
  2026-08-26 06:15Z, green, both channels. Note carefully why that drill passing every week did
  not catch F17: the drill exercises the pipe using ONE source that is armed and never handed to
  the work board. It proves the pipe. It proves nothing about whether the other 22 sources are
  connected to it, which is exactly the gap `check-alarm-reachability.mjs` now covers.

**The methodological finding, and the reason this document should be read before the next audit.**
Every fixed item here was found by MEASURING a live system — a probe run against the real
endpoint, a fixture built from a real heartbeat, a query against the production table. Every item
still open was found by READING, and reading is how the three checks in F1-F3 passed review while
being blind. The distance between the two lists is the distance between an opinion and a fact.
