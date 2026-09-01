/**
 * NO SPEC MAY TYPE A SECRET INTO A PAGE WITHOUT GOING THROUGH lib/secretInput.
 *
 * WHY THIS EXISTS (2026-09-01). tests/jass-tour/user-password-login.spec.ts typed the monitor
 * account's real password into Jass-Tour's login form. The sign-in failed against production, and
 * Playwright wrote test-results/<test>/error-context.md — the accessibility snapshot it writes on
 * EVERY failure — which recorded the field as
 *
 *     - textbox "Passwort" [ref=e27]: <the account's real password, in plaintext>
 *
 * monitor.yml then published test-results/ as a downloadable CI artifact. The artifacts were
 * deleted and the secret rotated.
 *
 * THE MITIGATION THAT WAS ALREADY IN PLACE DID NOT HELP, and that is the reason for a guard
 * rather than a comment. Both password-typing specs carried `test.use({ trace: 'off' })`, added
 * for exactly this danger, and both carried a paragraph explaining that screenshots were safe
 * because a password field renders as dots. Both claims were true. The error-context attachment
 * is neither the trace nor a screenshot, so neither switch touched it. A defence assembled from a
 * list of Playwright's recording channels is only ever as good as the list, and nobody can prove
 * the list is complete.
 *
 * The rule that does not depend on that list is: THE SECRET MUST NOT BE SITTING IN THE DOM AT A
 * MOMENT AN ASSERTION CAN FAIL. lib/secretInput.ts's submitSecret() enforces it by blanking every
 * password input the instant the form is submitted, inside a `finally`.
 *
 * SO THE RULE HERE IS: a spec under tests/ that reads an env var whose NAME contains PASSWORD or
 * SECRET, and also calls .fill(), must import submitSecret from lib/secretInput. Two ways to
 * comply, both good: route the credential through the helper, or prove the credential without a
 * form at all — which is what the Jass-Tour spec now does, calling signInWithPassword from Node
 * and injecting the session, so it never types anything and never trips this rule.
 *
 * The rule is deliberately coarse. It does not try to prove that the secret is the value that
 * reaches .fill(), because a checker that reasons about dataflow is a checker that can be talked
 * out of a finding. Holding both a secret and a keyboard is enough to owe the helper.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// fileURLToPath, NOT .pathname. A repo path with a space in it ("Internal Projects") arrives
// percent-encoded from a URL, and readdirSync then fails on a directory that plainly exists.
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TESTS_DIR = join(ROOT, 'tests')

/**
 * `process.env.X_PASSWORD`, `process.env.MY_SECRET_KEY`, and the bracket forms of both. Anchored
 * on the ENV VAR NAME rather than on any local identifier: a spec is free to call the constant
 * `gate` or `pw`, but it cannot rename the secret it pulled out of the environment.
 */
