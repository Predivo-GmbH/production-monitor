/**
 * Agent-Triage Tier — Phase 2 of the agentic auto-remediation plan (Tier B).
 *
 * Runs AFTER auto-fix (fast patterns) and auto-heal (redeploy) in monitor.yml, on the
 * failures they couldn't resolve — the "novel" class that today just produces a bare
 * escalation email. It spawns a headless Claude agent that DIAGNOSES each remaining failure
 * and remediates it within Tier-B policy:
 *
 *   - Monitor-spec DRIFT (a project intentionally renamed a label/route the spec asserts on)
 *       → fix the spec in THIS repo + commit + push. (Safe class, own repo, low blast radius.)
 *   - Real REGRESSION (the product genuinely broke)
 *       → open a PR on the target repo with a diagnosis. NEVER auto-ship app code.
 *   - Flaky / site-down → already handled upstream (retry / auto-heal); just annotate.
 *   - Secret / config / unknown → escalate WITH a written root-cause hypothesis.
 *
 * The agent's verdict is written to triage-results.json and folded into the alert email, so
 * Roger gets "diagnosis + what it did," not a red row.
 *
 * ── SUBSCRIPTION GATE ──────────────────────────────────────────────────────────────────
 * This tier drives the headless Claude CLI authed via Roger's SUBSCRIPTION — never a metered key
 * (the child env strips ANTHROPIC_API_KEY/AUTH_TOKEN/BASE_URL below, so a stray key can never bill
 * him per run). There is therefore NO paid/API-key path: a run that has only ANTHROPIC_API_KEY
 * (e.g. a GitHub-hosted runner with no subscription login) cannot authenticate. Per Roger's
 * standing rule it stays DORMANT until he explicitly enables it: it self-skips (loudly, exit 0)
 * unless BOTH
 *   - repo variable  AGENT_TRIAGE_ENABLED = 1   (the on-switch / kill-switch)
 *   - env            AGENT_TRIAGE_LOCAL   = 1   (a subscription-logged-in `claude` on the host)
 * are present. The production invoker is scripts/local-triage-runner.mjs (sets ENABLED+LOCAL on the
 * always-on desktop). Building it wired-but-off mirrors the run-canaries.mjs Anthropic-canary gate.
 */

import { readFileSync, writeFileSync, existsSync, rmSync } from 'fs'
import { execFileSync } from 'child_process'
import { agentToolFlags, DEPLOY_DENY_POLICY_NOTE } from './lib/deploy-deny-tools.mjs'

const RESULTS_PATH = 'test-results/results.json'
const AUTOFIX_PATH = 'auto-fix-results.json'
const VERDICT_PATH = 'triage-verdict.json'   // the agent writes this as its final action
const OUTPUT_PATH = 'triage-results.json'     // send-alert.mjs reads this
const MAX_TURNS = 40
const MODEL = 'claude-opus-4-8'
const AGENT_TIMEOUT_MS = 10 * 60 * 1000

// Project → { spec dir, GitHub repo, deploy branch }. Mirrors auto-fix.resolveProjectDir + flaky-retry.
const PROJECTS = {
  BackOffice:   { dir: 'backoffice',   repo: 'Arivioo/backoffice',       branch: 'main' },
  ReplyFlow:    { dir: 'replyflow',    repo: 'Arivioo/replyflow',        branch: 'main' },
  ChannelMover: { dir: 'ytmigration',  repo: 'Arivioo/ChannelMover',     branch: 'main' },
  ScoutCopilot: { dir: 'scoutcopilot', repo: 'Arivioo/ScoutCopilot',     branch: 'master' },
  'Distribution-OS': { dir: 'distribution-os', repo: 'Arivioo/distribution-os', branch: 'master' },
  Arivioo:      { dir: 'arivioo',      repo: 'Arivioo/Cursor_Arivioo',   branch: 'main' },
  LaunchReady:  { dir: 'launchready',  repo: 'Arivioo/launchready',      branch: 'master' },
  SignalScore:  { dir: 'signalscore',  repo: 'Arivioo/signalscore',      branch: 'main' },
  Valrano:      { dir: 'valrano',      repo: 'Arivioo/Valrano',          branch: 'main' },
  Predivo:      { dir: 'predivo',      repo: 'Arivioo/predivo',          branch: 'master' },
  BoatBuddy:    { dir: 'boatbuddy',    repo: 'Arivioo/BoatBuddy',        branch: 'main' },
}

