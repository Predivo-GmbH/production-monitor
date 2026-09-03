#!/usr/bin/env node
/**
 * Pings the ci-runner-watchdog dead-man switch with what actually happened: DID THIS RUN
 * INSPECT THE FLEET? See scripts/lib/watchdog-heartbeat.mjs for why that is not `job.status`.
 *
 * The ping URL arrives in the environment rather than on the command line: this repository is
 * PUBLIC, a ping URL held green by a stranger is a dead-man that cannot die, and an argv is
 * visible to anything that can list processes.
 *
 * This step must NEVER change the outcome of the job. A watchdog whose heartbeat can fail the
 * run it is reporting on is a second failure mode bolted onto the first, so every error here is
 * logged and swallowed, and the exit code is always 0.
 *
 * Contract:  node scripts/ci-watchdog-heartbeat.mjs
 *   env: HC_PING_URL              the healthchecks.io ping URL (required to actually ping)
 *        CI_RUNNER_FINDINGS_FILE  default ci-runner-findings.json
 *        GITHUB_JOB_STATUS        the workflow's job.status, for the log line only
 *        HEARTBEAT_DRY            set to 1 to decide and print without pinging
 */
import { readFileSync } from 'node:fs'
import { decideHeartbeat } from './lib/watchdog-heartbeat.mjs'

const FILE = process.env.CI_RUNNER_FINDINGS_FILE || 'ci-runner-findings.json'

let reportRaw = null
try {
  reportRaw = readFileSync(FILE, 'utf-8')
} catch {
  reportRaw = null // absent is a verdict, not an error
}

const { ping, reason } = decideHeartbeat({
  reportRaw,
  jobStatus: process.env.GITHUB_JOB_STATUS || 'unknown',
})

console.log(`heartbeat: ${ping.toUpperCase()} - ${reason}`)

const base = (process.env.HC_PING_URL || '').trim()
if (!base) {
  // Say it out loud. A dead-man that was never wired up is indistinguishable from a healthy one
  // until the day it is needed, and that is the exact shape of miss this whole repo exists for.
  console.error('::warning::HC_PING_URL is not set, so no heartbeat was sent and the dead-man switch is not being fed')
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
