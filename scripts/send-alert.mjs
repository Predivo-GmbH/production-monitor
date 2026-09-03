import { createMailTransport } from './lib/smtp.mjs'
import { sendOrEscalate } from './lib/alert-fallback.mjs'
import { extractFailures, canaryRows, deriveFailures, isNoDetailFallback, failedStepRows } from './lib/parse-failures.mjs'
import { previousDedupView, shouldSuppressAlert } from './lib/alert-dedup.mjs'
import { readFileSync, existsSync } from 'fs'
import { execSync } from 'child_process'

const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, ALERT_EMAIL, GITHUB_RUN_URL } = process.env

if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !ALERT_EMAIL) {
  console.error('Missing SMTP or alert config')
  process.exit(1)
}

// An out-of-band canary/step failure (a dead secret, a vendor 5xx) is NOT a Playwright
// test, so the report below carries zero failed specs. run-canaries.mjs records those
// named failures here so the alert can surface the actual check + error instead of a
// content-free "no per-test detail" line (the 2026-08-29 incident).
let canaryFailures = []
const canaryPath = 'canary-results.json'
if (existsSync(canaryPath)) {
  try {
    canaryFailures = JSON.parse(readFileSync(canaryPath, 'utf-8')).failures ?? []
  } catch { /* ignore — a broken canary file must not silence the test failures */ }
}

// Parse Playwright JSON results
let failures = []
const resultsPath = 'test-results/results.json'
if (existsSync(resultsPath)) {
  try {
    const results = JSON.parse(readFileSync(resultsPath, 'utf-8'))
    // deriveFailures prefers per-test failures, then a NAMED canary/step failure, then
    // Playwright's top-level errors, then the last-resort generic line.
    failures = deriveFailures(results, canaryFailures)
  } catch (e) {
    failures = [{ project: 'Parser', test: 'results.json', error: `Failed to parse: ${e.message}` }]
  }
} else if (canaryFailures.length > 0) {
  // No Playwright report, but a canary still named a real failure — surface it by name
  // rather than the generic "no report produced" crash line.
  failures = canaryRows(canaryFailures)
} else {
  // No report at all → the run died before Playwright wrote results (infra / timeout / crash).
  failures = [{
    project: 'Run failed — no report produced',
    test: 'results.json missing',
    error: 'test-results/results.json was not generated — the run likely crashed or timed out before Playwright wrote a report. Open the run logs.',
    file: '',
  }]
}

// A non-test always() step (Supabase build currency / machine health / expire-sessions) can
// exit 1 while every Playwright spec passes. deriveFailures then falls through to the generic
// "no per-test detail" row, which the header renders as "N test(s) failed" — a phantom test for
// what was really a step failure (board incident 2026-08-30, same class as the 2026-08-21 drift
// misreport). When that generic row is all we have, ask GitHub which STEP actually failed and
// name it, so a red monitor says what broke. Fails safe: any error keeps the generic row.
if (isNoDetailFallback(failures)) {
  const stepRows = failedStepFailures()
  if (stepRows.length) failures = stepRows
}

// Load auto-fix results if available
let autoFixResults = { fixes: [], escalations: [] }
const autoFixPath = 'auto-fix-results.json'
if (existsSync(autoFixPath)) {
  try {
    autoFixResults = JSON.parse(readFileSync(autoFixPath, 'utf-8'))
  } catch { /* ignore */ }
}

// Load auto-heal results if available
let autoHealResults = { healed: [], skipped: [] }
const autoHealPath = 'auto-heal-results.json'
if (existsSync(autoHealPath)) {
  try {
    autoHealResults = JSON.parse(readFileSync(autoHealPath, 'utf-8'))
  } catch { /* ignore */ }
}

// Load agent-triage results if available (Phase 2 — Claude diagnosis + remediation of novel failures)
let triageResults = { verdicts: [] }
const triagePath = 'triage-results.json'
if (existsSync(triagePath)) {
  try {
    triageResults = JSON.parse(readFileSync(triagePath, 'utf-8'))
  } catch { /* ignore */ }
}

// If auto-fix resolved ALL failures, only send a summary (not an alert)
const hasAutoFixes = autoFixResults.fixes.length > 0
const allFixed = autoFixResults.escalations.length === 0 && hasAutoFixes

// Use escalations as the "real" failures if auto-fix ran
if (hasAutoFixes) {
  failures = autoFixResults.escalations.length > 0
    ? autoFixResults.escalations.map(e => ({
        project: e.project,
        test: e.test,
        error: e.error || e.reason || 'Unknown',
        file: e.file || '',
      }))
    : failures
}

