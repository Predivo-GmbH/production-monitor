#!/usr/bin/env node
/**
 * PUBLISH WHAT THE HOURLY SUITE ALREADY PROVED, INSTEAD OF THROWING IT AWAY.
 *
 * WHY THIS EXISTS (2026-09-01). This monitor logs into eight products in a real browser with a
 * real magic link, fetches a real message back out of a real mailbox for five of them, and opens
 * ~170 pages an hour. Every one of those passes was discarded: only failures ever left the run,
 * as an alert email. So the Cockpit "Fleet health" page had no evidence to read and grew its own,
 * far weaker, browser-side probes — a POST to /auth/v1/otp where only a 500 counted as failure,
 * and a TLS socket to port 465 called "Mail server: Answering". On the morning this was written
 * that page rendered "Login OK / All clear" for LaunchReady while a needs-Roger board item said
 * LaunchReady cannot send its login emails.
 *
 * This script is the other half of Cockpit/sql/082_product_check_run.sql: it turns the Playwright
 * JSON report into one append-only row per product, so the page can stop probing and start
 * reporting. Read 082 before changing anything here; the schema is the contract.
 *
 * ── THE ONE RULE, AND IT IS THE WHOLE POINT ─────────────────────────────────────────────────
 *
 * EVERY OUTCOME IS THREE-VALUED: 'ok' | 'failed' | 'not-tested'. A check that did not run is
 * 'not-tested'. Never 'ok'. Never 'failed'. Concretely, in this file:
 *
 *   * a field with NO test matching its classifier stays 'not-tested' — predivo.ch is a company
 *     website with no sign-in of any kind, so its `login` must read grey, not green, forever;
 *     Valrano and BoatBuddy were in that list until 2026-09-01 and are now genuinely tested;
 *   * a SKIPPED test is not an outcome. `test.skip(!IMAP_PASS, …)` and `test.skip(!SUPABASE_URL,
 *     …)` fire routinely (arivioo's Supabase project has been paused; the OTP tests skip on a
 *     rate-limit cooldown). A skipped test counts in neither `checks_total` nor `checks_passed`
 *     and cannot make a field 'ok'. Counting skips as passes is how "153 checks, 153 passed"
 *     would be printed for a run that proved nothing.
 *
 * Inventing a pass for an unrun check is the exact defect this table was created to end. If you
 * are about to default something to 'ok' because it "must be fine", stop.
 *
 * ── FIRE AND FORGET: THIS MUST NEVER FAIL THE MONITOR RUN ───────────────────────────────────
 *
 * A reporting side-effect that can red a monitoring job would make the fleet look broken because
 * a dashboard write failed. Everything is caught, logged in plain English, and the process exits
 * 0 — including a missing or malformed results.json, an unreachable database and a rejected
 * insert. The ONLY exception is `--strict`, which exists so the unit suite can assert failures
 * are actually detected rather than silently swallowed.
 *
 * Contract:  node scripts/publish-check-results.mjs [--dry] [--strict] [--results <path>]
 *   env: BOARD_SUPABASE_SECRET or BACKOFFICE_SERVICE_ROLE_KEY (writes product_check_run).
 *        Falls back to reading the key out of BackOffice/docs/Credentials.txt for local runs.
 *        GITHUB_SERVER_URL / GITHUB_REPOSITORY / GITHUB_RUN_ID become `run_url` when present.
 *   --dry prints the rows it would write and writes nothing.
 */
import { readFileSync } from 'fs'

const BO_REF = 'xoecpzfsskalvjrtcbbl'
const BO_BASE = `https://${BO_REF}.supabase.co`
const BO_CREDS = 'C:\\Business\\Internal Projects\\BackOffice\\docs\\Credentials.txt'
const UA = 'publish-check-results/1.0'

/** Which program proved this. Matches `source` in product_check_run. */
export const SOURCE = 'production-monitor'
/** Written by the JSON reporter configured in playwright.config.ts:24. */
export const DEFAULT_RESULTS_FILE = 'test-results/results.json'
/** Failure messages are for a card on a page, not a log. Enough to name the cause. */
export const MAX_MESSAGE = 300

