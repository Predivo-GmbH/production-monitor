/**
 * Was the Supabase sweep COMPLETE — shared by every watchdog that sweeps the fleet.
 *
 * WHY THIS IS A LIB: check-supabase-build-currency.mjs learned on 2026-08-30 that a sweep
 * reporting only the projects some token HANDED it cannot tell "nothing is wrong" apart
 * from "nobody is watching", and that the same blindness made a redundant dead token red
 * the monitor every hour. It grew the fix (scripts/lib/supabase-projects-baseline.json plus
 * the three-valued coverage below) and went green in 5434fd3 + 4e6e8ee.
 *
 * expire-stale-sessions.mjs then failed at 15:11 UTC the SAME DAY with the identical
 * signature — `21 projects, 1 unreadable`, where the 1 was that same dead token and all 20
 * expected projects had just been swept. Two sweeps, one question, so the answer lives in
 * one place. Copying it would have produced a second dialect that drifts, which is the
 * failure mode the baseline file's own note warns about.
 *
 * These functions are pure and take the baseline as an argument, so the policy is testable
 * without a network, a secret, or a real fleet.
 */

import { readFileSync } from 'node:fs'

const BASELINE_FILE = new URL('./supabase-projects-baseline.json', import.meta.url)

/** The written-down expectation, or null when it has not been established yet. */
export function loadBaseline(file = BASELINE_FILE) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(parsed?.projects) && parsed.projects.length ? parsed : null
  } catch {
    return null
  }
}

/**
 * Baseline projects that NO token in this environment could see.
 *
 * The three-valued return is the whole point and must not be collapsed to an array:
 *   null -> coverage is UNPROVEN (no baseline). Not the same as "nothing missing".
 *   []   -> coverage is PROVEN COMPLETE. Every project we expect was read this run.
 *   [..] -> these products are unwatched right now.
 * Reading `[]` and `null` as the same thing is precisely the bug both callers used to have,
 * where "the sweep returned no complaints" was treated as "the sweep saw everything".
 *
 * Matching is by `ref`, never by name: a ref is what actually identifies a project, and a
 * project gets renamed far more easily than it gets a new ref. A finding for a project that
 * was REACHED but would not answer still counts as covered here — it has a ref, somebody
 * looked at it, and its own failure is reported through its caller's blindness path. What
 * this function answers is only "did anything look at it", not "did it answer".
 */
export function coverageGaps(findings, baseline) {
  if (!baseline?.projects?.length) return null
  const seen = new Set(findings.filter((f) => !f.isToken && f.ref).map((f) => f.ref))
  return baseline.projects.filter((p) => !seen.has(p.ref))
}

/**
 * One line a person can read, for whichever sweep is printing it. `verb` is what this
 * particular sweep DID to the project, so the sentence stays grammatical for each caller:
 * the build check reads a project, the session sweep sweeps it.
 */
export function coverageLine(gaps, baseline, verb = 'read') {
  if (!baseline) return `coverage: UNPROVEN — scripts/lib/supabase-projects-baseline.json is absent or empty, so a project that vanished from every token would not be noticed`
  const missing = gaps?.length ? ` — MISSING: ${gaps.map((p) => p.product).join(', ')}` : ''
  return `coverage: ${baseline.projects.length - (gaps?.length ?? 0)}/${baseline.projects.length} expected projects ${verb}${missing}`
}
