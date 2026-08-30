#!/usr/bin/env node
/**
 * A CUSTOMER RECEIVING THE SAME EMAIL TWICE MUST REACH ROGER. Until now nothing listened.
 *
 * WHY (ChannelMover INCIDENTS.md, first entry). On 2026-08-25 our only paying customer,
 * noelle@banek.net, was sent "Did everything arrive?" twice, because a stale build of
 * `lifecycle-tick` was live without the once-per-person guard. It was found HOURS LATE, by a
 * human opening the Supabase logs and counting rows in a ledger. To stop that from being the
 * detection path, ChannelMover commit 9a7ab98 made `lifecycle-tick` NOTICE the case itself: on a
 * second account-level step of the same kind, to the same person, on the same UTC day, it appends
 * a `"duplicate account-level step ..."` string to the `warnings[]` array in its JSON response and
 * writes the same line to `console.warn`. It changes no send behaviour — it is purely an observer.
 * The one thing it did NOT have was a reader. This is the reader.
 *
 * ── WHICH SURFACE, AND WHY THE RESPONSE BODY WINS HERE ──────────────────────────────────────
 *
 * There were two places to watch: the project's Supabase edge logs (the `console.warn`), or the
 * tick's own JSON response body (`warnings[]`). The response body is watched, and it is watched
 * WITHOUT re-invoking the function, because of one fact about how the tick is driven:
 *
 *   `lifecycle-tick` is called every 5 minutes by pg_cron via `net.http_post`
 *   (ChannelMover migration 20260824002). pg_net is fire-and-forget: the cron IGNORES the
 *   response — but pg_net still PERSISTS every response, body and all, into `net._http_response`,
 *   where it is retained for roughly six hours.
 *
 * So the response body is the "easier surface that is produced on every scheduled run" AND it also
 * covers the case the logs were supposed to be needed for — "a run whose caller ignores the
 * response" — because the caller here (pg_cron) ignores it and pg_net keeps it anyway. We read the
 * persisted body with a read-only Management API SQL query (same auth contract as
 * check-cron-heartbeats.mjs). Crucially this has ZERO side effects: a monitor must never invoke a
 * function that SENDS CUSTOMER EMAIL just to read its answer, least of all on production, where
 * that would be the monitor causing the very sends it watches for.
 *
 * ── IT PAGES ON THE FIRST SIGHTING, ON PURPOSE ─────────────────────────────────────────────
 *
 * check-products-down.mjs waits for a second consecutive sighting before it rings, because a
 * single failed probe can be one dropped packet. This does the opposite and it is the right
 * choice: the tick only emits the warning AFTER it has actually sent a second account-level email
 * to a person on one day. There is no blip to confirm — the customer-visible harm has already
 * happened. Rare (exactly once in the fleet's history) and serious and already-done is precisely
 * the profile that earns an interruption, so this files `critical` / `needs_human: true` at once,
 * which is what upsert_signal requires to schedule a page (BackOffice migration 126, line 234),
 * subject to production-monitor's own self-heal delay.
 *
 * ── IT DEDUPES SO IT PAGES ONCE PER REAL DUPLICATE ─────────────────────────────────────────
 *
 * The same duplicate condition re-emits its warning on every 5-minute tick until the UTC day rolls
 * over or the stale deploy is replaced, and the warning stays in net._http_response for ~6h. The
 * signal key is therefore the IDENTITY OF THE DUPLICATE — product, user, step, day — not the run
 * that reported it. upsert_signal dedupes on that key, so a hundred repeated warnings for one
 * duplicated email are one board row and one page. A duplicate is a past event, so nothing here
 * ever RESOLVES the signal: it stays open for Roger to acknowledge, and simply stops being re-filed
 * once it ages out of the retention window.
 *
 * Contract:  node scripts/check-lifecycle-duplicate-warnings.mjs [--dry]
 *   env: SUPABASE_TOKEN_CHANNELMOVER  (Management API PAT — reads net._http_response)
 *        BOARD_SUPABASE_SECRET or BACKOFFICE_SERVICE_ROLE_KEY  (files the signal via signal-intake;
 *        falls back to BackOffice/docs/Credentials.txt when run locally, like check-products-down)
 * Exit 0 = judged (no unread warnings, or an alarm filed). Exit 1 = could not tell — a token that
 * is unset or a Management API read that fails is NEVER "no duplicates": unknown is not clean.
 */
import { readFileSync } from 'fs'

const BO_REF = 'xoecpzfsskalvjrtcbbl'
const BO_BASE = `https://${BO_REF}.supabase.co`
const BO_CREDS = 'C:\\Business\\Internal Projects\\BackOffice\\docs\\Credentials.txt'
const NON_BROWSER_UA = 'lifecycle-dup-producer/1.0'
const SOURCE = 'production-monitor'
const KEY_PREFIX = 'lifecycle-dup'
const LINK = 'https://cockpit.predivo.ch/signals'

