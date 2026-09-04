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
  jobTimeout,
  stepCondition,
  sendsMail,
  cancelsInProgress,
  timeoutSilencedAlarms,
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

// ── DOES THE ALARM SURVIVE THE JOB'S OWN TIMEOUT? (2026-09-04) ───────────────────────────────
//
// The shape that shipped, verbatim from monitor.yml before the fix: a job that caps itself, and
// a mailer gated on failure() alone. The cap fires -> conclusion "cancelled" -> failure() is
// false -> the overrun is the one failure this alarm cannot report. Run 33818609882 lost 32
// failed tests and a 12-product outage exactly this way.
const CAPPED_AND_SILENT = `name: x
jobs:
  monitor:
    runs-on: ubuntu-latest
    timeout-minutes: 25
    steps:
      - uses: actions/checkout@v5
      - run: npm ci
      - name: Run production monitor
        timeout-minutes: 18
        run: npx playwright test
      - name: Send alert on failure
        if: failure()
        run: node scripts/send-alert.mjs
`

// Resolve injected script paths onto the real repo, so sendsMail() decides by walking imports
// rather than by trusting the fixture.
const resolveReal = (script) => join(ROOT, script)

check('jobTimeout reads the JOB cap and is not fooled by a step cap', () => {
  const [job] = parseJobs(CAPPED_AND_SILENT)
  assert.strictEqual(jobTimeout(job.attrs), 25, 'the four-space job cap')
  // The 18 belongs to a step and must never be read as the job's.
  assert.match(job.steps[2].raw, /timeout-minutes: 18/)
  assert.strictEqual(jobTimeout(parseJobs(FIXED)[0].attrs), null, 'no cap declared -> null')
})

check('parseJobs still finds every step now that job attrs are captured', () => {
  // The attrs branch was added to a parser three other gates already depend on.
  const [job] = parseJobs(CAPPED_AND_SILENT)
  assert.strictEqual(job.steps.length, 4)
  assert.strictEqual(job.steps[3].name, 'Send alert on failure')
  assert.ok(!/steps:/.test(job.steps[0].raw), 'the `steps:` key is not itself a step')
})

check('stepCondition strips the ${{ }} wrapper', () => {
  assert.strictEqual(stepCondition('- if: failure()\n  run: x'), 'failure()')
  assert.strictEqual(stepCondition('- if: ${{ failure() || cancelled() }}\n  run: x'),
    'failure() || cancelled()')
  assert.strictEqual(stepCondition('- run: x'), null)
})

check('sendsMail separates a NOTIFIER from a step that changes production', () => {
  // This is the narrowing that keeps the fix off auto-heal, which redeploys live sites. Decided
  // by walking imports to nodemailer — a name match would put both in the same bucket.
  assert.strictEqual(sendsMail(join(ROOT, 'scripts', 'send-alert.mjs')), true)
  assert.strictEqual(sendsMail(join(ROOT, 'scripts', 'auto-heal.mjs')), false,
    'auto-heal redeploys sites and must NOT be widened to fire on a timeout')
  assert.strictEqual(sendsMail(join(ROOT, 'scripts', 'auto-fix.mjs')), false)
})

check('DEFECT INJECTION: the exact shape that shipped is REPORTED', () => {
  const problems = timeoutSilencedAlarms(parseJobs(CAPPED_AND_SILENT), CAPPED_AND_SILENT, resolveReal)
  assert.strictEqual(problems.length, 1, 'expected exactly one silenced alarm')
  assert.strictEqual(problems[0].step, 'Send alert on failure')
  assert.strictEqual(problems[0].cap, 25)
  assert.match(problems[0].reason, /caps itself at 25 minutes/)
  assert.match(problems[0].reason, /failure\(\) is false/)
})

check('adding cancelled() clears it — the fix is what the rule accepts', () => {
  const fixed = CAPPED_AND_SILENT.replace('if: failure()', 'if: ${{ failure() || cancelled() }}')
  assert.deepStrictEqual(timeoutSilencedAlarms(parseJobs(fixed), fixed, resolveReal), [])
})

