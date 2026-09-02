#!/usr/bin/env node
/**
 * The invariant: a Playwright `waitForFunction` must actually wait as long as it says.
 *
 * Playwright's signature is waitForFunction(pageFunction, arg, options). Written with
 * two arguments — waitForFunction(fn, { timeout: 60_000 }) — the object becomes the ARG
 * handed to the browser callback and the timeout quietly falls back to
 * `use.actionTimeout` (playwright.config.ts:47 — 15s). Nothing throws and nothing warns.
 *
 * This was not hypothetical. All six call sites in tests/scoutcopilot/production-monitor.spec.ts
 * were written that way. The saved trace of the 2026-09-02 red monitor run
 * (33675914221 / 33678404644) records it exactly:
 *     "arg": {...{"k":"timeout","v":{"n":60000}}...},  "timeout": 15000
 * with the wait ending 15.0s after the click. ScoutCopilot's filter search answers in
 * 16-23s (measured against production: 15.8s server-side, 22.7s to the browser, 25.1s to
 * painted rows), so the test gave up before the answer and reported
 *     'search for "Messi" produced no result count ... within 60s — search pipeline down?'
 * The search pipeline was never down. The four other sites in that file happened to be
 * harmless only because they wanted 10-15s anyway, which is the coincidence that let the
 * mistake live: it is invisible until someone asks for longer than the action timeout.
 *
 * A timeout is a fact about the waiter, not about the thing waited on.
 *
 * The last case is the ratchet: it re-derives the property over EVERY spec and lib file,
 * including ones not written yet. The unit cases above it pin the rule in both directions,
 * because a ratchet that silently matches nothing is not a gate.
 *
 * Run: node test/waitforfunction-timeout.test.mjs   (exit 0 = all pass)
 */
import assert from 'node:assert'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  findWaitForFunctionCalls,
  looksLikeOptionsObject,
  misplacedOptionViolations,
} from '../scripts/lib/waitforfunction-args.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const tests = []
const t = (name, fn) => tests.push([name, fn])

// ── The rule itself, both directions ────────────────────────────────────────────

t('the exact bug is caught: options in the arg slot', () => {
  const src = `
    const got = await page.waitForFunction(
      () => document.querySelector('table tbody tr') !== null,
      { timeout: 60_000 },
    ).then(() => true).catch(() => false)
  `
  const calls = findWaitForFunctionCalls(src)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].argCount, 2)
  assert.equal(calls[0].misplacedOptions, true)
})

t('the correct three-argument form is NOT flagged', () => {
  const src = `await page.waitForFunction(() => true, undefined, { timeout: 60_000 })`
  assert.equal(findWaitForFunctionCalls(src)[0].misplacedOptions, false)
})

t('a real arg passed second is NOT flagged', () => {
  // lib/publicRoutes.ts does this: needles is genuine data for the callback.
  const src = `await page.waitForFunction((ns) => ns.length > 0, needles, { timeout: 5000 })`
  const c = findWaitForFunctionCalls(src)[0]
  assert.equal(c.argCount, 3)
  assert.equal(c.misplacedOptions, false)
})

t('a single-argument call is NOT flagged', () => {
  assert.equal(findWaitForFunctionCalls(`await page.waitForFunction(() => window.ready)`)[0].misplacedOptions, false)
})

t('polling is an option key too', () => {
  assert.equal(looksLikeOptionsObject('{ polling: 400 }'), true)
  assert.equal(looksLikeOptionsObject('{ timeout: 1, polling: 2 }'), true)
})

t('a non-options object second argument is left alone', () => {
  // A real arg that merely happens to be an object.
  assert.equal(looksLikeOptionsObject('{ selector: "#x" }'), false)
  assert.equal(looksLikeOptionsObject('needles'), false)
})

t('a nested timeout key does not count as top-level options', () => {
  assert.equal(looksLikeOptionsObject('{ opts: { timeout: 5 } }'), false)
})

// ── Parser robustness: the callbacks contain strings, regexes and commas ─────────

t('commas inside strings, regexes and nested calls do not split arguments', () => {
  const src = `
    await page.waitForFunction(
      () => {
        const rows = document.querySelectorAll('table tbody tr[role="link"]')
        return rows.length > 0 || /\\d+, \\d+/.test(document.body.textContent ?? '')
      },
      undefined,
      { timeout: 60_000 },
    )
  `
  const c = findWaitForFunctionCalls(src)[0]
  assert.equal(c.argCount, 3, `expected 3 args, got ${c.argCount}: ${JSON.stringify(c.args)}`)
  assert.equal(c.misplacedOptions, false)
})

t('division is not mistaken for a regex literal', () => {
  const src = `await page.waitForFunction(() => (a / b) > 1 && (c / d) < 2, undefined, { timeout: 10 })`
  assert.equal(findWaitForFunctionCalls(src)[0].argCount, 3)
})

// ── The ratchet ─────────────────────────────────────────────────────────────────

function sourceFiles() {
  const out = []
  const walk = (dir) => {
    for (const e of readdirSync(dir)) {
      if (e === 'node_modules' || e.startsWith('.')) continue
      const p = join(dir, e)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(ts|mts|mjs|js)$/.test(e) && !p.includes(`${'scripts'}${join('/', 'lib')}`)) out.push(p)
    }
  }
  for (const d of ['tests', 'lib']) walk(join(ROOT, d))
  return out
}

t('RATCHET: no waitForFunction in tests/ or lib/ passes options as the arg', () => {
  const files = sourceFiles()
  assert.ok(files.length > 5, `expected to scan several files, scanned ${files.length}`)

  const scanned = files.filter((f) => readFileSync(f, 'utf8').includes('waitForFunction'))
  assert.ok(
    scanned.length > 0,
    'scanned no file containing waitForFunction — the ratchet would pass vacuously',
  )

  const violations = scanned.flatMap((f) =>
    misplacedOptionViolations(readFileSync(f, 'utf8'), relative(ROOT, f).replace(/\\/g, '/')),
  )
  assert.deepEqual(
    violations,
    [],
    `waitForFunction options in the ARG slot — the wait silently uses actionTimeout instead:\n  ${violations.join('\n  ')}`,
  )
})

t('RATCHET is live: it still flags the shape it was built for', () => {
  // Guards the guard. If the scanner ever stops recognising the original bug, the
  // ratchet above would go green on a repo full of them.
  const original = `
    const gotResponse = await page.waitForFunction(
      () => {
        const body = document.body.textContent?.toLowerCase() ?? ''
        return body.includes('players found') || document.querySelector('table tbody tr') !== null
      },
      { timeout: 60_000 },
    ).then(() => true).catch(() => false)
  `
  assert.equal(misplacedOptionViolations(original, 'sample.ts').length, 1)
})

// ── Runner ──────────────────────────────────────────────────────────────────────

let failed = 0
for (const [name, fn] of tests) {
  try {
    fn()
    console.log(`  ok   ${name}`)
  } catch (err) {
    failed++
    console.error(`  FAIL ${name}\n       ${err.message}`)
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`)
process.exit(failed ? 1 : 0)
