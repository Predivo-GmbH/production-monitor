# A row the auto-fixer gives up on keeps the diagnosis it cost three attempts to find

**Signal:** `production-monitor/board-drainer-stuck-stub-erases-root-cause` — open since
2026-08-23, 15 occurrences, itself parked by the drainer after 3 failed attempts.
**Fixed:** 2026-09-02.

## What was wrong

When a fix run failed three times, the drainer escalated the row as "auto-fix STUCK" and wrote:

```js
p_root_cause: `[board-drainer] auto-fix STUCK after ${attempts} attempts — the action below
still stands, it just could not be applied automatically. …`
```

`upsert_incident` maps `p_root_cause` onto the signal's **`summary`**, and `summary` is the one
field on a signal that **replaces** rather than merges (`detail` has merged since migration 139).
So the stub was not added to the finding — it was written **over** it, and the diagnosis that had
cost three fix attempts stopped existing anywhere. `/signals` is the only place it lived.

A partial fix landed 2026-08-27: the stub used to be re-stamped on **every** run (138 times on
2026-08-24), and was reduced to once. That stopped the repetition. It did not stop the **first**
stamp, which is the one that costs the diagnosis.

## Measured, not inferred

Queried against the production board on 2026-09-02: **eight** rows whose entire root cause is the
stub, **two of them still open** (`commit-review/Cockpit:cb19bcf:abandon-unstarted-work-impossible`,
`commit-review/production-monitor:cc5e097:disk-legacy-row-pages-on-first-sample`). A ninth,
superseded, records the needs-Roger closer having had to restore one **by hand**: *"RESTORED
2026-08-25T02:55Z by the closer. The board-drainer had replac…"*.

## What changed

`stuckRootCause(inc, attempts)` — pure, exported, tested — writes the stub **and keeps the finding
underneath it**, in the same shape the EXPECTED branch a few lines above already used
(`[board-drainer] ${inc.root_cause || inc.title} — vendor plan expired …`). The drainer's note is
an annotation on the finding, never a replacement for it.

It cannot compound: `stripStuckAnnotation()` removes an annotation an earlier pass wrote before the
new one goes on, so a row that is parked, revived and parked again carries exactly one stub, with
the current attempt count, and still carries its diagnosis. Output is capped at the 2000 characters
`upsert_incident` slices to.

## Proof

`test/board-drainer.test.mjs`, six new assertions inside the existing suite (152 total, green):
the finding survives the stub and sits under it; the title is used when there is no diagnosis; no
empty "WHAT WAS FOUND" heading when there is nothing to keep; two passes produce one stub with the
later count and the finding intact; the 2000-character cap holds; and an ordinary diagnosis is
returned byte-for-byte unchanged by the stripper. The suite is globbed by
`.github/workflows/test.yml`, so it gates every push.

## What is NOT done here

The eight rows already gutted are **not** back-filled by this change. Their original `summary` was
overwritten in place and is not stored anywhere else on the row; recovering it means reading the
producer's own log for the run that first filed it. Six of the eight are already resolved or
superseded, so the loss is historical; the two open ones are named above.
