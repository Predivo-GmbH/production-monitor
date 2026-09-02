/**
 * THE MANAGEMENT TOKENS A LOCAL SESSION CAN ACTUALLY USE, AND THE PROJECT EACH ONE OPENS.
 *
 * -- THE INCIDENT (signal fleet:supabase-mgmt-tokens-dead-on-disk, 2026-08-29 -> 2026-09-02) --
 *
 * For four days the monitoring page carried a critical saying, verbatim:
 *
 *   "Every Supabase management PAT on disk is revoked (14 of 16 return 401; the 2 live ones are
 *    too narrowly scoped to run SQL), so no local session can query a product DB. The only fix is
 *    minting+writing+setting fresh tokens - a forbidden secret operation behind Roger's gate."
 *
 * Every clause of that was false, and a full enumeration on 2026-09-02 measured the opposite:
 * 35 distinct management tokens in 82 places across 44 files, of which FOURTEEN answer 200, and
 * every one of those runs SQL against its own project (POST /v1/projects/{ref}/database/query
 * returns 201). Nothing needed minting. Nothing was behind a gate. Two mistakes produced it:
 *
 *   1. THE COUNT INCLUDED THE PRE-ROTATION BACKUPS. The 2026-08-29/30 rotation left a
 *      `docs/Credentials.txt.bak-<date>-before-key-rotation` beside each live file. Those hold the
 *      tokens the rotation DELIBERATELY REVOKED. A sweep that globs `Credentials.txt*` therefore
 *      finds a dead token next to every live one and concludes the fleet is dead. Of the 21 dead
 *      tokens found, 17 exist ONLY in a .bak file or an archived session log. They are not
 *      config; they are the receipt of a rotation that worked.
 *
 *   2. THE LIVE TOKENS WERE TESTED AGAINST THE WRONG DOOR. The probe called
 *      /v1/projects/xoecpzfsskalvjrtcbbl/database/query - the COCKPIT FLEET project - using the
 *      BackOffice and ReplyFlow account tokens. There is one Supabase ACCOUNT PER PRODUCT, so an
 *      account-level admin token for BackOffice cannot see a project in the Cockpit account and
 *      answers 401. That 401 was read as "too narrowly scoped to run SQL". It was not a scope
 *      fact at all. A management token is account-level admin over its OWN account and has no
 *      opinion about anyone else's.
 *
 * -- WHY A MODULE AND NOT A CORRECTION --
 *
 * Three separate sweeps re-derived "no local session can query a product DB" in four days,
 * because the underlying gap is real even though the diagnosis was not: there are fourteen live
 * tokens on this disk and NOTHING MAPS A PROJECT TO THE ONE THAT OPENS IT. Guessing gets a 401
 * thirteen times out of fourteen, and a 401 reads exactly like a revoked credential. So each
 * sweep looked at the same evidence and reached the same wrong conclusion.
 *
 * The answer is not a fact written in a document, because the mapping changes whenever an account
 * is split or a project moves - which is the same rot lib/supabase-token.mjs exists to survive on
 * the CI side. It is a lookup performed against the live API: ASK EVERY TOKEN WHAT IT CAN SEE,
 * then use the one that names your project. This module is the local-disk twin of
 * lib/supabase-token.mjs, which does the same thing over process.env for CI. Keep them in step.
 *
 * -- THE RULES THIS ENCODES --
 *
 *   A .bak FILE IS NEVER A CREDENTIAL SOURCE. It is the definition of a superseded one.
 *   A TOKEN IS IDENTIFIED BY A HASH, NEVER BY ITS VALUE OR A PREFIX OF IT. A prefix is a secret
 *     in the only sense that matters: it narrows the guess. An engine printed twelve-character
 *     key prefixes into a transcript on 2026-09-02, the same day, doing exactly this job.
 *   A 401 FROM ONE TOKEN ENDS NOTHING. It is the expected answer from thirteen of fourteen.
 *
 * Pure except for the injected `fetch` and `readFile`: no network and no secret is needed to test
 * any of it. Run: node test/local-management-tokens.test.mjs
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The fleet root: the directory the product folders sit in. Derived from this file's own
 * location (scripts/lib -> production-monitor -> "Internal Projects") so it needs no config and
 * cannot drift. fileURLToPath, not .pathname - the path contains a space.
 */
export const FLEET_ROOT = fileURLToPath(new URL('../../..', import.meta.url))

/** `sbp_` plus its body. Length is not asserted: it is Supabase's to change, not ours. */
const TOKEN_RE = /sbp_[A-Za-z0-9]{16,}/g

/**
 * The ONLY safe way to name a token in a log, a report, a board note or a commit message.
 *
 * Eight hex characters of a SHA-256. Enough to say "this is the same token as that one" and to
 * tell fourteen of them apart, and it reveals nothing that shortens a guess at the value. Every
 * function in this module that returns something printable returns this and never the token.
 */
export const fingerprint = (token) => createHash('sha256').update(token).digest('hex').slice(0, 8)

