#!/usr/bin/env node
/**
 * DOES A PROJECT'S EDGE FUNCTION ENV STILL HOLD A KEY THE PROJECT NO LONGER RECOGNISES?
 *
 * -- THE INCIDENT (2026-09-02, ReplyFlow production, 93 minutes, 34 users) --
 *
 * A rotation created a new secret key on ReplyFlow production, updated the consumers it could
 * find, and revoked the old key. It found them with `gh secret list` and by reading each
 * product's docs/Credentials.txt. Both are real consumer lists. Neither is the one that runs.
 *
 * The consumer that runs is the Supabase EDGE FUNCTION ENV, and it held the revoked key in
 * `SB_SECRET_KEY` — which every ReplyFlow function reads FIRST:
 *
 *     Deno.env.get('SB_SECRET_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
 *
 * `??` yields the left side whenever it is SET. It has no opinion about whether the value still
 * WORKS. So the rotation updated the fallback, left the value that shadows it, revoked the old
 * key, and every database call in the product began answering `Unregistered API key`. 57
 * consecutive cron runs failed. The product's own error_log could not record it, because the
 * error logger reads the same dead variable.
 *
 * SignalScore production carried the identical fault the same minute and threw nothing at all —
 * only because no customer happened to call the path. That is the reason this is a CHECK and not
 * a fix: the fault is silent until traffic finds it.
 *
 * -- WHAT IT ASSERTS, AND WHY NOT MORE --
 *
 * Only variables that are handed to Supabase AS A CREDENTIAL are failures. Three other shapes
 * live in the same env and each would be a false alarm:
 *
 *   PLATFORM LISTS  `SUPABASE_PUBLISHABLE_KEYS` / `SUPABASE_SECRET_KEYS` are JSON arrays the
 *     platform maintains, not single keys. A digest sweep flags them on all 21 projects; a
 *     report that is 40 false positives deep is a report nobody reads.
 *   COMPARISON-ONLY `SERVICE_ROLE_JWT` is never presented to Supabase — it is a value an inbound
 *     Authorization header is compared against. A disabled legacy key still works perfectly for
 *     that, so it is a WARNING (a dead credential in a live-looking slot), never a failure.
 *     Tracked in standards/PROMPT_a_vault_and_env_still_hold_the_legacy_key_that_was_disabled_in_july.md
 *   FOREIGN KEYS    `STRIPE_SECRET_KEY` and friends are not Supabase keys and are not this
 *     check's business.
 *
 * -- THE RULE THIS ENCODES --
 *
 *   ENUMERATE CONSUMERS BY READING THE RESOLUTION ORDER IN THE CODE, NOT THE PLACES A KEY IS
 *     STORED. Rotating B while a stale A shadows it changes nothing and looks like everything.
 *   A KEY IS COMPARED BY DIGEST, NEVER BY VALUE OR PREFIX. Supabase already returns edge secret
 *     values as sha256 hex, so the comparison never needs a plaintext secret at all.
 *   "THE NEW KEY ANSWERS 200" PROVES THE KEY, NOT THE DEPLOYMENT. Only the consumer's own env
 *     answers the question this check asks.
 *
 * The classification is pure and is tested by fault injection with no network and no secret:
 *   node test/check-edge-env-keys.test.mjs
 * The live sweep reads its own management tokens off disk via lib/local-management-tokens.mjs:
 *   node scripts/check-edge-env-keys.mjs
 */
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { realpathSync } from 'node:fs'
import { sayVerdict, PASS, FAIL, UNKNOWN } from './lib/check-verdict.mjs'
import { discoverLocalTokens, projectsFor } from './lib/local-management-tokens.mjs'

/** Variables whose value is PRESENTED TO SUPABASE as a credential. A dead one here is an outage. */
export const OUTBOUND_CREDENTIALS = new Set([
  'SB_SECRET_KEY',
  'SB_PUBLISHABLE_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_ANON_KEY',
])

/** Variables holding a key that is only ever COMPARED against an inbound header. Warn, never fail. */
export const COMPARISON_ONLY = new Set(['SERVICE_ROLE_JWT'])

/** sha256 hex, lowercased. Supabase returns edge secret values already in this form. */
export const digest = (v) => createHash('sha256').update(String(v)).digest('hex')

