# Monitoring audit, 2026-09-03 — empty reads, fast burns, and a hung deploy

Third continuation of [AUDIT-MONITORING-2026-09-01.md](./AUDIT-MONITORING-2026-09-01.md) and
[AUDIT-MONITORING-2026-09-02-jobs-that-report-success-for-doing-nothing.md](./AUDIT-MONITORING-2026-09-02-jobs-that-report-success-for-doing-nothing.md).
Same method, held to the letter: for every check ask *what does it actually prove* and *what is the
cheapest way it could be lying*, and answer by **injecting the failure the check claims to catch**,
never by reading the code and forming an opinion. Everything below that says FIXED was watched to
fail first; every SOUND was watched to fail *correctly*.

This pass took the nine `scripts/check-*.mjs` sensors the first audit listed as **not yet audited by
injection**, farmed them to read-only agents one sensor each, and then re-verified every agent claim
against the source before changing a line — two agent claims on 2026-09-02 were wrong and were caught
that way, so nothing here is trusted on an agent's word. Six sensors carried a real defect; three
were proven sound. All fixes are one branch, applied centrally, with a defect-injected test each.

---

## F31 — The GitHub-allowance alarm was blind to a fast burn, and then erased its own memory of it · FIXED

`check-github-api-budget.mjs` reads the shared 5,000/hour GitHub core allowance once an hour and
files a signal when it is exhausted or on track to be. It has three alarm branches: the pool at zero
(`remaining <= 0`), a 5% floor (`remaining <= 250`), and two projection branches. The projection is
gated on `canProject = fracElapsed >= 0.1 && used >= 1500` — it refuses to speak in the first six
minutes of the window, correctly, because a burst of 200 calls in the first 30 seconds projects to
nonsense.

Between the 5% floor and that six-minute gate sat a hole the size of a truck. **A burst that spends
80–94% of the whole hourly pool in the first few minutes** — `remaining` 251–1000, `fracElapsed <
0.1` — reaches *none* of the branches: not exhausted (remaining > 0), not the 5% floor (remaining >
250), not the projection (fracElapsed < 0.1). It was reported `healthy`. Proven by injection against
the real exported `judgeQuota`:

```
used=4000/5000 at fracElapsed 0.05  ->  verdict: healthy, severity: info
used=4700/5000 at fracElapsed 0.05  ->  verdict: healthy, severity: info
```

The repo's own test at `test/check-github-api-budget.test.mjs:86-91` *codified* this: it asserted
`remaining: 300 four minutes in -> healthy`. And the second half is worse than the first: when the
verdict is `healthy`, `main()` files a **`resolved`** signal that clears any prior open alarm. So a
runaway consumer that bursts hard right after each hourly reset would have its previous hour's real
alarm **erased** every hour, from inside the six-minute blind spot.

Fixed: a projection-free branch gated to exactly `fracElapsed < 0.1` (the window the projection
refuses), firing `low`/warning when most of an hour's pool is already gone while most of the hour is
still to run — a burn *rate*, a fact knowable now, not a projection. Because it is gated to the first
six minutes it can never override or downgrade the critical projection branches that own everything
past that. Warning is "alarming" in `main()`, so it files OPEN and never resolves a live alarm. Six
new cases, watched to fail: the two injected scenarios that read healthy, the boundary at 20% left,
the small-burst-still-healthy guard, and the proof it does not downgrade the past-six-minute critical.

## F32 — A product with no registered backend was reported as having a *healthy* login · FIXED (closes F29's open half)

F29 of the 2026-09-02 audit said the design fault under it was "untouched": `check-products-down.mjs`
returned `{ ok: true }` for a product with a blank `supabase_ref`. In this file `true` means PROVEN
healthy — a customer can log in — and `null` means could-not-tell, the value `classifyAuth` returns
everywhere else. Nothing was checked for a blank-ref product, so `true` was a false green. It was
masked (the coverage denominator and the `p.supabase_ref` guards in `main()` already exclude blank
refs, so it is behaviourally neutral today) but it is the exact F5 trap: BoatBuddy, Distribution-OS
and arivioo each have a **live** Supabase backend and a blank registry row, and this branch called
their unmonitored login healthy.

Fixed: `probeAuth(no-ref)` now returns `{ ok: null, ... }`, so a future reader that trusts
`ok === true` as "login is up" can never be handed an unchecked product dressed as a proven one. The
existing test that asserted `ok === true` for this case — itself an instance of the audit's recurring
"a test that codifies the buggy assumption" shape — was rewritten to assert `null`, with the revert
watched to fail. F29's design-fault half is now closed; its other open item (the migration not yet on
Cockpit `main`) is unchanged and not this repo's.

## F33 — A deploy that hangs until GitHub kills it was reported as healthy · FIXED

`check-deploy-failures.mjs` reds a pipeline when the newest completed run's conclusion is `failure`
or `startup_failure`. GitHub has nine run-level conclusions. A deploy job that hangs until the
platform kills it ends the whole run `completed / timed_out` — a distinct conclusion — and it fell
straight through this exact-match filter as healthy. Injection confirmed: `currentFailures([{ ...,
conclusion: 'timed_out' }])` returned `[]`. This is the audit's shape B (an exact comparison where a
range was meant), and `timed_out` is not on the file's own "deliberately not red" list (staging-gate
refused, cancelled, still-running) — it was an oversight.

Fixed: `timed_out` added to the red set. A timed-out run has no `conclusion:'failure'` job, so
`classifyFailure` returns `unknown` (never mistaken for a staging-gate rejection) and `isAlarm` is
true, so it is filed as a real red. Three cases, watched to fail: the timed-out run is red, it is not
forgiven as a gate rejection, and a later green run still clears it. `cancelled` stays out on purpose.