check('a job with NO cap is not reported — there is no timeout to be cancelled by', () => {
  const uncapped = CAPPED_AND_SILENT.replace('    timeout-minutes: 25\n', '')
  assert.deepStrictEqual(timeoutSilencedAlarms(parseJobs(uncapped), uncapped, resolveReal), [])
})

check('an always() mailer is not reported — it already runs in a cancelled job', () => {
  const always = CAPPED_AND_SILENT.replace('if: failure()', 'if: always()')
  assert.deepStrictEqual(timeoutSilencedAlarms(parseJobs(always), always, resolveReal), [])
})

check('a failure()-gated step that does NOT send mail is left alone', () => {
  // Widening a notifier is free. Widening auto-heal so a TIMEOUT triggers a production
  // redeploy is not, and this case is what stops a later edit doing it by generalisation.
  const heal = CAPPED_AND_SILENT.replace('scripts/send-alert.mjs', 'scripts/auto-heal.mjs')
  assert.deepStrictEqual(timeoutSilencedAlarms(parseJobs(heal), heal, resolveReal), [])
})

check('cancel-in-progress: true EXEMPTS a workflow, and only that', () => {
  // There a cancellation is routine (ci-runner-watchdog supersedes itself several times an
  // hour), so paging on cancelled() would mail on every superseded run, not on an overrun.
  const routine = `concurrency:\n  group: g\n  cancel-in-progress: true\n${CAPPED_AND_SILENT}`
  assert.strictEqual(cancelsInProgress(routine), true)
  assert.deepStrictEqual(timeoutSilencedAlarms(parseJobs(routine), routine, resolveReal), [])

  const serial = `concurrency:\n  group: g\n  cancel-in-progress: false\n${CAPPED_AND_SILENT}`
  assert.strictEqual(cancelsInProgress(serial), false)
  assert.strictEqual(timeoutSilencedAlarms(parseJobs(serial), serial, resolveReal).length, 1,
    'false must NOT exempt — that is the case the fix exists for')
})

// ── THE SECOND RATCHET ───────────────────────────────────────────────────────────────────────
check('EVERY workflow: no mail alarm is silenced by its own job timeout', () => {
  const files = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f))
  assert.ok(files.length > 0, 'found no workflow files — the ratchet would pass over nothing')

  let mailersSeen = 0
  let cappedJobs = 0
  const problems = []
  for (const file of files) {
    const yaml = readFileSync(join(WORKFLOWS, file), 'utf-8')
    const jobs = parseJobs(yaml)
    for (const job of jobs) {
      if (jobTimeout(job.attrs) !== null) cappedJobs++
      for (const s of job.steps) {
        const script = repoFileHandler(s.raw)
        if (script && sendsMail(join(ROOT, script))) mailersSeen++
      }
    }
    for (const p of timeoutSilencedAlarms(jobs, yaml, (script) => join(ROOT, script))) {
      problems.push(`${file} → job "${p.job}" → step "${p.step}" (line ${p.line}): ${p.reason}`)
    }
  }

  // Denominators, for the same reason the sibling ratchet has one: if the parser or the
  // import-walk ever stops recognising these, this must fail rather than report a clean sweep
  // over nothing. Measured 2026-09-04: 14 capped jobs, 8 mail-sending handlers.
  assert.ok(cappedJobs >= 12,
    `only ${cappedJobs} jobs with a timeout-minutes found — the attrs parser is probably broken`)
  assert.ok(mailersSeen >= 6,
    `only ${mailersSeen} mail-sending handlers found — the nodemailer walk is probably broken`)

  assert.deepStrictEqual(problems, [],
    `\n  ${problems.length} alarm(s) their own job timeout would silence:\n    ${problems.join('\n    ')}\n`)
  console.log(`         (swept ${files.length} workflows, ${cappedJobs} capped jobs, ${mailersSeen} mail handlers)`)
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
