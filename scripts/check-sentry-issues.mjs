#!/usr/bin/env node
/**
 * Sentry must reach the BOARD, not Roger's inbox.
 *
 * WHY (audit 2026-08-27, Cockpit/docs/AUDIT-what-should-be-monitored-2026-08-27.md, shortlist #1).
 * The scheduled-jobs grid has a direct wire into /signals: check-healthchecks-down.mjs reads
 * healthchecks.io every hour and files a DOWN check as a signal. Sentry had no such wire. Its only
 * route to Roger ran through Gmail: Sentry mails him, an hourly assistant reads the inbox,
 * recognises the mail and files a signal BY HAND. That route loses things three ways and all three
 * have already happened here:
 *
 *   1. no alert rule on a project  -> no mail  -> nothing is ever filed;
 *   2. the inbox tidy-up files the mail first -> nothing is ever filed (a decision once sat unseen
 *      for seven days for exactly this reason);
 *   3. a different assistant files it every hour, so the same issue arrives under a different name
 *      each time. Measured on production 2026-08-27: 25 `source=sentry` rows carrying SIX different
 *      key conventions for one source (numeric issue id, `sentry:<id>`, shortId, a raw event id and
 *      two hand-written slugs). Dedup cannot work across those, and it did not.
 *
 * This is that missing wire, built to the same shape as check-healthchecks-down.mjs on purpose:
 * read with a token, file through `signal-intake`, dedup on a stable key, and never report a
 * failed read as a clean result.
 *
 * ── THE BAR: which issues become signals ─────────────────────────────────────────────────────
 *
 * ONE RULE: an unresolved Sentry issue becomes a signal when it has been seen in a LIVE
 * environment. Nothing else. Measured against the live org on 2026-08-27: 13 unresolved issues,
 * 8 qualify, 5 are staging-only or local-only.
 *
 * Why environment and not volume, recency, users or project. Every other bar was tried against
 * the same 13 rows first:
 *
 *   * event count >= 3   keeps 3 of 13 and drops five genuine PRODUCTION errors, one of them the
 *                        support mailer failing to send. This fleet has almost no traffic, so a
 *                        real defect fires ONCE. Volume here measures customers, not brokenness.
 *   * affected users     same shape: 4 of the 8 production issues report userCount 0.
 *   * first seen recently  drops BACKOFFICE-7, first seen 2026-08-20, still firing today at 33
 *                        events. When we started looking is not whether it is broken.
 *   * project whitelist  two of the nine projects have never received a single event in their
 *                        existence. A project list records what somebody remembered to instrument.
 *   * level >= error     all 13 are level `error`. A level bar returns zero and an empty tile,
 *                        which is the "it does not look bad, it looks like nothing" failure the
 *                        audit opens with.
 *
 * Environment is the only bar that tracks whether anyone can be hurt by it, and it is Roger's own
 * standing rule: "Anything on staging. Staging exists to break. An alarm from it teaches you to
 * ignore alarms."
 *
 * UNKNOWN COUNTS AS LIVE, deliberately. The live set is built by asking Sentry which unresolved
 * issues appear in each environment whose NAME is not provably a staging or local one
 * (`staging`, `staging.*`, `127.0.0.1`, `localhost`, `dev*`, `preview*`, `test*`). An environment
 * nobody has taught this script about is therefore treated as live. Dropping a production error
 * because a new environment got an unfamiliar name is the expensive mistake; carrying one extra
 * board row is the cheap one.
 *
 * ── WHICH SYSTEM WINS WHEN SENTRY AND THE BOARD DISAGREE ─────────────────────────────────────
 *
 * They already disagree, in both directions, on production today. So this cannot be left implicit.
 *
 *   Sentry wins on "is it still broken", but only ON EVIDENCE. A board row marked resolved while
 *   Sentry still holds the issue unresolved is REOPENED only when Sentry has seen the error AGAIN
 *   since the board resolved it (lastSeen > resolved_at). Otherwise the board's resolution stands.
 *
 * That is the rule that tells a real fix from an unclicked button. A fix that worked produces no
 * new events; a fix that did not produces more. Read off production 2026-08-27, it reopens
 * BACKOFFICE-7 (resolved on the board 08-21, fired again as recently as today, 33 events),
 * REPLYFLOW-EDGE-C and CHANNELMOVER-2, and it leaves REPLYFLOW-EDGE-D, REPLYFLOW-EDGE-E and
 * REPLYFLOW-2 resolved, because nothing has been seen from them since the board closed them.
 * The blunt alternative ("Sentry always wins") would reopen all six and the board would fill with
 * errors that stopped happening days ago, which is the failure this whole exercise exists to end.
 *
 * ── WHAT IT WILL NOT DO ──────────────────────────────────────────────────────────────────────
 *
 *   * It never touches a `source=sentry` row it did not file. Auto-resolve is restricted to rows
 *     carrying `detail.filed_by = 'check-sentry-issues'`. The board holds hand-filed Sentry rows
 *     that a person put there on purpose, including one titled "[not live]" about a staging-only
 *     money defect; a producer that tidied those away would be deleting somebody's judgement.
 *   * It never mints a second signal for an issue that already has one. Before filing, it adopts
 *     whatever key the board is already using for that issue (shortId, numeric id or `sentry:<id>`),
 *     so the six historic key conventions converge instead of doubling.
 *   * ONE class of error CAN ring a phone, and only one: a refused credential. Everything else is
 *     still filed `needs_human: false` at Sentry's own level (an application error is code, so it
 *     is machine-owned and belongs in the "Watching" band, never in "Needs you", which means it
 *     needs ROGER). A chronic application error remains a board item, never a phone call.
 *
 *     WHY THE EXCEPTION EXISTS (Roger's decision, 2026-09-04, option C of three). On 2026-09-02
 *     ReplyFlow and SignalScore answered `Unregistered API key` to every call BackOffice made. This
 *     producer SAW it and filed two signals — and both were graded into silence, because
 *     `severityFor()` is a straight copy of Sentry's level (so `error` becomes `warning`) and
 *     `needs_human` was hardcoded false. Zero of the 38 signals this source had ever filed had
 *     paged. The outage ran 22h40m and a human found it on a dashboard.
 *
 *     A refused credential is the one error class where "a machine owns it" is FALSE: no machine on
 *     this fleet can mint a replacement key, and the fault never self-heals. So `isCredentialRefusal`
 *     raises exactly that class to `critical` + `needs_human: true`, which is what upsert_signal
 *     requires. Replayed over all 38 signals ever filed, this rings 5 times in four months and is
 *     right all five; the alternative Roger rejected — "anything still broken after a day" — rings
 *     7 and is wrong at least twice. Measurements and the two rejected options:
 *     docs/DECISION-when-a-crash-report-is-allowed-to-ring-your-phone-2026-09-03.md
 *
 *     `signal_page_policy` DOES carry a `sentry` row with `may_page = true` (read live 2026-09-03;
 *     an earlier version of this header said it did not, and that was wrong). So the severity /
 *     needs_human pair was the only thing muting this source, and changing it here is sufficient.
 *
 * Contract:  node scripts/check-sentry-issues.mjs [--dry]
 *   env: SENTRY_API_TOKEN   read token for org `predivo-gmbh`. Falls back to the BackOffice
 *                           credentials file when running locally.
 *        BOARD_SUPABASE_SECRET or BACKOFFICE_SERVICE_ROLE_KEY   to file the signal.
 *        BOARD_SUPABASE_URL  optional. Defaults to the PRODUCTION BackOffice project. Point it at
 *                            staging to prove a change without writing to Roger's live board.
 * Exit 0 = judged (filed, reopened, resolved or nothing to do).
 * Exit 1 = could not tell, which is never "fine".
 */