export const NOT_TESTED = 'not-tested'
export const OK = 'ok'
export const FAILED = 'failed'

/** The three-valued fields, in the order the row is written. */
export const FIELDS = ['login', 'mail_delivery', 'site', 'identity', 'backend']

/**
 * tests/<dir> -> fleet_projects.slug. Verified against the live registry on 2026-09-01: all
 * eleven slugs below exist and are active. `ytmigration` is the pre-rename directory for
 * ChannelMover — the same mismatch monitor.yml already carries for its anon-key secret.
 */
export const TEST_DIR_TO_SLUG = {
  backoffice: 'backoffice',
  replyflow: 'replyflow',
  signalscore: 'signalscore',
  ytmigration: 'channelmover',
  scoutcopilot: 'scoutcopilot',
  valrano: 'valrano',
  arivioo: 'arivioo',
  launchready: 'launchready',
  'distribution-os': 'distributionos',
  boatbuddy: 'boatbuddy',
  predivo: 'predivo',
}

/**
 * Directories that are NOT products and must never produce a row. Each one tests the machinery
 * rather than something a customer opens: `self` tests this repo's own alerting, `ci-health`
 * watches other repos' pipelines, `api-health` watches third-party vendors, `keepalive` watches
 * Supabase projects being poked, and `grom-uploader` is an internal worker.
 *
 * This list is EXPLICIT, not a fallthrough, and test/publish-check-results.test.mjs asserts that
 * every directory under tests/ appears in exactly one of these two tables. A new product added
 * as a test directory and forgotten here would otherwise be monitored and invisible — the same
 * shape of miss as the "products down" tile that was lost in a merge and noticed three days later.
 */
export const NON_PRODUCT_DIRS = ['self', 'ci-health', 'api-health', 'keepalive', 'grom-uploader']

/**
 * HOW A TEST TITLE BECOMES A FIELD. Small on purpose, matched against the titles that actually
 * exist (run `grep -rh "  test(" tests/` before editing), and evaluated as a set: a test may
 * match more than one rule, because one test can genuinely prove more than one thing. BackOffice's
 * OTP round trip fetches a real message AND signs in with the code it found; recording it under
 * only one field would throw away half of what it proved, which is the habit this whole table
 * exists to break.
 *
 * The counts these rules produce were checked against the independent tally in 082's header:
 * 8 products with a real magic-link browser login, 5 with a real mailbox round trip. They agree.
 * Valrano became the NINTH magic-link login on 2026-09-01 (it had a form-rendering check and an
 * IMAP delivery check but had never once signed in), and BoatBuddy the first 'site-password'.
 *
 * WHAT IS DELIBERATELY NOT A LOGIN RULE, and this is the important part: "login page has form"
 * and "login form: fields accept input and opacity > 0" render the sign-in UI without ever
 * signing in. Valrano and ScoutCopilot both have one. Counting those as `login = ok` would say
 * "login works" on the strength of a form being visible, which is a smaller version of exactly
 * the /auth/v1/otp probe this replaces. They classify as `site` (a page rendered) or not at all.
 *
 * `loginMethod` is taken from the STRONGEST login rule matched by a test THAT RAN, so a run where
 * the magic-link test was skipped and only the OTP sign-in executed reports 'otp-email' rather
 * than a method nothing exercised. Every spec matched by the magic-link rule imports
 * loginViaMagicLink from lib/auth.ts (verified 2026-09-01, all 9).
 */

