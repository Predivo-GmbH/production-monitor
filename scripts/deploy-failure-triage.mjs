/**
 * Deploy-Failure Triage — Phase 2b of the agentic auto-remediation plan (Tier B, PR-only).
 *
 * The gap this closes: the live-site monitor triage (agent-triage.mjs) reacts to Playwright
 * failures against production URLs. The deploy PIPELINES (each repo's deploy.yml) are a different
 * surface — when one goes red on a CODE failure (build / typecheck / unit / gate-e2e), nothing
 * diagnoses it. flaky-retry.mjs deliberately SKIPS code failures (a retry can't fix a real bug),
 * and auto-heal only handles site-down. So a broken commit just sits red on the Deploy-Status
 * board until Roger opens the log himself.
 *
 * This orchestrator polls the fleet's deploy.yml runs, and for each CURRENT code failure spawns a
 * headless Claude agent that DIAGNOSES the root cause and opens a **PR** on the target repo with a
 * suggested fix + written diagnosis. It NEVER auto-ships: no push to the deploy branch, no merge,
 * no prod dispatch. A real regression becomes a reviewable PR; anything it can't safely patch is an
 * escalation with a root-cause hypothesis.
 *
 * WHY it can't collide with anything else:
 *   - Only the LATEST deploy run per branch, and only if its head_sha still == branch HEAD. If a
 *     newer commit landed (someone is actively pushing) or a newer run went green, we SKIP — so it
 *     never diagnoses a commit that's already been superseded or fixed.
 *   - `push` / `schedule` events only — NEVER a workflow_dispatch (those are manual prod promotions).
 *   - CODE failures only (build/typecheck/lint/unit/gate-e2e). Infra flakes stay with flaky-retry.
 *   - One PR per broken commit: dedup by (repo, head_sha) in state.json, and the agent also checks
 *     for an existing open agent PR before creating another.
 *   - Target-repo writes are PRs on an `agent/deploy-fix-*` branch only. The deploy branch is never
 *     touched, so an in-flight human/session push is never overwritten.
 *
 * ── SUBSCRIPTION GATE (mirrors agent-triage.mjs) ─────────────────────────────────────────────
 * Runs when DEPLOY_TRIAGE_ENABLED=1 AND DEPLOY_TRIAGE_LOCAL=1 (a subscription-logged-in `claude`).
 * There is NO paid/API-key path: the child env strips ANTHROPIC_API_KEY below, so a key-only run
 * cannot authenticate — the gate requires LOCAL and refuses otherwise. The scheduled local task
 * (setup-deploy-triage-task.ps1) sets ENABLED+LOCAL so it costs no API credits. Kill-switch:
 * DEPLOY_TRIAGE_DISABLED=1. Dry run: DEPLOY_TRIAGE_DRY_RUN=1 (read-only, write only the verdict).
 *
 * Requires on the host: git, gh (authenticated with a fleet PAT: repo + pull-request write), node,
 * and — in LOCAL mode — `claude` logged in to the subscription.
 */
import { execSync, execFileSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, rmSync } from 'fs'
import { join } from 'path'
import { getFleet } from '../lib/fleet.mjs'
import { pingUrl } from './lib/hc-ping.mjs'
import { agentToolFlags, DEPLOY_DENY_POLICY_NOTE } from './lib/deploy-deny-tools.mjs'

// Fleet: name/repo/deploy-branch from the DB-backed registry (fleet_products) via getFleet(). Filter
// to deploy-monitored products (branch != null). Falls back to the identical hardcoded superset on any
// DB failure, so triage can never lose a product; a launched product auto-appears once its row exists.
const { fleet: _fleet, source: _fleetSource } = await getFleet()
const PROJECTS = _fleet.filter((p) => p.branch)
console.log(`deploy-triage: fleet source = ${_fleetSource} (${PROJECTS.length} deploy-monitored)`)

// Real code failures — the class that needs a fix, not a retry. Mirrors flaky-retry CODE, plus the
// broad e2e/integration "gate" jobs which are code when they fail on the current HEAD (a retry
// already had its chance via flaky-retry; a still-red gate on HEAD is a real failing test). The
// integration gates (gate-integration / gate-critical / "integration tests") were previously
// swallowed by INFRA_ONLY's "edge function" pattern and skipped forever with nobody diagnosing them
// — the 2026-07-24 SignalScore gap. They belong here so a PERSISTENT one gets an agent diagnosis.
const CODE = /\blint\b|unit test|coverage|typecheck|tsc|feature coverage|build|run build|gate-e2e|gate-integration|gate-critical|e2e test|integration test|vitest|jest|playwright test/i
// Pure-infra step names we still leave to flaky-retry / auto-heal even if they linger. (CODE is
// checked FIRST, so a test gate that also mentions "edge function" is correctly treated as code.)
const INFRA_ONLY = /ftp|deploy .*staging|deploy .*production|verify .*alive|supabase cli|edge function|install deps|npm ci|setup-node|checkout|cache|prerender|smoke|rate limit/i

const BASE = process.env.DEPLOY_TRIAGE_HOME || 'C:\\Business\\_agent-triage'
const WORKROOT = join(BASE, 'deploy-fixes')
const STATE = join(BASE, 'deploy-triage-state.json')
const LOG = join(BASE, 'deploy-triage.log')
const LOOKBACK_MS = 6 * 60 * 60 * 1000   // only diagnose recent breakage
// Prod-promotion watchdog: a FAILED manual promotion can sit red on the board for many hours before
// anyone looks (this one sat ~9h on 2026-08-14). Look back a full week so a stale failure still
// pages; dedup-by-runId (not time) keeps it to a single alert per failed promotion.
const PROMO_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000
// Auto-retry a transient (DEPLOY-STEP) prod promotion ONLY if it's fresh — a transient FTP/network
// blip is minutes old. An old failure is not "transient"; a human should look. Retry is one-shot.
const PROMO_AUTORETRY_WINDOW_MS = 3 * 60 * 60 * 1000
const RUNS_PER_REPO = 12
const MODEL = 'claude-opus-4-8'
const MAX_TURNS = 60
const AGENT_TIMEOUT_MS = 18 * 60 * 1000

