// send-ci-runner-alert.mjs - emails the findings of check-ci-runners.mjs.
// Reads ci-runner-findings.json. Modelled on send-heartbeat-alert.mjs.
//
// Why this exists: check-ci-runners.mjs already moves the fleet back to GitHub-hosted runners on
// its own, so nothing breaks when the office PC is off. But a red run in the GitHub UI is not an
// alert - nobody is watching the GitHub UI. Without this, the fleet could sit on rented runners
// for days, quietly costing money, and the first sign would be the bill.
import { createMailTransport } from './lib/smtp.mjs'
import { classifyWatchdogFailure } from './lib/classify-watchdog-failure.mjs'
import { readFileSync, existsSync } from 'node:fs'

const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, ALERT_EMAIL, GITHUB_RUN_URL } = process.env

if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !ALERT_EMAIL) {
  console.error('Missing SMTP or alert config')
  process.exit(1)
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const transporter = await createMailTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  user: SMTP_USER,
  pass: SMTP_PASS,
})

// This step runs `if: failure()`. There are two very different reasons the checker failed:
//   1. It ran fine and found something (fell back to paid runners) -> benign report below.
//   2. It could NOT run at all (blind/expired PAT, no runners, API errors, or it crashed before
//      writing its report). That is the MORE dangerous case: the fleet is now unwatched. It must
//      NOT be reported with the reassuring "nothing is broken" copy, and it must NOT exit 0 - that
//      is the silent-failure this whole file exists to prevent.
let report = { findings: [], flips: [], repos_with_runners: null }
let brokenReason = null
if (!existsSync('ci-runner-findings.json')) {
  brokenReason = 'the watchdog wrote no report - it failed or crashed before it could inspect the fleet (see the run logs)'
} else {
  try {
    report = JSON.parse(readFileSync('ci-runner-findings.json', 'utf-8'))
    if (report.watchdog_broken) brokenReason = report.broken_reason || 'the watchdog reported it could not certify the fleet'
  } catch {
    brokenReason = 'the watchdog left an unreadable report (see the run logs)'
  }
}

// Case 3 (LAYER 2): the watchdog WORKFLOW itself has gone silent - monitor.yml files this with
// watchdog_silent:true when check-ci-watchdog-alive.mjs reports the every-10-min watchdog has not
// run. This is the OPPOSITE of the benign "moved to paid runners" copy: nothing has been moved and
// there is NO automatic fallback. While the watchdog is silent nobody flips RUNNER_LABEL, so if the
// office PC then goes down every job queues with no alert. Distinct red copy, but exit 0 on purpose:
// the email IS the alert, and the monitor job must stay green so the generic monitor alert does not
// separately mail "production monitor failed" for the same event (that double-mail trains you to
// ignore both). The monitor step is `continue-on-error`, so this failure never turns the run red.
if (report.watchdog_silent) {
  const detail = (report.findings && report.findings[0]) ||
    'The CI runner watchdog has stopped running.'
  const silentHtml = `
  <div style="font-family:system-ui,sans-serif;max-width:760px;margin:0 auto">
    <div style="background:#dc2626;color:white;padding:16px 24px;border-radius:8px 8px 0 0">
      <h2 style="margin:0;font-size:18px">The CI runner watchdog has gone SILENT - the fleet has NO automatic fallback</h2>
      <p style="margin:4px 0 0;font-size:14px;opacity:0.95">
        This is NOT the "office PC is off, moved to paid runners" notice. NOTHING has been moved and
        nothing is protected: while the watchdog is silent nobody is flipping the fleet to paid runners,
        so if the office PC goes down now, every build and deploy queues with no fallback and no alert.
      </p>
    </div>
    <div style="padding:24px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px">
      <p style="margin:0 0 12px;font-size:13px"><strong>What the heartbeat reported:</strong></p>
      <table style="width:100%;border-collapse:collapse"><tbody>
        <tr><td style="padding:8px;border:1px solid #e5e7eb;font-size:13px">${esc(detail)}</td></tr>
      </tbody></table>
      <p style="margin-top:16px;font-size:13px;color:#374151">
        <strong>What usually causes this:</strong> a scheduled workflow stops running silently - GitHub
        disables it after 60 days of repo inactivity, someone deleted or renamed it, or the Actions spend
        cap tripped and stopped every workflow in the account. Open the <code>ci-runner-watchdog</code>
        workflow in production-monitor and re-enable / restore it; the check clears within an hour.
      </p>
      ${GITHUB_RUN_URL ? `<p style="margin-top:8px"><a href="${GITHUB_RUN_URL}" style="color:#2563eb">View full run logs</a></p>` : ''}
      <p style="margin-top:8px;font-size:12px;color:#6b7280">Sent by production-monitor at ${new Date().toISOString()}</p>
    </div>
  </div>
  `
  await transporter.sendMail({
    from: `Production Monitor <${SMTP_USER}>`,
    to: ALERT_EMAIL,
    subject: `[CI RUNNERS] the runner watchdog has gone SILENT - the fleet has NO automatic fallback`,
    html: silentHtml,
  })
  console.log(`CI runner WATCHDOG-SILENT alert sent to ${ALERT_EMAIL}: ${detail}`)
  process.exit(0)
}

