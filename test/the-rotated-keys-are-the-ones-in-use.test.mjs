#!/usr/bin/env node
/**
 * THE KEYS THAT WERE LEAKED ARE DEAD, AND THE ONES IN USE ARE THE REPLACEMENTS.
 *
 * WHY THIS IS A TEST AND NOT A NOTE (2026-09-03). On 2026-09-02 both ReplyFlow's and SignalScore's
 * service keys were written into a chat, rotated, and the old ones revoked. That rotation then took
 * ReplyFlow production down for 93 minutes, because it updated `SUPABASE_SERVICE_ROLE_KEY` in the
 * edge env and left the revoked value in `SB_SECRET_KEY`, which every function reads FIRST:
 *
 *     Deno.env.get('SB_SECRET_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
 *
 * `??` returns the left side whenever it is SET; it has no opinion about whether the value works.
 *
 * Verifying that by hand produced a written report and a row asking Roger to confirm it — a rubber
 * stamp for work a machine can re-check. His answer, and the reason this file exists: *"why do you
 * even request an answer from me? Don't you know the answer yourself?"* So the verification is now
 * executable. Re-run it and it re-proves the rotation from scratch.
 *
 * WHAT IT ASSERTS, per project:
 *   1. The project recognises exactly ONE secret key, and it is the replacement by name.
 *   2. That key actually works — PostgREST and the auth admin API both answer 200. A key that
 *      lists is not a key that works; the rotation's own worst moment was a newly created key
 *      that answered 401 because the creation response is not the usable value.
 *   3. The edge runtime holds the SAME value in both variables, so nothing shadows the fallback.
 *   4. The product's own credentials file carries that key and no other secret-shaped value, so a
 *      later session cannot pick a revoked one out of it.
 *
 * AND ONE THING IT DELIBERATELY DOES NOT DO. `GET /v1/projects/{ref}/secrets` returns a SHA-256
 * HASH, not the value — 64 hex chars, and presenting it to PostgREST answers 401. Digesting it and
 * comparing against the live key is comparing a hash to a value, and it reports a false emergency
 * on a healthy project. Ask me how I know. So the two edge variables are only ever compared with
 * EACH OTHER, which is a valid comparison between two values of the same kind.
 *
 * No secret value is ever printed. Keys are handed straight to their target; only names, counts,
 * HTTP statuses and 8-char digests appear.
 *
 * NEEDS: a Supabase management token on this disk that can open each project. On a machine without
 * one — this repo's own ubuntu CI — there is nothing to verify, and the suite says so LOUDLY and
 * exits 0 rather than fabricating either a pass or a red. Same contract as
 * test/status-docs-carry-no-passwords.test.mjs.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { tokenForProject } from '../scripts/lib/local-management-tokens.mjs'

const digest = (v) => createHash('sha256').update(String(v)).digest('hex').slice(0, 8)
const MGMT = 'https://api.supabase.com'

/** The replacement minted on 2026-09-02. If it is ever rotated again, this name moves with it. */
export const EXPECTED_KEY_NAME = 'rotated_2026_09_02'

const PROJECTS = [
  { name: 'ReplyFlow', ref: 'dqmhsdzldkxngwjrxois', creds: 'C:\\Business\\Internal Projects\\replyflow\\docs\\Credentials.txt' },
  { name: 'SignalScore', ref: 'ogdpgufptemcgyszmjek', creds: 'C:\\Business\\Internal Projects\\signalscore\\docs\\Credentials.txt' },
]

let failures = 0
let checked = 0
const ok = (name, fn) => {
  checked++
  try { fn(); console.log(`  ok - ${name}`) } catch (e) {
    failures++
    console.log(`  NOT OK - ${name}`)
    console.log(`      ${e.message.split('\n').slice(0, 3).join('\n      ')}`)
  }
}

/**
 * The shape rule, extracted so it is testable without the network: two edge variables that must
 * hold the same credential. Exported for the defect-injection case below.
 */
export function edgePairVerdict(sbSecret, serviceRoleKey) {
  if (sbSecret === undefined || sbSecret === null) {
    return { ok: true, reason: 'SB_SECRET_KEY is not set, so nothing shadows the fallback' }
  }
  if (serviceRoleKey === undefined || serviceRoleKey === null) {
    return { ok: false, reason: 'SUPABASE_SERVICE_ROLE_KEY is missing entirely' }
  }
  return sbSecret === serviceRoleKey
    ? { ok: true, reason: 'both variables hold the same value' }
    : { ok: false, reason: 'SB_SECRET_KEY differs from SUPABASE_SERVICE_ROLE_KEY — the value that is READ FIRST is not the one that was updated' }
}

