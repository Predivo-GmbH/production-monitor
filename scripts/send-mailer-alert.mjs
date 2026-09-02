// send-mailer-alert.mjs - emails the findings of check-mailer-config.mjs.
// Reads mailer-findings.json. Modelled on send-ci-runner-alert.mjs.
//
// Why this exists: a red run in the GitHub UI is not an alert, because nobody is watching the
// GitHub UI. That is not a theory here - BackOffice support mail was dead for four days in
// August 2026 and the only record of it was a database row nobody read.
//
// WHY THIS EMAIL IS NOT THE WHOLE ALARM. This mail leaves on the fleet's own Metanet mailbox,
// and three of the eight products this guard watches send through the same Metanet server. If
// that server is what broke, this mail dies with it. The heartbeat step in the workflow is the
// half that survives: healthchecks.io notices the missing ping and mails from ITS infrastructure,
// which shares nothing with ours. Two layers, on purpose.
import { createMailTransport } from './lib/smtp.mjs'
import { classifyMailerAlert } from './lib/mailer-alert-copy.mjs'
import { readFileSync, existsSync } from 'node:fs'

const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, ALERT_EMAIL, GITHUB_RUN_URL } = process.env

if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !ALERT_EMAIL) {
  console.error('Missing SMTP or alert config')
  process.exit(1)
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const transporter = await createMailTransport({ host: SMTP_HOST, port: SMTP_PORT, user: SMTP_USER, pass: SMTP_PASS })

// This step runs `if: failure()`, and there are two very different reasons for that:
//   1. The guard ran and found broken mailers -> the report below.
//   2. The guard could not run at all (a token expired, the APIs were unreachable, it crashed
//      before writing its report). That is the MORE dangerous case, because the fleet's mail is
//      now unwatched, and it must never be reported with the reassuring copy.
let report = null
let brokenReason = null
if (!existsSync('mailer-findings.json')) {
  brokenReason = 'the guard wrote no report - it failed or crashed before it could read the fleet (see the run logs)'
} else {
  try {
    report = JSON.parse(readFileSync('mailer-findings.json', 'utf-8'))
    if (!Array.isArray(report.failures)) brokenReason = 'the guard left a report with no findings in it'
  } catch {
    brokenReason = 'the guard left an unreadable report (see the run logs)'
  }
}

const shell = (colour, title, lede, body) => `
  <div style="font-family:system-ui,sans-serif;max-width:760px;margin:0 auto">
    <div style="background:${colour};color:white;padding:16px 24px;border-radius:8px 8px 0 0">
      <h2 style="margin:0;font-size:18px">${title}</h2>
      <p style="margin:4px 0 0;font-size:14px;opacity:0.95">${lede}</p>
    </div>
    <div style="padding:24px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px">
      ${body}
      ${GITHUB_RUN_URL ? `<p style="margin-top:8px"><a href="${GITHUB_RUN_URL}" style="color:#2563eb">View full run logs</a></p>` : ''}
      <p style="margin-top:8px;font-size:12px;color:#6b7280">Sent by production-monitor at ${new Date().toISOString()}</p>
    </div>
  </div>`

if (brokenReason) {
  await transporter.sendMail({
    from: `Production Monitor <${SMTP_USER}>`,
    to: ALERT_EMAIL,
    subject: '[MAILERS] the mailer guard could NOT complete - nothing is watching product email',
    html: shell('#dc2626', 'The mailer guard could not complete - product email is unwatched',
      'This is NOT a "a product cannot send" notice. The check itself failed before it could look, so right now nothing is confirming that any of the eight products can send mail.',
      `<p style="margin:0 0 12px;font-size:13px"><strong>Reason reported by the run:</strong></p>
       <table style="width:100%;border-collapse:collapse"><tbody><tr><td style="padding:8px;border:1px solid #e5e7eb;font-size:13px">${esc(brokenReason)}</td></tr></tbody></table>
       <p style="margin-top:16px;font-size:13px;color:#374151"><strong>Most likely cause:</strong> one of the per-account Supabase access tokens expired, or the Postmark account token was rotated. Both show up in the run log as an HTTP 401 or 403 against a named project.</p>`),
  })
  console.log(`Mailer GUARD-BROKEN alert sent to ${ALERT_EMAIL}: ${brokenReason}`)
  process.exit(1)
}

const failures = report.failures || []
if (!failures.length) {
  console.log('No mailer findings to report.')
  process.exit(0)
}

const rows = failures
  .map((f) => `<tr>
      <td style="padding:8px;border:1px solid #e5e7eb;font-size:13px;white-space:nowrap"><strong>${esc(f.product)}</strong><br><span style="color:#6b7280">${esc(f.env)}</span></td>
      <td style="padding:8px;border:1px solid #e5e7eb;font-size:13px">${esc(f.what)}<br><span style="color:#374151">${esc(f.detail)}</span></td>
    </tr>`)
  .join('')

// A finding whose `what` is 'unaudited' means the send history could not be READ, not that a send
// was proven to have failed. classifyMailerAlert reserves "cannot send email" for the proven case
// and renders an unaudited-only run as unaudited (2026-08-26 board finding).
// How many DECLARED products this run actually audited, counted from the guard's own rows. The
// classifier needs it to tell "one product could not be read" (amber) from "not one product could
// be read" (red - nothing is watching the fleet's email at all).
const fleetProducts = new Set((report.rows || []).map((r) => r.product)).size
const { colour, subject, title, lede } = classifyMailerAlert(failures, { fleetProducts })

await transporter.sendMail({
  from: `Production Monitor <${SMTP_USER}>`,
  to: ALERT_EMAIL,
  subject,
  html: shell(colour, title, lede,
    `<table style="width:100%;border-collapse:collapse"><tbody>${rows}</tbody></table>
     <p style="margin-top:16px;font-size:13px;color:#374151">Every line above was read from the live project this hour, not from the repo. What normally causes it: a mailer secret changed on one environment and not the other, a move to a new mail provider that left the port behind, a second piece of code quietly reading the first mailer's settings, or a send history that could not be read (a rotated token or an upstream HTTP 500).</p>`),
})

const products = [...new Set(failures.map((f) => f.product))]
console.log(`Mailer alert sent to ${ALERT_EMAIL} (${failures.length} finding(s) across ${products.length} product(s)).`)