// Case 2: the watchdog itself is blind. Loud, distinct, non-zero.
if (brokenReason) {
  // The "renew the token" advice is only right when the failure is actually auth-shaped. A rate
  // limit, a dropped socket, a timeout, a crash, or a batch of failed API calls is NOT an expired
  // PAT, and telling Roger to renew the token every time trains him to distrust the one case where
  // it IS the token. So classify the reason (ratelimit | auth | other) and speak to what actually
  // failed. A rate limit is the most important to separate out: a 403 rate-limit looks exactly like
  // a 403 auth failure, and this alarm blamed the token for it three times before this.
  const kind = classifyWatchdogFailure(brokenReason)

  // ...but classifying it right is only half the job: we then PAGED for it anyway. A rate-limited
  // run is blind for a reason that is not this watchdog's to report and that Roger cannot act on -
  // the shared hourly API allowance was emptied upstream, the token is fine, and the check goes
  // green by itself at the reset. That condition already HAS an owner: check-github-api-budget.mjs,
  // whose source `github-api-budget` deliberately carries no `signal_page_policy` row so it lands
  // on /signals and "never rings his phone unasked" - the house default-nobody-chose rule. Emailing
  // from here bypassed a decision the house had already made. On 2026-08-30 a single self-healing
  // exhaustion (reset 17:20) sent four identical "the runner alarm is blind" pages between 16:40
  // and 17:16, each of whose own body said the check needs nothing and fixes itself.
  //
  // So: do not page - but STAY RED (exit 1). A run that could not certify the fleet must never look
  // healthy; see the "ABSENCE IS NOT SUCCESS" contract at the top of check-ci-runners.mjs. The red
  // run and the /signals row remain; only the unasked-for email goes away.
  if (kind === 'ratelimit') {
    console.log(
      'CI runner watchdog is blind on a RATE LIMIT - not paging. The shared API hour was emptied ' +
      'upstream; the token is valid and this clears itself at the reset. github-api-budget owns ' +
      `this condition and files it to /signals. Reason: ${brokenReason}`,
    )
    process.exit(1)
  }

  const likelyCauseHtml = kind === 'auth'
    ? `<p style="margin-top:16px;font-size:13px;color:#374151">
        <strong>Most likely cause:</strong> the DASHBOARD_PAT expired or lost its <code>administration</code>
        scope - the most likely auth failure of this watchdog. Renew/rescope the token and the check
        goes green within 10 minutes.
      </p>`
    : `<p style="margin-top:16px;font-size:13px;color:#374151">
        <strong>What to check:</strong> this is not an auth failure - the reason above is a crash, a
        timeout, a dropped connection, or failed API calls, not an expired token. Open the run logs to
        see what actually failed. (If the reason later mentions 401/403 or the token/scope, then renew
        the DASHBOARD_PAT.)
      </p>`
  const brokenHtml = `
  <div style="font-family:system-ui,sans-serif;max-width:760px;margin:0 auto">
    <div style="background:#dc2626;color:white;padding:16px 24px;border-radius:8px 8px 0 0">
      <h2 style="margin:0;font-size:18px">CI-runner watchdog could NOT complete - the runner alarm is blind</h2>
      <p style="margin:4px 0 0;font-size:14px;opacity:0.95">
        This is NOT the usual "office PC is off, moved to paid runners" notice. The watchdog failed
        before it could inspect the fleet, so right now nothing is confirming whether your CI is on
        free or paid runners. Until this is fixed, the cost saver is unwatched.
      </p>
    </div>
    <div style="padding:24px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px">
      <p style="margin:0 0 12px;font-size:13px"><strong>Reason reported by the run:</strong></p>
      <table style="width:100%;border-collapse:collapse"><tbody>
        <tr><td style="padding:8px;border:1px solid #e5e7eb;font-size:13px">${esc(brokenReason)}</td></tr>
      </tbody></table>
      ${likelyCauseHtml}
      ${GITHUB_RUN_URL ? `<p style="margin-top:8px"><a href="${GITHUB_RUN_URL}" style="color:#2563eb">View full run logs</a></p>` : ''}
      <p style="margin-top:8px;font-size:12px;color:#6b7280">Sent by production-monitor at ${new Date().toISOString()}</p>
    </div>
  </div>
  `
  await transporter.sendMail({
    from: `Production Monitor <${SMTP_USER}>`,
    to: ALERT_EMAIL,
    subject: `[CI RUNNERS] watchdog could NOT complete - the runner alarm is blind`,
    html: brokenHtml,
  })
  console.log(`CI runner WATCHDOG-BROKEN alert sent to ${ALERT_EMAIL}: ${brokenReason}`)
  process.exit(1)
}

