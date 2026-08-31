/**
 * Local Triage Runner — the "prefer the local subscription agent over the paid API" layer.
 *
 * Runs on Roger's always-on desktop via a Windows Scheduled Task (every ~20 min). It checks the
 * cloud production-monitor for an UNRESOLVED failure and, if found, runs agent-triage LOCALLY
 * through the Claude Code CLI authed by his SUBSCRIPTION — so remediation costs NO API credits.
 * The cloud/API triage in monitor.yml stays disabled (repo var AGENT_TRIAGE_ENABLED=0) as a
 * fallback for when the desktop is off.
 *
 * Flow:
 *   1. Find the latest "Production Monitor" run. If it didn't FAIL (or is still running) → nothing to do.
 *   2. If we already handled that run id → nothing to do (dedup).
 *   3. Refresh a dedicated PRISTINE clone (so the agent commits from a clean tree, isolated from
 *      Roger's own working copy of the repo).
 *   4. Download the run's test-results artifact (results.json → the failing checks).
 *   5. Run agent-triage.mjs with AGENT_TRIAGE_ENABLED=1 + AGENT_TRIAGE_LOCAL=1 (subscription, no key).
 *   6. Record the handled run id + append to the runner log.
 *   7. GUARD SWEEP: poll the scheduled guard workflows (GUARD_WORKFLOWS below — they emit console
 *      output, not results.json, so agent-triage can't parse them). A failed guard run gets a
 *      generic headless Claude triage on its run log; dedup per workflow+run id in state.json.
 *
 * Requires on the desktop: git, gh (authenticated), node, and `claude` logged in to the subscription.
 * Env knobs: LOCAL_TRIAGE_DRY_RUN=1 (pass a dry run through), LOCAL_TRIAGE_HOME / _REPO overrides.
 */
import { execFileSync, execSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'fs'
import { join } from 'path'
import { pingUrl } from './lib/hc-ping.mjs'
import { agentToolFlags, DEPLOY_DENY_POLICY_NOTE } from './lib/deploy-deny-tools.mjs'

const REPO = process.env.LOCAL_TRIAGE_REPO || 'Arivioo/production-monitor'
const BRANCH = 'master'
const BASE = process.env.LOCAL_TRIAGE_HOME || 'C:\\Business\\_agent-triage'
const WORKDIR = join(BASE, 'production-monitor')
const STATE = join(BASE, 'state.json')
const LOG = join(BASE, 'runner.log')
const DRY = process.env.LOCAL_TRIAGE_DRY_RUN === '1'

// -- the one launcher every automation goes through (docs/CONTRACT-agent-run-2026-08-30.md) --
// Nothing here spawns `claude` directly any more. agent-run reads the cockpit's automation
// switches, strips the Anthropic env, picks the engine and enforces the wall-clock cap.
// ABSOLUTE path on purpose: this repo and Cockpit sit at the SAME absolute paths on the desktop
// and on the laptop, so an absolute path is the portable one here; a path derived from cwd or
// from $HOME is the thing that would differ between the two machines.
const AGENT_RUN = 'C:/Business/Internal Projects/Cockpit/scripts/agent-run.mjs'
const AGENT_RUN_JOB = 'agent-triage'
// Exit 76 = Roger switched the automations off in the cockpit. A deliberate off, never a failure
// (contract section 7): log one line, no alert, no failure outcome, no healthcheck ping, exit 0.
const SWITCHED_OFF_EXIT = 76
let switchedOff = false

function sh(cmd, opts = {}) {
  const out = execSync(cmd, {
    encoding: 'utf-8',
    timeout: opts.timeout || 60_000,
    stdio: opts.inherit ? 'inherit' : 'pipe',
    cwd: opts.cwd,
    env: opts.env || process.env,
  })
  return out ? out.toString() : ''
}
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`
  console.log(line)
  try { appendFileSync(LOG, line + '\n') } catch { /* noop */ }
}
function loadState() { try { return JSON.parse(readFileSync(STATE, 'utf-8')) } catch { return {} } }
function saveState(s) { try { writeFileSync(STATE, JSON.stringify(s, null, 2)) } catch { /* noop */ } }

// Pristine clone of THIS repo (isolated from Roger's own working copy), refreshed to origin/master.
function refreshClone() {
  if (!existsSync(join(WORKDIR, '.git'))) {
    log('cloning repo (first run)...')
    sh(`gh repo clone ${REPO} "${WORKDIR}"`, { timeout: 120_000 })
  }
  sh(`git fetch origin ${BRANCH}`, { cwd: WORKDIR })
  sh(`git checkout ${BRANCH}`, { cwd: WORKDIR })
  sh(`git reset --hard origin/${BRANCH}`, { cwd: WORKDIR })
  sh(`git clean -fd`, { cwd: WORKDIR })
}

function triageMonitor(state) {
  // 1. pick the run to triage. LOCAL_TRIAGE_FORCE_RUN=<id> overrides the poll (manual re-triage /
  //    testing) and bypasses the green + dedup checks.
  const forceRunId = process.env.LOCAL_TRIAGE_FORCE_RUN
  let run
  if (forceRunId) {
    try {
      run = JSON.parse(sh(`gh run view ${forceRunId} --repo ${REPO} --json databaseId,status,conclusion`))
    } catch (e) { log(`gh run view ${forceRunId} failed: ${e.message.split('\n')[0]}`); process.exit(1) }
    log(`FORCED run #${run.databaseId} (status=${run.status} conclusion=${run.conclusion})`)
  } else {
    try {
      run = JSON.parse(sh(`gh run list --repo ${REPO} --workflow=monitor.yml --limit 1 --json databaseId,status,conclusion,createdAt`))[0]
    } catch (e) { log(`gh run list failed: ${e.message.split('\n')[0]}`); process.exit(1) }
    if (!run) { log('no monitor runs found'); return }
    if (run.status !== 'completed') { log(`latest monitor run #${run.databaseId} still ${run.status} — will re-check next tick`); return }
    if (run.conclusion !== 'failure') { log(`monitor GREEN (run #${run.databaseId} ${run.conclusion}) — nothing to triage`); return }
    if (state.lastHandledRun === run.databaseId) { log(`run #${run.databaseId} already triaged — skip`); return }
  }

  log(`monitor run #${run.databaseId} FAILED — triaging locally on the subscription${DRY ? ' [DRY RUN]' : ''}...`)

  // 3. pristine clone
  try {
    refreshClone()
  } catch (e) { log(`repo refresh failed: ${e.message.split('\n')[0]}`); process.exit(1) }

  // 4. download the run's test-results (extracts test-results/results.json into WORKDIR)
  try {
    sh(`gh run download ${run.databaseId} --repo ${REPO} -n test-results -D "${WORKDIR}"`, { timeout: 120_000 })
  } catch (e) { log(`artifact download failed (agent will investigate via gh instead): ${e.message.split('\n')[0]}`) }

  // 5. run the agent LOCALLY on the subscription — force subscription auth by dropping any API key
  const env = { ...process.env, AGENT_TRIAGE_ENABLED: '1', AGENT_TRIAGE_LOCAL: '1' }
  delete env.ANTHROPIC_API_KEY
  if (DRY) env.AGENT_TRIAGE_DRY_RUN = '1'
  try {
    sh('node scripts/agent-triage.mjs', { cwd: WORKDIR, env, inherit: true, timeout: 15 * 60_000 })
  } catch (e) { log(`agent-triage errored/timed out: ${e.message.split('\n')[0]}`) }

  // 6. record (even on agent error — don't loop on the same broken run every tick)
  state.lastHandledRun = run.databaseId
  state.lastHandledAt = new Date().toISOString()
  saveState(state)
  log(`done with run #${run.databaseId}`)
}

