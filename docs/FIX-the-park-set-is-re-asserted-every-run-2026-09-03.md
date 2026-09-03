# The fleet auto-fixer could not say WHICH findings it had abandoned

**Signal:** `board-drainer/stalled`, verdict `parks-unpublished` (warning).
**Fixed:** 2026-09-03. **Files:** `scripts/board-drainer.mjs`, `test/board-drainer.test.mjs`,
`scripts/check-drainer-progress.mjs` (verdict wording only).

## What was wrong

`detail.parked = true` was written in exactly ONE place — the branch of `main()` that first records
an item stuck — and nothing ever wrote it again. That makes the published flag an **edge**: it is on
a row only if one particular PATCH, on one particular run, on one particular machine, happened to
succeed.

Measured on production 2026-09-02: the drainer's heartbeat said **9** findings were parked and **2**
rows on the board published the flag. The other seven existed as abandoned only inside
`C:\Business\_board-drainer\state.json`, on whichever machine ran the task. No query, no page and no
person could name them. Three ways to get there, and all three had happened:

1. the evidence write failed (a 4xx, a dropped socket) and the item was parked anyway — parking is
   recorded LAST so a failed *escalation* is retried, but a failed *evidence* write is
   indistinguishable from a successful one to everything that runs later;
2. the item was parked before the flag existed at all;
3. something else rewrote `detail` — it merges (migration 136), but a producer that re-files the same
   key still wins any key it names.

The consumer contract is strict (`Cockpit/src/hooks/useFleetSignals.ts` renders `parked === true`),
so a row that missed its one write is simply not a parked row as far as the page is concerned.

## What changed

The drainer now **reconciles** instead of stamping. `reconcileParkedFlags()` reads the active board,
compares it against `state.stuck`, and makes the board agree:

* publishes `parked` / `parked_at` / `parked_attempts` on every item it currently considers parked —
  including one whose earlier write failed, with the ORIGINAL park time, not the time of the repair;
* CLEARS the flag on every row it no longer considers parked (`detail` merges, so a stale
  `parked: true` on a resolved row means the item is born parked the next time that check goes down);
* compares the whole triple, not just the boolean: a row saying `parked: true` with the wrong
  timestamp is publishing a fact we do not hold.

It runs at the END of every run, after every state mutation — and also on the two early exits (a
clean board, and a dry run, which reports the disagreement and writes nothing). It is idempotent: a
board that already agrees costs zero writes, and an ABSENT flag is treated as identical to
`parked: false`, so shipping this does not PATCH every row on the board once.

A marker whose key has no row on the active board is reported and left alone — there is nothing to
publish onto; the stale-marker prune clears those. A legacy marker (no `source`) whose key matches
more than one row is REFUSED by name rather than guessed at: marking a live finding as abandoned is
worse than saying "I do not know which".

`--reconcile-parked` runs the pass and nothing else — no classification, no dispatch, and
deliberately no heartbeat, since a `considered = 0` heartbeat would overwrite the live fixer's meter.

## Receipts

**Fault injection, live, on production** (2026-09-03T08:23–08:25Z). Isolated state file via
`BOARD_DRAINER_HOME`, target row `production-monitor/backoffice:recurring-costs-registry-unverified`
(which published no flag at all — the real fault shape):

```
08:23:22Z  ... detail.parked RE-ASSERTED (parked since 2026-08-30T11:22:33.444Z, 3 attempts)
           read back: parked=true  parked_at="2026-08-30T11:22:33.444Z"  parked_attempts=3
           the other six detail keys survived the PATCH
08:25:01Z  ... detail.parked CLEARED (the drainer no longer considers it parked)
           read back: parked=false parked_at=null parked_attempts=null
           rows on the active board publishing detail.parked===true: 0  (the true state)
```

**Unit:** eleven new cases in `test/board-drainer.test.mjs`, every one of them starting from a board
that DISAGREES with the state file — deleted flag, corrupted flag, wrong timestamp, stale flag to
clear, ambiguous legacy marker, one failing write costing exactly one row, and a reproduction of the
live 9-parked/2-published gap closing to zero in one pass. 182 assertions green; every `test/*.test.mjs`
suite green except `the-monitor-mailbox-has-two-doors`, which fails identically on clean master
(an IMAP timeout, a separate workstream).
