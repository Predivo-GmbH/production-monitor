# A row the auto-fixer gives up on keeps the diagnosis it cost three attempts to find

**Signal:** `production-monitor/board-drainer-stuck-stub-erases-root-cause` — open since
2026-08-23, 15 occurrences, itself parked by the drainer after 3 failed attempts.
**Fixed:** 2026-09-02 on `master` by `345b3fe`. **Written up:** 2026-09-03.

> This write-up was stranded. It was committed only to `origin/main`, a branch created by accident
> when a session pushed with `HEAD:main` believing that was the default branch (it is `master`).
> The code fix reached `master` by a different route and the document did not, so for a day the
> only description of this defect lived on a branch nobody reads. It is recovered here, rewritten
> to describe **the implementation that actually shipped** — see *Two fixes, one defect* below.

## What was wrong

When a fix run failed three times, the drainer escalated the row as "auto-fix STUCK" and wrote:

```js
p_root_cause: `[board-drainer] auto-fix STUCK after ${attempts} attempts — the action below
still stands, it just could not be applied automatically. …`
```

`upsert_incident` maps `p_root_cause` onto the signal's **`summary`**, and `summary` is the one
field on a signal that **replaces** rather than merges. So the stub was not added to the finding —
it was written **over** it, and the diagnosis that had cost three fix attempts stopped existing
anywhere. `/signals` is the only place it lived.

A partial fix landed 2026-08-27: the stub used to be re-stamped on **every** run (138 times on
2026-08-24) and was reduced to once. That stopped the repetition. It did not stop the **first**
stamp, which is the one that costs the diagnosis.

## Measured, not inferred

Queried against the production board on 2026-09-02: **eight** rows whose entire root cause is the
stub, **two of them still open** (`commit-review/Cockpit:cb19bcf:abandon-unstarted-work-impossible`,
`commit-review/production-monitor:cc5e097:disk-legacy-row-pages-on-first-sample`). A ninth,
superseded, records the needs-Roger closer having had to restore one **by hand**: *"RESTORED
2026-08-25T02:55Z by the closer. The board-drainer had replac…"*.

## What changed

`stuckRootCause(inc, attempts)` — pure, exported, tested — writes the note **as an annotation on
the finding, never as a replacement for it**:

```js
export function stuckRootCause(inc, attempts, intervalMs = PARKED_RETRY_INTERVAL_MS) {
  const note = `[board-drainer] auto-fix STUCK after ${attempts} attempts — …`
  const original = String(inc?.root_cause || '')
    .replace(/\n*\[board-drainer\] auto-fix STUCK after \d+ attempts[\s\S]*$/, '')
    .trim()
  return (original ? `${original}\n\n${note}` : note).slice(0, 2000)
}
```

The diagnosis comes first and the drainer's note goes underneath it. It cannot compound: any
annotation an earlier pass wrote is stripped before the new one is appended, so a row that is
parked, revived and parked again carries exactly one note, with the current attempt count, and
still carries its diagnosis. Output is capped at the 2000 characters `upsert_incident` slices to.

## Two fixes, one defect — and why this one

Two sessions solved this independently on 2026-09-02 and the repo briefly held both:

* **`master` (`345b3fe`, live):** *diagnosis first, note appended.* The stripper anchors on the
  note and runs to end-of-string.
* **`origin/main` (`bb5b641`, never landed):** *note first, then a `WHAT WAS FOUND (…kept):`
  heading, then the diagnosis*, via a `stripStuckAnnotation()` helper.

They were compared on their merits rather than by date, driving both through three consecutive
parks. Both keep the diagnosis and neither stacks notes. The difference that decided it: because
the shipped version appends at the **end** and strips to end-of-string, it has no optional heading
to anchor on, and is therefore **structurally immune to the bug the other one had to ship a
follow-up commit (`58c9c11`) to fix** — a greedy `\s*` ate the blank line its optional heading
needed, so a second park grew a second "WHAT WAS FOUND" heading. That was found by running the real
park path twice against the real board, not by reading the expression.

One behaviour was deliberately **not** adopted: the unlanded version fell back to `inc.title` when
a row had no `root_cause` at all. `master` returns just the note, and
`test/board-drainer.test.mjs` pins that (*"stuckRootCause with no prior diagnosis is just the note
(no leading blank lines)"*). When there is no diagnosis there is nothing to keep, and the title is
already on the row.

## Proof

`test/board-drainer.test.mjs` (171 assertions, green) covers the finding surviving the note, the
idempotence of a re-escalation, and the no-prior-diagnosis case. The suite is globbed by
`.github/workflows/test.yml`, so it gates every push.

## What is NOT done here

The eight rows already gutted are **not** back-filled. Their original `summary` was overwritten in
place and is not stored anywhere else on the row; recovering it means reading the producer's own
log for the run that first filed it. Six of the eight are already resolved or superseded, so the
loss is historical; the two open ones are named above.
