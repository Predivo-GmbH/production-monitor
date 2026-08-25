#!/usr/bin/env node
/**
 * Product-mailer config guard.
 *
 * WHY THIS EXISTS. Two silent mailer failures inside four days, 2026-08-20 and 2026-08-24:
 *
 *   1. BackOffice support mail died and nobody knew for four days. A shared SMTP_HOST/SMTP_PORT
 *      was repointed at smtp.postmarkapp.com:587 for ONE mailer; a SECOND mailer in the same
 *      repo read those two variables as its own fallback, followed them onto a STARTTLS port
 *      while still opening the socket with implicit TLS, and died on every handshake.
 *   2. arivioo PRODUCTION carried NONE of SMTP_HOST/PORT/USER/PASS, so every signup code and
 *      password reset threw, on a live public site, for at least nine days.
 *
 * Its sibling check-auth-email-config.mjs reads GoTrue's SMTP config and exempts Arivioo by
 * name. Every fleet product actually sends from EDGE-FUNCTION secrets, which that guard never
 * reads - which is exactly why the one completely unconfigured production mailer in the fleet
 * was invisible to it. This file reads the edge-function secrets.
 *
 * WHAT IT CHECKS, for all 8 products across both environments:
 *   1. SECRETS PRESENT   - the mailer variables exist at all on an environment declared to send.
 *   2. TRANSPORT AGREES  - host, port and the TLS mode the CLIENT CODE actually uses agree.
 *                          Implicit TLS exists only on 465. Postmark has no 465 listener at all
 *                          (probed 2026-08-24: the connection times out), so smtp.postmarkapp.com
 *                          requires STARTTLS on 587 or the Postmark HTTP API.
 *   3. ONE MAILER PER NAMESPACE - no SECOND file has appeared that reads another mailer's
 *                          SMTP_* variables. Today exactly one product has two readers on
 *                          purpose (BackOffice, with its own SUPPORT_SMTP_* prefix).
 *   4. IT ACTUALLY SENT  - Postmark outbound history per server for the Postmark products;
 *                          Supabase edge-function invocation logs for the Metanet ones.
 *
 * Everything treated as NORMAL lives in scripts/lib/mailer-baseline.json, so drift is a diff
 * against that file. Exempt/warn verdicts are recorded there with their reason, same model as
 * check-auth-email-config.mjs: a permanent red on a product with no audience is how an alarm
 * loses its credibility, so those are WARN and only real breakage is FAIL.
 *
 * READING SECRET VALUES. The Supabase Management API returns sha256 digests, never plaintext.
 * Host and port are resolved by hashing the candidate list in the baseline and matching. An
 * unresolved PORT fails (the candidate set is tiny and exhaustive); an unresolved HOST warns
 * (we simply cannot judge the Postmark rule, and it means we moved provider without telling
 * this file).
 *
 * READING THE SOURCE. Product repos are not checked out beside this one in CI, so each repo's
 * supabase/functions tree is fetched with a blobless sparse clone. On a machine that already
 * has the working copies (MAILER_SRC_ROOT, default C:\\Business\\Internal Projects) those are
 * used directly - which is also what makes defect injection testable.
 *
 * ENV: SUPABASE_TOKEN_<ACCOUNT> per account (same convention as its sibling)
 *      POSTMARK_ACCOUNT_TOKEN    - one account token; server tokens are read from it
 *      GH_TOKEN                  - only needed when the source has to be cloned
 *      MAILER_SRC_ROOT           - local checkout root; skips cloning when the dir exists
 *      MAILER_LOG_WINDOW_HOURS   - edge-log window, default 24 (see the retention note below)
 * Exit 1 on any failure. Writes mailer-findings.json for send-mailer-alert.mjs.
 */

import crypto from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdtempSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BASELINE_PATH = process.env.MAILER_BASELINE || path.join(HERE, 'lib', 'mailer-baseline.json')
const BASELINE = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8'))

