#!/usr/bin/env node
/**
 * AN ALARM MAILER THAT CANNOT SEND MUST NOT DIE IN A LOG.
 *
 * -- WHY THIS EXISTS (2026-09-03) ------------------------------------------------------------
 *
 * At 2026-09-02T23:38Z the hourly monitor detected 4 failures. Six minutes later, at 23:44:18Z
 * in run 33695562762, `send-alert.mjs` tried to tell Roger and got
 *
 *     Invalid login: 535 5.7.8
 *
 * from the Metanet SMTP account. send-alert.mjs ended in a bare, unguarded
 * `await transporter.sendMail(...)`, so the rejection killed the process, the step went red
 * inside a job that was ALREADY red, and nothing else happened. THE FAILURE WAS DETECTED AND
 * THE NOTIFICATION DIED. Nobody was told, and the only record was a line in a log nobody opens.
 *
 * The mail account is not coming back on its own: the same Metanet box (tertia.sui-inter.net)
 * simultaneously stopped accepting the monitor's IMAP login (AUTHENTICATIONFAILED from ~20:18Z),
 * which is a SECOND mailbox on the SAME server refusing a password nobody changed. Both are
 * provider-side. Restoring the account needs Roger; making the alarm audible does not.
 *
 * -- WHY THE BOARD, AND NOT ANOTHER MAILBOX ---------------------------------------------------
 *
 * The obvious fix — "send it from somewhere else" — needs a credential, which is exactly what is
 * missing. The board needs none that we do not already hold, and it is PROVABLY a different
 * pipe, verified this turn rather than assumed:
 *
 *   - `signal_page_policy` has production-monitor may_page=true (read live 2026-09-03T01:30Z),
 *     so a signal filed under this source is allowed to page.
 *   - A page to Roger's address matches NONE of BackOffice's TEST_RECIPIENT_PATTERNS
 *     (_shared/email.ts:86-90 — '@backoffice-test.local', '+e2e@', 'pmverify-'), so it takes the
 *     Postmark HTTP branch at email.ts:126-133, NOT the Metanet SMTP branch at :152. The dead
 *     account is not in this path at all.
 *
 * So: SMTP is one pipe, the board is another, and only one of them is broken. This does not
 * "retry harder" — retrying a 535 is just failing again more slowly.
 *
 * -- HOW THIS COULD LIE -----------------------------------------------------------------------
 *
 * The failure mode to avoid is a fallback that swallows the original problem. So:
 *   - the ORIGINAL failures are carried INTO the signal (buildUndeliverableSignal embeds them);
 *     the point is that the CONTENT survives the dead channel, not merely the fact of failure.
 *   - if the board write ALSO fails, both errors are reported and the caller still fails. A
 *     fallback that returns success because it caught something is the bug, not the fix.
 *   - secret values are redacted from every error string before it reaches a log or the board.
 *     An SMTP error can echo the credential it was handed back at you.
 *
 * Pure functions here, I/O in `deliverToBoard`, so the decision is testable without a network.
 */

const SIGNAL_INTAKE = 'https://xoecpzfsskalvjrtcbbl.supabase.co/functions/v1/signal-intake'

/**
 * Strip any secret VALUE out of text before it is logged or filed.
 *
 * GitHub masks secrets in its own log, but this string also travels to the board, and the local
 * copy of an error is not masked by anything. A redaction that only runs in CI is not a
 * redaction.
 *
 * @param text    any string (an error message, typically)
 * @param secrets values to remove; falsy and very short entries are ignored, because redacting a
 *                1-character "secret" would black out the whole message and hide the diagnosis.
 */
export function redactSecrets(text, secrets = []) {
  let out = String(text ?? '')
  for (const s of secrets) {
    if (typeof s !== 'string' || s.length < 6) continue
    out = out.split(s).join('[redacted]')
  }
  return out
}

/**
 * The one-line reason, in the words of the thing that refused us.
 *
 * A 535 and a connection timeout are different problems with different owners — "the provider
 * rejected our password" vs "we could not reach the provider at all" — and an alarm that says
 * only "send failed" makes a person go and find that out again by hand.
 */