import { readFileSync } from 'fs'

const BO_PROD = 'https://xoecpzfsskalvjrtcbbl.supabase.co'
const BO_CREDS = 'C:\\Business\\Internal Projects\\BackOffice\\docs\\Credentials.txt'
const SENTRY_API = 'https://sentry.io/api/0'
const SENTRY_ORG = 'predivo-gmbh'
const NON_BROWSER_UA = 'sentry-issues-producer/1.0'
const SOURCE = 'sentry'

/** The marker that says THIS script filed a row. Auto-resolve never runs on anything without it. */
export const FILED_BY = 'check-sentry-issues'

/** How far back Sentry is asked to look. Long enough that a slow-burning error is not lost. */
const STATS_PERIOD = '90d'

function readBoSecret() {
  if (process.env.BOARD_SUPABASE_SECRET) return process.env.BOARD_SUPABASE_SECRET.trim()
  if (process.env.BACKOFFICE_SERVICE_ROLE_KEY) return process.env.BACKOFFICE_SERVICE_ROLE_KEY.trim()
  const txt = readFileSync(BO_CREDS, 'utf-8')
  const m = txt.match(/sb_secret_[A-Za-z0-9_]+/)
  if (!m) throw new Error(`no sb_secret_ key found in ${BO_CREDS}`)
  return m[0]
}

