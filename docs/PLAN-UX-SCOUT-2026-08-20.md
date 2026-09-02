# PLAN, UX Scout tier (2026-08-20)

**Status:** Phases 0, 1, 2, 3, 4 and 5 (Measured + Cockpit page) are BUILT AND LIVE (2026-08-20). The Cockpit page (`/monitoring/scout`) shipped in a later session the same day, after the `factory` lock freed.
**Origin:** PostHog "self-driving" KB entry `hFra0uH2NRM`. Roger's steer: not buying it, learning from it.
**Companion memory:** `session_ux_scout_tier_proposal_2026_08_20.md`
**Sibling plan (same shape, already shipped):** `PLAN-BOARD-DRAINER-2026-08-15.md`

---

## The problem this fixes

Our whole agent tier is reactive. `~/.claude/scripts/hourly-production-check-prompt.md:24` (read 2026-08-20): *"If the latest completed monitor run is green AND no live-confirmed escalation exists: print `GREEN, nothing to do` and STOP immediately."*

Green means we look at nothing. A check finds what somebody predicted. Nothing in the fleet looks for what nobody predicted.

## CORRECTION 2026-08-20 (read this before any number below)

The friction table originally here was queried against `cuvqzwvyovxvvvuddtjd`, which is ReplyFlow **STAGING**, not production. Production is `dqmhsdzldkxngwjrxois` (`docs/Credentials.txt:26,34`; `deploy.yml:512` deploys prod there, `deploy.yml:191` deploys staging to the other). The dramatic items (onboarding lock, quota exceeded, "No stored tokens", "business already used on another account") are **E2E/test traffic on staging and do not exist on production**.

### The real production picture (`dqmhsdzldkxngwjrxois`, queried 2026-08-20)

`error_log`: 5,383 rows since 2026-06-12, latest 08:11:21Z. By month: 2026-06 = 13, 2026-07 = 3,546, 2026-08 = 1,824.

Last 14 days:

| function / operation | message | n |
|---|---|---|
| generate-reply / claude-call | Missing reviewId | 339 |
| create-checkout / checkout-session | Missing authorization header | 338 |
| create-billing-portal / portal-session | Missing authorization header | 318 |
| connect-platform / oauth | Missing authorization header | 318 |
| fetch-reviews / sync | Failed to fetch reviews: 503 UNAVAILABLE (Google) | 24 (last 08-08) |
| everything else | | 1 to 4 each |

### Fleet scale (all PROD refs, queried 2026-08-20)

| Product | prod ref | scale | error signal |
|---|---|---|---|
| ReplyFlow | `dqmhsdzldkxngwjrxois` | 4 businesses, 4 reply_profiles, 2 platform connections, 5 subscriptions, 49 reviews | `error_log` 5,383 rows; last 14d = 4 probe patterns + 1 real Google 503 cluster |
| ChannelMover | `qswluvqunswggfmesdcs` | 23 auth users, 3 migrations | `error_log` 10 rows lifetime, **0 in the last 30 days** |
| SignalScore | `ogdpgufptemcgyszmjek` | 12 auth users | `error_log` **0 rows**; `api_request_logs` **3,408 rows** (status_code / duration_ms / error_message / endpoint), `audit_log` 108 rows |

**Fleet total is roughly 39 users** (4 businesses + 23 + 12). So "rank the top N struggling users" is the wrong shape; there are not enough users for a ranking to mean anything.

### What that changes, and what it does not

**Does not change:** the architectural gap is real. `hourly-production-check-prompt.md:24` still means green equals looking at nothing, and we still cannot tell a bot from a user in the 339 + 338 + 318 + 318 rows, because no row carries a caller identity. Phase 0 converts that permanent unknown into a one-query fact.

**Changes the scout's shape:** at this scale it surfaces **every authenticated failure**, not a top-N ranking. That list will usually be short or empty, which is the correct answer, and it starts earning the moment users arrive. Ranking by distinct users is the right shape later and is deliberately deferred.

**Adds a second source:** SignalScore has no `error_log` traffic but does have `api_request_logs`. The scout reads `status_code >= 400` there.

### The bug this investigation actually found