export function classifySendFailure(message) {
  const m = String(message ?? '').toLowerCase()
  if (/\b535\b|invalid login|authentication failed|auth.*fail|not authenticated/.test(m)) {
    return {
      kind: 'refused',
      headline: 'the mail provider REFUSED the credential',
      meaning:
        'The server answered and rejected the login, so the host is reachable and the account is the thing in dispute. This is not proof the stored password is wrong: a suspended, locked-out or expired mailbox answers exactly this to a password it accepted an hour earlier.',
    }
  }
  if (/etimedout|timed out|timeout|econnrefused|ehostunreach|enotfound|econnreset|dns/.test(m)) {
    return {
      kind: 'unreachable',
      headline: 'the mail server could not be reached at all',
      meaning:
        'No answer came back, so nothing was proven about the credential — this is a fact about the network path, not about the password. Do not reset anything on the strength of it.',
    }
  }
  return {
    kind: 'unknown',
    headline: 'the alert email could not be sent',
    meaning: 'The send failed for a reason this check does not recognise; the underlying error is carried verbatim below.',
  }
}

/**
 * Build the signal that replaces the email that could not leave.
 *
 * The failures are embedded rather than linked, because a link is something you have to go and
 * open, and the whole reason we are here is that the push channel is down.
 *
 * @returns a signal-intake body
 */
export function buildUndeliverableSignal({
  subject,
  failures = [],
  runUrl,
  smtpHost,
  smtpUser,
  error,
  secrets = [],
  now = new Date().toISOString(),
}) {
  const safeError = redactSecrets(error, secrets)
  const c = classifySendFailure(safeError)

  // Redact the CARRIED failures too, not just the prose built from them. The first version of
  // this file scrubbed the summary and then attached the raw array to `detail`, which put the
  // credential straight back on the board through the other hand — caught by the leak test, not
  // by reading it.
  const carried = failures.slice(0, 20).map((f) => ({
    ...f,
    project: redactSecrets(f.project ?? '', secrets),
    test: redactSecrets(f.test ?? '', secrets),
    error: redactSecrets(f.error ?? '', secrets),
  }))

  const lines = carried.map((f) => {
    const where = [f.project, f.test].filter(Boolean).join(' — ')
    return `${where || 'unnamed'}: ${f.error}`
  })
  const more = failures.length > lines.length ? ` (+${failures.length - lines.length} more)` : ''

  return {
    source: 'production-monitor',
    key: 'alert-email-undeliverable',
    kind: 'incident',
    // critical AND needs_human together, deliberately: the paging rule is `needs_human AND
    // severity='critical'`, and check-alarm-reachability.mjs treats critical-with-needs_human-
    // false as a contradiction it will file a separate alarm about. A signal saying "you are not
    // being told things" that is itself not allowed to tell anyone is the joke this file exists
    // to avoid being.
    severity: 'critical',
    needs_human: true,
    state: 'open',
    title: 'The monitor found problems and could not email you',
    summary:
      `The hourly monitor tried to send "${subject}" and ${c.headline}. ` +
      `${c.meaning} ` +
      `Because that email never left, this board entry is the only copy of what it said. ` +
      (lines.length
        ? `It was reporting ${failures.length} failure(s)${more}: ${lines.join(' | ')}`
        : 'It carried no per-failure detail.'),
    detail: {
      undelivered_subject: subject,
      failure_count: failures.length,
      failures: carried,
      smtp_host: smtpHost ?? null,
      smtp_user: smtpUser ?? null,
      send_error: safeError,
      send_error_kind: c.kind,
      run_url: runUrl ?? null,
      filed_at: now,
    },
    link: runUrl || 'https://cockpit.predivo.ch/signals',
  }
}

/**
 * Is this `.sendMail(` call actually protected?
 *
 * The first version of this test asked `/try\s*{[\s\S]*?\.sendMail/`, which is not the question:
 * `[\s\S]*?` spans the whole file, so ANY `try {` occurring earlier — a JSON.parse guard at the
 * top, typically — made every mailer look guarded. It reported zero violations on a repo that
 * had twelve, which is the same shape as the 2026-09-02 alarm-step probe that "found" nothing.
 * So this walks braces and answers whether the call is LEXICALLY inside a try block.
 *
 * Deliberately syntactic and deliberately crude: it does not parse JS, so a brace inside a string
 * or a comment can skew it. It is a ratchet, not a type system — it must be hard to pass by
 * accident, and being slightly pessimistic is the safe direction for a guard about silence.
 *
 * @returns array of { index, guarded } for every `.sendMail(` in the source
 */
