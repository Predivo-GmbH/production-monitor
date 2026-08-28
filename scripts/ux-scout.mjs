#!/usr/bin/env node
/**
 * ux-scout.mjs: the PROACTIVE half of the agent tier.
 *
 * Everything else we run is REACTIVE: it wakes when a check somebody already wrote
 * goes red. `~/.claude/scripts/hourly-production-check-prompt.md:24` says it outright,
 * "if green ... STOP immediately". A check finds what you predicted. Nothing in the
 * fleet looks for what nobody predicted. This does.
 *
 * It reads each product's own failure log, splits AUTHENTICATED failures (a real person
 * hit this) from anonymous probes (a bot hit a public function URL), and files each one
 * as a REPORT in BackOffice `scout_reports`. A report is free. It never pages, never
 * opens a PR, never touches product code. Promotion to a fix is a separate, human-gated
 * phase.
 *
 * Plan: docs/PLAN-UX-SCOUT-2026-08-20.md
 * Sibling: board-drainer.mjs (same credential, logging, kill-switch and alarm shape).
 *
 * REF SAFETY (the mistake this file exists to not repeat): production refs are PARSED
 * OUT OF EACH REPO'S OWN deploy.yml at runtime, never hardcoded and never recalled from
 * memory. On 2026-08-20 a whole analysis was built on ReplyFlow STAGING because the ref
 * in a credentials file looked like production. resolveProdRef() makes that unrepeatable.
 *
 * Usage:
 *   UX_SCOUT_ENABLED=1 node scripts/ux-scout.mjs              # dry run: read, classify, print
 *   UX_SCOUT_ENABLED=1 UX_SCOUT_LIVE=1 node scripts/ux-scout.mjs   # also write + email
 *   UX_SCOUT_DISABLED=1                                        # kill switch, overrides everything
 *   UX_SCOUT_WINDOW_DAYS=7                                     # lookback (default 7)
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { DEPLOY_DENY_TOOLS } from './lib/deploy-deny-tools.mjs'

// ── config ───────────────────────────────────────────────────────────────────────
const PROJECTS_ROOT = process.env.UX_SCOUT_PROJECTS_ROOT || 'C:\\Business\\Internal Projects'
const STATE_DIR = process.env.UX_SCOUT_HOME || 'C:\\Business\\_ux-scout'
const LOG = join(STATE_DIR, 'ux-scout.log')
const SEND_EMAIL = join(homedir(), '.claude', 'scripts', 'send_report_email.py')
const BO_CREDS = join(PROJECTS_ROOT, 'BackOffice', 'docs', 'Credentials.txt')
const BO_REF = 'xoecpzfsskalvjrtcbbl' // BackOffice PROD (docs/Credentials.txt:18, "Production URL" line 12)
const BO_BASE = `https://${BO_REF}.supabase.co`
const NON_BROWSER_UA = 'ux-scout'
const MGMT = 'https://api.supabase.com/v1/projects'

const ENABLED = process.env.UX_SCOUT_ENABLED === '1'
const LIVE = process.env.UX_SCOUT_LIVE === '1'
const DISABLED = process.env.UX_SCOUT_DISABLED === '1'
const WINDOW_DAYS = Number(process.env.UX_SCOUT_WINDOW_DAYS || 7)

/**
 * The signal sources. Each entry says which repo to resolve the PROD ref from, and how to
 * turn that product's own failure table into (pattern, count, distinct_users, authenticated).
 *
 * `authenticated` is the column that matters. It is only meaningful for products whose
 * error-log helper stores `context` as real jsonb; ReplyFlow got that fix in commit 3e353c6
 * (2026-08-20). Where the helper still double-encodes, every row reads as anonymous, which
 * is why `contextFixed` is tracked explicitly rather than assumed.
 */