/**
 * True for a file whose name marks it as a SUPERSEDED copy.
 *
 * This is mistake (1) above, as a predicate. The rotation convention is
 * `Credentials.txt.bak-2026-08-29-before-key-rotation`, so anything with `.bak` in the name is a
 * snapshot of what a credential USED TO BE. Matching `.bak` anywhere rather than anchoring on the
 * exact suffix is deliberate: the fleet has both `.bak-<date>-before-key-rotation` and
 * `.bak-<date>-before-mailbox-pw`, and the next one will be spelled a third way.
 */
export const isSupersededCopy = (name) => name.includes('.bak')

/**
 * Every LIVE credentials file in the fleet, one per product, backups excluded.
 *
 * Enumerated from the directory listing rather than matched against a list of product names.
 * An absence claim needs an enumeration: a name list silently omits whichever product was added
 * last, and reports its token as missing rather than as unlooked-for.
 */
export function credentialFiles(root = FLEET_ROOT, { readdir = readdirSync, exists = existsSync } = {}) {
  let entries = []
  try {
    entries = readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const files = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const f = join(root, e.name, 'docs', 'Credentials.txt')
    if (!isSupersededCopy(f) && exists(f)) files.push(f)
  }
  return files.sort()
}

/**
 * The distinct management tokens in a body of text.
 *
 * Returns VALUES, because the caller has to send them somewhere. Nothing in this module ever
 * prints one, and neither should any caller: pair it with fingerprint() for anything human-facing.
 */
export function extractTokens(text) {
  return [...new Set(String(text).match(TOKEN_RE) || [])]
}

/**
 * Every distinct management token on this disk, with the files each was found in.
 *
 * Deduplicated by value, so one token stored in three products counts once and is reported as
 * one token in three places - which is the shape that makes an inventory table checkable.
 */
export function discoverLocalTokens({ root = FLEET_ROOT, files, readFile = (p) => readFileSync(p, 'utf8') } = {}) {
  const found = new Map()
  for (const file of files ?? credentialFiles(root)) {
    let text
    try {
      text = readFile(file)
    } catch {
      continue
    }
    for (const token of extractTokens(text)) {
      const e = found.get(token) ?? { token, id: fingerprint(token), files: [] }
      e.files.push(file)
      found.set(token, e)
    }
  }
  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * What one token opens, asked of the live API.
 *
 * A non-200 yields an EMPTY project list and never throws, because for any given project this is
 * the expected answer from every token but one, and an exception here would turn the normal case
 * into a failure. `status` is carried out separately so the caller can still tell "this token is
 * revoked" (401 on every project) from "this token is fine, just not for your project" (200 with
 * a list that does not contain your ref) - a distinction the incident above collapsed.
 */
export async function projectsFor(token, { fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  try {
    const res = await fetchImpl('https://api.supabase.com/v1/projects', {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return { status: res.status, projects: [] }
    const body = await res.json()
    return { status: res.status, projects: Array.isArray(body) ? body : [] }
  } catch (err) {
    return { status: 0, projects: [], error: String(err?.message ?? err).slice(0, 120) }
  }
}

/**
 * The token that opens `target`, where `target` is a project ref OR a project name.
 *
 * Names are accepted because a person asking a question has a product in mind, not a
 * twenty-character ref, and requiring the ref is what sends someone back to the dashboard.
 * Matching is case-insensitive on the name and exact on the ref.
 *
 * Returns null when NO token on this disk opens it - a different fact from "the token is dead",
 * and the only one of the two that is ever worth escalating.
 */
export async function tokenForProject(target, { tokens, fetchImpl = fetch, root = FLEET_ROOT } = {}) {
  const candidates = tokens ?? discoverLocalTokens({ root })
  const wanted = String(target).toLowerCase()
  for (const c of candidates) {
    const { status, projects } = await projectsFor(c.token, { fetchImpl })
    const hit = projects.find((p) => p.ref === target || String(p.name ?? '').toLowerCase() === wanted)
    if (hit) return { ...c, status, project: hit }
  }
  return null
}

/**
 * Run SQL against a project through the Management API.
 *
 * This is the call the incident claimed was impossible. It is a POST, and a successful one
 * answers 201 rather than 200 - which is worth stating here, because a caller asserting `=== 200`
 * would report every successful query as a failure and manufacture the incident all over again.
 */
export async function runSql(projectRef, query, token, { fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  const res = await fetchImpl(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const rows = res.ok ? await res.json() : null
  return { status: res.status, rows }
}

/**
 * The whole local inventory, in the shape a report or an inventory table needs: accounts,
 * projects and FINGERPRINTS, with no token value anywhere in the returned object.
 */
export async function inventory({ root = FLEET_ROOT, fetchImpl = fetch } = {}) {
  const out = []
  for (const c of discoverLocalTokens({ root })) {
    const { status, projects } = await projectsFor(c.token, { fetchImpl })
    let account = null
    if (status === 200) {
      try {
        const r = await fetchImpl('https://api.supabase.com/v1/profile', {
          headers: { Authorization: `Bearer ${c.token}` },
        })
        if (r.ok) account = (await r.json())?.primary_email ?? null
      } catch {
        /* an unnamed live token is still a live token */
      }
    }
    out.push({
      id: c.id,
      alive: status === 200,
      status,
      account,
      projects: projects.map((p) => ({ ref: p.ref, name: p.name })),
      files: c.files,
    })
  }
  return out
}