export function sendMailCallSites(src) {
  const sites = []
  const re = /\.sendMail\s*\(/g
  let m
  while ((m = re.exec(src)) !== null) {
    sites.push({ index: m.index, guarded: isInsideTry(src, m.index) })
  }
  return sites
}

function isInsideTry(src, index) {
  // Walk backwards from the call, tracking brace depth. Every time we close out of a block that
  // we entered from the left (depth goes negative relative to the start), look at what introduced
  // that block: if it is `try`, the call sits inside it.
  let depth = 0
  for (let i = index; i >= 0; i--) {
    const ch = src[i]
    if (ch === '}') depth++
    else if (ch === '{') {
      if (depth === 0) {
        // Found an enclosing block opener. What keyword introduced it?
        const before = src.slice(Math.max(0, i - 12), i)
        if (/\btry\s*$/.test(before)) return true
      } else depth--
    }
  }
  return false
}

/**
 * Every mailer in a scripts directory that can die silently.
 *
 * @param files [{ name, src }]
 * @returns names of files that call sendMail with neither sendOrEscalate nor an enclosing try
 */
export function unguardedMailers(files) {
  const out = []
  for (const { name, src } of files) {
    const sites = sendMailCallSites(src)
    if (sites.length === 0) continue
    if (/sendOrEscalate/.test(src)) continue
    if (sites.every((s) => s.guarded)) continue
    out.push(name)
  }
  return out
}

/**
 * File the signal. Throws on a non-2xx so the caller can report BOTH failures — the board write
 * quietly returning is how a fallback becomes a second silent channel.
 */
export async function deliverToBoard(body, { secret, fetchImpl = fetch, url = SIGNAL_INTAKE } = {}) {
  if (!secret) throw new Error('no board secret available (BOARD_SUPABASE_SECRET / BACKOFFICE_SERVICE_ROLE_KEY)')
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
      'User-Agent': 'alert-fallback/1.0',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`signal-intake -> HTTP ${res.status}: ${text.slice(0, 200)}`)
  }
  return res.json().catch(() => ({}))
}

/**
 * Send, and if the send fails, make the failure audible somewhere that still works.
 *
 * ALWAYS RETHROWS when the mail did not go out. The step must stay red: "we filed it on the
 * board" is a consolation, not a success, and a green step here would mean the next run's dedup
 * treats a never-delivered alert as delivered.
 *
 * @param send      () => Promise<any>  the actual sendMail call
 * @param context   what to say if it fails (see buildUndeliverableSignal)
 * @param deps      { secret, fetchImpl, log, errorLog } — injected for tests
 * @returns { delivered: 'smtp' } on success
 */
export async function sendOrEscalate(send, context, deps = {}) {
  const { secret, fetchImpl, log = console.log, errorLog = console.error } = deps
  try {
    const r = await send()
    return { delivered: 'smtp', result: r }
  } catch (sendErr) {
    const safe = redactSecrets(sendErr?.message ?? sendErr, context.secrets ?? [])
    const body = buildUndeliverableSignal({ ...context, error: safe })

    errorLog(
      `::error title=The monitor could not email you::${body.title} — ${classifySendFailure(safe).headline}. ` +
        `The alert has been filed on the board instead (cockpit.predivo.ch/signals). Underlying send error: ${safe}`,
    )

    let boardError = null
    try {
      await deliverToBoard(body, { secret, fetchImpl })
      log(`Alert could not be emailed; filed to the board as ${body.source}/${body.key} instead.`)
    } catch (e) {
      boardError = redactSecrets(e?.message ?? e, context.secrets ?? [])
      errorLog(
        `::error title=BOTH alert channels are down::The alert email failed (${safe}) AND filing it to the board failed (${boardError}). ` +
          'Nothing has told anyone about this run. This is the loudest this process can be.',
      )
    }

    const err = new Error(
      `alert email undeliverable: ${safe}` + (boardError ? ` — and the board fallback also failed: ${boardError}` : ' — filed to the board instead'),
    )
    err.sendError = safe
    err.boardError = boardError
    err.escalated = boardError === null
    throw err
  }
}