const findings = report.findings || []
const flips = report.flips || []

if (findings.length === 0 && flips.length === 0) {
  console.log('No CI runner findings to report.')
  process.exit(0)
}

const rows = findings
  .map((f) => `<tr><td style="padding:8px;border:1px solid #e5e7eb;font-size:13px">${esc(f)}</td></tr>`)
  .join('')

const flipRows = flips
  .map((f) => `<li style="margin:4px 0">${esc(f)}</li>`)
  .join('')

const html = `
  <div style="font-family:system-ui,sans-serif;max-width:760px;margin:0 auto">
    <div style="background:#b45309;color:white;padding:16px 24px;border-radius:8px 8px 0 0">
      <h2 style="margin:0;font-size:18px">CI runners: the office PC is not taking our build jobs</h2>
      <p style="margin:4px 0 0;font-size:14px;opacity:0.95">
        Nothing is broken and nothing is blocked. The fleet has been moved back onto GitHub's rented
        runners automatically, so deploys and tests still work. They just cost money again while this lasts.
      </p>
    </div>
    <div style="padding:24px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px">
      ${flips.length ? `<p style="margin:0 0 12px;font-size:13px"><strong>Switched automatically:</strong></p><ul style="margin:0 0 16px;padding-left:20px;font-size:13px">${flipRows}</ul>` : ''}
      ${rows ? `<table style="width:100%;border-collapse:collapse"><tbody>${rows}</tbody></table>` : ''}
      <p style="margin-top:16px;font-size:13px;color:#374151">
        <strong>What usually causes this:</strong> the PC is off or asleep, or it rebooted and nobody has
        logged in yet (the runner host starts at logon, not at boot). Logging in normally fixes it, and the
        fleet moves itself back to the free runners within 10 minutes.
      </p>
      <p style="margin-top:8px;font-size:12px;color:#6b7280">
        Cost while it lasts: roughly $0.006 per build-minute. This is a bill problem, not an outage.
      </p>
      ${GITHUB_RUN_URL ? `<p style="margin-top:8px"><a href="${GITHUB_RUN_URL}" style="color:#2563eb">View full run logs</a></p>` : ''}
      <p style="margin-top:8px;font-size:12px;color:#6b7280">Sent by production-monitor at ${new Date().toISOString()}</p>
    </div>
  </div>
`

await transporter.sendMail({
  from: `Production Monitor <${SMTP_USER}>`,
  to: ALERT_EMAIL,
  subject: `[CI RUNNERS] office PC not taking build jobs - fleet moved to paid runners`,
  html,
})

console.log(`CI runner alert sent to ${ALERT_EMAIL} (${findings.length} finding(s), ${flips.length} flip(s)).`)