function sh(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf-8', timeout: opts.timeout || 30_000, cwd: opts.cwd, stdio: opts.inherit ? 'inherit' : 'pipe' })?.toString() ?? ''
}
function gh(args, opts = {}) { return sh(`gh ${args}`, opts).trim() }
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`
  console.log(line)
  try { appendFileSync(LOG, line + '\n') } catch { /* noop */ }
}
function loadState() { try { return JSON.parse(readFileSync(STATE, 'utf-8')) } catch { return { handled: {} } } }
function saveState(s) { try { writeFileSync(STATE, JSON.stringify(s, null, 2)) } catch { /* noop */ } }

function branchHead(repo, branch) {
  try { return gh(`api repos/${repo}/git/ref/heads/${branch} --jq .object.sha`) }
  catch { return null }
}

// The failing job + step for a run (mirrors flaky-retry.failedStepName but keeps the job too).
function failedJobStep(repo, runId) {
  try {
    const data = JSON.parse(gh(`run view ${runId} --repo ${repo} --json jobs`))
    for (const job of data.jobs ?? []) {
      if (job.conclusion !== 'failure') continue
      const step = (job.steps ?? []).find((s) => s.conclusion === 'failure')
      return { job: job.name, step: step ? step.name : job.name }
    }
  } catch { /* best effort */ }
  return { job: '', step: '' }
}

// Does an open agent deploy-fix PR already exist for this repo? (belt-and-braces on top of state dedup)
// The marker lives in the PR's HEAD BRANCH (agent/deploy-fix-<sha>), so filter branches in JS —
// `--search in:title` would miss it because the branch name isn't in the title.
function hasOpenAgentPr(repo) {
  try {
    const prs = JSON.parse(gh(`pr list --repo ${repo} --state open --limit 50 --json headRefName`))
    return prs.some((p) => (p.headRefName || '').startsWith('agent/deploy-fix'))
  } catch { return false }
}

// Find the single actionable failure per project: the LATEST deploy run, still HEAD, code-failed.
function findCandidates(state) {
  const candidates = []
  for (const p of PROJECTS) {
    let runs
    try {
      runs = JSON.parse(gh(
        `run list --repo ${p.repo} --workflow=deploy.yml --branch ${p.branch} --limit ${RUNS_PER_REPO} ` +
        `--json databaseId,status,conclusion,createdAt,headSha,event,attempt,displayTitle`,
      ))
    } catch (e) { log(`[skip] ${p.name}: run list failed (${e.message.split('\n')[0]})`); continue }
    if (!runs || runs.length === 0) continue

    const latest = runs[0]
    if (latest.status !== 'completed') continue              // a run is in flight → let it finish
    if (latest.conclusion !== 'failure') continue            // green (or cancelled) → nothing to fix
    if (Date.now() - new Date(latest.createdAt).getTime() > LOOKBACK_MS) continue
    if (latest.event === 'workflow_dispatch') continue       // prod promotion — never touch

    // Persistence gate (Roger's alerting philosophy: auto-fix first, only own PERSISTENT breakage).
    // Don't diagnose a fresh first-attempt failure — flaky-retry may still rerun it green (a
    // transient JWT/staging blip). Own it only once it's persistent: already retried (attempt >= 2,
    // still red) OR older than the ~2h auto-retry window. Prevents a "this was just transient" no-op
    // escalation email — the 2026-07-24 SignalScore class.
    const ageMs = Date.now() - new Date(latest.createdAt).getTime()
    const persistent = (latest.attempt ?? 1) >= 2 || ageMs >= 2 * 60 * 60 * 1000
    if (!persistent) { log(`[skip] ${p.name}#${latest.databaseId}: first-attempt failure ${Math.round(ageMs / 60000)}m old — inside auto-retry window, not yet persistent`); continue }

    const head = branchHead(p.repo, p.branch)
    if (head && latest.headSha !== head) {                   // superseded by a newer commit → skip (don't collide)
      log(`[skip] ${p.name}#${latest.databaseId}: not HEAD anymore (a newer commit landed) — leaving it`)
      continue
    }

    const dedupKey = `${p.repo}@${latest.headSha}`
    if (state.handled[dedupKey]) continue                    // already opened a PR / escalated for this commit

    const { job, step } = failedJobStep(p.repo, latest.databaseId)
    if (!CODE.test(step) && !CODE.test(job)) {
      // Not a code failure → flaky-retry / auto-heal own it. Only log the infra ones for visibility.
      if (INFRA_ONLY.test(step) || INFRA_ONLY.test(job)) log(`[skip] ${p.name}#${latest.databaseId}: infra step "${step}" (flaky-retry/auto-heal own it)`)
      else log(`[skip] ${p.name}#${latest.databaseId}: non-code step "${step}" — leaving for the alert path`)
      continue
    }

    if (hasOpenAgentPr(p.repo)) {
      log(`[skip] ${p.name}#${latest.databaseId}: an agent deploy-fix PR is already open`)
      state.handled[dedupKey] = { at: new Date().toISOString(), note: 'pr-already-open' }
      continue
    }

    candidates.push({ ...p, runId: latest.databaseId, headSha: latest.headSha, event: latest.event, job, step, title: latest.displayTitle, dedupKey })
  }
  return candidates
}

