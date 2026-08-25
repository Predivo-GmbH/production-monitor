#!/usr/bin/env node
/**
 * prod-deploy-guard.mjs — the ONLY permitted path for Board Drainer fix agents to deploy a
 * Supabase edge function to PROD (Roger-approved guardrails, 2026-08-20).
 *
 * Guardrails, in order — any failure aborts non-zero with a clear reason:
 *   1. ALLOWLIST (hard-coded below; monitoring/ops layer only — product functions are NEVER allowed)
 *   2. DAILY CAP: max 2 real deploys per UTC day (state: C:/Business/_board-drainer/prod-deploys.json)
 *   3. REPO: must be a git repo, supabase/functions/<name> clean, origin in sync (HEAD == remote HEAD)
 *   4. CI GATE: if the repo has GitHub Actions workflows, latest run on the branch must be green;
 *      no workflows -> "no CI — proceeding on probe-verification only"
 *   5. DEPLOY: supabase functions deploy <name> --project-ref <ref> --use-api
 *      (caller sets SUPABASE_ACCESS_TOKEN; this script never reads secrets itself)
 *   6. PROBE (mandatory): up to 3 tries 15s apart; HTTP < 400 AND body contains --probe-expect.
 *      Probe failure -> AUTO-ROLLBACK (deploy HEAD~1 version, restore working tree) -> exit 2.
 *   7. RECEIPT EMAIL on every real deploy attempt (deployed | rolled-back | failed).
 *   8. State update: only REAL deploys count against the cap (deployed AND rolled-back both burned
 *      real prod deploys; refused/errored-before-deploy attempts do not count).
 *
 * Usage:
 *   node scripts/prod-deploy-guard.mjs --project <ref> --function <name> --repo <abs repo path>
 *     --probe-url <url> [--probe-expect <substring>] [--probe-header "Name: value"]
 *     [--probe-method GET|POST] [--note "<what+why>"] [--dry-run]
 *
 * Exit codes: 0 = deployed (or dry-run OK) · 2 = rolled back · 1 = refused / error.
 * --dry-run runs steps 1-4 and prints what it WOULD do (no deploy, no probe, no email).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs'
import { execFileSync, spawnSync } from 'child_process'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { pathToFileURL } from 'url'

// ── config ─────────────────────────────────────────────────────────────────────
// THE allowlist — monitoring/ops functions only. Product functions (auth, payments, email,
// connect-platform, process-queue, …) are NEVER allowed here, by design. Extend deliberately.
const ALLOWLIST = {
  dqmhsdzldkxngwjrxois: { label: 'ReplyFlow PROD', functions: ['monitor-sync-health'] },
  xoecpzfsskalvjrtcbbl: { label: 'BackOffice PROD', functions: ['monitoring-board', 'health-monitor'] },
}

const DAILY_CAP = 2
const STATE_FILE = process.env.PROD_DEPLOYS_STATE || 'C:/Business/_board-drainer/prod-deploys.json'
const SEND_EMAIL = join(homedir(), '.claude', 'scripts', 'send_report_email.py')
const PROBE_TRIES = 3
const PROBE_GAP_MS = 15_000

function log(msg) { console.log(`[prod-deploy-guard ${new Date().toISOString()}] ${msg}`) }
function fail(reason) { log(`REFUSED/ERROR: ${reason}`); process.exit(1) }

// ── args ───────────────────────────────────────────────────────────────────────
const USAGE = `Usage: node scripts/prod-deploy-guard.mjs --project <ref> --function <name> --repo <abs repo path> --probe-url <url> [--probe-expect <substring>] [--probe-header "Name: value"] [--probe-method GET|POST] [--note "<what+why>"] [--dry-run]`

function parseArgs(argv) {
  const a = { probeHeaders: [], dryRun: false, probeMethod: 'GET' }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    if (k === '--dry-run') { a.dryRun = true; continue }
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) return { error: `missing value for ${k}\n${USAGE}` }
    i++
    switch (k) {
      case '--project': a.project = v; break
      case '--function': a.function = v; break
      case '--repo': a.repo = v; break
      case '--probe-url': a.probeUrl = v; break
      case '--probe-expect': a.probeExpect = v; break
      case '--probe-header': a.probeHeaders.push(v); break
      case '--probe-method': a.probeMethod = v.toUpperCase(); break
      case '--note': a.note = v; break
      default: return { error: `unknown flag ${k}\n${USAGE}` }
    }
  }
  for (const req of ['project', 'function', 'repo', 'probeUrl']) {
    if (!a[req]) return { error: `missing required --${req.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}\n${USAGE}` }
  }
  if (!['GET', 'POST'].includes(a.probeMethod)) return { error: `--probe-method must be GET or POST\n${USAGE}` }
  for (const h of a.probeHeaders) {
    if (!/^[^:]+:\s*.+$/.test(h)) return { error: `bad --probe-header "${h}" (want "Name: value")\n${USAGE}` }
  }
  if (!/^https?:\/\//.test(a.probeUrl)) return { error: `--probe-url must be http(s)\n${USAGE}` }
  return { args: a }
}

// ── 1. allowlist ───────────────────────────────────────────────────────────────
function allowlistMessage() {
  return Object.entries(ALLOWLIST)
    .map(([ref, p]) => `  ${ref} (${p.label}): ${p.functions.join(', ')}`).join('\n')
}
function checkAllowlist(project, fn) {
  const p = ALLOWLIST[project]
  if (!p) return { ok: false, reason: `project ref "${project}" is not allowlisted` }
  if (!p.functions.includes(fn)) return { ok: false, reason: `function "${fn}" is not allowlisted on ${p.label}` }
  return { ok: true, label: p.label }
}

// ── 2. daily cap ───────────────────────────────────────────────────────────────
const todayKey = () => new Date().toISOString().slice(0, 10) // UTC day
function loadCapState(file = STATE_FILE) {
  try { return JSON.parse(readFileSync(file, 'utf-8')) } catch { return {} }
}
function saveCapState(state, file = STATE_FILE) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    // prune old day keys so the file stays a one-liner
    const pruned = { [todayKey()]: state[todayKey()] || 0 }
    writeFileSync(file, JSON.stringify(pruned, null, 2) + '\n')
  } catch (e) { log(`WARNING: could not write cap state ${file}: ${e.message}`) }
}

// ── 3. repo checks ─────────────────────────────────────────────────────────────
function git(repo, args) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf-8' })
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || r.stdout || '').trim().slice(0, 300)}`)
  return (r.stdout || '').trim()
}
function checkRepo(repo, fn) {
  try { git(repo, ['rev-parse', '--is-inside-work-tree']) } catch { fail(`--repo ${repo} is not a git repository`) }
  const fnDir = `supabase/functions/${fn}`
  if (!existsSync(join(repo, fnDir))) fail(`${fnDir} does not exist in ${repo}`)
  const dirty = git(repo, ['status', '--porcelain', '--', fnDir])
  if (dirty) fail(`uncommitted changes in ${fnDir} — commit first, the deploy must be exactly what's committed:\n${dirty}`)
  const branch = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (branch === 'HEAD') fail('detached HEAD — refusing to deploy')
  log(`fetching origin/${branch} to confirm sync...`)
  git(repo, ['fetch', 'origin', branch])
  const local = git(repo, ['rev-parse', 'HEAD'])
  const remote = git(repo, ['rev-parse', `origin/${branch}`])
  if (local !== remote) fail(`local HEAD (${local.slice(0, 8)}) != origin/${branch} (${remote.slice(0, 8)}) — push/pull first; prod must run exactly the committed code`)
  log(`repo OK: ${repo} @ ${branch} ${local.slice(0, 8)} (in sync with origin)`)
  return { branch, commit: local }
}

// ── 4. CI gate ─────────────────────────────────────────────────────────────────
function checkCi(repo, branch) {
  let workflows = []
  try {
    workflows = readdirSync(join(repo, '.github', 'workflows')).filter((f) => /\.(ya?ml)$/.test(f))
  } catch { /* no workflows dir */ }
  if (workflows.length === 0) {
    log('no CI — proceeding on probe-verification only (repo has no GitHub Actions workflows)')
    return { ciRun: 'none (no workflows)' }
  }
  const origin = git(repo, ['remote', 'get-url', 'origin'])
  const m = origin.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/)
  if (!m) fail(`repo has ${workflows.length} workflow(s) but origin is not a GitHub remote — cannot verify CI, refusing`)
  const slug = m[1]
  const r = spawnSync('gh', ['run', 'list', '--repo', slug, '--branch', branch, '--limit', '1', '--json', 'conclusion,status,url,displayTitle'], { encoding: 'utf-8' })
  if (r.status !== 0) fail(`gh run list failed for ${slug}: ${(r.stderr || '').trim().slice(0, 300)}`)
  const runs = JSON.parse(r.stdout || '[]')
  if (runs.length === 0) fail(`repo has workflows but no runs on ${branch} yet — cannot verify CI green, refusing`)
  const run = runs[0]
  if (run.conclusion !== 'success') fail(`latest CI run on ${branch} is ${run.status}/${run.conclusion} (${run.url}) — refusing to deploy on red CI`)
  log(`CI gate OK: latest run on ${slug}@${branch} green — ${run.url}`)
  return { ciRun: run.url }
}