const isDigest = (s) => /^[0-9a-f]{64}$/.test(String(s).toLowerCase())

/**
 * One edge secret, judged against the keys the project still recognises.
 *
 * `known` maps digest -> "type:name" for every key on the project. `legacyDisabled` is the
 * project's own answer from /api-keys/legacy, not an assumption: legacy keys are still ENABLED on
 * every staging project in this fleet, so the same digest is fine there and fatal in production.
 *
 * Returns level 'skip' for anything that is not one of the two credential shapes above — a check
 * that judges variables it does not understand invents work rather than finding it.
 */
export function classifySecret({ name, value }, { known, legacyDisabled }) {
  const outbound = OUTBOUND_CREDENTIALS.has(name)
  const comparison = COMPARISON_ONLY.has(name)
  if (!outbound && !comparison) return { name, level: 'skip', reason: 'not a single-key Supabase credential' }
  if (!isDigest(value)) return { name, level: 'skip', reason: 'value is not a digest — cannot be judged safely' }

  const d = String(value).toLowerCase()
  const match = known.get(d)

  if (!match) {
    return outbound
      ? { name, level: 'fail', reason: 'holds a key this project does not recognise — every call using it is refused' }
      : { name, level: 'warn', reason: 'holds a key this project does not recognise (compared against, not presented)' }
  }
  if (match.startsWith('legacy:') && legacyDisabled) {
    return outbound
      ? { name, level: 'fail', reason: `holds ${match}, and legacy keys are disabled on this project` }
      : { name, level: 'warn', reason: `holds ${match}, dead as a credential but still valid as a comparison value` }
  }
  return { name, level: 'ok', reason: `matches ${match}` }
}

/**
 * Every judged secret on one project, plus the two counts a caller acts on.
 *
 * `checked` is reported separately from `secrets.length` on purpose: a run that judged nothing
 * must not read as a clean run. That is the failure mode this whole monitoring tree exists to
 * avoid — a job that reports success for doing nothing.
 */
export function auditProject({ name, ref, secrets, known, legacyDisabled }) {
  const results = secrets.map((s) => classifySecret(s, { known, legacyDisabled }))
  const judged = results.filter((r) => r.level !== 'skip')
  return {
    name,
    ref,
    legacyDisabled,
    results,
    checked: judged.length,
    failures: judged.filter((r) => r.level === 'fail'),
    warnings: judged.filter((r) => r.level === 'warn'),
  }
}

/** One line per project, and the verdict a caller can assert on. */
export function summarise(audits) {
  const failing = audits.filter((a) => a.failures.length)
  const checked = audits.reduce((n, a) => n + a.checked, 0)
  return {
    projects: audits.length,
    checked,
    failing: failing.length,
    warnings: audits.reduce((n, a) => n + a.warnings.length, 0),
    // A sweep that judged nothing is not a pass. It is a broken sweep.
    verdict: checked === 0 ? 'inconclusive' : failing.length ? 'fail' : 'pass',
  }
}

