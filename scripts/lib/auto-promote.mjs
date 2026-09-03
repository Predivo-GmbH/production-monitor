/**
 * WHICH INTERNAL TOOLS MAY SHIP THEMSELVES, AND UNDER EXACTLY WHAT CONDITIONS.
 *
 * WHY THIS EXISTS (2026-09-03). Roger's deploy page kept showing rows that read "Promoting it is
 * mine, not yours" while nothing promoted them - the sentence named an owner with no mechanism
 * behind it, so a row sat until a session happened to look or the 24h backlog watcher went red.
 * He asked what to do about it and answered the question himself: **"Yes - auto-promote
 * internal."** Customer-facing products still always wait for his word; that half is unchanged and
 * is enforced here by an allowlist that defaults to refusing.
 *
 * THE DECISION THIS ENCODES, in his words (2026-09-01, quoted in BackOffice
 * supabase/functions/deploy-status/promotion-owner.ts): *"You can promote it directly into
 * production because it is an internal product... If everything is documented and also clear on
 * staging, you can promote it to production yourself."* Scoped explicitly: *"This changes R64 for
 * INTERNAL products ONLY. A customer-facing product (ReplyFlow, SignalScore, ChannelMover,
 * ScoutCopilot, Valrano, arivioo, the predivo.ch site) still goes to Roger."*
 *
 * ⭐ EVERY CONDITION BELOW IS A REASON TO REFUSE. This code can deploy to production without a
 * human present, so it is written to say NO on anything it cannot positively prove: an unknown
 * product, an unreadable state, a staging run whose FULL gate set did not pass, a divergence, a
 * fleet deploy already in flight. There is no branch that ships on "probably fine".
 */

/**
 * The only products this may ever promote. Each entry is a decision Roger stated, by name.
 *   BackOffice, Cockpit  - 2026-09-01, the quote above, named directly.
 *   Distribution-OS      - 2026-09-03: "Distribution-OS is OURS to release, same as BackOffice."
 *
 * NOT here, deliberately, though the portfolio registry files them as `intern`: Predivo (his
 * 2026-09-01 wording names the predivo.ch site as customer-facing), BoatBuddy, LaunchReady and
 * Jass-Tour (he has never named them in a promotion decision). Anything absent is refused.
 */
export const AUTO_PROMOTABLE = Object.freeze(['backoffice', 'cockpit', 'distribution-os'])

/** Gate jobs that must ALL have concluded success on the staging run being promoted. */
export const REQUIRED_STAGING_JOBS = Object.freeze(['deploy-staging', 'e2e-staging'])

export function isAutoPromotable(repo) {
  const tail = String(repo ?? '').split('/').pop() ?? ''
  return AUTO_PROMOTABLE.includes(tail.trim().toLowerCase())
}

/**
 * Decide whether ONE product may be promoted right now.
 *
 * @param {object} p
 * @param {string} p.repo              repository name
 * @param {string|null} p.prodSha      commit the production deploy JOB last shipped
 * @param {string|null} p.stagingSha   commit the staging deploy JOB last shipped
 * @param {string|null} p.compareStatus GitHub compare prod...staging: 'behind'|'ahead'|'identical'|'diverged'
 * @param {Record<string,string|null>} p.stagingJobs job name -> conclusion, for the staging run
 * @param {boolean} p.fleetBusy        another fleet deploy is in flight
 * @returns {{promote: boolean, reason: string}}
 */
export function decide(p) {
  const repo = String(p?.repo ?? '')
  if (!isAutoPromotable(repo)) {
    return { promote: false, reason: `${repo || '(unnamed)'}: not on the internal allowlist - a customer-facing product is Roger's word, never mine` }
  }
  // A deploy in flight is refused for the same reason the PreToolUse serializer refuses one: on
  // 2026-09-03 three simultaneous promotions got our own address refused by the shared host for 45
  // minutes. One at a time, always.
  if (p?.fleetBusy) {
    return { promote: false, reason: `${repo}: another fleet deploy is in flight - they share one host, so one at a time` }
  }
  if (!p?.prodSha || !p?.stagingSha) {
    return { promote: false, reason: `${repo}: could not read what is deployed (prod=${p?.prodSha ? 'ok' : 'unknown'}, staging=${p?.stagingSha ? 'ok' : 'unknown'}) - refusing to ship blind` }
  }
  if (p.prodSha === p.stagingSha) {
    return { promote: false, reason: `${repo}: nothing to promote, production already has it` }
  }
  // DIVERGED IS NEVER PROMOTED. Each side holds work the other lacks, so a promotion ships nothing
  // and widens the split - it needs a merge, and a merge is a judgement call, not a deploy.
  if (p.compareStatus === 'diverged') {
    return { promote: false, reason: `${repo}: staging and production have drifted apart - this needs merging, not promoting` }
  }
  // ONLY "ahead" is promotable. The compare is prod...staging (base=prod, head=staging), so
  // GitHub's "ahead" means staging holds commits production does not - the real promote case.
  // "behind" means staging is BEHIND production (production already has newer code): there is
  // nothing to promote, and shipping would dispatch main HEAD the cited staging run never covered.
  // The sibling reader promotion-backlog.mjs:62 treats the identical call as "ahead" only.
  if (p.compareStatus === 'behind') {
    return { promote: false, reason: `${repo}: nothing to promote, production is already ahead of staging` }
  }
  if (p.compareStatus !== 'ahead') {
    return { promote: false, reason: `${repo}: could not establish how staging relates to production (compare said "${p.compareStatus ?? 'nothing'}") - refusing to ship blind` }
  }
  // THE FULL GATE SET, on the very run that produced this staging build. Roger's condition was
  // "the FULL E2E suite passed there, not a subset, not a smoke run". A missing job is a refusal,
  // not a pass: absence of a result is not a result.
  const jobs = p?.stagingJobs ?? {}
  for (const name of REQUIRED_STAGING_JOBS) {
    const got = jobs[name]
    if (got !== 'success') {
      return { promote: false, reason: `${repo}: staging job "${name}" is ${got ?? 'missing'}, not success - the full gate set must be green on the exact commit being shipped` }
    }
  }
  return { promote: true, reason: `${repo}: staging ${String(p.stagingSha).slice(0, 7)} is green on ${REQUIRED_STAGING_JOBS.join(' + ')} and production is on ${String(p.prodSha).slice(0, 7)}` }
}

/**
 * At most ONE promotion per run, even when several qualify - the shared host is the constraint,
 * and a run that fires three deploys is the incident this fleet already had.
 */
export function pickOne(decisions) {
  return (decisions ?? []).find((d) => d?.promote) ?? null
}
