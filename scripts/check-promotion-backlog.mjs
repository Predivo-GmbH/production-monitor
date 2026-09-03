#!/usr/bin/env node
/**
 * NOTHING SHIPPED FOR TOO LONG, AND NOTHING SPLIT IN TWO.
 *
 * WHY THIS EXISTS (2026-09-03). Roger, on the Deploy Status page for the fourth time in two days:
 * *"I do not want to have this fucking deploy board stale and not working properly."*
 *
 * The page was not lying. Distribution-OS had been saying "staging and production have drifted
 * apart - this needs merging, not approving" since 2026-08-04 - a month - while each branch kept
 * collecting work the other never received, production's side including a gate password rotated
 * because the previous one had reached git. Other products sat "N commits on staging that
 * production does not have" until somebody happened to look.
 *
 * So the gap was never truthfulness. It was that A DASHBOARD IS PULL: nothing went red when the
 * page was right and nobody acted. Every other class of rot here is caught by something that fails
 * on its own; this one had nothing. `check-drift.mjs` watches Supabase schema and cron drift, not
 * shipping.
 *
 * A FINDING IS FILED TO THE BOARD AND EXITS 0, exactly like every sibling sensor in monitor.yml
 * (check-deploy-failures, check-healthchecks-down, check-sentry-issues, …). Exit 1 is reserved for
 * "I could not look": no product could be read, a repo was unreadable, or a GitHub API call failed.
 * A month-old shipping backlog is a chronic board item, not something to re-red the hourly monitor
 * and re-mail Roger every hour — that was the original defect (a finding exited 1, so it rode the
 * job's failure() path into send-alert.mjs on every run and could never resolve).
 *
 * ⭐ IT COMPARES WHAT IS DEPLOYED, NOT THE BRANCH HEADS. On Distribution-OS the branch heads say
 * ahead 9 / behind 17 and the deployed commits say ahead 9 / behind 8. Both true, different
 * questions; "is production behind" is about what is LIVE. Comparing one against the other is how
 * you invent a bug that is not there - I nearly filed exactly that.
 *
 * ABSENCE IS NOT SUCCESS. If it cannot read a repo it says so and fails, rather than reporting a
 * healthy fleet it never looked at.
 */
import { readFileSync } from 'fs'
import { classifyBacklog, rank, DEFAULT_MAX_AGE_H } from './lib/promotion-backlog.mjs'

// The board this files into is BackOffice's, the same one every sibling sensor writes to.
export const SOURCE = 'promotion-backlog'
const BO_REF = 'xoecpzfsskalvjrtcbbl'
const BO_BASE = `https://${BO_REF}.supabase.co`
const BO_CREDS = 'C:\\Business\\Internal Projects\\BackOffice\\docs\\Credentials.txt'
const UA = 'promotion-backlog/1.0'

const OWNER = process.env.PROMO_OWNER || 'Predivo-GmbH'

// Products that ship a website to the shared host and have a staging environment.
const FLEET = (process.env.PROMO_FLEET || 'ChannelMover,ScoutCopilot,Valrano,BoatBuddy,ReplyFlow,backoffice,distribution-os,signalscore')
  .split(',').map((s) => s.trim()).filter(Boolean)