export const SOURCES_FOR_TEST = [
  {
    product: 'replyflow',
    repo: 'replyflow',
    table: 'error_log',
    contextFixed: true,
    sql: (days) => ERROR_LOG_SQL(days),
  },
  {
    product: 'channelmover',
    repo: 'ChannelMover',
    table: 'error_log',
    contextFixed: true, // 5721994, deployed PROD 2026-08-20
    sql: (days) => ERROR_LOG_SQL(days),
  },
  {
    // SignalScore's error_log is empty (0 rows, verified 2026-08-20) but api_request_logs
    // carries 3,408 rows with status_code, so THAT is its signal source. A scout reads the
    // table a product actually writes, not the one we wish it wrote.
    product: 'signalscore',
    repo: 'signalscore',
    table: 'api_request_logs',
    contextFixed: true, // 7049391, deployed PROD 2026-08-20
    sql: (days) => `
      select coalesce(service, 'unknown') as function_name,
             coalesce(endpoint, '') as operation,
             ${NORMALISE("coalesce(error_message, 'HTTP ' || status_code::text)")} as message_pattern,
             count(*)::int as occurrences,
             0::int as distinct_users,
             false as authenticated,
             min(created_at) as first_seen,
             max(created_at) as last_seen,
             '{}'::jsonb as sample_evidence
        from api_request_logs
       where created_at > now() - interval '${days} days'
         and status_code >= 400
       group by 1,2,3
       order by occurrences desc`,
  },
  {
    // arivioo: writes error_log but had 0 rows at 2026-08-20. Included anyway. A source
    // that is empty today must still be WATCHED, otherwise the day it starts producing is
    // the day nobody notices.
    //
    // arivioo has NO .github/workflows/deploy.yml at all — it ships to Metanet over FTP, not
    // GitHub CI — so resolveProdRef() had nothing to read and every run failed ENOENT, leaving
    // arivioo's prod error_log silently unread while the digest still claimed nothing was
    // skipped (incident ux-scout:arivioo-source-unreadable, 2026-08-26). The ref therefore
    // comes from the next-best source of truth, named here so it is auditable rather than
    // magic. This is the PROD ref, deliberately NOT the staging ref xyqdyqpdjugevjmjbcdp that
    // also lives in that credentials file.
    product: 'arivioo',
    repo: 'arivioo',
    table: 'error_log',
    contextFixed: true, // commit 9be8b4b
    ref: { value: 'iooexkbuxmeryeuzpxau', because: 'docs/Credentials.txt:18 "Project ID: iooexkbuxmeryeuzpxau" + :19 "Project URL"; repo deploys via FTP so it has no .github/workflows/deploy.yml for resolveProdRef()' },
    sql: (days) => ERROR_LOG_SQL(days),
  },
  {
    // Valrano. Its Management PAT returned 403 on the first run, which turned out to be a
    // RETIRED token sitting on the canonical "Access Token:" line of its Credentials.txt
    // after the 2026-07-30 org move (retired -> 403, valrano-ci-deploy -> 201). Fixed in the
    // credentials file, so the scout reads it normally now. Kept as a reminder that a
    // READ FAILED is a lead to chase, never a reason to drop a product from coverage.
    product: 'valrano',
    repo: 'Valrano',
    table: 'error_log',
    contextFixed: true, // 5dc0de5, 3 error-log consumers deployed PROD 2026-08-20
    sql: (days) => ERROR_LOG_SQL(days),
  },
  {
    // BackOffice. Excluded from the first build on the reasoning "internal admin tool, its
    // only user is Roger". That reasoning was WRONG and Roger called it: there IS a user, and
    // when it breaks he is the one it breaks for. Checked 2026-08-20: error_log holds 22 rows,
    // 21 of them the Smartlead "Plan expired!" 401 still firing that morning, i.e. excluding
    // BackOffice actively hid a recurring failure that was already an open item.
    product: 'backoffice',
    repo: 'BackOffice',
    table: 'error_log',
    contextFixed: true, // 39b4f2f, 13 error-log consumers deployed PROD 2026-08-20
    // BackOffice CI does not deploy edge functions (.github/workflows/deploy.yml:226), so its
    // deploy.yml carries no --project-ref for resolveProdRef() to find. The ref therefore comes
    // from the next-best source of truth, named here so it is auditable rather than magic.
    ref: { value: 'xoecpzfsskalvjrtcbbl', because: 'docs/Credentials.txt:12 "Production URL: https://backoffice.predivo.ch" + :18 "Project ID"' },
    sql: (days) => ERROR_LOG_SQL(days),
  },
  {
    // Instrumented 2026-08-20. Had 16 edge functions and NO failure table at all, so every
    // caught error went to console.error and vanished. 9 auth users at the time.
    product: 'scoutcopilot',
    repo: 'ScoutCopilot',
    table: 'error_log',
    contextFixed: true, // helper written correct from the start (ca771ce)
    ref: { value: 'rlcsuqwqzoqjykdiqjye', because: 'docs/Credentials.txt:12 "Production URL: https://scoutcopilot.com" + :18 "Project ID"; CI does not deploy edge functions so deploy.yml has no --project-ref' },
    sql: (days) => ERROR_LOG_SQL(days),
  },
  {
    // Instrumented 2026-08-20. 6 edge functions, no failure table. 5 auth users.
    // Its stripe-checkout and stripe-portal catches returned a generic message and threw the
    // real cause away entirely, so payment failures were unknowable. Now logged.
    product: 'distribution-os',
    repo: 'Distribution-OS',
    table: 'error_log',
    contextFixed: true, // ae75c94
    ref: { value: 'jxjpbmkgmuunpayqgbsx', because: 'docs/Credentials.txt:12 "Production URL" + :18 "Project ID"; CI does not deploy edge functions' },
    sql: (days) => ERROR_LOG_SQL(days),
  },
  {
    // Instrumented 2026-08-20. 2 edge functions, no failure table. 3 auth users.
    product: 'launchready',
    repo: 'launchready',
    table: 'error_log',
    contextFixed: true, // 8c13443
    ref: { value: 'hcfeoescybfngjsphekq', because: 'docs/Credentials.txt:12 "Production URL" + :18 "Project ID"; CI does not deploy edge functions' },
    sql: (days) => ERROR_LOG_SQL(days),
  },
]

