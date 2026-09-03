/**
 * THE MONITOR'S MAILBOX HAS TWO DOORS, AND A ROTATION KEEPS FIXING ONE OF THEM.
 *
 * -- WHAT IT ENFORCES -----------------------------------------------------------------------
 *
 *     BOTH DOORS OF THE MONITOR MAILBOX MUST OPEN. NOT ONE. BOTH.
 *
 * The mailbox noreply@backoffice.predivo.ch is used twice by this repository: over IMAP to read
 * the OTP mail the product checks depend on, and over SMTP to send the alert that says what those
 * checks found. They are stored under different secret names — IMAP_PASS and SMTP_PASS, with the
 * workflows mapping ALERT_SMTP_PASS onto the latter — so the sending half is one indirection away
 * from the name anybody searches for.
 *
 * -- WHY THIS TEST EXISTS AND NOT A COMMENT --------------------------------------------------
 *
 * On 2026-09-03 the password was reset because the old one was genuinely refused, and the fleet
 * monitor had been dead for roughly twelve hours as a result. The reading half was updated,
 * proven with a real login, and declared fixed. The very next run failed, because the sending
 * half was still stale — the monitor ran, checked 204 things, found problems, and could not tell
 * anybody. `credential-rotation-standard.md` has warned since July that "the rotation verified
 * the KEYS, not the CONSUMERS", and section 3c was written about this same mistake the day
 * before. Reading the warning did not prevent repeating it. Only a machine that tries both doors
 * can prevent it, so this is that machine.
 *
 * -- HOW IT PROVES, AND WHAT IT REFUSES TO DO ------------------------------------------------
 *
 * It attempts a REAL login at each door and requires the protocol's own success token — `a1 OK`
 * for IMAP, `235` for SMTP. It does not read a config file and conclude the value "looks set":
 * that is the class of check this repository spent two days removing, where a green result only
 * proved that a string was present.
 *
 * The secret is never printed, never echoed, never placed on a command line, and never written
 * to disk by this file. It is read into a variable and used. On a failure the test reports the
 * server's refusal line, which contains no secret.
 *
 * -- SKIPPING IS A REPORTED OUTCOME, NOT A SILENT PASS ---------------------------------------
 *
 * With no credential available this test cannot run, and it says so loudly and exits non-zero
 * rather than passing. A test that quietly passes when it could not reach its dependency is the
 * exact defect `a-check-cannot-pass-without-reaching-its-dependency.test.mjs` exists to catch,
 * and this file must not become an instance of it.
 */
import fs from 'node:fs'
import net from 'node:net'
import tls from 'node:tls'

const HOST = process.env.IMAP_HOST || 'tertia.sui-inter.net'
const USER = process.env.IMAP_USER || 'noreply@backoffice.predivo.ch'
const CRED = 'C:/Business/Internal Projects/BackOffice/docs/Credentials.txt'

/** CI supplies the secrets; a developer machine falls back to the gitignored record. */
function secret(kind) {
  const fromEnv = kind === 'imap'
    ? process.env.IMAP_PASS
    : (process.env.SMTP_PASS || process.env.ALERT_SMTP_PASS)
  if (fromEnv) return { value: fromEnv, from: 'environment' }
  if (!fs.existsSync(CRED)) return null
  const lines = fs.readFileSync(CRED, 'utf8').split(/\r?\n/)
  const anchor = lines.findIndex((l) => l.toLowerCase().includes(USER.toLowerCase()))
  if (anchor < 0) return null
  for (let i = Math.max(0, anchor - 3); i < Math.min(lines.length, anchor + 9); i++) {
    const m = lines[i].match(/^\s*(?:pass|passwort|password|pw)\s*[:=]\s*(\S+)/i)
    if (m) return { value: m[1], from: 'local record' }
  }
  return null
}

