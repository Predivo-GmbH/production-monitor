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

11 of the 18 `scripts/check-*.mjs` sensors have not been examined one by one against the two
questions (`check-auth-email-config`, `check-rls-grants` and `check-cron-heartbeats` were, and the
first two are the subject of F9). Also outstanding: the 22 healthchecks.io checks mapped to what each actually proves;
the remaining Cockpit tiles and their feeds; the alert-to-inbox path end to end (F6 is the finding
that this path is the weak one, not the sensors); and whether any scheduled job's own failure can
go unnoticed the way the monitor's did.