/** How far back to read persisted tick responses. Matches pg_net's ~6h retention: reading the
 *  whole retained window every run, with key-dedup downstream, means a skipped monitor run cannot
 *  lose a warning that is still on disk. */
export const LOOKBACK_HOURS = 6

/**
 * The products whose lifecycle-tick response bodies are read. One today; a second product that
 * adopts the same warnings[] contract is a one-line addition. `ref` is the project the tick runs
 * in; `patEnv` is its Management API PAT (already a repo secret used by the other fleet checks).
 */
export const PRODUCTS = [
  { name: 'ChannelMover', patEnv: 'SUPABASE_TOKEN_CHANNELMOVER', ref: 'qswluvqunswggfmesdcs' },
]

/**
 * Which projects this run reads. Normally PRODUCTS (production). A rehearsal points it at a
 * staging ref instead by setting LIFECYCLE_DUP_REHEARSAL_REF — the same org PAT covers both — so
 * the WHOLE script (read → parse → dedup → file) can be observed end-to-end against staging without
 * ever reading production or editing this file. This is how the alert was proven, per the brief's
 * "prove it by observation, not by reading code".
 */
export function productsToCheck(env = process.env) {
  const ref = env.LIFECYCLE_DUP_REHEARSAL_REF
  if (ref) return [{ name: 'ChannelMover', patEnv: 'SUPABASE_TOKEN_CHANNELMOVER', ref }]
  return PRODUCTS
}

/**
 * Pull every retained lifecycle-tick response that carries at least one warning. The shape is
 * unmistakable — lifecycle-tick is the only function returning `{"ranAt":...,"warnings":[...]}` —
 * and `"warnings":["` matches a NON-EMPTY array only, so a clean run (`"warnings":[]`) is skipped
 * in the database rather than fetched and discarded.
 */
export const warningsSql = (hours = LOOKBACK_HOURS) => `
  select id, created, content
  from net._http_response
  where status_code = 200
    and created > now() - interval '${Number(hours)} hours'
    and content like '%"ranAt"%'
    and content like '%"warnings":["%'
  order by created desc`

/**
 * Parse one warning string into the identity of the duplicate. The tick's message is:
 *   duplicate account-level step "<step>" sent to <email> (user <userId>) a second time on <day>; ...
 * A string that does NOT match is not dropped — the caller still alarms on it with a hashed key,
 * because a real warning we cannot parse is exactly the thing we must not go silent on.
 */
export function parseWarning(msg) {
  const m = String(msg).match(
    /account-level step "([^"]+)" sent to (\S+) \(user ([^)]+)\) a second time on (\d{4}-\d{2}-\d{2})/,
  )
  if (!m) return null
  return { step: m[1], email: m[2], userId: m[3], day: m[4] }
}

/** A stable, order-independent fingerprint for a warning we could not parse. Not crypto — just a
 *  key that is the same every run for the same text, so an unparseable warning still dedupes. */
export function hashText(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return (h >>> 0).toString(36)
}

/**
 * The identity of the duplicate, which is what the page dedupes on — the person and the email
 * they got twice today, NOT the run that noticed it. Parsed → product:user:step:day. Unparsed →
 * product:raw:<hash>, so it still collapses to one row.
 */
export function dedupKey(product, parsed, rawMsg) {
  return parsed
    ? `${KEY_PREFIX}:${product}:${parsed.userId}:${parsed.step}:${parsed.day}`
    : `${KEY_PREFIX}:${product}:raw:${hashText(String(rawMsg))}`
}

/**
 * Flatten persisted responses into one entry per distinct duplicate. Rows are JSON-parsed
 * defensively (a single unreadable body must not sink the run), warnings are pulled out, and
 * entries are deduped by key here too so the same duplicate seen across many ticks is filed once.
 */
export function collectWarnings(rows, product) {
  const byKey = new Map()
  for (const row of rows) {
    let body
    try { body = JSON.parse(row.content) } catch { continue }
    const warns = Array.isArray(body?.warnings) ? body.warnings : []
    for (const raw of warns) {
      const parsed = parseWarning(raw)
      const key = dedupKey(product, parsed, raw)
      // Keep the earliest sighting — that is when the customer was actually emailed twice.
      const prior = byKey.get(key)
      if (!prior || new Date(row.created) < new Date(prior.seenAt)) {
        byKey.set(key, { key, product, parsed, raw, seenAt: row.created, responseId: row.id })
      }
    }
  }
  return [...byKey.values()]
}

