#!/usr/bin/env node
/**
 * A CUSTOMER EMAILED THE SAME THING TWICE MUST REACH ROGER. Until now nothing read the warning.
 *
 * ── THE EVENT THIS WATCHES ──────────────────────────────────────────────────────────────────
 * ChannelMover's `lifecycle-tick` (supabase/functions/lifecycle-tick/index.ts) decides who gets a
 * lifecycle email. On 2026-08-25 `noelle@banek.net` — the only customer who has ever completed a
 * migration — received "Did everything arrive?" twice, because production was running a build
 * WITHOUT the once-per-person guard (ChannelMover/docs/INCIDENTS.md, first entry). It was found
 * hours later, by hand, by counting rows in a ledger.
 *
 * The fix added an OBSERVABILITY BACKSTOP: whenever the tick sends the same account-level step to
 * the same person a second time on one UTC day, it emits
 *
 *     console.warn(`[lifecycle-tick] WARNING: duplicate account-level step "<step>" sent to
 *                   <email> (user <id>) a second time on <YYYY-MM-DD>; ... This is the signature
 *                   of a stale deploy of lifecycle-tick.`)
 *
 * and returns the same text in the response body as `warnings[]`. It changes no send behaviour —
 * it only observes. But an observer nobody observes is just a slower version of the ledger count.
 * This script is the reader.
 *
 * ── WHICH SURFACE, AND WHY (brief step 1) ───────────────────────────────────────────────────
 * The warning is emitted to TWO surfaces: the HTTP response body (`warnings[]`) and the edge logs
 * (`console.warn` -> the `function_logs` source). This check watches the LOGS. The reason is not
 * preference, it is mechanism:
 *
 *   * The tick is invoked by pg_cron via `net.http_post` every 5 minutes (migration
 *     20260824002_lifecycle_tick_cron.sql). pg_net is FIRE-AND-FORGET: the HTTP response — and
 *     with it `warnings[]` — is discarded. So the response body OF THE RUN THAT ACTUALLY SENT THE
 *     DUPLICATE is never read by anyone. It is gone the instant the send happens.
 *   * For a monitor to read a response body it would have to invoke the tick ITSELF. That yields a
 *     FRESH response computed against the CURRENT ledger, and with the once-per-person guard
 *     present that response's `warnings[]` is always empty — it cannot contain the historical
 *     duplicate. (It would also fire a live send path from a monitor, which we do not want.)
 *   * `console.warn` in `function_logs` is the ONLY durable record of what the real scheduled runs
 *     did. That is exactly the brief's own hint: "the logs catch a run whose caller ignores the
 *     response." pg_cron is the caller that ignores it.
 *
 * ── WHY IT RINGS ON THE FIRST SIGHTING, unlike products-down ────────────────────────────────
 * check-products-down.mjs waits for TWO consecutive runs before it pages, because an unreachable
 * site may be one dropped packet. This does not, because the thing it reports is not transient: a
 * warning line in `function_logs` is the durable record of an email that WAS ALREADY SENT twice.
 * It does not un-happen. One confirmed line = one customer definitely double-emailed = critical /
 * needs_human, the same wire a product being down rings on (fleet-signal.mjs).
 *
 * ── WHY IT NEVER FILES "RESOLVED" ───────────────────────────────────────────────────────────
 * A sent email is a historical fact. `function_logs` retention is ~1 day, so the warning line ages
 * out of the query window while the incident is still true. If this check resolved a row when the
 * line disappeared it would auto-close a real customer-visible incident that nobody acted on — the
 * exact false-recovery trap. So it only ever OPENS (idempotently, on a stable key) and leaves the
 * row standing until a human dismisses it. The key carries the UTC day, so a genuinely new
 * duplicate on another day is a new row rather than a re-stamp of the old one.
 *
 * ── THE THIRD STATE (scripts/lib/check-verdict.mjs) ─────────────────────────────────────────
 * A check that cannot READ the logs must never read as "no duplicates". The token is resolved via
 * the Management API's own project list FIRST (findTokenForProject), so a dead token, a refused
 * token and a 200-with-nothing all collapse to "no token can see this project" -> UNKNOWN, before
 * the logs are ever queried. A non-2xx from the logs endpoint, or a payload this cannot parse, is
 * also UNKNOWN. UNKNOWN exits non-zero: could-not-look is never fine, and it is an incident about
 * the SENSOR. This is what the repo-wide guard
 * test/a-check-cannot-pass-without-reaching-its-dependency.test.mjs enforces by injection.
 *
 * Contract:  node scripts/check-lifecycle-duplicate-warnings.mjs [--dry] [--json] [--ref <ref>]
 *                                                                 [--lookback-min <n>]
 *   env: any SUPABASE_TOKEN_* / *_SUPABASE_ACCESS_TOKEN  — a MANAGEMENT token that can see the
 *        ChannelMover project, to read its edge logs. (monitor.yml already passes
 *        SUPABASE_TOKEN_CHANNELMOVER to its neighbours.)
 *        BOARD_SUPABASE_SECRET or BACKOFFICE_SERVICE_ROLE_KEY  — to file the signal (falls back to
 *        BackOffice/docs/Credentials.txt when run locally, like every other sensor here).
 *   --ref overrides the project read (used by the staging rehearsal); defaults to prod ChannelMover.
 * Exit 0 = judged (clean, or an alarm filed — the board is the alert). Exit 1 = could not read,
 * which is never "fine".
 */