function imapLogin(pw) {
  return new Promise((res) => {
    const s = tls.connect({ host: HOST, port: 993, servername: HOST, timeout: 20000 }, () => {})
    let buf = ''; let stage = 0
    s.on('data', (d) => {
      buf += d.toString()
      if (stage === 0 && /^\* OK/m.test(buf)) { stage = 1; buf = ''; s.write('a1 LOGIN "' + USER + '" "' + pw + '"\r\n') }
      else if (stage === 1 && /^a1 (OK|NO|BAD)/m.test(buf)) {
        const ok = /^a1 OK/m.test(buf)
        const line = (buf.match(/^a1 (?:NO|BAD).*/m) || [''])[0].trim().slice(0, 90)
        s.end(); res({ ok, detail: ok ? 'a1 OK' : line })
      }
    })
    s.on('error', (e) => res({ ok: false, detail: 'socket ' + e.code }))
    s.on('timeout', () => { s.destroy(); res({ ok: false, detail: 'timeout' }) })
  })
}

function smtpLogin(pw, port, useTls) {
  return new Promise((res) => {
    const sock = useTls
      ? tls.connect({ host: HOST, port, servername: HOST, timeout: 20000 }, () => {})
      : net.connect({ host: HOST, port, timeout: 20000 }, () => {})
    let stage = 0
    const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')
    sock.on('data', (d) => {
      const t = d.toString()
      if (stage === 0 && /^220/m.test(t)) { stage = 1; sock.write('EHLO monitor.local\r\n') }
      else if (stage === 1 && /^250/m.test(t)) { stage = 2; sock.write('AUTH LOGIN\r\n') }
      else if (stage === 2 && /^334/m.test(t)) { stage = 3; sock.write(b64(USER) + '\r\n') }
      else if (stage === 3 && /^334/m.test(t)) { stage = 4; sock.write(b64(pw) + '\r\n') }
      else if (stage === 4) {
        const ok = /^235/m.test(t)
        sock.end(); res({ ok, detail: ok ? '235 accepted' : t.trim().split('\n')[0].slice(0, 90) })
      }
    })
    sock.on('error', (e) => res({ ok: false, detail: 'socket ' + e.code }))
    sock.on('timeout', () => { sock.destroy(); res({ ok: false, detail: 'timeout' }) })
  })
}

const failures = []

const readDoor = secret('imap')
if (!readDoor) {
  failures.push('READ door: no credential available from the environment or the local record — ' +
    'this test could not run, which is a failure and not a pass')
} else {
  const r = await imapLogin(readDoor.value)
  console.log(`  read door  (IMAP 993)  -> ${r.ok ? 'OPEN' : 'REFUSED'}  [${r.detail}]  via ${readDoor.from}`)
  if (!r.ok) failures.push('READ door refused: ' + r.detail)
}

const sendDoor = secret('smtp')
if (!sendDoor) {
  failures.push('SEND door: no credential available from the environment or the local record — ' +
    'this test could not run, which is a failure and not a pass')
} else {
  let r = await smtpLogin(sendDoor.value, 465, true)
  if (!r.ok) { const alt = await smtpLogin(sendDoor.value, 587, false); if (alt.ok) r = alt }
  console.log(`  send door  (SMTP 465)  -> ${r.ok ? 'OPEN' : 'REFUSED'}  [${r.detail}]  via ${sendDoor.from}`)
  if (!r.ok) failures.push('SEND door refused: ' + r.detail)
}

if (failures.length) {
  console.error('\nthe-monitor-mailbox-has-two-doors: FAILED')
  for (const f of failures) console.error('  - ' + f)
  console.error('\nBoth doors use the SAME mailbox password under DIFFERENT secret names.')
  console.error('Fixing one and not the other is how the fleet went quiet for twelve hours on 2026-09-03.')
  console.error('See credential-rotation-standard.md section 3d.')
  process.exit(1)
}
console.log('\nthe-monitor-mailbox-has-two-doors: both doors open (2 assertions)')