function readSentryToken() {
  if (process.env.SENTRY_API_TOKEN) return process.env.SENTRY_API_TOKEN.trim()
  const txt = readFileSync(BO_CREDS, 'utf-8')
  const m = txt.match(/^SENTRY_API_TOKEN:\s*(\S+)/m)
  if (!m) throw new Error(`no SENTRY_API_TOKEN found in ${BO_CREDS}`)
  return m[1]
}

/**
 * Environment names that are provably NOT live.
 *
 * A BLOCK list, not an allow list, and that direction is the whole point. The org carries six
 * environment names today and four of them are staging in some spelling: `staging`,
 * `staging.backoffice.predivo.ch`, `staging.replyflow.help`, `staging.valrano.com`, plus the
 * local `127.0.0.1`. Only `production` is live. If the fleet ever ships an environment called
 * `prod`, `live` or `www.replyflow.help`, an allow list would silently drop every error in it and
 * the board would read zero while a product burned. This way the new name is treated as live and
 * the worst case is one board row too many.
 */
const NOT_LIVE = [
  /^staging(\b|[.\-_])/i,
  /^dev(\b|elopment\b|[.\-_])/i,
  /^preview(\b|[.\-_])/i,
  /^test(\b|ing\b|[.\-_])/i,
  /^local(host)?(\b|[.\-_])/i,
  /^127\.0\.0\.1$/,
  /^::1$/,
]

export function isLiveEnvironment(name) {
  const n = String(name ?? '').trim()
  if (!n) return false          // an unnamed environment is not evidence of a live one
  return !NOT_LIVE.some((re) => re.test(n))
}

export function liveEnvironments(names) {
  return [...new Set((names ?? []).map((n) => (typeof n === 'string' ? n : n?.name)).filter(Boolean))]
    .filter(isLiveEnvironment)
}

/**
 * Every key the board might already be using for this issue, newest convention first.
 *
 * Historic rows exist under all three. Adopting the one that is already there is what stops this
 * producer minting a duplicate beside a row somebody filed by hand.
 */
export function candidateKeys(issue) {
  const id = String(issue.id ?? '')
  const short = String(issue.shortId ?? '')
  return [short, id, id && `${SOURCE}:${id}`].filter(Boolean)
}

/** The key this issue will be filed under: whatever the board already uses, else its shortId. */
export function keyFor(issue, boardRows) {
  const byKey = new Map((boardRows ?? []).map((r) => [r.key, r]))
  for (const k of candidateKeys(issue)) if (byKey.has(k)) return k
  return String(issue.shortId || issue.id)
}

/**
 * The wordings that mean "a credential was refused", which is the ONE class allowed to page.
 *
 * Deliberately about the REJECTION, never about the secret. `expiring tokens` in
 * "Failed to query expiring tokens" is a table of customer tokens being read and is not a refusal,
 * so bare `token` is not matched — only a token that was rejected. `JWT issued at future` is here
 * because it is a real refusal that the narrower option (A) missed twice: a clock-skewed JWT is
 * refused exactly like a revoked one, and no machine can fix it either.
 */
export const CREDENTIAL_REFUSAL = new RegExp([
  'unregistered api key', 'invalid api key', 'no api key', 'api key not found', 'bad api key',
  'jwt expired', 'jwt issued at future', 'invalid jwt', 'jwsError', 'invalid signature',
  'signature verification', 'invalid token', 'expired token', 'token expired', 'token refused',
  'invalid credential', 'unauthorized', 'unauthorised', 'permission denied', 'forbidden',
  'http 401', 'http 403', '\\b401\\b', '\\b403\\b',
].join('|'), 'i')

