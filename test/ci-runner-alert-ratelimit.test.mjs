/**
 * The CI-runner watchdog must not PAGE for an exhausted GitHub API allowance.
 *
 * 2026-08-30: the shared hourly API pool was emptied upstream (core reset 17:20). The watchdog
 * runs every 10 minutes, so it went blind four times — 16:40, 16:50, 17:01, 17:16 — and sent four
 * identical "the runner alarm is blind" emails, each of whose own body told Roger the token was
 * fine, not to rotate it, and that the check "goes green on its own once the allowance resets".
 * Four pages for a self-healing condition with no human action attached.
 *
 * The house had already decided this: an exhausted allowance is owned by check-github-api-budget.mjs,
 * whose source `github-api-budget` deliberately carries NO signal_page_policy row so it lands on
 * /signals and never rings unasked. The runner watchdog was paging around that decision.
 *
 * Two directions are pinned here, because a suppression that is too broad is the worse bug:
 *   1. a rate-limit reason sends NOTHING (and still exits non-zero — blind is never "healthy")
 *   2. an auth reason still pages, exactly as before
 *
 * classifyWatchdogFailure is already unit-tested next door. This spawns the SHIPPED script on
 * purpose: 6f2fd93 in this repo was an exit policy that was exported, documented and unit-tested
 * while the CLI had quietly stopped calling it. A green test on an exported function proves
 * nothing about what the product actually does.
 *
 * Run: node test/ci-runner-alert-ratelimit.test.mjs   (exit 0 = all pass)
 */
import assert from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

let passed = 0
let failed = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok   - ${name}`); passed++ }
  catch (e) { console.log(`  FAIL - ${name}: ${e.message}`); failed++ }
}

const SCRIPT = fileURLToPath(new URL('../scripts/send-ci-runner-alert.mjs', import.meta.url))

// The real bail() reason, verbatim from run 33324792237.
const RATELIMIT_REASON =
  'GitHub API rate limit exhausted (core resets at 2026-08-30T17:20:42.000Z) - this is a RATE ' +
  'LIMIT, not an auth failure. The token is valid; an invalid token could not reach the API at ' +
  'all. The shared hourly API allowance was emptied upstream (see the CI Cost Guard / ' +
  'github-api-budget), so this run cannot certify the fleet until the allowance resets. Do NOT ' +
  'rotate the DASHBOARD_PAT.'

const AUTH_REASON =
  'listed no private repositories. Broken token or broken harness - not a healthy fleet.'

/**
 * Run the shipped alert script over a watchdog_broken report, in a scratch directory.
 *
 * SMTP points at a closed port on loopback, so ANY attempt to send fails immediately with
 * ECONNREFUSED rather than hanging on a real connection — that refusal is the evidence a send was
 * attempted. Nothing here can reach a real mail server, so no test can email Roger.
 */
function runWith(reason) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-runner-alert-'))
  writeFileSync(join(dir, 'ci-runner-findings.json'), JSON.stringify({
    generated_at: '2026-08-30T17:16:34.000Z',
    watchdog_broken: true,
    broken_reason: reason,
    repos_with_runners: null,
    flips: [],
    findings: [`WATCHDOG COULD NOT COMPLETE: ${reason}`],
  }))
  const r = spawnSync(process.execPath, [SCRIPT], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: '9', // discard port, nothing listening -> instant ECONNREFUSED
      SMTP_USER: 'test@example.invalid',
      SMTP_PASS: 'not-a-real-password',
      ALERT_EMAIL: 'test@example.invalid',
      GITHUB_RUN_URL: 'https://example.invalid/run/1',
    },
  })
  return { ...r, out: `${r.stdout || ''}${r.stderr || ''}` }
}

check('a rate-limited watchdog sends NO email', () => {
  const r = runWith(RATELIMIT_REASON)
  assert.doesNotMatch(r.out, /alert sent/i, 'it must not report having sent a page')
  assert.doesNotMatch(r.out, /ECONNREFUSED|ETIMEDOUT|ESOCKET/, 'it must not even attempt an SMTP connection')
  assert.match(r.stdout, /not paging/i, 'and it must say, where a person will read it, that it chose not to page')
})

check('a rate-limited watchdog still exits non-zero — blind is never healthy', () => {
  const r = runWith(RATELIMIT_REASON)
  assert.equal(r.status, 1, 'a run that could not certify the fleet must never look successful')
})

check('the suppression is narrow: an auth failure still pages', () => {
  const r = runWith(AUTH_REASON)
  assert.doesNotMatch(r.stdout, /not paging/i, 'a broken token is exactly what this alarm is for')
  assert.match(r.out, /ECONNREFUSED|ESOCKET|ETIMEDOUT/, 'it must have tried to send the page')
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