console.log('\nTHE PAIR RULE (offline, so it is proven even where no token exists)')
ok('two matching edge variables pass', () => {
  assert.equal(edgePairVerdict('abc', 'abc').ok, true)
})
ok('THE 2026-09-02 OUTAGE: a shadowing SB_SECRET_KEY that differs is a FAILURE', () => {
  const v = edgePairVerdict('the-revoked-one', 'the-live-one')
  assert.equal(v.ok, false)
  assert.match(v.reason, /READ FIRST/)
})
ok('an unset SB_SECRET_KEY is fine — nothing shadows the fallback', () => {
  assert.equal(edgePairVerdict(undefined, 'abc').ok, true)
})
ok('a missing SUPABASE_SERVICE_ROLE_KEY is a failure, not a pass', () => {
  assert.equal(edgePairVerdict('abc', null).ok, false)
})

console.log('\nTHE LIVE ROTATION')

let reachable = 0
for (const p of PROJECTS) {
  let token = null
  try {
    const found = await tokenForProject(p.ref)
    token = found?.token || found
  } catch { token = null }
  if (!token) {
    console.log(`  (${p.name}: no management token on this machine can open it — not checked)`)
    continue
  }
  reachable++
  const H = { Authorization: `Bearer ${token}` }

  const keyRes = await fetch(`${MGMT}/v1/projects/${p.ref}/api-keys?reveal=true`, { headers: H })
  ok(`${p.name}: the key list is readable (a failed read is never a clean result)`, () => {
    assert.equal(keyRes.ok, true, `api-keys returned HTTP ${keyRes.status}`)
  })
  if (!keyRes.ok) continue
  const keys = await keyRes.json()
  const secrets = keys.filter((k) => k.type === 'secret')

  ok(`${p.name}: exactly ONE secret key exists, and it is "${EXPECTED_KEY_NAME}"`, () => {
    assert.equal(secrets.length, 1, `found ${secrets.length} secret keys: ${secrets.map((s) => s.name).join(', ')}`)
    assert.equal(secrets[0].name, EXPECTED_KEY_NAME)
  })
  const live = secrets[0]
  if (!live) continue

  const rest = await fetch(`https://${p.ref}.supabase.co/rest/v1/`, {
    headers: { apikey: live.api_key, Authorization: `Bearer ${live.api_key}` },
  })
  const admin = await fetch(`https://${p.ref}.supabase.co/auth/v1/admin/users?page=1&per_page=1`, {
    headers: { apikey: live.api_key, Authorization: `Bearer ${live.api_key}` },
  })
  ok(`${p.name}: that key WORKS — a key that lists is not a key that works`, () => {
    assert.equal(rest.status, 200, `PostgREST answered ${rest.status}`)
    assert.equal(admin.status, 200, `auth admin answered ${admin.status}`)
  })

  const secRes = await fetch(`${MGMT}/v1/projects/${p.ref}/secrets`, { headers: H })
  ok(`${p.name}: the edge runtime env is readable`, () => {
    assert.equal(secRes.ok, true, `secrets returned HTTP ${secRes.status}`)
  })
  if (secRes.ok) {
    const env = Object.fromEntries((await secRes.json()).map((s) => [s.name, s.value]))
    ok(`${p.name}: nothing shadows the updated key in the deployed runtime`, () => {
      const v = edgePairVerdict(env.SB_SECRET_KEY, env.SUPABASE_SERVICE_ROLE_KEY)
      assert.equal(v.ok, true, v.reason)
    })
  }

  ok(`${p.name}: its credentials file carries the live key and no other secret-shaped value`, () => {
    assert.equal(existsSync(p.creds), true, `credentials file not found at the expected path`)
    const text = readFileSync(p.creds, 'utf8')
    const tokens = text.match(/[A-Za-z0-9._-]{20,}/g) || []
    const liveDigest = digest(live.api_key)
    const carries = tokens.filter((c) => digest(c) === liveDigest).length
    const secretShaped = tokens.filter((c) => /^sb_secret_/.test(c))
    const stale = secretShaped.filter((c) => digest(c) !== liveDigest)
    assert.ok(carries > 0, 'the file does not carry the live secret key')
    assert.equal(stale.length, 0, `the file also holds ${stale.length} secret-shaped value(s) that are not the live key`)
  })
}

if (reachable === 0) {
  console.log('\n  *** NOT RUN HERE, THIS PROVES NOTHING ***')
  console.log('  No Supabase management token on this machine opens either project, so the live half')
  console.log('  was SKIPPED, not passed. It runs for real on the machines that hold the fleet.')
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${checked} assertions, ${failures} failing, ${reachable} of ${PROJECTS.length} projects reachable\n`)
process.exit(failures === 0 ? 0 : 1)
