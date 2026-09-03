// HOW LONG HAS A PRODUCT BEEN SITTING UNSHIPPED, AND HOW LONG HAS IT BEEN SPLIT IN TWO?
//
// WHY THIS EXISTS (2026-09-03). Roger, opening the Deploy Status page for the fourth time in two
// days and finding the same rows still sitting there: *"I do not want to have this fucking deploy
// board stale and not working properly."*
//
// The page was already telling the truth. Distribution-OS said, correctly, "staging and production
// have drifted apart - this needs merging, not approving" - and it had said so since 2026-08-04, a
// MONTH, while each branch kept collecting work the other never got. Production's side held
// security fixes (a gate password rotated because the previous one reached git) that staging did
// not have. Three other products sat "N commits on staging that production does not have" until
// somebody happened to look.
//
// So the defect is not that the page lies. It is that NOTHING FAILS when the page is right and
// nobody acts. A dashboard is PULL: it waits to be read. Every other class of rot in this fleet is
// caught by something that goes red on its own, and this one had no such thing -
// `check-drift.mjs` watches Supabase schema and cron drift, not shipping.
//
// This module is the missing question, and it is deliberately only the pure part: given two
// deployed commits and their dates, has this sat too long? The network lives in the caller so the
// judgement can be tested without one.
//
// ⭐ IT COMPARES THE DEPLOYED COMMITS, NOT THE BRANCH HEADS. Measured 2026-09-03 on
// Distribution-OS: comparing branch heads gives ahead 9 / behind 17, comparing what is actually
// DEPLOYED gives ahead 9 / behind 8. Both are true and they answer different questions. The one
// that matters for "is production behind" is what is LIVE, which is why the page uses it - and
// comparing a branch-head number against a deployed number is how you invent a bug that is not
// there. I nearly reported exactly that.

/** Hours a product may sit promotable before it counts as neglected. */
export const DEFAULT_MAX_AGE_H = 24

/**
 * @param {object} p
 *  name           product name
 *  status         GitHub compare status: 'identical' | 'ahead' | 'behind' | 'diverged'
 *  aheadBy        commits on staging that production does not have
 *  behindBy       commits on production that staging does not have
 *  oldestUnshippedAt  ISO date of the OLDEST commit waiting to ship (null when nothing waits)
 *  prodGate       'auto' | 'manual'
 * @param {object} opts  { now: Date, maxAgeH: number }
 * @returns {{ level: 'ok'|'stale'|'diverged', reason: string, ageH: number|null }}
 */
export function classifyBacklog(p, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date()
  const maxAgeH = Number.isFinite(opts.maxAgeH) ? opts.maxAgeH : DEFAULT_MAX_AGE_H

  // DIVERGED IS NEVER OK, AT ANY AGE. It cannot be resolved by shipping - each side holds work the
  // other lacks, so a promotion would ship nothing and quietly widen the split. It only ever gets
  // worse on its own, so there is no grace period to give it.
  if (p.status === 'diverged') {
    return {
      level: 'diverged',
      ageH: ageInHours(p.oldestUnshippedAt, now),
      reason:
        `${p.name}: staging and production have drifted apart (staging +${p.aheadBy ?? '?'}, ` +
        `production +${p.behindBy ?? '?'}). This needs MERGING, not promoting - a promotion here ` +
        `ships nothing and the two sides keep growing apart.`,
    }
  }

  if (p.status !== 'ahead' || !p.aheadBy) return { level: 'ok', ageH: null, reason: `${p.name}: nothing waiting` }

  const ageH = ageInHours(p.oldestUnshippedAt, now)
  // Unknown age is NOT treated as fresh. A missing date used to be the quiet path that let a thing
  // sit forever; if we cannot tell how old it is, that is itself worth saying.
  if (ageH === null) {
    return {
      level: 'stale',
      ageH: null,
      reason: `${p.name}: ${p.aheadBy} commit(s) on staging that production does not have, and the age could not be read - treating as neglected rather than fresh.`,
    }
  }
  if (ageH < maxAgeH) return { level: 'ok', ageH, reason: `${p.name}: waiting ${ageH.toFixed(1)}h, under the ${maxAgeH}h threshold` }

  const days = ageH / 24
  return {
    level: 'stale',
    ageH,
    reason:
      `${p.name}: ${p.aheadBy} commit(s) have been waiting to go live for ` +
      `${days >= 2 ? `${days.toFixed(1)} DAYS` : `${ageH.toFixed(1)}h`} ` +
      `(threshold ${maxAgeH}h). Promoting is Claude's job, not Roger's - it has not been done.`,
  }
}

function ageInHours(iso, now) {
  if (!iso) return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  return (now.getTime() - t) / 3_600_000
}

/** Everything that is not 'ok', worst first: diverged before merely stale, then oldest first. */
export function rank(results) {
  const bad = results.filter((r) => r.level !== 'ok')
  return bad.sort((a, b) => {
    if (a.level !== b.level) return a.level === 'diverged' ? -1 : 1
    return (b.ageH ?? Infinity) - (a.ageH ?? Infinity)
  })
}