// ── 4b. verify_jwt declaration gate (added 2026-08-20) ─────────────────────────
/**
 * REFUSE to deploy a function whose LIVE verify_jwt is not declared in its repo's
 * config.toml. This closes a whole class of silent production breaks.
 *
 * `supabase functions deploy` applies config.toml and defaults anything UNDECLARED to
 * verify_jwt = true. A fleet audit on 2026-08-20 found 35 functions across 4 repos running
 * false in production with nothing declaring it. Deploying any of them would have made them
 * 401: Stripe webhooks stop applying payment events, auth-email hooks stop letting anyone log
 * in, public endpoints go dark. ChannelMover alone had 32 such functions, and its CI only got
 * away with it by passing --no-verify-jwt, a flag THIS script does not pass.
 *
 * That matters most here, because this is the AUTONOMOUS path: board-drainer.mjs hands this
 * script to fix agents. An agent must never be able to break a product as a side effect of
 * deploying an unrelated fix.
 *
 * Fails CLOSED: if live state cannot be read, or the value is undeclared, or the declaration
 * disagrees with live, the deploy is refused with the exact line to add.
 */
export function verifyJwtGateDecision(liveValue, declaredValue) {
  if (liveValue === undefined || liveValue === null) {
    return { ok: false, reason: 'could not read live verify_jwt for this function (failing closed)' }
  }
  if (declaredValue === undefined) {
    return {
      ok: false,
      reason: `live verify_jwt=${liveValue} but the function is NOT declared in supabase/config.toml. `
        + `Deploying would default it to true and could silently break it. Add:
`
        + `  [functions.<name>]
  verify_jwt = ${liveValue}`,
    }
  }
  if (declaredValue !== liveValue) {
    return {
      ok: false,
      reason: `config.toml says verify_jwt=${declaredValue} but PRODUCTION is ${liveValue}. `
        + `The repo disagrees with live; reconcile deliberately before deploying.`,
    }
  }
  return { ok: true, reason: `verify_jwt=${liveValue}, declared and matching` }
}