async function main() {
  const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  const MAX_AGE_H = Number(process.env.PROMO_MAX_AGE_H || DEFAULT_MAX_AGE_H)
  const dry = process.argv.includes('--dry')

  if (!TOKEN) {
    console.error('::error::no GH_TOKEN / GITHUB_TOKEN - cannot check the promotion backlog, and will not pretend the fleet is clean')
    return 1
  }

  const H = {
    Authorization: `Bearer ${TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'promotion-backlog',
  }
  let apiErrors = 0
  async function gh(path) {
    try {
      const r = await fetch(`https://api.github.com${path}`, { headers: H })
      if (!r.ok) { apiErrors++; return null }
      return await r.json()
    } catch { apiErrors++; return null }
  }

  /** The head sha of the most recent run whose named job actually SUCCEEDED. Never the run colour. */
  async function lastDeployedSha(repo, workflowMatch, jobName) {
    const runs = await gh(`/repos/${OWNER}/${repo}/actions/runs?per_page=30`)
    if (!runs?.workflow_runs) return null
    for (const run of runs.workflow_runs) {
      if (!workflowMatch.test(String(run.name || ''))) continue
      const jobs = await gh(`/repos/${OWNER}/${repo}/actions/runs/${run.id}/jobs?per_page=50`)
      const job = (jobs?.jobs || []).find((j) => j.name === jobName)
      if (job?.conclusion === 'success') return run.head_sha
    }
    return null
  }

  const results = []
  const unreadable = []

  for (const repo of FLEET) {
    const prod = await lastDeployedSha(repo, /deploy/i, 'deploy')
    const staging = await lastDeployedSha(repo, /deploy/i, 'deploy-staging')
    if (!prod || !staging) { unreadable.push(`${repo} (prod=${prod ? 'ok' : 'unknown'}, staging=${staging ? 'ok' : 'unknown'})`); continue }
    if (prod === staging) { results.push({ ...classifyBacklog({ name: repo, status: 'identical', aheadBy: 0, oldestUnshippedAt: null }, { maxAgeH: MAX_AGE_H }), repo }); continue }

    const cmp = await gh(`/repos/${OWNER}/${repo}/compare/${prod}...${staging}`)
    if (!cmp) { unreadable.push(`${repo} (compare failed)`); continue }

    // The OLDEST commit still waiting, which is what "how long has this sat" means.
    const oldest = (cmp.commits || [])[0]?.commit?.committer?.date || null
    results.push({ ...classifyBacklog({
      name: repo,
      status: cmp.status,
      aheadBy: cmp.ahead_by,
      behindBy: cmp.behind_by,
      oldestUnshippedAt: oldest,
    }, { maxAgeH: MAX_AGE_H }), repo })
  }

  const bad = rank(results)
  for (const r of results.filter((x) => x.level === 'ok')) console.log(`  ok    ${r.reason}`)
  for (const r of bad) console.log(`  ${r.level.toUpperCase().padEnd(8)} ${r.reason}`)

  if (unreadable.length) {
    console.log('')
    for (const u of unreadable) console.log(`::error::could not read shipping state for ${u}`)
  }

  console.log(`\nchecked ${results.length} product(s), ${bad.length} needing action, ${unreadable.length} unreadable`)

  // ── file findings to the board, and resolve the ones that caught up ───────────
  // A finding is a board row, not a job failure. Only "could not look" reds the run.
  if (results.length && !dry) {
    const secret = readBoSecret()
    // 'superseded' is read alongside 'open' for the same reason the sibling producers do it: the
    // board-drainer stamps a row superseded when it moves it onto the work board, and a product that
    // catches up while it sits there still has to be resolved.
    const open = await boGet(secret, `fleet_signals?source=eq.${SOURCE}&state=in.(open,superseded)&select=key`)
    const openKeys = new Set(open.map((r) => r.key))
    const redKeys = new Set(bad.map((r) => r.repo))
    const judgedKeys = new Set(results.map((r) => r.repo))   // every product we could actually read

    for (const r of bad) {
      const res = await fileSignal(secret, signalFor(r))
      console.log(`  filed ${r.repo} - ${res.will_page ? `page due ${res.page_due_at}` : `not paging (${res.suppressed ?? 'not eligible'})`}`)
    }

    // Resolve only keys THIS run judged and did not find bad — never "everything under this source
    // that is not red", the erasure trap the sibling producers document.
    for (const key of [...openKeys].filter((k) => judgedKeys.has(k) && !redKeys.has(k))) {
      await fileSignal(secret, {
        source: SOURCE, key, kind: 'incident', severity: 'info', state: 'resolved',
        title: `${key}: shipping is caught up again`,
        summary: 'The deployed commits match, or the wait is back under the threshold, so this cleared itself.',
        link: 'https://cockpit.predivo.ch/deploy',
      })
      console.log(`  recovered: ${key} - signal resolved.`)
    }
  } else if (dry) {
    console.log(`--dry: would file ${bad.length} finding(s) and resolve any caught-up rows. Nothing written.`)
  }

  // Annotations, not a job failure: these show red in the log but do NOT set failure() (exactly as
  // check-deploy-failures.mjs does), so a chronic backlog cannot re-mail Roger every hour.
  for (const r of bad) console.log(`::error::${r.reason}`)

  // EXIT 1 IS RESERVED FOR "I COULD NOT LOOK". A finding is filed above and exits 0.
  return exitCode({ readCount: results.length, unreadableCount: unreadable.length, apiErrors })
}

// ── pure helpers (importable for tests) ───────────────────────────────────────

/** The board signal for one product that is behind or split. Pure. */
export function signalFor(r) {
  const title = r.level === 'diverged'
    ? `${r.repo}: staging and production have drifted apart and need merging`
    : `${r.repo}: commits have been waiting too long to go live`
  return {
    source: SOURCE,
    key: r.repo,
    kind: 'incident',
    severity: 'warning',
    state: 'open',
    // Claude promotes or merges this; it lands on /signals and never rings Roger's phone. There is
    // no signal_page_policy row for this source, so upsert_signal records it policy-off regardless.
    needs_human: false,
    title,
    summary: r.reason,
    detail: { level: r.level, age_hours: r.ageH },
    link: 'https://cockpit.predivo.ch/deploy',
  }
}

/**
 * The exit discipline every sibling sensor states in its monitor.yml comment: exit 1 ONLY when the
 * sweep could not look (nothing read, a repo unreadable, or a GitHub API call failed). A finding is
 * a filed board row and exits 0. Pure.
 */
export function exitCode({ readCount, unreadableCount, apiErrors: apiErr }) {
  return readCount === 0 || unreadableCount > 0 || apiErr > 0 ? 1 : 0
}

// ── board I/O (mirrors check-deploy-failures.mjs exactly) ─────────────────────

function readBoSecret() {
  if (process.env.BOARD_SUPABASE_SECRET) return process.env.BOARD_SUPABASE_SECRET.trim()
  if (process.env.BACKOFFICE_SERVICE_ROLE_KEY) return process.env.BACKOFFICE_SERVICE_ROLE_KEY.trim()
  const txt = readFileSync(BO_CREDS, 'utf-8')
  const m = txt.match(/sb_secret_[A-Za-z0-9_]+/)
  if (!m) throw new Error(`no sb_secret_ key found in ${BO_CREDS}`)
  return m[0]
}

async function boGet(secret, path) {
  const res = await fetch(`${BO_BASE}/rest/v1/${path}`, {
    headers: { apikey: secret, Authorization: `Bearer ${secret}`, 'User-Agent': UA },
  })
  if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`)
  return res.json()
}

async function fileSignal(secret, body) {
  const res = await fetch(`${BO_BASE}/functions/v1/signal-intake`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`signal-intake -> HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`)
  return res.json()
}

// Importable for tests; only runs the sweep when executed directly.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('check-promotion-backlog.mjs')) {
  main().then((c) => process.exit(c)).catch((e) => {
    console.error(`::error::promotion-backlog could not complete: ${e.message}`)
    process.exit(1)
  })
}
