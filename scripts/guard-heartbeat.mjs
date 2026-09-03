#!/usr/bin/env node
/**
 * Pings a guard's dead-man switch with what actually happened: DID THIS RUN INSPECT WHAT IT
 * WATCHES, AND DID ITS FINDING GET OUT? See scripts/lib/guard-heartbeat.mjs for why neither of
 * those is `job.status`.
 *
 * Used by ci-runner-watchdog.yml, mailer-config-check.yml, ci-budget-check.yml and monitor.yml.
 *
 * monitor.yml joined on 2026-09-03. Its heartbeat was `if: success()`, so the ping was not
 * mis-aimed, it was SKIPPED - a different disguise for the same defect, and the costliest one,
 * because the workflow's own 180-minute tolerance then turned every three-hour PRODUCT outage
 * into a false "the monitor stopped running". See the `monitor-hourly` spec for the run history
 * that settled it.
 *
 * The ping URL arrives in the environment rather than on the command line: this repository is
 * PUBLIC, a ping URL held green by a stranger is a dead-man that cannot die, and argv is visible
 * to anything that can list processes.
 *
 * This step must NEVER change the outcome of the job. A heartbeat that can fail the run it is
 * reporting on is a second failure mode bolted onto the first, so every error here is logged and
 * swallowed, and the exit code is always 0.
 *
 * Contract:  node scripts/guard-heartbeat.mjs
 *   env: HEARTBEAT_GUARD        a key of GUARDS (default ci-runner-watchdog)
 *        HC_PING_URL            the healthchecks.io ping URL (required to actually ping)
 *        GUARD_REPORT_FILE      override the spec's report path (tests / local runs)
 *        GITHUB_JOB_STATUS      the workflow's job.status, for the log line only
 *        ALERT_STEP_OUTCOME     the alert step's `outcome`; 'failure' means the finding could not
 *                               be delivered and the dead-man must say so
 *        HEARTBEAT_DRY          set to 1 to decide and print without pinging
 */
import { readFileSync } from 'node:fs'
import { decideHeartbeat, GUARDS } from './lib/guard-heartbeat.mjs'

const guard = process.env.HEARTBEAT_GUARD || 'ci-runner-watchdog'
const spec = GUARDS[guard]
const file = process.env.GUARD_REPORT_FILE || spec?.file || 'ci-runner-findings.json'

let reportRaw = null
try {
  reportRaw = readFileSync(file, 'utf-8')
} catch {
  reportRaw = null // absent is a verdict, not an error
}

const { ping, reason } = decideHeartbeat({
  reportRaw,
  guard,
  jobStatus: process.env.GITHUB_JOB_STATUS || 'unknown',
  // An alert step that was SKIPPED (nothing to report) or that succeeded is not a delivery
  // failure. Only an outcome of 'failure' is.
  alertOutcome: process.env.ALERT_STEP_OUTCOME || null,
})

console.log(`heartbeat[${guard}]: ${ping.toUpperCase()} - ${reason}`)

const base = (process.env.HC_PING_URL || '').trim()
if (!base) {
  // Say it out loud. A dead-man that was never wired up is indistinguishable from a healthy one
  // until the day it is needed, and that is the exact shape of miss this whole repo exists for.
  console.error(`::warning::HC_PING_URL is not set for ${guard}, so no heartbeat was sent and the dead-man switch is not being fed`)
  process.exit(0)
}
if (process.env.HEARTBEAT_DRY === '1') {
  console.log('heartbeat: dry run, nothing was sent')
  process.exit(0)
}

const url = ping === 'up' ? base : `${base.replace(/\/+$/, '')}/fail`
try {
  const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(10_000) })
  if (!res.ok) console.error(`::warning::heartbeat ping returned HTTP ${res.status}`)
} catch (err) {
  console.error(`::warning::heartbeat ping failed: ${err.message}`)
}
process.exit(0)