// ── Tier-B policy for deploy-pipeline failures (agent system prompt) ─────────────────────────
const SYSTEM_POLICY = `You are the deploy-pipeline triage agent for a fleet of production SaaS apps. One project's deploy pipeline (its GitHub Actions deploy.yml) just failed on a CODE step (build / typecheck / lint / unit / e2e) on the CURRENT branch HEAD. Your job: diagnose the ROOT CAUSE and open a PULL REQUEST on the target repo with a suggested fix. You run headless in CI with real git + gh write access. Be conservative, deterministic, and evidence-driven.

INVESTIGATE (read-only first):
- Read the failing run's logs: \`gh run view <runId> --repo <repo> --log-failed\` (and \`--log\` if you need context). Identify the exact failing job, step, and error.
- You are given a PRISTINE local clone of the target repo at HEAD. Read the relevant source + test files. Use \`gh api repos/<repo>/commits?per_page=15\` and \`git log\`/\`git show\` to find the commit that introduced the break.
- If it's quick and safe, REPRODUCE locally in the clone (e.g. \`npm ci\` then the failing test/build command) to confirm the cause and to VERIFY your fix before proposing it. Do not spend more than a few minutes; if repro is slow/flaky, diagnose from logs + code instead.

CLASSIFY and take the ONE permitted action:
1. REGRESSION / real code break (a bug, a broken test, a type error, a missing import, a bad assertion) — construct the SMALLEST correct fix. Create a NEW branch \`agent/deploy-fix-<short-sha>\`, commit the fix (message prefixed "[agent-triage] "), push THAT branch only, and \`gh pr create\` against the deploy branch with: a title naming the project + failing step, and a body that states the root cause, the fix, and how you verified it (or that you could not run it). NEVER commit or push to the deploy branch (main/master). NEVER \`gh pr merge\`.
2. TEST-DRIFT — the product intentionally changed and the TEST is now asserting on the old behaviour (proven by a recent commit). Same action as (1): fix the TEST in a PR. NEVER weaken/delete a test just to make CI green if the product is actually broken — that masks a regression; if unsure, treat as REGRESSION.
3. ENV / SECRET / CI-CONFIG — the failure is a missing/rotated secret, a CI runner/config issue, or an environment gap (not the app code). ACTION: none automatic — escalate with exactly which secret/config and the fix.
4. CANNOT SAFELY PATCH — you understand the cause but a correct fix isn't small/safe to construct headlessly. ACTION: escalate with a written root-cause + a suggested patch in prose. Do NOT open a low-confidence PR.

HARD RULES:
- NEVER push to a deploy branch (main/master) of any repo. Target-repo changes are PRs on an \`agent/deploy-fix-*\` branch ONLY.
- NEVER run destructive gh: no \`pr merge\`, no \`run rerun\`/\`run cancel\`, no \`workflow run\`/dispatch, no delete, no force-push.
- Do not touch unrelated files. The PR must be minimal and scoped to the failing cause.
- One PR per failure. Before creating, run \`gh pr list\` to ensure you're not duplicating an open agent PR.
- Bound your work; do not loop.

FINAL ACTION (required): use the Write tool to write triage-verdict.json in your CURRENT working directory as JSON:
{"verdicts":[{"project":"","repo":"","runId":"","class":"REGRESSION|TEST-DRIFT|ENV|CANNOT-PATCH","rootCause":"1-3 sentences","action":"PR url / escalation / none","prUrl":"","verified":"how you verified, or 'not run'","escalate":true|false,"suggestedFix":"prose, only if escalating"}]}`

function buildUserPrompt(c, workdir) {
  return [
    `A deploy pipeline just failed on a code step. Triage it per policy and open a PR (or escalate).`,
    ``,
    `- Project: ${c.name}`,
    `- Target repo: ${c.repo}  (deploy branch: ${c.branch})`,
    `- Failed run: ${c.runId}  (event: ${c.event}, commit: ${c.headSha})`,
    `- Failing job → step: "${c.job}" → "${c.step}"`,
    `- Commit title: ${c.title || 'unknown'}`,
    `- Pristine clone (work here, at HEAD ${c.headSha.slice(0, 7)}): ${workdir}`,
    ``,
    `Start by reading the failing logs: gh run view ${c.runId} --repo ${c.repo} --log-failed`,
    `Then investigate the code in the clone, construct the smallest correct fix, verify if quick, and open the PR against ${c.branch}. Write triage-verdict.json when done.`,
  ].join('\n')
}

function prepareClone(c) {
  if (!existsSync(WORKROOT)) mkdirSync(WORKROOT, { recursive: true })
  const dir = join(WORKROOT, c.repo.split('/')[1])
  try {
    if (!existsSync(join(dir, '.git'))) {
      log(`  cloning ${c.repo} (first time)...`)
      sh(`gh repo clone ${c.repo} "${dir}"`, { timeout: 180_000 })
    }
    sh(`git fetch origin ${c.branch}`, { cwd: dir, timeout: 120_000 })
    sh(`git checkout ${c.branch}`, { cwd: dir })
    sh(`git reset --hard ${c.headSha}`, { cwd: dir })
    sh(`git clean -fd`, { cwd: dir })
  } catch (e) {
    log(`  clone/refresh failed for ${c.repo}: ${e.message.split('\n')[0]}`)
    return null
  }
  return dir
}

