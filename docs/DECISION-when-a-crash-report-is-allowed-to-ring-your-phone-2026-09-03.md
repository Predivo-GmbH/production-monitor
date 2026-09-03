# When a crash report is allowed to ring Roger's phone

**Status: DECISION OPEN — Roger picks. Nothing has been changed.**
Measured 2026-09-03 between 20:40Z and 21:00Z against BackOffice production (`xoecpzfsskalvjrtcbbl`),
38 signals, the entire history of the `sentry` source.

---

## The question

On 2026-09-02 ReplyFlow and SignalScore started answering `Unregistered API key` to every call
BackOffice made. The crash reporter saw it. It filed two signals. **No alarm fired**, and Roger
found the rest of the same root cause himself, 22 hours later, by looking at his own dashboard.

This document is not about a missing sensor. The sensor worked. It is about what the sensor's
output was *graded* as, and who decided that.

## Who decides severity and needs_human today

Nobody, at the moment the error arrives. Both fields are constants of the translation:

* `scripts/check-sentry-issues.mjs:181` — `severityFor()` is a straight copy of the crash
  reporter's own level. `fatal` → `critical`; **`error` and `warning` both → `warning`**;
  anything else → `info`. Nothing about the *content* of an error can raise it.
* `scripts/check-sentry-issues.mjs:205` — `needs_human: false`, **hardcoded**, with the reason
  written beside it: *"An application error is CODE, so a machine owns it. 'Needs you' on this
  board means it needs Roger, and putting an error there would change what the band means."*
* `upsert_signal` (BackOffice migration 126) pages only on `severity='critical' AND
  needs_human=true`.

Two constants and an AND. **No crash report can ever page, by construction.** Grepping this file
for `chronic|escalat|repeat` returns one comment and no rule: *"A chronic error is a board item,
never a phone call."* That is the whole escalation policy — there isn't one.

**One stale belief corrected while measuring.** The same file's header states *"`signal_page_policy`
has no `sentry` row"*. It does now: read live, `source='sentry', may_page=true`. So the silence is
NOT policy absence; the row is armed and the severity/needs_human AND is the only thing stopping it.
Fixing the grading is therefore sufficient — no policy change is also needed.

## What actually happened to the 38 signals

| | |
|---|---|
| signals from the crash reporter, all time | **38** |
| of those that ever paged | **0** |
| severity mix | 28 `warning`, 9 `info`, 1 `critical` |
| `needs_human = true` | 2 |
| suppression reasons on record | `backfill` 15, `policy-off` 13, `not-eligible` 5, `routed-to-work-board` 4, `acknowledged-first` 1 |

Zero of thirty-eight. This is not a threshold that is set too high; it is a path with no door in it.

---

## Option A — grade on CONTENT: a credential refusal is critical

An error whose text matches a credential/authorisation refusal (`Unregistered API key`,
`Invalid API key`, `JWT expired`, `JWT issued at future`, `401`, `403`, `unauthorized`,
`permission denied`, `invalid/expired token`, `signature verification`) is filed
`severity: critical, needs_human: true`. Everything else is unchanged.

**Cost, replayed over all 38 signals: 3 pages, ever.**

| first seen | product | what it said |
|---|---|---|
| 2026-09-02 21:02 | replyflow-edge | `Failed to query expiring tokens: Unregistered API key` (×31) |
| 2026-09-02 20:29 | replyflow-edge | `Failed to recover stale jobs: Unregistered API key` (×35) |
| 2026-08-20 16:55 | backoffice | `Smartlead HTTP 401: {"message":"Plan expired!"}` (×33) |

Roughly **0.75 pages a month**, and all three are things Roger would want to be told: two are the
outage this document exists because of, the third is a paid subscription that had lapsed.

*Why content and not level:* a refused credential is never the application's fault and never
self-heals. It is exactly the class where "a machine owns it" is false — no machine on this fleet
can mint a replacement key.