/**
 * Titles a person wrote to say "this is NOT a live production fault". Never paged, whatever they
 * say. Both wordings are real and both would otherwise have produced a false page: one row begins
 * "Cleared in Sentry" (already fixed) and one begins "[not live]" (a staging-only money defect a
 * person filed by hand).
 */
const NOT_LIVE_PREFIX = /^\s*(\[not live\]|cleared in sentry)/i

/**
 * Is this error a refused credential? Judged on the title and the culprit, never on the level —
 * the level is what got this wrong in the first place.
 */
export function isCredentialRefusal(issue) {
  const text = `${issue?.title ?? ''} ${issue?.culprit ?? ''}`
  if (NOT_LIVE_PREFIX.test(String(issue?.title ?? ''))) return false
  return CREDENTIAL_REFUSAL.test(text)
}

/** Sentry's own level, mapped onto the board's three words. Nothing is invented. */
export function severityFor(issue) {
  const level = String(issue.level ?? 'error').toLowerCase()
  if (level === 'fatal') return 'critical'
  if (level === 'error' || level === 'warning') return 'warning'
  return 'info'
}

const dateOnly = (iso) => (iso ? String(iso).slice(0, 10) : 'an unknown date')

/** What the cockpit actually reads, in words that name the product and the consequence. */
export function signalFor(issue, key) {
  const envs = (issue.environments ?? []).join(', ')
  const times = Number(issue.count ?? 0)
  const users = Number(issue.userCount ?? 0)
  const seen = times === 1 ? 'Seen once' : `Seen ${times} times`
  const who = users > 0 ? ` ${users} user${users === 1 ? '' : 's'} affected.` : ''
  // The ONE exception to "an application error is code, so a machine owns it": a refused
  // credential cannot be fixed by any machine here and never self-heals, so it is the only class
  // that belongs in "Needs you". Roger's decision, 2026-09-04 — see the header.
  const refused = isCredentialRefusal(issue)
  return {
    source: SOURCE,
    key: key ?? String(issue.shortId || issue.id),
    kind: 'incident',
    severity: refused ? 'critical' : severityFor(issue),
    state: 'open',
    // upsert_signal is eligible to page only on needs_human AND critical, so these two move
    // together or not at all. Everything that is not a refused credential keeps the old contract.
    needs_human: refused,
    product: issue.project || null,
    title: `${issue.project || 'app'} is throwing an error: ${issue.title || '(untitled)'}`.slice(0, 200),
    summary: [
      // Say WHY the phone rang, first, in the words a person woken by it needs.
      refused ? 'A key or login was REFUSED, so no machine here can fix this. ' : '',
      `${seen} since ${dateOnly(issue.firstSeen)}, most recently ${dateOnly(issue.lastSeen)}`,
      envs ? ` in ${envs}` : '',
      `.${who}`,
      issue.culprit ? ` It is thrown from ${issue.culprit}.` : '',
      ` Sentry ${issue.shortId}.`,
    ].join('').trim(),
    detail: {
      filed_by: FILED_BY,
      issue_id: String(issue.id ?? ''),
      short_id: issue.shortId ?? '',
      project: issue.project ?? '',
      level: issue.level ?? '',
      culprit: issue.culprit ?? null,
      environments: issue.environments ?? [],
      event_count: times,
      user_count: users,
      first_seen: issue.firstSeen ?? null,
      last_seen: issue.lastSeen ?? null,
      permalink: issue.permalink ?? '',
    },
    // Straight to the error. The fix starts where the stack trace is, not on a board tile.
    link: issue.permalink || 'https://cockpit.predivo.ch/signals',
  }
}

const ACTIVE_STATES = new Set(['open', 'acknowledged', 'snoozed'])

/**
 * THE WHOLE DECISION, pure and testable: what gets filed, what gets reopened, what gets resolved,
 * and what is deliberately left exactly as it is.
 *
 * `liveIssues`  unresolved Sentry issues that have been seen in a live environment.
 * `boardRows`   every `source=sentry` row on the board, with key/state/resolved_at/detail.
 */