/** Fetch what one project knows about its own keys. Values never leave this function. */
export async function loadProject(ref, token, { fetchImpl = fetch } = {}) {
  const get = async (p) => {
    const r = await fetchImpl(`https://api.supabase.com/v1/projects/${ref}${p}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    return r.ok ? r.json() : null
  }
  const [keys, legacy, secrets] = await Promise.all([get('/api-keys?reveal=true'), get('/api-keys/legacy'), get('/secrets')])
  if (!Array.isArray(keys) || !Array.isArray(secrets)) return null
  const known = new Map(keys.map((k) => [digest(k.api_key), `${k.type}:${k.name}`]))
  return { known, legacyDisabled: legacy?.enabled === false, secrets }
}

/** The live sweep over every project a token on this disk opens. */
/**
 * TOKENS FROM THE ENVIRONMENT, because a CI runner has no credential files.
 *
 * discoverLocalTokens() reads the credential files under the fleet checkout. That is the right
 * source on a workstation and there is nothing to read on a GitHub runner, so on CI this check
 * would report UNKNOWN forever - true, useless, and exactly the kind of permanent amber an alarm
 * gets trained to ignore. The monitor already hands its siblings the same tokens by name.
 */
export function tokensFromEnv(env = process.env) {
  const out = []
  for (const [k, v] of Object.entries(env)) {
    if (!/^SUPABASE_TOKEN_[A-Z0-9_]+$/.test(k)) continue
    const token = String(v || '').trim()
    if (token) out.push({ token, id: k })
  }
  return out
}

export async function sweep({ fetchImpl = fetch, tokens, withMeta = false } = {}) {
  const seen = new Map()
  // Env first: on CI it is the only source, and on a workstation a token passed in deliberately
  // should beat one found by scanning. Both are de-duplicated by project ref below anyway.
  const fromEnv = tokensFromEnv()
  const list = tokens ?? (fromEnv.length ? fromEnv : discoverLocalTokens())
  for (const t of list) {
    const { projects } = await projectsFor(t.token, { fetchImpl })
    for (const p of projects) if (!seen.has(p.ref)) seen.set(p.ref, { name: p.name, token: t.token })
  }
  const audits = []
  for (const [ref, p] of seen) {
    const loaded = await loadProject(ref, p.token, { fetchImpl })
    if (!loaded) continue
    audits.push(auditProject({ name: p.name, ref, ...loaded }))
  }
  // The caller needs to tell "no token to look with" apart from "looked and every project
  // refused", and an array of audits cannot say which happened. Opt-in so every existing
  // caller and test keeps the plain array.
  return withMeta ? { audits, tokens: list.length } : audits
}

// WHY THIS IS NOT `import.meta.url === pathToFileURL(process.argv[1]).href` (2026-09-03).
//
// That is the idiom the rest of this repo uses, and it is the idiom this file shipped with. It
// worked on the development machine and did NOT fire on the CI runner: the job printed a single
// line of injector noise, exited 0, and the ratchet in
// test/a-check-cannot-pass-without-reaching-its-dependency.test.mjs failed all four faults with
// "reported a PASS ... verdict NONE DECLARED" over an EMPTY stdout. Empty stdout is the proof —
// the judgement below, which already returns `inconclusive` for a sweep that judged nothing, was
// never reached at all. Comparing two URL STRINGS compares two spellings of a path; percent
// encoding, a symlinked checkout and a relative argv[1] each make the same file spell itself two
// ways. Comparing the two REALPATHS asks the filesystem instead, which has one answer.
//
// A check that cannot run is the purest form of a job reporting success for doing nothing, and it
// is invisible precisely because there is no output to be suspicious of.
function invokedDirectly() {
  const arg = process.argv[1]
  if (!arg) return false
  const real = (p) => { try { return realpathSync(p) } catch { return p } }
  return real(fileURLToPath(import.meta.url)) === real(arg)
}

if (invokedDirectly()) {
  const { audits, tokens } = await sweep({ withMeta: true })
  for (const a of audits) {
    const mark = a.failures.length ? 'FAIL' : a.warnings.length ? 'warn' : ' ok '
    console.log(`[${mark}] ${a.name} (${a.ref}) — ${a.checked} credentials judged, legacy keys ${a.legacyDisabled ? 'disabled' : 'enabled'}`)
    for (const r of [...a.failures, ...a.warnings]) console.log(`         ${r.level.toUpperCase()} ${r.name}: ${r.reason}`)
  }
  const s = summarise(audits)
  console.log(`
${s.projects} projects, ${s.checked} credentials judged, ${s.failing} failing, ${s.warnings} warnings — ${s.verdict.toUpperCase()}`)

  // Three states, never two. "It judged nothing" is not "nothing is wrong": say WHICH kind of
  // blindness it was, because "no management token on this host" is a deployment mistake and
  // "every project refused to load" is an outage, and they need different people.
  if (s.verdict === 'inconclusive') {
    const why = tokens === 0
      ? 'no Supabase management token is readable on this host, so not one project was looked at'
      : `${tokens} management token(s) found, but every project failed to load — nothing was judged`
    sayVerdict(UNKNOWN, why)
    console.log(`INCONCLUSIVE: ${why}`)
    process.exit(1)
  }
  if (s.verdict === 'fail') {
    sayVerdict(FAIL, `${s.failing} project(s) present a key their own project no longer recognises`)
    process.exit(1)
  }
  sayVerdict(PASS, `${s.checked} credentials across ${s.projects} projects all recognised by their own project`)
  process.exit(0)
}