/**
 * Products NOT watched, stated out loud in every digest. A scout that reports "no
 * authenticated failures fleet-wide" while silently covering a third of the fleet is worse
 * than no scout: it manufactures false confidence.
 */
const NOT_COVERED = [
  // Empty on 2026-08-20. It used to hold scoutcopilot, launchready and distribution-os with
  // the reason "no error-log helper in the repo". Roger's answer to that was the right one:
  // then build one. All three were instrumented rather than excused. Keep this list and the
  // digest line even while it is empty, because the honest thing is to say out loud that
  // nothing is being skipped, not to go quiet about coverage.
]


/** The standard error_log rollup, shared by every product using the _shared/error-log.ts helper. */
function ERROR_LOG_SQL(days) {
  return `
      select function_name,
             coalesce(operation, '') as operation,
             ${NORMALISE('error_message')} as message_pattern,
             count(*)::int as occurrences,
             count(distinct context->>'user_id')::int as distinct_users,
             bool_or(context->>'user_id' is not null) as authenticated,
             min(created_at) as first_seen,
             max(created_at) as last_seen,
             (array_agg(context order by created_at desc))[1] as sample_evidence
        from error_log
       where created_at > now() - interval '${days} days'
       group by 1,2,3
       order by authenticated desc, occurrences desc`
}

/**
 * Collapse the volatile parts of an error message so the same problem groups into one row
 * instead of N. Without this, "Failed to fetch reviews: 503 {json blob}" would file a new
 * report every time the blob differs by a byte.
 */
function NORMALISE(col) {
  return `left(regexp_replace(regexp_replace(${col}, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', '<uuid>', 'gi'), '\\s+', ' ', 'g'), 160)`
}

// ── logging ──────────────────────────────────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`
  console.log(line)
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true })
    appendFileSync(LOG, line + '\n')
  } catch { /* noop */ }
}

// ── credentials (read at runtime, never inlined; same rule as board-drainer.mjs) ──
function readMgmtPat(repo) {
  const path = join(PROJECTS_ROOT, repo, 'docs', 'Credentials.txt')
  const txt = readFileSync(path, 'utf-8')
  // Prefer the token on an explicitly labelled "Access Token:" line; a credentials file
  // can mention several sbp_ values in prose and the first one is not always the live PAT.
  const labelled = txt.match(/Access Token:\s*(sbp_[A-Za-z0-9]+)/)
  if (labelled) return labelled[1]
  const any = txt.match(/sbp_[A-Za-z0-9]+/)
  if (!any) throw new Error(`no sbp_ management token found in ${path}`)
  return any[0]
}

