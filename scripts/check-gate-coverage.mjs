#!/usr/bin/env node
/**
 * v11 GATE-COVERAGE guard for the fleet.
 *
 * This is the enforcement half of "every project gets the v11 browser gates". It answers,
 * automatically and every week: does each app that SHOULD have the v11 staging-gate harness
 * actually have it, and is it GREEN?
 *
 *   - ENROLLED (has .github/workflows/staging-gates.yml) + latest run success  -> OK
 *   - ENROLLED + latest run failing/none                                       -> FAIL (broken gates = alert)
 *   - REQUIRED but NOT enrolled (no staging-gates.yml yet)                      -> PENDING (reported, never fails)
 *   - gates:'na' (static site / internal tool, no auth+DB+lists to gate)       -> skipped
 *
 * So a red run here means an *enrolled* project's gates broke; the PENDING list is the
 * living backfill queue (a past project not yet enrolled, or a future one that skipped the
 * template, can never be silently forgotten — it shows here until enrolled). New projects
 * inherit the harness from project-starter, so they land ENROLLED on day one.
 *
 * Read-only. Mirrors check-pipeline-drift.mjs (same FLEET, same local/CI dual mode).
 *   - CI mode:  gh api (needs GH_TOKEN = FLEET_READ_TOKEN, classic PAT repo:read).
 *   - Local:    LOCAL_FLEET_ROOT="C:\\Business\\Internal Projects" reads working copies;
 *               run status still uses gh api if a token is present, else marked "unknown".
 */

import { existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { getFleet } from '../lib/fleet.mjs'
import { sayVerdict, PASS, FAIL, UNKNOWN } from './lib/check-verdict.mjs'

// gates: 'required' = an app with auth/DB/lists/dialogs that MUST carry the v11 gates.
//        'na'       = static marketing site or internal tool — nothing to browser-gate.
// Fleet now comes from the DB-backed registry (fleet_products) via getFleet(), which FALLS BACK to
// the canonical hardcoded list on any DB failure — so this check can never lose a product / silently
// pass. A launched product auto-appears here once its fleet_products row exists (auto-enroll).
const { fleet: FLEET, source: FLEET_SOURCE } = await getFleet()
console.log(`gate-coverage: fleet source = ${FLEET_SOURCE} (${FLEET.length} products)`)

const WORKFLOW = 'staging-gates.yml'
const LOCAL_ROOT = process.env.LOCAL_FLEET_ROOT
const hasToken = !!(process.env.GH_TOKEN || process.env.GITHUB_TOKEN)

// A CHECK THAT CANNOT LOOK MUST NOT EXIT 0 (2026-09-03, found by fault injection).
//
// This block used to print "gate-coverage check skipped: set FLEET_READ_TOKEN ..." and exit 0,
// which made the weekly workflow GREEN. Run with no token in the environment — which is what a
// revoked, expired or renamed PAT looks like from in here — and the entire guard retires itself
// silently and permanently. Nothing in the system distinguishes "every enrolled project's gates
// are green" from "I have not looked at a project since the token died", because both are a
// green run with nobody reading the log.
//
// The rationalisation in the old comment was "skip cleanly rather than fail the nightly — the
// check activates the moment the secret is added". That is true and it is the trap: it optimises
// for the day the guard is being wired up, and pays for it with every day afterwards, when the
// same silence means the opposite thing. A dormant guard has to be loud about being dormant,
// because the only person who can arm it is the person who has stopped being told.
if (!LOCAL_ROOT && !hasToken) {
  const reason = 'the v11 gate-coverage guard could not look at a single repository: no FLEET_READ_TOKEN / '
    + 'DASHBOARD_PAT in the environment and no LOCAL_FLEET_ROOT. Nothing was checked, so nothing is known — '
    + 'this is a dormant guard, not a fleet with healthy gates.'
  sayVerdict(UNKNOWN, reason)
  console.error(`::error::${reason}`)
  // Same wire a real broken-gate finding uses, so blindness reaches a person the way a finding
  // would. A guard that is off is worse news than a gate that is red: the red gate is at least
  // being watched.
  if (process.env.ALERT_SMTP_HOST) {
    try {
      const { createMailTransport } = await import('./lib/smtp.mjs')
      const t = await createMailTransport({
        host: process.env.ALERT_SMTP_HOST,
        port: process.env.ALERT_SMTP_PORT,
        user: process.env.ALERT_SMTP_USER,
        pass: process.env.ALERT_SMTP_PASS,
      })
      await t.sendMail({
        from: 'Gate Coverage Guard <' + process.env.ALERT_SMTP_USER + '>',
        to: process.env.ALERT_TO,
        subject: '[ALERT] The v11 gate-coverage guard is not checking anything',
        html: '<p>' + reason + '</p><p>It needs a classic PAT with <code>repo:read</code> across the fleet, stored as the repository secret <code>FLEET_READ_TOKEN</code> (or <code>DASHBOARD_PAT</code>). Until then no project&rsquo;s staging gates are being watched.</p>',
      })
    } catch (e) {
      console.error('alert email failed:', e.message)
    }
  } else {
    console.error('NOT EMAILED: ALERT_SMTP_HOST is unset, so this blindness reached nobody but a red run.')
  }
  process.exit(1)
}

// Does the repo carry the staging-gates workflow? (enrolled)
function isEnrolled({ repo, dir }) {
  if (LOCAL_ROOT) return existsSync(join(LOCAL_ROOT, dir, '.github', 'workflows', WORKFLOW))
  try {
    execSync(`gh api repos/${repo}/contents/.github/workflows/${WORKFLOW}`, { stdio: 'pipe' })
    return true
  } catch { return false } // 404 -> not enrolled
}

// Latest CONCLUSIVE staging-gates run conclusion via gh api (needs a token). Returns 'success' |
// 'failure' | 'none' (enrolled but never ran, or no verdict in the recent window) | 'unknown'
// (no token to check).
// status=completed: this guard runs Mon 06:40 UTC, right while the gates' own Mon 06:30 cron is
// mid-flight (conclusion null) — judging an in-progress run as 'none' false-positive FAILs
// (BackOffice + ReplyFlow, 2026-08-17). An in-flight run is not a verdict; judge the last FINISHED one.
// Same reasoning for 'cancelled': staging-gates.yml runs `concurrency: cancel-in-progress: true`, so a
// Deploy/schedule/dispatch burst supersedes older runs mid-crawl, leaving a superseded 'cancelled' as the
// newest completed run even when the gates are GREEN (2026-08-24: BackOffice + ReplyFlow both had a recent
// 'success' but the newest completed run was a superseded 'cancelled' → false FAIL). A concurrency-cancelled
// run is not a verdict either; scan back and judge the newest run that reached success/failure. If NONE of
// the recent window reached a verdict, that's a genuinely stuck harness → 'none' (fails), so a truly broken
// gate still alerts.
function latestRunConclusion({ repo }) {
  if (!hasToken) return 'unknown'
  try {
    const out = execSync(
      `gh api "repos/${repo}/actions/workflows/${WORKFLOW}/runs?per_page=10&status=completed" --jq "[.workflow_runs[].conclusion]"`,
      { stdio: 'pipe' },
    ).toString().trim()
    const conclusions = JSON.parse(out || '[]')
    return conclusions.find((c) => c && c !== 'cancelled' && c !== 'skipped') || 'none'
  } catch { return 'none' }
}

const violations = []   // enrolled but gates red -> exit 1 + alert
const pending = []      // required, not yet enrolled -> backfill queue (never fails)
const okList = []
const naList = []
const deferred = []     // gate-worthy but enrollment HELD (e.g. off-stack, pending a decision) -> never fails

for (const p of FLEET) {
  if (p.gates === 'na') { naList.push(p.name); continue }
  if (p.gates === 'deferred') { deferred.push(p.name); continue }
  if (!isEnrolled(p)) { pending.push(p.name); continue }
  const c = latestRunConclusion(p)
  if (c === 'success' || c === 'unknown') okList.push(`${p.name}${c === 'unknown' ? ' (enrolled; run status needs a token)' : ''}`)
  else violations.push({ name: p.name, conclusion: c })
}

console.log('v11 gate-coverage guard — every REQUIRED app must carry a GREEN staging-gates harness:\n')
for (const v of violations) console.log(`*** FAIL *** ${v.name} — staging-gates enrolled but latest run = ${v.conclusion} (broken gates)`)
for (const n of okList) console.log(`OK    ${n}`)
if (pending.length) {
  console.log('\nPENDING enrollment (required apps without the v11 gates yet — the backfill queue):')
  for (const n of pending) console.log(`  - ${n}  (add e2e/staging/v11-gates.spec.ts + playwright.v11-gates.config.ts + ${WORKFLOW}; then it flips to enforced)`)
}
if (deferred.length) console.log(`\nDEFERRED (gate-worthy but enrollment held — revisit; not counted): ${deferred.join(', ')}`)
if (naList.length) console.log(`\nN/A (static site / internal tool, nothing to browser-gate): ${naList.join(', ')}`)

const required = FLEET.filter((p) => p.gates === 'required').length
console.log(`\nCoverage: ${okList.length}/${required} required apps enrolled + green · ${pending.length} pending · ${violations.length} broken.`)

if (violations.length) {
  // THE ALERT THIS FILE PROMISED AND NEVER HAD. Line 81 says "exit 1 + alert" and there was no
  // mail code in this script at all (2026-09-01 audit: grep for sendMail/SMTP returned 0), while
  // gate-coverage-check.yml carried neither an alert step nor a healthchecks heartbeat. So a real
  // finding - on 2026-08-31 this guard caught BoatBuddy's staging gates broken - reached nobody
  // but a red workflow run. Same shape as the RLS and auth-email guards fixed the same day.
  if (!process.env.ALERT_SMTP_HOST) {
    console.error('NOT EMAILED: ' + violations.length + ' project(s) with broken gates were found and ALERT_SMTP_HOST is unset, so nobody was told. Wire the mail secrets in this workflow.')
  } else {
    try {
      const { createMailTransport } = await import('./lib/smtp.mjs')
      const t = await createMailTransport({
        host: process.env.ALERT_SMTP_HOST,
        port: process.env.ALERT_SMTP_PORT,
        user: process.env.ALERT_SMTP_USER,
        pass: process.env.ALERT_SMTP_PASS,
      })
      await t.sendMail({
        from: 'Gate Coverage Guard <' + process.env.ALERT_SMTP_USER + '>',
        to: process.env.ALERT_TO,
        subject: '[ALERT] ' + violations.length + ' product(s) with a broken staging-gate harness',
        html: '<p>These products are enrolled in the v11 staging gates and their latest gate run is not green, so nothing is checking them before a release:</p><ul>' + violations.map((v) => '<li><b>' + v.name + '</b> - latest run ' + v.conclusion + '</li>').join('') + '</ul>',
      })
    } catch (e) {
      console.error('alert email failed:', e.message)
    }
  }
  sayVerdict(FAIL, `${violations.length} enrolled project(s) with a broken v11 gate run.`)
  console.error(`\nFAIL: ${violations.length} enrolled project(s) with a broken v11 gate run.`)
  process.exit(1)
}
sayVerdict(PASS, `${okList.length}/${required} required app(s) enrolled and green, ${pending.length} pending enrollment.`)
console.log('\nAll ENROLLED gate harnesses green. (Pending apps are the tracked backfill queue, not a failure.)')