**Weakness, stated plainly:** it is a pattern list, so it only catches refusals somebody thought of.
A new provider phrasing its rejection differently is missed until the list is extended.

## Option B — grade on PERSISTENCE: an error that will not go away is critical

An error still unresolved N hours after it was first seen, having occurred at least M times, is
raised to `critical, needs_human: true`.

**Cost, replayed over all 38 signals:**

| threshold | pages |
|---|---|
| open ≥ 6h and seen ≥ 2× | 10 |
| open ≥ 12h and seen ≥ 3× | 8 |
| open ≥ 24h and seen ≥ 3× | 7 |
| open ≥ 24h and seen ≥ 10× | 4 |

At the middle setting (24h / 3×) it pages 7 times, of which **6 are not credential failures at all**:

* `Failed to recover stale jobs: JWT issued at future` — replyflow-edge, 66h, ×7 *(a real one A's
  pattern list missed — see the merge below)*
* `Failed to query expiring tokens: JWT issued at future` — replyflow-edge, 196h, ×4 *(same)*
* `InvalidData: received corrupt message` — backoffice, 108h, ×15, **title begins "Cleared in
  Sentry"**: it would have paged Roger about something already fixed
* `no profile for bounced address` — channelmover, 110h, ×4
* `TypeError: Cannot destructure property default of undefined` — REPLYFLOW-3, 101h, ×12
* `stripe-webhook leaves a sale unbooked when the ECB FX lookup blips` — **title begins
  "[not live]"**: a hand-filed staging-only row. It would have woken him for a defect that is not
  in production.

**At least 2 of 7 are outright false pages**, and both are visible in the title — which means B
needs its own exclusion list to be safe, i.e. exactly the maintenance burden A is criticised for.

*Strength:* it has no vocabulary. It catches a failure nobody anticipated, which is the class that
actually hurts.

---

## Recommendation: A now, with B's two real catches folded in; B only if Roger wants breadth

A pages 3 times in four months and is right all three times. B pages 7 and is wrong at least twice,
both times for a reason a one-line title check would have caught (`Cleared in Sentry`, `[not live]`).

The honest merge is **A with the pattern widened to any JWT/authorisation phrasing, not just the
ones seen so far** — that picks up both `JWT issued at future` rows B found and A missed, taking A
from 3 pages to 5 over the same four months, still under 1.25 a month, still with no false page.

If Roger wants the breadth of B as well, the safe form is **A OR (B at 24h/10× excluding any title
beginning `Cleared in Sentry` or `[not live]`)** — that is 4 additional candidates, not 7.

## The third question: may one product's copy be resolved while the same error is live elsewhere?

Measured, and the answer is more uncomfortable than expected. Across all 38 signals there is exactly
**one** case of the same error text on more than one signal
(`REPLYFLOW-EDGE-H - Error: Failed to fail job: <!DOCTYPE html>`), and both copies were resolved.

**So a "same error text" guard would NOT have caught 2026-09-02.** The ReplyFlow signals that were
resolved at 08:31Z and the BackOffice half that stayed broken did not share an error string — they
shared a *root cause* wearing two different symptoms (`Unregistered API key` in ReplyFlow's own
functions; a silent `continue` and a false "0 registered users" in BackOffice). Text matching cannot
see that.

The mechanism that can is narrower and cheaper: **when a signal is resolved because a credential was
replaced, re-probe every other consumer of that credential before the resolution is accepted.** That
is a check, not a grading rule, and it belongs with the key-sweep work rather than here.

## What this document did NOT check

* Whether the phone push transport itself still delivers. The weekly fire drill last passed
  2026-09-02T06:33Z with a 5-week green streak, but the drill proves the *signal* path; the fleet
  email channel is separately recorded as dead (SMTP 535) and was not re-tested here.
* Whether `upsert_signal`'s own dedup/cooldown would collapse a burst of credential errors into one
  page. It probably should, and that is a second question.
* Any source other than `sentry`. The other 25 sources have their own grading and were not replayed.