/**
 * HOW STRONG EACH PROOF OF SIGN-IN IS, strongest first. Stated here as its own list rather than
 * left implicit in the order of CLASSIFIER_RULES, because it is a JUDGEMENT and it decides what
 * one word on the Fleet health page means. Reordering the rules below for readability must not
 * silently downgrade what a product reports.
 *
 * WHY THIS ORDER:
 *
 *   magic-link-browser — a real per-user token is minted, verified by GoTrue, and the app then
 *                        admits that specific user. It proves the whole pipeline AND that the
 *                        product can tell one person from another.
 *   otp-email          — the same, and it additionally proves a real message reached a real
 *                        mailbox. It ranks BELOW the magic link only because it is the flow that
 *                        skips on a rate-limit cooldown, so it is the less reliable evidence of
 *                        the two, not the weaker one in principle.
 *   site-password      — one shared secret opens the whole site (BoatBuddy's PasswordGate). It
 *                        proves the door opens; it proves NOTHING about user identity, because
 *                        the product has no users. It is real access control and worth reporting,
 *                        but it must never outrank a per-user sign-in on a product that has both.
 *
 * A product with BOTH a user sign-in and a gate therefore reports the user sign-in: reporting
 * 'site-password' for such a product would understate what was actually proven, and reporting it
 * ABOVE a magic link would overstate a shared password as an identity check.
 */
export const LOGIN_METHOD_STRENGTH = ['magic-link-browser', 'otp-email', 'site-password']

export const CLASSIFIER_RULES = [
  // ── login: only tests that actually SIGN IN. Listed strongest-first to match
  //    LOGIN_METHOD_STRENGTH, which is what actually decides the reported method. ──
  { field: 'login', pattern: /^full login works/i, loginMethod: 'magic-link-browser' },
  { field: 'login', pattern: /^E2E OTP:.*enter code/i, loginMethod: 'otp-email' },
  // BoatBuddy has no user accounts at all: its PasswordGate is the only sign-in a person performs.
  // The NEGATIVE case ('wrong site password is refused') is deliberately NOT a login rule — it
  // proves the gate REJECTS, which is not the same claim as "login works", and it reds the run on
  // its own when it fails.
  { field: 'login', pattern: /^full site password login works/i, loginMethod: 'site-password' },

  // ── mail_delivery: a real message, fetched back out of a real mailbox over IMAP. ──
  { field: 'mail_delivery', pattern: /^E2E OTP:/i },

  // ── identity: the domain is serving OUR product, not a parking page or a stale deploy. ──
  { field: 'identity', pattern: /^site identity\b/i },

  // ── backend: the product's own server-side functions and data sources answer. ──
  { field: 'backend', pattern: /edge functions? (is|are) reachable/i },
  { field: 'backend', pattern: /^no external data source is failing/i },

  // ── site: pages a visitor opens actually load and render. ──
  { field: 'site', pattern: /^public routes from manifest/i },
  { field: 'site', pattern: /\b(page|site|root document)\b[^:]*\b(loads?|is served|has [a-z ]*form|has hero)\b/i },
]

// ── reading the report ───────────────────────────────────────────────────────────────────────