const SRC_ROOT = process.env.MAILER_SRC_ROOT || 'C:\\Business\\Internal Projects'
const FUNCTIONS_SUBDIR = 'supabase/functions'
const TRANSPORT_KEYS = ['HOST', 'PORT', 'USER', 'PASS']

// Supabase's log API silently returns ZERO ROWS for a window whose start is older than the
// project's log retention (~1 day on the free plan) - it does not error. A window wider than
// retention therefore reads as "this mailer has sent nothing", which is the exact false verdict
// this guard exists to avoid producing. Verified 2026-08-25 on four projects: a 30h window
// returned rows, a 48h window returned 0 for every one of them.
const LOG_WINDOW_HOURS = Number(process.env.MAILER_LOG_WINDOW_HOURS || 24)

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex')
const hostByDigest = new Map(BASELINE.hostCandidates.map((v) => [sha256(v), v]))
const portByDigest = new Map(BASELINE.portCandidates.map((v) => [sha256(v), v]))

const failures = []
const warnings = []
const rows = []

const fail = (product, env, what, detail) => failures.push({ product, env, what, detail })
const warn = (product, env, what, detail) => warnings.push({ product, env, what, detail })

// ─────────────────────────────────────────────────────────────────────────────
// 1. The source: which files read which SMTP_* namespace, and how each opens the socket
// ─────────────────────────────────────────────────────────────────────────────

/** Every .ts/.js file under a directory, as repo-relative POSIX paths. */
function walk(root, base = root, out = []) {
  for (const entry of readdirSync(root)) {
    if (entry === 'node_modules' || entry === '.git') continue
    const full = path.join(root, entry)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, base, out)
    else if (/\.(ts|js|mts|mjs)$/.test(entry)) out.push(path.relative(base, full).split(path.sep).join('/'))
  }
  return out
}

/**
 * Obtain a product's supabase/functions tree. Prefers the local working copy, because that is
 * what a person edits and what defect injection touches. Falls back to a blobless sparse clone,
 * which is what CI does - the product repos are not checked out beside this one there.
 */
function getFunctionsDir(p) {
  const local = path.join(SRC_ROOT, p.dir, ...FUNCTIONS_SUBDIR.split('/'))
  if (existsSync(local)) return { dir: local, origin: 'local working copy' }

  const token = process.env.GH_TOKEN
  if (!token) return { dir: null, origin: null, error: 'no local checkout and GH_TOKEN is not set, so the source could not be read' }
  try {
    const tmp = mkdtempSync(path.join(tmpdir(), 'mailer-src-'))
    const url = `https://x-access-token:${token}@github.com/${p.repo}.git`
    execFileSync('git', ['clone', '--depth', '1', '--filter=blob:none', '--sparse', '--single-branch', '--quiet', url, tmp], { stdio: ['ignore', 'ignore', 'pipe'] })
    execFileSync('git', ['-C', tmp, 'sparse-checkout', 'set', FUNCTIONS_SUBDIR], { stdio: ['ignore', 'ignore', 'pipe'] })
    const dir = path.join(tmp, ...FUNCTIONS_SUBDIR.split('/'))
    if (!existsSync(dir)) return { dir: null, origin: null, error: `${p.repo} has no ${FUNCTIONS_SUBDIR} tree` }
    return { dir, origin: `clone of ${p.repo}` }
  } catch (err) {
    const msg = (err.stderr ? String(err.stderr) : err.message).replace(/x-access-token:[^@]+@/g, 'x-access-token:***@')
    return { dir: null, origin: null, error: `could not clone ${p.repo}: ${msg.trim().split('\n').pop()}` }
  }
}

/**
 * How a file opens its socket. This is the half of the 2026-08-20 defect that no config check
 * could see: the secrets said 587 and the CODE said implicit TLS.
 *   implicit-only  tls:true / secure:true / Deno.connectTls - valid ONLY on 465
 *   port-derived   tls: port === 465 - correct on both, it follows the port
 *   http-api       talks to api.postmarkapp.com and never opens an SMTP socket
 */