function readBoSecret() {
  if (process.env.BOARD_SUPABASE_SECRET) return process.env.BOARD_SUPABASE_SECRET.trim()
  const m = readFileSync(BO_CREDS, 'utf-8').match(/sb_secret_[A-Za-z0-9_]+/)
  if (!m) throw new Error(`no sb_secret_ key found in ${BO_CREDS}`)
  return m[0]
}

/**
 * Resolve a repo's PRODUCTION Supabase ref from its own deploy.yml.
 *
 * Every fleet deploy.yml has a staging step and a production step, each running
 * `supabase functions deploy ... --project-ref <ref>`. We walk the file, remember the most
 * recent `- name:` above each ref, and return the one whose step name mentions production.
 * Falls back to the LAST ref in the file (prod is always the later job) so a renamed step
 * degrades to the right answer rather than to staging.
 */
export function resolveProdRef(deployYml) {
  const lines = deployYml.split(/\r?\n/)
  let stepName = ''
  const found = []
  for (const line of lines) {
    const nameMatch = line.match(/^\s*-\s*name:\s*(.+?)\s*$/)
    if (nameMatch) stepName = nameMatch[1]
    const refMatch = line.match(/--project-ref\s+([a-z]{20})/)
    if (refMatch) found.push({ ref: refMatch[1], step: stepName })
  }
  if (!found.length) return null
  const prod = found.find((f) => /prod/i.test(f.step))
  return (prod || found[found.length - 1]).ref
}

function prodRefFor(repo) {
  const path = join(PROJECTS_ROOT, repo, '.github', 'workflows', 'deploy.yml')
  const ref = resolveProdRef(readFileSync(path, 'utf-8'))
  if (!ref) throw new Error(`no --project-ref found in ${path}`)
  return ref
}

