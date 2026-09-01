/**
 * THE SECRET STORE IS THE ONE PLACE test/no-control-bytes.test.mjs CANNOT LOOK.
 *
 * That guard scans every authored file in the repo for invisible bytes, and it shipped on
 * 2026-09-01 after a BACKSPACE byte in a Valrano spec reported a working login as broken. Hours
 * later the monitor went red again on the same class of defect, in the one place a file-scanner
 * structurally cannot reach: a GitHub Actions secret. JASSTOUR_SERVICE_ROLE_KEY had been stored
 * with a leading UTF-8 BOM, so every request built from it was unsendable, and the two checks
 * that used it failed in two different vocabularies that both hid the cause:
 *
 *   "Failed to create test user: Cannot convert argument to a ByteString because the character
 *    at index 7 has a value of 65279 which is greater than 255."
 *   "UNREADABLE  JASSTOUR  metrics endpoint returned no usable sample"
 *
 * These tests pin scripts/lib/credentials.mjs, which repairs such a value in memory and says so.
 *
 * NO DEPENDENCIES, ON PURPOSE. .github/workflows/test.yml runs deliberately without `npm ci` —
 * see f2b5b85, where a guard's own test died importing nodemailer before it reached the decision
 * under test. node:test, node:assert and the module itself are all this may use.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  inspectCredential,
  isWireValueName,
  repairMessage,
  sanitizeEnv,
  sanitizeEnvAndReport,
} from '../scripts/lib/credentials.mjs'

/** Built from a code point, never typed, so this file stays free of the bytes it is about. */
const BOM = String.fromCharCode(0xfeff)
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b)
const BACKSPACE = String.fromCharCode(0x08)
const KEY = 'sb_secret_ExampleNotARealKey'

/**
 * THE REGRESSION ITSELF, reproduced without a secret and without the network.
 *
 * "Bearer " is seven characters, so a BOM at the front of the key lands at index 7 — which is
 * why the production error said index 7 and why that number pointed at the key rather than at
 * anything in the repo. If this ever stops throwing, undici has changed and the rest of this
 * file is about a problem that no longer exists.
 */
test('a BOM-prefixed key cannot be put in a header, and the repaired one can', () => {
  assert.throws(
    () => new Headers({ Authorization: `Bearer ${BOM}${KEY}` }),
    /65279/,
    'undici must still refuse a header value containing U+FEFF — this is the production failure',
  )

  const { clean } = inspectCredential(BOM + KEY)
  assert.doesNotThrow(() => new Headers({ Authorization: `Bearer ${clean}`, apikey: clean }))
})

test('the repaired value is the original key, byte for byte', () => {
  assert.equal(inspectCredential(BOM + KEY).clean, KEY)
})

test('a clean value is returned unchanged and reported as untouched', () => {
  const result = inspectCredential(KEY)
  assert.equal(result.clean, KEY)
  assert.equal(result.repaired, false)
  assert.deepEqual(result.removals, [])
})

test('the report names the character and its position, and never the value', () => {
  const { removals } = inspectCredential(BOM + KEY)
  assert.deepEqual(removals, ['U+FEFF at the start'])

  // The whole log line, as it will appear in a public CI log. A credential's length is itself
  // worth knowing to an attacker, so neither the value nor its length may appear.
  const line = repairMessage({ name: 'JASSTOUR_SERVICE_ROLE_KEY', removals })
  assert.match(line, /JASSTOUR_SERVICE_ROLE_KEY/)
  assert.match(line, /U\+FEFF/)
  assert.ok(!line.includes(KEY), 'the value must never reach the log')
  assert.ok(!line.includes(String(KEY.length)), 'the length must never reach the log either')
})

/**
 * THE TRAILING BYTE, which the leading-BOM case above structurally cannot guard: a BOM at index 0
 * happens not to equal the length, so "at position 0" passed the no-length-leak assertion while a
 * byte at the END -- the classic "echo adds a newline, and the newline goes into the secret" --
 * reported its raw index, and that index IS the key's length. This case is here so the promise at
 * credentials.mjs:94-96 is guarded from both ends, not just the front.
 */
test('a TRAILING invisible byte reports its location without leaking the value length', () => {
  const { removals } = inspectCredential(KEY + '\n')
  assert.deepEqual(removals, ['U+000A at the end'])

  const line = repairMessage({ name: 'JASSTOUR_SERVICE_ROLE_KEY', removals })
  assert.match(line, /U\+000A/)
  assert.ok(!line.includes(String(KEY.length)), 'the length must never reach the log, even for a byte at the very end')
})

