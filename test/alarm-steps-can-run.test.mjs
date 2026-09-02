#!/usr/bin/env node
/**
 * The invariant: a workflow's "send the alert" step must be ABLE TO RUN when the thing it
 * reports actually happens.
 *
 * Daily Dashboard Update run 33643774410 (2026-09-02) failed on its FTP pre-flight, which had
 * been placed before `actions/checkout` on purpose so it would fail fast on a stale password.
 * Checkout was therefore skipped, and `Send alert on failure` died with
 * "Cannot find module .../scripts/send-alert.mjs". The guard written to make a dead FTP
 * credential loud was the one failure that could not be reported. Nobody was emailed; the red
 * sat in the GitHub UI, which nobody watches.
 *
 * The last case below is the ratchet: it re-derives the property over EVERY workflow in
 * .github/workflows, including ones not written yet, so this cannot come back by being
 * reintroduced somewhere else. The three unit cases above it pin the rule itself, because a
 * ratchet that silently matches nothing is not a gate.
 *
 * Run: node test/alarm-steps-can-run.test.mjs   (exit 0 = all pass)
 */
import assert from 'node:assert'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseJobs,
  needsInstalledDeps,
  unreachableHandlers,
  repoFileHandler,
} from '../scripts/lib/alarm-step-reachability.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WORKFLOWS = join(ROOT, '.github', 'workflows')

let passed = 0
let failed = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok   - ${name}`); passed++ }
  catch (e) { console.log(`  FAIL - ${name}: ${e.message}`); failed++ }
}

// The exact shape that shipped: a fallible step, THEN checkout, THEN the handler.
const BROKEN = `name: x
jobs:
  update-dashboard:
    steps:
      - name: Verify FTP credentials
        run: curl ftp://host/
      - uses: actions/checkout@v5
      - run: npm ci
      - name: Send alert on failure
        if: failure()
        run: node scripts/send-alert.mjs
`

const FIXED = `name: x
jobs:
  update-dashboard:
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
      - run: npm ci
      - name: Verify FTP credentials
        run: curl ftp://host/
      - name: Send alert on failure
        if: failure()
        run: node scripts/send-alert.mjs
`

check('parseJobs finds the job and every step, in order', () => {
  const [job] = parseJobs(BROKEN)
  assert.strictEqual(job.name, 'update-dashboard')
  assert.strictEqual(job.steps.length, 4)
  assert.strictEqual(job.steps[0].name, 'Verify FTP credentials')
  assert.strictEqual(job.steps[1].name, 'actions/checkout@v5')
})

check('a handler placed after a fallible pre-checkout step is REPORTED', () => {
  const problems = unreachableHandlers(parseJobs(BROKEN), () => '/nonexistent.mjs')
  assert.strictEqual(problems.length, 1, 'expected exactly one problem')
  assert.match(problems[0].reason, /checkout is step 2/)
  assert.match(problems[0].reason, /Verify FTP credentials/)
  assert.match(problems[0].reason, /would not exist/)
})

check('moving checkout to the front clears it — the fix is what the rule accepts', () => {
  assert.deepStrictEqual(unreachableHandlers(parseJobs(FIXED), () => '/nonexistent.mjs'), [])
})

check('a job with no checkout at all is reported', () => {
  const yaml = `name: x
jobs:
  j:
    steps:
      - name: Send alert on failure
        if: failure()
        run: node scripts/send-alert.mjs
`
  const problems = unreachableHandlers(parseJobs(yaml), () => '/nonexistent.mjs')
  assert.strictEqual(problems.length, 1)
  assert.match(problems[0].reason, /never checks the repo out/)
})

check('setup steps may precede the handler deps; substantive work may not', () => {
  // checkout/setup-node/cache/npm ci are the handler's OWN prerequisites — if npm ci is what
  // broke, there is no mailer either way, so they are not counted as blockers.
  const yaml = `name: x
jobs:
  j:
    steps:
      - uses: actions/setup-node@v5
      - uses: actions/cache@v4
      - uses: actions/checkout@v5
      - run: npm ci
      - name: real work
        run: node scripts/work.mjs
      - name: Send alert on failure
        if: failure()
        run: node scripts/send-alert.mjs
`
  assert.deepStrictEqual(unreachableHandlers(parseJobs(yaml), () => '/nonexistent.mjs'), [])
})

check('needsInstalledDeps follows a DYNAMIC import, not just static ones', () => {
  // scripts/lib/smtp.mjs reaches nodemailer with `await import('nodemailer')`. A checker that
  // only read `from '...'` would call every mailer in this repo dependency-free.
  assert.strictEqual(needsInstalledDeps(join(ROOT, 'scripts', 'lib', 'smtp.mjs')), true)
  assert.strictEqual(needsInstalledDeps(join(ROOT, 'scripts', 'send-alert.mjs')), true,
    'send-alert.mjs reaches nodemailer transitively via lib/smtp.mjs')
})

check('needsInstalledDeps does not mistake Node builtins for packages', () => {
  assert.strictEqual(
    needsInstalledDeps(join(ROOT, 'scripts', 'lib', 'alarm-step-reachability.mjs')), false,
    'this file imports only node:fs / node:module / node:path')
})

check('the handler matcher only fires on failure()/always() steps running a repo file', () => {
  assert.strictEqual(repoFileHandler('- if: failure()\n  run: node scripts/a.mjs'), 'scripts/a.mjs')
  assert.strictEqual(repoFileHandler('- if: always()\n  run: bash scripts/b.sh'), 'scripts/b.sh')
  assert.strictEqual(repoFileHandler('- run: node scripts/a.mjs'), null, 'not a handler')
  assert.strictEqual(repoFileHandler('- if: failure()\n  run: echo hi'), null, 'not a repo file')
})

// ── THE RATCHET ──────────────────────────────────────────────────────────────────────────────
check('EVERY workflow: no failure handler can be stranded by an earlier step', () => {
  const files = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f))
  assert.ok(files.length > 0, 'found no workflow files — the ratchet would pass over nothing')

  let handlersSeen = 0
  const problems = []
  for (const file of files) {
    const jobs = parseJobs(readFileSync(join(WORKFLOWS, file), 'utf-8'))
    for (const job of jobs) {
      handlersSeen += job.steps.filter((s) => repoFileHandler(s.raw)).length
    }
    for (const p of unreachableHandlers(jobs, (script) => join(ROOT, script))) {
      problems.push(`${file} → job "${p.job}" → step "${p.step}" (line ${p.line}): ${p.reason}`)
    }
  }

  // A denominator built from what we happened to find is how a gate goes quiet. If the parser
  // ever stops recognising steps, this fails instead of reporting a clean sweep over nothing.
  assert.ok(handlersSeen >= 8,
    `only ${handlersSeen} failure handlers found across ${files.length} workflows — the parser is probably broken`)

  assert.deepStrictEqual(problems, [],
    `\n  ${problems.length} unreachable alarm step(s):\n    ${problems.join('\n    ')}\n`)
  console.log(`         (swept ${files.length} workflows, ${handlersSeen} failure handlers)`)
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