// ── I/O ──────────────────────────────────────────────────────────────────────────
async function runSql(ref, pat, sql) {
  const res = await fetch(`${MGMT}/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json', 'User-Agent': NON_BROWSER_UA },
    body: JSON.stringify({ query: sql }),
  })
  const body = await res.text()
  if (!res.ok) throw new Error(`query HTTP ${res.status}: ${body.slice(0, 200)}`)
  const parsed = body.trim() ? JSON.parse(body) : []
  if (parsed && parsed.message) throw new Error(`sql error: ${String(parsed.message).slice(0, 200)}`)
  return parsed
}

async function upsertReport(secret, payload) {
  const res = await fetch(`${BO_BASE}/rest/v1/rpc/upsert_scout_report`, {
    method: 'POST',
    headers: {
      apikey: secret, Authorization: `Bearer ${secret}`,
      'User-Agent': NON_BROWSER_UA, 'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(`upsert_scout_report HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.text()
}

async function readDismissed(secret) {
  // Phase 3 feedback: a pattern a human already judged not-real or known must never be
  // re-narrated or re-surfaced in the digest. This is what replaces hardcoded noise arrays
  // (e.g. replyflow monitor-email-integrity AI_NOISE, calibrated once on 2026-07-29 and
  // stale in silence ever since) with a decision that lives in data.
  const url = `${BO_BASE}/rest/v1/scout_reports`
    + `?select=product,function_name,message_pattern,state,state_reason`
    + `&state=in.(not-real,known,fixed)`
  const res = await fetch(url, {
    headers: { apikey: secret, Authorization: `Bearer ${secret}`, 'User-Agent': NON_BROWSER_UA },
  })
  if (!res.ok) throw new Error(`dismissed read HTTP ${res.status}`)
  return res.json()
}

export function dismissKey(r) {
  return `${r.product}||${r.function_name}||${r.message_pattern}`
}

// ── classification ───────────────────────────────────────────────────────────────
/**
 * Split a product's grouped rows into the two piles that matter.
 *
 * AUTHENTICATED means at least one occurrence carried a caller identity, so a real person
 * hit it. Those are reported individually with full evidence, however few they are: at the
 * fleet's current size (~39 users across products, verified 2026-08-20) a top-N ranking
 * would be meaningless, and one real user blocked is the whole signal.
 *
 * ANONYMOUS rows are almost always unauthenticated probes against public function URLs.
 * They are counted and shown as one summary line so they stay visible without ever being
 * mistaken for user pain.
 */
export function classify(rows, { dismissed = new Set(), product = '' } = {}) {
  const authenticated = []
  const anonymous = []
  const skipped = []
  const reopened = []
  for (const r of rows) {
    const key = dismissKey({ product, ...r })
    if (dismissed.has(key)) {
      // A dismissal is NOT unconditional, and this is the difference between a filter and
      // a blind spot.
      //
      // Nearly every dismissal is "unauthenticated probe, has_auth=false on every
      // occurrence". That judgement is only true while the pattern STAYS anonymous. The day
      // the same message starts hitting a signed-in user it is no longer a probe, it is the
      // exact user pain this tool exists to find, and silently skipping it would be the
      // worst possible failure: a filter that hides the thing it was built to surface.
      //
      // So: honour the dismissal only while the pattern is still anonymous. If it comes back
      // AUTHENTICATED, re-surface it and say plainly that it was previously dismissed, so the
      // judgement gets revisited against the new evidence rather than inherited.
      if (!r.authenticated) { skipped.push(r); continue }
      reopened.push(r)
      authenticated.push({ ...r, reopenedFromDismissal: true })
      continue
    }
    if (r.authenticated) authenticated.push(r)
    else anonymous.push(r)
  }
  return { authenticated, anonymous, skipped, reopened }
}

// ── narration (the ONLY model call; skipped entirely when nothing is authenticated) ──
function narrate(product, rows) {
  const prompt = [
    'You are the UX Scout. Below are grouped production failures that hit AUTHENTICATED users',
    `of ${product}. For EACH group output exactly one line: "<message_pattern> => <one sentence:`,
    'what the user was most likely trying to do, and what this probably means>".',
    'Do not speculate beyond the evidence. Do not propose code. No preamble, no numbering.',
    '',
    JSON.stringify(rows.map((r) => ({
      function: r.function_name, operation: r.operation, message: r.message_pattern,
      occurrences: r.occurrences, distinct_users: r.distinct_users, evidence: r.sample_evidence,
    })), null, 1),
  ].join('\n')

  // SECURITY (incident production-monitor:cdba231:...-command-injection, 2026-08-20).
  // This used `shell: true`, which on Windows hands command+args to cmd.exe as ONE string
  // with no escaping. The prompt is built from PRODUCTION ERROR TEXT (message_pattern and
  // sample_evidence), which is attacker-influenced end to end: a signed-in user can put
  // arbitrary characters into an error_log row (e.g. create-checkout assigns ctx.plan before
  // isPlanKey() rejects it), and NORMALISE() collapses only UUIDs and whitespace, so quotes,
  // &, |, ^, <, > and newlines all survive. That is arbitrary code execution on Roger's box,
  // inside a process that has already read the BackOffice service key and every product's
  // Management PAT.
  //
  // It was dormant until the same day's jsonb fix: before that, context->>'user_id' was
  // always null, so nothing ever grouped as authenticated and narrate() never ran on a real
  // row. Fixing one bug armed another.
  //
  // No shell. Explicit binary, args array, exactly the pattern board-drainer.mjs already uses.
  const CLAUDE_BIN = process.platform === 'win32' ? 'claude.exe' : 'claude'
  // This call only narrates findings and asks for no tools, but it is still an autonomous
  // spawn of the CLI, so it carries the same deny list as every other dispatcher. One
  // invariant with no exceptions is what deploy-deny-tools.test.mjs can actually enforce.
  const res = spawnSync(CLAUDE_BIN, ['-p', prompt, '--disallowedTools', DEPLOY_DENY_TOOLS.join(',')], {
    encoding: 'utf-8', timeout: 5 * 60 * 1000,
  })
  if (res.status !== 0 || !res.stdout) {
    log(`  narration unavailable (${res.error?.message || `exit ${res.status}`}); reporting without it`)
    return {}
  }
  const out = {}
  for (const line of res.stdout.split('\n')) {
    const i = line.indexOf('=>')
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 2).trim()
  }
  return out
}

// ── Measured (the step that closes the loop) ─────────────────────────────────────
/**
 * Nothing else in the fleet does this. Our receipts prove A CHANGE WAS MADE; they never
 * prove THE PROBLEM STOPPED. When a report is marked `fixed` (scout-triage.mjs) a
 * measure_after date is armed; this pass re-runs that exact signal afterwards and records
 * whether it actually went away.
 *
 * The comparison window starts at the moment the fix was marked, so a "gone" verdict means
 * gone SINCE the fix, not gone on average.
 */
