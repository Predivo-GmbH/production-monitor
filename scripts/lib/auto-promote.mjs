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
 * ⭐ WHICH PIPELINE IS "PRODUCTION", PINNED - because matching it by NAME picked the wrong one.
 *
 * MEASURED 2026-09-03 21:40Z. The promoter found "what is deployed to production" by scanning
 * recent runs for one whose NAME contained "deploy" and which held a JOB called `deploy`. Two
 * different pipelines in the same repo satisfy both: `deploy.yml` ships the app, and
 * `deploy-edge-functions.yml` ("Deploy edge functions") ships Supabase functions - and ITS job is
 * also called `deploy`. Edge deploys are frequent, so they won the scan:
 *
 *   backoffice        believed prod = 9803714 (an edge run)   TRUE prod = 6f35d6c   ahead by 5
 *   distribution-os   believed prod = 465ce6e (an edge run)   TRUE prod = 7444255   behind 8 vs 1
 *
 * The consequence was not a crash, it was a FALSE ALL-CLEAR: backoffice had 9803714 sitting on
 * staging with deploy-staging AND e2e-staging both green, five commits ahead of what production
 * actually runs, and the promoter logged "nothing to promote, production already has it" every
 * hour. The one mechanism written to stop a row sitting until somebody looked was itself the
 * thing that sat.
 *
 * So the pipeline is no longer inferred. Each entry is a FILE PATH read from the repo, and the
 * sha that authorises a promotion and the workflow that receives it are now the same object by
 * construction - they cannot drift apart, because there is only one of them.
 *
 *   prod     the workflow whose `deploy` job IS production for this product
 *   staging  the workflow whose `deploy-staging` + `e2e-staging` jobs gate it
 *            (Distribution-OS splits them across two files; the other two do not)
 *   ref      the branch a production dispatch runs from. NOT always "main": Distribution-OS is
 *            on `master`, and the hardcoded "main" would have 422'd every promotion it ever
 *            tried. Verified 2026-09-03 against each repo's own default_branch.
 *   ignorePaths  copied VERBATIM from that workflow's own `paths-ignore`. A commit touching only
 *            these cannot change what a deploy produces, so a branch tip that is ahead of the
 *            proven commit by nothing but such files is still deployment-equivalent to it.
 *            Distribution-OS has none: its production workflow is dispatch-only, and its staging
 *            lives on a different branch, so nothing there is safely ignorable.
 *
 * A product absent from this map is REFUSED, exactly like a product absent from the allowlist:
 * a new product must land on the safe side without anyone remembering to edit this file.
 */
export const PIPELINES = Object.freeze({
  // backoffice deliberately ignores markdown at ANY depth; cockpit's '*.md' is root-level only
  // (GitHub Actions semantics). The lists differ on purpose - do not "tidy" them into one.
  backoffice: Object.freeze({
    prod: 'deploy.yml', staging: 'deploy.yml', ref: 'main',
    ignorePaths: Object.freeze(['*.md', '**/*.md', 'docs/**', 'LICENSE', '.gitignore']),
  }),
  cockpit: Object.freeze({
    prod: 'deploy.yml', staging: 'deploy.yml', ref: 'main',
    ignorePaths: Object.freeze(['*.md', 'docs/**', 'LICENSE', '.gitignore']),
  }),
  'distribution-os': Object.freeze({
    prod: 'deploy.yml', staging: 'deploy-staging.yml', ref: 'master',
    ignorePaths: Object.freeze([]),
  }),
})

/**
 * Does one changed file match one `paths-ignore` pattern, with GitHub Actions' semantics?
 *
 * Only the three shapes these workflows actually use are implemented, and anything else returns
 * false - an unrecognised pattern must never widen what counts as ignorable:
 *   '*.md'      ROOT-LEVEL markdown only. This is the one people get wrong; backoffice's own
 *               workflow carries a comment about having been bitten by it.
 *   '**' / 'x/**'  a prefix, at any depth
 *   'LICENSE'   an exact path
 */
