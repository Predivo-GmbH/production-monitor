import { defineConfig } from '@playwright/test'
import { sanitizeEnvAndReport } from './scripts/lib/credentials.mjs'

// A CREDENTIAL SECRET WITH AN INVISIBLE CHARACTER IN IT BREAKS EVERY SPEC THAT TOUCHES IT, and
// the error names undici's header encoder rather than the secret (2026-09-01: a UTF-8 BOM on
// JASSTOUR_SERVICE_ROLE_KEY reported itself as "Failed to create test user: Cannot convert
// argument to a ByteString"). See scripts/lib/credentials.mjs for the whole incident.
//
// HERE, at config module scope, rather than in globalSetup: Playwright loads this config in the
// main process AND again in every worker process, so the repair reaches the specs no matter how
// Playwright chooses to spawn them, and it happens before any spec's module-level
// `process.env.X_KEY || ''` has been evaluated. globalSetup runs in one process only and would
// have to rely on env inheritance surviving the fork.
//
// Reported once, from the main process only, so one bad secret is one line and not four. The
// value is never logged; the report names the variable and the code point.
sanitizeEnvAndReport(process.env, process.env.TEST_WORKER_INDEX === undefined ? console.warn : () => {})

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  // Suite-level cap: a hung suite must end as a FAILED run, never a job-level timeout.
  // GitHub reports an exceeded job `timeout-minutes` as conclusion=cancelled, which skips
  // every `if: failure()` step in monitor.yml — auto-fix, auto-heal, triage AND the alert
  // email — so a 25-min blackout run went out completely silent (2026-08-24, runner lost
  // network egress: all 96 tests burned their full timeout). 15 min is ~3x the normal
  // ~4m50s suite, and Playwright still writes results.json so send-alert.mjs can report.
  globalTimeout: 15 * 60_000,
  // Every run signs the monitor's test user out of every project it touched. Without this the
  // hourly login piled up abandoned sessions until Supabase alarmed on Disk IO (2026-08-29,
  // 111,117 sessions across 7 projects). See lib/revokeSessions.ts.
  globalTeardown: './lib/revokeSessions.ts',
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: 1,
  workers: 3,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
    ['json', { outputFile: 'test-results/results.json' }],
  ],
  use: {
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
    viewport: { width: 1280, height: 720 },
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
})