export function verdict(before, after) {
  if (after === 0) return 'gone'
  if (before > 0 && after < before / 2) return 'reduced'
  if (after > before) return 'worse'
  return 'unchanged'
}

async function measurePass(boSecret) {
  let due = []
  try {
    due = await fetch(
      `${BO_BASE}/rest/v1/scout_reports?select=*&state=eq.fixed&measured_at=is.null&measure_after=lte.${new Date().toISOString()}`,
      { headers: { apikey: boSecret, Authorization: `Bearer ${boSecret}`, 'User-Agent': NON_BROWSER_UA } },
    ).then((r) => (r.ok ? r.json() : []))
  } catch { /* a measurement pass must never take the scan down with it */ }
  if (!due.length) return []

  const results = []
  for (const rep of due) {
    const src = SOURCES_FOR_TEST.find((s) => s.product === rep.product)
    if (!src) continue
    try {
      const ref = src.ref ? src.ref.value : prodRefFor(src.repo)
      const pat = readMgmtPat(src.repo)
      // Count the SAME pattern only since the fix was marked.
      const since = rep.state_changed_at || rep.measure_after
      const col = src.table === 'api_request_logs' ? "coalesce(error_message, 'HTTP ' || status_code::text)" : 'error_message'
      const sql = `select count(*)::int as n from ${src.table}
                   where created_at > '${since}'
                     and ${NORMALISE(col)} = ${escapeLiteral(rep.message_pattern)}`
      const rows = await runSql(ref, pat, sql.replace(/\s+/g, ' ').trim())
      const after = rows?.[0]?.n ?? 0
      const v = verdict(rep.occurrences, after)
      await fetch(`${BO_BASE}/rest/v1/scout_reports?id=eq.${rep.id}`, {
        method: 'PATCH',
        headers: {
          apikey: boSecret, Authorization: `Bearer ${boSecret}`,
          'User-Agent': NON_BROWSER_UA, 'Content-Type': 'application/json', Prefer: 'return=minimal',
        },
        body: JSON.stringify({ measured_at: new Date().toISOString(), measured_result: v }),
      })
      results.push({ ...rep, after, verdictResult: v })
      log(`  measured ${rep.product}/${rep.function_name}: ${rep.occurrences} before, ${after} since fix -> ${v}`)
    } catch (e) {
      log(`  measure failed for ${rep.id.slice(0, 8)}: ${String(e).slice(0, 160)}`)
    }
  }
  return results
}

/** Single-quote a value for inline SQL. Patterns are our own normalised text, never user input,
 *  but doubling quotes keeps an apostrophe in an error message from breaking the query. */
export function escapeLiteral(s) {
  return `'${String(s).replace(/'/g, "''")}'`
}