// ── Edge-triggered dedup (Roger's alerting philosophy: don't re-page hourly for a KNOWN ongoing
// issue — page once when it breaks, once when it resolves). Suppress this alert ONLY if every
// current failure was ALSO failing in the immediately-previous monitor run — as the identical
// continuing failure, or as a root cause (failure reason) that run already paged, now spread to
// more specs (the 2026-08-31 re-page incident; see scripts/lib/alert-dedup.mjs). A NEW failure —
// new test, or a known test failing for a NEW reason — always pages. FAIL-OPEN: any uncertainty
// (no prior run, artifact missing, parse error, GH error, vague reason) → send the alert. We
// never go silent on doubt.
// Ask GitHub which STEP of THIS run failed, so a non-test step failure is named instead of
// rendered as a phantom test row. FAIL-SAFE: no run id / no gh auth / any error → [] and the
// caller keeps the generic row (never worse than before). Only replaces the row on a real hit.
function failedStepFailures() {
  try {
    const runId = String(process.env.GITHUB_RUN_ID || '')
    if (!runId) return []
    if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) return []
    const out = execSync(`gh run view ${runId} --json jobs`, { encoding: 'utf-8', timeout: 30_000 })
    return failedStepRows(JSON.parse(out).jobs)
  } catch {
    return []
  }
}

// Tell "the mailbox is locked" apart from "this run merely held a login replaced while it ran".
// GitHub resolves secrets at job start, so a rotation landing mid-run leaves this process carrying
// the OLD value for its whole life — a 535 that says nothing about the mailbox. Two timestamps tell
// them apart: the job's start and the SMTP secret's last rotation. buildUndeliverableSignal only
// downgrades when the secret is PROVABLY newer than the job start. FAIL-SAFE everywhere: any error
// or missing token → undefined → it pages exactly as before. A page is never suppressed on absent
// data (2026-09-03: the check missing here cost three false "sign in to Metanet" pages).
function jobStartedAtISO() {
  try {
    const runId = String(process.env.GITHUB_RUN_ID || '')
    if (!runId) return undefined
    if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) return undefined
    const out = execSync(`gh run view ${runId} --json jobs`, { encoding: 'utf-8', timeout: 30_000 })
    const starts = (JSON.parse(out).jobs ?? []).map((j) => Date.parse(j.startedAt)).filter(Number.isFinite)
    return starts.length ? new Date(Math.min(...starts)).toISOString() : undefined
  } catch {
    return undefined
  }
}

function smtpSecretUpdatedAtISO() {
  try {
    // `gh secret list` needs a token that can READ secret metadata (a repo-admin PAT). The default
    // GITHUB_TOKEN used for dedup above CANNOT, so this prefers SECRET_METADATA_TOKEN (DASHBOARD_PAT)
    // when the workflow supplies it. It never returns a value — only name + updatedAt.
    const token = process.env.SECRET_METADATA_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN
    if (!token) return undefined
    const out = execSync('gh secret list --json name,updatedAt', {
      encoding: 'utf-8',
      timeout: 30_000,
      env: { ...process.env, GH_TOKEN: token },
    })
    // send-alert authenticates with SMTP_PASS; ALERT_SMTP_PASS is the sibling box on the same
    // server. Both were rotated together on 2026-09-03, so take the newest of whichever exist.
    const names = new Set(['SMTP_PASS', 'ALERT_SMTP_PASS'])
    const times = JSON.parse(out)
      .filter((r) => names.has(r.name))
      .map((r) => Date.parse(r.updatedAt))
      .filter(Number.isFinite)
    return times.length ? new Date(Math.max(...times)).toISOString() : undefined
  } catch {
    return undefined
  }
}

// Build the previous run's dedup view (signatures + root-cause reasons) from its
// test-results artifact. Returns null on ANY uncertainty → the caller fails open (sends).
function previousDedup() {
  try {
    const currentRunId = String(process.env.GITHUB_RUN_ID || '')
    if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) return null   // no gh auth → fail open
    const runs = JSON.parse(execSync(
      'gh run list --workflow=monitor.yml --limit=10 --json databaseId,status,conclusion',
      { encoding: 'utf-8', timeout: 30_000 },
    ))
    const prev = runs.find((r) =>
      String(r.databaseId) !== currentRunId &&
      r.status === 'completed' &&
      (r.conclusion === 'success' || r.conclusion === 'failure'))
    if (!prev) return null                          // no comparable prior run → fail open
    if (prev.conclusion === 'success') return null  // last run GREEN → every current failure is new → send
    // Last run failed → pull its results.json artifact and extract its failure rows.
    execSync(`gh run download ${prev.databaseId} -n test-results -D _prev_results`, { encoding: 'utf-8', timeout: 60_000 })
    const prevResults = JSON.parse(readFileSync('_prev_results/test-results/results.json', 'utf-8'))
    const prevFailures = []
    for (const suite of prevResults.suites ?? []) prevFailures.push(...extractFailures(suite, null))
    return previousDedupView(prevFailures)          // empty → null → fail open
  } catch {
    return null                                     // ANY error → fail open (send)
  }
}