/** Strip ANSI escape codes, same as scripts/lib/parse-failures.mjs does for the alert. */
export function stripAnsi(str) {
  return String(str).replace(/\x1b\[[0-9;]*m/g, '')
}

/**
 * tests/<dir>/x.spec.ts -> <dir>. Playwright writes `file` relative to testDir ('arivioo/...'),
 * but a config change could make it relative to the repo root, so both are handled rather than
 * assumed. Returns null for anything that is not a product directory — including every entry in
 * NON_PRODUCT_DIRS and any directory nobody has mapped.
 */
export function slugForFile(file) {
  if (typeof file !== 'string' || file === '') return null
  const parts = file.replace(/\\/g, '/').split('/').filter(Boolean)
  const testsAt = parts.indexOf('tests')
  const dir = testsAt >= 0 ? parts[testsAt + 1] : parts[0]
  if (!dir) return null
  return TEST_DIR_TO_SLUG[dir] || null
}

/**
 * 'passed' | 'failed' | 'skipped' for one Playwright test entry.
 *
 * 'flaky' is a pass: it failed and then passed on the retry the config already allows, so the
 * check ultimately held. 'skipped' is NEITHER — it is the absence of an outcome, and every
 * caller here must treat it as such.
 */
export function outcomeOf(test) {
  const status = test && test.status
  if (status === 'expected' || status === 'flaky') return 'passed'
  if (status === 'unexpected') return 'failed'
  return 'skipped'
}

/** The first line of the real error behind a failed test, trimmed to fit on a card. */
export function messageOf(test) {
  const results = (test && test.results) || []
  const failed = [...results].reverse().find((r) => (r.errors && r.errors.length) || r.error) || results[results.length - 1]
  const raw = (failed && failed.errors && failed.errors[0] && failed.errors[0].message)
    || (failed && failed.error && failed.error.message)
    || 'Unknown error'
  return stripAnsi(raw).split('\n')[0].trim().slice(0, MAX_MESSAGE)
}

/**
 * Flatten the nested suite tree into one check per test entry. Playwright nests
 * file-suite > describe-suite > specs, and describes can nest further, so this recurses.
 */
export function collectChecks(results) {
  const checks = []
  const walk = (suite) => {
    if (!suite || typeof suite !== 'object') return
    for (const spec of suite.specs || []) {
      const file = spec.file || suite.file || ''
      for (const test of spec.tests || []) {
        const outcome = outcomeOf(test)
        checks.push({
          file,
          slug: slugForFile(file),
          title: spec.title || 'Unknown test',
          outcome,
          message: outcome === 'failed' ? messageOf(test) : null,
        })
      }
    }
    for (const child of suite.suites || []) walk(child)
  }
  for (const suite of (results && results.suites) || []) walk(suite)
  return checks
}

/** Every rule this title matches, in rule order. May be empty — most titles match nothing. */
export function classify(title) {
  return CLASSIFIER_RULES.filter((r) => r.pattern.test(title || ''))
}

// ── building the rows ────────────────────────────────────────────────────────────────────────

/**
 * One row per product PRESENT IN THIS REPORT.
 *
 * A product the run never touched (a filtered run such as `npm run test:backoffice`) produces no
 * row at all: writing a row of 'not-tested' for it would put a grey card over last hour's real
 * evidence and call that an improvement. A product that IS in the report but whose every test
 * skipped does get a row, all-'not-tested' with checks_total 0 — that is the news, and it is
 * true (arivioo's suite skips wholesale whenever its Supabase project is paused).
 */
export function buildRows(results, { runUrl = null, source = SOURCE } = {}) {
  const checks = collectChecks(results)
  const byslug = new Map()

  for (const check of checks) {
    if (!check.slug) continue
    if (!byslug.has(check.slug)) {
      byslug.set(check.slug, {
        slug: check.slug,
        source,
        run_url: runUrl,
        checks_total: 0,
        checks_passed: 0,
        login: NOT_TESTED,
        login_method: 'none',
        mail_delivery: NOT_TESTED,
        site: NOT_TESTED,
        identity: NOT_TESTED,
        backend: NOT_TESTED,
        failures: [],
        // LOGIN_METHOD_STRENGTH index of the strongest login proof seen on a test that RAN.
        // -1 = none yet.
        _loginRank: -1,
      })
    }
    const row = byslug.get(check.slug)

    // A skipped test is not an outcome: it counts nowhere and classifies nothing.
    if (check.outcome === 'skipped') continue

    row.checks_total += 1
    if (check.outcome === 'passed') row.checks_passed += 1
    else row.failures.push({ name: check.title, message: check.message || 'Unknown error' })

    for (const rule of classify(check.title)) {
      // 'failed' is terminal for a field: any matching test failing means the field failed,
      // regardless of how many siblings passed.
      if (row[rule.field] !== FAILED) row[rule.field] = check.outcome === 'failed' ? FAILED : OK
      if (rule.field === 'login') {
        // Ranked by LOGIN_METHOD_STRENGTH, NOT by position in CLASSIFIER_RULES. Reordering the
        // rules must not be able to change what a product reports about its own sign-in.
        const rank = LOGIN_METHOD_STRENGTH.indexOf(rule.loginMethod)
        if (rank >= 0 && (row._loginRank === -1 || rank < row._loginRank)) {
          row._loginRank = rank
          row.login_method = rule.loginMethod
        }
      }
    }
  }

  return [...byslug.values()]
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .map(({ _loginRank, ...row }) => row)
}

/** The run these numbers came from, so anything on the page can be opened and checked. */
export function runUrlFrom(env = process.env) {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = env
  if (!GITHUB_SERVER_URL || !GITHUB_REPOSITORY || !GITHUB_RUN_ID) return null
  return `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`
}

/** One line per product, for the run log. Says what was proven and what was not. */
export function describeRow(row) {
  const fields = FIELDS.map((f) => `${f}=${row[f]}`).join(' ')
  const method = row.login_method === 'none' ? '' : ` via ${row.login_method}`
  return `  ${row.slug.padEnd(14)} ${String(row.checks_passed).padStart(3)}/${String(row.checks_total).padEnd(3)} ${fields}${method}`
}

// ── talking to the database ──────────────────────────────────────────────────────────────────

export function readBoSecret(env = process.env) {
  if (env.BOARD_SUPABASE_SECRET) return env.BOARD_SUPABASE_SECRET.trim()
  if (env.BACKOFFICE_SERVICE_ROLE_KEY) return env.BACKOFFICE_SERVICE_ROLE_KEY.trim()
  const txt = readFileSync(BO_CREDS, 'utf-8')
  const m = txt.match(/sb_secret_[A-Za-z0-9_]+/)
  if (!m) throw new Error(`no sb_secret_ key found in ${BO_CREDS}`)
  return m[0]
}

/** Load and parse the report. Any problem is `null` — never a partial or invented result. */
export function loadResults(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'))
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.suites)) {
      console.log(`publish-check-results: ${path} is not a Playwright report (no suites array). Nothing published.`)
      return null
    }
    return parsed
  } catch (err) {
    console.log(`publish-check-results: could not read ${path} (${err.message}). Nothing published.`)
    return null
  }
}

