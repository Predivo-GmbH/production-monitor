/**
 * IS THE CODE WE COMMITTED ACTUALLY THE CODE THAT IS RUNNING?
 *
 * WHY THIS EXISTS. On 2026-09-01 the largest error on the monitoring board — BackOffice's
 * Smartlead failure, 51 events and still climbing — turned out to have been FIXED on 2026-08-29.
 * The fix was on `main`, reviewed, tested and green. Production was still serving the build from
 * 2026-08-20, because BackOffice CI applies migrations but does not deploy edge functions, so
 * every function ships by an explicit dispatch and that step was simply never taken. Nothing was
 * blocking it. Nobody had done it, and nothing anywhere said so. Nine days.
 *
 * Distribution-OS is the same shape and worse: it has NO edge-function deploy in CI at all, so a
 * committed change can only reach production if a human remembers to run the CLI.
 *
 * All 21 checks in this repo were enumerated on 2026-09-02 before this one was written. The two
 * closest are `check-drift` (database schema and cron drift between staging and prod) and
 * `check-pipeline-drift` (whether each deploy.yml still conforms to the deploy standard). Neither
 * answers this question. Nothing did.
 *
 * ── What it compares ─────────────────────────────────────────────────────────────────────
 * For each edge function: the time of the newest PUSHED commit touching that function's own
 * directory or `supabase/functions/_shared`, against the `updated_at` the Supabase Management API
 * reports for the live production function.
 *
 * Shared modules count, and that is the point rather than an over-reach: a change to a shared
 * module only reaches a function when THAT function is redeployed. BackOffice's fix lived in
 * `_shared/outreach.ts` plus a new `_shared/smartlead-plan.ts`, and every function importing them
 * kept running the old copy.
 *
 * But only the shared files a function ACTUALLY IMPORTS count, resolved transitively from its
 * `index.ts`. The first version of this check folded the whole `_shared` directory into every
 * function and reported "49 of BackOffice's 55 functions are behind" — true in the trivial sense
 * that someone had touched some shared file, useless as a signal, and exactly the kind of number
 * that teaches a person to stop reading a check. `send-invoice` does not import the Smartlead
 * classifier and is not stale because that classifier changed.
 *
 * ── Three findings, deliberately distinct ────────────────────────────────────────────────
 *   STALE          committed after the deploy -> the running code is not the code we have.
 *   NEVER_DEPLOYED in the repo, absent from production -> it has never run anywhere real.
 *   ORPHAN         live in production, absent from the repo -> running code nobody can read.
 *
 * ── Why a grace window ───────────────────────────────────────────────────────────────────
 * A deploy takes minutes, so a commit is legitimately newer than its deployment for a while. The
 * window is a floor, not a judgement: below it we say nothing, above it the fact is real. Set
 * generously, because this watches a nine-day failure, not a nine-minute one.
 *
 * ── Coverage, and why a missing repo is not silence ──────────────────────────────────────
 * `lib/edge-code-baseline.json` lists every repo that has `supabase/functions/`. A repo with no
 * established production ref is reported as UNPROVEN, never skipped. That rule is copied from
 * check-supabase-build-currency, which on 2026-08-30 printed "21 projects checked, 0 behind"
 * while a product nobody could see went unwatched — absent read as fine.
 *
 * Contract:  node scripts/check-edge-code-live.mjs [--dry] [--json]
 *   env: any SUPABASE_TOKEN_* / *_SUPABASE_ACCESS_TOKEN  to read the live functions.
 *        BOARD_SUPABASE_SECRET or BACKOFFICE_SERVICE_ROLE_KEY  to file the signal.
 *        FLEET_ROOT  optional, defaults to C:/Business/Internal Projects.
 *        EDGE_STALE_GRACE_HOURS  optional, defaults to 6.
 * Exit 0 = judged (a filed alarm still exits 0 — the board is the alert, per fleet-signal.mjs).
 * Exit 1 = could not tell, which is never "fine".
 */
import { readFileSync, existsSync, mkdtempSync } from 'fs'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { tmpdir } from 'os'

import { boardSecret, fileSignal, signal } from './lib/fleet-signal.mjs'
import { findTokenForProject } from './lib/supabase-token.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FLEET_ROOT = process.env.FLEET_ROOT || 'C:/Business/Internal Projects'
const ALARM_KEY = 'edge-code-not-live'
const DEFAULT_GRACE_HOURS = 6
// Scratch space for CI-mode clones. One per process, removed by the runner, never by us.
const WORKDIR = process.env.EDGE_CHECK_WORKDIR || mkdtempSync(join(tmpdir(), 'edge-code-'))

// ── The pure core. Everything below the line is I/O; everything here is testable. ─────────

export const HOUR_MS = 3600_000