## F34 — The staging↔prod schema-drift guard reported "identical" over a database it never read · FIXED

`check-drift.mjs` compares prod and staging schema/constraint/cron sets and reports "identical" when
they are equal — but never checked that anything was actually **read**. If both `query(prod)` and
`query(staging)` return `[]` — a permission-scoped PAT, a query against the wrong schema, a
Management-API response that answers 200 with an empty array instead of erroring — the two empty sets
are trivially equal and every leg reports total health, fleet-wide, over databases nobody read.
Injection (a `fetch` shim answering `200 []` for all 18 queries) produced:

```
OK  ReplyFlow schema columns identical (0)    OK  ReplyFlow constraints identical (0)   ...
No drift across all products.    EXIT=0
```

Fixed: a live Supabase project always has public columns, so zero columns on either side is a failed
read, not an empty schema. The schema read is now the sentinel — zero rows either side fails the run
loudly and skips that product's remaining legs, whose "identical (0)" would be the same lie. A new
suite drives the real script under `fetch` shims: an all-empty read now fails; a non-empty identical
read still passes (the guard does not cry wolf). Watched to fail with the guard reverted.

## F35 — A truncated deploy.yml conformed to the hardened standard for 7 of 12 products · FIXED

`check-pipeline-drift.mjs` asserts every product's `deploy.yml` conforms to the hardened deploy
standard. Every check is a **negative** pattern match — it fails only when a BAD pattern is *found* —
and the content-*presence* checks (§4a) run only for `staged` products. So a 0-byte or truncated
`deploy.yml` (a bad checkout, a `gh api` content truncation, an empty commit) matched no bad pattern
and passed as fully conformant, and for the 7 static/push-to-prod products there was no content
assertion at all. Injection (an empty file for a static product) reported it clean.

Fixed: assert the file is a real workflow first — every genuine fleet `deploy.yml` carries a `jobs:`
block and at least one `runs-on:` (verified against ReplyFlow/BackOffice/SignalScore, 46–82 KB each);
an empty or truncated one carries neither. A new suite builds a temp fleet of conforming files, then
truncates one static product's file: before the fix that run was green, after it the empty file is
named as drift. Watched to fail with the guard reverted.

## F36 — Three sensors put through injection and proven SOUND · PROVEN

Not every lead is a defect, and proving a check *correct* by injection is as much the job as finding a
hole. Three sensors were driven with the exact failure their prior leads described and answered right:

* **`check-ci-watchdog-alive.mjs`** — lead: "reads a queued backlog as fresh liveness." Refuted. It
  hard-filters to `status === 'completed'` and fails loud if none exist. Injected 20 fresh *queued*
  runs → `::error:: ... queued but not executing`, exit 1; injected 19 fresh queued in front of one
  200-minute-old completed run → correctly `not run for 200 minutes`, exit 1. Already fixed 2026-09-01.
* **`check-ci-runners.mjs` / `check-ci-budget.mjs` / `lib/paidRunnerReminder.mjs`** — lead: "alerts on
  the transition to paid runners and is green forever after." Refuted. The transition alert is still
  edge-triggered, but `decideReminder()` re-evaluates the persisted paid state every run and re-fires
  (proven live: fires at 13h, again at 50h, throttled at 2h) with a 12h grace and 24h re-alert.
  Level-triggered as of commit `14001f3`.
* **`check-mailer-config.mjs`** — SOUND. The implicit-TLS/STARTTLS-port mismatch (the 2026-08-20 outage
  shape) fires under a fully offline injection; an empty/unreadable secrets read forces
  `the mailer is not configured at all`, not a clean pass.

## F37 — check-edge-code-live reads a stale local git ref when run off the CI runner · MEASURED, PARKED

`check-edge-code-live.mjs` compares each edge function's newest *pushed* commit against what is live
in production. In **CI mode** (how `monitor.yml` runs it) it fresh-clones and is sound — verified. In
**LOCAL mode** (`repoSource()` line 328, active whenever `FLEET_ROOT` points at an existing checkout,
which is this box's default `C:/Business/Internal Projects`) it reads whatever the machine's
`origin/main` already points at and **never runs `git fetch`** — so a real committed-but-undeployed
fix upstream reads clean, silently, when the check is run by hand on the local machine. Proven with a
real bare remote + a never-refetched clone: ground-truth remote HEAD `2026-09-02T14:00`, the local ref
the sensor read `2026-08-20T09:00`, `compareInventories stale: []`.

Parked, not fixed here, deliberately: the scheduled/CI path — the one that actually pages — is sound,
and the fix (a `git fetch` in local mode, or a `stale-local` verdict that refuses to certify freshness
it did not confirm) needs care not to slow or break the local dev flow. Recorded so the next pass
starts from a fact, not a grep.

---

## What this pass changes about the method

Every defect here is one of the three shapes the first audit named, and the two that recur are the
dangerous ones: **an exact comparison where a range was meant** (F33's `timed_out`, F31's early-window
gap) and **a failed or empty read reported as a clean result** (F32, F34, F35 — and F37, still open).
The sharpest single lesson, from F34 and F35: *a comparison of two empty sets is not agreement, it is
two absences* — a drift check that reads nothing from both sides and calls it "identical" is the
purest form of the failure this whole audit exists to catch, and it was sitting in the two sensors
that had **no test coverage at all**. The first thing an "all clear" must prove is that it looked.
