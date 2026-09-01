// send-automation-resolved.mjs — Emails when previously-escalated workflows (red beyond
// their cadence-relative escalation threshold) are green again. Reads
// /tmp/automation-resolved.json produced by automation-status.mjs
// (diff against the previously published report). Counterpart to send-automation-alert.mjs.
//
// The hourly local auto-fix re-dispatches dashboard-update.yml after fixing an
// escalation, so this email typically arrives minutes after the fix — Roger's
// "issue was fixed" notification for the [AUTOMATION] alert class.

import { createMailTransport } from './lib/smtp.mjs'
import { readFileSync, existsSync } from 'node:fs'

const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, ALERT_EMAIL } = process.env

if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !ALERT_EMAIL) {
  console.error('Missing SMTP or alert config')
  process.exit(1)
}

let resolved = []
// RESOLVED_FILE override exists so the send path can be tested locally (Windows has no /tmp).
const path = process.env.RESOLVED_FILE || '/tmp/automation-resolved.json'
if (existsSync(path)) {
  try {
    resolved = JSON.parse(readFileSync(path, 'utf-8'))
  } catch { /* ignore */ }
}

if (resolved.length === 0) {
  console.log('No resolved escalations to report.')
  process.exit(0)
}

const rows = resolved
  .map(
    (e) =>
      `<tr>
        <td style="padding:8px;border:1px solid #e5e7eb;font-weight:600;white-space:nowrap">${e.name}</td>
        <td style="padding:8px;border:1px solid #e5e7eb">${e.workflow}</td>
        <td style="padding:8px;border:1px solid #e5e7eb;color:#6b7280;white-space:nowrap">war ${e.redHours} h rot</td>
        <td style="padding:8px;border:1px solid #e5e7eb"><a href="https://github.com/Predivo-GmbH/${e.repo}/actions" style="color:#2563eb">Runs ansehen</a></td>
      </tr>`,
  )
  .join('')

const html = `
  <div style="font-family:system-ui,sans-serif;max-width:700px;margin:0 auto">
    <div style="background:#059669;color:white;padding:16px 24px;border-radius:8px 8px 0 0">
      <h2 style="margin:0;font-size:18px">Automation Resolved — Workflow(s) wieder grün</h2>
      <p style="margin:4px 0 0;font-size:14px;opacity:0.9">${resolved.length} zuvor eskalierte(r) Workflow(s) laufen wieder erfolgreich. Keine Aktion nötig.</p>
    </div>
    <div style="padding:24px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px">
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead>
          <tr style="background:#ecfdf5">
            <th style="padding:8px;border:1px solid #e5e7eb;text-align:left">Projekt</th>
            <th style="padding:8px;border:1px solid #e5e7eb;text-align:left">Workflow</th>
            <th style="padding:8px;border:1px solid #e5e7eb;text-align:left">Dauer</th>
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
  subject: `[AUTOMATION RESOLVED] ${resolved.length} Workflow(s) wieder grün`,
  html,
})

console.log(`Automation resolution email sent to ${ALERT_EMAIL} for ${resolved.length} workflow(s).`)