const SECRET_ENV = /process\s*\.\s*env\s*(?:\.\s*[A-Za-z0-9_]*(?:PASSWORD|SECRET)[A-Za-z0-9_]*|\[\s*['"`][A-Za-z0-9_]*(?:PASSWORD|SECRET)[A-Za-z0-9_]*['"`]\s*\])/

/** Any keyboard-into-the-page call. `.fill(` is how every spec in this repo does it. */
const FILL_CALL = /\.fill\s*\(/

/** `import { submitSecret } from '../../lib/secretInput'`, in any member order or quote style. */
const IMPORTS_HELPER = /import\s*\{[^}]*\bsubmitSecret\b[^}]*\}\s*from\s*['"][^'"]*lib\/secretInput['"]/

/**
 * The detector, as a pure function of (path, source) so the test below can run it on a fixture
 * string. Returns a human-readable reason, or null when the file is fine.
 *
 * A guard whose detection has never been demonstrated proves only that it ran. Keeping this
 * separate from the filesystem walk is what makes demonstrating it possible.
 */
export function offence(rel, source) {
  const readsSecret = SECRET_ENV.test(source)
  const types = FILL_CALL.test(source)
  if (!readsSecret || !types) return null
  if (IMPORTS_HELPER.test(source)) return null
  return (
    `${rel} reads a PASSWORD/SECRET environment variable AND calls .fill(), but does not import ` +
    'submitSecret from lib/secretInput. Playwright writes the page\'s accessibility tree into ' +
    'test-results/<test>/error-context.md on every failure, and a password input contributes its ' +
    'VALUE to that tree, so a typed credential ends up in the uploaded CI artifact. Either submit ' +
    'it through submitSecret(), which blanks the field in the same breath, or prove the ' +
    'credential without a form (see tests/jass-tour/user-password-login.spec.ts).'
  )
}

function walk(dir, out = []) {
  let entries
  try { entries = readdirSync(dir) } catch { return out }
  for (const entry of entries) {
    const full = join(dir, entry)
    let st
    try { st = statSync(full) } catch { continue }
    if (st.isDirectory()) walk(full, out)
    else if (entry.endsWith('.ts') || entry.endsWith('.mjs') || entry.endsWith('.js')) out.push(full)
  }
  return out
}

test('no spec types a secret without lib/secretInput', () => {
  const files = walk(TESTS_DIR)
  assert.ok(files.length > 0, 'found no spec files at all under tests/ — this guard was scanning nothing')

  const offenders = []
  for (const file of files) {
    const rel = relative(ROOT, file).split(sep).join('/')
    const reason = offence(rel, readFileSync(file, 'utf8'))
    if (reason) offenders.push(reason)
  }
  assert.deepEqual(offenders, [], offenders.join('\n\n'))
})

test('the guard actually detects a typed secret', () => {
  // The shape of the code that leaked, reduced to its two load-bearing lines.
  const leaky = [
    "import { test, expect } from '@playwright/test'",
    "const PW = process.env.JASSTOUR_TEST_PASSWORD || ''",
    'await page.locator(\'input[type="password"]\').fill(PW)',
  ].join('\n')
  assert.ok(offence('tests/x/leaky.spec.ts', leaky), 'a spec that reads a PASSWORD env var and fills must be flagged')

  // The bracket form of the same read, so renaming the access style is not an escape hatch.
  const bracket = [
    "const PW = process.env['BOATBUDDY_GATE_PASSWORD']",
    'await field.fill(PW)',
  ].join('\n')
  assert.ok(offence('tests/x/bracket.spec.ts', bracket), 'process.env["..._PASSWORD"] must be flagged too')

  // ...and a SECRET-named var, since the rule covers both words.
  const secretName = "const K = process.env.SOME_SECRET_KEY\nawait f.fill(K)"
  assert.ok(offence('tests/x/secret.spec.ts', secretName), 'a *_SECRET_* env var must be flagged too')
})

test('the guard does not flag the compliant or the innocent', () => {
  const compliant = [
    "import { test, expect } from '@playwright/test'",
    "import { assertNoSecretInDom, submitSecret } from '../../lib/secretInput'",
    "const PW = process.env.BOATBUDDY_GATE_PASSWORD || ''",
    'await submitSecret(page, password, PW, page.locator(\'button[type="submit"]\'))',
    "await password.fill('definitely-not-the-gate-password')",
  ].join('\n')
  assert.equal(offence('tests/x/ok.spec.ts', compliant), null, 'importing submitSecret must satisfy the rule')

  // Holds a secret but never types: the Jass-Tour shape after the rewrite.
  const noTyping = [
    "const PW = process.env.JASSTOUR_TEST_PASSWORD || ''",
    'await client.auth.signInWithPassword({ email, password: PW })',
  ].join('\n')
  assert.equal(offence('tests/x/api.spec.ts', noTyping), null, 'a spec that never types must not be flagged')

  // Types plenty, holds nothing: every other spec in this repo.
  const noSecret = [
    "await emailInput.fill('test-monitor@example.com')",
    "await searchInput.fill('Messi')",
  ].join('\n')
  assert.equal(offence('tests/x/plain.spec.ts', noSecret), null, 'filling non-secret fields must not be flagged')

  // A near miss that must NOT count as compliance: importing something else from the module.
  const wrongImport = [
    "import { assertNoSecretInDom } from '../../lib/secretInput'",
    "const PW = process.env.GATE_PASSWORD",
    'await field.fill(PW)',
  ].join('\n')
  assert.ok(
    offence('tests/x/partial.spec.ts', wrongImport),
    'importing only assertNoSecretInDom is not the same as routing the secret through submitSecret',
  )
})

test('the guard is looking at the real specs, and at the two that hold secrets', () => {
  // A path typo would turn every assertion above into a green no-op over an empty list. This
  // pins the scan to files that must exist, and to the two specs the rule is actually about.
  const files = walk(TESTS_DIR).map((f) => relative(ROOT, f).split(sep).join('/'))
  for (const expected of [
    'tests/boatbuddy/site-password-gate.spec.ts',
    'tests/jass-tour/user-password-login.spec.ts',
  ]) {
    assert.ok(files.includes(expected), `${expected} was not scanned — the walk is not reaching the specs`)
  }

  const boatbuddy = readFileSync(join(ROOT, 'tests/boatbuddy/site-password-gate.spec.ts'), 'utf8')
  assert.ok(SECRET_ENV.test(boatbuddy), 'BoatBuddy still reads its gate password, so the rule still applies to it')
  assert.ok(IMPORTS_HELPER.test(boatbuddy), 'BoatBuddy types its secret, so it must route it through submitSecret')

  const jasstour = readFileSync(join(ROOT, 'tests/jass-tour/user-password-login.spec.ts'), 'utf8')
  assert.ok(SECRET_ENV.test(jasstour), 'Jass-Tour still reads its test password, so the rule still applies to it')
  assert.equal(
    FILL_CALL.test(jasstour),
    false,
    'Jass-Tour must not type anything: it proves the credential through signInWithPassword in Node ' +
      'precisely so no value ever reaches a field an accessibility snapshot could record',
  )
})