function runAgent(c, workdir, dryRun) {
  const verdictPath = join(workdir, 'triage-verdict.json')
  try { if (existsSync(verdictPath)) rmSync(verdictPath) } catch { /* noop */ }

  const READ_ONLY = [
    'Read', 'Grep', 'Glob', 'Write',
    'Bash(gh api:*)', 'Bash(gh run view:*)', 'Bash(gh pr list:*)', 'Bash(gh pr view:*)',
    'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git diff:*)', 'Bash(git status:*)',
    'Bash(cat:*)', 'Bash(ls:*)', 'Bash(curl:*)',
  ]
  const WRITE = [
    'Edit', 'Bash(git:*)', 'Bash(gh pr create:*)',
    'Bash(npm:*)', 'Bash(npx:*)', 'Bash(node:*)', 'Bash(pnpm:*)',
  ]
  const allowedTools = (dryRun ? READ_ONLY : [...READ_ONLY, ...WRITE]).join(',')
  const DRY_NOTE = '\n\n⚠️ DRY RUN: Do NOT branch, commit, push, edit, or open PRs — investigate read-only and write ONLY triage-verdict.json. In "action", describe what you WOULD do, prefixed "[DRY-RUN would] ".'
  const policy = (dryRun ? SYSTEM_POLICY + DRY_NOTE : SYSTEM_POLICY) + DEPLOY_DENY_POLICY_NOTE

  const CLAUDE_BIN = process.platform === 'win32' ? 'claude.exe' : 'claude'
  const args = [
    '-p', buildUserPrompt(c, workdir),
    '--append-system-prompt', policy,
    ...agentToolFlags(allowedTools),
    '--max-turns', String(MAX_TURNS),
    '--model', MODEL,
    '--output-format', 'json',
  ]
  // ALWAYS the subscription CLI, never a metered key. This used to drop the key only when
  // DEPLOY_TRIAGE_LOCAL=1, which means every other mode billed per run — and the comment already
  // knew the risk ("would silently route to the PAID API and bill per run") while the code only
  // covered one branch. Roger's standing rule, 2026-08-29: the API key is only for work a customer
  // triggers inside a product. Triage has no customer in the loop, so the condition is gone.
  const agentEnv = { ...process.env, GIT_AUTHOR_NAME: 'Agent Triage', GIT_AUTHOR_EMAIL: 'noreply@predivo.ch', GIT_COMMITTER_NAME: 'Agent Triage', GIT_COMMITTER_EMAIL: 'noreply@predivo.ch' }
  delete agentEnv.ANTHROPIC_API_KEY
  delete agentEnv.ANTHROPIC_AUTH_TOKEN
  delete agentEnv.ANTHROPIC_BASE_URL
  try {
    execFileSync(CLAUDE_BIN, args, {
      cwd: workdir,
      stdio: ['ignore', 'inherit', 'inherit'],
      timeout: AGENT_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      env: agentEnv,
    })
  } catch (e) {
    log(`  agent errored/timed out for ${c.name}: ${e.message?.split('\n')[0]}`)
  }

  let verdicts = []
  if (existsSync(verdictPath)) {
    try { verdicts = JSON.parse(readFileSync(verdictPath, 'utf-8')).verdicts ?? [] } catch { /* malformed */ }
  }
  return verdicts
}