`_shared/error-log.ts` did `context: context ? JSON.stringify(context) : '{}'` into a **jsonb** column. Verified on prod 2026-08-20: `select jsonb_typeof(context) from error_log` returns **`string`** on every row, storing the literal `"{}"` instead of the object `{}`. So `context->>'user_id'` was permanently null and every call site that already passed context (fetch-reviews, log-client-error, generate-reply's inner calls) was silently unqueryable. The same helper is copied into `arivioo`, `BackOffice`, `ChannelMover` and `signalscore`.

## Design decisions (made, with reasons)

**D1. Reports live in a NEW table, not in `monitoring_incidents`.**
Verified constraints on `public.monitoring_incidents` (BackOffice prod `xoecpzfsskalvjrtcbbl`, `pg_constraint` query 2026-08-20):
- `source` CHECK allows only `healthchecks, sentry, production-monitor, cron, silent-failure`
- `status` CHECK allows only `open, investigating, fixed, blocked, self-healed, expected`

Reusing it would need two constraint migrations AND would put reports in front of the Board Drainer (`board-drainer.mjs:79` reads `status=in.(open,blocked,investigating)`), turning free findings into paging work. **Reports are free, alarms are not.** That separation is the whole lesson. New table `public.scout_reports` in BackOffice.

**D2. Grouping is deterministic SQL. The LLM only narrates.**
Counting and ranking must not hallucinate. An LLM pass turns the top N groups into "here is what users are hitting and what it probably means". Marginal cost is one small weekly headless `claude.exe` call, same mechanism the Board Drainer already uses (`spawnSync claude.exe`), so it rides Roger's existing plan rather than metered API.

**D3. No session replay, no autocapture, no PostHog.**
Everything below runs on data we already own and write. No GDPR/nFADP reversal, no cookie banner.

**D4. Credentials read at runtime from each project's `docs/Credentials.txt`.**
Same pattern as `board-drainer.mjs:67-74` (`readBoSecret()`), never inlined, never registered in the scheduled-task env.

**D5. Phase 1 ships with an email digest, no cockpit UI.**
A cockpit page is the right long-term home but `Cockpit sql/ + mcp/` is a shared canonical surface under the workstream lock. UI is Phase 5, lock-gated.

---

## Phase 0, evidence (BUILT 2026-08-20, ReplyFlow)

**Why first:** verified on prod, `select jsonb_typeof(context) from error_log` returns `string` on every row and the stored value is the literal `"{}"`. No caller identity anywhere. A scout could count failures but could not say whether a failure hit a person or a bot, and an unverifiable report must never become a PR.

**What was actually changed (narrower than first planned).** The original scope said "11 call sites across 6 functions". On reading them, 6 of the 11 already pass context; only the **4 top-level catches** produce the high-volume rows, so only those 4 were touched:

| file | line | what it now passes |
|---|---|---|
| `generate-reply/index.ts` | top-level catch | `has_auth, service_call, has_review_id, review_id, business_id, preview, user_id` |
| `connect-platform/index.ts` | top-level catch | `has_auth, user_id, action, platform, business_id` |
| `create-checkout/index.ts` | top-level catch | `has_auth, user_id, plan, annual` |
| `create-billing-portal/index.ts` | top-level catch | `has_auth, user_id, has_stripe_customer` |

Plus the real fix in `_shared/error-log.ts`: pass the **object**, not `JSON.stringify(...)`, so `context` lands as jsonb and `context->>'user_id'` works.

**Privacy:** ids and booleans only. No email, name, review text, prompt, card data or token is ever written to `context`.

**The discriminator this buys.** `has_auth=false` on a `Missing reviewId` proves the 2026-07-29 bot/probe calibration. The same message with a `user_id` is a real UI bug that must never be filtered away with it. Today those 339 rows are indistinguishable; after this they are one query apart.

**Route header: DEFERRED, deliberately.** Tagging the client path would need `x-rf-route` added to `Access-Control-Allow-Headers` in `_shared/cors.ts`, which has **37 consumers** that would all need redeploying, plus a frontend change (there is no central invoke wrapper; 107 direct `functions.invoke` call sites). `function_name + operation + action + platform` already answers "where", so the route buys little for a large blast radius.

**Deploy:** `_shared/error-log.ts` has **16 consumer functions**, so the jsonb fix only takes effect where redeployed. The repo's `deploy.yml` bulk-deploys ALL function dirs on both lanes (`deploy.yml:189-191` staging, `deploy.yml:510-512` prod), so a normal deploy covers all 16.
**Done when:** a fresh prod `error_log` row shows `jsonb_typeof(context)='object'` and a real `user_id`.
**Rollback:** revert the commit; `context` was already optional.

---

## Phase 1, the scout (READ-ONLY, propose-only)

**New:** `production-monitor/scripts/ux-scout.mjs` plus `test/ux-scout.test.mjs`.

**Reshaped for the real fleet size (~39 users).** No top-N ranking. The scout reports **every authenticated failure**, and separately summarises the unauthenticated probe patterns so they are visible but never mistaken for user pain.

**What it does, once a week:**
1. Read each product's signal table over the last 7 days, against the **PROD** ref taken from that repo's own `deploy.yml` (never a ref recalled from memory; that is the mistake this plan already made once).
   - ReplyFlow `dqmhsdzldkxngwjrxois` and ChannelMover `qswluvqunswggfmesdcs`: `error_log`
   - SignalScore `ogdpgufptemcgyszmjek`: `api_request_logs` where `status_code >= 400`
2. Split each row into **authenticated** (`context->>'user_id'` present) and **unauthenticated/probe**.
3. Every authenticated failure becomes its own report with full evidence. Probe patterns are collapsed into one counted summary line.
4. One headless `claude.exe` call writes a short "what happened, what it probably means" per authenticated group. Skipped entirely when there are none, so a quiet week costs nothing.
5. Upsert into `public.scout_reports`.
6. Email one weekly digest. Silent when nothing new.

**New table `public.scout_reports`** (BackOffice migration):
`id, product, source_table, function_name, operation, message_pattern, first_seen, last_seen, occurrences, distinct_users, authenticated bool, sample_evidence jsonb, narrative text, state text, state_reason text, created_at, updated_at`
with `state` in `new | real | not-real | known | fixed` and a unique key on `(product, function_name, message_pattern)`.

**Hard limits:** read-only against product DBs. Writes only to `scout_reports`. Opens no PR, touches no product code, files nothing into `monitoring_incidents`, pages nobody.
**Enable/disable:** `UX_SCOUT_ENABLED=1` to run, `UX_SCOUT_DISABLED=1` kill switch, default off until registered.
**Done when:** one real weekly digest lands and its contents match a hand check.

---

## Phase 2, the second shift

Register the scheduled task (`setup-ux-scout-task.ps1`, mirroring `setup-board-drainer-task.ps1`), weekly. Add its row to `AUTOMATIONS_RUNBOOK.md` per the birth-certificate rule at line 7, including the alarm: run errors email Roger via `send_report_email.py`, same as the Board Drainer.

**Gate:** one supervised dry run first (`UX_SCOUT_ENABLED=1` without live write), Roger reads the classifications before it writes anything.

---

## Phase 3, triage teaches the scout

Roger marks each report `real` / `not-real` / `known` with a one-line reason. The reason is stored in `scout_reports.state_reason` and the scout reads past dismissals so it stops re-filing the same thing.

This is the piece that replaces the hardcoded `AI_NOISE` array with something that cannot silently go stale. It is also the cheapest thing PostHog does that we do not: *"When you dismiss or snooze a report and say why, that note is forwarded to the scout that filed it"* (posthog.com/docs/self-driving/inbox, fetched 2026-08-20).

Marking interface for Phase 3 is a reply to the digest email or a one-line CLI, **not** a cockpit page. UI comes later.

---

## Phase 4, promote to fix (AUTONOMY GATE, needs explicit Roger approval)

Only reports Roger has marked `real` become eligible for the Board Drainer, under its **existing unchanged** autonomy boundary (`BOARD-DRAINER-RUNBOOK.md`: destructive DB, secrets, payments, customer comms and prod promotion of product code always escalate).

Also in this phase: replace the hardcoded `MAX_PER_RUN = 3` (`board-drainer.mjs:49`) with a severity threshold dial, so autonomy is expressed as policy rather than a magic number. PostHog's equivalent is the P0/P1+/P2+/P3+/All selector.

**This phase is where a robot starts changing product code because of a UX signal. It does not start without a separate yes.**

---

## Phase 5, Measured, and the cockpit page

- **Measured:** N days after a fix closes, the scout re-runs that one signal's query and reports whether it actually dropped. This upgrades every receipt in the fleet from "the change was made" to "the problem stopped". Cheapest high-value item in the whole plan, but it needs Phases 0 to 4 to have something to measure.
- **Cockpit page:** a Reports surface next to the Monitoring board. **Blocked on the `factory` workstream lock**, do not start while another session holds it.

---

## Cost

Marginal cost is one small weekly headless `claude.exe` invocation (Roger's existing plan, not metered API), plus SQL reads against DBs we already own. No new vendor, no new subscription, no credits. **Estimated marginal spend: $0.**

## Sequencing and gates

`Phase 0 -> Phase 1 -> [Roger reads first digest] -> Phase 2 -> Phase 3 -> [Roger's explicit yes] -> Phase 4 -> Phase 5`

Phases 0 and 1 are the ones Roger approved on 2026-08-20. Everything from Phase 4 on needs a fresh yes because that is where autonomy widens.

## Loose ends found during planning (not part of this plan)

- **SignalScore `error_log` has 0 rows** (`ogdpgufptemcgyszmjek`, queried 2026-08-20). The helper exists at `signalscore/supabase/functions/_shared/error-log.ts` (1 call site). Dark instrumentation, so the scout will find nothing there until it is wired.
- **ReplyFlow `ad_funnel_events` has 0 rows.** Same shape.
- **ChannelMover analytics is WIRED.** CORRECTED 2026-08-20: an earlier note in this session claimed `posthog-js` was a dead dependency with no init. That was WRONG, and it came from grepping `src/` in a repo that has no `src/`. ChannelMover is an **EXPO** app; its source is `app/ components/ hooks/ lib/`, and `lib/analytics.ts` imports posthog-js and calls `posthog.init` with the same cookieless config as the others (persistence memory, autocapture false, disable_session_recording true). **Lesson: confirm a repo's actual source layout before concluding anything is unused.**
- **`POSTHOG_PERSONAL_API_KEY`** (`BackOffice/docs/Credentials.txt:123`, host `eu.posthog.com`) is alive but has no read scopes (403 `permission_denied`, not 401) and zero consumers in the codebase.


---

# BUILD LOG (2026-08-20)

Roger approved the plan and said to develop through as far as possible without stopping for approvals unless genuinely needed.

## Shipped

| Phase | State | Evidence |
|---|---|---|
| 0 Evidence | **LIVE on staging, prod promotion dispatched** | ReplyFlow `3e353c6`. Staging proof by query: newest row `jsonb_typeof(context)='object'`, `context={"has_auth": false}`; the two rows from before the deploy still read `'string'` / `"{}"`. |
| 0b jsonb fix ported | **pushed** | ChannelMover `5721994`, SignalScore `7049391`. Still present in BackOffice and arivioo. |
| 1 The scout | **BUILT, first LIVE run done** | `scripts/ux-scout.mjs`, 24 unit tests green, 11 reports written to `scout_reports` on BackOffice prod. |
| 1b Table | **LIVE both refs** | BackOffice migration 117, applied by hand to staging `vvgqkwiqauafcflshsec` and prod `xoecpzfsskalvjrtcbbl`. Verified: 21 columns, RLS on, 3 policies, RPC present. |
| 2 Second shift | **REGISTERED, LIVE** | `UX-Scout-LocalRunner`, weekly Mon 07:20, next run 2026-08-24 07:20. Battery gates off, StartWhenAvailable on. |
| 3 Triage teaches it | **BUILT, loop proven end to end** | `scripts/scout-triage.mjs`. Marked one report not-real with a reason; the next scout run logged "1 previously-judged pattern(s) will not be re-surfaced" and "1 skipped". |
| 1c Coverage | **BUILT** `924ae73`, 5 sources + explicit not-covered list |
| 5a Measured | **BUILT** | `verdict()` + `measurePass()` run on every weekly tick; `scout-triage.mjs mark <id> fixed` arms the 7-day re-check. 7 tests. |
| 4 Autonomy | **BUILT** `e9c8e44` | Roger chose "staging, then stop" + a severity threshold. Boundary UNCHANGED. |
| 5b Cockpit page | **BUILT, LIVE on prod** | Cockpit `e3d427f` (+ `d52bdb1` scrollbar fix). `/monitoring/scout`, acceptance round trip proven (details in the Phase 5b build log below). |

## Birth certificate (AUTOMATIONS_RUNBOOK.md, all five)

1. Heartbeat: no healthchecks slot, free plan at its 20-check cap (same documented precedent as Factory Engine and Commit Review). Env `UX_SCOUT_HC` is wired for when a slot frees.
2. Runbook row: added, overview count 13 to 14 tasks.
3. Tracked repo: `production-monitor` is the monitor repo itself.
4. Alarm PROVEN: a run was deliberately failed by pointing `UX_SCOUT_PROJECTS_ROOT` at a non-existent directory; the failure email sent and was confirmed to `rogmueller1976@gmail.com`.
5. Task settings standard: `StartWhenAvailable=True`, both battery gates False.

## Bug found and fixed on the way

**Board-Drainer-LocalRunner had both battery gates ON.** Audited during the birth-certificate check: `DisallowStartIfOnBatteries=True`, `StopIfGoingOnBatteries=True`, while all three sibling runners (AgentTriage, DeployTriage, Needs-Roger Closer) had them False. `New-ScheduledTaskSettingsSet` defaults them to True, and this is exactly how the brain tasks silently skipped for days on 2026-08-10. A drainer that skips looks identical to a clean board. Fixed in `setup-board-drainer-task.ps1` and the task re-registered; both now False, still ENABLED and LIVE on the 20-minute repeat.

## Coverage (added after the first run, `924ae73`)

The first build read 3 products and printed "no authenticated user hit a failure in any product". Six products write a failure table. **A scout that says "fleet-wide" while covering half the fleet manufactures false confidence, which is worse than no scout.** Fixed:

| Product | Watched | Note |
|---|---|---|
| replyflow | yes | `error_log` |
| channelmover | yes | `error_log` |
| signalscore | yes | `api_request_logs`, status_code >= 400 (`error_log` is empty) |
| arivioo | yes | `error_log`, 0 rows at 2026-08-20. Watched anyway: the day an empty source starts producing is the day nobody notices. |
| valrano | yes, **currently READ FAILED** | Management PAT returns 403 "account does not have the necessary privileges". Deliberately left in the list so the gap is reported every week rather than silently dropped. This also means the digest emails weekly until the credential is fixed, on purpose. |
| backoffice | no | internal admin tool, only user is Roger |
| scoutcopilot / launchready / distribution-os | no | no error-log helper in the repo, so there is no failure table to read |

Every digest now opens with `Coverage: N product(s) read` (plus an UNREADABLE count) and closes with the NOT-watched list and the reason for each.

## What the first live run actually found

11 reports. **Zero authenticated user failures across the whole fleet**, which given roughly 39 users is the correct answer rather than a broken run. ReplyFlow's 1,345 anonymous occurrences over 14 days are the four probe patterns; SignalScore contributed one `firecrawl HTTP 502`. Nothing paged, nothing was emailed (a quiet week is silent by design).

The honest read: the scout will find little until the fleet has users. Its value today is that the 339 `Missing reviewId` rows are now one query away from being provably bot traffic rather than a permanent unknown, and that the machinery is in place before it is needed rather than after.


---

# ROUND 2 (2026-08-20): the three coverage gaps, answered

Roger challenged all three exclusions in the coverage table above. He was right on every one; none of them were reasons, they were excuses. All three are now closed.

## 1. Valrano "READ FAILED" was never a scout problem

Root cause: Valrano's two projects moved to a new org on 2026-07-30, so the token sitting on the canonical `Access Token:` line of `Valrano/docs/Credentials.txt` is the **retired distributionos PAT**. The live one was four lines above, labelled `CI PAT on this account` ("valrano-ci-deploy").

Verified 2026-08-20: retired PAT -> **HTTP 403**, valrano-ci-deploy PAT -> **HTTP 201**.

Fixed in the credentials file itself, not worked around in the scout, so every tool that reads that file benefits.

**Then the same defect was found in Distribution-OS**: retired `supabase@` PAT on the labelled line, live `db@` "distributionos-ci-deploy" PAT further down. Same verification (403 vs 201), same fix. This is a **systemic residue of the 2026-07-30 org reorg** and is worth checking on any product whose Supabase account moved.

## 2. BackOffice: "its only user is Roger" was the wrong call

There is a user, and when it breaks he is who it breaks for. On checking: `error_log` held **22 rows, 21 of them the Smartlead `HTTP 401 "Plan expired!"` still firing that morning**. Excluding BackOffice was actively hiding a recurring failure that is already an open item. Now watched.

## 3. "No failure table exists" is a reason to build one

`ScoutCopilot` (9 auth users, 16 edge functions), `Distribution-OS` (5 users, 6 functions) and `launchready` (3 users, 2 functions) shipped with **no failure table at all**: every caught error went to `console.error` inside Supabase and vanished.

Built for each: an `error_log` migration (shape copied verbatim from the ReplyFlow production table so one scout query works everywhere, RLS on, no grant to anon/authenticated), a `_shared/error-log.ts` that passes `context` as a jsonb object **correct from the start**, and `logError` at the outermost catch of every function. Applied to staging where one exists, then production, and deployed.

### Two real defects found while doing it

**Distribution-OS had no `config.toml` at all** while production ran `stripe-webhook` and `send-auth-email` at `verify_jwt=false`. `supabase functions deploy` defaults anything undeclared to `true`, so the next bulk deploy by anyone would have silently 401'd every Stripe webhook (payment events stop applying, Stripe retries then gives up) and broken every auth email (nobody can sign up or log in). Found by reading the live state via the Management API **before** deploying. `config.toml` now records all six values verbatim. Staging had already drifted to all-true; the deploy corrected it.

**Two ScoutCopilot imports landed inside multi-line `import {` blocks** (`compare`, `import-team`), because the insertion heuristic matched the opening line as "the last import". Caught by the Supabase bundler on the first deploy attempt, which is the real gate here since `deno check` **segfaults on this repo's unmodified files at HEAD** (reproduced via `git stash`, so it is a pre-existing toolchain problem, not these edits). Both moved to first-import position, which is always valid.

## Result

| | before | after |
|---|---|---|
| Products read | 3 | **9** |
| Unreadable | 1 (valrano) | **0** |
| Products with no failure table | 3 | **0** |
| `NOT_COVERED` list | 4 entries | **empty** |

The digest still prints a coverage line when nothing is skipped ("Every product that ships edge functions has a failure table and is watched"), because going quiet about coverage is exactly how a silent cap creeps back in.

## The payoff, on production

ReplyFlow PROD, a real row minutes after the promotion landed:

```
generate-reply  "Missing reviewId"
{"preview": false, "has_auth": false, "review_id": null, "business_id": null,
 "service_call": false, "has_review_id": false}
```

`has_auth: false`. The 339-occurrence pattern is now **provably** unauthenticated traffic rather than a user hitting a wall. This morning that was a permanent unknown, and the 2026-07-29 calibration that filtered it was an assumption. It is now a fact.

## Process note

`c200c3c` was staged with `git add -A` in a repo another session was working in, and swept in an unrelated in-progress change to `lib/edgeFunctions.ts`. Not reverted (the content is valid and reverting would destroy that session's work); recorded in `41ed654`. Stage explicit paths in a repo under a shared workstream lock.


---

# PHASE 4, built 2026-08-20 (Roger's two decisions)

Asked as two concrete choices rather than a vague "needs your yes". Roger picked:

**Autonomy: "staging, then stop."** A scout report he marks `real` becomes eligible for the same fix agent, through the SAME classifier and the SAME boundary the drainer already has for product code. It writes the fix, deploys to STAGING, and escalates the prod promotion. **Nothing widened, and no new risk class exists.** The alternatives (draft-only PRs, or full prod autonomy for copy-only fixes) were both declined.

**Threshold: a severity dial**, replacing `MAX_PER_RUN = 3`, a hardcoded number whose reasoning nobody could reconstruct:

```
BOARD_DRAINER_THRESHOLD = critical | warning (default) | info
```

Items below the bar are still classified and logged every run, just not dispatched, so lowering the dial can never silently lose work. An unknown or absent severity goes **above** the bar, never below: a row we cannot grade is a row we must not skip. `MAX_PER_RUN` survives as a hard blast-radius ceiling.

## How a report becomes a fix

```
scout files a report        (free, never pages)
   -> Roger marks it `real` with a reason      <- THE GATE
   -> board-drainer picks it up, same classifier as every incident
   -> destructive / secrets / payments / OAuth / prod-promotion -> ESCALATE
   -> otherwise: fix, commit, deploy STAGING, stop
   -> report marked `fixed`, `worked_at` set, `measure_after` armed
   -> 7 days later the scout re-checks that exact signal
      -> gone | reduced | unchanged | worse
```

Reports still live in `scout_reports` and never become incidents. `scoutReportToIncident()` only shapes one for the existing agent path. Severity is derived, never invented: hit a signed-in user gives `warning`, anonymous but human-approved gives `info`, never `critical`, because a UX finding is by definition not an outage.

## Proven live, then cleaned up

A labelled self-test row, dry-run only, deleted afterwards:

- a copy-only report routed to `[claude/FIX]`
- the **same** report escalated to `[roger/VERIFY]` the moment its text contained the word "delete", because the classifier reads the narrative too

That second result is worth keeping in mind: **an LLM-written narrative can trip a safety guard, and when it does the result is escalation, never a wider action.** Fail-safe in the right direction.

10 new tests, including a regression guard asserting an OAuth-class scout report still hard-escalates exactly as it did before Phase 4 existed.


---

# FINAL ROUND: the loop caught its own author

The first unattended LIVE drainer tick with Phase 4 ran clean at **09:56:56Z**. Minutes later the commit-review automation filed **three findings against code written earlier the same day**, two of them critical. All three verified by hand before fixing.

| Finding | Where | Fix |
|---|---|---|
| **Command injection** on the operator workstation | `ux-scout.mjs` narrate() ran `spawnSync(..., { shell: true })` on production error text | `798432f` |
| **Constraint violation + fail-open loop** | `board-drainer.mjs` wrote `source='scout-ux'`, which the incidents CHECK rejects | `798432f` |
| Stuck escalations dumped every auto-fix on Roger, and compounded | pre-existing stuck block | `6dfb826` |

## The injection, because the chain is worth remembering

`shell: true` on Windows hands command+args to `cmd.exe` as one unescaped string. The prompt was built from `message_pattern` and `sample_evidence`, i.e. production error text. `NORMALISE()` collapses only UUIDs and whitespace, so quotes, `&`, `|`, `^`, `<`, `>` and newlines all survive.

The reachable path, verified by reading the file: `create-checkout/index.ts` assigns `ctx.plan = plan` **before** `isPlanKey()` rejects it. So a signed-in user puts arbitrary characters into `error_log.context` with `user_id` already set, the row groups as authenticated, and that is exactly the set `narrate()` runs on. The process holds the BackOffice service key and every product's Management PAT.

**It was dormant until the same session's jsonb fix.** Before that, `context->>'user_id'` was always null fleet-wide, nothing ever grouped as authenticated, and `narrate()` never ran on a real row. **Fixing one bug armed another.** That is the part worth carrying forward: a dormant path can be armed by an unrelated correctness fix, and neither change looks dangerous on its own.

## Why the fail-open loop is worse than it first reads

`upsertIncident` throws on a non-ok response, and the throw escaped the per-item loop. `main()` aborted **before** `markScoutReport()`, so `worked_at` stayed null; `readScoutQueue` filters on `worked_at is null`; so the same report would re-dispatch an Opus agent **every tick, forever**. And because `saveState()` also sat past the throw, `MAX_ATTEMPTS` never incremented: **the blast-radius guard failed open rather than closed.**

Fixed structurally, not by widening the constraint. A scout report is not an incident and must never become one, so `isScoutDerived()` now guards all three upsert paths, and each item is isolated in `try/catch` so one bad item costs exactly one item and still records an attempt.

## What my own verification missed, and the guard added for it

The dry-run returns before any `upsertIncident` call, and the Phase 4 tests asserted severity, id and classifier routing but never `p_source`. **A dry-run that short-circuits before the write path cannot validate the write path.** A CONSTRAINT GUARD test now fails loudly if anyone "fixes" this by renaming the source instead of keeping reports off the board.

Tests: **29 board-drainer assertions + 26 ux-scout.** Writing them caught a bug in the fix itself (the first version double-prefixed `Claude - Claude - ...`).

## Board hygiene note

Closing these, I upserted under `source='production-monitor'` when the real rows were `source='silent-failure'`, creating two duplicates. **The upsert key is `(source, key)`: read a row's actual source before closing it.** Duplicates deleted, real rows closed.


---

# ROUND 3: closing the CLASS, after Roger asked why it was safe to close

I had said the session was safe to close. Roger pushed back: why, when you just found more work. He was right. I had fixed the config.toml landmine in three repos **because I happened to deploy to them**, and never checked the other six.

## The fleet audit (all 9 products, live Management API vs each repo's config.toml)

| repo | fns | live-false | AT RISK |
|---|---|---|---|
| replyflow | 42 | 41 | 0 |
| **ChannelMover** | 32 | 32 | **32** |
| signalscore | 16 | 3 | 0 |
| Valrano | 41 | 41 | 0 (fixed earlier today) |
| **BackOffice** | 53 | 33 | **3** |
| arivioo | 57 | 45 | 0 |
| ScoutCopilot | 16 | 16 | 0 |
| Distribution-OS | 6 | 2 | 0 (fixed earlier today) |
| launchready | 2 | 1 | 0 |
| | | **TOTAL** | **35** |

A fourth instance, and the second-worst. **ChannelMover: 32 functions, zero declared.**

## Why it was worse than a manual-deploy hazard

ChannelMover's CI escaped only because both deploy steps pass `--no-verify-jwt` (`deploy.yml:208`, `:647`). But `prod-deploy-guard.mjs:160` runs

```
supabase functions deploy <fn> --project-ref <ref> --use-api
```

with **no** `--no-verify-jwt`, and `board-drainer.mjs:274` hands that script to **autonomous fix agents**. So an agent deploying one ChannelMover function to prod would have flipped it to `true` and 401'd it. An agent must never break a product as a side effect of an unrelated fix.

## The fix, in two halves

**Instances** (`d3d08b3` ChannelMover, `6fcfcc8` BackOffice): all 35 declared, read verbatim from live. Re-audit: **35 -> 0 fleet-wide.**

**The class** (`ac475be`): `prod-deploy-guard.mjs` now REFUSES to deploy any function whose live `verify_jwt` is not declared in its repo's `config.toml`, printing the exact line to add. It **fails closed** on an unreadable live state, a missing token, an undeclared value, or a config-vs-live disagreement. An undeclared value is refused even when the default would happen to match, because that means the repo is not the source of truth.

Placed deliberately **before** the dry-run early return, so `--dry-run` actually exercises it. A dry-run that short-circuits before a check cannot validate that check, which is precisely how the `scout-ux` constraint bug shipped earlier the same day. 8 tests.

## One more of my own, found the same way

`commit-review-prompt.md:68` still seeded every finding as `"p_who_must_act": "Roger"`. Commit `6dfb826` had fixed the board-drainer **consumer** half of that defect and left the **producer** untouched, so findings were still being BORN wrongly owned (4 such rows created at 09:5xZ had to be hand-corrected). Now defaults to Claude, with Roger named only for hands-only work, and the reasoning written into the file so it is not re-broken. Secondary drift fixed too: the file documented `p_source: "commit-review"`, a value the CHECK rejects outright.

## The lesson worth keeping

**Fixing three instances is not fixing a class.** Both times today I fixed what I tripped over and called it done; both times an audit of the whole fleet found more. The durable form of the fix is the one that makes the next instance impossible, not the one that clears the current list.


---

# PHASE 5b, built 2026-08-20 (later session, after the factory lock freed)

The Cockpit page, the visual equivalent of `scripts/scout-triage.mjs`. Lives at
`cockpit.predivo.ch/monitoring/scout` (Monitoring -> "UX Scout" tab, third SectionNav entry).

## What shipped (Cockpit repo)

- `src/hooks/useScoutReports.ts`: reads `public.scout_reports` directly via the shared
  Supabase client (migration 117's RLS already grants authenticated select/update, so NO
  sql/ or mcp/ surface was touched, and nothing here can write `monitoring_incidents`).
  `useMarkScoutReport` copies `scout-triage.mjs mark()` verbatim: reason mandatory for
  every state except `new` (hook throws), `fixed` sets `measure_after = now()+7d` and
  clears `measured_at`/`measured_result`.
- `src/pages/ScoutReports.tsx`: grouped by product, unjudged first. Per row: user-vs-probe
  badge (with distinct_users), occurrences, last_seen, narrative, collapsible
  sample_evidence, state + reason, measured_result chip, armed re-check note.
  Reason gate is UI-enforced: confirm disabled while empty.
- Wired: `src/App.tsx` route, `src/lib/navigation.ts` (tab + palette icon),
  `e2e/smoke.spec.ts` route list. Commits: `e3d427f` (page), `d52bdb1` (SectionNav fix, below).

## Verification (the acceptance test was the round trip, not a screenshot)

- Dev server pointed at BackOffice PROD via env override (no files edited); session minted
  via admin generate_link, so no OTP email was sent.
- Marked replyflow `create-billing-portal` "Missing authorization header" (718x, evidence
  `has_auth:false`) not-real WITH a reason through real UI clicks; REST read-back confirmed
  state + reason on prod. Confirm button proven disabled with an empty reason.
- `UX_SCOUT_ENABLED=1 node scripts/ux-scout.mjs` then logged
  "2 previously-judged pattern(s) will not be re-surfaced" (up from 1).
- Deployed: STAGING green, then promoted to PROD same day; verified live in Roger's real
  browser. Scripts kept in `C:/Business/scratchpad/scout-*.mjs|py`.

## Bug found on the way: SectionNav 1px scrollbar

Roger reported a tiny up/thumb/down scrollbar stack at the right end of the tab bar.
Measured live in his browser: the shared `SectionNav` (`overflow-x-auto` + the
`-mb-px`/`border-b-2` underline trick) overflows vertically by exactly 1px on EVERY tab
bar in the app; his Windows classic scrollbars render it, overlay scrollbars hide it.
Pre-existing, not introduced by the scout page. Fixed in `d52bdb1` (`overflow-y-hidden`),
verified gone on prod in his browser.

## Notes for the next session

- The 718x probe pattern marked not-real during acceptance is a REAL judgement on prod
  data. Roger may revisit it in the UI (Reopen).
- Staging cockpit reads the STAGING BackOffice DB, so `/monitoring/scout` on staging shows
  the empty state; the scout only writes to prod.


---

# PHASE 5b DONE: the tier is complete

The Cockpit page shipped to production on 2026-08-20 (Cockpit `e3d427f`, plus `d52bdb1` fixing a 1px SectionNav overflow that rendered a scrollbar app-wide). Live at **https://cockpit.predivo.ch/monitoring/scout**.

It reads `scout_reports` directly under the table's existing RLS, so **no `sql/` or `mcp/` change was needed** and the workstream-lock conflict that blocked it never had to be resolved. It cannot write `monitoring_incidents`, by design.

**Verified independently rather than accepted on report** (13:33Z): 24 rows / 22 new / 2 not-real / 0 authenticated on prod, both commits on `origin/main`, both trees clean, page returns HTTP 200, and critically the round trip closes: a not-real judgement entered **through the production UI** makes `ux-scout.mjs` log `2 previously-judged pattern(s) will not be re-surfaced`. The human decision reaches the machine. That was the acceptance test for the whole tier, and it passes.

## The one thing worth carrying forward

The Monitoring Board turned over to three fresh parked items, and they are **the same two defects already fixed elsewhere**: `always()` instead of `!cancelled()` (now BackOffice, Valrano and SignalScore) and blocked-routes-never-asserted (ReplyFlow, now SignalScore). The Gate A crawler is being ported product by product and reintroducing both at each port.

That is the same failure this document already records twice about my own work: **fixing instances is not fixing a class.** The durable move is to correct the template the port copies from, so the next product cannot inherit the defect.


---

# ROUND 4: closing every deferred item, and one more flaw in my own design

Roger's instruction: *"you keep saying something is not blocking but optional, so I always want to have every optional thing done."* Fair. Every parked item is now done, investigated and closed, or converted into a named finding with its exact remediation.

## The backlog is triaged: 24 of 24, zero unjudged

17 `not-real`, 7 `known`, every one with a written reason. Most are provable rather than taste: `has_auth=false` on every occurrence means no signed-in user was affected, and an auth guard rejecting an anonymous hit is the guard working. Two were investigated properly:

- The BackOffice **ledger** finding is not a live gap: one occurrence ever (2026-07-21, a race before the chart of accounts was populated), accounts 1020/3000 now exist and are active, 101 journal entries posted since, and the invoice named in its context **is booked** with its fee and a later refund. Nothing unbooked.
- The Distribution-OS **stripe signature** finding is my own verification probe from 09:26Z. The function correctly returned 400.

## The flaw the triage exposed, in the scout itself

Almost every dismissal reads *"unauthenticated probe, has_auth=false on every occurrence"*. **That is only true while the pattern stays anonymous.** The scout skipped a dismissed pattern unconditionally and forever, so the day one of those messages began hitting a signed-in user it would be silently swallowed. A filter hiding the exact thing it was built to surface, which is the "noise filter rots" failure one layer deeper than the mandatory-reason rule guards against.

Fixed **before** triaging, deliberately: dismissing 22 patterns under the old rule would have manufactured 22 permanent blind spots. A dismissal now holds only while the pattern is anonymous; a return as AUTHENTICATED reopens it, labelled so the old verdict is re-judged rather than inherited. A pre-existing test that **encoded the flaw** was corrected rather than kept.

## Two corrections to claims I made earlier in this same document

**ChannelMover's `posthog-js` is NOT a dead dependency.** I wrote that in three places. It came from grepping `src/` in a repo that has no `src/`: ChannelMover is an **Expo** app (`app/ components/ hooks/ lib/`) and `lib/analytics.ts` initialises PostHog with the same cookieless config as the rest. I had begun removing the dependency and caught it only because `npm run build` did not exist. Reverted, corrected in all five documents.

**`ad_funnel_events` is not an orphan either.** It is written by `replyflow/supabase/functions/r/index.ts`, the ad-click redirect. Zero rows is correct: the Meta campaign is held.

Both are the same mistake: concluding "unused" from a search that never looked in the right place.

## SignalScore: 1 -> 13 of 16 functions instrumented

Its `error_log` had the helper but one call site, so an empty table read as "nothing goes wrong here" instead of "nothing is looking". Three functions were deliberately **not** wired because their only candidate is a 400 JSON-guard, which would manufacture noise, and that is itself the finding: those three have **no top-level handler at all**. `get-company-officers` first landed in a helper returning `[]` and was re-targeted, the same mistake as ScoutCopilot's `report` earlier the same day. **The tail-most 2-space catch is not necessarily the handler's.**

## The Gate A treadmill, quantified

Two parked incidents cleared by porting fixes already proven elsewhere. The standing observation matters more: **there is no shared Gate A template.** `gate-a-crawl.spec.ts` is hand-copied per repo and has already drifted (641 / 593 / 576 / 538 lines). The same two defects have now been found and fixed **four times, once per product.** Until the corrected step and the `blockedRoutes` assertion are part of what the next port copies, the next product inherits both again.

## The pattern across this whole session

Four separate times today the same shape appeared, three of them in my own work:

1. Fixed the config.toml landmine in three repos, called it done. An audit found a fourth and 35 at-risk functions.
2. Fixed the stuck-ownership defect in the drainer (the consumer), left the prompt template (the producer) still seeding every finding wrongly.
3. Dismissals were permanent, so the filter could hide the thing it was built to find.
4. The Gate A rollout is fixing the same two defects once per product instead of once in the template.

**Fixing instances is not fixing a class.** The durable move is always the one that makes the next instance impossible.

---

## 2026-09-02 — the Kimi write root: the scout's narration would have died the day the engine switched

The one model call this tool makes is `narrate()`, and since 2026-08-30 it no longer spawns
`claude` itself: it goes through `Cockpit/scripts/agent-run.mjs`, the single launcher that reads
the cockpit's engine switch (`docs/CONTRACT-agent-run-2026-08-30.md`). On the **Kimi** side that
launcher builds `KIMI_JOB_WRITE_ROOTS` from the `--add-dir` values the caller passes, and it
**refuses a Kimi launch that passes none** — an agent whose write boundary is unset is exactly the
thing the switch exists to never start.

So on 2026-08-31 the narration spawn was given one (commit `1949082`):

```
'--add-dir', 'C:/Business/_ux-scout/kimi-workspace'
```

A dedicated, deliberately **empty** directory, never `UX_SCOUT_HOME` itself — that holds
`ux-scout.log`, `fatal.txt` and the dismissal digests, and handing a Kimi agent write access to
this tool's own records would be a worse boundary than none. The narration writes nothing at all;
the root exists only because the guard requires one.

**What was wrong with that.** Nothing on the machine ever created the directory, and `agent-run`
refuses a write root that does not exist just as firmly as a missing one. The scout runs weekly on
a GREEN board and its narration failure degrades to "narration unavailable" rather than an alarm —
so the first Monday after Roger put the engine on Kimi, the run would have quietly lost the one
part of it a human reads, and nothing would have said why. Fixed the same night by `1e53d20`, an
idempotent `mkdirSync(..., { recursive: true })` immediately before the spawn.

**Why there is now a test (`test/ux-scout.test.mjs`, 2026-09-02).** The fix left the two paths as
two string literals five lines apart, and drifting is the entire defect — a later edit that moves
the workspace, or drops the `mkdirSync` as "dead code", reproduces it exactly and no reader would
notice. Four assertions pin the **relationship**, not the value:

- the spawn still declares an `--add-dir` at all (without one the job cannot move to Kimi);
- the path it declares is among the paths `mkdirSync` creates;
- the creation sits **before** the spawn that is told to write there;
- the root is a dedicated subdirectory, never the state dir.

They read the source off disk rather than calling `narrate()`, which would spawn the real CLI.
Proven to catch the defect and not merely to pass: the same expressions run against
`git show 1949082:scripts/ux-scout.mjs` find the `--add-dir` literal and **zero** `mkdirSync`
literals, so the suite would have been red on the broken commit.

**Still true and deliberate:** the `UX-Scout-LocalRunner` scheduled task is **Disabled** on this
machine (last run 2026-08-24, result 0). That is the documented kill switch from
`scripts/setup-ux-scout-task.ps1`, not a fault — but it does mean the write-root fix has not yet
been exercised by a real weekly run, which is why the pin above is a test and not a log line.
