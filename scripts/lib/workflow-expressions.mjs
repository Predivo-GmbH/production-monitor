/**
 * GitHub accepts the status check functions success(), failure(), cancelled() and always()
 * inside ONE thing: an `if:` condition. Anywhere else in a `${{ }}` expression it refuses the
 * WHOLE workflow file, and a refused file is the worst failure this repo has, because:
 *
 *   a refused workflow starts NO JOBS  ->  no jobs means no `Send alert on failure` step
 *   ->  the run is red in the GitHub UI, which nobody watches, and NOBODY IS TOLD.
 *
 * Measured 2026-09-04: b6336e1 put `RUN_WAS_CANCELLED: ${{ cancelled() && !failure() }}` in the
 * alert step's `env:`. Run 33872552961 concluded `failure` with 0 jobs and no log at all; the
 * dispatch API spelled the cause out - HTTP 422 "failed to parse workflow: (Line: 837, Col: 30):
 * Unrecognized function: 'cancelled'". Both CI checks on that commit (unit tests, gitleaks) were
 * GREEN, because nothing in this repo read the workflow files as GitHub reads them.
 */

export const STATUS_FUNCTIONS = ['success', 'failure', 'cancelled', 'always']

const STATUS_CALL = new RegExp('\\b(' + STATUS_FUNCTIONS.join('|') + ')\\s*\\(')

/**
 * Drop a YAML line comment. A `#` counts as a comment when it opens the line or follows
 * whitespace - the same shape YAML itself uses. This matters because the fix for the very bug
 * this guards DESCRIBES the broken spelling in a comment, and a scanner that read prose as
 * configuration would fail the file it had just repaired (2026-09-04: cancelsInProgress() did
 * exactly that one commit earlier and shipped its gate disabled).
 */
export function stripComment (line) {
  const m = line.match(/(^|\s)#/)
  if (!m) return line
  return line.slice(0, m.index + (m[1] ? 1 : 0))
}

/** Every `${{ ... }}` span in a string, unbalanced tails included so nothing is silently dropped. */
export function expressionSpans (text) {
  const out = []
  let i = 0
  for (;;) {
    const start = text.indexOf('${{', i)
    if (start < 0) return out
    const end = text.indexOf('}}', start + 3)
    out.push(end < 0 ? text.slice(start + 3) : text.slice(start + 3, end))
    i = end < 0 ? text.length : end + 2
  }
}

/** True when this line is the `if:` key itself (job-level, step-level, or the `- if:` form). */
export function isIfLine (line) {
  return /^\s*(-\s+)?if\s*:/.test(line)
}

/**
 * Every place a workflow calls a status function inside an expression that is NOT an `if:`.
 * Returns [{ line, text, fn }] - empty means GitHub will accept the file on this rule.
 */
export function illegalStatusFunctions (source) {
  const found = []
  source.split(/\r?\n/).forEach((raw, idx) => {
    const code = stripComment(raw)
    if (isIfLine(code)) return
    for (const span of expressionSpans(code)) {
      const hit = span.match(STATUS_CALL)
      if (hit) found.push({ line: idx + 1, text: raw.trim(), fn: hit[1] })
    }
  })
  return found
}
