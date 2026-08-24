import { createMailTransport } from './lib/smtp.mjs'
import { readFileSync, existsSync } from 'fs'
import { execSync } from 'child_process'

const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, ALERT_EMAIL, GITHUB_RUN_URL } = process.env

if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !ALERT_EMAIL) {
  console.error('Missing SMTP or alert config')
  process.exit(1)
}

/** Strip ANSI escape codes from error messages */
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '')
}

/** Recursively extract failed specs from nested suite structure.
 *  Playwright nests: file-suite (title=filename) > describe-suite (title=describe name) > specs.
 *  We prefer the deepest suite title that isn't a filename (contains " — "). */
function extractFailures(suite, parentName) {
  const failures = []
  // Use this suite's title if it looks like a describe name, otherwise fall back to parent
  const isDescribe = suite.title && !suite.title.endsWith('.spec.ts')
  const name = isDescribe ? suite.title.replace(/ — Production Monitor$/, '') : (parentName || suite.title || 'Unknown')

  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      if (test.status === 'unexpected') {
        // Pull the error from the last result that actually failed (an
        // 'unexpected' test's final result holds the real error).
        const failedResult = [...(test.results ?? [])].reverse()
          .find((r) => r.errors?.length || r.error) || test.results?.[test.results.length - 1]
        const errorMsg = failedResult?.errors?.[0]?.message
          || failedResult?.error?.message
          || 'Unknown error'
        const location = failedResult?.errors?.[0]?.location
        const cleanError = stripAnsi(errorMsg).split('\n')[0].slice(0, 300)
        const fileRef = location
          ? `${location.file?.split('/').pop()}:${location.line}`
          : ''

        failures.push({
          project: name,
          test: spec.title || 'Unknown test',
          error: cleanError,
          file: fileRef,
        })
      }
    }
  }

  for (const child of suite.suites ?? []) {
    failures.push(...extractFailures(child, name))
  }

  return failures
}

// Parse Playwright JSON results
let failures = []
const resultsPath = 'test-results/results.json'
if (existsSync(resultsPath)) {
  try {
    const results = JSON.parse(readFileSync(resultsPath, 'utf-8'))
    for (const suite of results.suites ?? []) {
      failures.push(...extractFailures(suite, null))
    }
    // No per-test failures extracted but the run still failed → surface whatever detail
    // Playwright DID record instead of a content-free "Unknown" alert. This happens on a
    // global setup/teardown failure, a worker crash, or a config error — the real info lives
    // in the report's top-level `errors` and `stats`, not in any spec.
    if (failures.length === 0) {
      const topErrors = (results.errors ?? [])
        .map((e) => stripAnsi(e?.message || String(e)).split('\n')[0].slice(0, 300))
        .filter(Boolean)
      if (topErrors.length) {
        failures = topErrors.map((msg) => ({
          project: 'Run-level error',
          test: 'global setup/teardown / worker',
          error: msg,
          file: '',
        }))
      } else {
        const s = results.stats || {}
        const statsLine = Object.keys(s).length
          ? `${s.expected ?? '?'} passed, ${s.unexpected ?? '?'} failed, ${s.flaky ?? '?'} flaky, ${s.skipped ?? '?'} skipped`
          : 'report had no suites and no top-level errors'
        failures = [{
          project: 'Run failed — no per-test detail',
          test: 'see run logs',
          error: `The run failed but produced no parseable per-test failures (${statsLine}). Likely a crash/timeout in setup or a worker died. Open the run logs.`,
          file: '',
        }]
      }
    }
  } catch (e) {
    failures = [{ project: 'Parser', test: 'results.json', error: `Failed to parse: ${e.message}` }]
  }
} else {
  // No report at all → the run died before Playwright wrote results (infra / timeout / crash).
  failures = [{
    project: 'Run failed — no report produced',
    test: 'results.json missing',
    error: 'test-results/results.json was not generated — the run likely crashed or timed out before Playwright wrote a report. Open the run logs.',
    file: '',
  }]
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
// current failure was ALSO failing in the immediately-previous monitor run (a continuing, already-
// alerted issue). A NEW/changed failure signature always pages. FAIL-OPEN: any uncertainty (no
// prior run, artifact missing, parse error, GH error) → send the alert. We never go silent on doubt.
function previousFailureSignatures() {
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
    if (prev.conclusion === 'success') return new Set()   // last run GREEN → every current failure is new → send
    // Last run failed → pull its results.json artifact and extract its failure signatures.
    execSync(`gh run download ${prev.databaseId} -n test-results -D _prev_results`, { encoding: 'utf-8', timeout: 60_000 })
    const prevResults = JSON.parse(readFileSync('_prev_results/test-results/results.json', 'utf-8'))
    const prevFailures = []
    for (const suite of prevResults.suites ?? []) prevFailures.push(...extractFailures(suite, null))
    if (prevFailures.length === 0) return null      // couldn't read prior failures → fail open
    return new Set(prevFailures.map((f) => `${f.project}||${f.test}`))
  } catch {
    return null                                     // ANY error → fail open (send)
  }
}

const currentSignatures = failures.map((f) => `${f.project}||${f.test}`)
const prevSignatures = previousFailureSignatures()
const allAlreadyAlerted =
  prevSignatures instanceof Set &&
  prevSignatures.size > 0 &&
  currentSignatures.length > 0 &&
  currentSignatures.every((s) => prevSignatures.has(s))
if (allAlreadyAlerted && !allFixed) {
  console.log(`Suppressing duplicate alert — all ${currentSignatures.length} failure(s) were already alerted in the previous run (still failing, no new/changed issue). Resolution email will fire when they recover.`)
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
  headerSubtitle = `${failures.length} test(s) failed across ${Object.keys(projectGroups).length} project(s)`
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

const transporter = await createMailTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  user: SMTP_USER,
  pass: SMTP_PASS,
})

await transporter.sendMail({
  from: `Production Monitor <${SMTP_USER}>`,
  to: ALERT_EMAIL,
  subject: allFixed
    ? `[AUTO-FIXED] ${autoFixCount} issue(s) resolved automatically`
    : hasAutoFixes
      ? `[PARTIAL FIX] ${failures.length} issue(s) need attention, ${autoFixCount} auto-fixed`
      : `[ALERT] ${failures.length} test(s) failed — ${projectSummary}`,
  html,
})

console.log(`Alert sent to ${ALERT_EMAIL} with ${failures.length} failure(s): ${projectSummary}`)