export function reconcile(liveIssues, boardRows) {
  const rows = boardRows ?? []
  const byKey = new Map(rows.map((r) => [r.key, r]))
  const file = [], reopen = [], leave = [], resolve = []
  const covered = new Set()

  for (const issue of liveIssues ?? []) {
    const key = keyFor(issue, rows)
    covered.add(key)
    const row = byKey.get(key)
    if (!row) { file.push({ issue, key }); continue }
    if (ACTIVE_STATES.has(row.state)) { file.push({ issue, key, refresh: true }); continue }

    // Resolved or superseded on the board, still unresolved in Sentry. Evidence decides.
    const lastSeen = Date.parse(issue.lastSeen ?? '')
    const resolvedAt = Date.parse(row.resolved_at ?? '')
    if (Number.isFinite(lastSeen) && Number.isFinite(resolvedAt) && lastSeen > resolvedAt) {
      reopen.push({ issue, key, row })
    } else {
      leave.push({ issue, key, row })
    }
  }

  // Recovered: only rows THIS producer filed, and only while they are still active. A row a
  // person filed by hand is somebody's judgement and is never tidied away by a machine.
  for (const row of rows) {
    if (!ACTIVE_STATES.has(row.state)) continue
    if (row.detail?.filed_by !== FILED_BY) continue
    if (covered.has(row.key)) continue
    resolve.push({ row })
  }

  return { file, reopen, leave, resolve }
}

// ── the network edges, kept thin so the decision above stays testable ─────────────────────────

/**
 * HTTP statuses that are the upstream having a bad second, not an answer about our fleet.
 * A 401/403/404 is deliberately NOT here: a dead token or a moved endpoint is a real finding and
 * must red the hour on the first try, not three tries later.
 */
const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])

/** A read is re-tried this many times before "could not run" is believed. */
export const READ_ATTEMPTS = 3
/** How long between those attempts. Long enough to outlast a blip, short enough for an hourly run. */
export const READ_GAP_MS = 5_000

/**
 * Retry a READ that failed transiently, and only a read.
 *
 * WHY (run 33539154299, 2026-09-01 17:51 UTC). Sentry answered ONE request with HTTP 500 and the
 * whole hourly monitor went red; the identical request returned 200 minutes later, and the 9 live
 * issues it lists were unchanged. A monitor that reports somebody else's bad second as our
 * emergency teaches Roger to ignore it, which is the same failure `check-products-down.mjs`
 * already solved for product probes ("one TLS reset or one cold start is not an outage. All
 * attempts must fail"). This is that rule, applied to the upstreams this check reads.
 *
 * It stays a READ-only rule on purpose. `signal-intake` is a POST, and a POST that answered 503
 * may still have committed, so retrying it could file a row twice; a duplicated board row is a
 * worse outcome than a red hour, so that path keeps failing on the first error.
 */
export async function readWithRetry(doRead, label, {
  attempts = READ_ATTEMPTS,
  gapMs = READ_GAP_MS,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = console.log,
} = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await doRead()
    } catch (e) {
      if (!e.transient || attempt >= attempts) {
        if (e.transient) e.message = `${e.message} (${attempts} attempts, all transient failures)`
        throw e
      }
      log(`  ${label}: ${e.message} - retrying (attempt ${attempt} of ${attempts})`)
      await sleep(gapMs)
    }
  }
}

/** Tag an error as "the upstream hiccupped" so `readWithRetry` knows it is worth another try. */
function transient(message) {
  const e = new Error(message)
  e.transient = true
  return e
}

async function sentryGetOnce(token, path) {
  let res
  try {
    res = await fetch(`${SENTRY_API}${path}`, {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': NON_BROWSER_UA },
    })
  } catch (e) {
    // No HTTP answer at all (DNS, TLS, socket). Same class as a 502: try again before believing it.
    throw transient(`Sentry GET ${path} -> ${e.message}`)
  }
  if (!res.ok) {
    const msg = `Sentry GET ${path} -> HTTP ${res.status}`
    throw TRANSIENT_STATUS.has(res.status) ? transient(msg) : new Error(msg)
  }
  // The Link header carries Sentry's pagination cursor. It used to be thrown away by res.json(),
  // which is why the caller could not tell ONE PAGE from THE POPULATION (2026-09-02 audit).
  return { body: await res.json(), link: res.headers.get('link') }
}

