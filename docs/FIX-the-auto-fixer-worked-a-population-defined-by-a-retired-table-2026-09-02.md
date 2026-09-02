# The auto-fixer's work queue was defined by a table it stopped writing to a day earlier

**2026-09-02 · `scripts/board-drainer.mjs`, `scripts/check-drainer-progress.mjs`**

The companion fix on the same day
(`FIX-a-count-that-excluded-the-population-it-reported-on-2026-09-02.md`) made the *abandoned* half
loud: an item the fixer gives up on is now handed to a person. It also stated, correctly at the
time, that the *never-tried* half was only counted, not fixed. **This is that half.**

## 1. The mechanism

`readBoard()` ended with `return rows.filter(writableToIncidentBoard)`, an ALLOW list of the six
values `monitoring_incidents.source` accepts. It was written for a real reason: the write-back went
to that table, and a rejected source would 400, throw the item out of its own run and take the
whole run's bookkeeping with it — the fail-open class `isScoutDerived()` exists for.

**That reason expired on 2026-09-01.** Migration 142 went live on production (BackOffice run
33505940504, `deploy` success at job level, `156 migrations, 0 pending`), and `upsert_incident`
became a thin adapter onto `upsert_signal`. It does not mention `monitoring_incidents` at all, and
`fleet_signals` has no source CHECK of any kind. Migration 156 then revoked every write grant on
the retired table.

So for a day the fixer was holding real work back to avoid an error that could no longer happen.
**A population defined by what the tool can write, rather than by what exists.**

## 2. Measured, not assumed

Read from the deciding systems, not from the code:

| | |
|---|---|
| `upsert_incident` on production — mentions `monitoring_incidents`? | **no** |
| `upsert_incident` on production — calls `upsert_signal`? | **yes** |
| a source CHECK on `fleet_signals`? | **none exists** (kind / origin / severity / state only) |
| active signals on the board, 2026-09-02 21:25Z | 25 |
| of those, DROPPED by the guard before `considered` was taken | **12 (48%)** |
| the same log line at 20:06Z, on a fuller board | **31** |

The 12, by name: seven `monitoring-hygiene` faults in the monitoring system itself, three
`work-board` rows, `board-drainer/stalled`, and
`external-tools-freshness/external-tools-never-scanned`.

**Fault-injected on BackOffice staging, both directions:**

```
insert into monitoring_incidents (source='monitoring-hygiene')
   -> ERROR 23514: violates check constraint monitoring_incidents_source_check   (still refused)

select upsert_incident('monitoring-hygiene', ...)
   -> HTTP 201; row lands in fleet_signals kind=incident state=open origin=direct  (accepted)
```

The retired store really does still reject the source. The live write path really does accept it.
Both facts hold at once, which is exactly why reading either one alone was misleading.

## 3. The change: a DENY list, and it must stay one

`workableFinding()` replaces `writableToIncidentBoard()`. Everything is a finding **except** rows
that are not findings, each excluded for its own stated reason:

- `work-board` — the rows ARE the work board; a person has them by definition, and routing one
  would mint a second work item for the item it came from.
- `board-drainer` — this machinery's own heartbeat and its own stall alarm.
  (Both already matched `NOT_A_FINDING` in `check-drainer-progress.mjs`, reached independently.)
- `test`, `probe`, `wrapper`, `__drill__`, `__migration_probe__` — synthetic. Migration 159's own
  disposition: "exercise the pipe, not a fault". A drill that dispatches a real agent is not a drill.
- `report`, `closer-digest`, `notification-closer`, `notification-hc-up`, `notification-report` —
  deliveries and delivery bookkeeping. Migration 159: "a report IS a delivery".

**Why the direction matters more than the contents.** An allow list makes a NEW producer invisible
by default — outside the queue until somebody remembers a constant in a file. That is the defect
above, and it would return the same way. A deny list fails loud: an unrecognised source is worked,
or at worst classified and handed to a person.

This is not hypothetical. While this fix was being written, a source called `memory-backup` filed
its first signal ever (21:50Z). Under the allow list it would have been invisible to the auto-fixer
from birth, permanently, and no count would have noticed.

`isScoutDerived()` is **kept and unchanged**. `scout-ux` is deliberately absent from the deny list:
the structural guard also catches a scout-derived row filed under any other source, which a name
list never could, and removing one guard must not quietly disarm the other.

`NOT_A_FINDING_SOURCES` is exported and `check-drainer-progress.mjs` imports it instead of keeping
its own two-name copy. Two hand-kept lists is how the numerator and the denominator came to
disagree in the first place.

## 4. Proof

