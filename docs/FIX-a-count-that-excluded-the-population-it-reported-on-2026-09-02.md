# The fleet auto-fixer's health alarm measured everything except what it had given up on

**2026-09-02 · `scripts/check-drainer-progress.mjs`, `scripts/board-drainer.mjs`**

Roger, on `cockpit.predivo.ch/monitoring`: *"I can see NeedsMe19 with Claude1 watching 21 Parked2.
This doesn't tell me that everything is done and finished."* The top item on that page was the
board-drainer alarm, seen 43 times, saying nine of thirteen findings had been abandoned. This is
what was actually true, and what changed.

## 1. What was measured

Live, 2026-09-02 20:04Z, read from `fleet_signals` and the drainer's own published heartbeat:

| | |
|---|---|
| active signals on the board (`open`/`acknowledged`) | 42 |
| of those, real findings (excluding `work-board` and `board-drainer` rows) | 24 |
| the drainer even LOOKS at (`considered`) | **11** |
| held back — its source is one `monitoring_incidents` rejects | **31** |
| held back AND not attached to any work item | **13** |
| parked, by the drainer's own count | **9** |
| rows publishing `detail.parked = true` | **2** |

So `9 of 13 (69%)` had become `9 of 11 (82%)` — and both numbers were far too kind. The honest
statement is **22 of 24 findings on the board (92%) were being worked by nobody**: nine the fixer
tried and abandoned, thirteen it never looked at once.

## 2. Three defects, all the same shape

**The denominator was the drainer's opinion of the board, not the board.** `readBoard()` ends with
`return rows.filter(writableToIncidentBoard)`, because the write still goes to
`monitoring_incidents`, whose `source` CHECK accepts six values. Everything else is logged as HELD
BACK and dropped *before* `considered` is taken. The 2026-09-01 fix taught the alarm to count parked
items in the numerator and left the denominator exactly where it was. **Never tried is worse than
given up, and it was the quieter of the two.**

**The private count and the page disagreed, 9 against 2.** `detail.parked` is published once, in the
branch that first records an item stuck, and nothing re-asserts it. Seven abandonments existed only
inside `C:\Business\_board-drainer\state.json` on one machine — no query, no page and no person
could name them. The drainer's own log line claimed *"Each is published as detail.parked=true on its
signal row"*; that was false for seven of nine, and the line has been corrected to say what actually
happens.

**A rehearsal overwrote the report.** Caught live while this was being written.
`writeRunHeartbeat` is called unconditionally from `main().then()`, so a DRY run publishes over the
production heartbeat — one row, upserted, so the real run's report is not shadowed but destroyed. At
19:36Z the heartbeat said `considered 11, dispatchable 0, parked 9` and the alarm returned
`given-up`. At 20:06Z a dry run on a second machine, whose state file was last written 2026-08-25,
replaced it with `dry: true, dispatchable 4, parked 4, last_dispatch_at 2026-08-25`, and the same
alarm returned *"none picked up for 199h"*. Neither number described the live fixer. The flag needed
to tell them apart, `dry`, was in the row all along and nothing read it.

## 3. What changed

### The alarm (`check-drainer-progress.mjs`)

- **Assertion 5 — the denominator is the board.** The check now performs a second, independent read
  of the active board and computes the population itself. `writableToIncidentBoard` is *imported*
  from the drainer rather than copied, so the reach test cannot drift from the filter it tests; if
  that module fails to load the check throws, and a throw here is already "could not tell".
  Out-of-reach excludes rows that already have a person: `work-board` rows are the work board, and
  anything carrying `detail.work_item` has been handed over.
- **Assertion 6 — the page must be able to name the abandoned.** Any gap between the drainer's
  parked count and the rows publishing the flag is stated out loud: as its own verdict
  (`parks-unpublished`) when nothing louder fires, and as a sentence inside `given-up` when
  something does, so it can never be masked.
- **Assertion 7 — a rehearsal is not a report.** A heartbeat carrying `dry: true` is graded
  `unknown`, never `ok` and never the stall its own numbers describe.
- **The alarm now NAMES the abandoned findings**, in the summary and in `detail.never_tried` /
  `detail.parked_published`. Before, the one row that did reach Roger said "9 of 13" and named none
  of them, so he had to derive the list himself — pull, again.
- A board read that fails downgrades to `board = null`: every board-derived assertion is skipped and
  the summary says so. Losing the board never makes the alarm quieter than it was.

### The drainer (`board-drainer.mjs`)

**Parking is now a handover, not a lane.** `cls.handoff` already means "no agent run can close this;
it needs a person", and such an item is minted on the work board with a paste-ready prompt and
leaves the alarm surface. An item at the attempt ceiling has *proved* it belongs to that class:
three agent runs were dispatched and none closed it. So it is routed the same way, by the same
function, for the same reason.

- Rate-limited, oldest-parked first (`parkedHandoverQueue`, pure and unit-tested). Three per run: a
  nine-item backlog clears inside an hour at the 20-minute cadence and can never flood the board.
  An unrecorded park time sorts to the *front* — it is the most neglected case, not the least.
