#!/usr/bin/env node
/**
 * send-dashboard-alert.mjs — Failure alert for the Daily Dashboard Update workflow.
 *
 * WHY THIS IS NOT send-alert.mjs. That sender is shaped for the Playwright monitor: it reads
 * test-results/results.json, and when there is none it renders "Run failed — no report produced
 * / results.json missing". This job never runs Playwright, so every alert it sent would have
 * described a missing test report instead of the dead FTP password that actually broke it.
 * Worse, send-alert.mjs dedups against `gh run list --workflow=monitor.yml` — an unrelated red
 * monitor could SUPPRESS this alarm entirely. Same reasoning that gave drift-check.yml its own
 * sender (see scripts/send-drift-alert.mjs).
 *
 * WHAT IT REPORTS. There is no findings payload for "the FTP server did not answer" — the
 * failure IS the step. So it asks GitHub which step of THIS run failed and names it. Scoped to
 * the current job (GITHUB_JOB) so that two failing jobs in one run send two accurate mails
 * rather than two copies of everything.
 *
 * FAIL-OPEN, ALWAYS. Anything that goes wrong while working out WHICH step failed — no token,
 * no run id, `gh` missing, a malformed response — falls back to a generic "this workflow failed,
 * open the logs" mail. A red run must never end in silence; that silence is the whole reason
 * this file exists (run 33643774410, 2026-09-02).
 *
 * Contract: node scripts/send-dashboard-alert.mjs
 *   env: SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/ALERT_EMAIL (required),
 *        GH_TOKEN (optional — enables step naming), WORKFLOW_LABEL, GITHUB_RUN_URL,
 *        GITHUB_RUN_ID, GITHUB_JOB, DASHBOARD_ALERT_DRYRUN=1 to render without sending.
 */
import { execSync } from 'node:child_process'
import { createMailTransport } from './lib/smtp.mjs'

const {
  SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, ALERT_EMAIL,
  GITHUB_RUN_URL, WORKFLOW_LABEL,
} = process.env

if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !ALERT_EMAIL) {
  console.error('Missing SMTP or alert config')
  process.exit(1)
}

const label = WORKFLOW_LABEL || 'Daily Dashboard Update'
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * Ask GitHub which step(s) of this run failed. Returns [] on ANY problem, and the caller then
 * sends the generic mail — never worse than the alert we would otherwise have sent.
 */
function failedSteps() {
  try {
    const runId = String(process.env.GITHUB_RUN_ID || '')
    if (!runId) return []
    if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) return []
    const out = execSync(`gh run view ${runId} --json jobs`, { encoding: 'utf-8', timeout: 30_000 })
    const jobs = JSON.parse(out).jobs ?? []

    // Only this job's steps, when we can tell which job we are. Both jobs in this workflow set
    // no `name:`, so the API's job name is the job id GITHUB_JOB carries. If it does not match
    // (a renamed job, a matrix), fall back to every failed step rather than reporting nothing.
    const mine = jobs.filter((j) => j.name === process.env.GITHUB_JOB)
    const scope = mine.length > 0 ? mine : jobs

    const rows = []
    for (const job of scope) {
      for (const step of job.steps ?? []) {
        if (step.conclusion === 'failure') {
          rows.push({ job: job.name, step: step.name || 'unnamed step' })
        }
      }
    }
    return rows
  } catch {
    return []
  }
}

const steps = failedSteps()

const rows = steps.length > 0
  ? steps.map((s) => `<tr>
        <td style="padding:8px;border:1px solid #e5e7eb;font-weight:600;white-space:nowrap">${esc(s.job)}</td>
        <td style="padding:8px;border:1px solid #e5e7eb;color:#dc2626;font-family:monospace;font-size:12px">${esc(s.step)}</td>
      </tr>`).join('')
  : `<tr>
        <td style="padding:8px;border:1px solid #e5e7eb;font-weight:600;white-space:nowrap">${esc(label)}</td>
        <td style="padding:8px;border:1px solid #e5e7eb;color:#dc2626;font-family:monospace;font-size:12px">The workflow failed. The failing step could not be identified from here — open the run logs.</td>
      </tr>`

const headerSubtitle = steps.length > 0
  ? `${steps.length} step(s) failed: ${steps.map((s) => s.step).join(', ')}. The dashboard was not published.`
  : 'The workflow failed. The dashboard was not published.'

const html = `
  <div style="font-family:system-ui,sans-serif;max-width:700px;margin:0 auto">
    <div style="background:#dc2626;color:white;padding:16px 24px;border-radius:8px 8px 0 0">
      <h2 style="margin:0;font-size:18px">${esc(label)} — Failed</h2>
      <p style="margin:4px 0 0;font-size:14px;opacity:0.9">${esc(headerSubtitle)}</p>
    </div>
    <div style="padding:24px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px">
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead>
          <tr style="background:#fef2f2">
            <th style="padding:8px;border:1px solid #e5e7eb;text-align:left">Job</th>
            <th style="padding:8px;border:1px solid #e5e7eb;text-align:left">Failed step</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="margin-top:16px;font-size:13px;color:#374151">
        While this is red, the project dashboard and <code>automation-status.json</code> keep
        serving their last good copy — consumers read that as current, so a stale fleet view is
        part of the damage, not just the missing update.
      </p>
      ${GITHUB_RUN_URL ? `<p style="margin-top:16px"><a href="${GITHUB_RUN_URL}" style="color:#2563eb">View full run logs</a></p>` : ''}
      <p style="margin-top:16px;font-size:12px;color:#6b7280">
        Sent by production-monitor (dashboard-update) at ${new Date().toISOString()}
      </p>
    </div>
  </div>
`

const subject = steps.length > 0
  ? `[ALERT] ${label} failed — ${steps.map((s) => s.step).join(', ')}`
  : `[ALERT] ${label} failed — see run logs`

// Local verification hook, mirroring send-drift-alert.mjs: render without SMTP or a real email.
if (process.env.DASHBOARD_ALERT_DRYRUN) {
  console.log(`SUBJECT: ${subject}\n\n${html}`)
  process.exit(0)
}

const transporter = await createMailTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  user: SMTP_USER,
  pass: SMTP_PASS,
})

await transporter.sendMail({
  from: `Production Monitor <${SMTP_USER}>`,
  to: ALERT_EMAIL,
  subject,
  html,
})

console.log(`Dashboard alert sent to ${ALERT_EMAIL} naming ${steps.length} failed step(s).`)