/**
 * Decide what is wrong, given two inventories of the same repo.
 *
 * @param committed  Map slug -> ISO string of the newest pushed commit touching it (or _shared)
 * @param deployed   Map slug -> ISO string the Management API reports as updated_at
 * @param graceMs    how far a commit may lead its deployment before we call it stale
 * @returns { stale, neverDeployed, orphan } — each an array, each sorted worst-first
 */
export function compareInventories(committed, deployed, graceMs) {
  const stale = []
  const neverDeployed = []
  const orphan = []

  for (const [slug, committedAt] of committed) {
    const deployedAt = deployed.get(slug)
    if (deployedAt === undefined) {
      neverDeployed.push({ slug, committedAt })
      continue
    }
    // Number(new Date(x)) is NaN for an unparseable timestamp. NaN comparisons are always
    // false, so a bad timestamp would silently read as "not stale" — the reassuring direction.
    // Refuse it instead: a value we cannot compare is unknown, and unknown is never fine.
    const c = Date.parse(committedAt)
    const d = Date.parse(deployedAt)
    if (Number.isNaN(c) || Number.isNaN(d)) {
      stale.push({ slug, committedAt, deployedAt, behindMs: null, unparseable: true })
      continue
    }
    const behindMs = c - d
    if (behindMs > graceMs) stale.push({ slug, committedAt, deployedAt, behindMs })
  }

  for (const slug of deployed.keys()) {
    if (!committed.has(slug)) orphan.push({ slug, deployedAt: deployed.get(slug) })
  }

  // Worst first: the longest-stranded fix is the one that has been wrong for longest.
  stale.sort((a, b) => (b.behindMs ?? Infinity) - (a.behindMs ?? Infinity))
  neverDeployed.sort((a, b) => a.slug.localeCompare(b.slug))
  orphan.sort((a, b) => a.slug.localeCompare(b.slug))
  return { stale, neverDeployed, orphan }
}

/** Human-readable age, so a board row reads as "9 days" rather than 786240000. */
export function describeBehind(ms) {
  if (ms === null || ms === undefined) return 'unknown'
  const h = ms / HOUR_MS
  if (h < 48) return `${Math.floor(h)}h`
  return `${Math.floor(h / 24)}d`
}

/**
 * The one sentence Roger reads. Leads with the worst product and the worst age, because a board
 * row that says "3 products affected" tells him nothing about whether to care.
 */
export function summarise(findings) {
  const stale = findings.flatMap((f) => f.stale.map((s) => ({ ...s, repo: f.repo })))
  const never = findings.flatMap((f) => f.neverDeployed.map((s) => ({ ...s, repo: f.repo })))
  if (!stale.length && !never.length) return null
  const worst = stale[0]
  const parts = []
  if (worst) {
    parts.push(`${worst.repo}'s ${worst.slug} has been fixed in our code for ${describeBehind(worst.behindMs)} and production is still running the old version`)
  }
  if (never.length) {
    parts.push(`${never.length} function(s) exist in our code and have never been deployed at all (${never.slice(0, 3).map((n) => `${n.repo}/${n.slug}`).join(', ')}${never.length > 3 ? ', …' : ''})`)
  }
  if (stale.length > 1) parts.push(`${stale.length} functions are behind in total`)
  return parts.join('. ') + '.'
}

// ── I/O ──────────────────────────────────────────────────────────────────────────────────

export function loadBaseline(path = join(HERE, 'lib', 'edge-code-baseline.json')) {
  return JSON.parse(readFileSync(path, 'utf-8')).repos
}

/**
 * Every relative import in a Deno edge module, as written.
 *
 * Deno requires the extension, so specifiers are literal paths and no module resolution is
 * needed. Bare specifiers (`npm:`, `https:`, `jsr:`) are someone else's code and cannot make our
 * deployment stale, so they are ignored on purpose.
 */