const prevView = previousDedup()
if (shouldSuppressAlert(failures, prevView) && !allFixed) {
  console.log(`Suppressing duplicate alert — all ${failures.length} failure(s) match the previous run (continuing failure or an already-paged root cause spreading; no new issue). Resolution email will fire when they recover.`)
  process.exit(0)
}

// Group failures by project for summary
const projectGroups = {}
for (const f of failures) {
  if (!projectGroups[f.project]) projectGroups[f.project] = []
  projectGroups[f.project].push(f)
}
const projectSummary = Object.entries(projectGroups)
  .map(([name, items]) => `${name} (${items.length})`)
  .join(', ')

const failureRows = failures
  .map(
    (f) =>
      `<tr>
        <td style="padding:8px;border:1px solid #e5e7eb;font-weight:600;white-space:nowrap">${f.project}</td>
        <td style="padding:8px;border:1px solid #e5e7eb">${f.test}</td>
        <td style="padding:8px;border:1px solid #e5e7eb;color:#dc2626;font-family:monospace;font-size:12px">${f.error}${f.file ? `<br><span style="color:#6b7280;font-size:11px">${f.file}</span>` : ''}</td>
      </tr>`,
  )
  .join('')

// Build email sections based on scenario
const totalIssues = failures.length + autoFixResults.fixes.length
const autoFixCount = autoFixResults.fixes.length

// Header: context-aware
let headerBg, headerTitle, headerSubtitle
if (allFixed) {
  headerBg = '#059669'
  headerTitle = 'Production Monitor — All Issues Auto-Fixed'
  headerSubtitle = `${autoFixCount} issue(s) detected and resolved automatically. No action needed.`
} else if (hasAutoFixes) {
  headerBg = '#f59e0b'
  headerTitle = 'Production Monitor — Partial Auto-Fix'
  headerSubtitle = `${autoFixCount} of ${totalIssues} issue(s) auto-fixed. ${failures.length} still need attention.`
} else {
  headerBg = '#dc2626'
  headerTitle = 'Production Monitor Alert'
  // "failure(s)", not "test(s)": a row here can be a failed non-test STEP or a canary, and
  // calling a step failure a failed test is the 2026-08-30 "1 test(s) failed when every test
  // passed" incident. The table names exactly what broke.
  headerSubtitle = `${failures.length} failure(s) across ${Object.keys(projectGroups).length} project(s)`
}