**Unit, fault-injected.** `workableFinding` was mutated back to the old six-value allow list and
both suites were watched to fail:

```
board-drainer.test.mjs           AssertionError: monitoring-hygiene is a finding and must be worked
check-drainer-progress.test.mjs  AssertionError: THE FIX: every real finding is in reach now
```

Restored: `board-drainer.test.mjs` **166 assertions passed**, `check-drainer-progress.test.mjs`
**36 tests passed**. Every suite the CI gate globs (`for f in test/*.test.mjs`): **48 of 48 PASS**.

The alarm keeps a `REGRESSION GUARD` test that hands `summariseBoard()` the OLD guard through an
injectable and asserts it goes loud again — so re-introducing an allow list of any shape is a red
test, not a silent shrinking of the queue.

**Live, same harness both sides.** One snapshot of the production board, put through the guard
running in production today and the guard in this change — one method, two filters, because
comparing two numbers means comparing two identical methods:

```
live board: 15 active signal(s)
  OLD guard: considered 12, dropped 3
  NEW guard: considered 14, dropped 1   (board-drainer/stalled, by decision)
  NEWLY VISIBLE: external-tools-freshness/external-tools-never-scanned
                 memory-backup/refused-note-carries-a-live-healthchecks-ping-address
  LOST: 0
```

**Injected, on staging.** Probe rows written through `upsert_incident`, read back with the drainer's
own board query, both guards applied, then deleted (0 left, retired store untouched at its 3
rollback rows, no `store-merge` alarm raised):

```
  old=dropped  new=WORKED   monitoring-hygiene/__probe_src_check__        <- formerly rejected source
  old=dropped  new=WORKED   kb-learning/daily-digest-2026-08-24           <- real, pre-existing
  old=dropped  new=WORKED   pull-engine/circuit-breaker-channelmover      <- real, pre-existing
  old=dropped  new=WORKED   a-producer-invented-next-month/__probe_...    <- an unclassified source
  old=dropped  new=dropped  report/__probe_not_a_finding__                <- still refused
  old=dropped  new=dropped  __drill__/__probe_drill__                     <- still refused
```

## 5. What the newly visible findings turned out to be

The board moved under this work: concurrent sessions resolved 19 of the held-back rows between
20:06Z and 22:30Z, each with a real receipt (`incident_status=fixed` and a summary naming the fix),
not by clearing a flag. What the guard was still hiding at the end of the day:

| finding | what it is |
|---|---|
| `external-tools-freshness/external-tools-never-scanned` | **Real, and already half-answered.** 12 of 48 external tools have never been fingerprinted; 5 of the original 17 were a genuine wiring gap and are fixed. Most of the rest are browser-only services no scan can reach. Already carries `detail.work_item`, so a person has it; it now also reaches the fixer. |
| `memory-backup/refused-note-carries-a-live-healthchecks-ping-address` | **Real, owner Claude, born after the allow list would have hidden it.** The nightly notes backup refused a memory note carrying a live healthchecks.io ping address. The guard is right; the note needs redacting. Brief already written at `standards/PROMPT_backup_secret_guard_filename_false_positive.md`. |
| `board-drainer/stalled` | **Still not worked, deliberately.** It is the fixer's own alarm about itself; working it would make the machine dispatch against its own measurement. It carries `needs_human=true`, so it reaches Roger by the normal path — it is not invisible, it is routed elsewhere. |

## 6. Records corrected, because they now say the opposite

- `FIX-a-count-that-excluded-the-population-it-reported-on-2026-09-02.md` §6 said
  "`monitoring_incidents` remains the write target and its `source` CHECK still rejects …". True
  when written that morning, false by that evening.
- `Cockpit/docs/PLAN-ONE-STORE-2026-08-27.md` §8.1 listed this as an open change its owner must make.
- Four comment blocks inside `board-drainer.mjs` still described the write as going to
  `monitoring_incidents` and referred to "Plan A step 2, dual-write for a week", which was dropped.

## 7. Still open, and not touched here

- **A dry run still overwrites the live heartbeat** — `writeRunHeartbeat` is called unconditionally
  from `main().then()`. Unchanged, still briefed at
  `standards/PROMPT_a_dry_run_overwrites_the_live_drainer_heartbeat.md`.
- **`detail.parked` is still written once and never re-asserted.** Same brief.
- **`monitoring_incidents.source`'s CHECK is deliberately NOT widened.** The table is the documented
  one-statement rollback for the cutover; loosening a constraint on a frozen artefact would weaken
  the rollback and fix nothing, because nothing writes it. It stays exactly as it is. **This is the
  one place where the obvious reading of the task — "widen the constraint" — is the wrong action.**