async function main() {
  if (process.env.DEPLOY_TRIAGE_DISABLED === '1') { log('DEPLOY_TRIAGE_DISABLED=1 — no-op'); return }

  // ── Prod-promotion watchdog probes (alert-only surface) ──────────────────────────────────────
  // Ops probe: send a sample prod-promotion alert (proves the email path).
  if (process.env.PROMO_WATCH_TEST_EMAIL === '1') {
    log('PROMO_WATCH_TEST_EMAIL=1 — sending a sample prod-promotion alert...')
    await sendPromoEmail([{ project: 'SampleProject', repo: 'Arivioo/sample', runId: '0', step: 'Verify staging gate', klass: 'STAGING-GATE (test)', reason: 'This is a test of the prod-promotion watchdog alert — no real failure.', remedy: 'No action needed — test only.' }])
    return
  }
  // Force-classify a specific real failed promotion run and email it (proof against real data).
  // Format: PROMO_WATCH_FORCE_RUN="Arivioo/backoffice=31748761448". Bypasses dedup + lookback.
  if (process.env.PROMO_WATCH_FORCE_RUN) {
    const [repo, runId] = process.env.PROMO_WATCH_FORCE_RUN.split('=')
    const p = PROJECTS.find((x) => x.repo.toLowerCase() === (repo || '').toLowerCase()) || { name: repo, repo, branch: 'main' }
    let run = { databaseId: runId, headSha: '' }
    try { run = { ...run, ...JSON.parse(gh(`run view ${runId} --repo ${repo} --json headSha,displayTitle`)) } } catch { /* best effort */ }
    const { step, job } = failedJobStep(repo, runId)
    const cls = classifyPromoFailure(p, run, step)
    log(`PROMO_WATCH_FORCE_RUN: ${p.name}#${runId} → ${cls.klass} ("${step || job}")`)
    await sendPromoEmail([{ project: p.name, repo, runId, step: step || job, headSha: run.headSha, ...cls }])
    return
  }
  // Free detection (no agent) — runs on every tick regardless of the paid-key AI gate below.
  try { await checkProdPromotions() } catch (e) { log(`prod-promotion watchdog error: ${e.message.split('\n')[0]}`) }

  // Ops probe: verify the alert-email config end-to-end without a real failure.
  if (process.env.DEPLOY_TRIAGE_TEST_EMAIL === '1') {
    log('DEPLOY_TRIAGE_TEST_EMAIL=1 — sending a sample alert...')
    await sendTriageEmail([{ project: 'SampleProject', step: 'gate-e2e', class: 'ESCALATION (test)', rootCause: 'This is a test of the deploy-triage alert email — no real failure.', action: 'none', escalate: true, runUrl: 'https://github.com/Predivo-GmbH/production-monitor/actions' }])
    return
  }

  const enabled = process.env.DEPLOY_TRIAGE_ENABLED === '1'
  const local = process.env.DEPLOY_TRIAGE_LOCAL === '1'
  if (!enabled || !local) {
    const hasKey = !!process.env.ANTHROPIC_API_KEY
    log(`⏭️  deploy-failure-triage SKIPPED: DEPLOY_TRIAGE_ENABLED=${process.env.DEPLOY_TRIAGE_ENABLED || 'unset'}, DEPLOY_TRIAGE_LOCAL=${local ? '1' : 'unset'}, ANTHROPIC_API_KEY ${hasKey ? 'set (ignored — stripped from the child; not a credential for this tier)' : 'unset'}. Runs ONLY when ENABLED=1 AND LOCAL=1 (subscription CLI); there is no paid/API-key path.`)
    return
  }

  const dryRun = process.env.DEPLOY_TRIAGE_DRY_RUN === '1'
  const detectOnly = process.env.DEPLOY_TRIAGE_DETECT_ONLY === '1'
  if (!existsSync(BASE)) mkdirSync(BASE, { recursive: true })
  const state = loadState()
  if (!state.handled) state.handled = {}

  log(`deploy-failure-triage: polling ${PROJECTS.length} deploy pipelines${detectOnly ? ' [DETECT-ONLY]' : dryRun ? ' [DRY RUN]' : ''} (LOCAL/subscription)...`)
  // DETECT-ONLY: run the fleet poll + classification and print what WOULD be diagnosed, without
  // cloning or invoking the agent. Safe ops/validation probe (no writes, no state, no cost).
  const candidates = findCandidates(detectOnly ? { handled: {} } : state)
  if (detectOnly) {
    if (candidates.length === 0) log('DETECT-ONLY: no current code-failures across the fleet.')
    candidates.forEach((c) => log(`DETECT-ONLY: would diagnose ${c.name} #${c.runId} — "${c.step}" @ ${c.headSha.slice(0, 7)} (${c.event})`))
    return
  }
  if (candidates.length === 0) { log('deploy-failure-triage: no current code-failures to diagnose. All clear.'); return }

  log(`deploy-failure-triage: ${candidates.length} code-failure(s) to diagnose → ${candidates.map((c) => `${c.name}#${c.runId}`).join(', ')}`)

  const diagnoses = []   // one per verdict, across all candidates — folded into the alert email
  for (const c of candidates) {
    log(`▶ ${c.name} #${c.runId}: "${c.step}" (commit ${c.headSha.slice(0, 7)}) — diagnosing...`)
    const workdir = prepareClone(c)
    if (!workdir) { log(`  ${c.name}: clone unavailable — skipping this tick (will retry)`); continue }

    const verdicts = runAgent(c, workdir, dryRun)

    // Record so we don't re-diagnose the same broken commit next tick (even on agent error — a fix
    // PR, once open, will be picked up by hasOpenAgentPr; a failed diagnosis shouldn't loop forever).
    if (!dryRun) {
      state.handled[c.dedupKey] = {
        at: new Date().toISOString(),
        runId: c.runId,
        verdicts: verdicts.map((v) => ({ class: v.class, action: v.action, prUrl: v.prUrl || '', escalate: !!v.escalate })),
      }
      saveState(state)
    }
    verdicts.forEach((v) => {
      log(`  [${v.class}] ${c.name} → ${v.action}${v.prUrl ? ' (' + v.prUrl + ')' : ''}${v.escalate ? ' — NEEDS ROGER' : ''}`)
      diagnoses.push({ project: c.name, step: c.step, runUrl: `https://github.com/${c.repo}/actions/runs/${c.runId}`, ...v })
    })
    if (verdicts.length === 0) {
      log(`  ${c.name}: agent produced no verdict (see output above)`)
      diagnoses.push({ project: c.name, step: c.step, runUrl: `https://github.com/${c.repo}/actions/runs/${c.runId}`, class: 'UNKNOWN', rootCause: 'The triage agent produced no verdict — see runner output.', action: 'none', escalate: true })
    }
  }

  // Ping Roger for anything that needs him (an opened fix PR to review, or an escalation the agent
  // couldn't fix). Silent no-op if SMTP isn't configured in the environment.
  if (!dryRun) await sendTriageEmail(diagnoses.filter((d) => d.escalate || d.prUrl))

  log('deploy-failure-triage: done.')
}

// ── Alert email (folds the AI diagnosis into a ping) ────────────────────────────────────────
async function sendTriageEmail(items) {
  if (!items || items.length === 0) return
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, ALERT_EMAIL } = process.env
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !ALERT_EMAIL) {
    log(`  (email skipped — SMTP/ALERT_EMAIL not configured; ${items.length} item(s) in deploy-triage.log)`)
    return
  }
  let createMailTransport
  try { ({ createMailTransport } = await import('./lib/smtp.mjs')) }
  catch { log('  (email skipped — nodemailer not available)'); return }

  const esc = (s) => String(s ?? '').replace(/[<>&]/g, (m) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[m]))
  const rows = items.map((d) => `
    <tr>
      <td style="padding:8px;border:1px solid #e5e7eb;font-weight:600;white-space:nowrap">${esc(d.project)}</td>
      <td style="padding:8px;border:1px solid #e5e7eb">${esc(d.class)}${d.step ? ' · ' + esc(d.step) : ''}</td>
      <td style="padding:8px;border:1px solid #e5e7eb">${esc(d.rootCause || d.diagnosis || '')}</td>
      <td style="padding:8px;border:1px solid #e5e7eb;white-space:nowrap">${d.prUrl ? `<a href="${esc(d.prUrl)}" style="color:#2563eb">PR ansehen</a>` : (d.escalate ? '<span style="color:#dc2626">Braucht dich</span>' : '—')} · <a href="${esc(d.runUrl)}" style="color:#2563eb">Run</a></td>
    </tr>`).join('')
  const prCount = items.filter((d) => d.prUrl).length
  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:760px;margin:0 auto">
      <div style="background:#dc2626;color:white;padding:16px 24px;border-radius:8px 8px 0 0">
        <h2 style="margin:0;font-size:18px">Deploy-Pipeline Triage — ${items.length} Diagnose(n)</h2>
        <p style="margin:4px 0 0;font-size:14px;opacity:0.9">${prCount} Fix-PR(s) zum Review · ${items.length - prCount} Eskalation(en)</p>
      </div>
      <div style="padding:24px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px">
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead><tr style="background:#fef2f2">
            <th style="padding:8px;border:1px solid #e5e7eb;text-align:left">Projekt</th>
            <th style="padding:8px;border:1px solid #e5e7eb;text-align:left">Klasse</th>
            <th style="padding:8px;border:1px solid #e5e7eb;text-align:left">Ursache</th>
            <th style="padding:8px;border:1px solid #e5e7eb;text-align:left">Aktion</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <p style="margin-top:16px;font-size:12px;color:#6b7280">Deploy-Status live: backoffice.predivo.ch/deploy-status · gesendet ${new Date().toISOString()}</p>
      </div>
    </div>`
  try {
    const transporter = await createMailTransport({
      host: SMTP_HOST, port: SMTP_PORT, user: SMTP_USER, pass: SMTP_PASS,
    })
    await transporter.sendMail({
      from: `Deploy Triage <${SMTP_USER}>`,
      to: ALERT_EMAIL,
      subject: `[DEPLOY] ${items.length} Diagnose(n) — ${prCount} Fix-PR, ${items.length - prCount} Eskalation`,
      html,
    })
    log(`  📧 alert emailed to ${ALERT_EMAIL} (${items.length} item(s))`)
  } catch (e) {
    log(`  email send failed: ${e.message.split('\n')[0]} (items still in deploy-triage.log)`)
  }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// PROD-PROMOTION WATCHDOG (alert-only) — closes the blind spot this file's own exclusions create.
//
// Every auto-remediation layer deliberately ignores `workflow_dispatch` runs (flaky-retry.mjs:105,
// findCandidates line ~133, auto-heal only does site-down) because a bot must NEVER auto-retry or
// auto-push a PRODUCTION promotion. Correct — but it left a hole: when a MANUAL prod promotion
// fails, it renders red on the Deploy-Status board with no alert, no triage, no heal, and just sits
// there until a human notices (BackOffice, 2026-08-14, ~9h stale). This watchdog watches exactly
// that surface: latest failed prod-dispatch per repo → classify → EMAIL. It NEVER dispatches prod;
// detection + a ping with a one-line remedy only. Free (no agent) → runs before the paid-key gate.
// ══════════════════════════════════════════════════════════════════════════════════════════════

function runUrl(repo, runId) { return `https://github.com/${repo}/actions/runs/${runId}` }