import { boardSecret, fileSignal, signal } from './lib/fleet-signal.mjs'
import { findTokenForProject } from './lib/supabase-token.mjs'
import { sayVerdict, PASS, FAIL, UNKNOWN } from './lib/check-verdict.mjs'

// ChannelMover PRODUCTION project ref (lib/edge-code-baseline.json, verified 2026-09-02). Hardcoded
// the same way fleet-signal.mjs hardcodes the board ref: a single known subject, so there is no
// baseline file whose emptying could silently shrink the population being watched.
const CHANNELMOVER_PROD_REF = 'qswluvqunswggfmesdcs'
const PRODUCT = 'ChannelMover'
const KEY_PREFIX = 'lifecycle-dup-email'
// The distinctive middle of the console.warn line. No brackets/quotes, so it is a literal in both
// the ClickHouse and the legacy BigQuery LIKE that the logs endpoints speak.
const WARNING_MARKER = 'WARNING: duplicate account-level step'
const DEFAULT_LOOKBACK_MIN = 90   // > the hourly cadence, so consecutive runs overlap; well under the 24h endpoint cap

// ── The pure core. Everything here is testable without a network or a secret. ────────────────

/** The SQL asked of the logs endpoint. Only top-level columns, so it is dialect-safe. */
export function logsSql(marker = WARNING_MARKER) {
  const safe = String(marker).replace(/'/g, "''")
  return `select event_message, timestamp from function_logs ` +
    `where event_message like '%${safe}%' order by timestamp desc limit 100`
}

/**
 * Pull the facts out of one warning line. Returns null for a line that does not match the shape,
 * so a stray log that merely contains the marker cannot invent a finding.
 *
 * The line, verbatim from lifecycle-tick:
 *   [lifecycle-tick] WARNING: duplicate account-level step "<step>" sent to <email>
 *   (user <id>) a second time on <YYYY-MM-DD>; ...
 */
export function parseWarning(eventMessage) {
  const text = String(eventMessage || '')
  if (!text.includes(WARNING_MARKER)) return null
  const step = text.match(/account-level step "([^"]+)"/)?.[1]
  const email = text.match(/sent to (\S+?) \(user /)?.[1]
  const userId = text.match(/\(user ([^)]+)\)/)?.[1]
  const day = text.match(/a second time on (\d{4}-\d{2}-\d{2})/)?.[1]
  if (!step || !email || !day) return null   // a match we cannot fully read is not a clean finding
  return { step, email, userId: userId || null, day, sample: text.slice(0, 400) }
}

/**
 * Turn a page of log rows into distinct findings. Rows are objects carrying `event_message`
 * (the shape both logs endpoints return). Deduped on (day, step, email): the warn prints once per
 * duplicate send, but two overlapping query windows or two runs on one day would surface the same
 * line twice, and that is still ONE customer double-emailed.
 */
export function findDuplicateWarnings(rows) {
  const byKey = new Map()
  for (const row of rows || []) {
    const f = parseWarning(row?.event_message ?? row)
    if (!f) continue
    const k = `${f.day}|${f.step}|${f.email}`
    if (!byKey.has(k)) byKey.set(k, f)
  }
  return [...byKey.values()]
}

/**
 * The row a confirmed duplicate files. Critical + needs_human, because it is customer-visible and
 * has already happened — it rings on the same wire a product being down does. Stable key includes
 * the UTC day so a new day's duplicate is a new incident, not a re-stamp.
 */
export function duplicateSignal(finding, product = PRODUCT) {
  const who = finding.email
  return signal({
    key: `${KEY_PREFIX}:${product.toLowerCase()}:${finding.day}:${finding.step}:${who}`,
    product,
    severity: 'critical',
    needsHuman: true,
    title: `${product}: a customer was emailed the same thing twice — ${who} got "${finding.step}" twice on ${finding.day}`,
    summary: `lifecycle-tick logged that it sent the account-level step "${finding.step}" to ${who} `
      + `a second time on ${finding.day} (UTC). The once-per-person guard did not stop it and the `
      + `per-migration ledger index cannot — this is the signature of a stale deploy of `
      + `lifecycle-tick, the exact fault that double-emailed noelle@banek.net on 2026-08-25 `
      + `(ChannelMover/docs/INCIDENTS.md). A customer received a duplicate email; check the live `
      + `ChannelMover build is the current one and dismiss this once handled. This row does not `
      + `self-resolve: a sent email does not un-happen.`,
    detail: {
      product,
      step: finding.step,
      email: who,
      userId: finding.userId,
      day: finding.day,
      source: 'function_logs',
      evidence: finding.sample,
    },
  })
}

// ── I/O below this line. ─────────────────────────────────────────────────────────────────────