export function relativeImports(source) {
  const out = new Set()
  const patterns = [
    /\bfrom\s*['"](\.[^'"]+)['"]/g,            // import x from './y.ts'
    /\bimport\s*['"](\.[^'"]+)['"]/g,          // import './y.ts'
    /\bimport\s*\(\s*['"](\.[^'"]+)['"]/g,     // await import('./y.ts')
  ]
  for (const re of patterns) for (const m of source.matchAll(re)) out.add(m[1])
  return [...out]
}

/** POSIX path resolve — git paths are always forward-slashed, on every platform. */
export function resolvePosix(fromFile, spec) {
  const parts = fromFile.split('/').slice(0, -1).concat(spec.split('/'))
  const stack = []
  for (const p of parts) {
    if (p === '.' || p === '') continue
    if (p === '..') stack.pop()
    else stack.push(p)
  }
  return stack.join('/')
}

/**
 * The files a function is actually built from: its own entry point plus every shared module it
 * transitively imports. `readFile(path)` returns the content at the deployable branch, or null.
 */
export function dependencyFiles(slug, readFile) {
  const seen = new Set()
  const queue = [`supabase/functions/${slug}/index.ts`]
  while (queue.length) {
    const path = queue.shift()
    if (seen.has(path)) continue
    const src = readFile(path)
    if (src === null || src === undefined) continue
    seen.add(path)
    for (const spec of relativeImports(src)) {
      const resolved = resolvePosix(path, spec)
      if (resolved.startsWith('supabase/functions/')) queue.push(resolved)
    }
  }
  return [...seen]
}

/** Pure parser for a `git log --format=%x01%cI --name-only` stream. Newest commit comes first. */
export function parseCommitTimes(raw) {
  const map = new Map()
  let current = null
  for (const line of raw.split('\n')) {
    if (line.startsWith('\x01')) { current = line.slice(1).trim(); continue }
    const path = line.trim()
    if (!path || !current) continue
    if (!map.has(path)) map.set(path, current) // first sighting = newest; the log is newest-first
  }
  return map
}

/** file path -> ISO time of the newest commit touching it, in ONE git pass. */
export function fileCommitTimes(repoDir, branch, execer = execFileSync) {
  const raw = execer('git', ['log', '--format=%x01%cI', '--name-only', branch, '--', 'supabase/functions'],
    { cwd: repoDir, encoding: 'utf-8', maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).toString()
  return parseCommitTimes(raw)
}

/**
 * Newest pushed commit per function, over exactly the files that function is built from.
 *
 * One `git log --name-only` pass builds file -> newest-commit-time for the whole functions tree,
 * so each function's answer is a lookup rather than a git call of its own.
 */
export function committedFunctions(repoDir, branch, execer = execFileSync) {
  const git = (args) => execer('git', args, { cwd: repoDir, encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()
  // ls-tree against the REMOTE branch, not the working copy: an uncommitted directory is not
  // something anyone can deploy, and neither is a local-only branch.
  const entries = git(['ls-tree', '--name-only', `${branch}:supabase/functions`]).split('\n')
  const slugs = entries.map((e) => e.replace(/\/$/, '')).filter((e) => e && !e.startsWith('_') && !e.includes('.'))

  const mtime = fileCommitTimes(repoDir, branch, execer)
  const cache = new Map()
  const readFile = (path) => {
    if (!cache.has(path)) {
      try { cache.set(path, git(['show', `${branch}:${path}`])) } catch { cache.set(path, null) }
    }
    return cache.get(path)
  }

  const out = new Map()
  for (const slug of slugs) {
    let newest = null
    for (const f of dependencyFiles(slug, readFile)) {
      const t = mtime.get(f)
      if (t && (newest === null || t > newest)) newest = t
    }
    // If the entry point could not be read, fall back to the directory. A function whose
    // index.ts is missing is odd, but silence would be worse than an imprecise timestamp.
    if (!newest) newest = git(['log', '-1', '--format=%cI', branch, '--', `supabase/functions/${slug}`]) || null
    if (newest) out.set(slug, newest)
  }
  return out
}

export async function deployedFunctions(projectRef, token) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/functions`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`functions list -> HTTP ${res.status}`)
  const list = await res.json()
  return new Map(list.map((f) => [f.slug, new Date(f.updated_at).toISOString()]))
}

/**
 * Where a repo is read from.
 *
 * LOCAL — the fleet checkout, when this runs on a machine that has one (FLEET_ROOT).
 * CI    — a blobless clone into a scratch dir. `--filter=blob:none` keeps the FULL commit history
 *         and all trees, which is everything `git log --name-only` needs, and fetches file
 *         contents only for the few hundred files the import graph actually walks.
 *
 * A shallow clone would be wrong here and quietly so: this check reads commit dates months back,
 * and `--depth` would make every older file look like it had no history — i.e. not stale. The
 * reassuring direction again.
 *
 * It clones over HTTPS with git rather than reading the REST API on purpose. The per-file commit
 * lookup that would replace it costs roughly one call per file per repo per hour, against an
 * allowance that is a single shared pool and already has its own watchdog
 * (check-github-api-budget.mjs, written after that pool was measured at 102 requests/minute).
 */
export function repoSource(entry, { root, workdir, token, owner = 'Predivo-GmbH' }, deps = {}) {
  const exists = deps.exists ?? existsSync
  const exec = deps.exec ?? execFileSync
  const local = join(root, entry.repo)
  if (exists(join(local, '.git'))) return { dir: local, mode: 'local' }
  if (!token) return { dir: null, mode: 'unavailable', why: 'no local checkout and no GH_TOKEN to clone with' }

  const dir = join(workdir, entry.repo)
  if (!exists(join(dir, '.git'))) {
    // The token goes in the URL because that is the only place git accepts it for a one-shot
    // clone. It never reaches a log line: git prints the remote without credentials, and every
    // error below is re-thrown with the URL replaced.
    const url = `https://x-access-token:${token}@github.com/${owner}/${entry.repo}.git`
    try {
      exec('git', ['clone', '--filter=blob:none', '--no-checkout', '--quiet', url, dir],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      throw new Error(`clone failed: ${String(e.message).split(token).join('***')}`)
    }
  }
  return { dir, mode: 'clone' }
}

async function main() {
  const dry = process.argv.includes('--dry')
  const graceMs = Number(process.env.EDGE_STALE_GRACE_HOURS || DEFAULT_GRACE_HOURS) * HOUR_MS
  const baseline = loadBaseline()

  const findings = []
  const unproven = []
  const unreadable = []

  for (const entry of baseline) {
    if (!entry.prod) { unproven.push(entry.repo); continue }
    let repoDir
    try {
      const src = repoSource(entry, { root: FLEET_ROOT, workdir: WORKDIR, token: process.env.GH_TOKEN })
      if (!src.dir) { unreadable.push(`${entry.repo} (${src.why})`); continue }
      repoDir = src.dir
    } catch (e) { unreadable.push(`${entry.repo} (${e.message})`); continue }
    try {
      const token = await findTokenForProject(entry.prod)
      if (!token) { unreadable.push(`${entry.repo} (no token can see ${entry.prod})`); continue }
      const committed = committedFunctions(repoDir, entry.branch)
      const deployed = await deployedFunctions(entry.prod, token.token ?? token)
      const cmp = compareInventories(committed, deployed, graceMs)
      findings.push({ repo: entry.repo, ...cmp })
      console.log(`  ${entry.repo}: ${committed.size} in code, ${deployed.size} live — ` +
        `${cmp.stale.length} behind, ${cmp.neverDeployed.length} never deployed, ${cmp.orphan.length} orphan`)
      for (const s of cmp.stale) {
        console.log(`     BEHIND ${s.slug}: committed ${s.committedAt}, deployed ${s.deployedAt} (${describeBehind(s.behindMs)} behind)`)
      }
      for (const n of cmp.neverDeployed) console.log(`     NEVER DEPLOYED ${n.slug}`)
    } catch (e) {
      unreadable.push(`${entry.repo} (${e.message})`)
    }
  }

  if (unproven.length) console.log(`  UNPROVEN coverage (no production ref established): ${unproven.join(', ')}`)
  if (unreadable.length) console.log(`  COULD NOT READ: ${unreadable.join('; ')}`)

  // A read that failed is not a clean bill of health. Say so, loudly, and exit non-zero —
  // the same rule the rest of this repo follows.
  if (unreadable.length && !findings.length) {
    console.error(`::error::edge-code currency could not be established for any product`)
    return 1
  }

  const summary = summarise(findings)
  if (!summary) {
    console.log(`  OK  every deployed edge function is at or ahead of its committed code ` +
      `(${findings.length} product(s) checked, grace ${graceMs / HOUR_MS}h)`)
    return 0
  }

  console.error(`::warning::${summary}`)
  if (dry) { console.log('  --dry: not filing'); return 0 }

  await fileSignal(boardSecret(), signal({
    key: ALARM_KEY,
    product: findings.find((f) => f.stale.length)?.repo ?? 'fleet',
    severity: 'warning',
    // A fix sitting undeployed is a board row, not a phone call: nothing is on fire, something
    // is merely not switched on. It becomes urgent only via the error it was meant to stop,
    // which has its own alarm.
    needsHuman: false,
    title: 'A fix exists in our code but production is still running the old version',
    summary,
    detail: {
      grace_hours: graceMs / HOUR_MS,
      checked_at: new Date().toISOString(),
      products_checked: findings.map((f) => f.repo),
      unproven_coverage: unproven,
      unreadable,
      stale: findings.flatMap((f) => f.stale.map((s) => ({ repo: f.repo, ...s, behind: describeBehind(s.behindMs) }))),
      never_deployed: findings.flatMap((f) => f.neverDeployed.map((n) => ({ repo: f.repo, ...n }))),
      orphan: findings.flatMap((f) => f.orphan.map((o) => ({ repo: f.repo, ...o }))),
    },
  }))
  return 0
}

// Set exitCode rather than process.exit(): on Windows, exiting while an undici handle is still
// closing aborts the process and reports 127, and an alarm with an ambiguous exit status is the
// exact failure class this repo exists to catch.
if (import.meta.url === (await import('url')).pathToFileURL(process.argv[1] || '').href) {
  main().then(
    (code) => { process.exitCode = code },
    (e) => {
      console.error(`::error::edge-code currency check could NOT run (${e.message}). This is unknown, not fine.`)
      process.exitCode = 1
    },
  )
}
