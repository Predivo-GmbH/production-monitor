#!/usr/bin/env node
/**
 * LAYER 2: who watches the CI runner watchdog.
 *
 * ci-runner-watchdog.yml runs every 10 minutes and moves the fleet back to GitHub-hosted runners
 * whenever the office PC stops taking jobs. That covers the office PC going down.
 *
 * It does not cover ITSELF going down. A scheduled workflow can stop running silently: it gets
 * disabled after 60 days of repository inactivity, someone deletes or renames it, the Actions
 * spend cap trips and every workflow in the account stops, or GitHub simply drops the tick.
 * In all of those cases the watchdog is not red - it is ABSENT, and absence produces no alert.
 * That is the exact shape of failure a heartbeat exists to catch, and it is the shape that has
 * bitten this business repeatedly (the budget updater sat in an archived repo for 53 days
 * queueing runs that never started, and nobody noticed).
 *
 * So this asserts the watchdog RAN RECENTLY, and is called from monitor.yml - which is hourly
 * and already carries the fleet's healthchecks.io dead-man's switch. That inherits real
 * heartbeat coverage without needing a 21st healthchecks slot, and the account is at 20 of 20
 * (verified 2026-08-24: POST /api/v3/checks/ returns HTTP 403 at the plan ceiling).
 *
 * The threshold is deliberately loose. The watchdog runs every 10 minutes, so a 90-minute
 * threshold tolerates nine consecutive missed ticks. GitHub drops scheduled ticks routinely -
 * production-monitor's own hourly cron is documented as dropping most nights - and an alarm that
 * cries wolf gets ignored, which is worse than no alarm.
 */
// Set exitCode rather than calling process.exit(): on Windows, process.exit() while an
// undici/fetch handle is still closing aborts the process (libuv UV_HANDLE_CLOSING assertion)
// and reports 127 instead of the intended code. An alarm whose exit status is ambiguous is
// the exact failure class this script exists to catch, so it must end cleanly.
async function main() {
const OWNER = process.env.CI_WATCHDOG_OWNER || 'Predivo-GmbH'
const REPO = process.env.CI_WATCHDOG_REPO || 'production-monitor'
const FILE = process.env.CI_WATCHDOG_FILE || 'ci-runner-watchdog.yml'
const MAX_AGE_MIN = Number(process.env.CI_WATCHDOG_MAX_AGE_MIN || 90)
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN

if (!TOKEN) {
    console.error('::error::no GH_TOKEN - cannot verify the CI watchdog is alive, and will not assume it is')
    return 1
  }

const r = await fetch(
  `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${FILE}/runs?per_page=20`,
  {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'ci-watchdog-liveness',
    },
  },
)

if (!r.ok) {
    console.error(`::error::could not read ${FILE} run history (HTTP ${r.status}). Cannot certify the CI watchdog is alive.`)
    return 1
  }

const { workflow_runs: runs = [] } = await r.json()

// Absence is the failure being tested for, so an empty history must FAIL, never pass quietly.
if (!runs.length) {
    console.error(`::error::${FILE} has NO runs at all. The CI runner watchdog is not running, so nothing is watching whether our build machine is taking jobs.`)
    return 1
  }

// A QUEUED RUN IS NOT A HEARTBEAT (2026-09-01 audit). `completed[0] || runs[0]` fell through to
// the newest run of ANY status and measured `created_at`, the moment GitHub ENQUEUED it. The
// failure this file exists to catch is the watchdog wedging, and a wedged watchdog is exactly one
// whose runs pile up queued: with the newest page all queued, their fresh timestamps report
// "last run 3 min ago" while not a line of it has executed for hours.
const completed = runs.filter((x) => x.status === 'completed')
if (!completed.length) {
  const statuses = [...new Set(runs.map((x) => x.status))].join('/')
  console.error(`::error::not one of the last ${runs.length} runs has actually run - they are all ${statuses}. The CI runner watchdog is queued but not executing, so nobody is checking whether the build machine takes jobs.`)
  process.exit(1)
}
const newest = completed[0]
const ageMin = Math.round((Date.now() - new Date(newest.created_at)) / 60000)

console.log(`CI watchdog last run : ${newest.created_at} (${ageMin} min ago, ${newest.conclusion || newest.status})`)
console.log(`threshold            : ${MAX_AGE_MIN} min (it runs every 10, so this allows ${Math.floor(MAX_AGE_MIN / 10)} missed ticks)`)

if (ageMin > MAX_AGE_MIN) {
    console.error(`::error::the CI runner watchdog has not run for ${ageMin} minutes (threshold ${MAX_AGE_MIN}). While it is silent, nobody is checking whether our own build machine is taking jobs - so if that machine goes down, deploys would queue with no alert.`)
    return 1
  }

// Its verdict matters as much as its heartbeat: a watchdog that runs and keeps failing is also
// a problem, but a DIFFERENT one, and it emails separately. Report, do not double-alert.
if (newest.conclusion && newest.conclusion !== 'success') {
  console.log(`::warning::CI watchdog ran ${ageMin} min ago but concluded "${newest.conclusion}" - it alerts on that itself.`)
}

console.log('\nCI watchdog liveness: PASS')
  return 0
}

// exitCode, not process.exit(): calling exit() while a fetch handle is still closing aborts on
// Windows (libuv UV_HANDLE_CLOSING) and reports 127 instead of the intended code. An alarm whose
// exit status is ambiguous is the exact failure class this script exists to catch.
process.exitCode = await main()
