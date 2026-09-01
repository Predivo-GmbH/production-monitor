/**
 * cron-cadence.mjs — Cadence-relative escalation threshold for automation-status.mjs.
 *
 * The 2026-08-29 board incident "red-48h-escalator-ignores-workflow-cadence": the
 * escalator flagged any non-PR workflow red for a flat 48h. A workflow that only
 * SCHEDULES once a week (e.g. a weekly report) has had zero chances to recover at
 * the 48h mark — it had not even run again — so the "red since N hours" escalation
 * paged on a job that could not possibly have healed yet. The threshold must be
 * cadence-relative: max(BASE, 2x the workflow's own schedule period), so "red since
 * N hours" means the job has had at least two full schedule periods to recover.
 *
 * Pure logic lives here so test/cron-cadence.test.mjs can pin it without the network.
 */

export const BASE_ESCALATION_HOURS = 48
// Even the rarest schedule must eventually escalate: cap the derived threshold at
// 21 days so a yearly-cron workflow cannot stay red silently forever.
export const MAX_ESCALATION_HOURS = 21 * 24

/**
 * Extract every cron expression from a GitHub Actions workflow YAML, without a YAML
 * dependency. Matches the `schedule:` block entries:  - cron: '0 6 * * 1'
 * Returns [] when the workflow has no schedule (push/PR/dispatch only).
 */
export function extractCronSchedules(yamlText) {
  if (typeof yamlText !== 'string') return []
  const out = []
  const re = /^\s*-?\s*cron:\s*['"]?([^'"\n#]+?)['"]?\s*$/gm
  let m
  while ((m = re.exec(yamlText)) !== null) out.push(m[1].trim())
  return out
}

/** Parse one cron field into a matcher. Returns null on anything exotic. */
function fieldMatcher(field, min, max, dowNames = false) {
  const tests = []
  for (const part of field.split(',')) {
    let step = 1
    let range = part
    const slash = part.indexOf('/')
    if (slash !== -1) {
      step = Number(part.slice(slash + 1))
      range = part.slice(0, slash)
      if (!Number.isInteger(step) || step < 1) return null
    }
    if (range === '*' || range === '') {
      const base = range === '' ? min : min
      tests.push((v) => (v - base) % step === 0)
      continue
    }
    const dash = range.indexOf('-')
    if (dash !== -1) {
      const lo = Number(range.slice(0, dash))
      const hi = Number(range.slice(dash + 1))
      if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) return null
      tests.push((v) => v >= lo && v <= hi && (v - lo) % step === 0)
      continue
    }
    const n = Number(range)
    if (!Number.isInteger(n) || n < min || n > max) return null
    if (slash !== -1) tests.push((v) => v >= n && (v - n) % step === 0)
    else if (dowNames && n === 7) tests.push((v) => v === 0 || v === 7)
    else tests.push((v) => v === n)
  }
  return (v) => tests.some((t) => t(v))
}

/**
 * Median gap (hours) between consecutive fires of a 5-field cron expression,
 * simulated minute-by-minute over a 400-day window (long enough to catch two fires
 * of a monthly or yearly schedule — real cron skips invalid DOM dates, so a
 * "day 31" monthly job can have ~3-month gaps). Handles `*`, `*\/n`, `a`,
 * `a,b,c`, `a-b`, `a-b/n`, and standard DOM/DOW OR-semantics. Returns null when
 * the expression is unparseable or fires fewer than twice in the window.
 */
export function cronPeriodHours(cronExpr, fromMs = Date.now()) {
  if (typeof cronExpr !== 'string') return null
  const fields = cronExpr.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const minute = fieldMatcher(fields[0], 0, 59)
  const hour = fieldMatcher(fields[1], 0, 23)
  const dom = fieldMatcher(fields[2], 1, 31)
  const month = fieldMatcher(fields[3], 1, 12)
  const dow = fieldMatcher(fields[4], 0, 7, true)
  if (!minute || !hour || !dom || !month || !dow) return null
  const domRestricted = fields[2] !== '*'
  const dowRestricted = fields[4] !== '*'

  // Start at the next whole minute.
  const start = Math.floor(fromMs / 60000) * 60000 + 60000
  const end = start + 400 * 24 * 3600 * 1000
  const fires = []
  for (let t = start; t < end; t += 60000) {
    const d = new Date(t) // UTC: GitHub cron is UTC
    if (!month(d.getUTCMonth() + 1)) continue
    const domHit = dom(d.getUTCDate())
    const dowHit = dow(d.getUTCDay())
    const dayHit = domRestricted && dowRestricted ? domHit || dowHit : domHit && dowHit
    if (!dayHit) continue
    if (hour(d.getUTCHours()) && minute(d.getUTCMinutes())) fires.push(t)
  }
  if (fires.length < 2) return null
  const gaps = []
  for (let i = 1; i < fires.length; i++) gaps.push((fires[i] - fires[i - 1]) / 36e5)
  gaps.sort((a, b) => a - b)
  return gaps[Math.floor(gaps.length / 2)]
}

/**
 * The escalation threshold for a workflow, cadence-relative:
 *   max(48h, 2 x schedule period), capped at MAX_ESCALATION_HOURS.
 * `schedulePeriodHours` null/undefined (no schedule, unparseable, push-only) → 48h base.
 */
export function escalationThresholdHours(schedulePeriodHours) {
  if (!Number.isFinite(schedulePeriodHours) || schedulePeriodHours <= 0) return BASE_ESCALATION_HOURS
  return Math.min(MAX_ESCALATION_HOURS, Math.max(BASE_ESCALATION_HOURS, Math.ceil(2 * schedulePeriodHours)))
}

/**
 * Effective threshold for a whole workflow YAML: the SHORTEST schedule period wins
 * (a workflow scheduled both daily and weekly must be judged by its daily cadence).
 */
export function thresholdForWorkflowYaml(yamlText, fromMs = Date.now()) {
  const crons = extractCronSchedules(yamlText)
  let best = null
  for (const c of crons) {
    const p = cronPeriodHours(c, fromMs)
    if (p !== null && (best === null || p < best)) best = p
  }
  return { schedulePeriodHours: best, thresholdHours: escalationThresholdHours(best) }
}
