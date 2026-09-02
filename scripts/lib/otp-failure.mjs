/**
 * How an OTP-email check reports the two ways it can fail.
 *
 * These two sentences mean opposite things and for months the monitor printed only
 * the second one:
 *
 *   MailboxUnreachableError  the monitor could not READ its own test mailbox.
 *                            A fact about the monitor. Says nothing about the product.
 *   anything else            the mailbox WAS readable and the email never arrived.
 *                            A fact about the product's send chain.
 *
 * On 2026-09-02 at 20:18 UTC the shared OTP inbox started answering
 * `[AUTHENTICATIONFAILED] Authentication failed` to every login. `waitForOtpEmail`
 * threw at connect, ~2 seconds in, and all five specs caught it with a bare `catch {}`
 * and printed "OTP email NOT delivered within 90s - send-auth-email chain is broken.
 * Check: pg_net Authorization header, edge function signature guard, SMTP credentials."
 * Four products (ReplyFlow, SignalScore, Valrano, ChannelMover) were named broken by a
 * check that had not waited 90s and had not looked in any inbox. The one step that knew
 * the truth - the workflow's inbox pre-clear - was `continue-on-error: true`.
 *
 * 2026-09-03: the same lockout was still live, and the four MONITOR FAULT lines ended
 * `Underlying IMAP error: Command failed` - which names nothing. ImapFlow builds every
 * rejected IMAP command as `new Error('Command failed')` (imap-flow.js:747) and hangs the
 * actual diagnosis on OTHER properties. Measured against a real IMAP server this turn:
 *     err.message               "Command failed"
 *     err.response              "3 NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)"
 *     err.serverResponseCode    "AUTHENTICATIONFAILED"
 *     err.authenticationFailed  true
 * Reading only `.message` collapses "your password is refused", "the mail host is
 * throttling us" and "the mailbox is full" into one identical sentence - and those need
 * three different people doing three different things. In run 33691549820 the workflow's
 * own Python pre-clear step printed `[AUTHENTICATIONFAILED] Authentication failed.` for
 * the same mailbox in the same run, so that run held both the answer and the shrug, and
 * which one Roger saw depended on which step he opened.
 *
 * The guard that was supposed to prevent this (case 2, "the real IMAP error survives into
 * the message") passed the entire time, because its fixture was
 * `new Error('[AUTHENTICATIONFAILED] ...')` - an error whose `.message` already carried
 * the text. It asserted on a shape the library never produces. A fixture built to your own
 * expectation tests the expectation, not the library.
 *
 * NEVER surface `err.executedCommand` from here: that is the compiled LOGIN line.
 *
 * Lives in scripts/lib as plain JS, not inside lib/imap.ts, for one reason: it is the
 * part with the judgement in it, and here a test can execute it in both directions.
 * A guard that only ever runs the passing case is not a guard.
 */

/**
 * The sentence a human can act on, pulled off whichever property actually holds it.
 *
 * Order matters: `response` is the full tagged server line and is the most specific thing
 * available; `responseText` is the same minus the tag; `.message` comes last, because for
 * the entire NO/BAD family it is the constant string "Command failed".
 */
export function imapCauseText(cause) {
  if (cause == null) return 'unknown'
  if (!(cause instanceof Error)) return String(cause)

  const server = firstString(cause.response, cause.responseText)
  const code = firstString(cause.serverResponseCode, cause.code)

  // A DNS/TCP/TLS failure never reaches an IMAP command, so it has no server line at all;
  // there its own message IS the diagnosis and the errno is the part worth leading with.
  const base = server || firstString(cause.message) || 'unknown'

  const text = code && !base.includes(code) ? `${code}: ${base}` : base
  return text.length > 300 ? `${text.slice(0, 300)}...` : text
}

function firstString(...vals) {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

/**
 * Did the mail server ANSWER and refuse us, or did we never get an answer at all?
 * These two lead to opposite actions - reset the password vs. do not touch the password -
 * so they must never share a sentence.
 */
export function isCredentialRejection(cause) {
  if (!(cause instanceof Error)) return false
  if (cause.authenticationFailed === true) return true
  return /AUTHENTICATIONFAILED|AUTHORIZATIONFAILED/i.test(
    `${cause.serverResponseCode ?? ''} ${cause.response ?? ''} ${cause.responseText ?? ''} ${cause.message ?? ''}`,
  )
}

export class MailboxUnreachableError extends Error {
  constructor(message, cause) {
    super(message)
    this.name = 'MailboxUnreachableError'
    this.reason = imapCauseText(cause)
    // Kept apart from `reason` so the wording can name ONE action, instead of asking Roger
    // to go and check three secrets and a mail provider on every kind of failure.
    this.credentialsRejected = isCredentialRejection(cause)
  }
}

/**
 * The single place that turns a waitForOtpEmail() failure into words a human acts on.
 * Every OTP spec routes its catch here, so the wording is fixed once rather than in
 * five copies - which is what let the wrong sentence survive in all five at once.
 */
export function describeOtpFailure(err, project) {
  if (err instanceof MailboxUnreachableError) {
    const action = err.credentialsRejected
      ? `The mail server ANSWERED and REFUSED the monitor's login, so the host and the mailbox are ` +
        `both reachable and only the password is not accepted: reset it at the mail provider, then ` +
        `put the new value in the repo secret IMAP_PASS.`
      : `The monitor never got as far as a REFUSED login, so this is not a wrong password and ` +
        `resetting one will not clear it: check IMAP_HOST / IMAP_PORT, whether the mail host is ` +
        `reachable and answering, and whether the mailbox is throttled, full or locked.`

    return (
      `MONITOR FAULT - cannot verify ${project} OTP delivery: the monitor could not read its own ` +
      `test mailbox, so it never looked. This is NOT evidence that ${project} failed to send the ` +
      `email, and ${project}'s send chain should not be touched on the strength of this line. ` +
      `${action} Underlying IMAP error: ${err.reason}`
    )
  }
  return (
    `${project} OTP email NOT delivered: the test mailbox was readable and stayed empty for 90s - ` +
    `send-auth-email chain is broken. ` +
    `Check: pg_net Authorization header, edge function signature guard, SMTP credentials.`
  )
}