export function isIgnorablePath(file, patterns) {
  const f = String(file ?? '')
  if (!f) return false
  return (patterns ?? []).some((raw) => {
    const p = String(raw ?? '')
    if (p.startsWith('**/')) {
      const suffix = p.slice(3)
      if (suffix.startsWith('*.')) return f.endsWith(suffix.slice(1))
      return f === suffix || f.endsWith(`/${suffix}`)
    }
    if (p.endsWith('/**')) return f.startsWith(`${p.slice(0, -3)}/`)
    if (p.startsWith('*.')) return !f.includes('/') && f.endsWith(p.slice(1))
    return f === p
  })
}

/** The pinned pipeline for a repo, or null - and null is a refusal, never a guess. */
export function pipelineFor(repo) {
  const tail = String(repo ?? '').split('/').pop() ?? ''
  return PIPELINES[tail.trim().toLowerCase()] ?? null
}

/**
 * Is this workflow run an APP deploy, as opposed to an edge-functions deploy that merely also has
 * a job named `deploy`? Used by the sibling reader check-promotion-backlog.mjs, which cannot use
 * the pinned map above because it reports on all eight products, not just the three promotable
 * ones. Measured across the whole fleet on 2026-09-03: excluding edge runs corrects backoffice
 * (9803714 -> 6f35d6c) and distribution-os (465ce6e -> 7444255) to the shas their own deploy.yml
 * actually shipped, and changes the answer for none of the other seven.
 */
export function isAppDeployRun(runName) {
  const n = String(runName ?? '')
  return /deploy/i.test(n) && !/edge/i.test(n)
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
 * @param {string|null} p.refHeadSha   tip of the branch a production dispatch would run from -
 *                                     i.e. the commit that would ACTUALLY ship
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
  // ⭐ SHIP ONLY WHAT YOU PROVED. A production dispatch takes a BRANCH ref, never a sha, so what
  // actually deploys is the tip of that branch AT DISPATCH TIME - not the staging commit whose
  // gates were just checked. If main has moved since, every gate above was evidence about a
  // commit that is not the one going out, and the log line would name the proven sha while
  // shipping a different one. Measured 2026-09-03: cockpit's gated staging sha was cc4935e while
  // main stood at 5bf29fd, and backoffice's was 9803714 while main stood at 046d045 - so on that
  // hour BOTH promotable products would have shipped code no gate in this file had looked at.
  // The refusal is not new policy: the "behind" branch above already refuses for this exact
  // reason ("would dispatch main HEAD the cited staging run never covered"). It was true of every
  // other branch too, and only that one said so.
  if (!p?.refHeadSha) {
    return { promote: false, reason: `${repo}: could not read what the production branch currently points at - refusing to dispatch a branch whose tip is unknown` }
  }
  // A tip that is ahead is not automatically a different DEPLOY. Every one of these pipelines
  // carries a `paths-ignore`, and a commit touching only those paths cannot change what is built -
  // it never even triggers a staging run, so demanding sha equality would wait for a run that is
  // never going to happen. Found within the hour of writing this gate: backoffice's main sat one
  // commit past its gated build, and that commit was a single file, docs/FIX-...md. Sha equality
  // would have held five green commits for ever while the log promised they would ship next hour.
  if (p.refHeadSha !== p.stagingSha) {
    const short = `staging gated ${String(p.stagingSha).slice(0, 7)} but the production branch now points at ${String(p.refHeadSha).slice(0, 7)}`
    const files = p?.tipChangedFiles
    if (!Array.isArray(files)) {
      return { promote: false, reason: `${repo}: ${short}, and I could not read which files differ - refusing to ship a difference I have not seen` }
    }
    const wouldShip = files.filter((f) => !isIgnorablePath(f, p?.ignorePaths))
    if (wouldShip.length) {
      return { promote: false, reason: `${repo}: the proven commit is not the one that would ship - ${short}, and ${wouldShip.length} changed file(s) no gate has seen would go out with it (e.g. ${wouldShip[0]}). Let staging catch up and this promotes itself next hour.` }
    }
    return { promote: true, reason: `${repo}: staging ${String(p.stagingSha).slice(0, 7)} is green on ${REQUIRED_STAGING_JOBS.join(' + ')} and production is on ${String(p.prodSha).slice(0, 7)} - the branch tip ${String(p.refHeadSha).slice(0, 7)} adds only ${files.length} deploy-ignored file(s), so it builds the same thing` }
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