// Does the current branch HEAD have a green staging (push) run? Mirrors the deploy.yml prod gate —
// if true, the failed promotion is trivially fixable by re-dispatching (it will promote HEAD).
function headHasGreenStaging(repo, branch) {
  try {
    const head = branchHead(repo, branch)
    if (!head) return { promotable: false, head: null }
    const n = JSON.parse(gh(
      `run list --repo ${repo} --workflow=deploy.yml --branch ${branch} --event push --limit 30 ` +
      `--json headSha,conclusion`,
    )).filter((r) => r.headSha === head && r.conclusion === 'success').length
    return { promotable: n >= 1, head }
  } catch { return { promotable: false, head: null } }
}

// Classify a failed prod promotion into an actionable reason + remedy. No per-repo paths-ignore
// parsing (kept lean) — the staging-gate case names the usual cause and gives the exact fix.
function classifyPromoFailure(p, run, step) {
  const s = String(step || '')
  if (/staging gate|verify staging/i.test(s)) {
    const { promotable, head } = headHasGreenStaging(p.repo, p.branch)
    return {
      klass: 'STAGING-GATE',
      reason: `The promoted commit ${String(run.headSha || '').slice(0, 7)} has no green staging run, so the production gate refused it. Usual cause: the commit changed only paths-ignore files (.gitignore / docs/** / *.md), which don't trigger the staging pipeline — so it can never be promoted.`,
      remedy: promotable
        ? `Current branch HEAD (${String(head || '').slice(0, 7)}) already has a green staging run — just re-run the promotion to ship HEAD:  gh workflow run deploy.yml --repo ${p.repo} -f confirm=deploy`
        : `Push a real (non-paths-ignore) commit to ${p.branch}, wait for the staging pipeline to go green, then promote.`,
    }
  }
  // DEPLOY-STEP = a specific FTP/upload/verify step (the commit already passed the staging gate).
  // Deliberately precise step names — NOT the bare "deploy" job fallback or "build" (those are real
  // failures a retry can't fix), so only a genuine transient infra step is auto-retry-eligible.
  if (/ftp|lftp|upload|mirror|clean old|verify production|site-id/i.test(s)) {
    return {
      klass: 'DEPLOY-STEP',
      reason: `The production deploy failed at "${s}" — typically a transient FTP/network blip on a commit that already passed the staging gate.`,
      remedy: `Open the run log; if it looks transient, re-run:  gh workflow run deploy.yml --repo ${p.repo} -f confirm=deploy`,
    }
  }
  return {
    klass: 'OTHER',
    reason: `The production promotion failed at "${s || 'an unknown step'}".`,
    remedy: `Open the run log to diagnose: ${runUrl(p.repo, run.databaseId)}`,
  }
}