// ── Guard-workflow sweep ─────────────────────────────────────────────────────────
// The scheduled GUARD workflows in this repo (a red run IS the alert) emit console output, not
// the Playwright results.json agent-triage.mjs parses — so the monitor path above can't see them.
// Scope gap found 2026-08-19: rls-grants-check + gate-coverage-check ran red >48h while this
// runner (monitor.yml-only poll) reported all-green. For each failed guard run, dispatch a
// generic headless Claude (subscription, no API cost) on the run log. LOCAL_GUARD_TRIAGE=0 disables.
const GUARD_WORKFLOWS = [
  'rls-grants-check.yml',
  'gate-coverage-check.yml',
  'auth-email-config-check.yml',
  'drift-check.yml',
  'cron-heartbeat.yml',
]

const GUARD_POLICY = `You are the guard-run triage agent for the production-monitor repo (${REPO}, branch ${BRANCH}). One of its scheduled GUARD workflows just went red. A red guard run IS the alert: either the guard found something real in the fleet, or the guard itself is broken.

Policy:
- Read the failing run's logs first: gh run view <runId> --repo ${REPO} --log. Identify the exact failing project/check.
- If the root cause is a bug in the guard script/workflow/test in THIS repo: fix it minimally (match repo style), run the repo's tests (test/*.test.mjs) when relevant, commit + push to ${BRANCH}. You may re-run the guard via \`gh workflow run <workflow-file> --repo ${REPO}\` to verify green.
- If the red is a REAL finding in a fleet product (RLS grant drift, broken v11 gates, config drift): do NOT weaken or silence the guard to make it pass. Report the finding precisely in the verdict. Product-side fixes are PRs on the target repo only.
- NEVER push to any repo other than THIS one; NEVER pr merge / run cancel / delete.
- Bound your work; do not loop.

FINAL ACTION (required): use the Write tool to write guard-triage-verdict.json in the repo root as JSON:
{"verdicts":[{"workflow":"","runId":"","class":"GUARD-BUG|REAL-FINDING|FLAKY|UNKNOWN","diagnosis":"1-3 sentences","action":"commit sha / PR url / escalation","escalate":true|false}]}`