- Only a hand-over that actually landed un-parks the item. A failed mint or a failed supersede
  leaves both the local marker and the published flag where they were.
- The published `detail.parked` flag is cleared on hand-over, because `detail` merges (migration
  136) and a stale `parked: true` on a superseded row would make the item **born parked** the next
  time the same check goes down.
- `BOARD_DRAINER_PARKED_HANDOVER_PER_RUN=0` restores the old behaviour exactly. The suppression
  ships with the switch that turns it off.
- `runStats.parked_handed_over` is published, so "parked: 0 because the board is clean" can be told
  apart from "parked: 0 because everything was given away this hour".

## 4. Is the attempt ceiling itself right?

**Yes, and it is unchanged.** Retrying forever is the 2026-08-24 deadlock, where three unfixable
items ate the whole per-run budget for thirty hours while thirty-four others waited behind them.
Three failed autonomous attempts is enough evidence that a particular fault is not one this machine
can close. What was wrong was never the giving up — it was giving up **quietly**. Giving up is now
the loudest thing the drainer does with an item: it hands it to a person and says so, in the log, in
the heartbeat and on the work board.

The 24-hour scheduled retry (Plan B B3.2) is kept as the safety net for anything whose hand-over
fails, and "Hand to Claude" still gives an item straight back with the attempt counter reset.

## 5. Proof

- `node test/check-drainer-progress.test.mjs` — **35 passed** (21 pre-existing, 14 new; every new
  case was watched to fail against the previous version).
- `node test/board-drainer.test.mjs` — **156 assertions passed** (150 pre-existing, 6 new).
- Every suite the CI gate globs (`test/*.test.mjs`): **47 of 47 PASS, 0 FAIL**.
- **Fault injection, live board.** Two `__drill__` rows inserted into `fleet_signals`, one plain and
  one carrying `detail.parked = true`:

  ```
  BEFORE   board: 23 active finding(s), 10 in reach, 13 out of reach and unowned, 2 publishing parked=true
  INJECT   HTTP 201
  AFTER    board: 25 active finding(s), 10 in reach, 15 out of reach and unowned, 3 publishing parked=true
  CLEANUP  rows removed
  RESTORED board: 23 active finding(s), 10 in reach, 13 out of reach and unowned, 2 publishing parked=true
  ```

- **Fault injection, hand-over path.** A five-incident fixture with four items already at the
  ceiling, run against an isolated `BOARD_DRAINER_HOME` and an invalid secret so nothing could reach
  production (the heartbeat write took its 401 and was swallowed, as designed):

  ```
  PARK 4, HAND OVER PARKED 3
    would hand commit-review/k-old   (parked 2026-08-20) -> monitor-k-old-910b29f2
    would hand commit-review/k-mid   (parked 2026-08-25) -> monitor-k-mid-a3ba37a6
    would hand commit-review/k-new   (parked 2026-09-01) -> monitor-k-new-19810071
  ```

  Oldest-parked first, the fourth left for the next run.

- **The live alarm, after the change:**

  > given-up — 22 of the 23 findings on the board (96%) are being worked by nobody: 9 PARKED … and
  > 13 NEVER TRIED … Worse: only 2 of those 9 parked findings publish detail.parked=true on their
  > row, so 7 of them cannot even be NAMED from the board … Never tried:
  > external-tools-freshness/external-tools-never-scanned, external-tools-scan/unregistered:…,
  > monitoring-hygiene/closer-digest-swallowed-by-hourly-mail-throttle, …

## 6. Still open

- ~~**The 31 held-back signals are not fixed, only counted.** `monitoring_incidents` remains the
  write target and its `source` CHECK still rejects `monitoring-hygiene`, `external-tools-scan` and
  `external-tools-freshness`. Removing that limit is Plan A step 2 (write to both stores) in
  `docs/PLAN-ONE-STORE-2026-08-27.md`.~~
  **CLOSED THE SAME DAY, and the sentence above was already wrong when written.**
  `monitoring_incidents` stopped being the write target on 2026-09-01: migration 142 made
  `upsert_incident` an adapter onto `upsert_signal`, and `fleet_signals` has no source CHECK. The
  400 the guard existed to avoid could no longer happen. The allow list is gone, replaced by a deny
  list of rows that genuinely are not findings — see
  `FIX-the-auto-fixer-worked-a-population-defined-by-a-retired-table-2026-09-02.md`. Plan A step 2
  as written (dual-write for a week) was dropped by Roger on 2026-08-27 and never existed to wait
  for.
- **A dry run still overwrites the live heartbeat.** The alarm now refuses to grade one, which stops
  it lying; it does not stop the overwrite. The fix belongs in `writeRunHeartbeat` — skip the write
  when `runStats.dry`, or write dry runs to a separate key — and is briefed at
  `standards/PROMPT_a_dry_run_overwrites_the_live_drainer_heartbeat.md`.
- **`detail.parked` is still written once and never re-asserted.** The alarm now reports the gap;
  reconciling the flag on every run is briefed in the same place.