// Poll each repo's latest MANUAL prod promotion and act on a recent failure. State machine per run
// (dedup/track by repo@runId in state.promo):
//   · DEPLOY-STEP (transient FTP/verify) on a commit still == branch HEAD, fresh → AUTO-RETRY ONCE
//     (`gh run rerun` re-runs the SAME commit's promotion), then a calm "watching" email.
//   · A run we already retried that failed AGAIN → ESCALATE (alert, no second retry — no loop).
//   · STAGING-GATE / OTHER / ineligible DEPLOY-STEP → ALERT once.
// NEVER dispatches a fresh prod deploy of a NEW/other commit — a rerun only re-attempts the exact
// promotion a human already started. Kill-switches: DEPLOY_TRIAGE_DISABLED=1 (whole script) or
// PROMO_AUTORETRY_DISABLED=1 (auto-retry only → falls back to alert-only, the original behaviour).
// PROMO_WATCH_DETECT_ONLY=1 → poll + classify + log the decision, no rerun, no email, no state write.
async function checkProdPromotions() {
  const detectOnly = process.env.PROMO_WATCH_DETECT_ONLY === '1'
  const autoRetry = process.env.PROMO_AUTORETRY_DISABLED !== '1'   // ON by default; kill-switch to disable
  const state = loadState()
  if (!state.promo) state.promo = {}

  const toAlert = []    // STAGING-GATE / OTHER / ineligible DEPLOY-STEP — normal alert
  const toRetry = []    // transient DEPLOY-STEP, eligible for a one-shot auto-retry
  const toEscalate = [] // already auto-retried and still failing — alert, don't retry again

  for (const p of PROJECTS) {
    let runs
    try {
      runs = JSON.parse(gh(
        `run list --repo ${p.repo} --workflow=deploy.yml --branch ${p.branch} --event workflow_dispatch ` +
        `--limit 5 --json databaseId,status,conclusion,createdAt,headSha,displayTitle`,
      ))
    } catch (e) { log(`[promo skip] ${p.name}: run list failed (${e.message.split('\n')[0]})`); continue }
    if (!runs || runs.length === 0) continue          // static push-to-prod repos have no dispatch runs
    const latest = runs[0]
    if (latest.status !== 'completed') continue        // in flight (incl. a rerun we started) → let it finish
    if (latest.conclusion !== 'failure') continue      // latest promotion is green/cancelled → nothing to flag
    if (Date.now() - new Date(latest.createdAt).getTime() > PROMO_LOOKBACK_MS) continue

    const key = `${p.repo}@${latest.databaseId}`
    const prior = state.promo[key] || null
    const { job, step } = failedJobStep(p.repo, latest.databaseId)
    const cls = classifyPromoFailure(p, latest, step)
    const finding = { project: p.name, repo: p.repo, runId: latest.databaseId, step: step || job, headSha: latest.headSha, title: latest.displayTitle, ...cls, key }

    const ageMs = Date.now() - new Date(latest.createdAt).getTime()
    const isHead = !!latest.headSha && latest.headSha === branchHead(p.repo, p.branch)
    const retryEligible = cls.klass === 'DEPLOY-STEP' && autoRetry && isHead && ageMs <= PROMO_AUTORETRY_WINDOW_MS

    let decision
    if (prior && prior.retried && !prior.escalated) decision = 'escalate'   // retried once, still red
    else if (prior && (prior.alerted || prior.escalated)) decision = 'skip' // already handled this run
    else if (retryEligible) decision = 'retry'
    else decision = 'alert'

    log(`[promo]${detectOnly ? ' [DETECT]' : ''} ${p.name}#${latest.databaseId}: ${cls.klass} ("${step || job}") → ${decision.toUpperCase()}${decision === 'alert' && cls.klass === 'DEPLOY-STEP' ? ` (retry skipped: ${!autoRetry ? 'disabled' : !isHead ? 'commit≠HEAD' : 'stale'})` : ''}`)
    if (decision === 'skip') continue
    if (decision === 'retry') toRetry.push(finding)
    else if (decision === 'escalate') toEscalate.push(finding)
    else toAlert.push(finding)
  }

  if (toAlert.length + toRetry.length + toEscalate.length === 0) {
    log(`prod-promotion watchdog:${detectOnly ? ' [DETECT]' : ''} no actionable failed promotions.`)
    return
  }
  if (detectOnly) {
    const fmt = (arr, tag) => arr.map((f) => `${tag}:${f.project}#${f.runId}`)
    log(`prod-promotion watchdog: [DETECT] ${[...fmt(toRetry, 'RETRY'), ...fmt(toEscalate, 'ESCALATE'), ...fmt(toAlert, 'ALERT')].join(', ') || 'nothing'}`)
    return
  }

  // 1. Auto-retry transient DEPLOY-STEP promotions — one-shot, re-runs the SAME commit's promotion.
  const retried = []
  for (const f of toRetry) {
    try {
      gh(`run rerun ${f.runId} --repo ${f.repo}`)
      state.promo[f.key] = { at: new Date().toISOString(), runId: f.runId, klass: f.klass, retried: true }
      retried.push(f)
      log(`  ♻️  auto-retried prod promotion ${f.project}#${f.runId} (transient DEPLOY-STEP, commit==HEAD, one-shot)`)
    } catch (e) {
      log(`  auto-retry FAILED for ${f.project}#${f.runId}: ${e.message.split('\n')[0]} — alerting instead`)
      state.promo[f.key] = { at: new Date().toISOString(), runId: f.runId, klass: f.klass, alerted: true }
      toAlert.push(f)   // rerun call itself failed → fall back to a normal alert
    }
  }
  if (retried.length > 0) await sendPromoEmail(retried, { mode: 'retried' })

  // 2. Escalations (retry already spent, still failing) + normal alerts — one email.
  const alertItems = [
    ...toEscalate.map((f) => ({ ...f, escalated: true, reason: `Auto-retry was already attempted and it failed again — this needs you. ${f.reason}` })),
    ...toAlert,
  ]
  if (alertItems.length > 0) {
    await sendPromoEmail(alertItems, { mode: 'alert' })
    for (const f of toEscalate) state.promo[f.key] = { ...(state.promo[f.key] || {}), at: new Date().toISOString(), runId: f.runId, klass: f.klass, retried: true, escalated: true }
    for (const f of toAlert) if (!state.promo[f.key]?.escalated) state.promo[f.key] = { at: new Date().toISOString(), runId: f.runId, klass: f.klass, alerted: true }
  }

  saveState(state)
}