/**
 * Read the ChannelMover edge logs for the warning, via the Management API analytics endpoint.
 * Returns { ok:true, rows } on a genuine read, or { ok:false, why } which the caller turns into
 * UNKNOWN. Tries `logs.all` (the classic SQL-over-sources endpoint) and falls back to `logs` so a
 * dialect/endpoint mismatch degrades to a different-but-working read rather than a false clean.
 */
export async function readWarningLogs(ref, token, { lookbackMin = DEFAULT_LOOKBACK_MIN, now = Date.now(), fetchImpl = fetch } = {}) {
  const end = new Date(now).toISOString()
  const start = new Date(now - lookbackMin * 60_000).toISOString()
  const sql = encodeURIComponent(logsSql())
  const qs = `sql=${sql}&iso_timestamp_start=${encodeURIComponent(start)}&iso_timestamp_end=${encodeURIComponent(end)}`
  let lastWhy = 'no endpoint answered'
  for (const endpoint of ['analytics/endpoints/logs.all', 'analytics/endpoints/logs']) {
    const url = `https://api.supabase.com/v1/projects/${ref}/${endpoint}?${qs}`
    let res
    try {
      res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) })
    } catch (err) {
      lastWhy = `request to ${endpoint} failed: ${err.message}`
      continue
    }
    if (!res.ok) { lastWhy = `${endpoint} -> HTTP ${res.status}`; continue }
    let body
    try { body = await res.json() } catch { lastWhy = `${endpoint} -> non-JSON body`; continue }
    const rows = Array.isArray(body) ? body
      : Array.isArray(body?.result) ? body.result
      : Array.isArray(body?.data) ? body.data
      : null
    if (rows === null) { lastWhy = `${endpoint} -> 200 but no result array (shape: ${Object.keys(body || {}).join(',') || 'none'})`; continue }
    return { ok: true, rows, endpoint }
  }
  return { ok: false, why: lastWhy }
}

function parseArgs(argv) {
  const a = { dry: false, json: false, ref: CHANNELMOVER_PROD_REF, lookbackMin: DEFAULT_LOOKBACK_MIN }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry') a.dry = true
    else if (argv[i] === '--json') a.json = true
    else if (argv[i] === '--ref') a.ref = argv[++i]
    else if (argv[i] === '--lookback-min') a.lookbackMin = Number(argv[++i]) || DEFAULT_LOOKBACK_MIN
  }
  return a
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)

  const token = await findTokenForProject(args.ref)
  if (!token) {
    sayVerdict(UNKNOWN, `no management token in this environment can see ChannelMover (${args.ref}); its edge logs were not read, so this proves nothing about duplicate emails.`)
    console.error('::error::lifecycle-duplicate check could not read ChannelMover logs: no management token sees the project. Unknown is not healthy.')
    return 1
  }

  const read = await readWarningLogs(args.ref, token.token, { lookbackMin: args.lookbackMin })
  if (!read.ok) {
    sayVerdict(UNKNOWN, `could not read ChannelMover edge logs (${read.why}); nothing here proves a customer was NOT double-emailed.`)
    console.error(`::error::lifecycle-duplicate check could not read the logs (${read.why}). Unknown is not healthy.`)
    return 1
  }

  const findings = findDuplicateWarnings(read.rows)

  if (args.json) console.log(JSON.stringify({ ref: args.ref, endpoint: read.endpoint, scanned: read.rows.length, findings }, null, 2))
  console.log(`lifecycle-tick warning scan (${PRODUCT} ${args.ref}, last ${args.lookbackMin} min via ${token.key}): ${read.rows.length} matching log line(s), ${findings.length} distinct duplicate(s).`)

  if (findings.length === 0) {
    sayVerdict(PASS, `no "duplicate account-level step" warning in the last ${args.lookbackMin} minutes of ChannelMover edge logs.`)
    return 0
  }

  for (const f of findings) console.log(`  DUPLICATE: ${f.email} got "${f.step}" twice on ${f.day}${f.userId ? ` (user ${f.userId})` : ''}.`)

  if (args.dry) {
    console.log('--dry: nothing written.')
    for (const f of findings) console.log(JSON.stringify(duplicateSignal(f), null, 2))
    sayVerdict(FAIL, `${findings.length} duplicate customer email(s) in the log window (not filed: --dry).`)
    return 0
  }

  const secret = boardSecret()
  for (const f of findings) await fileSignal(secret, duplicateSignal(f))
  console.error(`::error::${findings.length} customer(s) were emailed the same lifecycle step twice. Filed as critical on https://cockpit.predivo.ch/signals.`)
  sayVerdict(FAIL, `${findings.length} duplicate customer email(s) filed critical/needs_human on the board.`)
  return 0   // a filed alarm exits 0 — the board is the alert (fleet-signal.mjs)
}

if (import.meta.url === (await import('url')).pathToFileURL(process.argv[1] || '').href) {
  main().then(
    (code) => { process.exitCode = code },
    (e) => {
      console.error(`::error::the lifecycle-duplicate check could NOT run (${e.message}). Unknown is not healthy.`)
      process.exitCode = 1
    },
  )
}
