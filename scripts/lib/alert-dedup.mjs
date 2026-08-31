/**
 * Pure edge-triggered dedup decision for the monitor alert (scripts/send-alert.mjs).
 *
 * WHY THIS EXISTS (2026-08-31 board incident "alert-dedup-repages-when-one-cause-spreads").
 * The dedup signature was `${project}||${test}`. One root cause — a site 500ing, a dead
 * service key — fails spec A in run N (page), then spreads and fails specs A, B, C in run
 * N+1. B and C were "new" signatures, so the SAME already-paged outage paged again every
 * run while it spread. Conversely, the old signature could NOT see a failure whose error
 * changed: spec A failing for a brand-new reason still matched `project||test` and was
 * swallowed as "continuing".
 *
 * The signature now carries the failure reason: `${project}||${test}||${reason}`. A current
 * failure counts as already-alerted when EITHER
 *   1. its full signature was failing in the previous run (a continuing, unchanged failure), OR
 *   2. its (non-vague) failure reason appeared ANYWHERE in the previous run — the root cause
 *      was already paged; this row is that same cause spreading to another spec.
 * Suppression still requires EVERY current failure to be already-alerted. A genuinely new
 * failure (new test + new reason, or a KNOWN test failing for a NEW reason) always pages.
 *
 * FAIL-OPEN ON ANY DOUBT, unchanged: no prior run, empty prior failure set, an empty or
 * content-free reason ("Unknown error") — all refuse to suppress via reason-match. The
 * caller keeps its own fail-open behaviour (any error building `prev` → null → send).
 * The resolution mail is untouched: it lives in send-resolved.mjs on a GREEN run, and a
 * suppressed alert still exits 0 exactly as before.
 *
 * Extracted here as pure functions so a unit suite can pin it with no network / no mail.
 */

import { stripAnsi } from './parse-failures.mjs'

/** Normalise an error message for comparison: ANSI stripped, first line, whitespace
 *  collapsed, trimmed, capped (same 300 the alert renderer uses). */
export function normalizeReason(error) {
  return stripAnsi(String(error ?? '')).split('\n')[0].replace(/\s+/g, ' ').trim().slice(0, 300)
}

/** The dedup signature: project + test + failure reason. */
export function failureSignature(f) {
  return `${f.project}||${f.test}||${normalizeReason(f.error)}`
}

// Reasons that carry no information. A content-free reason must never reason-match:
// "Unknown error" appearing in both runs says nothing about a shared root cause.
const VAGUE_REASONS = new Set(['', 'unknown error', 'unknown'])

/** Build the previous-run view the dedup needs from the previous run's failure rows.
 *  Returns null (fail open) when there is nothing comparable. */
export function previousDedupView(prevFailures) {
  if (!Array.isArray(prevFailures) || prevFailures.length === 0) return null
  const signatures = new Set(prevFailures.map(failureSignature))
  const reasons = new Set(
    prevFailures
      .map((f) => normalizeReason(f.error).toLowerCase())
      .filter((r) => !VAGUE_REASONS.has(r)),
  )
  return { signatures, reasons }
}

/** Was this failure already alerted in the previous run — either as the identical
 *  continuing failure, or as the same root cause paged under another test? */
export function isAlreadyAlerted(f, prevView) {
  if (prevView.signatures.has(failureSignature(f))) return true
  const reason = normalizeReason(f.error).toLowerCase()
  if (VAGUE_REASONS.has(reason)) return false // fail open on a content-free reason
  return prevView.reasons.has(reason)
}

/** Suppress this alert ONLY if every current failure was already alerted in the previous
 *  run. Any doubt (no prev view, empty current set) → false → the caller sends. */
export function shouldSuppressAlert(currentFailures, prevView) {
  if (!prevView || prevView.signatures.size === 0) return false
  if (!Array.isArray(currentFailures) || currentFailures.length === 0) return false
  return currentFailures.every((f) => isAlreadyAlerted(f, prevView))
}
