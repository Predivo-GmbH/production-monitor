// send-heartbeat-alert.mjs — Emails the findings of check-cron-heartbeats.mjs when
// one or more fleet pg_cron jobs are persistently dead or a project is unverifiable.
// Reads heartbeat-findings.json. Modeled on send-automation-alert.mjs. Runs nightly
// via cron-heartbeat.yml, so a standing breakage pages at most once per day.

import { createMailTransport } from './lib/smtp.mjs'
import { readFileSync, existsSync } from 'node:fs'

const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, ALERT_EMAIL, GITHUB_RUN_URL } = process.env

if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !ALERT_EMAIL) {
  console.error('Missing SMTP or alert config')
  process.exit(1)
}

let findings = []
if (existsSync('heartbeat-findings.json')) {
  try {
    findings = JSON.parse(readFileSync('heartbeat-findings.json', 'utf-8'))
  } catch { /* ignore */ }
}

if (findings.length === 0) {
  console.log('No heartbeat findings to report.')
  process.exit(0)
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const rows = findings
  .map(
    (f) =>
      `<tr>
        <td style="padding:8px;border:1px solid #e5e7eb;font-weight:600;white-space:nowrap">${esc(f.product)}</td>
        <td style="padding:8px;border:1px solid #e5e7eb;font-family:monospace;font-size:12px">${esc(f.job)}${f.schedule ? `<br><span style="color:#6b7280">[${esc(f.schedule)}]</span>` : ''}</td>
        <td style="padding:8px;border:1px solid #e5e7eb;color:${f.problem === 'unverifiable' ? '#b45309' : '#dc2626'};white-space:nowrap">${esc(f.problem)}</td>
        <td style="padding:8px;border:1px solid #e5e7eb;font-size:12px">${esc(f.detail)}</td>
      </tr>`,
  )
  .join('')

const html = `
  <div style="font-family:system-ui,sans-serif;max-width:760px;margin:0 auto">
    <div style="background:#dc2626;color:white;padding:16px 24px;border-radius:8px 8px 0 0">
      <h2 style="margin:0;font-size:18px">Fleet Cron Heartbeat — scheduled job(s) look dead</h2>
      <p style="margin:4px 0 0;font-size:14px;opacity:0.9">${findings.length} finding(s). Nothing here is a blip: a job is listed only after missing ~3× its own interval, or after its dispatched HTTP calls were refused (a dead credential, which never recovers on its own) or failed persistently.</p>
    </div>
    <div style="padding:24px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px">
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead>
          <tr style="background:#fef2f2">
            <th style="padding:8px;border:1px solid #e5e7eb;text-align:left">Product</th>
            <th style="padding:8px;border:1px solid #e5e7eb;text-align:left">Cron job</th>
            <th style="padding:8px;border:1px solid #e5e7eb;text-align:left">Problem</th>
            <th style="padding:8px;border:1px solid #e5e7eb;text-align:left">Detail</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="margin-top:16px;font-size:12px;color:#6b7280">
        Where to look depends on which of the two layers found it.
        A row naming ONE cron job is layer 1: look in the product's <code>cron.job_run_details</code> (and <code>cron.job</code>).
        A row whose job column reads "(N http_post cron job(s))" is layer 2, and for that one <code>cron.job_run_details</code> is the WRONG table —
        it reports 'succeeded' the moment a call is enqueued, whatever the call returns, which is how four jobs 401'd for weeks unseen.
        Look in <code>net._http_response</code> instead; it is the only table that knows, and it is pruned after about six hours, so read it soon.
        "dead" = pg_cron stopped producing successful runs, or the dispatched HTTP calls are being refused / persistently failing;
        "unverifiable" = this check could not reach the project or could not read the response table (fix that first — a silent watchdog is worse than none).
        Healing stays product-local; this layer only watches the watchers.
      </p>
      ${GITHUB_RUN_URL ? `<p style="margin-top:8px"><a href="${GITHUB_RUN_URL}" style="color:#2563eb">View full run logs</a></p>` : ''}
      <p style="margin-top:8px;font-size:12px;color:#6b7280">Sent by production-monitor at ${new Date().toISOString()}</p>
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
  subject: `[HEARTBEAT] ${findings.length} fleet cron job(s) look dead`,
  html,
})

console.log(`Heartbeat alert sent to ${ALERT_EMAIL} with ${findings.length} finding(s).`)