function tlsModeOf(src) {
  const portDerived = /(?:tls|secure)\s*:\s*[^,;\n]*(?:===|!==)\s*465/.test(src)
  const implicitLiteral = /(?:tls|secure)\s*:\s*true\b/.test(src) || /\bconnectTls\s*\(/.test(src)
  const httpApi = /api\.postmarkapp\.com/.test(src)
  if (portDerived && implicitLiteral) return 'mixed'
  if (implicitLiteral) return 'implicit-only'
  if (portDerived) return 'port-derived'
  if (httpApi) return 'http-api'
  return 'unknown'
}

/**
 * namespace -> { files, keys, mode } for one product's tree, plus the edge-function slugs that
 * send mail. The slug list is DERIVED (a function that imports a mailer file is a mailer
 * function) rather than written down, because a hand-kept list goes stale the first time
 * somebody adds a function, and a stale list reads as "nothing sends here".
 */
function scanSource(dir) {
  const found = new Map()
  const modeByFile = new Map()
  const files = walk(dir)
  const sources = new Map(files.map((rel) => [rel, readFileSync(path.join(dir, rel), 'utf-8')]))

  for (const [rel, src] of sources) {
    const re = /(?:Deno\.env\.get|process\.env)\s*[(.]\s*['"`]?([A-Z0-9_]*?)SMTP_(HOST|PORT|USER|PASS|FROM)\b/g
    let m
    let touched = false
    while ((m = re.exec(src))) {
      const ns = m[1]
      if (!found.has(ns)) found.set(ns, { files: new Set(), keys: new Set() })
      found.get(ns).files.add(`${FUNCTIONS_SUBDIR}/${rel}`)
      found.get(ns).keys.add(m[2])
      touched = true
    }
    if (touched) modeByFile.set(`${FUNCTIONS_SUBDIR}/${rel}`, tlsModeOf(src))
  }

  const mailerBasenames = new Set([...found.values()].flatMap((i) => [...i.files]).map((f) => path.posix.basename(f).replace(/\.(ts|js|mts|mjs)$/, '')))
  const mailFunctions = new Set()
  for (const [rel, src] of sources) {
    const slug = rel.split('/')[0]
    if (slug.startsWith('_')) continue
    const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => path.posix.basename(m[1]).replace(/\.(ts|js|mts|mjs)$/, ''))
    if (imports.some((b) => mailerBasenames.has(b))) mailFunctions.add(slug)
    if ([...found.values()].some((i) => i.files.has(`${FUNCTIONS_SUBDIR}/${rel}`))) mailFunctions.add(slug)
  }
  return { found, modeByFile, mailFunctions: [...mailFunctions] }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. The live secrets
// ─────────────────────────────────────────────────────────────────────────────

async function getSecrets(ref, token) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/secrets`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const list = await res.json()
  return new Map(list.map((s) => [s.name, s.value]))
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Did it actually send?
// ─────────────────────────────────────────────────────────────────────────────

/** Postmark server name -> { last: Date|null, total } for every server on the account. */
async function postmarkHistory() {
  const acct = process.env.POSTMARK_ACCOUNT_TOKEN
  if (!acct) return { error: 'POSTMARK_ACCOUNT_TOKEN is not set' }
  const h = { 'X-Postmark-Account-Token': acct, Accept: 'application/json' }
  const res = await fetch('https://api.postmarkapp.com/servers?count=100&offset=0', { headers: h })
  if (!res.ok) return { error: `servers list HTTP ${res.status}` }
  const body = await res.json()
  if (!Array.isArray(body.Servers)) return { error: 'servers list returned no Servers array' }
  const out = new Map()
  for (const s of body.Servers) {
    const tok = (s.ApiTokens || [])[0]
    if (!tok) { out.set(s.Name, { error: 'server has no API token' }); continue }
    const m = await fetch('https://api.postmarkapp.com/messages/outbound?count=1&offset=0', {
      headers: { 'X-Postmark-Server-Token': tok, Accept: 'application/json' },
    })
    if (!m.ok) { out.set(s.Name, { error: `outbound HTTP ${m.status}` }); continue }
    const mj = await m.json()
    const last = (mj.Messages || [])[0]
    out.set(s.Name, { total: mj.TotalCount, last: last ? new Date(last.ReceivedAt) : null })
  }
  return { servers: out }
}

/**
 * Successful invocations of this environment's mail-sending edge functions.
 *
 * ONLY 2xx COUNTS. Verified 2026-08-25: Valrano production logged 97 invocations of
 * send-auth-email in 24h and every one was a 400, and arivioo logged 401s on email-hook - those
 * are this monitor's own unauthenticated reachability probes, not sends. Counting raw
 * invocations would have called both mailers healthy while neither had delivered anything.
 */
async function edgeMailActivity(ref, token, slugs) {
  if (!slugs || !slugs.length) return { error: 'no function in this repo imports the mailer' }
  const fnRes = await fetch(`https://api.supabase.com/v1/projects/${ref}/functions`, { headers: { Authorization: `Bearer ${token}` } })
  if (!fnRes.ok) return { error: `functions list HTTP ${fnRes.status}` }
  const fns = await fnRes.json()
  const ids = fns.filter((f) => slugs.includes(f.slug)).map((f) => f.id)
  if (!ids.length) return { error: `none of ${slugs.join(', ')} is deployed here` }

  const sql = `select count(*) as c, max(timestamp) as last from function_edge_logs cross join unnest(metadata) as m cross join unnest(m.response) as r where m.function_id in (${ids.map((i) => `'${i}'`).join(',')}) and r.status_code < 300`
  const start = new Date(Date.now() - LOG_WINDOW_HOURS * 3600e3).toISOString()
  const end = new Date().toISOString()
  const url = `https://api.supabase.com/v1/projects/${ref}/analytics/endpoints/logs.all?sql=${encodeURIComponent(sql)}&iso_timestamp_start=${encodeURIComponent(start)}&iso_timestamp_end=${encodeURIComponent(end)}`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) return { error: `logs HTTP ${res.status}` }
  const body = await res.json()
  const row = (body.result || [])[0] || {}
  return { count: Number(row.c || 0), last: row.last ? new Date(Number(row.last) / 1000) : null, windowHours: LOG_WINDOW_HOURS }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. The checks
// ─────────────────────────────────────────────────────────────────────────────

function checkReaders(p, found) {
  const declared = p.readers || {}
  for (const [ns, info] of found) {
    const label = ns === '' ? 'SMTP_*' : `${ns}SMTP_*`
    const allowed = declared[ns]
    if (!allowed) {
      fail(p.product, 'repo', 'a mailer namespace nobody declared',
        `${[...info.files].join(', ')} reads ${label}, which this product is not recorded as using at all. Either it is a new mailer that needs a baseline entry, or it is reading another mailer's variables.`)
      continue
    }
    const extra = [...info.files].filter((f) => !allowed.includes(f))
    if (extra.length) {
      fail(p.product, 'repo', 'a SECOND mailer reading another mailer\'s variables',
        `${extra.join(', ')} now reads ${label}. Declared reader(s): ${allowed.join(', ')}. This is the shape of the 2026-08-20 BackOffice outage: a second reader silently follows every change made for the first one.`)
    }
  }
  for (const ns of Object.keys(declared)) {
    if (!found.has(ns)) {
      warn(p.product, 'repo', 'a declared mailer has disappeared',
        `nothing under ${FUNCTIONS_SUBDIR} reads ${ns === '' ? 'SMTP_*' : `${ns}SMTP_*`} any more. If the mailer was removed on purpose, drop it from the baseline; the secrets are still set and are now unused.`)
    }
  }
}

function checkTransport(p, e, ns, info, mode, secrets) {
  const label = ns === '' ? 'SMTP_' : `${ns}SMTP_`
  const need = TRANSPORT_KEYS.filter((k) => info.keys.has(k))
  const missing = need.filter((k) => !secrets.has(`${label}${k}`))

  if (missing.length === need.length && need.length) {
    fail(p.product, e.env, 'the mailer is not configured at all',
      `none of ${need.map((k) => label + k).join(', ')} is set on this project, so every send throws. This is the arivioo production failure of 2026-08-24 exactly.`)
    return { host: '(absent)', port: '(absent)', mode }
  }
  if (missing.length) {
    fail(p.product, e.env, 'part of the mailer configuration is missing',
      `${missing.map((k) => label + k).join(', ')} absent while the rest is set. The code reads all of ${need.join(', ')}, so it either throws or silently falls back to a default that nobody chose.`)
  }

  const hostDigest = secrets.get(`${label}HOST`)
  const portDigest = secrets.get(`${label}PORT`)
  const host = hostDigest ? hostByDigest.get(hostDigest) : undefined
  const port = portDigest ? portByDigest.get(portDigest) : undefined

  if (hostDigest && !host) {
    warn(p.product, e.env, 'the mail host is one this check does not know',
      `${label}HOST hashes to nothing in the candidate list, so the Postmark rule could not be applied here. Add the new host to hostCandidates in scripts/lib/mailer-baseline.json.`)
  }
  if (portDigest && !port) {
    fail(p.product, e.env, 'the mail port is not a mail port',
      `${label}PORT hashes to none of ${BASELINE.portCandidates.join(', ')}. Either it is wrong, or it is a port this fleet has never used and the baseline needs it.`)
  }

  const portNum = port ? Number(port) : null
  const implicit = mode === 'implicit-only' || mode === 'mixed'

  if (implicit && portNum && portNum !== BASELINE.implicitTlsOnlyPort) {
    fail(p.product, e.env, 'implicit TLS on a port that does not speak it',
      `${label}PORT is ${portNum} but ${[...info.files].join(', ')} opens the socket with implicit TLS (${mode}). Implicit TLS exists only on ${BASELINE.implicitTlsOnlyPort}; on ${portNum} the handshake fails on every send. This is the 2026-08-20 BackOffice outage.`)
  }
  if (host && BASELINE.noImplicitTlsListener.includes(host)) {
    if (portNum === BASELINE.implicitTlsOnlyPort) {
      fail(p.product, e.env, 'a host with no implicit-TLS listener, on the implicit-TLS port',
        `${label}HOST is ${host} and ${label}PORT is ${portNum}. ${host} has no ${BASELINE.implicitTlsOnlyPort} listener at all - the connection times out (probed 2026-08-24). It needs STARTTLS on 587 or the HTTP API.`)
    } else if (implicit) {
      fail(p.product, e.env, 'an implicit-TLS client pointed at a host that has no implicit-TLS listener',
        `${label}HOST is ${host}, and ${[...info.files].join(', ')} opens the socket with implicit TLS (${mode}). ${host} accepts neither - it needs STARTTLS on 587 or the HTTP API.`)
    }
  }
  if (mode === 'unknown') {
    warn(p.product, e.env, 'the client\'s TLS mode could not be read',
      `${[...info.files].join(', ')} shows neither a hard-coded TLS flag nor a port-derived one, so the transport rule could not be applied to ${label}*.`)
  }

  return { host: host || (hostDigest ? 'unknown' : '(absent)'), port: port || (portDigest ? 'unknown' : '(absent)'), mode }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Run
// ─────────────────────────────────────────────────────────────────────────────

const pm = await postmarkHistory()
if (pm.error) warn('(fleet)', '-', 'Postmark history unavailable', `${pm.error} - no product could be checked for whether it actually sent.`)

for (const p of BASELINE.products) {
  const token = process.env[`SUPABASE_TOKEN_${p.account}`]
  const src = getFunctionsDir(p)

  let scan = null
  if (src.error) {
    fail(p.product, 'repo', 'the mailer source could not be read', `${src.error}. Without it neither the transport rule nor the second-reader rule can be applied to this product.`)
  } else {
    scan = scanSource(src.dir)
    checkReaders(p, scan.found)
  }

  for (const e of p.envs) {
    if (!token) {
      fail(p.product, e.env, 'unaudited', `SUPABASE_TOKEN_${p.account} is not set, so this environment was not read at all.`)
      rows.push({ product: p.product, env: e.env, ns: '-', host: '?', port: '?', mode: '?', status: 'UNAUDITED' })
      continue
    }

    let secrets
    try {
      secrets = await getSecrets(e.ref, token)
    } catch (err) {
      fail(p.product, e.env, 'the project could not be read', `Supabase Management API: ${err.message}`)
      rows.push({ product: p.product, env: e.env, ns: '-', host: '?', port: '?', mode: '?', status: 'UNAUDITED' })
      continue
    }

    // --- 1. secrets present / deliberately absent ---------------------------
    const anyMailerSecret = [...secrets.keys()].some((k) => /SMTP_/.test(k))
    if (e.config === 'dormant') {
      if (anyMailerSecret) {
        fail(p.product, e.env, 'a dormant environment has grown a mailer',
          `this environment is recorded as deliberately unconfigured (${e.configNote || 'no reason recorded'}), but it now carries ${[...secrets.keys()].filter((k) => /SMTP_/.test(k)).join(', ')}. Either it started sending and the baseline is stale, or something was set here by mistake.`)
      } else {
        warn(p.product, e.env, 'dormant, nothing sends from it', e.configNote || 'declared dormant in the baseline')
      }
      rows.push({ product: p.product, env: e.env, ns: '-', host: '-', port: '-', mode: '-', status: anyMailerSecret ? 'FAIL' : 'DORMANT' })
      continue
    }

    // --- 2 & 3. transport, per namespace the source actually reads -----------
    const namespaces = scan ? [...scan.found.keys()].filter((ns) => (p.readers || {})[ns]) : Object.keys(p.readers || {})
    if (!namespaces.length && scan) {
      fail(p.product, e.env, 'no mailer found in the source at all', `nothing under ${FUNCTIONS_SUBDIR} reads any SMTP_* variable, yet this environment is declared to send.`)
    }
    for (const ns of namespaces) {
      const info = scan ? scan.found.get(ns) : { files: new Set(p.readers[ns]), keys: new Set(TRANSPORT_KEYS) }
      const modes = [...info.files].map((f) => (scan ? scan.modeByFile.get(f) : 'unknown'))
      const mode = modes.includes('implicit-only') ? 'implicit-only' : modes.includes('mixed') ? 'mixed' : (modes[0] || 'unknown')
      const before = failures.length
      const r = checkTransport(p, e, ns, info, mode, secrets)
      const bad = failures.length > before
      rows.push({ product: p.product, env: e.env, ns: ns === '' ? 'SMTP_' : `${ns}SMTP_`, host: r.host, port: r.port, mode: r.mode, status: bad ? 'FAIL' : 'OK' })
    }

    // --- 4. did it actually send? ------------------------------------------
    if (e.traffic === 'postmark' && pm.servers) {
      const s = pm.servers.get(e.postmarkServer)
      if (!s) {
        fail(p.product, e.env, 'its Postmark server is gone', `no Postmark server named "${e.postmarkServer}" exists on the account any more, so this product has no sending unit.`)
      } else if (s.error) {
        warn(p.product, e.env, 'Postmark history unreadable', s.error)
      } else if (!s.last) {
        fail(p.product, e.env, 'it has never sent anything', `Postmark server "${e.postmarkServer}" has no outbound message in its retention window, yet this environment is declared to be sending.`)
      } else {
        const hours = (Date.now() - s.last.getTime()) / 3600e3
        if (hours > e.maxSilenceHours) {
          fail(p.product, e.env, 'it has sent nothing recently',
            `last message through Postmark server "${e.postmarkServer}" was ${Math.round(hours)}h ago (${s.last.toISOString()}), past the ${e.maxSilenceHours}h this product is allowed to be silent.`)
        }
        rows.push({ product: p.product, env: e.env, ns: 'sent', host: `${s.total} msg`, port: `${Math.round(hours)}h ago`, mode: 'postmark', status: hours > e.maxSilenceHours ? 'FAIL' : 'OK' })
      }
    } else if (e.traffic === 'edge') {
      const a = await edgeMailActivity(e.ref, token, scan ? scan.mailFunctions : null)
      if (a.error) warn(p.product, e.env, 'edge-function history unreadable', a.error)
      else if (!a.count) {
        fail(p.product, e.env, 'it has sent nothing recently',
          `no SUCCESSFUL invocation of ${(scan.mailFunctions || []).join(', ')} in the last ${a.windowHours}h, yet this environment is declared to be sending.`)
      } else {
        rows.push({ product: p.product, env: e.env, ns: 'sent', host: `${a.count} ok`, port: a.last ? `${Math.round((Date.now() - a.last.getTime()) / 3600e3)}h ago` : '-', mode: `edge/${a.windowHours}h`, status: 'OK' })
      }
    } else if (e.traffic === 'none') {
      // Reported, never enforced. The reason is recorded in the baseline so that the day this
      // product gets an audience, turning the budget on is a one-line change with its history
      // attached rather than a judgement call made from scratch.
      let detail = e.trafficNote || 'no send budget declared'
      if (e.postmarkServer && pm.servers) {
        const s = pm.servers.get(e.postmarkServer)
        if (s && s.last) detail += ` - last send ${Math.round((Date.now() - s.last.getTime()) / 3600e3)}h ago, ${s.total} in Postmark's window`
      } else if (scan) {
        const a = await edgeMailActivity(e.ref, token, scan.mailFunctions)
        detail += a.error ? ` - send history unreadable: ${a.error}` : ` - ${a.count} SUCCESSFUL mailer call(s) in the last ${a.windowHours}h`
      }
      warn(p.product, e.env, 'silence here is not judged', detail)
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Report
// ─────────────────────────────────────────────────────────────────────────────

console.log('MAILER TRANSPORT (live edge-function secrets, resolved from their sha256 digests):')
console.log('PRODUCT'.padEnd(17), 'ENV'.padEnd(11), 'NAMESPACE'.padEnd(14), 'HOST'.padEnd(22), 'PORT'.padEnd(10), 'CLIENT TLS'.padEnd(14), 'STATUS')
for (const r of rows) {
  console.log(String(r.product).padEnd(17), String(r.env).padEnd(11), String(r.ns).padEnd(14), String(r.host).padEnd(22), String(r.port).padEnd(10), String(r.mode).padEnd(14), r.status)
}

if (warnings.length) {
  console.log('\nWARN (reported, does not fail the guard):')
  for (const w of warnings) console.log(`  [WARN] ${w.product}/${w.env}: ${w.what} - ${w.detail}`)
}

if (failures.length) {
  console.log('\nFAIL:')
  for (const f of failures) {
    console.log(`::warning::${f.product}/${f.env}: ${f.what}`)
    console.log(`  *** ${f.product}/${f.env}: ${f.what}`)
    console.log(`      ${f.detail}`)
  }
}

try {
  writeFileSync('mailer-findings.json', JSON.stringify({
    checked_at: new Date().toISOString(),
    failures,
    warnings,
    rows,
  }, null, 2))
} catch { /* if we cannot write the report, send-mailer-alert.mjs still fires on the missing file */ }

if (failures.length) {
  console.error(`\nFAIL: ${failures.length} mailer problem(s) across ${new Set(failures.map((f) => f.product)).size} product(s).`)
  process.exit(1)
}
console.log(`\nAll declared mailers OK (${warnings.length} warning(s)).`)