async function sendPromoEmail(items, { mode = 'alert' } = {}) {
  if (!items || items.length === 0) return
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, ALERT_EMAIL } = process.env
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !ALERT_EMAIL) {
    log(`  (promo email skipped — SMTP/ALERT_EMAIL not configured; ${items.length} item(s) in deploy-triage.log)`)
    return
  }
  let createMailTransport
  try { ({ createMailTransport } = await import('./lib/smtp.mjs')) }
  catch { log('  (promo email skipped — nodemailer not available)'); return }

  const retriedMode = mode === 'retried'
  const esc = (s) => String(s ?? '').replace(/[<>&]/g, (m) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[m]))
  const rows = items.map((d) => `
    <tr>
      <td style="padding:8px;border:1px solid #e5e7eb;font-weight:600;white-space:nowrap">${esc(d.project)}</td>
      <td style="padding:8px;border:1px solid #e5e7eb;white-space:nowrap">${esc(d.klass)}<br><span style="color:#6b7280;font-size:11px">${esc(d.step)}</span></td>
      <td style="padding:8px;border:1px solid #e5e7eb">${esc(d.reason)}${retriedMode ? '' : `<br><span style="color:#065f46;font-size:12px"><strong>Fix:</strong> ${esc(d.remedy)}</span>`}</td>
      <td style="padding:8px;border:1px solid #e5e7eb;white-space:nowrap"><a href="${esc(runUrl(d.repo, d.runId))}" style="color:#2563eb">Run</a></td>
    </tr>`).join('')
  const headerBg = retriedMode ? '#7c3aed' : '#dc2626'
  const headerTitle = retriedMode
    ? `Prod-Promotion auto-retried — ${items.length} project(s)`
    : `Prod-Promotion Failed — ${items.length} project(s)`
  const headerSub = retriedMode
    ? 'A transient production-deploy failure was automatically re-run (same commit, one-shot). No action needed unless it fails again — you will get a second email if it does.'
    : 'A manual production deploy did not complete. Production is unchanged (still on the last green build) — but it did not go live.'
  const thBg = retriedMode ? '#f5f3ff' : '#fef2f2'
  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:760px;margin:0 auto">
      <div style="background:${headerBg};color:white;padding:16px 24px;border-radius:8px 8px 0 0">
        <h2 style="margin:0;font-size:18px">${headerTitle}</h2>
        <p style="margin:4px 0 0;font-size:14px;opacity:0.9">${headerSub}</p>
      </div>
      <div style="padding:24px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px">
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead><tr style="background:${thBg}">
            <th style="padding:8px;border:1px solid #e5e7eb;text-align:left">Projekt</th>
            <th style="padding:8px;border:1px solid #e5e7eb;text-align:left">Klasse / Schritt</th>
            <th style="padding:8px;border:1px solid #e5e7eb;text-align:left">${retriedMode ? 'Ursache' : 'Ursache &amp; Fix'}</th>
            <th style="padding:8px;border:1px solid #e5e7eb;text-align:left">Link</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <p style="margin-top:16px;font-size:12px;color:#6b7280">${retriedMode ? 'Auto-heal re-runs the SAME commit\'s promotion once for transient failures only; it never dispatches a new/other commit to production.' : 'This watchdog never dispatches a new production deploy — it alerts, and only auto-retries a transient failure on the exact commit you already promoted.'} Deploy-Status live: backoffice.predivo.ch/deploy-status · gesendet ${new Date().toISOString()}</p>
      </div>
    </div>`
  try {
    const transporter = await createMailTransport({
      host: SMTP_HOST, port: SMTP_PORT, user: SMTP_USER, pass: SMTP_PASS,
    })
    await transporter.sendMail({
      from: `Deploy Triage <${SMTP_USER}>`,
      to: ALERT_EMAIL,
      subject: retriedMode
        ? `[PROD PROMO] auto-retried ${items.length} transient failure(s) — watching`
        : `[PROD PROMO FAILED] ${items.length} project(s) — manual production deploy did not complete`,
      html,
    })
    log(`  📧 prod-promotion ${retriedMode ? 'auto-retry notice' : 'alert'} emailed to ${ALERT_EMAIL} (${items.length} item(s))`)
  } catch (e) {
    log(`  promo email send failed: ${e.message.split('\n')[0]} (items still in deploy-triage.log)`)
  }
}

// Heartbeat (2026-08-10 reliability plan): success ping / fail signal to healthchecks.io.
const HC = pingUrl('deploytriage-localrunner')
Promise.resolve().then(main).then(
  () => (HC ? fetch(HC).catch(() => {}) : undefined),
  (e) => Promise.resolve(HC ? fetch(`${HC}/fail`).catch(() => {}) : null).then(() => { console.error(e); process.exitCode = 1 }),
)
