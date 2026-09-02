// ============================================================
// ImapFlow UID consistency rule — READ BEFORE EDITING
// ------------------------------------------------------------
// ImapFlow methods take { uid: true } in DIFFERENT positions:
//   search(criteria, OPTIONS)        → 2nd arg (2 params)
//   fetchOne(range, query, OPTIONS)  → 3rd arg (3 params)
//   messageDelete(range, OPTIONS)    → 2nd arg (2 params)
//
// If you change ANY IMAP call, verify ALL calls agree on UID
// vs sequence mode. Putting uid:true in fetchOne's 2nd arg
// silently treats UIDs as sequence numbers — works by accident
// when UIDs are small, then breaks as UIDs grow past message
// count. Use fetchOneByUid() below to avoid this entirely.
// ============================================================
import { ImapFlow } from 'imapflow'
// The fault-attribution rules live in plain JS so test/imap-fault-attribution.test.mjs
// can execute them in BOTH directions. Re-exported here so specs have one import.
// @ts-ignore -- plain-JS sibling module, no .d.ts by design
import { MailboxUnreachableError, describeOtpFailure } from '../scripts/lib/otp-failure.mjs'
export { MailboxUnreachableError, describeOtpFailure }

interface ImapConfig {
  host: string
  port: number
  user: string
  pass: string
}

interface ParsedOtpEmail {
  otp: string | null
  confirmationLink: string | null
  subject: string
  from: string
  date: Date
}

/**
 * Connects to an IMAP mailbox and waits for a new email containing an OTP code.
 * Polls every second for up to `timeoutMs` milliseconds.
 * Returns the OTP code and any confirmation link found in the email body.
 *
 * When `subjectFilter` is provided, only emails whose subject contains that
 * string are considered. This prevents race conditions when multiple projects
 * share the same IMAP inbox and run OTP tests concurrently.
 *
 * TWO failures live here and they mean opposite things — never merge them:
 *   MailboxUnreachableError → we could not read the inbox. Says nothing about the product.
 *   Error('No OTP email received…') → the inbox WAS readable and stayed empty. Real signal.
 * The second is only ever thrown after at least one search has actually completed,
 * so "the email never arrived" is a measured claim rather than an assumption.
 */
export async function waitForOtpEmail(
  config: ImapConfig,
  opts: { timeoutMs?: number; deleteAfter?: boolean; subjectFilter?: string } = {},
): Promise<ParsedOtpEmail> {
  const { timeoutMs = 30_000, deleteAfter = true, subjectFilter } = opts

  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: true,
    auth: { user: config.user, pass: config.pass },
    logger: false,
  })

  try {
    try {
      await client.connect()
    } catch (err) {
      // Connect/login failed. This takes ~2s, so the caller's old "not delivered
      // within 90s" message was not merely misattributed, it was arithmetically
      // impossible — the run had not waited 90s for anything.
      throw new MailboxUnreachableError(
        `IMAP connect/login to ${config.host} failed — the monitor cannot read its own test mailbox`,
        err,
      )
    }
    const deadline = Date.now() + timeoutMs

    // Proven only by a search that actually returned. Until then we have no
    // standing to say anything about what is or is not in the inbox.
    let mailboxProven = false
    let lastPollError: unknown = null

    while (Date.now() < deadline) {
      // getMailboxLock was outside the try: when it threw, `lock` was undefined and
      // the handler's own `lock.release()` raised a TypeError that escaped as if it
      // were the email verdict.
      let lock: { release: () => void } | null = null
      try {
        lock = await client.getMailboxLock('INBOX')
        // Search for messages — filter by subject when provided
        const searchCriteria: Record<string, unknown> = {}
        if (subjectFilter) {
          searchCriteria.subject = subjectFilter
        }
        const uids = await client.search(searchCriteria, { uid: true })
        mailboxProven = true

        if (uids.length === 0) {
          lock.release()
          lock = null
          await sleep(1000)
          continue
        }

        // Fetch the latest matching message (highest UID)
        const latestUid = uids[uids.length - 1]
        const msg = await fetchOneByUid(client, latestUid, {
          envelope: true,
          source: true,
        })

        if (!msg?.source) {
          lock.release()
          lock = null
          await sleep(1000)
          continue
        }

        const rawEmail = msg.source.toString()
        const subject = msg.envelope?.subject || ''
        const from = msg.envelope?.from?.[0]?.address || ''
        const date = msg.envelope?.date || new Date()

        // Extract 6-digit OTP from subject or body
        const otpMatch = rawEmail.match(/\b(\d{6})\b/)
        const otp = otpMatch ? otpMatch[1] : null

        // Extract confirmation link (any URL containing /auth/v1/verify or token)
        const linkMatch = rawEmail.match(/https?:\/\/[^\s"<>]+(?:verify|confirm|callback)[^\s"<>]*/i)
        const confirmationLink = linkMatch ? decodeHtmlEntities(linkMatch[0]) : null

        // Delete only this message after reading
        if (deleteAfter) {
          await client.messageDelete(String(latestUid), { uid: true })
        }

        lock.release()
        lock = null
        return { otp, confirmationLink, subject, from, date }
      } catch (err) {
        lastPollError = err
        try { lock?.release() } catch { /* lock already gone with the connection */ }
        await sleep(1000)
      }
    }

    if (!mailboxProven) {
      // Connected, but not one search ever completed — the session died, the mailbox
      // is not selectable, or every poll errored. We still never saw the inbox.
      throw new MailboxUnreachableError(
        `IMAP mailbox on ${config.host} never became readable within ${timeoutMs}ms`,
        lastPollError,
      )
    }

    throw new Error(`No OTP email received within ${timeoutMs}ms`)
  } finally {
    await client.logout().catch(() => {})
  }
}

/**
 * Clears all messages in the INBOX (used before tests to start fresh).
 */
export async function clearInbox(config: ImapConfig): Promise<number> {
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: true,
    auth: { user: config.user, pass: config.pass },
    logger: false,
  })

  try {
    await client.connect()
    const lock = await client.getMailboxLock('INBOX')
    try {
      const status = await client.status('INBOX', { messages: true })
      if (status.messages > 0) {
        await client.messageDelete('1:*')
      }
      lock.release()
      return status.messages
    } catch {
      lock.release()
      return 0
    }
  } finally {
    await client.logout().catch(() => {})
  }
}

/**
 * Safe wrapper: always fetches by UID (3rd arg), never sequence number.
 * Prevents the bug where uid:true in the 2nd arg is silently ignored.
 */
function fetchOneByUid(client: ImapFlow, uid: number, query: { envelope?: boolean; source?: boolean }) {
  return client.fetchOne(String(uid), query, { uid: true })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}