const sentryGetPage = (token, path) => readWithRetry(() => sentryGetOnce(token, path), 'sentry')
const sentryGet = async (token, path) => (await sentryGetPage(token, path)).body

/**
 * ONE PAGE IS NOT THE POPULATION (2026-09-02 audit). The issue query asked for `limit=100` and read
 * whatever came back with no cursor, so issue 101 in an environment was simply absent from the
 * covered set - and reconcile() auto-resolves everything this producer filed that it did not
 * re-cover, posting "Sentry no longer lists this as an unresolved error" over a live one. There
 * are nine live issues today so it has never bitten, but the number of unresolved errors is
 * exactly the number this producer cannot bound, and what a truncated read produces here is a
 * silent all-clear rather than a visible gap.
 */
export const MAX_ISSUE_PAGES = 10

export function nextCursor(linkHeader) {
  // Sentry: `<https://...>; rel="next"; results="true"; cursor="0:100:0"`
  const next = String(linkHeader || '').split(',')
    .find((p) => /rel="next"/.test(p) && /results="true"/.test(p))
  return next ? (next.match(/cursor="([^"]+)"/) || [])[1] || null : null
}

const mapIssue = (i) => ({
  id: String(i.id),
  shortId: i.shortId ?? '',
  title: i.title ?? '(untitled)',
  project: i.project?.slug ?? '',
  culprit: i.culprit ?? null,
  level: i.level ?? 'error',
  count: Number(i.count ?? 0),
  userCount: Number(i.userCount ?? 0),
  firstSeen: i.firstSeen ?? null,
  lastSeen: i.lastSeen ?? null,
  permalink: i.permalink ?? '',
  environments: [],
})

/**
 * Unresolved issues that have been seen in a live environment, with the environments they were
 * seen in attached.
 *
 * A THROW HERE FAILS THE RUN, by design. If the environment list cannot be read we do not know
 * which environments are live, and a producer that guesses "production only" at that moment would
 * quietly file nothing and leave a green tile over a burning product.
 */
/** A 200 whose body is not an issue list means the read failed, never that the environment is clean. */
export function issuesFrom(raw, env) {
  if (!Array.isArray(raw)) {
    throw new Error(`Sentry answered 200 for environment "${env}" with no issue list, so nothing could be judged`)
  }
  return raw
}