// ── Failure extraction (mirrors auto-fix.mjs / send-alert.mjs) ──────────────────────────
function extractFailures(suite, parentName) {
  const failures = []
  const isDescribe = suite.title && !suite.title.endsWith('.spec.ts')
  const name = isDescribe ? suite.title.replace(/ — Production Monitor$/, '') : parentName || suite.title || 'Unknown'
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      if (test.status === 'unexpected') {
        const last = test.results?.[test.results.length - 1]
        const errorMsg = last?.errors?.[0]?.message || last?.error?.message || 'Unknown error'
        const loc = last?.errors?.[0]?.location
        const attachments = (last?.attachments ?? []).map((a) => a.path).filter(Boolean)
        failures.push({
          project: name,
          test: spec.title || 'Unknown test',
          error: errorMsg.replace(/\x1b\[[0-9;]*m/g, '').split('\n').slice(0, 8).join('\n').slice(0, 1200),
          file: loc?.file || '',
          line: loc?.line || 0,
          screenshots: attachments.filter((p) => /\.(png|jpg)$/i.test(p)),
        })
      }
    }
  }
  for (const child of suite.suites ?? []) failures.push(...extractFailures(child, name))
  return failures
}

// Prefer auto-fix's escalation list (the failures it couldn't pattern-fix); fall back to the raw report.
function loadEscalations() {
  if (existsSync(AUTOFIX_PATH)) {
    try {
      const esc = JSON.parse(readFileSync(AUTOFIX_PATH, 'utf-8')).escalations ?? []
      if (esc.length) return esc
    } catch { /* fall through */ }
  }
  if (!existsSync(RESULTS_PATH)) return []
  try {
    const results = JSON.parse(readFileSync(RESULTS_PATH, 'utf-8'))
    return (results.suites ?? []).flatMap((s) => extractFailures(s, null))
  } catch { return [] }
}

function specPathFor(project) {
  const p = PROJECTS[project]
  if (!p) return null
  const path = `tests/${p.dir}/production-monitor.spec.ts`
  return existsSync(path) ? path : null
}

// ── Tier-B policy (agent system prompt) ─────────────────────────────────────────────────
const SYSTEM_POLICY = `You are the auto-remediation triage agent for a fleet of production SaaS apps monitored by Playwright specs in THIS repo (production-monitor). The hourly monitor just failed on one or more checks that the fast pattern-fixer could NOT resolve. Diagnose each and remediate within STRICT policy.

You are running headless in CI with real write access (git push to this repo, gh with a fleet-wide PAT). Act conservatively and deterministically.

For EACH failing check, first CLASSIFY by investigating:
- Read the failing spec (I give you its path) and the exact assertion that failed.
- Use gh to inspect the TARGET project repo's RECENT commits (e.g. \`gh api repos/<repo>/commits?per_page=15\`) and diffs.
- Check the LIVE site if useful (curl the URL).

CLASSES and the ONLY permitted action for each:
1. MONITOR-DRIFT — the product intentionally changed (a renamed label/route/testid the spec asserts on), and a recent target-repo commit proves the change was deliberate. ACTION: edit the drifted assertion in the spec file in THIS repo to match the new product, then \`git add\`, \`git commit\` (message prefixed "[agent-triage] "), and \`git push\`. This is the safe self-heal.
2. REGRESSION — the product genuinely broke (no intentional change explains it; the live site is wrong). ACTION: DO NOT edit app code and DO NOT push to the target repo. Instead open a PR on the target repo describing the regression + a suggested fix: create a branch via the GitHub API, commit the suggested patch to it, and \`gh pr create\`. If you cannot safely construct a patch, do NOT open a PR — escalate instead with the diagnosis and a suggested patch in prose.
3. FLAKY / TRANSIENT or SITE-DOWN — a timeout/network blip, or the site was briefly down (already being redeployed by auto-heal). ACTION: none — just annotate; the retry/auto-heal paths own these.
4. SECRET / CONFIG — a dead/rotated key or auth rate-limit (often a canary failure). ACTION: none automatic — escalate with exactly which credential/service and how to rotate it.
5. UNKNOWN — none of the above fit. ACTION: escalate with your best written root-cause hypothesis.

HARD RULES:
- NEVER edit application source in a target repo directly, and NEVER push to any repo other than THIS one (production-monitor). Target-repo changes are PRs only.
- NEVER run destructive gh (no pr merge, no run cancel, no delete, no workflow dispatch/run).
- Only touch spec files under tests/**. Do not change monitor infrastructure/scripts.
- If uncertain between DRIFT and REGRESSION, treat it as REGRESSION (never silently rewrite a spec to match a broken product — that would mask a real bug).
- Bound your work; do not loop.

FINAL ACTION (required): use the Write tool to write ${VERDICT_PATH} in the repo root as JSON:
{"verdicts":[{"project":"","test":"","class":"MONITOR-DRIFT|REGRESSION|FLAKY|SITE-DOWN|SECRET|UNKNOWN","action":"what you did (commit sha / PR url / none)","diagnosis":"1-3 sentences","escalate":true|false,"suggestedFix":"prose, only if escalating"}]}`

