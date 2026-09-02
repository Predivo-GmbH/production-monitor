#!/usr/bin/env node
/**
 * The discovery loop behind the Cockpit's External Tools page.
 *
 * WHY IT EXISTS. A register of the outside services we depend on rots the day it is written.
 * Before this script, nothing in the fleet read the SOURCE to find out which vendors the code
 * actually talks to — so a new vendor could be wired in and never appear on any page, and a
 * cancelled one could keep charging with nothing using it. The two registers we had were both
 * hand-kept: `api_entries` was missing 20 live vendors when it was audited on 2026-08-27, and
 * `src/data/supabaseAccounts.ts` in the Cockpit is a hardcoded file behind a LAST_VERIFIED
 * constant, which is what a frozen page looks like from the inside.
 *
 * WHAT IT DOES. Once a day, for every repo in the fleet, it pulls the vendor FINGERPRINTS out
 * of four places that cannot lie about what the code calls:
 *   - `secrets.NAME`         in .github/workflows/*.yml
 *   - `Deno.env.get('NAME')` in supabase/functions/**\/*.ts
 *   - key names in .env.example        (NEVER .env — real values are not read, ever)
 *   - dependency names in package.json
 * Each is matched against `tool_fingerprints`. Matches become `tool_usage_sites` rows and
 * refresh the tool's `last_seen_in_code_at`. Non-matches become `unregistered` findings. A
 * registered, active tool with no sites for three consecutive scans becomes `orphaned`.
 *
 * WHY IT NEVER DELETES. The scan is additive: it writes sites and ages timestamps, and a tool
 * can only leave the page when a human sets `retired_at`. A scanner false-negative must never
 * be able to make a live dependency disappear from the register.
 *
 * NOISE CONTROL, because a scanner that cries wolf is ignored inside a week:
 *   1. WHOLE-TOKEN matching only — `SUPABASE_URL` must never match `VALRANO_SUPABASE_URL`
 *      into the wrong vendor.
 *   2. TWO-SCAN confirmation — a finding is only surfaced as a signal once `seen_count >= 2`,
 *      so a half-merged branch never raises an alarm.
 *   3. An IGNORE LIST — `tool_fingerprints` rows with `api_entry_id IS NULL` (CRON_SECRET,
 *      NODE_ENV, E2E_*, our own staging gate). Without it the first run reports our own
 *      scaffolding as vendors.
 *
 * Plan: Cockpit/docs/PLAN-EXTERNAL-TOOLS-PAGE-2026-08-27.md
 *
 * Contract:  node scripts/scan-external-tools.mjs [--dry] [--root <dir>]
 *   env: BOARD_SUPABASE_SECRET or BACKOFFICE_SERVICE_ROLE_KEY  (falls back to the local
 *        BackOffice Credentials.txt when run by hand)
 *        FLEET_ROOT  where the repos are checked out (default: C:\\Business\\Internal Projects)
 * Exit 0 = scanned. Exit 1 = could not scan, which is never "nothing changed".
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { homedir } from 'node:os'
import { pingUrl } from './lib/hc-ping.mjs'

// Prod by default. BO_PROJECT_REF points it at BackOffice staging so a change can be proven
// against a real database before it is promoted — the staging-first rule applies to a scanner
// exactly as it does to a page.
const BO_REF = process.env.BO_PROJECT_REF || 'xoecpzfsskalvjrtcbbl'
const BO_BASE = `https://${BO_REF}.supabase.co`
const BO_CREDS = join('C:', sep, 'Business', 'Internal Projects', 'BackOffice', 'docs', 'Credentials.txt')
const UA = 'external-tools-scan/1.0'
const SOURCE = 'external-tools-scan'
const HC_SLUG = 'external-tools-scan'
const ORPHAN_AFTER_SCANS = 3
// Below this many repos, the checkout is assumed partial and orphan detection is skipped.
// 24 repos were present when this was built; 14 leaves room for a repo being retired without
// silently disabling the check. See the block that uses it for why absence is not evidence.
const MIN_REPOS_FOR_ORPHANS = Number(process.env.MIN_REPOS_FOR_ORPHANS || 14)

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'test-results', '.turbo'])

// ── credentials ─────────────────────────────────────────────────────────────
function readBoSecret() {
  if (process.env.BOARD_SUPABASE_SECRET) return process.env.BOARD_SUPABASE_SECRET.trim()
  if (process.env.BACKOFFICE_SERVICE_ROLE_KEY) return process.env.BACKOFFICE_SERVICE_ROLE_KEY.trim()
  const txt = readFileSync(BO_CREDS, 'utf-8')
  const m = txt.match(/sb_secret_[A-Za-z0-9_]+/)
  if (!m) throw new Error(`no sb_secret_ key found in ${BO_CREDS}`)
  return m[0]
}

// ── BackOffice REST ─────────────────────────────────────────────────────────
async function boGet(secret, path) {
  const res = await fetch(`${BO_BASE}/rest/v1/${path}`, {
    headers: { apikey: secret, Authorization: `Bearer ${secret}`, 'User-Agent': UA },
  })
  if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`)
  return res.json()
}

async function boWrite(secret, path, body, { method = 'POST', prefer = 'return=minimal' } = {}) {
  const res = await fetch(`${BO_BASE}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: secret, Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json', Prefer: prefer, 'User-Agent': UA,
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.status === 204 ? null : res.json().catch(() => null)
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

// ── file walking ────────────────────────────────────────────────────────────
function* walk(dir, depth = 0) {
  if (depth > 8) return
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (e.name.startsWith('.') && !['.github', '.env.example'].includes(e.name)) continue
    if (SKIP_DIRS.has(e.name)) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) yield* walk(full, depth + 1)
    else yield full
  }
}

/**
 * Pull vendor fingerprints out of one repo. Returns [{kind, pattern, path}].
 *
 * The four sources are chosen because they are DECLARATIONS, not prose: a workflow secret, an
 * edge-function env read, an example-env key and a package dependency each mean "this code
 * talks to that vendor". Comments and docs are deliberately not scanned — they describe
 * intent, and intent is what the register is already full of.
 */