export async function fetchLiveIssues(token) {
  const envNames = liveEnvironments(await sentryGet(token, `/organizations/${SENTRY_ORG}/environments/`))
  if (!envNames.length) throw new Error('Sentry reports no live environment at all, which cannot be right')

  const found = new Map()
  for (const env of envNames) {
    let cursor = null
    for (let page = 1; page <= MAX_ISSUE_PAGES; page++) {
    const { body: raw, link } = await sentryGetPage(
      token,
      `/organizations/${SENTRY_ORG}/issues/?query=is:unresolved&statsPeriod=${STATS_PERIOD}` +
      `&limit=100&environment=${encodeURIComponent(env)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    )
    // A 200 THAT IS NOT A LIST OF ISSUES IS A FAILED READ (2026-09-01 audit). `: []` turned any
    // body that was not an array into "this environment has no unresolved issues", and zero
    // issues is not neutral here: reconcile() auto-resolves every row this producer filed and did
    // not re-cover, posting "Sentry no longer lists this as an unresolved error" over live
    // production errors. Same defect checksFrom() closed in check-healthchecks-down.mjs today.
    for (const i of issuesFrom(raw, env)) {
      const existing = found.get(String(i.id))
      if (existing) { existing.environments.push(env); continue }
      const issue = mapIssue(i)
      issue.environments.push(env)
      found.set(issue.id, issue)
    }
      cursor = nextCursor(link)
      if (!cursor) break
      // Refusing to guess is this file's whole contract. A truncated read must never be allowed to
      // auto-resolve rows it never looked at, so an unexpectedly deep list fails the run instead.
      if (page === MAX_ISSUE_PAGES) {
        throw new Error(`Sentry still had more unresolved issues for "${env}" after ${MAX_ISSUE_PAGES} pages of 100 - refusing to judge, and to auto-resolve, on a partial list`)
      }
    }
  }
  return { issues: [...found.values()], liveEnvironments: envNames }
}

function boBase() {
  return (process.env.BOARD_SUPABASE_URL || BO_PROD).replace(/\/+$/, '')
}

async function boGetOnce(secret, path) {
  let res
  try {
    res = await fetch(`${boBase()}/rest/v1/${path}`, {
      headers: { apikey: secret, Authorization: `Bearer ${secret}`, 'User-Agent': NON_BROWSER_UA },
    })
  } catch (e) {
    throw transient(`GET ${path} -> ${e.message}`)
  }
  if (!res.ok) {
    const msg = `GET ${path} -> HTTP ${res.status}`
    throw TRANSIENT_STATUS.has(res.status) ? transient(msg) : new Error(msg)
  }
  return res.json()
}

const boGet = (secret, path) => readWithRetry(() => boGetOnce(secret, path), 'board')

async function fileSignal(secret, body) {
  const res = await fetch(`${boBase()}/functions/v1/signal-intake`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
      'User-Agent': NON_BROWSER_UA,
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`signal-intake -> HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`)
  return res.json()
}

async function main() {
  const dry = process.argv.includes('--dry')
  const token = readSentryToken()

  const { issues, liveEnvironments: envs } = await fetchLiveIssues(token)
  console.log(
    `sentry: ${issues.length} unresolved issue(s) seen in a live environment ` +
    `(${envs.join(', ')}), org ${SENTRY_ORG}`,
  )
  for (const i of issues) {
    console.log(`  ${i.shortId} (${i.project}) x${i.count} last ${i.lastSeen} [${i.environments.join(', ')}]`)
  }

  if (dry) { console.log('--dry: the board was not read and nothing was written.'); return 0 }

  const secret = readBoSecret()
  const rows = await boGet(
    secret,
    `fleet_signals?source=eq.${SOURCE}&select=key,state,resolved_at,detail,title`,
  )
  const plan = reconcile(issues, rows)

  for (const { issue, key, refresh } of plan.file) {
    await fileSignal(secret, signalFor(issue, key))
    console.log(`  ${refresh ? 'refreshed' : 'FILED'}: ${issue.shortId} as ${SOURCE}/${key}`)
  }
  for (const { issue, key, row } of plan.reopen) {
    await fileSignal(secret, signalFor(issue, key))
    console.log(
      `  REOPENED: ${issue.shortId} (${SOURCE}/${key}) - the board resolved it ${row.resolved_at}, ` +
      `Sentry has seen it again since (${issue.lastSeen})`,
    )
  }
  for (const { issue, key, row } of plan.leave) {
    console.log(
      `  left resolved: ${issue.shortId} (${SOURCE}/${key}) - still unresolved in Sentry, but ` +
      `nothing has been seen since the board closed it on ${row.resolved_at}`,
    )
  }
  for (const { row } of plan.resolve) {
    await fileSignal(secret, {
      source: SOURCE, key: row.key, kind: 'incident', severity: 'info', state: 'resolved',
      title: `Cleared in Sentry: ${row.title}`,
      summary: 'Sentry no longer lists this as an unresolved error on a live environment.',
      detail: { filed_by: FILED_BY },
      link: 'https://cockpit.predivo.ch/signals',
    })
    console.log(`  cleared: ${SOURCE}/${row.key} - resolved in Sentry, so the signal is resolved.`)
  }

  console.log(
    `sentry: ${plan.file.length} filed or refreshed, ${plan.reopen.length} reopened, ` +
    `${plan.leave.length} left resolved, ${plan.resolve.length} cleared.`,
  )
  return 0
}

if (import.meta.url === (await import('url')).pathToFileURL(process.argv[1] || '').href) {
  main().then(
    (code) => { process.exitCode = code },
    (e) => {
      console.error(`::error::the Sentry check could NOT run (${e.message}). Unknown is not healthy.`)
      process.exitCode = 1
    },
  )
}