function buildUserPrompt(escalations) {
  const lines = ['The following monitor checks failed and were NOT auto-fixed. Triage each per policy.\n']
  escalations.forEach((f, i) => {
    const meta = PROJECTS[f.project]
    const spec = specPathFor(f.project)
    lines.push(`## Failure ${i + 1}`)
    lines.push(`- Project: ${f.project}`)
    lines.push(`- Target repo: ${meta ? meta.repo + ' (branch ' + meta.branch + ')' : 'unknown'}`)
    lines.push(`- Test: ${f.test}`)
    lines.push(`- Monitor spec: ${spec || 'not found — locate under tests/'}`)
    if (f.file) lines.push(`- Failed at: ${f.file}:${f.line}`)
    if (f.reason) lines.push(`- Why it reached you: ${f.reason}`)
    if (f.screenshots?.length) lines.push(`- Screenshots: ${f.screenshots.join(', ')}`)
    lines.push(`- Error:\n\`\`\`\n${f.error}\n\`\`\`\n`)
  })
  return lines.join('\n')
}

function main() {
  const enabled = process.env.AGENT_TRIAGE_ENABLED === '1'
  // LOCAL mode = invoke the local Claude Code CLI authed via Roger's SUBSCRIPTION (no API key,
  // no metered cost). This is now the ONLY path: the child env strips ANTHROPIC_API_KEY below, so a
  // run that has only a key (e.g. a GitHub-hosted runner with no subscription login) cannot
  // authenticate. The gate therefore REQUIRES LOCAL and refuses a key-only run loudly, rather than
  // starting one that would die silently. Production invoker: scripts/local-triage-runner.mjs.
  const local = process.env.AGENT_TRIAGE_LOCAL === '1'
  if (!enabled || !local) {
    const hasKey = !!process.env.ANTHROPIC_API_KEY
    console.log(`⏭️  agent-triage SKIPPED: AGENT_TRIAGE_ENABLED=${process.env.AGENT_TRIAGE_ENABLED || 'unset'}, AGENT_TRIAGE_LOCAL=${local ? '1' : 'unset'}, ANTHROPIC_API_KEY ${hasKey ? 'set (ignored — stripped from the child; not a credential for this tier)' : 'unset'}.`)
    console.log('   Runs ONLY when ENABLED=1 AND LOCAL=1 (a subscription-logged-in `claude` on the host). There is no paid/API-key path.')
    process.exit(0)
  }
  console.log('agent-triage: LOCAL mode — subscription CLI, no API cost.')

  const dryRun = process.env.AGENT_TRIAGE_DRY_RUN === '1'
  const escalations = loadEscalations()
  if (escalations.length === 0) {
    console.log('agent-triage: no unresolved failures to triage.')
    process.exit(0)
  }
  console.log(`agent-triage: ${escalations.length} unresolved failure(s) → invoking Claude (${MODEL})${dryRun ? ' [DRY RUN — no writes]' : ''}...`)

  // Clean any stale verdict from a prior run (fs, not shell — cross-platform).
  try { if (existsSync(VERDICT_PATH)) rmSync(VERDICT_PATH) } catch { /* noop */ }

  const userPrompt = buildUserPrompt(escalations)

  // Read-only investigation tools + Write (for the verdict file only). Safe in dry-run.
  const READ_ONLY = [
    'Read', 'Grep', 'Glob', 'Write',
    'Bash(gh api:*)', 'Bash(gh run view:*)', 'Bash(curl:*)', 'Bash(cat:*)', 'Bash(ls:*)',
    'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git diff:*)',
  ]
  // Write actions — only in live mode: edit+commit+push a drifted spec (this repo), open a PR (target).
  const WRITE = ['Edit', 'Bash(git:*)', 'Bash(gh pr:*)', 'Bash(node:*)', 'Bash(npx playwright:*)']
  const allowedTools = (dryRun ? READ_ONLY : [...READ_ONLY, ...WRITE]).join(',')

  const DRY_NOTE = '\n\n⚠️ DRY RUN: Do NOT commit, push, edit files, or open PRs — investigate read-only and write ONLY triage-verdict.json. In each verdict\'s "action" field, describe what you WOULD have done, prefixed "[DRY-RUN would] ".'
  const policy = (dryRun ? SYSTEM_POLICY + DRY_NOTE : SYSTEM_POLICY) + DEPLOY_DENY_POLICY_NOTE

  // Exit 76 = switched off in the cockpit. Declared OUT here on purpose: inside the `try` it is
  // not in scope in the `catch` that reads it, and a ReferenceError there would turn a
  // deliberate off into a crash - the loudest possible way to fail at being quiet.
  const SWITCHED_OFF = 76
  try {
    // Headless Claude Code via execFileSync (args ARRAY, no shell) — passing the multi-line
    // system prompt through a shell string mangles it on Windows (cmd/PowerShell parse the policy
    // text as commands). execFileSync avoids all quoting on both Linux (cloud) and Windows (local).
    // 2026-08-30: THROUGH THE SHIM, NOT STRAIGHT TO CLAUDE. Every automation launches via
    // Cockpit/scripts/agent-run.mjs, which reads Roger's on/off and Claude-or-Kimi switches and
    // translates the flags. Contract: Cockpit/docs/CONTRACT-agent-run-2026-08-30.md.
    //
    // THIS FILE WAS MISSED BY THE ORIGINAL SWEEP AND IT IS THE MAIN PATH FOR THIS JOB. The sweep
    // found local-triage-runner.mjs, which is what the scheduled task starts, and converted the
    // guard spawn there - but that runner shells out to THIS script, which does the real work and
    // had its own spawn. A job can have more than one door, and converting the one you found first
    // leaves the other wide open: Agent Triage would have carried a switch that did nothing.
    const AGENT_RUN = 'C:/Business/Internal Projects/Cockpit/scripts/agent-run.mjs'
    const args = [
      AGENT_RUN, '--job', 'agent-triage', '--',
      '-p', userPrompt,
      '--append-system-prompt', policy,
      ...agentToolFlags(allowedTools),
      // agent-run builds the Kimi write roots (KIMI_JOB_WRITE_ROOTS) from --add-dir and refuses a
      // Kimi launch without one (2026-08-31, the agent-triage Kimi profile). The ONLY repo this
      // job writes is the pristine clone, so the root is exactly the clone.
      '--add-dir', WORKDIR,
      '--max-turns', String(MAX_TURNS),
      '--model', MODEL,
      '--output-format', 'json',
    ]
    execFileSync(process.execPath, args, {
      stdio: ['ignore', 'inherit', 'inherit'], // ignore stdin: prompt comes via -p, avoids a 3s "no stdin" wait
      timeout: AGENT_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      // ALWAYS the subscription CLI, never a metered key. Roger's standing rule, 2026-08-29:
      // the API key is only for work a customer triggers inside a product. A stray key in this
      // process's environment would silently bill him per run; the child simply never sees one.
      env: (() => {
        const e = { ...process.env, GIT_AUTHOR_NAME: 'Agent Triage', GIT_AUTHOR_EMAIL: 'noreply@predivo.ch', GIT_COMMITTER_NAME: 'Agent Triage', GIT_COMMITTER_EMAIL: 'noreply@predivo.ch' }
        delete e.ANTHROPIC_API_KEY
        delete e.ANTHROPIC_AUTH_TOKEN
        delete e.ANTHROPIC_BASE_URL
        return e
      })(),
    })
  } catch (e) {
    // A DELIBERATE OFF IS NOT AN ERROR, and must not be logged as one. Checked FIRST, because
    // everything below treats a non-zero exit as a fault and would file this as "Claude run
    // errored" - a false failure of exactly the kind this fleet exists to catch.
    if (e && e.status === SWITCHED_OFF) {
      console.log('agent-triage: the automations are switched off in the cockpit, so no agent was run. This is deliberate and not a failure.')
      return
    }
    console.error('agent-triage: agent run errored/timed out:', e.message?.split('\n')[0])
  }

  // Fold the agent's verdict into the alert payload.
  let verdicts = []
  if (existsSync(VERDICT_PATH)) {
    try { verdicts = JSON.parse(readFileSync(VERDICT_PATH, 'utf-8')).verdicts ?? [] } catch { /* malformed */ }
  }
  const summary = {
    ran: true,
    escalationCount: escalations.length,
    verdicts,
    unresolvedEscalate: verdicts.filter((v) => v.escalate),
    timestamp: new Date().toISOString(),
  }
  writeFileSync(OUTPUT_PATH, JSON.stringify(summary, null, 2))
  console.log(`\nagent-triage: ${verdicts.length} verdict(s); ${summary.unresolvedEscalate.length} still need Roger.`)
  verdicts.forEach((v) => console.log(`  [${v.class}] ${v.project}/${v.test} → ${v.action}`))
}

main()