test('the other invisible characters this fleet has actually been bitten by are caught', () => {
  // 2026-08-31: a BEL byte in eight run-*.ps1 paths. 2026-09-01: a BACKSPACE in a spec.
  assert.equal(inspectCredential(`${BACKSPACE}${KEY}`).clean, KEY)
  assert.equal(inspectCredential(`${ZERO_WIDTH_SPACE}${KEY}`).clean, KEY)
  // The classic: echo adds a newline, and the newline goes into the secret.
  assert.equal(inspectCredential(`${KEY}\n`).clean, KEY)
  assert.equal(inspectCredential(`  ${KEY}  `).clean, KEY)
})

/**
 * WE REMOVE EXACTLY WHAT A HUMAN CANNOT SEE, AND NOTHING ELSE.
 *
 * A space in the middle of a key normally means two values got pasted together. That must keep
 * failing loudly rather than be silently welded into something almost-plausible, so interior
 * VISIBLE whitespace is preserved. This is also what keeps comma-and-space separated lists like
 * HEALTHCHECKS_API_KEYS intact.
 */
test('interior visible whitespace is preserved, so a pasting mistake still fails loudly', () => {
  assert.equal(inspectCredential('key_one key_two').clean, 'key_one key_two')
  assert.equal(inspectCredential('hcr_a, hcr_b').clean, 'hcr_a, hcr_b')
})

test('wire-value names are matched by whole segment, so the ordinary environment is safe', () => {
  for (const name of ['JASSTOUR_SERVICE_ROLE_KEY', 'SUPABASE_TOKEN_ARIVIOO', 'IMAP_PASS', 'OTP_TEST_EMAIL', 'BOARD_SUPABASE_SECRET', 'DASHBOARD_PAT', 'HEALTHCHECKS_API_KEYS', 'VALRANO_SUPABASE_URL']) {
    assert.equal(isWireValueName(name), true, `${name} should be treated as a wire value`)
  }
  // PATH is not PAT and HOSTNAME is not HOST. Being matched would be harmless, but a predicate
  // that is precise about what it claims to cover is one that can be reasoned about.
  for (const name of ['PATH', 'HOSTNAME', 'HOME', 'NODE_OPTIONS', 'GITHUB_REPOSITORY']) {
    assert.equal(isWireValueName(name), false, `${name} should not be treated as a wire value`)
  }
})

test('sanitizeEnv repairs in place, touches nothing else, and reports what it did', () => {
  const env = {
    JASSTOUR_SERVICE_ROLE_KEY: BOM + KEY,
    JASSTOUR_ANON_KEY: KEY,
    PATH: `C:/bin${BOM}`,
    EMPTY_KEY: '',
  }
  const report = sanitizeEnv(env)

  assert.equal(env.JASSTOUR_SERVICE_ROLE_KEY, KEY, 'the broken secret is repaired')
  assert.equal(env.JASSTOUR_ANON_KEY, KEY, 'an already-clean secret is left exactly as it was')
  assert.equal(env.PATH, `C:/bin${BOM}`, 'a non-wire variable is never rewritten')
  assert.equal(env.EMPTY_KEY, '', 'an unset secret stays unset rather than becoming a value')
  assert.deepEqual(report, [{ name: 'JASSTOUR_SERVICE_ROLE_KEY', removals: ['U+FEFF at the start'] }])
})

/**
 * A SILENT REPAIR WOULD BE THE WORSE BUG. The stored secret is still defective after this module
 * rescues a run from it, and every OTHER consumer of that secret — the product's own deploys, the
 * keep-alive workflows, the next repo to copy it — is still broken. The log line is the only
 * thing that will ever get it fixed at source, which is the same rule lib/supabaseToken.ts
 * follows when it falls back to a working token and names the stale one anyway.
 */
test('a repair is always announced, and a clean environment says nothing at all', () => {
  const said = []
  sanitizeEnvAndReport({ A_KEY: BOM + KEY }, (m) => said.push(m))
  assert.equal(said.length, 1)
  assert.match(said[0], /A_KEY/)
  assert.match(said[0], /STILL WRONG/)

  const quiet = []
  sanitizeEnvAndReport({ A_KEY: KEY }, (m) => quiet.push(m))
  assert.deepEqual(quiet, [], 'a clean environment must not produce a warning nobody can act on')
})

/**
 * ANTI-ROT, the same idea test/no-control-bytes.test.mjs uses on its own detector: assert that
 * the thing under test can still fail. Every other assertion here would keep passing if
 * inspectCredential() were reduced to `value => ({ clean: value, removals: [], repaired: false })`
 * for a clean input, so one case must prove the detector still detects.
 */
test('the detector still detects — this suite cannot rot into a no-op', () => {
  const result = inspectCredential(BOM + KEY)
  assert.equal(result.repaired, true)
  assert.notEqual(result.clean, BOM + KEY)
  assert.ok(result.removals.length > 0)
})
