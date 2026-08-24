// send-automation-alert.mjs — Emails when one or more GitHub Actions workflows have
// been red longer than the escalation threshold. Reads /tmp/automation-escalations.json
// produced by automation-status.mjs. Modeled on send-alert.mjs.

import { createMailTransport } from './lib/smtp.mjs'
import { readFileSync, existsSync } from 'node:fs'

const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, ALERT_EMAIL } = process.env

if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !ALERT_EMAIL) {
  console.error('Missing SMTP or alert config')
  process.exit(1)
}

let escalations = []
const path = '/tmp/automation-escalations.json'
if (existsSync(path)) {
  try {
    escalations = JSON.parse(readFileSync(path, 'utf-8'))
  } catch { /* ignore */ }
}

if (escalations.length === 0) {
  console.log('No escalations to report.')
  process.exit(0)
}

const rows = escalations
  .map(
    (e) =>
      `<tr>
        <td style="padding:8px;border:1px solid #e5e7eb;font-weight:600;white-space:nowrap">${e.name}</td>
        <td style="padding:8px;border:1px solid #e5e7eb">${e.workflow}</td>
        <td style="padding:8px;border:1px solid #e5e7eb;color:#dc2626;white-space:nowrap">${e.redHours} h</td>
        <td style="padding:8px;border:1px solid #e5e7eb"><a href="${e.url}" style="color:#2563eb">Run ansehen</a></td>
      </tr>`,
  )
  .join('')

const html = `
  <div style="font-family:system-ui,sans-serif;max-width:700px;margin:0 auto">
    <div style="background:#dc2626;color:white;padding:16px 24px;border-radius:8px 8px 0 0">
      <h2 style="margin:0;font-size:18px">Automation Alert — Workflows seit über 48 h rot</h2>
      <p style="margin:4px 0 0;font-size:14px;opacity:0.9">${escalations.length} Workflow(s) schlagen seit längerem fehl und wurden nicht behoben.</p>
    </div>
    <div style="padding:24px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px">
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead>
          <tr style="background:#fef2f2">
            <th style="padding:8px;border:1px solid #e5e7eb;text-align:left">Projekt</th>
            <th style="padding:8px;border:1px solid #e5e7eb;text-align:left">Workflow</th>
            <th style="padding:8px;border:1px solid #e5e7eb;text-align:left">Rot seit</th>
            <th style="padding:8px;border:1px solid #e5e7eb;text-align:left">Link</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="margin-top:16px;font-size:12px;color:#6b7280">
        Status live im BackOffice: backoffice.predivo.ch → Administration → Wie wir arbeiten.<br>
        Gesendet von production-monitor am ${new Date().toISOString()}
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
  subject: `[AUTOMATION] ${escalations.length} Workflow(s) seit >48h rot`,
  html,
})

console.log(`Automation alert sent to ${ALERT_EMAIL} with ${escalations.length} escalation(s).`)
