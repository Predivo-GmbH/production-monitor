/**
 * Unit test for the Supabase management-token ownership fallback.
 *
 * THE 2026-08-30 BUG: the monitor went red EVERY HOUR because
 * YTMIGRATION_SUPABASE_ACCESS_TOKEN returned 401 for project qswluvqunswggfmesdcs,
 * so ChannelMover's edge-function discovery could not run. Nothing was wrong with
 * ChannelMover: a DIFFERENT token in the very same environment could read that
 * project, and the same hourly run proved it by listing ChannelMover as current.
 * The check failed because it trusted a token NAME, and a name is only a guess
 * about which account owns a project. The auth-email guard failed the same way on
 * LaunchReady in its own workflow.
 *
 * These cases pin the rule that came out of it: a pinned token is a hint, not a
 * fact; a refusal means ASK THE OTHERS; and "no token here can see it" is a
 * genuinely different finding from "the pinned one was wrong", because the first
 * needs a person and the second only needs the label repaired.
 *
 * The last case exists because of the 2026-08-30 watchdog lesson: exitDecision()
 * was exported, documented and unit-tested while the CLI had quietly stopped
 * calling it. A green test on a function nothing invokes proves nothing, so this
 * also asserts the two real callers still route through this module.
 *
 * Run: node test/supabase-token.test.mjs   (exit 0 = all pass)
 */
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { findTokenForProject, isTokenRefused, managementTokenKeys } from '../scripts/lib/supabase-token.mjs'

let passed = 0
let failed = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   - ${name}`); passed++ }
  catch (e) { console.log(`  FAIL - ${name}: ${e.message}`); failed++ }
}

/** Stand in for the Management API: each token sees exactly the refs it owns. */
const stubApi = (owned) => {
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://api.supabase.com/v1/projects')
    const token = String(init.headers.Authorization).replace('Bearer ', '')
    const refs = owned[token]
    if (!refs) return { ok: false, status: 401, json: async () => ({}) }
    return { ok: true, status: 200, json: async () => refs.map((ref) => ({ ref })) }
  }
}
const realFetch = globalThis.fetch

await check('only token-shaped env vars are candidates, and empty ones are not', () => {
  const keys = managementTokenKeys({
    SUPABASE_TOKEN_CHANNELMOVER: 'a',
    YTMIGRATION_SUPABASE_ACCESS_TOKEN: 'b',
    SUPABASE_ACCESS_TOKEN: 'c',
    SUPABASE_TOKEN_EMPTY: '',
    BACKOFFICE_ANON_KEY: 'not-a-management-token',
    BACKOFFICE_URL: 'https://backoffice.predivo.ch',
  })
  assert.deepEqual(keys, ['SUPABASE_ACCESS_TOKEN', 'SUPABASE_TOKEN_CHANNELMOVER', 'YTMIGRATION_SUPABASE_ACCESS_TOKEN'])
})

await check('the real 2026-08-30 case: the pinned token is refused, a sibling owns the project', async () => {
  stubApi({ 'live-channelmover': ['qswluvqunswggfmesdcs'] })
  const found = await findTokenForProject('qswluvqunswggfmesdcs', {
    YTMIGRATION_SUPABASE_ACCESS_TOKEN: 'dead-ytmigration',
    SUPABASE_TOKEN_CHANNELMOVER: 'live-channelmover',
  }, 'YTMIGRATION_SUPABASE_ACCESS_TOKEN')
  assert.equal(found.key, 'SUPABASE_TOKEN_CHANNELMOVER')
  assert.equal(found.token, 'live-channelmover')
})

await check('the token already refused is never blamed twice', async () => {
  stubApi({ 'pinned-but-wrong-project': ['some-other-ref'] })
  const found = await findTokenForProject('some-other-ref', {
    SUPABASE_TOKEN_LAUNCHREADY: 'pinned-but-wrong-project',
  }, 'SUPABASE_TOKEN_LAUNCHREADY')
  assert.equal(found, null, 'the skipped key must not be handed back as the fallback')
})

await check('no token can see the project — a person is needed, not a retry', async () => {
  stubApi({ 'sees-nothing-useful': ['unrelated-ref'] })
  const found = await findTokenForProject('hcfeoescybfngjsphekq', {
    SUPABASE_TOKEN_LAUNCHREADY: 'sees-nothing-useful',
  })
  assert.equal(found, null)
})

await check('a dead token sees nothing rather than throwing', async () => {
  stubApi({}) // every token 401s
  const found = await findTokenForProject('qswluvqunswggfmesdcs', { SUPABASE_TOKEN_X: 'revoked' })
  assert.equal(found, null)
})

await check('only 401/403 mean "wrong token" — a 500 is about the project', () => {
  assert.equal(isTokenRefused(401), true)
  assert.equal(isTokenRefused(403), true)
  assert.equal(isTokenRefused(500), false)
  assert.equal(isTokenRefused(404), false)
})

await check('both real callers actually route through this module', () => {
  const guard = readFileSync(new URL('../scripts/check-auth-email-config.mjs', import.meta.url), 'utf8')
  assert.match(guard, /from '\.\/lib\/supabase-token\.mjs'/, 'auth-email guard must import the resolver')
  assert.match(guard, /await readAuthConfig\(/, 'auth-email guard must call the falling-back reader, not getAuthConfig directly')

  const edge = readFileSync(new URL('../lib/edgeFunctions.ts', import.meta.url), 'utf8')
  assert.match(edge, /from '\.\/supabaseToken'/, 'edge-function discovery must import the resolver')
  assert.match(edge, /await findTokenForProject\(/, 'edge-function discovery must actually call it')

  // The specs must not reinstate the "this exact token must be set" gate that
  // turned one stale label into an hourly red run.
  for (const p of ['backoffice', 'replyflow', 'signalscore', 'valrano', 'ytmigration']) {
    const spec = readFileSync(new URL(`../tests/${p}/production-monitor.spec.ts`, import.meta.url), 'utf8')
    assert.doesNotMatch(spec, /cannot discover deployed functions/, `${p} still gates on one token name`)
  }
})

await check('a missing/empty pinned secret is still reported, not silently worked around', () => {
  // The 2026-08-30 blind-spot regression: readAuthConfig returned
  // `fellBackFrom: pinned ? pinnedKey : null`, so a DELETED or never-renewed
  // SUPABASE_TOKEN_<ACCT> (in CI an undefined secret expands to '') resolved via a
  // sibling token and produced no STALE TOKEN NAMES line and no UNAUDITED line — the
  // run stayed green while another account's PAT did the audit. The commit's own
  // invariant is "The fallback is always REPORTED". So the fallback must be flagged
  // whether the pinned token was refused OR absent, and the message must tell them
  // apart ("is not set" vs "is no longer accepted").
  const guard = readFileSync(new URL('../scripts/check-auth-email-config.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(guard, /fellBackFrom:\s*pinned\s*\?/, 'the fallback must be reported even when the pinned secret was absent, not only when it was refused')
  assert.match(guard, /is not set/, 'the missing-secret shape must be worded and surfaced in STALE TOKEN NAMES')
})

globalThis.fetch = realFetch
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