export function extractFingerprints(repoDir, readFile = (p) => readFileSync(p, 'utf-8')) {
  const out = []
  for (const file of walk(repoDir)) {
    const rel = relative(repoDir, file).split(sep).join('/')
    let text
    try {
      if (statSync(file).size > 2_000_000) continue        // a 2MB source file is generated, not written
      text = readFile(file)
    } catch { continue }

    if (rel.startsWith('.github/workflows/') && /\.ya?ml$/.test(rel)) {
      for (const m of text.matchAll(/secrets\.([A-Z0-9_]+)/g)) out.push({ kind: 'gha_secret', pattern: m[1], path: rel })
    }
    if (/\.ts$/.test(rel) && rel.includes('supabase/functions/')) {
      for (const m of text.matchAll(/Deno\.env\.get\(\s*['"]([A-Z0-9_]+)['"]/g)) out.push({ kind: 'env_var', pattern: m[1], path: rel })
    }
    if (rel.endsWith('.env.example')) {
      for (const m of text.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)) out.push({ kind: 'env_var', pattern: m[1], path: rel })
    }
    if (rel === 'package.json') {
      try {
        const pkg = JSON.parse(text)
        for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
          out.push({ kind: 'npm_package', pattern: dep, path: rel })
        }
      } catch { /* an unparseable package.json is a repo problem, not a scan problem */ }
    }
    if (/\.(ts|tsx|mjs|js)$/.test(rel)) {
      for (const m of text.matchAll(/https:\/\/([a-z0-9][a-z0-9.-]*\.[a-z]{2,})/gi)) {
        out.push({ kind: 'hostname', pattern: m[1].toLowerCase(), path: rel })
      }
    }
  }
  return out
}

/**
 * A workflow secret and an edge-function env var live in ONE namespace.
 *
 * The first run of this scanner reported ANTHROPIC_API_KEY, FIRECRAWL_API_KEY, SENTRY_ORG and a
 * dozen others as "unregistered" while they were sitting in the register the whole time —
 * because the fingerprint had been recorded as an env var and the code used it as a workflow
 * secret, or the other way round. The distinction is meaningless: the NAME identifies the
 * vendor. And a scanner that produces 289 false findings on its first run is a scanner nobody
 * ever reads again. Hostnames and npm packages keep their own namespaces, because there the
 * kind IS part of the meaning.
 */
const NAME_KINDS = new Set(['env_var', 'gha_secret'])
const nsOf = (kind) => (NAME_KINDS.has(kind) ? 'name' : kind)

/**
 * Second-chance matching for a decorated variable name.
 *
 * VITE_SENTRY_DSN, NEXT_PUBLIC_SENTRY_DSN and STAGING_SENTRY_DSN are all Sentry. Storing every
 * decoration as its own fingerprint row would mean re-teaching the register every time a repo
 * picks a different bundler. So: try the exact token first, and only on a miss, strip the known
 * FRAMEWORK and ENVIRONMENT prefixes and try once more.
 *
 * Deliberately NOT stripped: product prefixes such as VALRANO_ or REPLYFLOW_. Those name one
 * project's own credential, and collapsing them would attribute one product's usage to another.
 * A wrong attribution is worse than an unmatched token, because it looks like an answer.
 */
const DECORATIONS = /^(VITE_|NEXT_PUBLIC_|EXPO_PUBLIC_|PUBLIC_|REACT_APP_|STAGING_|PROD_|PRODUCTION_)+/
export function normalizeName(token) {
  return token.replace(DECORATIONS, '')
}

/** Build the lookup the way classify expects it. Kept beside classify so the two cannot drift. */
export function indexFingerprints(rows) {
  return new Map(rows.filter((r) => r.kind !== 'name_contains').map((r) => [`${nsOf(r.kind)}\n${r.pattern}`, r]))
}

/**
 * Third-chance matching: an unambiguous WORD inside the token.
 *
 * The fleet names one vendor's credential a dozen ways — SUPABASE_URL, REPLYFLOW_SUPABASE_URL,
 * SUPABASE_STAGING_URL, STAGING_SERVICE_ROLE_KEY, SB_URL. Enumerating every one as its own
 * fingerprint row is a losing race against the next product's naming taste. So a tool may
 * declare a `name_contains` fingerprint: a word that, when it appears as a whole underscore-
 * delimited segment of the token, identifies that vendor.
 *
 * THE SAFETY RULE, and it is the whole reason this tier is safe: if TWO tools claim the same
 * token, NOTHING is attributed and the token stays unmatched. A tie means the hint was not
 * unambiguous after all, and an unmatched token is a visible question, while a wrongly
 * attributed one is an invisible wrong answer.
 */
export function indexHints(rows) {
  const m = new Map()
  for (const r of rows.filter((x) => x.kind === 'name_contains' && x.api_entry_id)) {
    if (!m.has(r.pattern)) m.set(r.pattern, [])
    m.get(r.pattern).push(r)
  }
  return m
}

export function matchByHint(token, hints) {
  const segments = new Set(token.split('_'))
  // Collect EVERY tool any matching word points at — including two tools that both registered
  // the same word. Looking only at the first row per word would hide exactly the conflict this
  // function exists to detect.
  const claims = new Map()
  for (const [word, rows] of hints) {
    if (!segments.has(word)) continue
    for (const r of rows) if (!claims.has(r.api_entry_id)) claims.set(r.api_entry_id, r)
  }
  return claims.size === 1 ? [...claims.values()][0] : null   // a tie attributes nothing, on purpose
}

/**
 * The whole decision, pure and testable.
 *
 * `known` is a Map of "namespace\npattern" -> row (api_entry_id null = the ignore list).
 * Matching is on the WHOLE token, which is what a Map lookup gives us for free: a substring
 * rule would file VALRANO_SUPABASE_URL under the generic SUPABASE_URL fingerprint.
 */
export function classify(fingerprints, known, hints = new Map()) {
  const sites = new Map()          // "toolId|repo|path" -> {api_entry_id, repo, path, fingerprint_id}
  const unknown = new Map()        // "ns\npattern" -> {kind, pattern, paths:Set}
  for (const fp of fingerprints) {
    const ns = nsOf(fp.kind)
    // Three tiers, cheapest and most certain first: exact token, then the same token with
    // framework/environment decoration stripped, then an unambiguous word inside it.
    let entry = known.get(`${ns}\n${fp.pattern}`)
    if (!entry && ns === 'name') entry = known.get(`name\n${normalizeName(fp.pattern)}`)
    if (!entry && ns === 'name') entry = matchByHint(fp.pattern, hints)
    if (entry) {
      if (!entry.api_entry_id) continue                    // ignore list: known non-vendor
      const k = `${entry.api_entry_id}|${fp.repo}|${fp.path}`
      if (!sites.has(k)) sites.set(k, { api_entry_id: entry.api_entry_id, repo: fp.repo, path: fp.path, fingerprint_id: entry.id })
    } else {
      const key = `${ns}\n${fp.pattern}`
      if (!unknown.has(key)) unknown.set(key, { kind: fp.kind, pattern: fp.pattern, paths: new Set() })
      unknown.get(key).paths.add(`${fp.repo}/${fp.path}`)
    }
  }
  return { sites: [...sites.values()], unknown: [...unknown.values()] }
}

/**
 * A hostname we have never seen is usually a documentation link, not a vendor. Only hostnames
 * that look like an API endpoint are worth reporting; everything else would bury the real
 * findings under every MDN link in the codebase.
 */
export function isReportableHostname(host) {
  if (/^(api|app|server|cloud|dashboard)\./.test(host)) return true
  if (/\.(googleapis|supabase)\.(com|co)$/.test(host)) return false     // covered by their own rows
  return false
}

/**
 * Can this scan HONESTLY judge whether a tool is unused?
 *
 * THE 2026-08-31 FALSE ALARM, which is the whole reason this exists. The page declared Zyte,
 * Browserless and Google Search Console API dead. All three were live: Zyte and Browserless are
 * the 2nd and 3rd tiers of arivioo's scraper chain across 14 edge functions, and the GSC API is
 * pull-engine's weekly Search Console pull. What those three have in common is not disuse — it
 * is that each is used in EXACTLY ONE repo, `arivioo` or `pull-engine`, and the host that runs
 * the daily scan does not have those two repos checked out. Every other tool in the register
 * lives in a repo that host does have, so only these three could ever go quiet.
 *
 * The repo-COUNT floor could not catch it: the host clears the floor comfortably while missing
 * the two repos that mattered. A count answers "did I look at enough places", never "did I look
 * in THE place". So the test is per tool and by NAME: a tool may only be called orphaned when
 * every repo it was last seen in was actually scanned this run. If one is missing, this scan has
 * no opinion — that is not a failure, it is the honest answer, and it must be said out loud.
 *
 * `priorRepos` is the set of repos the tool's recorded usage sites sit in; `scannedRepos` is what
 * this run walked. Returns the missing repos — empty means the verdict is trustworthy.
 */
export function orphanBlockers(priorRepos, scannedRepos) {
  return [...(priorRepos || [])].filter((r) => !scannedRepos.has(r)).sort()
}

export function isReportable(fp) {
  if (fp.kind === 'hostname') return isReportableHostname(fp.pattern)
  if (fp.kind === 'npm_package') return false                          // far too many to be a signal
  // An env var or a workflow secret is a deliberate act by whoever added it. Those are worth
  // a look every time — that is exactly the "someone wired in a new vendor" case.
  return true
}

function signalForFinding(f) {
  const where = (f.evidence.paths || []).slice(0, 3).join(', ')
  return {
    source: SOURCE,
    key: `${f.kind}:${f.fingerprint}`,
    kind: 'finding',
    severity: 'warning',
    state: 'open',
    needs_human: false,
    title: f.kind === 'unregistered'
      ? `An outside service is used in the code but is not on the tools list: ${f.fingerprint}`
      : `Nothing uses ${f.fingerprint} any more`,
    summary: f.kind === 'unregistered'
      ? `Found in ${where || 'the fleet'}. Either add it to the tools list with the reason we use it, or find out who wired it in.`
      : `The tools list still says we depend on it, but ${ORPHAN_AFTER_SCANS} scans in a row found no reference to it anywhere. If it is paid for, it may be cancellable.`,
    detail: { finding_kind: f.kind, fingerprint: f.fingerprint, ...f.evidence },
    link: 'https://cockpit.predivo.ch/external-tools',
  }
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  const dry = process.argv.includes('--dry')
  const rootArg = process.argv.indexOf('--root')
  const root = rootArg > -1 ? process.argv[rootArg + 1]
    : (process.env.FLEET_ROOT || join('C:', sep, 'Business', 'Internal Projects'))

  if (!existsSync(root)) throw new Error(`fleet root not found: ${root}`)

  const secret = readBoSecret()
  const fpRows = await boGet(secret, 'tool_fingerprints?select=id,api_entry_id,kind,pattern')
  const known = indexFingerprints(fpRows)
  const hints = indexHints(fpRows)
  console.log(`fingerprints: ${fpRows.length} known (${fpRows.filter((r) => !r.api_entry_id).length} deliberately ignored)`)

  const repos = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !SKIP_DIRS.has(d.name))
    .map((d) => d.name)

  const all = []
  for (const repo of repos) {
    const found = extractFingerprints(join(root, repo)).map((f) => ({ ...f, repo }))
    all.push(...found)
  }
  console.log(`scanned ${repos.length} repo(s) under ${root} -> ${all.length} raw fingerprint hit(s)`)

  const { sites, unknown } = classify(all, known, hints)
  const reportable = unknown.filter(isReportable)
  const seenToolIds = new Set(sites.map((s) => s.api_entry_id))
  console.log(`matched ${sites.length} usage site(s) across ${seenToolIds.size} tool(s); ${reportable.length} unrecognised of ${unknown.length} unmatched`)

  if (dry) {
    for (const u of reportable.slice(0, 40)) console.log(`  UNREGISTERED ${u.kind} ${u.pattern} -> ${[...u.paths].slice(0, 2).join(', ')}`)
    console.log('--dry: nothing written.')
    return 0
  }

  const now = new Date().toISOString()

  // 1. usage sites — upsert, never delete. Absence is expressed by last_seen_at aging.
  if (sites.length) {
    await boWrite(secret, 'tool_usage_sites?on_conflict=api_entry_id,repo,path',
      sites.map((s) => ({ ...s, last_seen_at: now })),
      { prefer: 'resolution=merge-duplicates,return=minimal' })
  }

  // 2. refresh each seen tool's freshness + reference count
  for (const toolId of seenToolIds) {
    const count = sites.filter((s) => s.api_entry_id === toolId).length
    await boWrite(secret, `api_entries?id=eq.${toolId}`,
      { last_seen_in_code_at: now, code_ref_count: count }, { method: 'PATCH' })
  }

  // 3. unregistered findings — two-scan confirmation before anything is said out loud
  const existing = await boGet(secret, 'external_tool_findings?select=id,kind,fingerprint,seen_count,state')
  const byKey = new Map(existing.map((f) => [`${f.kind}:${f.fingerprint}`, f]))
  const confirmed = []

  for (const u of reportable) {
    const key = `unregistered:${u.pattern}`
    const prev = byKey.get(key)
    const evidence = { kind: u.kind, paths: [...u.paths].slice(0, 10) }
    if (!prev) {
      await boWrite(secret, 'external_tool_findings', [{ kind: 'unregistered', fingerprint: u.pattern, evidence, seen_count: 1 }])
    } else if (prev.state === 'open' || prev.state === 'confirmed') {
      const seen = prev.seen_count + 1
      await boWrite(secret, `external_tool_findings?id=eq.${prev.id}`,
        { seen_count: seen, evidence, updated_at: now, state: seen >= 2 ? 'confirmed' : 'open' }, { method: 'PATCH' })
      if (seen === 2) confirmed.push({ kind: 'unregistered', fingerprint: u.pattern, evidence })
    }
  }

  // 4. orphans — a registered, active, non-retired tool that nothing references any more.
  //
  // THE FLOOR IS THE SAFETY PROPERTY, not a tuning knob. Orphan detection reasons from ABSENCE,
  // and absence is indistinguishable from "the checkout was incomplete". A host with half the
  // fleet cloned would confidently report half the register as unused, and someone would
  // eventually cancel a live subscription on the strength of it. So: below the floor, usage
  // sites are still recorded (that only ever ADDS knowledge) and orphan detection is skipped
  // out loud.
  if (repos.length < MIN_REPOS_FOR_ORPHANS) {
    console.log(`::warning::only ${repos.length} repo(s) present (floor is ${MIN_REPOS_FOR_ORPHANS}) — usage recorded, orphan detection SKIPPED. A partial checkout cannot tell "unused" from "not checked out".`)
  } else {
  const tools = await boGet(secret, 'api_entries?select=id,name,status,retired_at,code_ref_count,last_seen_in_code_at&status=eq.active&retired_at=is.null')

  // Where each tool was LAST SEEN. The count floor above asks "enough repos?"; this asks the
  // only question that decides an absence claim — "was THIS tool's repo among them?".
  const priorSites = await boGet(secret, 'tool_usage_sites?select=api_entry_id,repo')
  const priorReposByTool = new Map()
  for (const s of priorSites) {
    if (!priorReposByTool.has(s.api_entry_id)) priorReposByTool.set(s.api_entry_id, new Set())
    priorReposByTool.get(s.api_entry_id).add(s.repo)
  }
  const scannedRepos = new Set(repos)

  for (const t of tools) {
    if (seenToolIds.has(t.id)) continue
    // Never scanned yet is not the same as unused. Only a tool that HAS been seen before and
    // has now gone quiet can be an orphan; otherwise the first run would declare half the
    // register dead.
    if (!t.last_seen_in_code_at) continue
    // Nor is "gone from the repos I happen to have" the same as unused.
    const missing = orphanBlockers(priorReposByTool.get(t.id), scannedRepos)
    if (missing.length) {
      console.log(`::warning::cannot judge ${t.name}: last seen in ${missing.join(', ')}, which this checkout does not have — no orphan verdict (a missing repo is not an unused tool)`)
      continue
    }
    const key = `orphaned:${t.name}`
    const prev = byKey.get(key)
    if (!prev) {
      await boWrite(secret, 'external_tool_findings', [{ kind: 'orphaned', fingerprint: t.name, api_entry_id: t.id, evidence: { last_seen_in_code_at: t.last_seen_in_code_at }, seen_count: 1 }])
    } else if (prev.state === 'open' || prev.state === 'confirmed') {
      const seen = prev.seen_count + 1
      await boWrite(secret, `external_tool_findings?id=eq.${prev.id}`,
        { seen_count: seen, updated_at: now, state: seen >= ORPHAN_AFTER_SCANS ? 'confirmed' : 'open' }, { method: 'PATCH' })
      if (seen === ORPHAN_AFTER_SCANS) confirmed.push({ kind: 'orphaned', fingerprint: t.name, evidence: { tool: t.name } })
    }
  }
  }

  // 5. one signal per newly-confirmed finding, through the SAME intake everything else uses.
  //    No second alert channel, no email: /signals is the one board.
  for (const f of confirmed) await fileSignal(secret, signalForFinding(f))
  console.log(`findings: ${confirmed.length} newly confirmed and filed as signals`)

  const hc = pingUrl(HC_SLUG)
  if (hc) await fetch(hc, { method: 'POST', headers: { 'User-Agent': UA } }).catch(() => {})
  return 0
}

// Only run when invoked directly, so the pure functions above stay unit-testable.
if (process.argv[1] && process.argv[1].endsWith('scan-external-tools.mjs')) {
  main().then((c) => process.exit(c)).catch(async (e) => {
    console.error(`::error::external-tools scan failed: ${e.message}`)
    const hc = pingUrl(HC_SLUG)
    if (hc) await fetch(`${hc}/fail`, { method: 'POST', headers: { 'User-Agent': UA } }).catch(() => {})
    process.exit(1)
  })
}
