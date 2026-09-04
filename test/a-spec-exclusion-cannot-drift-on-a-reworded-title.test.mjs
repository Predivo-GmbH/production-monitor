/**
 * A GATE KEYED ON A SENTENCE IS SWITCHED OFF BY A REWRITE NOBODY CALLS A CHANGE.
 *
 *   node test/a-spec-exclusion-cannot-drift-on-a-reworded-title.test.mjs
 *
 * THE DEFECT (board 57ff3eb:spec-title-exclusion-couples-to-editable-literal, 2026-09-04).
 * reachedAnyProduct() is the breadth gate that stops one unreachable runner being mailed out as six
 * product outages. It must not count a spec that passes with NO network I/O. Commit 57ff3eb excluded
 * the one such spec inside api-health/auth-backends.spec.ts by its TITLE STRING:
 *
 *     new Set(['auth: at least 14 projects are actually being checked'])
 *
 * That is prose. Anyone may reword it, and the "14" in it is a floor that rises the moment the fleet
 * grows past fourteen products. Either edit leaves a green test suite and a dead exclusion: the
 * network-free spec starts counting as proof a product was reached, and a genuine total blackout is
 * relabelled "N failure(s) across N project(s)" — precisely the bug commit 37b7982 removed. Nothing
 * in the repo could observe that happening, because no test tied the string in the library to the
 * string in the spec file.
 *
 * THE FIX IT PINS. The exclusion is keyed on a Playwright TAG (`{ tag: '@network-free' }`), which is
 * a machine-readable marker with no other purpose, and this file reads the REAL spec file off disk to
 * prove the two sides still agree. It fails if:
 *   - the tag is removed from the spec, or renamed on either side (the drift the old key could not see);
 *   - the keyed /auth/v1/health probes ever pick up the tag (that would discard the only breadth
 *     evidence a shared-web-host outage leaves behind — board 1d83704's over-correction);
 *   - the library stops honouring the tag.
 * And it asserts the property the old code did NOT have: rewording the title changes nothing.
 *
 * The floor spec is located by a CODE SYMBOL it references (MINIMUM_TARGETS) and the probe spec by
 * the endpoint it requests, never by their sentences — a test that identified them by prose would
 * have the same defect it is here to prevent.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NON_PRODUCT_SPEC_TAG, reachedAnyProduct } from '../scripts/lib/parse-failures.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SPEC = join(ROOT, 'tests', 'api-health', 'auth-backends.spec.ts')

let passed = 0
const check = (name, fn) => {
  try { fn(); passed++; console.log(`PASS  ${name}`) }
  catch (err) { process.exitCode = 1; console.error(`FAIL  ${name}\n      ${err.message}`) }
}

/** Split the spec source into one block per `test(...)` declaration, keyed on nothing but syntax. */
function testBlocks(src) {
  const starts = []
  const re = /^[ \t]*test\(/gm
  for (let m = re.exec(src); m; m = re.exec(src)) starts.push(m.index)
  return starts.map((s, i) => src.slice(s, starts[i + 1] ?? src.length))
}

/** Does this declaration carry the exclusion tag, in either quoting style? */
const carriesTag = (block) => new RegExp(String.raw`\btag:\s*(['"\`])@${NON_PRODUCT_SPEC_TAG}\1`).test(block)

const src = readFileSync(SPEC, 'utf8')
const blocks = testBlocks(src)

check('the library exports a tag to key the exclusion on, not a sentence', () => {
  assert.equal(typeof NON_PRODUCT_SPEC_TAG, 'string')
  assert.ok(NON_PRODUCT_SPEC_TAG.length > 0, 'an empty tag would match nothing and silently disarm the gate')
  assert.ok(!NON_PRODUCT_SPEC_TAG.startsWith('@'), "Playwright's JSON reporter strips the '@'; store it stripped")
})

check('auth-backends.spec.ts still declares both kinds of spec', () => {
  assert.ok(blocks.length >= 2, `expected the floor spec and at least one keyed probe, found ${blocks.length} test() declarations`)
})

check('THE DRIFT GUARD: the network-free floor spec carries the exclusion tag', () => {
  // Located by the constant it asserts against, so rewording its title cannot move this test.
  const floor = blocks.filter((b) => b.includes('MINIMUM_TARGETS'))
  assert.equal(floor.length, 1, `expected exactly one spec asserting MINIMUM_TARGETS, found ${floor.length}`)
  assert.ok(carriesTag(floor[0]),
    `the floor spec in ${SPEC} no longer carries { tag: '@${NON_PRODUCT_SPEC_TAG}' }. `
    + 'Without it reachedAnyProduct() counts a spec that makes no request as proof a product was '
    + 'reached, and a total blackout is mailed out as N separate product outages.')
})

check('the keyed auth probes are NOT tagged - they are the real breadth evidence', () => {
  const probes = blocks.filter((b) => b.includes('/auth/v1/health'))
  assert.equal(probes.length, 1, `expected exactly one keyed probe declaration, found ${probes.length}`)
  assert.ok(!carriesTag(probes[0]),
    'tagging the keyed /auth/v1/health probe would discard the only breadth evidence a shared-web-host '
    + 'outage leaves (board 1d83704): every product spec fails at page.goto while Supabase still answers.')
})

check('a tagged passing spec is NOT counted as reaching a product', () => {
  const passedTest = { results: [{ status: 'passed' }] }
  const results = { suites: [{ title: 'api-health/auth-backends.spec.ts', suites: [{ title: 'Auth backends', specs: [
    { title: 'auth: at least 14 projects are actually being checked', tags: [NON_PRODUCT_SPEC_TAG], tests: [passedTest] },
  ] }] }] }
  assert.equal(reachedAnyProduct(results), false)
})

check('THE PROPERTY THE OLD KEY LACKED: rewording the title changes nothing', () => {
  // Same spec, same tag, a completely different sentence — and a floor of 15 rather than 14. Under the
  // title-keyed Set both of these silently re-armed the spec as breadth evidence. Under the tag they
  // are invisible, which is the entire point of the fix.
  const passedTest = { results: [{ status: 'passed' }] }
  const reworded = { suites: [{ title: 'api-health/auth-backends.spec.ts', suites: [{ title: 'Auth backends', specs: [
    { title: 'auth: we check at least 15 projects, and here is the count', tags: [NON_PRODUCT_SPEC_TAG], tests: [passedTest] },
  ] }] }] }
  assert.equal(reachedAnyProduct(reworded), false,
    'a reworded title must not resurrect a spec the tag excludes')
})

check("the '@'-prefixed spelling is tolerated too, so a reporter change cannot disarm the gate", () => {
  const passedTest = { results: [{ status: 'passed' }] }
  const results = { suites: [{ title: 'api-health/auth-backends.spec.ts', suites: [{ title: 'Auth backends', specs: [
    { title: 'anything at all', tags: [`@${NON_PRODUCT_SPEC_TAG}`], tests: [passedTest] },
  ] }] }] }
  assert.equal(reachedAnyProduct(results), false)
})

check('an UNTAGGED passing spec in the same file still counts - no over-exclusion', () => {
  const passedTest = { results: [{ status: 'passed' }] }
  const results = { suites: [{ title: 'api-health/auth-backends.spec.ts', suites: [{ title: 'Auth backends', specs: [
    { title: 'auth: at least 14 projects are actually being checked', tags: [NON_PRODUCT_SPEC_TAG], tests: [passedTest] },
    { title: 'auth backend answers, so a customer can log in: BACKOFFICE', tags: [], tests: [passedTest] },
  ] }] }] }
  assert.equal(reachedAnyProduct(results), true)
})

if (process.exitCode) console.error('\nat least one check failed.')
else console.log(`\n${passed} checks passed - the breadth-gate exclusion is keyed on a tag, and drift in it is visible.`)
