#!/usr/bin/env node
// ============================================================================
// The monitor signs in as MORE THAN ONE account, so it has to sign out of more than one.
//
// 2026-08-29 shipped a teardown that revokes the monitor's sessions after every run, and it
// worked - for TEST_EMAIL. But tests/backoffice/production-monitor.spec.ts:177 does a real
// magic-link login as OTP_TEST_EMAIL, which .github/workflows/monitor.yml:237 sets to the
// IMAP_USER mailbox (noreply@backoffice.predivo.ch), a different address from the TEST_EMAIL
// on :245. Nothing ever signed THAT one out.
//
// Result: 1,682 live sessions for noreply@backoffice.predivo.ch on a project with 8 real
// users, still growing after the "the monitor now signs out" fix had shipped - which is why
// the leak was reported as "not the production-monitor". The monitor did sign out. Just not
// as this user.
//
// These cases fail if the second identity is ever dropped again.
//   node test/revoke-sessions-identities.test.mjs
// ============================================================================
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

let pass = 0
let fail = 0
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  PASS  ${name}`) }
  catch (e) { fail++; console.log(`  FAIL  ${name}\n        ${e.message}`) }
}

const src = fs.readFileSync(path.join(root, 'lib', 'revokeSessions.ts'), 'utf8')

// --- structural guarantees, no execution needed -----------------------------
t('the teardown collects identities instead of hardcoding one email', () => {
  assert.ok(/export function testIdentities/.test(src), 'testIdentities() is gone')
  assert.ok(/const emails = testIdentities\(\)/.test(src), 'globalTeardown no longer calls testIdentities()')
})

t('OTP_TEST_EMAIL is one of the identities that gets signed out', () => {
  assert.ok(/env\.OTP_TEST_EMAIL/.test(src), 'OTP_TEST_EMAIL is not collected - the BackOffice magic-link login would leak again')
})

t('IMAP_USER is collected too, because that is the spec\'s own fallback', () => {
  assert.ok(/env\.IMAP_USER/.test(src), 'IMAP_USER is not collected; the spec falls back to it when OTP_TEST_EMAIL is unset')
})

t('every project is crossed with every identity, not just the first', () => {
  assert.ok(/flatMap/.test(src), 'the project list is no longer crossed with the identity list')
})

// --- behaviour of testIdentities(), run for real ----------------------------
// Node 24 strips TypeScript types on import, so the real function is loaded and run rather
// than a second copy of its logic that would drift from it.
let testIdentities = null
try {
  ;({ testIdentities } = await import(`file://${path.join(root, 'lib', 'revokeSessions.ts').replace(/\\/g, '/')}`))
} catch (e) {
  console.log(`  FAIL  the module could not be loaded: ${e.message.split('\n')[0]}`)
  fail++
}

if (testIdentities) {
  t('both accounts are returned when the workflow sets them, as monitor.yml does', () => {
    const got = testIdentities({ TEST_EMAIL: 'healthcheck-test@predivo.ch', OTP_TEST_EMAIL: 'noreply@backoffice.predivo.ch' })
    assert.deepEqual(got.sort(), ['healthcheck-test@predivo.ch', 'noreply@backoffice.predivo.ch'])
  })

  t('the same address set twice is revoked once, not twice', () => {
    const got = testIdentities({ TEST_EMAIL: 'a@b.ch', OTP_TEST_EMAIL: 'a@b.ch', IMAP_USER: 'a@b.ch' })
    assert.deepEqual(got, ['a@b.ch'])
  })

  t('the IMAP_USER fallback is covered when OTP_TEST_EMAIL is unset', () => {
    const got = testIdentities({ TEST_EMAIL: 'a@b.ch', IMAP_USER: 'noreply@backoffice.predivo.ch' })
    assert.ok(got.includes('noreply@backoffice.predivo.ch'))
  })

  t('an empty or malformed value never becomes an identity to revoke', () => {
    const got = testIdentities({ TEST_EMAIL: 'a@b.ch', OTP_TEST_EMAIL: '', IMAP_USER: 'not-an-email' })
    assert.deepEqual(got, ['a@b.ch'])
  })

  t('with nothing configured it still falls back to the documented default', () => {
    assert.deepEqual(testIdentities({}), ['healthcheck-test@predivo.ch'])
  })
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