async function insertRows(secret, rows) {
  const res = await fetch(`${BO_BASE}/rest/v1/product_check_run`, {
    method: 'POST',
    headers: {
      apikey: secret,
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
      'User-Agent': UA,
    },
    body: JSON.stringify(rows),
  })
  if (!res.ok) throw new Error(`product_check_run insert -> HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
}

export function parseArgs(argv = []) {
  const at = argv.indexOf('--results')
  return {
    dry: argv.includes('--dry'),
    strict: argv.includes('--strict'),
    resultsFile: at >= 0 && argv[at + 1] ? argv[at + 1] : DEFAULT_RESULTS_FILE,
  }
}

/** Returns the number of rows written (0 when there was nothing to write, or --dry). */
export async function publish({ dry = false, resultsFile = DEFAULT_RESULTS_FILE, env = process.env } = {}) {
  const results = loadResults(resultsFile)
  if (!results) return 0

  const rows = buildRows(results, { runUrl: runUrlFrom(env) })
  if (rows.length === 0) {
    console.log('publish-check-results: the report contains no product test directories. Nothing published.')
    return 0
  }

  console.log(`publish-check-results: ${rows.length} product(s) in this run`)
  for (const row of rows) console.log(describeRow(row))

  if (dry) {
    console.log('--dry: nothing written.\n' + JSON.stringify(rows, null, 2))
    return 0
  }

  await insertRows(readBoSecret(env), rows)
  console.log(`publish-check-results: wrote ${rows.length} row(s) to product_check_run.`)
  return rows.length
}

async function main() {
  const { dry, strict, resultsFile } = parseArgs(process.argv.slice(2))
  try {
    await publish({ dry, resultsFile })
  } catch (err) {
    // FIRE AND FORGET. A dashboard write must never be able to red a monitoring run: that would
    // make the fleet look broken because a reporting side-effect failed. Say so loudly, exit 0.
    console.log(`publish-check-results: could NOT publish (${err.message}). The monitor run is unaffected.`)
    if (strict) throw err
  }
}

if (import.meta.url === (await import('url')).pathToFileURL(process.argv[1] || '').href) {
  main().then(
    () => { process.exitCode = 0 },
    () => { process.exitCode = 1 },   // --strict only; main() swallows everything otherwise
  )
}
