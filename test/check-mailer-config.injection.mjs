/**
 * DEFECT INJECTION for check-mailer-config.mjs.
 *
 * A guard proven by reading its source is not proven. Each case below breaks the fleet in one
 * of the exact ways it has actually broken, runs the real checker against the real live
 * systems, and asserts the checker goes red with the right sentence. Then it puts everything
 * back and proves the restore by DIGEST, because "I restored it" is not a receipt.
 *
 * Run: node test/check-mailer-config.injection.mjs      (exit 0 = every defect was caught)
 * Needs the same environment as the checker, plus write access to the arivioo staging project.
 *
 * WHAT IT TOUCHES, and why that is safe:
 *   - It mutates SMTP_HOST / SMTP_PORT / SMTP_USER on arivioo STAGING only
 *     (xyqdyqpdjugevjmjbcdp). Never production, never SMTP_PASS, never another product.
 *     arivioo staging sends only when a test drives it, so the couple of minutes it spends
 *     mis-configured has no audience. The originals are captured first, restored in a finally
 *     block, and re-read and compared as sha256 digests at the end.
 *   - Everything else is injected without touching any live system at all: a copy of a product's
 *     source in a temp directory, and a copy of the baseline with one field changed.
 */
import assert from 'node:assert'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync, cpSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(HERE, '..')
const CHECKER = path.join(REPO, 'scripts', 'check-mailer-config.mjs')
const BASELINE = path.join(REPO, 'scripts', 'lib', 'mailer-baseline.json')
const SRC_ROOT = process.env.MAILER_SRC_ROOT || 'C:\\Business\\Internal Projects'

const STAGING_REF = 'xyqdyqpdjugevjmjbcdp' // arivioo staging - the only project this file writes to
const TOKEN = process.env.SUPABASE_TOKEN_ARIVIOO

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex')
const scratch = mkdtempSync(path.join(tmpdir(), 'mailer-injection-'))

let passed = 0
let failed = 0

/** Run the real checker and return { code, out }. */
function runChecker(env = {}, nodeArgs = []) {
  try {
    const out = execFileSync('node', [...nodeArgs, CHECKER], {
      cwd: scratch,
      encoding: 'utf-8',
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, out }
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout || ''}${err.stderr || ''}` }
  }
}

/** Assert the checker went red AND said the specific thing we injected. */
function expectCaught(name, result, phrase) {
  try {
    assert.notEqual(result.code, 0, 'the checker exited 0 - it did NOT catch the injected defect')
    assert.ok(result.out.includes(phrase), `the checker went red but never said "${phrase}"`)
    console.log(`  ok   - ${name}`)
    passed++
  } catch (err) {
    console.log(`  FAIL - ${name}: ${err.message}`)
    const lines = result.out.split('\n').filter((l) => /\*\*\*|FAIL/.test(l)).slice(0, 6)
    for (const l of lines) console.log(`         | ${l.trim()}`)
    failed++
  }
}

async function secrets(ref) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/secrets`, { headers: { Authorization: `Bearer ${TOKEN}` } })
  if (!res.ok) throw new Error(`secrets read HTTP ${res.status}`)
  return new Map((await res.json()).map((s) => [s.name, s.value]))
}

async function setSecret(ref, name, value) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/secrets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([{ name, value }]),
  })
  if (!res.ok) throw new Error(`set ${name} HTTP ${res.status}: ${await res.text()}`)
}

