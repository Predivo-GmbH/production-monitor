import { createMailTransport } from './lib/smtp.mjs'
import { execSync } from 'child_process'
import { sendOrEscalate } from './lib/alert-fallback.mjs'

const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, ALERT_EMAIL, GITHUB_RUN_URL } = process.env

if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !ALERT_EMAIL) {
  console.error('Missing SMTP or alert config')
  process.exit(1)
}

// Check if the previous workflow run failed
let previousFailed = false
let failedSummary = ''

// Manual self-test: `gh workflow run monitor.yml -f force_resolved_email=true`
// forces a send so the notification path can be verified end-to-end without
// waiting for a real fail->recover cycle. (The resolution path was silently
// broken before — this is its regression guard.)
const forceSend = String(process.env.FORCE_RESOLVED_EMAIL || '') === 'true'
if (forceSend) {
  console.log('FORCE_RESOLVED_EMAIL=true — sending a test resolution email')
  previousFailed = true
}

if (!forceSend) try {
  // This step runs while the CURRENT run is still in-progress, so the current
  // run is NOT yet in the --status=completed list. The previous bug assumed
  // runs[0] was the current run and checked runs[1] — off by one — so the
  // resolution email never fired. Instead: list recent runs, exclude the
  // current run by id (GITHUB_RUN_ID is always set in Actions), and take the
  // most recent run that actually finished tests (success/failure, not
  // cancelled). That is the genuine "previous run".
  const currentRunId = String(process.env.GITHUB_RUN_ID || '')
  const runsJson = execSync(
    'gh run list --workflow=monitor.yml --limit=10 --json conclusion,status,databaseId',
    { encoding: 'utf-8' },
  )
  const runs = JSON.parse(runsJson)
  const previous = runs.find(
    (r) =>
      String(r.databaseId) !== currentRunId &&
      r.status === 'completed' &&
      (r.conclusion === 'success' || r.conclusion === 'failure'),
  )
  if (previous) {
    console.log(`Previous run ${previous.databaseId} concluded: ${previous.conclusion}`)
    if (previous.conclusion === 'failure') previousFailed = true
  } else {
    console.log('No prior completed run found to compare against')
  }
} catch (e) {
  console.log('Could not check previous run status:', e.message)
}

if (!previousFailed) {
  console.log('Previous run was not a failure — no resolution email needed')
  process.exit(0)
}

// Try to get failure details from the previous alert (auto-fix-results or generic)
let resolvedItems = []
try {
  const logsJson = execSync(
    'gh run list --workflow=monitor.yml --status=completed --limit=5 --json conclusion,databaseId',
    { encoding: 'utf-8' },
  )
  const logs = JSON.parse(logsJson)
  const failedRuns = logs.filter(r => r.conclusion === 'failure')
  if (failedRuns.length > 0) {
    failedSummary = `${failedRuns.length} recent failed run(s) before this green run.`
  }
} catch { /* ignore */ }

const html = `
  <div style="font-family:system-ui,sans-serif;max-width:700px;margin:0 auto">
    <div style="background:#059669;color:white;padding:16px 24px;border-radius:8px 8px 0 0">
      <h2 style="margin:0;font-size:18px">Production Monitor — All Clear${forceSend ? ' (TEST)' : ''}</h2>
      <p style="margin:4px 0 0;font-size:14px;opacity:0.9">${forceSend ? 'Test of the notification path — triggered manually, not a real recovery.' : 'All tests are passing again. No action needed.'}</p>
    </div>
    <div style="padding:24px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px">
      <p style="margin:0 0 12px;font-size:14px;color:#374151">
        The issues from the previous run have been resolved. All production monitors are green.
      </p>
      ${GITHUB_RUN_URL ? `<p style="margin-top:16px"><a href="${GITHUB_RUN_URL}" style="color:#2563eb">View full run logs</a></p>` : ''}
      <p style="margin-top:16px;font-size:12px;color:#6b7280">
        Sent by production-monitor at ${new Date().toISOString()}
      </p>
    </div>
  </div>
`

const subject = forceSend ? '[TEST] Resolution email — notification path check' : '[RESOLVED] All tests passing again'

// Guarded the same way as send-alert.mjs, and for the same two reasons. A resolution mail that
// dies on a refused login used to die in this log only; now it is filed on the board. And a
// resolution mail that GOES OUT is the first proof that the mail server is back, so the success
// path withdraws the "could not email you" row the failed run before it filed — on 2026-09-05
// that row stayed CRITICAL + needs_human for a server that delivered this very email at 08:19:56Z.
// The transport is built INSIDE the guarded call: it pins the MX A record, so DNS/connect
// failures throw there, before sendMail is ever reached.
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
    failures: [],
    runUrl: GITHUB_RUN_URL,
    smtpHost: SMTP_HOST,
    smtpUser: SMTP_USER,
    // The password is never wanted in a log or on the board; an SMTP server can echo it back.
    secrets: [SMTP_PASS],
  },
  { secret: process.env.BOARD_SUPABASE_SECRET || process.env.BACKOFFICE_SERVICE_ROLE_KEY },
)

console.log(`Resolution email sent to ${ALERT_EMAIL}`)