function triageOneGuard(state, wf, run) {
  log(`guard ${wf} run #${run.databaseId} FAILED — triaging locally on the subscription${DRY ? ' [DRY RUN]' : ''}...`)
  try { refreshClone() } catch (e) { log(`repo refresh failed: ${e.message.split('\n')[0]}`); return }
  const prompt = [
    `Guard workflow "${wf}" run #${run.databaseId} in ${REPO} FAILED (scheduled guard, red).`,
    `Start by reading its logs: gh run view ${run.databaseId} --repo ${REPO} --log`,
    `Then triage per policy and write guard-triage-verdict.json.`,
  ].join('\n')
  const allowedTools = [
    'Read', 'Grep', 'Glob', 'Write',
    'Bash(gh api:*)', 'Bash(gh run view:*)', 'Bash(gh run list:*)', 'Bash(gh workflow run:*)', 'Bash(gh pr create:*)', 'Bash(gh repo clone:*)',
    'Bash(curl:*)', 'Bash(cat:*)', 'Bash(ls:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git diff:*)',
    ...(DRY ? [] : ['Edit', 'Bash(git:*)', 'Bash(node:*)']),
  ].join(',')
  const policy = (DRY
    ? GUARD_POLICY + '\n\n⚠️ DRY RUN: investigate read-only; write ONLY guard-triage-verdict.json; describe what you WOULD do as "[DRY-RUN would] ...".'
    : GUARD_POLICY) + DEPLOY_DENY_POLICY_NOTE
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Agent Triage', GIT_AUTHOR_EMAIL: 'noreply@predivo.ch', GIT_COMMITTER_NAME: 'Agent Triage', GIT_COMMITTER_EMAIL: 'noreply@predivo.ch' }
  delete env.ANTHROPIC_API_KEY // force the LOCAL subscription CLI, never a metered key
  try {
    // execFileSync with an args ARRAY (no shell) — see agent-triage.mjs for why (Windows quoting).
    // process.execPath is the node already running this file, so the runner never hard-codes a
    // node path; everything after `--` is the engine's own argv, unchanged.
    execFileSync(process.execPath, [
      AGENT_RUN, '--job', AGENT_RUN_JOB, '--',
      '-p', prompt,
      '--append-system-prompt', policy,
      ...agentToolFlags(allowedTools),
      // agent-run builds the Kimi write roots (KIMI_JOB_WRITE_ROOTS) from --add-dir and refuses a
      // Kimi launch without one (2026-08-31, the agent-triage Kimi profile). Root = the clone.
      '--add-dir', WORKDIR,
      '--max-turns', '40',
      '--model', 'claude-opus-4-8',
      '--output-format', 'json',
    ], { stdio: ['ignore', 'inherit', 'inherit'], timeout: 10 * 60_000, maxBuffer: 64 * 1024 * 1024, cwd: WORKDIR, env })
  } catch (e) {
    // execFileSync THROWS on a non-zero exit; the code is on err.status.
    if (e?.status === SWITCHED_OFF_EXIT) {
      switchedOff = true
      log('automations are switched off in the cockpit - guard triage skipped (a deliberate off, not a failure)')
      return   // BEFORE the handledGuards write below: a guard run nothing looked at is not handled
    }
    log(`guard-triage agent errored/timed out: ${e.message.split('\n')[0]}`)
  }
  if (!state.handledGuards) state.handledGuards = {}
  state.handledGuards[wf] = run.databaseId
  saveState(state)
  log(`done with guard ${wf} run #${run.databaseId}`)
}

function triageGuards(state) {
  if (process.env.LOCAL_GUARD_TRIAGE === '0') return
  for (const wf of GUARD_WORKFLOWS) {
    let run
    try {
      run = JSON.parse(sh(`gh run list --repo ${REPO} --workflow=${wf} --limit 1 --json databaseId,status,conclusion`))[0]
    } catch (e) { log(`[guard ${wf}] run list failed: ${e.message.split('\n')[0]}`); continue }
    if (!run || run.status !== 'completed' || run.conclusion !== 'failure') continue
    if (state.handledGuards?.[wf] === run.databaseId) { log(`[guard ${wf}] run #${run.databaseId} already triaged — skip`); continue }
    triageOneGuard(state, wf, run)
    if (switchedOff) return   // the switch is fleet-wide; the other guards would only re-learn it
  }
}

function main() {
  if (!existsSync(BASE)) mkdirSync(BASE, { recursive: true })
  const state = loadState()
  triageMonitor(state)
  triageGuards(state)
}

// Heartbeat (2026-08-10 reliability plan): success ping / fail signal to healthchecks.io.
const HC = pingUrl('agenttriage-localrunner')
Promise.resolve().then(main).then(
  () => (HC && !switchedOff ? fetch(HC).catch(() => {}) : undefined),
  (e) => Promise.resolve(HC ? fetch(`${HC}/fail`).catch(() => {}) : null).then(() => { console.error(e); process.exitCode = 1 }),
)
