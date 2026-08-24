// send-drift-alert.mjs — Failure alert for the Staging-Prod Drift Check workflow.
// Renders the ACTUAL drift findings (schema/constraint/cron/placeholder drift from
// check-drift.mjs, and deploy.yml pipeline drift from check-pipeline-drift.mjs) instead
// of the Playwright-shaped "Run failed — no report produced" fallback that send-alert.mjs
// emits when there is no test-results/results.json (the drift job never runs Playwright).
// Reads drift-results.json and pipeline-drift-results.json (each a JSON array of finding
// strings). FAIL-OPEN: if neither payload exists but the job still failed (npm ci, a hard
// crash before a payload was written), it sends a generic "workflow failed — open the logs"
// alert rather than going silent. Modeled on send-automation-alert.mjs / send-alert.mjs.

import { createMailTransport } from './lib/smtp.mjs'
import { readFileSync, existsSync } from 'node:fs'

const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, ALERT_EMAIL, GITHUB_RUN_URL } = process.env

if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !ALERT_EMAIL) {
  console.error('Missing SMTP or alert config')
  process.exit(1)
}

/** Load a JSON array-of-strings payload; [] if absent or unparseable. */
function loadFindings(path) {
  if (!existsSync(path)) return []
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'))
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

const sections = [
  { category: 'Staging↔Prod DB drift', findings: loadFindings('drift-results.json') },
  { category: 'Deploy-pipeline drift', findings: loadFindings('pipeline-drift-results.json') },
].filter((s) => s.findings.length > 0)

const totalFindings = sections.reduce((n, s) => n + s.findings.length, 0)

// FAIL-OPEN: job failed but no payload was written (crash before the drift scripts, npm ci
// failure, etc.). Never go silent on a red run — send a generic "open the logs" alert.
const rows = totalFindings > 0
  ? sections
      .flatMap((s) =>
        s.findings.map(
          (f) => `<tr>
        <td style="padding:8px;border:1px solid #e5e7eb;font-weight:600;white-space:nowrap">${s.category}</td>
        <td style="padding:8px;border:1px solid #e5e7eb;color:#dc2626;font-family:monospace;font-size:12px">${f}</td>
      </tr>`,
        ),
      )
      .join('')
  : `<tr>
        <td style="padding:8px;border:1px solid #e5e7eb;font-weight:600;white-space:nowrap">Drift check failed</td>
        <td style="padding:8px;border:1px solid #e5e7eb;color:#dc2626;font-family:monospace;font-size:12px">The drift-check workflow failed but wrote no findings payload (likely a crash/timeout or an npm ci failure before the drift scripts ran). Open the run logs.</td>
      </tr>`

const headerSubtitle = totalFindings > 0
  ? `${totalFindings} drift finding(s) across ${sections.length} categor${sections.length === 1 ? 'y' : 'ies'} — staging is not a truthful rehearsal of prod until resolved.`
  : 'The drift-check workflow failed without producing a findings payload. Open the run logs.'

const html = `
  <div style="font-family:system-ui,sans-serif;max-width:700px;margin:0 auto">
    <div style="background:#dc2626;color:white;padding:16px 24px;border-radius:8px 8px 0 0">
      <h2 style="margin:0;font-size:18px">Staging-Prod Drift Check — Failed</h2>
      <p style="margin:4px 0 0;font-size:14px;opacity:0.9">${headerSubtitle}</p>
    </div>
    <div style="padding:24px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px">
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead>
          <tr style="background:#fef2f2">
            <th style="padding:8px;border:1px solid #e5e7eb;text-align:left">Category</th>
            <th style="padding:8px;border:1px solid #e5e7eb;text-align:left">Finding</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      ${GITHUB_RUN_URL ? `<p style="margin-top:16px"><a href="${GITHUB_RUN_URL}" style="color:#2563eb">View full run logs</a></p>` : ''}
      <p style="margin-top:16px;font-size:12px;color:#6b7280">
        Sent by production-monitor (drift-check) at ${new Date().toISOString()}
      </p>
    </div>
  </div>
`

const subject = totalFindings > 0
  ? `[DRIFT] ${totalFindings} staging↔prod drift finding(s) detected`
  : `[DRIFT] drift-check workflow failed — see run logs`

// Local verification hook: DRIFT_ALERT_DRYRUN=1 prints the subject + HTML and exits
// without sending, so the render path can be checked without SMTP or a real email.
if (process.env.DRIFT_ALERT_DRYRUN) {
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

console.log(`Drift alert sent to ${ALERT_EMAIL} with ${totalFindings} finding(s).`)
