# A listener for ChannelMover's "same customer emailed twice" warning

**Date:** 2026-09-04 · **Commit:** `b5b1064` · **Item:** `if-a-customer-gets-the-same-email-twice-alert-me-like-a`

## The problem
ChannelMover's `lifecycle-tick` (supabase/functions/lifecycle-tick/index.ts, commit 9a7ab98)
emits `console.warn("[lifecycle-tick] WARNING: duplicate account-level step ...")` and returns the
same text in its response `warnings[]` whenever it sends the same account-level email to one person
twice on a UTC day. That is the signature of a stale deploy — the exact fault that double-emailed
our only migrating customer on 2026-08-25 (ChannelMover/docs/INCIDENTS.md, first entry). Until now
the only reader was a human opening the Supabase logs; the 2026-08-25 duplicate was found hours
late, by counting rows in a ledger. Nothing listened.

## Which surface, and why (logs, not the response body)
The warning is emitted to two surfaces. This listener watches the **edge logs** (`function_logs`),
not the response body, and the reason is mechanism, not preference:

- The tick is invoked by `pg_cron` via `net.http_post` every 5 minutes (migration
  `20260824002_lifecycle_tick_cron.sql`). `pg_net` is **fire-and-forget**: the HTTP response — and
  with it `warnings[]` — is discarded. So the response body of the run that actually sent the
  duplicate is never read by anyone.
- For a monitor to read a response body it would have to invoke the tick itself, yielding a fresh
  response computed against the current ledger; with the once-per-person guard present that
  response's `warnings[]` is always empty. It also can't contain the historical duplicate.
- `console.warn` in `function_logs` is the only durable record of what the real scheduled runs did.
  This is the brief's own hint: "the logs catch a run whose caller ignores the response." `pg_cron`
  is that caller.

## What was built
- **`scripts/check-lifecycle-duplicate-warnings.mjs`** — reads ChannelMover's `function_logs` via
  the Supabase Management API analytics endpoint (`analytics/endpoints/logs.all`, with a fallback to
  `analytics/endpoints/logs`) for the warning marker, parses each line into
  `{step, email, userId, day}`, and files a **critical / needs_human** signal via `signal-intake`
  so a duplicate customer email rings on the same wire a product being down does.
  - **Rings on the first sighting** (unlike products-down's two-run rule): a warning line is the
    durable record of an email already sent twice; it is not transient.
  - **Never files "resolved"**: a sent email is a historical fact and `function_logs` retention is
    ~1 day, so the line ages out while the incident is still true. Auto-resolving would false-close a
    real customer-visible incident. It only opens, idempotently, on a stable key that carries the UTC
    day.
  - **Three-state discipline**: the management token is resolved via the Management API's project
    list first, so a dead/refused token and a 200-with-nothing all collapse to `UNKNOWN` before the
    logs are queried; a non-2xx or unparseable payload is `UNKNOWN` too. `UNKNOWN` exits non-zero —
    could-not-look is never "no duplicates".
- **`test/check-lifecycle-duplicate-warnings.test.mjs`** — 18 behavioural assertions (parse,
  de-dup, signal shaping, and the read path failing).
- **`.github/workflows/monitor.yml`** — new hourly step "No customer was emailed the same lifecycle
  step twice", passing `SUPABASE_TOKEN_CHANNELMOVER` (already used by neighbouring checks) and
  `BOARD_SUPABASE_SECRET`.

## How it was proven
- **18/18 behavioural assertions** pass (`node test/check-lifecycle-duplicate-warnings.test.mjs`,
  exit 0).
- **4/4 anti-false-clean guard faults** pass: the repo-wide
  `test/a-check-cannot-pass-without-reaching-its-dependency.test.mjs` runs the check with its
  dependency broken (netdown / unauth / empty200 / emptyinput) and confirms it never reports a pass.
- **Live intake round-trip** against the real Cockpit board: the signal my check builds for a real
  duplicate is `critical / needs_human`; `signal-intake` accepted the payload (a downgraded,
  non-paging self-test row, resolved immediately — `will_page:false, suppressed:"not-eligible"`,
  confirming the paging gate keys on `needs_human`). So a real critical row would be page-eligible.
- **Endpoint path** confirmed live (unauthenticated probe returns 401, not 404, on both
  `logs.all` and `logs`).

## Not done (and why)
The brief's preferred proof was to make a duplicate warning **originate on live staging** and watch
the alert. That was not performed: with the once-per-person guard present the tick cannot produce a
duplicate, so reproducing it requires deploying a deliberately guard-broken build to ChannelMover
**staging** plus seeding staging data — which needs live staging credentials this machine does not
hold (0 management tokens present) and which must not be imported here (a security decision that is
Roger's). The **live log-read path** therefore verifies in CI, on the next scheduled monitor run,
where `SUPABASE_TOKEN_CHANNELMOVER` is live; a wrong endpoint/dialect fails **loud** (`UNKNOWN` →
exit 1 reds the monitor), never silently clean.

## Parked as separate items (brief step 4 — other unread warnings found)
- `nothing-notices-when-a-paying-customer-s-paused-migratio` — ChannelMover `migration-watchdog`
  console.warns "[watchdog] Auto-resume failed" for a **paid** quota-paused migration; no Sentry,
  no listener.
- `nothing-notices-when-a-paying-customer-s-legal-gazette-a` — SignalScore `shab-monitor`
  console.warns when a paid customer's legal-gazette alert rows fail to persist; bypasses its own
  `logError`.