// ── digest ───────────────────────────────────────────────────────────────────────
export function buildDigest(findings, windowDays, measured = [], notCovered = NOT_COVERED) {
  const L = []
  const realCount = findings.reduce((n, f) => n + f.authenticated.length, 0)
  L.push(`UX Scout, last ${windowDays} days.`)
  L.push(`Coverage: ${findings.length} product(s) read` + (findings.some((f) => f.error) ? `, ${findings.filter((f) => f.error).length} UNREADABLE (see below)` : '') + '.')
  L.push('')
  if (realCount === 0) {
    L.push('No authenticated user hit a failure in any product. That is the correct answer, not a broken run.')
  } else {
    L.push(`${realCount} failure pattern(s) hit a REAL, signed-in user:`)
  }
  L.push('')
  for (const f of findings) {
    L.push(`## ${f.product} (${f.table}, prod ${f.ref})`)
    if (f.error) { L.push(`  READ FAILED: ${f.error}`); L.push(''); continue }
    if (!f.authenticated.length) {
      L.push('  no authenticated failures')
    }
    for (const r of f.authenticated) {
      L.push(`  ${r.reopenedFromDismissal ? '[USER, REOPENED]' : '[USER]'} ${r.function_name}/${r.operation}: ${r.message_pattern}`)
      if (r.reopenedFromDismissal) L.push('         PREVIOUSLY DISMISSED as anonymous, but it has now hit a signed-in user. The old judgement no longer holds; judge it again on this evidence.')
      L.push(`         ${r.occurrences}x, ${r.distinct_users} distinct user(s), last ${r.last_seen}`)
      if (r.narrative) L.push(`         ${r.narrative}`)
      L.push(`         evidence: ${JSON.stringify(r.sample_evidence)}`)
    }
    const anonTotal = f.anonymous.reduce((n, r) => n + r.occurrences, 0)
    if (anonTotal) {
      L.push(`  [probe] ${anonTotal} anonymous occurrence(s) across ${f.anonymous.length} pattern(s), no caller identity on any of them.`)
      for (const r of f.anonymous.slice(0, 5)) {
        L.push(`          ${r.occurrences}x ${r.function_name}: ${r.message_pattern.slice(0, 90)}`)
      }
      if (!f.contextFixed) {
        L.push('          NOTE: this product still double-encodes error_log.context, so "anonymous" here')
        L.push('          means UNKNOWN, not proven-bot. Port the ReplyFlow 3e353c6 jsonb fix to read it.')
      }
    }
    if (f.skipped.length) L.push(`  (${f.skipped.length} pattern(s) skipped: already judged not-real/known/fixed)`)
    L.push('')
  }
  if (measured.length) {
    L.push('## Measured (did the fix actually work?)')
    for (const m of measured) {
      L.push(`  ${m.verdictResult.toUpperCase()}: ${m.product}/${m.function_name} "${m.message_pattern.slice(0, 60)}"`)
      L.push(`         ${m.occurrences} before the fix, ${m.after} since. Fix marked ${String(m.state_changed_at).slice(0, 10)}.`)
    }
    L.push('')
  }
  const unreadable = findings.filter((f) => f.error)
  // These three facts are INDEPENDENT and must never be chained mutually-exclusive. NOT_COVERED
  // is 'products we chose not to watch'; unreadable is 'products we tried to read this run and
  // could not' — a BLIND SPOT. An earlier else-if chain hung the blind-spot line off NOT_COVERED,
  // so whenever NOT_COVERED was non-empty the digest went silent about an unreadable source and
  // still read as full coverage — a quiet re-run of incident ux-scout:arivioo-source-unreadable
  // (2026-08-26). Emit each on its own condition; only reassure when BOTH are empty.
  if (notCovered.length) {
    L.push('NOT watched (stated every week on purpose, so "fleet-wide" never overstates coverage):')
    for (const [p, why] of notCovered) L.push(`  ${p}: ${why}`)
  }
  if (unreadable.length) {
    L.push(`Coverage has a blind spot this run: ${unreadable.length} product(s) could not be read (${unreadable.map((f) => f.product).join(', ')}). A failure inside them would go unseen — do NOT read this as full coverage.`)
  }
  if (!notCovered.length && !unreadable.length) {
    L.push('Every product that ships edge functions has a failure table and is watched. Nothing is skipped.')
  }
  L.push('')
  L.push('Reports are free. Nothing here paged anyone, opened a PR, or changed code.')
  return L.join('\n')
}

function emailDigest(subject, body) {
  const tmp = join(STATE_DIR, 'digest.txt')
  writeFileSync(tmp, body, 'utf-8')
  const res = spawnSync('python', [SEND_EMAIL, subject, tmp], { encoding: 'utf-8', timeout: 120000 })
  if (res.status !== 0) log(`  email FAILED: ${res.stderr || res.error?.message || `exit ${res.status}`}`)
  else log('  digest emailed')
}