async function deleteSecret(ref, name) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/secrets`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([name]),
  })
  if (!res.ok) throw new Error(`delete ${name} HTTP ${res.status}: ${await res.text()}`)
}

/** A copy of the real baseline with one environment's fields overridden. */
function baselineWith(product, envName, patch, file) {
  const j = JSON.parse(readFileSync(BASELINE, 'utf-8'))
  const p = j.products.find((x) => x.product === product)
  const e = p.envs.find((x) => x.env === envName)
  Object.assign(e, patch)
  const out = path.join(scratch, file)
  writeFileSync(out, JSON.stringify(j, null, 2))
  return out
}

console.log('Defect injection against check-mailer-config.mjs\n')

// ─────────────────────────────────────────────────────────────────────────────
// Injections that touch NOTHING live: a copied source tree, a copied baseline
// ─────────────────────────────────────────────────────────────────────────────

console.log('Source and baseline injections (no live system is modified):')

// 1. A SECOND MAILER APPEARS. The 2026-08-20 BackOffice outage: a second file quietly reads
//    the first mailer's variables and follows every change made for it.
{
  // A full copy of every product's functions tree, so the other seven still evaluate normally
  // and only Valrano carries the injected defect.
  const root = path.join(scratch, 'src-second-reader')
  for (const dir of ['arivioo', 'BackOffice', 'ChannelMover', 'Distribution-OS', 'replyflow', 'ScoutCopilot', 'signalscore', 'Valrano']) {
    cpSync(path.join(SRC_ROOT, dir, 'supabase', 'functions'), path.join(root, dir, 'supabase', 'functions'), { recursive: true })
  }
  const intruder = path.join(root, 'Valrano', 'supabase', 'functions', 'send-invoice', 'index.ts')
  mkdirSync(path.dirname(intruder), { recursive: true })
  writeFileSync(intruder, [
    "// Injected defect: a second mailer helping itself to the shared mailer's variables.",
    "const host = Deno.env.get('SMTP_HOST')",
    "const port = Number(Deno.env.get('SMTP_PORT'))",
    "const conn = await Deno.connectTls({ hostname: host, port })",
  ].join('\n'))
  const r = runChecker({ MAILER_SRC_ROOT: root })
  expectCaught('a SECOND mailer appears that reads another mailer\'s SMTP_* variables', r, 'a SECOND mailer reading another mailer\'s variables')
}

// 2. A DORMANT ENVIRONMENT GROWS A MAILER. Declaring arivioo staging dormant while it plainly
//    carries mailer secrets is the same shape as somebody setting secrets on a project that is
//    not supposed to send.
{
  const bl = baselineWith('arivioo', 'staging', { config: 'dormant', configNote: 'injected: declared dormant while it has secrets' }, 'baseline-dormant.json')
  const r = runChecker({ MAILER_BASELINE: bl })
  expectCaught('an environment declared dormant has grown a mailer', r, 'a dormant environment has grown a mailer')
}

// 3. THE MAILER IS NOT CONFIGURED AT ALL. Distribution-OS staging genuinely has no mailer
//    secrets; declaring it as an environment that must send reproduces the arivioo production
//    failure of 2026-08-24 against the real, live, empty project.
{
  const bl = baselineWith('Distribution-OS', 'staging', { config: 'required' }, 'baseline-unconfigured.json')
  const r = runChecker({ MAILER_BASELINE: bl })
  expectCaught('an environment that must send has no mailer secrets at all', r, 'the mailer is not configured at all')
}

// 4. IT HAS SENT NOTHING RECENTLY. Real Postmark history, a budget short enough that the real
//    last-send breaches it.
{
  const bl = baselineWith('ChannelMover', 'production', { maxSilenceHours: 1 }, 'baseline-silent.json')
  const r = runChecker({ MAILER_BASELINE: bl })
  expectCaught('a mailer that should be sending has sent nothing recently', r, 'it has sent nothing recently')
}

// 5. ITS SENDING UNIT IS GONE. A product pointed at a Postmark server that does not exist.
{
  const bl = baselineWith('replyflow', 'production', { postmarkServer: 'ReplyFlow-that-was-deleted' }, 'baseline-noserver.json')
  const r = runChecker({ MAILER_BASELINE: bl })
  expectCaught('the product\'s Postmark server has disappeared', r, 'its Postmark server is gone')
}

// 5b. POSTMARK HISTORY UNREADABLE. A blank or rotated account token means the checker can read
//     NO product's Postmark send history. Before 2026-08-25 that was a single fleet-level WARN
//     and the whole 'did it send' block was gated on `&& pm.servers`, so the run stayed green and
//     the four postmark products went unchecked - the exact silent-BackOffice shape this guard
//     exists to catch. Now every postmark environment must go red as unaudited. Injected with a
//     bogus token, so no live system is touched.
{
  const r = runChecker({ POSTMARK_ACCOUNT_TOKEN: 'injection-not-a-real-postmark-token' })
  expectCaught('an unreadable Postmark account token makes every postmark product unaudited, not OK', r, 'its send history could not be read')
}

// 5c. A SINGLE SERVER'S OUTBOUND HISTORY IS UNREADABLE. 91e053b fixed the ACCOUNT-level unreadable
//     case (5b) but left the PER-SERVER case as a warn(): when the account list reads fine but ONE
//     product's Postmark server answers the outbound-history fetch with a non-2xx (a rotated or
//     revoked server token -> 401, or a 429 partway through the sequential loop), the guard could
//     not prove THAT product sent, yet exited 0 and dropped its row - the exact silent-BackOffice
//     shape one level below where 5b caught it. Injected with a fetch shim (run via `node --import`
//     in the checker's own subprocess) that lets the live account list and every other server
//     through untouched and fails ONLY the ChannelMover server's outbound fetch, so exactly one
//     product must go red as unaudited while the rest of the fleet stays green. No live system is
//     modified - the shim only rewrites one HTTP response in memory.
{
  const shim = path.join(scratch, 'postmark-oneserver-fault.mjs')
  writeFileSync(shim, [
    "// Test-only fetch shim. Fails ONLY the target Postmark server's outbound-history fetch.",
    "const TARGET = process.env.POSTMARK_FAULT_SERVER",
    "const realFetch = globalThis.fetch",
    "const targetTokens = new Set()",
    "globalThis.fetch = async (url, opts = {}) => {",
    "  const u = typeof url === 'string' ? url : url.url",
    "  if (u.includes('/servers')) {",
    "    // Pass the live server list through, but capture the target server's API token.",
    "    const res = await realFetch(url, opts)",
    "    const text = await res.text()",
    "    try { for (const s of (JSON.parse(text).Servers || [])) if (s.Name === TARGET) for (const t of (s.ApiTokens || [])) targetTokens.add(t) } catch {}",
    "    // Tell the parent test whether the LIVE account list actually yielded the target server's",
    "    // token. If it did not (token absent/rotated/rate-limited, or the server is gone), the",
    "    // per-server branch can never be reached and 5c must report a SKIPPED test, not a pass.",
    "    if (targetTokens.size) console.error('__5C_SHIM_CAPTURED_TARGET__')",
    "    return new Response(text, { status: res.status, headers: { 'content-type': 'application/json' } })",
    "  }",
    "  if (u.includes('/messages/outbound')) {",
    "    const h = opts.headers || {}",
    "    const tok = h['X-Postmark-Server-Token'] || h['x-postmark-server-token']",
    "    if (tok && targetTokens.has(tok)) return new Response('{\"Message\":\"injected 401\"}', { status: 401, headers: { 'content-type': 'application/json' } })",
    "  }",
    "  return realFetch(url, opts)",
    "}",
  ].join('\n'))
  const r = runChecker({ POSTMARK_FAULT_SERVER: 'ChannelMover' }, ['--import', pathToFileURL(shim).href])
  // 5c must DISCRIMINATE the per-server branch, not just see the phrase. The account-level branch
  // (5b) and the per-server branch emit the byte-identical 'its send history could not be read',
  // so asserting only that phrase (as this case used to via expectCaught) passes even when the
  // shim never captured the target token and the ACCOUNT-level branch fired for ALL FOUR postmark
  // products - the per-server branch this case exists to prove is then never reached and the
  // regression ships green. The tell that ISOLATES the per-server branch: exactly ONE product goes
  // unaudited for unreadable send history (ChannelMover), whereas the account-level branch takes
  // replyflow/signalscore/BackOffice down with it (four occurrences of the phrase, not one).
  const name5c = 'one product\'s Postmark server outbound history answers non-2xx (per-server unreadable)'
  try {
    assert.ok(r.out.includes('__5C_SHIM_CAPTURED_TARGET__'),
      'the shim never captured ChannelMover\'s server token (POSTMARK_ACCOUNT_TOKEN absent/rotated/rate-limited, or the account list did not return the ChannelMover server), so the per-server branch was never exercised - reporting a SKIPPED test as a fail rather than a silent pass')
    assert.notEqual(r.code, 0, 'the checker exited 0 - it did NOT catch the per-server unreadable defect')
    const unreadable = (r.out.match(/its send history could not be read/g) || []).length
    assert.equal(unreadable, 1,
      `expected exactly ONE product unaudited for unreadable send history (the per-server branch); got ${unreadable}. More than one means the ACCOUNT-level branch fired (the 5b scenario) and the per-server branch was never reached - the byte-identical-phrase trap this case exists to catch.`)
    assert.match(r.out, /ChannelMover\/production: unaudited/,
      'the single unaudited product is not ChannelMover/production, so the per-server fault did not isolate to the target server')
    console.log(`  ok   - ${name5c}`)
    passed++
  } catch (err) {
    console.log(`  FAIL - ${name5c}: ${err.message}`)
    const lines = r.out.split('\n').filter((l) => /\*\*\*|FAIL/.test(l)).slice(0, 6)
    for (const l of lines) console.log(`         | ${l.trim()}`)
    failed++
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Injections against the LIVE arivioo staging project - captured, broken, restored, verified
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nLive-secret injections on arivioo STAGING (captured, broken, restored, digest-verified):')

const ORIGINAL_PLAINTEXT = {
  SMTP_HOST: 'tertia.sui-inter.net',
  SMTP_PORT: '465',
  SMTP_USER: 'staging-noreply@arivioo.com',
}

let before
try {
  before = await secrets(STAGING_REF)
  // Refuse to run at all unless the values we are about to restore are provably the ones that
  // are live right now. Restoring a guess would be worse than never testing.
  for (const [name, plain] of Object.entries(ORIGINAL_PLAINTEXT)) {
    assert.equal(before.get(name), sha256(plain), `${name} on arivioo staging is not the value this test knows how to restore - aborting without touching anything`)
  }

  // 6. IMPLICIT TLS ON A PORT THAT DOES NOT SPEAK IT. The exact 2026-08-20 BackOffice defect:
  //    the port moves to a STARTTLS port while the client still opens the socket with tls:true.
  await setSecret(STAGING_REF, 'SMTP_PORT', '587')
  expectCaught('the port is moved to 587 under an implicit-TLS client', runChecker(), 'implicit TLS on a port that does not speak it')
  await setSecret(STAGING_REF, 'SMTP_PORT', ORIGINAL_PLAINTEXT.SMTP_PORT)

  // 7. POSTMARK ON THE IMPLICIT-TLS PORT. Postmark has no 465 listener at all, so this is dead
  //    on arrival however correct it looks.
  await setSecret(STAGING_REF, 'SMTP_HOST', 'smtp.postmarkapp.com')
  expectCaught('the host is moved to Postmark while the port stays 465', runChecker(), 'no implicit-TLS listener')
  await setSecret(STAGING_REF, 'SMTP_HOST', ORIGINAL_PLAINTEXT.SMTP_HOST)

  // 8. A PORT THAT IS NOT A MAIL PORT. Catches a typo that no TLS rule would notice.
  await setSecret(STAGING_REF, 'SMTP_PORT', '4655')
  expectCaught('the port is a typo that is not a mail port at all', runChecker(), 'the mail port is not a mail port')
  await setSecret(STAGING_REF, 'SMTP_PORT', ORIGINAL_PLAINTEXT.SMTP_PORT)

  // 9. ONE SECRET REMOVED. Half a configuration is the quietest failure of the four: the
  //    remaining values look right in every dashboard.
  await deleteSecret(STAGING_REF, 'SMTP_USER')
  expectCaught('one of the four mailer secrets is removed', runChecker(), 'part of the mailer configuration is missing')
  await setSecret(STAGING_REF, 'SMTP_USER', ORIGINAL_PLAINTEXT.SMTP_USER)
} finally {
  // Restore is not a claim, it is a comparison. Put every value back and prove the digests match
  // what was live before this file ran.
  if (before) {
    for (const [name, plain] of Object.entries(ORIGINAL_PLAINTEXT)) await setSecret(STAGING_REF, name, plain)
    const after = await secrets(STAGING_REF)
    console.log('\nRestore verification (sha256 digests read back from the live project):')
    let clean = true
    for (const name of [...before.keys()].filter((k) => /SMTP_/.test(k))) {
      const same = before.get(name) === after.get(name)
      if (!same) clean = false
      console.log(`  ${same ? 'ok  ' : 'DIFF'} - ${name}`)
    }
    if (!clean) { console.log('\narivioo staging was NOT restored to its original state - fix this before doing anything else.'); failed++ }
  }
}

// 10. AND THE HEALTHY FLEET IS STILL GREEN. A guard that fails on everything is not a guard.
{
  const r = runChecker()
  if (r.code === 0) { console.log('\n  ok   - the untouched fleet passes'); passed++ }
  else { console.log('\n  FAIL - the untouched fleet is red after the injections were reverted'); console.log(r.out.slice(-1500)); failed++ }
}

console.log(`\n${passed} caught, ${failed} missed.`)
process.exit(failed ? 1 : 0)