const html = `
  <div style="font-family:system-ui,sans-serif;max-width:700px;margin:0 auto">
    <div style="background:${headerBg};color:white;padding:16px 24px;border-radius:8px 8px 0 0">
      <h2 style="margin:0;font-size:18px">${headerTitle}</h2>
      <p style="margin:4px 0 0;font-size:14px;opacity:0.9">${headerSubtitle}</p>
    </div>
    <div style="padding:24px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px">
      ${!allFixed ? `
      <h3 style="margin:0 0 12px;font-size:15px;color:#dc2626">Needs Attention (${failures.length})</h3>
      <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:20px">
        <thead>
          <tr style="background:#fef2f2">
            <th style="padding:8px;border:1px solid #e5e7eb;text-align:left">Project</th>
            <th style="padding:8px;border:1px solid #e5e7eb;text-align:left">Test</th>
            <th style="padding:8px;border:1px solid #e5e7eb;text-align:left">Error</th>
          </tr>
        </thead>
        <tbody>${failureRows}</tbody>
      </table>` : ''}
      ${hasAutoFixes ? `
      <h3 style="margin:0 0 12px;font-size:15px;color:#059669">Auto-Fixed (${autoFixCount}) — no action needed</h3>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead>
          <tr style="background:#f0fdf4">
            <th style="padding:8px;border:1px solid #e5e7eb;text-align:left">What was fixed</th>
          </tr>
        </thead>
        <tbody>
          ${autoFixResults.fixes.map(f => `<tr><td style="padding:8px;border:1px solid #e5e7eb;color:#065f46">${f.detail}</td></tr>`).join('')}
        </tbody>
      </table>` : ''}
      ${autoHealResults.healed.length > 0 ? `
      <h3 style="margin:20px 0 12px;font-size:15px;color:#7c3aed">Auto-Healed — Redeploy Triggered (${autoHealResults.healed.length})</h3>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <tbody>
          ${autoHealResults.healed.map(p => `<tr><td style="padding:8px;border:1px solid #e5e7eb;color:#5b21b6">Triggered redeploy for <strong>${p}</strong></td></tr>`).join('')}
        </tbody>
      </table>
      <p style="font-size:12px;color:#6b7280;margin-top:8px">Sites should recover within 3-5 minutes. Next monitor run will verify.</p>` : ''}
      ${autoHealResults.skipped.length > 0 ? `
      <details style="margin-top:12px;font-size:12px;color:#6b7280">
        <summary>Skipped heals (${autoHealResults.skipped.length})</summary>
        <ul style="margin:4px 0;padding-left:20px">
          ${autoHealResults.skipped.map(s => `<li>${s.project}: ${s.reason}</li>`).join('')}
        </ul>
      </details>` : ''}
      ${(triageResults.verdicts?.length) ? `
      <h3 style="margin:20px 0 12px;font-size:15px;color:#2563eb">Agent Triage — Diagnosis &amp; Action (${triageResults.verdicts.length})</h3>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr style="background:#eff6ff">
          <th style="padding:8px;border:1px solid #e5e7eb;text-align:left">Check</th>
          <th style="padding:8px;border:1px solid #e5e7eb;text-align:left">Class</th>
          <th style="padding:8px;border:1px solid #e5e7eb;text-align:left">Diagnosis / Action</th>
        </tr></thead>
        <tbody>
          ${triageResults.verdicts.map(v => `<tr>
            <td style="padding:8px;border:1px solid #e5e7eb;white-space:nowrap">${v.project || ''}<br><span style="color:#6b7280;font-size:11px">${v.test || ''}</span></td>
            <td style="padding:8px;border:1px solid #e5e7eb;font-weight:600;color:${v.escalate ? '#dc2626' : '#059669'}">${v.class || ''}</td>
            <td style="padding:8px;border:1px solid #e5e7eb;font-size:12px">${v.diagnosis || ''}${v.action ? `<br><span style="color:#2563eb">→ ${v.action}</span>` : ''}${v.suggestedFix ? `<br><span style="color:#6b7280;font-size:11px">Suggested: ${v.suggestedFix}</span>` : ''}</td>
          </tr>`).join('')}
        </tbody>
      </table>
      <p style="font-size:12px;color:#6b7280;margin-top:8px">Green class = self-healed or handled; red = still needs you.</p>` : ''}
      ${GITHUB_RUN_URL ? `<p style="margin-top:16px"><a href="${GITHUB_RUN_URL}" style="color:#2563eb">View full run logs</a></p>` : ''}
      <p style="margin-top:16px;font-size:12px;color:#6b7280">
        Sent by production-monitor at ${new Date().toISOString()}
      </p>
    </div>
  </div>
`

const subject = allFixed
  ? `[AUTO-FIXED] ${autoFixCount} issue(s) resolved automatically`
  : hasAutoFixes
    ? `[PARTIAL FIX] ${failures.length} issue(s) need attention, ${autoFixCount} auto-fixed`
    : `[ALERT] ${failures.length} failure(s) — ${projectSummary}`

// Building the transport is INSIDE the guarded call on purpose. createMailTransport resolves and
// pins the MX host's A record, so a DNS or connect failure throws HERE, before sendMail is ever
// reached — and that is just as much an undeliverable alert as a 535 is. Guarding only the send
// would leave the earlier half of the same journey dying silently.
await sendOrEscalate(
  async () => {
    const transporter = await createMailTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      user: SMTP_USER,
      pass: SMTP_PASS,
    })
    return transporter.sendMail({
      from: `Production Monitor <${SMTP_USER}>`,
      to: ALERT_EMAIL,
      subject,
      html,
    })
  },
  {
    subject,
    failures,
    runUrl: GITHUB_RUN_URL,
    smtpHost: SMTP_HOST,
    smtpUser: SMTP_USER,
    // The password is never wanted in a log or on the board, and an SMTP server can echo what it
    // was handed straight back in the rejection string.
    secrets: [SMTP_PASS],
    // If the send is refused, these decide whether it was a locked mailbox or a login replaced
    // mid-run. Best-effort; either being undefined just keeps the old paging behaviour.
    jobStartedAt: jobStartedAtISO(),
    secretUpdatedAt: smtpSecretUpdatedAtISO(),
  },
  { secret: process.env.BOARD_SUPABASE_SECRET || process.env.BACKOFFICE_SERVICE_ROLE_KEY },
)

console.log(`Alert sent to ${ALERT_EMAIL} with ${failures.length} failure(s): ${projectSummary}`)