// ── main ─────────────────────────────────────────────────────────────────────────
async function main() {
  if (DISABLED) { log('KILL SWITCH set (UX_SCOUT_DISABLED=1), exiting.'); return }
  if (!ENABLED) {
    // Default posture is wired-but-off, exactly like the Board Drainer and the paid-key
    // gate: registering the script must never be the same act as arming it.
    console.log('ux-scout: UX_SCOUT_ENABLED not set, self-skipping (exit 0)')
    return
  }
  log(`UX Scout start, mode=${LIVE ? 'LIVE' : 'DRY-RUN'}, window=${WINDOW_DAYS}d`)

  const boSecret = readBoSecret()
  let dismissed = new Set()
  try {
    dismissed = new Set((await readDismissed(boSecret)).map(dismissKey))
    log(`  ${dismissed.size} previously-judged pattern(s) will not be re-surfaced`)
  } catch (e) {
    log(`  could not read prior judgements (${String(e).slice(0, 120)}); proceeding without them`)
  }

  const findings = []
  for (const src of SOURCES_FOR_TEST) {
    const f = { product: src.product, table: src.table, contextFixed: src.contextFixed, authenticated: [], anonymous: [], skipped: [] }
    try {
      f.ref = src.ref ? src.ref.value : prodRefFor(src.repo)
      const pat = readMgmtPat(src.repo)
      const rows = await runSql(f.ref, pat, src.sql(WINDOW_DAYS).replace(/\s+/g, ' ').trim())
      Object.assign(f, classify(rows, { dismissed, product: src.product }))
      log(`  ${src.product} (prod ${f.ref}): ${f.authenticated.length} authenticated, ${f.anonymous.length} anonymous, ${f.skipped.length} skipped`)
    } catch (e) {
      f.error = String(e).slice(0, 200)
      log(`  ${src.product}: READ FAILED ${f.error}`)
    }
    findings.push(f)
  }

  // Narrate only what a real user hit. A quiet week costs nothing.
  for (const f of findings) {
    if (!f.authenticated.length) continue
    const map = narrate(f.product, f.authenticated)
    for (const r of f.authenticated) r.narrative = map[r.message_pattern] || null
  }

  // Measured pass: re-check every signal whose fix is old enough to judge. Runs before the
  // digest is built so a verdict rides the same weekly email.
  const measured = LIVE ? await measurePass(boSecret) : []

  const digest = buildDigest(findings, WINDOW_DAYS, measured)
  console.log('\n' + digest)

  if (!LIVE) { log('DRY-RUN, nothing written, nothing emailed.'); return }

  let written = 0
  for (const f of findings) {
    if (f.error) continue
    for (const r of [...f.authenticated, ...f.anonymous]) {
      try {
        await upsertReport(boSecret, {
          p_product: f.product, p_source_table: f.table,
          p_function_name: r.function_name, p_operation: r.operation || null,
          p_message_pattern: r.message_pattern,
          p_first_seen: r.first_seen, p_last_seen: r.last_seen,
          p_occurrences: r.occurrences, p_distinct_users: r.distinct_users || 0,
          p_authenticated: Boolean(r.authenticated),
          p_sample_evidence: r.sample_evidence || {},
          p_narrative: r.narrative || null,
        })
        written++
      } catch (e) {
        log(`  upsert failed for ${f.product}/${r.function_name}: ${String(e).slice(0, 160)}`)
      }
    }
  }
  log(`  ${written} report(s) upserted to scout_reports`)

  const realCount = findings.reduce((n, f) => n + f.authenticated.length, 0)
  const failed = findings.filter((f) => f.error).length
  // Silent on a genuinely quiet week. A digest that arrives every week regardless is a
  // digest that stops being read.
  if (realCount > 0 || failed > 0 || measured.length > 0) {
    const bits = [`${realCount} user-facing finding(s)`]
    if (measured.length) bits.push(`${measured.length} measured`)
    if (failed) bits.push(`${failed} source unreadable`)
    emailDigest(`[UX SCOUT] ${bits.join(', ')}`, digest)
  } else {
    log('  quiet week, no email sent')
  }
  log('UX Scout done.')
}

// Run-as-script guard. Compared via pathToFileURL rather than string-building a file://
// URL: on Windows `import.meta.url` is file:///C:/... (three slashes) and the hand-built
// form has two, so the naive comparison silently never matches and main() never runs.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    log(`FATAL: ${String(e)}`)
    try {
      const tmp = join(STATE_DIR, 'fatal.txt')
      writeFileSync(tmp, `UX Scout run failed:\n\n${String(e)}\n${e?.stack || ''}`, 'utf-8')
      spawnSync('python', [SEND_EMAIL, '[ALERT] UX Scout run failed', tmp], { encoding: 'utf-8', timeout: 120000 })
    } catch { /* the log line above is the last resort */ }
    process.exit(1)
  })
}
