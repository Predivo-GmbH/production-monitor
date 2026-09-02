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
 * Lives in scripts/lib as plain JS, not inside lib/imap.ts, for one reason: it is the
 * part with the judgement in it, and here a test can execute it in both directions.
 * A guard that only ever runs the passing case is not a guard.
 */

export class MailboxUnreachableError extends Error {
  constructor(message, cause) {
    super(message)
    this.name = 'MailboxUnreachableError'
    this.reason = cause instanceof Error ? cause.message : String(cause ?? 'unknown')
  }
}

/**
 * The single place that turns a waitForOtpEmail() failure into words a human acts on.
 * Every OTP spec routes its catch here, so the wording is fixed once rather than in
 * five copies - which is what let the wrong sentence survive in all five at once.
 */
export function describeOtpFailure(err, project) {
  if (err instanceof MailboxUnreachableError) {
    return (
      `MONITOR FAULT - cannot verify ${project} OTP delivery: the monitor could not read its own ` +
      `test mailbox, so it never looked. This is NOT evidence that ${project} failed to send the ` +
      `email, and ${project}'s send chain should not be touched on the strength of this line. ` +
      `Fix the monitor's mailbox access: repo secrets IMAP_HOST / IMAP_USER / IMAP_PASS, and the ` +
      `mailbox itself at the mail provider. Underlying IMAP error: ${err.reason}`
    )
  }
  return (
    `${project} OTP email NOT delivered: the test mailbox was readable and stayed empty for 90s - ` +
    `send-auth-email chain is broken. ` +
    `Check: pg_net Authorization header, edge function signature guard, SMTP credentials.`
  )
}
