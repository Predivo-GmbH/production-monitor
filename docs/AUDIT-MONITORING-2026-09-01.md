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

14 of the 18 `scripts/check-*.mjs` sensors have not been examined one by one against the two
questions. Also outstanding: the 22 healthchecks.io checks mapped to what each actually proves;
the remaining Cockpit tiles and their feeds; the alert-to-inbox path end to end (F6 is the finding
that this path is the weak one, not the sensors); and whether any scheduled job's own failure can
go unnoticed the way the monitor's did.