/** Parse [functions.X] verify_jwt out of a repo's supabase/config.toml. */
export function declaredVerifyJwt(configToml, fn) {
  if (!configToml) return undefined
  for (const m of configToml.matchAll(/\[functions\.([A-Za-z0-9_-]+)\]([^\[]*)/g)) {
    if (m[1] !== fn) continue
    const v = /verify_jwt\s*=\s*(true|false)/.exec(m[2])
    if (v) return v[1] === 'true'
  }
  return undefined
}

async function checkVerifyJwt(repo, fn, ref) {
  const token = process.env.SUPABASE_ACCESS_TOKEN
  if (!token) fail('SUPABASE_ACCESS_TOKEN not set — cannot read live verify_jwt, refusing (fail closed)')
  let live
  try {
    const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/functions`, {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'prod-deploy-guard' },
    })
    if (!res.ok) fail(`could not list functions on ${ref} (HTTP ${res.status}) — refusing (fail closed)`)
    const found = (await res.json()).find((x) => x.slug === fn)
    live = found ? Boolean(found.verify_jwt) : undefined
    if (found === undefined) {
      // A brand-new function has no live row yet; config.toml is then the only authority.
      const declaredNew = declaredVerifyJwt(readCfg(repo), fn)
      if (declaredNew === undefined) fail(`${fn} is not deployed yet AND not declared in config.toml — declare it before the first deploy`)
      log(`verify_jwt gate OK: ${fn} not yet deployed, config.toml declares ${declaredNew}`)
      return
    }
  } catch (e) {
    fail(`verify_jwt pre-read failed (${String(e).slice(0, 120)}) — refusing (fail closed)`)
  }
  const d = verifyJwtGateDecision(live, declaredVerifyJwt(readCfg(repo), fn))
  if (!d.ok) fail(`verify_jwt gate: ${d.reason}`)
  log(`verify_jwt gate OK: ${d.reason}`)
}

function readCfg(repo) {
  const p = `${repo}/supabase/config.toml`
  return existsSync(p) ? readFileSync(p, 'utf-8') : ''
}

// ── 5. deploy ──────────────────────────────────────────────────────────────────
function deploy(repo, fn, ref) {
  const r = spawnSync('supabase', ['functions', 'deploy', fn, '--project-ref', ref, '--use-api'], {
    cwd: repo, encoding: 'utf-8', shell: true, env: process.env,
  })
  const out = `${r.stdout || ''}\n${r.stderr || ''}`.trim()
  return { ok: r.status === 0, out }
}

// ── 6. probe ───────────────────────────────────────────────────────────────────
async function probeOnce(a) {
  const headers = {}
  for (const h of a.probeHeaders) {
    const idx = h.indexOf(':')
    headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim()
  }
  try {
    const res = await fetch(a.probeUrl, { method: a.probeMethod, headers })
    const body = await res.text()
    if (res.status >= 400) return { ok: false, detail: `HTTP ${res.status}: ${body.slice(0, 200)}` }
    if (a.probeExpect && !body.includes(a.probeExpect)) {
      return { ok: false, detail: `HTTP ${res.status} but body missing "${a.probeExpect}": ${body.slice(0, 200)}` }
    }
    return { ok: true, detail: `HTTP ${res.status}${a.probeExpect ? `, body contains "${a.probeExpect}"` : ''}` }
  } catch (e) {
    return { ok: false, detail: `fetch error: ${e.message}` }
  }
}
async function probe(a) {
  const evid = []
  for (let i = 1; i <= PROBE_TRIES; i++) {
    const r = await probeOnce(a)
    evid.push(`try ${i}: ${r.detail}`)
    log(`probe try ${i}/${PROBE_TRIES}: ${r.detail}`)
    if (r.ok) return { ok: true, evidence: evid }
    if (i < PROBE_TRIES) await new Promise((res) => setTimeout(res, PROBE_GAP_MS))
  }
  return { ok: false, evidence: evid }
}

// ── 7. receipt email ───────────────────────────────────────────────────────────
function sendReceipt(subject, body) {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true })
    const bodyFile = join(dirname(STATE_FILE), `prod-deploy-receipt-${Date.now()}.txt`)
    writeFileSync(bodyFile, body)
    const r = spawnSync('python', [SEND_EMAIL, subject, bodyFile], { encoding: 'utf-8', timeout: 60_000 })
    if (r.status !== 0) log(`WARNING: receipt email failed (exit ${r.status}): ${(r.stderr || '').slice(0, 200)}`)
    else log(`receipt email sent: ${subject}`)
  } catch (e) { log(`WARNING: receipt email failed: ${e.message}`) }
}

// ── main ───────────────────────────────────────────────────────────────────────
async function main() {
  const { error, args: a } = parseArgs(process.argv.slice(2))
  if (error) fail(error)

  // 1. allowlist
  const al = checkAllowlist(a.project, a.function)
  if (!al.ok) fail(`${al.reason}.\nAllowed (monitoring/ops layer only):\n${allowlistMessage()}`)
  log(`allowlist OK: ${a.function} on ${al.label} (${a.project})`)

  // 2. daily cap
  const cap = loadCapState()
  const used = cap[todayKey()] || 0
  if (!a.dryRun && used >= DAILY_CAP) {
    fail(`daily cap reached: ${used}/${DAILY_CAP} real prod deploys already used on ${todayKey()} (UTC) — wait for tomorrow or ask Roger`)
  }
  log(`daily cap OK: ${used}/${DAILY_CAP} used today (UTC)`)

  // token precheck (real runs only; the script never reads the secret itself)
  if (!a.dryRun && !process.env.SUPABASE_ACCESS_TOKEN) {
    fail('SUPABASE_ACCESS_TOKEN is not set — the CALLER must export it (see the repo\'s docs/Credentials.txt); this script never reads secrets itself')
  }

  // 3. repo checks
  const { branch, commit } = checkRepo(a.repo, a.function)

  // 4. CI gate
  const { ciRun } = checkCi(a.repo, branch)

  // 4b. verify_jwt declaration gate. Runs BEFORE the dry-run early-return on purpose, so a
  // dry-run actually exercises it. A dry-run that short-circuits before a check cannot
  // validate that check, which is exactly how the scout-ux constraint bug shipped today.
  await checkVerifyJwt(a.repo, a.function, a.project)

  if (a.dryRun) {
    log('─'.repeat(60))
    log(`DRY-RUN: all preflight checks passed. WOULD now:`)
    log(`  1. supabase functions deploy ${a.function} --project-ref ${a.project} --use-api   (cwd=${a.repo})`)
    log(`  2. probe ${a.probeMethod} ${a.probeUrl} (up to ${PROBE_TRIES}x, 15s apart${a.probeExpect ? `, expect "${a.probeExpect}"` : ''}) — auto-rollback on failure`)
    log(`  3. email receipt "[DEPLOY] prod ${a.function} -> ${a.project} (<status>)"`)
    log(`  4. count 1/${DAILY_CAP} against today's cap in ${STATE_FILE}`)
    log(`  (verify_jwt declaration gate already PASSED above — it is not skipped in dry-run)`)
    log('DRY-RUN: no deploy, no probe, no email.')
    return
  }

  // 5. deploy
  log(`deploying ${a.function} -> ${a.project} (${al.label}) @ ${commit.slice(0, 8)}...`)
  const d = deploy(a.repo, a.function, a.project)
  log(`deploy output: ${d.out.slice(0, 600)}`)
  if (!d.ok) {
    sendReceipt(`[DEPLOY] prod ${a.function} -> ${a.project} (failed)`,
      `note: ${a.note || '(none)'}\nrepo: ${a.repo}\nbranch: ${branch}\ncommit: ${commit}\nCI run: ${ciRun}\n\nDEPLOY FAILED:\n${d.out}`)
    fail(`supabase functions deploy failed — see output above. Receipt emailed.`)
  }

  // 6. probe (mandatory) + auto-rollback
  const p = await probe(a)
  let status = 'deployed'
  let rollbackInfo = 'none'
  if (!p.ok) {
    log('PROBE FAILED — auto-rollback: deploying previous committed version (HEAD~1)...')
    const fnDir = `supabase/functions/${a.function}`
    const rb = { ok: false, out: '' }
    try {
      git(a.repo, ['checkout', 'HEAD~1', '--', fnDir])
      const rd = deploy(a.repo, a.function, a.project)
      rb.ok = rd.ok; rb.out = rd.out
    } catch (e) {
      rb.out = `rollback git/deploy error: ${e.message}`
    } finally {
      // ALWAYS restore the working tree to HEAD, whatever the rollback deploy did
      try { git(a.repo, ['checkout', 'HEAD', '--', fnDir]) } catch (e) { log(`WARNING: could not restore ${fnDir} to HEAD: ${e.message}`) }
    }
    rollbackInfo = rb.ok
      ? `probe failed 3x -> rolled back to HEAD~1 version, redeploy OK, working tree restored to HEAD`
      : `probe failed 3x -> rollback redeploy ALSO FAILED: ${rb.out.slice(0, 400)}`
    log(`ROLLBACK: ${rollbackInfo}`)
    status = rb.ok ? 'rolled-back' : 'failed'
  }

  // 7. receipt (always on a real deploy attempt)
  sendReceipt(`[DEPLOY] prod ${a.function} -> ${a.project} (${status})`,
    [
      `status: ${status}`,
      `note: ${a.note || '(none)'}`,
      `project: ${a.project} (${al.label})`,
      `function: ${a.function}`,
      `repo: ${a.repo}`,
      `branch: ${branch}`,
      `commit: ${commit}`,
      `CI run: ${ciRun}`,
      `deploy output: ${d.out.slice(0, 600)}`,
      `probe evidence:\n${p.evidence.map((e) => '  ' + e).join('\n')}`,
      `rollback: ${rollbackInfo}`,
      `time: ${new Date().toISOString()}`,
    ].join('\n'))

  // 8. count the REAL deploy against the cap (deployed AND rolled-back both burned prod deploys)
  const st = loadCapState()
  st[todayKey()] = (st[todayKey()] || 0) + 1
  saveCapState(st)

  if (status === 'rolled-back') { log('exit 2 (rolled back) — do NOT close the incident as fixed.'); process.exit(2) }
  if (status === 'failed') fail('deployed but probe failed AND rollback failed — manual intervention needed.')
  log(`DONE: ${a.function} deployed to ${al.label} and probe-verified.`)
}

export { parseArgs, checkAllowlist, loadCapState, allowlistMessage }

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => { console.error(e); process.exit(1) })
}