/** What one confirmed duplicate says on the cockpit, and it is armed to ring the moment it lands. */
export function signalFor(entry) {
  const { product, parsed, raw, key, seenAt } = entry
  const who = parsed ? `${parsed.email} (user ${parsed.userId})` : 'a customer'
  const what = parsed ? `the "${parsed.step}" account-level email` : 'an account-level email'
  const when = parsed ? ` on ${parsed.day}` : ''
  return {
    source: SOURCE,
    key,
    kind: 'incident',
    product,
    severity: 'critical',
    needs_human: true,
    state: 'open',
    title: `${product} sent a customer the same email twice`,
    summary:
      `${product} sent ${who} ${what} a SECOND time${when}. lifecycle-tick's once-per-person guard ` +
      `did not stop it — the signature of a stale deploy running without the guard. The customer has ` +
      `already received both emails; this cannot self-heal. Warning verbatim: "${raw}"`,
    detail: { product, ...(parsed || { unparsed: raw }), warning: raw, firstSeenAt: seenAt },
    link: LINK,
  }
}

function readBoSecret() {
  if (process.env.BOARD_SUPABASE_SECRET) return process.env.BOARD_SUPABASE_SECRET.trim()
  if (process.env.BACKOFFICE_SERVICE_ROLE_KEY) return process.env.BACKOFFICE_SERVICE_ROLE_KEY.trim()
  const txt = readFileSync(BO_CREDS, 'utf-8')
  const m = txt.match(/sb_secret_[A-Za-z0-9_]+/)
  if (!m) throw new Error(`no sb_secret_ key found in ${BO_CREDS}`)
  return m[0]
}

/** Management API query with retries — api.supabase.com intermittently 502s; a gateway blip must
 *  not read as "no duplicates". Same retry contract as check-cron-heartbeats.mjs. */
async function query(ref, pat, sql) {
  let lastErr
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: sql }),
        signal: AbortSignal.timeout(30_000),
      })
      const text = await res.text()
      if (res.ok && !text.startsWith('<')) return JSON.parse(text)
      lastErr = new Error(`HTTP ${res.status}: ${text.slice(0, 150)}`)
    } catch (e) {
      lastErr = e
    }
    if (attempt < 4) await new Promise((r) => setTimeout(r, attempt * 5000))
  }
  throw lastErr
}

async function fileSignal(secret, body) {
  const res = await fetch(`${BO_BASE}/functions/v1/signal-intake`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', 'User-Agent': NON_BROWSER_UA },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`signal-intake -> HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`)
  return res.json()
}

async function main() {
  const dry = process.argv.includes('--dry')

  // Gather every unread duplicate across the watched products first, so a single unverifiable
  // product fails the run loudly instead of being silently counted as clean.
  const entries = []
  let unverifiable = 0
  for (const { name, patEnv, ref } of productsToCheck()) {
    console.log(`\n== ${name} (${ref})`)
    const pat = process.env[patEnv]
    if (!pat) {
      console.error(`  UNVERIFIABLE env ${patEnv} not set — cannot read ${name}'s tick responses`)
      unverifiable++
      continue
    }
    let rows
    try {
      rows = await query(ref, pat, warningsSql())
    } catch (e) {
      console.error(`  UNVERIFIABLE Management API query failed after retries: ${e.message}`)
      unverifiable++
      continue
    }
    const found = collectWarnings(rows, name)
    if (found.length === 0) { console.log(`  OK    no unread duplicate-email warnings in the last ${LOOKBACK_HOURS}h`); continue }
    for (const e of found) console.error(`  DUP   ${e.key} — first seen ${e.seenAt}`)
    entries.push(...found)
  }

  if (dry) {
    console.log(`\n--dry: ${entries.length} duplicate warning(s) found, nothing written.`)
    for (const e of entries) console.log(JSON.stringify(signalFor(e)))
    return unverifiable > 0 ? 1 : 0
  }

  if (entries.length > 0) {
    const secret = readBoSecret()
    for (const e of entries) await fileSignal(secret, signalFor(e))
    console.error(`::error::${entries.length} customer(s) were emailed the same thing twice. Filed as critical on /signals.`)
  }

  // A read that could not be done is never a clean bill of health.
  if (unverifiable > 0) {
    console.error(`::error::${unverifiable} product(s) could not be read — unknown is not "no duplicates".`)
    return 1
  }
  return 0
}

if (import.meta.url === (await import('url')).pathToFileURL(process.argv[1] || '').href) {
  main().then(
    (code) => { process.exitCode = code },
    (e) => {
      console.error(`::error::the duplicate-email check could NOT run (${e.message}). Unknown is not healthy.`)
      process.exitCode = 1
    },
  )
}
