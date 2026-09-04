#!/usr/bin/env node
/**
 * THE BOARD EMPTIES ITSELF, OR IT DOES NOT EMPTY.
 *
 * WHY THIS EXISTS. Measured on the live work board on 2026-09-03: 229 open items
 * (135 next, 27 in_progress, 37 blocked, 30 awaiting_signoff) against 392 done, and over the
 * preceding fourteen days 43.5 items were opened per day against 28.4 closed. Fifteen new rows a
 * day, forever. That arithmetic has exactly one cause and it is not laziness: NOT ONE ITEM ON THE
 * BOARD STATES WHAT FINISHED MEANS. Closing therefore requires a human to read a row, remember
 * what it was about, go and look, and decide — so closing is the step that gets skipped, while
 * opening costs one tool call.
 *
 * `work_items.done_when` (added separately) is the missing half: a machine-checkable sentence
 * about when a row stops being true. This script is the other half — it reads those sentences
 * hourly, evaluates them, and closes what passes, with no human and no interactive session in the
 * loop. An item that cannot say when it is finished still never closes itself, and that is correct:
 * the fix for such a row is to give it a finish-test, not to guess on its behalf.
 *
 * ── THE THREE STATES, AND WHY THE THIRD IS THE WHOLE FILE ─────────────────────────────────────
 *
 * scripts/lib/check-verdict.mjs documents this house's most expensive failure class: a job that
 * reports success for doing nothing. Eight instances on 2026-09-02, six more on 2026-09-03. Every
 * evaluator below therefore answers pass / fail / UNKNOWN, and unknown closes NOTHING:
 *
 *   pass     I reached the thing the row is about, and it is finished.
 *   fail     I reached it, and it is not finished. The row stays open. This is a normal answer.
 *   unknown  I did not reach it. NEVER a pass, never a close, and it is an incident about ME.
 *
 * This script is the most dangerous possible host for that failure, because here a blind sensor
 * does not merely stay quiet — it DELETES WORK. A `query_returns_no_rows` test against a stubbed,
 * revoked or renamed dependency answers "no rows" perfectly cheerfully, and every row on the board
 * would close itself in one run. So two positive canaries run before anything is believed:
 *
 *   proveQueryPath    a sentinel `select 1` must come back as one row saying 1. A revoked grant, a
 *                     renamed table, a wrong project ref and a stubbed fetch all answer HTTP 200
 *                     with `[]`, which is indistinguishable from a genuine empty result unless
 *                     something known-non-empty is asked for in the same breath.
 *   proveNetworkPath  a hostname that CANNOT resolve must fail to resolve. If it answers, this
 *                     process's fetch is intercepted and no `url_answers` verdict means anything.
 *
 * A canary is not decoration: both are the difference between "the query returned nothing" and
 * "nothing answered the query", and only one of those is a reason to close somebody's work.
 *
 * ── ONLY CLOSE WHAT THE BOARD ITSELF AGREES TO CLOSE ─────────────────────────────────────────
 *
 * A pass never writes to the database. It calls Cockpit's own `workEvidence` and `workClose`
 * (Cockpit/mcp/lib/tools.mjs), so every guard those already carry still applies to a close made by
 * a machine at 03:00: the documentation_ref must resolve to a real file or a live URL, the
 * production proof must hold, `unstartedSignoffRefusal` still refuses a row nothing was ever built
 * for, and an item Roger has already been asked about is left alone. Writing straight to
 * `work_items` would bypass all of it, and the fifteen items closed in one day on 2026-08-24 on an
 * agent's reading of "this looks finished" are why that is not an option.
 *
 * The consequence is worth stating plainly rather than hiding in a count: a passing finish-test
 * does not always mean `done`. When the production proof does not hold, workClose parks the item
 * at `awaiting_signoff` in Roger's lane. That is the board's decision, not this script's, and the
 * two outcomes are reported as two different numbers — CLOSED and HANDED TO ROGER — because
 * reporting them as one would be this repo's other favourite lie.
 *
 * ── WHAT IS DELIBERATELY NEVER TOUCHED ───────────────────────────────────────────────────────
 *
 *   `human`             a question for a person cannot be answered by a machine. Skipped whole:
 *                       not evaluated, not counted as unknown, no evidence filed. Silence here is
 *                       correct, and it is the ONLY place in this file where silence is correct.
 *   `awaiting_signoff`  already in Roger's lane, waiting on his word. Closing one behind his back
 *                       is the exact thing the sign-off gate exists to prevent.
 *   `done`/`abandoned`  already closed.
 *
 * ── done_when IS UNTRUSTED INPUT ─────────────────────────────────────────────────────────────
 *
 * Any agent with a board token can write a `done_when`, and this process runs on Roger's machine
 * holding management tokens for the whole fleet. So `test_exits_zero` runs only a path that ends
 * `.test.mjs`/`.test.js`, resolves inside an allow-listed root, and is spawned with no shell and
 * no caller-supplied arguments (the same rule Cockpit/mcp/lib/prodref.mjs already applies to a
 * test-suite proof); `query_returns_no_rows` accepts one read-only statement and refuses anything
 * carrying a second statement or a writing verb. A malformed or refused finish-test is UNKNOWN,
 * never pass — a row must not be able to close itself by being unreadable.
 *
 * ── CONTRACT ─────────────────────────────────────────────────────────────────────────────────
 *
 *   node scripts/close-finished-items.mjs [--dry] [--json] [--verbose]
 *
 *   DRY IS THE DEFAULT. Closing requires CLOSER_CONFIRM to be set in the environment, so an
 *   accidental run — a copied command line, a scheduler pointed at the wrong script, a curious
 *   session — evaluates everything and closes nothing.
 *
 *   env: CLOSER_CONFIRM     must be set for anything to close at all.
 *        CLOSER_MAX         most items one run may close (default 25). A first real run must not
 *                           be able to move a hundred rows before anybody has read one.
 *        CLOSER_TEST_ROOTS  path-delimited roots a test_exits_zero path may live under.
 *        SENTRY_API_TOKEN   optional; otherwise read from BackOffice's credentials file.
 *   Board credentials are read INSIDE the process from ~/.claude.json -> mcpServers['cockpit-mcp']
 *   .env. No secret is ever passed on a command line, printed, or logged, in whole or in part.
 *
 * Exit 0 = judged (including "found things and closed them" — a filed action exits 0, the house
 *          rule in scripts/lib/fleet-signal.mjs).
 * Exit 1 = could not tell. The board could not be read, or nothing could be evaluated at all.
 *
 * This file is named `close-*` rather than `check-*`, so it is NOT swept by the glob in
 * test/a-check-cannot-pass-without-reaching-its-dependency.test.mjs. It honours that contract
 * anyway — every blind path here calls sayVerdict(UNKNOWN, ...) — and its own suite,
 * test/close-finished-items.test.mjs, breaks each dependency five ways and asserts nothing closes.
 */
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, delimiter, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { homedir } from 'node:os'

import { sayVerdict, PASS, FAIL, UNKNOWN } from './lib/check-verdict.mjs'

const CLAUDE_CONFIG = join(homedir(), '.claude.json')
const COCKPIT_TOOLS = 'C:/Business/Internal Projects/Cockpit/mcp/lib/tools.mjs'
const BO_CREDS = 'C:/Business/Internal Projects/BackOffice/docs/Credentials.txt'
const SENTRY_API = 'https://sentry.io/api/0'
const SENTRY_ORG = 'predivo-gmbh'   // the one org, same constant scripts/check-sentry-issues.mjs pins
const DEFAULT_TEST_ROOTS = ['C:/Business/Internal Projects']
const DEFAULT_MAX_CLOSURES = 25

/**
 * Statuses this job may act on.
 *
 * `awaiting_signoff` is absent on purpose and it is the single most important line in this
 * constant: those rows are already parked in Roger's lane with a question addressed to him. A
 * machine closing one is not automation, it is answering on his behalf.
 */
export const ACTIONABLE_STATUSES = ['next', 'in_progress', 'blocked']

/** A row this script must never touch, whatever its finish-test says. */
export const UNTOUCHABLE_STATUSES = ['done', 'abandoned', 'awaiting_signoff']

/**
 * A QUESTION OWED TO ROGER IS THE OTHER HALF OF HIS LANE, AND IT WAS NOT PROTECTED.
 *
 * The comment above ACTIONABLE_STATUSES already says it: a row parked in his lane with a question
 * addressed to him must not be closed by a machine, because that is "answering on his behalf".
 * UNTOUCHABLE_STATUSES enforced that for `awaiting_signoff` and NOT for `blocked` — and this file
 * did not mention `blocked_question` or `blocked_owner` even once. sql/092 builds his list as
 * `awaiting_signoff` OR a question recorded against him, so a blocked row is in his lane by exactly
 * the same right, and sql/096 exists because such a question was once deleted by a side effect.
 *
 * A row blocked on a VENDOR or a CLIENT is a different thing and stays closeable: the finish-test
 * passing is real news about it, and nobody is being answered for.
 */
export function isOwedToRoger(item) {
  if (!item) return false
  if (String(item.blocked_owner || '').toLowerCase() === 'roger') return true
  return item.status === 'blocked' && Boolean(String(item.blocked_question || '').trim())
}

/**
 * A ROW IN HIS LANE THAT ASKS HIM NOTHING IS NOT A DECISION.
 *
 * WHY (measured on the live board 2026-09-03): his lane held 50 rows, and 21 of them carried no
 * question at all. They were not silent by choice. `public.upsert_signal` (BackOffice migration
 * 139) had its two text fields backwards -- `detail` MERGED while `decision_question` REPLACED --
 * and every producer calls it without `p_decision_question`, whose default is null. So each
 * producer pass overwrote the ask with nothing. BackOffice migration 167 fixed the cause on
 * 2026-09-03 (null now means "I am not talking about the question"); 16 of the erased asks were
 * restored from the rows' own evidence trails the same day.
 *
 * THE CAUSE IS FIXED, SO THIS IS NOT A CLEANUP -- IT IS THE ALARM THAT WAS MISSING. The defect
 * ran for an unknown length of time and nothing noticed, because an empty question is invisible:
 * the row still appears in his lane, still says NEEDS ROGER, and the board cannot tell a row that
 * wants nothing from a row whose want was deleted. Roger's own words on the board's purpose are
 * that it should reach him "only really if there is a real decision to be made by my side" -- a
 * row that states no decision is the exact opposite of that, and it costs him the same attention.
 *
 * This never closes, moves or edits anything. It counts, and it says what it counted, so that the
 * next time a producer erases an ask the number moves instead of the lane quietly emptying.
 */
export function silentRowsInHisLane(items = []) {
  return (items || []).filter((it) => isOwedToRoger(it) && !String(it?.blocked_question || '').trim())
}

export const SKIP = 'skip'

// ── the pure core ────────────────────────────────────────────────────────────────────────────

/** Every kind this job understands, and which args each one cannot work without. */
export const KINDS = {
  sentry_resolved: ['issue_id'],
  query_returns_no_rows: ['sql'],
  url_answers: ['url', 'status'],
  test_exits_zero: ['path'],
  deploy_newer_than: ['project_ref', 'function_slug', 'iso'],
  metric_below: ['name', 'threshold', 'days'],
  human: ['question'],
}

const finding = (state, reason, extra = {}) => ({ state, reason, ...extra })
export const unknown = (reason, extra) => finding(UNKNOWN, reason, extra)
export const pass = (reason, extra) => finding(PASS, reason, extra)
export const fail = (reason, extra) => finding(FAIL, reason, extra)

/**
 * Read a stored `done_when` into `{ ok, kind, args }`, or say why it cannot be read.
 *
 * MALFORMED IS UNKNOWN, NEVER PASS, and never silently skipped either. A row whose finish-test is
 * gibberish is a row whose finish-test nobody has checked since it was written; that is a fact
 * somebody needs, and dropping it from the counts is how a typo becomes permanent.
 */
export function parseDoneWhen(raw) {
  if (raw === null || raw === undefined) return { ok: false, reason: 'no done_when' , absent: true }
  let doc = raw
  if (typeof doc === 'string') {
    const text = doc.trim()
    if (!text) return { ok: false, reason: 'done_when is an empty string' }
    try { doc = JSON.parse(text) } catch (e) { return { ok: false, reason: `done_when is not valid JSON (${e.message})` } }
  }
  if (Array.isArray(doc) || typeof doc !== 'object' || doc === null) {
    return { ok: false, reason: `done_when must be an object, got ${Array.isArray(doc) ? 'an array' : typeof doc}` }
  }
  const kind = doc.kind
  if (typeof kind !== 'string' || !kind.trim()) return { ok: false, reason: 'done_when has no `kind`' }
  if (!Object.hasOwn(KINDS, kind)) {
    return { ok: false, reason: `done_when kind "${kind}" is not one this job understands (${Object.keys(KINDS).join(', ')})` }
  }
  // `args` may be nested or written flat beside `kind`. Accepting both is not laxity: a finish-test
  // is hand-written by whoever opened the row, and refusing the flat spelling would turn a
  // cosmetic difference into an item that silently never closes.
  const args = (doc.args && typeof doc.args === 'object' && !Array.isArray(doc.args)) ? doc.args : doc
  const missing = KINDS[kind].filter((k) => args[k] === undefined || args[k] === null || args[k] === '')
  if (missing.length) return { ok: false, reason: `done_when ${kind} is missing ${missing.join(', ')}` }
  return {
    ok: true,
    kind,
    args,
    // Optional receipts a finish-test may carry so a passing row can satisfy workClose's own gates
    // without this script inventing either. Never required, never invented.
    documentation_ref: typeof doc.documentation_ref === 'string' ? doc.documentation_ref : null,
    production_ref: typeof doc.production_ref === 'string' ? doc.production_ref : null,
  }
}

/** A Sentry status that means somebody dealt with it. `ignored` counts: it is a decision. */
export function sentryStatusIsSettled(status) {
  return ['resolved', 'resolvedinnextrelease', 'ignored', 'muted'].includes(String(status || '').toLowerCase())
}

/**
 * Is this SQL safe to run as a finish-test? PURE, so the rule is testable without a database.
 *
 * `done_when` is written by any agent holding a board token and evaluated by a process holding
 * management tokens for the whole fleet, so this is a privilege boundary, not tidiness. One
 * read-only statement, and a refusal is UNKNOWN — a row must not close itself by being refused.
 */
export function sqlIsReadOnly(sql) {
  const text = String(sql || '').trim()
  if (!text) return { ok: false, reason: 'empty sql' }
  // Strip line comments and block comments before judging: `-- drop` is not a verb, and
  // `select 1 /*;*/ ; drop table x` must not hide behind one.
  const bare = text.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').trim()
  if (!/^(select|with)\b/i.test(bare)) return { ok: false, reason: 'sql must begin with SELECT or WITH' }
  if (bare.replace(/;\s*$/, '').includes(';')) return { ok: false, reason: 'sql carries more than one statement' }
  const banned = /\b(insert|update|delete|drop|truncate|alter|create|grant|revoke|copy|call|do|vacuum|refresh|reindex|comment|security\s+label)\b/i
  const hit = bare.match(banned)
  if (hit) return { ok: false, reason: `sql contains a writing verb (${hit[1].toLowerCase()})` }
  return { ok: true }
}

/**
 * Is this path one we are willing to execute? PURE except for the caller-supplied `exists`.
 *
 * Mirrors Cockpit/mcp/lib/prodref.mjs's test-suite proof deliberately: a test file, inside an
 * allow-listed root, run with no shell and no arguments. A path that does not exist is UNKNOWN and
 * not fail — a deleted test file is a stale finish-test, which is a fact about the row, not a
 * verdict about the work.
 */
export function testPathIsRunnable(path, { roots = testRoots(), exists = existsSync } = {}) {
  const raw = String(path || '').trim()
  if (!raw) return { ok: false, reason: 'no test path' }
  if (!isAbsolute(raw)) return { ok: false, reason: `"${raw}" is not an absolute path` }
  if (!/\.test\.(mjs|js)$/i.test(raw)) return { ok: false, reason: `"${raw}" is not a .test.mjs / .test.js file` }
  const norm = resolve(raw).replace(/\\/g, '/').toLowerCase()
  const inRoot = roots.some((r) => {
    const root = resolve(r).replace(/\\/g, '/').toLowerCase().replace(/\/$/, '')
    return norm === root || norm.startsWith(`${root}/`)
  })
  if (!inRoot) return { ok: false, reason: `"${raw}" is outside every allow-listed root (${roots.join(', ')})` }
  if (!exists(raw)) return { ok: false, reason: `"${raw}" does not exist` }
  return { ok: true, resolved: raw }
}

/**
 * DRY IS THE DEFAULT, AND THE FLAG ONLY EVER TIGHTENS IT. Pure, and exported, because "an
 * accidental run closes nothing" is a property worth asserting rather than reading.
 *
 * Closing requires a deliberate CLOSER_CONFIRM in the environment. A command line cannot switch it
 * on, which is the point: command lines get copied, schedulers get repointed, and a session poking
 * at an unfamiliar script in this repo must not be able to empty somebody's board by running it.
 */
export function isDryRun(argv = process.argv, env = process.env) {
  if (argv.includes('--dry')) return true
  return !env.CLOSER_CONFIRM
}

/** Most items one run may close. A first real run must not move a hundred rows unwatched. */
export function closureCap(env = process.env) {
  const n = Number(env.CLOSER_MAX)
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MAX_CLOSURES
}

/**
 * UNION, NEVER REPLACE — and the variable used to be called `extra` while doing the opposite.
 *
 * Measured 2026-09-04 across three parallel sweeps of the board: at least eight open rows are
 * unclosable BY CONSTRUCTION, because their subject is a script under `~/.claude/scripts` or
 * `C:/ClaudeShared/scripts` and `testPathIsRunnable` refuses anything outside the roots — which
 * makes the row UNKNOWN, never FAIL. A perfect test could never clear them. The fleet's own
 * operator tooling was unreachable by the board's finish-test machinery, and nothing said so:
 * an out-of-root path and a genuinely unevaluatable check produce the identical verdict.
 *
 * Two halves to the fix and both are needed. The scheduled task now SETS `CLOSER_TEST_ROOTS`
 * (see setup-closer-task.ps1). And this function no longer lets that variable REPLACE the main
 * root: setting it used to silently drop `C:/Business/Internal Projects`, so a well-meant
 * "let it also see ClaudeShared" would have turned every product row UNKNOWN in one edit. That
 * is the same shape as a new exit code that only half-answers its contract.
 */
export function testRoots(env = process.env) {
  const extra = String(env.CLOSER_TEST_ROOTS || '').split(delimiter).map((s) => s.trim()).filter(Boolean)
  const out = [...DEFAULT_TEST_ROOTS]
  for (const r of extra) if (!out.includes(r)) out.push(r)
  return out
}

/**
 * Evaluate one finish-test. Async, pure apart from the injected `deps` — which is the point: the
 * suite breaks every one of them five ways and asserts the answer is unknown each time.
 *
 * Returns { state, reason } plus, where the evaluation itself produced one, a `production_ref`
 * that workClose can independently re-verify. Never a receipt this script wrote about itself.
 */
export async function evaluateDoneWhen(raw, deps = {}) {
  const parsed = parseDoneWhen(raw)
  if (!parsed.ok) {
    if (parsed.absent) return unknown('this item has no finish-test, so nothing about it can be judged', { no_test: true })
    return unknown(`malformed finish-test: ${parsed.reason}`, { malformed: true })
  }
  const { kind, args } = parsed

  /**
   * Fold the row's own receipts into a finding.
   *
   * ORDER MATTERS AND IT COST A RED TEST. Spreading the carried fields LAST wiped the
   * `production_ref` an evaluator had just derived (a green test path, a live 2xx URL) with the
   * done_when's own null, so every item that could have proved itself was handed to Roger instead.
   * A hand-written receipt still wins over a derived one — it is the author's deliberate answer —
   * but an absent one may never overwrite anything.
   */
  const withCarry = (f) => ({
    ...f,
    kind,
    documentation_ref: parsed.documentation_ref || null,
    production_ref: parsed.production_ref || f.production_ref || null,
  })

  if (kind === 'human') {
    return withCarry(finding(SKIP, `a question for Roger, not for a machine: "${String(args.question).slice(0, 160)}"`))
  }

  try {
    switch (kind) {
      case 'sentry_resolved': return withCarry(await evalSentry(args, deps))
      case 'query_returns_no_rows': return withCarry(await evalQuery(args, deps))
      case 'url_answers': return withCarry(await evalUrl(args, deps))
      case 'test_exits_zero': return withCarry(await evalTest(args, deps))
      case 'deploy_newer_than': return withCarry(await evalDeploy(args, deps))
      case 'metric_below': return withCarry(evalMetric(args))
      default: return withCarry(unknown(`no evaluator for kind "${kind}"`))
    }
  } catch (e) {
    // A THROW IS UNKNOWN, ALWAYS. Every evaluator below already turns its own expected failures
    // into an explicit unknown; this catches the unexpected ones, and the unexpected ones are
    // exactly the class that would otherwise crash the run after some rows had already closed.
    return withCarry(unknown(`the finish-test could not be evaluated (${String(e && e.message ? e.message : e).slice(0, 200)})`))
  }
}

async function evalSentry(args, deps) {
  const read = deps.sentryIssue || realSentryIssue
  const issue = await read(String(args.issue_id))
  if (!issue || typeof issue !== 'object' || Array.isArray(issue)) {
    return unknown(`Sentry did not return an issue object for ${args.issue_id} — the read failed or answered with something else`)
  }
  const status = issue.status
  if (typeof status !== 'string' || !status.trim()) {
    return unknown(`Sentry's answer for issue ${args.issue_id} carries no status field, so nothing was established`)
  }
  if (sentryStatusIsSettled(status)) return pass(`Sentry issue ${args.issue_id} is "${status}"`)
  return fail(`Sentry issue ${args.issue_id} is still "${status}"`)
}

async function evalQuery(args, deps) {
  const safe = sqlIsReadOnly(args.sql)
  if (!safe.ok) return unknown(`the finish-test's query was refused: ${safe.reason}. A refused test proves nothing`)

  // A query finish-test MUST name the project it is asked about. It used to fall back to the board's
  // OWN project when project_ref was absent — but a done_when whose SQL is about ReplyFlow, answered
  // against the board's DB, returns zero rows and reads as PASS. That is "I cannot check this"
  // rendered as "it is finished": on 2026-09-04 a query naming its project only in a `-- comment`
  // (which nothing parses) was run against the board, returned zero rows, and was pushed to
  // awaiting_signoff on Roger's lane. So an absent project_ref is UNKNOWN, never the board — and the
  // named project still has to prove it can be opened below. Substituting the board's own project is
  // exactly the substitution that turns a non-answer into a false close, so it never happens.
  const ref = args.project_ref
  if (!ref) return unknown('this finish-test names no Supabase project_ref, so it cannot be run against the right database — the board\'s own project must never be substituted, or "I cannot check this" becomes "it is finished"')

  const prove = deps.proveQueryPath || realProveQueryPath
  const proof = await prove(ref)
  if (!proof.ok) {
    // THE CANARY IS THE WHOLE EVALUATOR. "No rows" is the passing answer here, and a dependency
    // that has stopped answering says exactly that. Without this, a revoked grant closes the board.
    return unknown(`the query path to ${ref} could not be proved (${proof.reason}), so "no rows" would mean "nothing answered", not "nothing matched"`)
  }

  const run = deps.runQuery || realRunQuery
  const { status, rows } = await run(ref, args.sql)
  if (status !== 200 && status !== 201) return unknown(`the finish-test query answered HTTP ${status} on ${ref}`)
  if (!Array.isArray(rows)) return unknown(`the finish-test query answered HTTP ${status} on ${ref} but returned no row array`)
  if (rows.length === 0) return pass(`the finish-test query returned zero rows on ${ref} (sentinel query confirmed the path is answering)`)
  return fail(`the finish-test query still returns ${rows.length} row(s) on ${ref}`)
}

async function evalUrl(args, deps) {
  const want = Number(args.status)
  if (!Number.isFinite(want)) return unknown(`"${args.status}" is not a status code`)

  const prove = deps.proveNetworkPath || realProveNetworkPath
  const proof = await prove()
  if (!proof.ok) {
    // If a hostname that cannot exist answers, this process's fetch is not talking to the internet,
    // and every status code it reports is a fiction. Measured, not assumed: the fault injector in
    // test/a-check-cannot-pass-without-reaching-its-dependency.test.mjs makes every fetch answer
    // HTTP 200, which is precisely the shape that would close a `url_answers 200` row while blind.
    return unknown(`this process's network path could not be proved (${proof.reason}), so no status code it reads means anything`)
  }

  const probe = deps.probeUrl || realProbeUrl
  const got = await probe(String(args.url))
  // `Number(null)` is 0 and `Number.isFinite(0)` is true, so an earlier version of this line read a
  // refused connection as "HTTP 0" and reported it as a legible FAIL — a verdict about a server
  // that never spoke. Found by the netdown injection in the suite, which is the only reason it is
  // not in production: a status that is not a real HTTP status is a non-answer, and a non-answer is
  // unknown. Requiring an integer of at least 100 is what makes "no status" impossible to mistake.
  const status = got && typeof got.status === 'number' && Number.isInteger(got.status) && got.status >= 100 ? got.status : null
  if (status === null) {
    return unknown(`${args.url} did not answer with an HTTP status at all (${got && got.error ? got.error : `got ${JSON.stringify(got && got.status)}`})`)
  }
  if (status !== want) return fail(`${args.url} answers HTTP ${status}, not ${want}`)
  // A 2xx product URL is a proof shape workClose can re-verify for itself; a 401/403/404 is not,
  // however legitimate a finish-test it makes. Handing over a receipt the board would refuse is
  // worse than handing over none: it looks like proof in the log and fails at the gate.
  return pass(`${args.url} answers HTTP ${status} as required`, status >= 200 && status < 300 ? { production_ref: String(args.url) } : {})
}

async function evalTest(args, deps) {
  const ok = testPathIsRunnable(String(args.path), { roots: deps.testRoots || testRoots(), exists: deps.exists || existsSync })
  if (!ok.ok) return unknown(`the finish-test's test file was refused: ${ok.reason}. A test that cannot be run has not failed, it has not been asked`)
  const run = deps.runTest || realRunTest
  const result = await run(ok.resolved)
  if (!result || result.code === null || result.code === undefined) {
    return unknown(`${args.path} could not be run (${result && result.error ? result.error : 'no exit code'})`)
  }
  if (result.code === 0) return pass(`${args.path} runs and exits 0`, { production_ref: ok.resolved })
  return fail(`${args.path} exits ${result.code}`)
}

async function evalDeploy(args, deps) {
  const wanted = Date.parse(args.iso)
  if (Number.isNaN(wanted)) return unknown(`"${args.iso}" is not a timestamp this can compare against`)
  const read = deps.deployedAt || realDeployedAt
  const live = await read(String(args.project_ref), String(args.function_slug))
  if (!live || !live.updated_at) {
    return unknown(`the live updated_at for ${args.function_slug} on ${args.project_ref} could not be read (${live && live.error ? live.error : 'no answer'})`)
  }
  const at = Date.parse(live.updated_at)
  // Date.parse gives NaN for an unparseable value, and every NaN comparison is false — which reads
  // as "not newer", the quiet direction. Refuse it instead, exactly as check-edge-code-live does.
  if (Number.isNaN(at)) return unknown(`${args.function_slug} on ${args.project_ref} reports updated_at "${live.updated_at}", which cannot be compared`)
  if (at > wanted) return pass(`${args.function_slug} on ${args.project_ref} was last deployed ${live.updated_at}, after ${args.iso}`)
  return fail(`${args.function_slug} on ${args.project_ref} was last deployed ${live.updated_at}, which is not after ${args.iso}`)
}

/**
 * TODO (deliberate stub, and it stays unknown until it is real).
 *
 * There is no metric store in this fleet that a job can ask "what was <name> over the last <days>".
 * Numbers live in Supabase tables, healthchecks, GitHub's API and a dashboard, each with its own
 * shape, and picking one here would mean inventing a registry nobody writes to — which is how a
 * check ends up reporting confidently about a population of zero.
 *
 * TO FINISH THIS: give `metric_below` a `source` naming an existing reader (a Supabase project +
 * read-only SQL is the obvious first one, and `query_returns_no_rows` already proves that path),
 * evaluate it through that reader, and hold it to the same canary rule — a metric that reads as
 * absent must be unknown, never "below the threshold".
 */
function evalMetric(args) {
  return unknown(
    `metric_below is not implemented: there is no metric store this job can ask for "${args.name}" over ${args.days} day(s). ` +
    'Nothing is known about this item, and an unimplemented test is never a pass. See the TODO in scripts/close-finished-items.mjs.',
    { todo: true },
  )
}

/**
 * The one sentence, and the verdict that decides the exit code.
 *
 * Modelled on check-edge-code-live.mjs's verdict(): a count printed beside a verdict does not
 * change the verdict, so the reassuring branches are the ones written most defensively.
 *
 *   UNKNOWN/1  the board could not be read, or there were no open items at all (the board is never
 *              empty — an empty answer is a broken sensor), or every finish-test came back unknown.
 *   UNKNOWN/0  some finish-tests could not be evaluated. Work was still done, so the run is not an
 *              error, but it may not print itself as clean either.
 *   FAIL/0     the board was read and NOT ONE open item carries a finish-test. A real finding
 *              about the board, and today's actual answer.
 *   PASS/0     every finish-test was evaluated and acted on.
 */
export function verdict({ boardRead, open = 0, evaluated = 0, skipped = 0, passes = 0, fails = 0, unknowns = 0, closed = 0, handed = 0, refused = 0, dry = false, reason = '' }) {
  if (!boardRead) {
    return { state: UNKNOWN, code: 1, level: 'error', headline: `the work board could not be read (${reason}). Nothing was evaluated and nothing was closed; this is a broken job, not an empty board` }
  }
  if (open === 0) {
    return { state: UNKNOWN, code: 1, level: 'error', headline: 'the work board returned ZERO open items. It had 229 on 2026-09-03 and grows fifteen a day, so an empty answer is a renamed column, a revoked grant or a wrong filter — a broken sensor, never a finished board' }
  }
  if (evaluated === 0 && skipped === 0) {
    return { state: FAIL, code: 0, level: 'warning', headline: `not one of ${open} open item(s) carries a finish-test, so nothing on this board can close itself. Nothing was evaluated because there was nothing to evaluate — the fix is a done_when on each row, not a change to this job` }
  }
  if (evaluated > 0 && passes === 0 && fails === 0) {
    return { state: UNKNOWN, code: 1, level: 'error', headline: `all ${evaluated} finish-test(s) came back unknown — not one dependency could be reached, so nothing is known about any of them (${open} open item(s) on the board)` }
  }
  const tail = `${evaluated} finish-test(s) of ${open} open item(s) evaluated: ${passes} passed, ${fails} not finished yet, ${unknowns} could NOT be evaluated, ${skipped} left for Roger` +
    (dry ? ` — DRY RUN, nothing was closed (${passes} would have been offered to the board)` : `; ${closed} closed, ${handed} handed to Roger for sign-off, ${refused} refused by the board`)
  if (unknowns > 0) {
    return { state: UNKNOWN, code: 0, level: 'warning', headline: `this is NOT a clean sweep: ${tail}` }
  }
  return { state: PASS, code: 0, level: 'log', headline: tail }
}

/** The receipt filed BEFORE a close, so the reason a row closed outlives the log line. */
export function receiptFor(item, f) {
  return {
    item: item.slug,
    kind: 'gate',
    title: `Finish-test passed: ${f.kind}`,
    detail: [
      `This item declared how it would know it was finished, and a machine checked it.`,
      `Finish-test: ${f.kind}`,
      `Evaluated at: ${new Date().toISOString()} by production-monitor/scripts/close-finished-items.mjs`,
      `Result: PASS — ${f.reason}`,
      f.production_ref ? `Production proof offered to work_close: ${f.production_ref}` : 'No production proof was produced by the finish-test itself.',
    ].join('\n'),
  }
}

/**
 * THE ONE PLACE THAT DECIDES WHAT GETS OFFERED TO THE BOARD.
 *
 * Written as a single exported function rather than inline in main() for one reason: it makes
 * "a blind dependency closes NOTHING" a property the suite can assert directly, over every kind at
 * once, instead of a claim about code somebody has read. `offer` is called for passes and for
 * nothing else — not for a fail, not for an unknown, not for a `human` row — and the suite proves
 * that by breaking each dependency five ways and asserting `offer` was never reached.
 */
export async function sweep(items, { deps = {}, offer = null, max = Infinity } = {}) {
  const results = []
  for (const item of items || []) {
    if (item.done_when === null || item.done_when === undefined) continue
    results.push({ item, f: await evaluateDoneWhen(item.done_when, deps) })
  }
  const buckets = {
    results,
    skipped: results.filter((r) => r.f.state === SKIP),
    passes: results.filter((r) => r.f.state === PASS),
    fails: results.filter((r) => r.f.state === FAIL),
    unknowns: results.filter((r) => r.f.state === UNKNOWN),
    outcomes: [],
    deferred: 0,
  }
  if (!offer) return buckets
  for (const r of buckets.passes.slice(0, max)) buckets.outcomes.push(await offer(r.item, r.f))
  buckets.deferred = Math.max(0, buckets.passes.length - buckets.outcomes.length)
  return buckets
}

/**
 * Which items this job may look at at all, and why each rejected one was rejected.
 *
 * THREE LISTS, NOT TWO — AND THE THIRD IS THE ONE THAT TAKES WORK OFF ROGER.
 *
 * Measured on the live board 2026-09-04: of 31 open rows carrying a finish-test that had NEVER
 * been evaluated, 20 are `kind: human` and correctly none of a machine's business — but **eleven
 * carry a machine-checkable check and had never once been run**, because they are owed to Roger
 * and this function dropped them before `sweep` ever saw them.
 *
 * JUDGING IS NOT ACTING, AND CONFLATING THEM COST HIM HIS OWN LANE. A row owed to Roger must
 * never be CLOSED by a machine — that rule is absolute and unchanged. But refusing to LOOK at it
 * is a different thing entirely, and it has a cost he pays: the world moves on, the question
 * becomes moot, and nothing anywhere notices. His lane can only ever grow. A verdict written onto
 * a blocked row costs him nothing and can tell him "the thing you were going to decide has
 * already resolved itself" — which is the only way a lane of questions gets shorter without him
 * answering every one of them.
 *
 * So: `judgeOnly` rows are swept with no `offer`, their verdict is recorded, and they are never
 * handed to `workClose`. `untouchable` keeps its original meaning — rows nothing here looks at,
 * which now means the wrong status, or owed to him with no machine check to run.
 */
export function selectItems(rows) {
  const actionable = []
  const judgeOnly = []
  const untouchable = []
  for (const r of rows || []) {
    if (UNTOUCHABLE_STATUSES.includes(r.status)) { untouchable.push(r); continue }
    if (!ACTIONABLE_STATUSES.includes(r.status)) { untouchable.push(r); continue }
    // A question addressed to Roger is his to answer, whatever the finish-test says. Held here
    // rather than at the close, so it never reaches workClose and never shows up as a near-miss.
    if (isOwedToRoger(r)) {
      if (r.done_when !== null && r.done_when !== undefined) judgeOnly.push(r)
      else untouchable.push(r)
      continue
    }
    actionable.push(r)
  }
  return { actionable, judgeOnly, untouchable }
}

// ── I/O ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Board credentials, read INSIDE this process and never spoken about.
 *
 * They are put onto process.env because Cockpit/mcp/lib/db.mjs reads SUPABASE_URL and
 * SUPABASE_SERVICE_KEY at module-evaluation time and throws without them — which is also why
 * tools.mjs is imported dynamically further down, AFTER this has run.
 *
 * Returns key NAMES only. Nothing here ever returns, prints, or logs a value: a prefix is a secret
 * in the only sense that matters, because it narrows a guess.
 */
export function loadBoardCredentials({ configPath = CLAUDE_CONFIG, read = readFileSync, env = process.env } = {}) {
  let cfg
  try { cfg = JSON.parse(read(configPath, 'utf-8')) } catch (e) {
    return { ok: false, reason: `could not read the MCP registration at ${configPath} (${e.code || e.message})` }
  }
  const entry = cfg && cfg.mcpServers && cfg.mcpServers['cockpit-mcp']
  const found = entry && entry.env
  if (!found || typeof found !== 'object') return { ok: false, reason: `${configPath} carries no mcpServers['cockpit-mcp'].env block` }
  const needed = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY']
  const absent = needed.filter((k) => !found[k])
  if (absent.length) return { ok: false, reason: `the cockpit-mcp registration is missing ${absent.join(' and ')}` }
  const applied = []
  for (const [k, v] of Object.entries(found)) {
    if (!env[k] && typeof v === 'string' && v) { env[k] = v; applied.push(k) }
  }
  return { ok: true, applied, url: found.SUPABASE_URL }
}

/** The Supabase project ref the board itself lives in, derived from its URL. Never a secret. */
export function boardProjectRef(env = process.env) {
  const m = /^https?:\/\/([a-z0-9]+)\.supabase\.co/i.exec(String(env.SUPABASE_URL || ''))
  return m ? m[1] : null
}

/** Read the open board. Throws on anything that is not a clean read — the caller turns that into
 *  an unknown, because "I could not read the board" must never look like "the board is empty". */
/**
 * WHAT THIS RUN DECIDED, WRITTEN DOWN ON THE ROW.
 *
 * ══ THE GAP ═════════════════════════════════════════════════════════════════════════════════
 *
 * sql/098 added three columns -- `done_when`, `done_checked_at`, `done_check_result` -- and only
 * the first was ever written by anything. Grepped across this whole repo: ZERO writes of the
 * other two. So this job evaluated a check, decided pass / not-yet / cannot-tell, printed it to
 * stdout on a headless laptop, and threw the answer away. Measured after the first real
 * scheduled run on 2026-09-03: 96 rows have carried a finish-test and `done_checked_at` is null
 * on every one of them.
 *
 * Three things were impossible because of it. Nobody could see WHICH checks had been evaluated
 * or what they said. A check that fails to be executable every single hour looked identical to a
 * check nobody had got to. And the work-board requirement's own §9 gate "nothing is fictional"
 * is defined as the count of rows whose stated check cannot be executed -- it reads
 * `done_check_result`, so it was pinned at `unknown` for ever, by construction.
 *
 * Same shape as the rest of this board's history: a column nothing writes, and a fact that
 * exists only on a page nobody reads.
 *
 * Pure so it can be tested without a board. Returns null for a row this run did not judge --
 * SKIP means "left for Roger", which is not a verdict about the check.
 */
export function evaluationStamp(f, now = () => new Date().toISOString()) {
  if (!f || typeof f !== 'object') return null
  const state = f.state
  if (state !== PASS && state !== FAIL && state !== UNKNOWN) return null
  return { done_checked_at: now(), done_check_result: state }
}

/**
 * Write the stamps. One PATCH per row, failures collected rather than thrown: a board that will
 * not take the bookkeeping must never stop the closing that already happened.
 */
export async function recordEvaluations(results, { env = process.env, fetchImpl = fetch, now = () => new Date().toISOString() } = {}) {
  const stat = { written: 0, skipped: 0, failed: [] }
  for (const r of results || []) {
    const stamp = evaluationStamp(r && r.f, now)
    if (!stamp || !r.item || !r.item.id) { stat.skipped++; continue }
    try {
      const res = await fetchImpl(`${env.SUPABASE_URL}/rest/v1/work_items?id=eq.${r.item.id}`, {
        method: 'PATCH',
        headers: {
          apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json', Prefer: 'return=minimal',
        },
        body: JSON.stringify(stamp),
        signal: AbortSignal.timeout(20_000),
      })
      if (!res.ok) { stat.failed.push(`${r.item.slug}: HTTP ${res.status}`); continue }
      stat.written++
    } catch (e) {
      stat.failed.push(`${r.item.slug}: ${String(e && e.message).slice(0, 120)}`)
    }
  }
  return stat
}

export async function readBoard({ env = process.env, fetchImpl = fetch } = {}) {
  const base = env.SUPABASE_URL
  const key = env.SUPABASE_SERVICE_KEY
  const statuses = ACTIONABLE_STATUSES.concat(UNTOUCHABLE_STATUSES.filter((s) => s === 'awaiting_signoff'))
  const q = `work_items?select=id,slug,title,status,done_when,documentation_ref,opened_at,started_at,claim_paths,blocked_question,blocked_owner` +
    `&status=in.(${statuses.join(',')})&order=opened_at.asc&limit=2000`
  const res = await fetchImpl(`${base}/rest/v1/${q}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  })
  const text = await res.text()
  if (!res.ok) {
    // The specific case worth naming: this job's whole input is a column another agent adds.
    // "column does not exist" is a deployment order problem, not a board problem, and saying so
    // saves the next person the twenty minutes it would otherwise cost.
    if (/work_items\.done_when does not exist/i.test(text)) {
      throw new Error('work_items.done_when does not exist yet — the finish-test column has not been added, so there is nothing for this job to evaluate')
    }
    throw new Error(`board read -> HTTP ${res.status}: ${text.slice(0, 200)}`)
  }
  let rows
  try { rows = JSON.parse(text) } catch { throw new Error(`board read answered HTTP ${res.status} with something that is not JSON`) }
  if (!Array.isArray(rows)) throw new Error(`board read answered HTTP ${res.status} but not with a row array`)
  return rows
}

function sentryToken(env = process.env) {
  if (env.SENTRY_API_TOKEN) return env.SENTRY_API_TOKEN.trim()
  const m = readFileSync(BO_CREDS, 'utf-8').match(/^SENTRY_API_TOKEN:\s*(\S+)/m)
  if (!m) throw new Error(`no SENTRY_API_TOKEN available`)
  return m[1]
}

/**
 * ORG-SCOPED FIRST, AND THE ORDER WAS MEASURED, NOT GUESSED.
 *
 * The obvious address — `/api/0/issues/<id>/` — answers HTTP 404 for this org's own issues with
 * this org's own token (probed live 2026-09-03 against issue 141893005, which is `resolved`), while
 * `/api/0/organizations/predivo-gmbh/issues/<id>/` answers 200. Written the obvious way round,
 * every `sentry_resolved` row in the fleet would have been permanently unknown and nobody would
 * have had a reason to look: unknown is a quiet, safe, entirely plausible answer, and "the issue
 * is not visible to us" reads exactly like a token problem. The bare path is kept as a fallback
 * for a token scoped some other way; a 404 from both is a real refusal and throws, because a
 * failed read is unknown and unknown must never be quiet here.
 */
export const SENTRY_ISSUE_PATHS = (org, issueId) => [
  `/organizations/${org}/issues/${encodeURIComponent(issueId)}/`,
  `/issues/${encodeURIComponent(issueId)}/`,
]

async function realSentryIssue(issueId) {
  const token = sentryToken()
  const errors = []
  for (const path of SENTRY_ISSUE_PATHS(SENTRY_ORG, issueId)) {
    const res = await fetch(`${SENTRY_API}${path}`, {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'work-board-closer/1.0' },
      signal: AbortSignal.timeout(20_000),
    })
    if (res.ok) return res.json()
    errors.push(`${path} -> HTTP ${res.status}`)
  }
  throw new Error(`Sentry could not be read (${errors.join('; ')})`)
}

const queryPathProofs = new Map()
const managementTokens = new Map()

async function managementTokenFor(ref) {
  if (managementTokens.has(ref)) return managementTokens.get(ref)
  const pending = (async () => {
    const { tokenForProject } = await import('./lib/local-management-tokens.mjs')
    return tokenForProject(ref)
  })()
  managementTokens.set(ref, pending)
  return pending
}

/**
 * THE SENTINEL. `select 1 as canary` must come back as exactly one row saying 1.
 *
 * Cached per project ref per process, because it is asked once per finish-test and the answer
 * cannot change mid-run in a way that would make an earlier close wrong.
 */
async function realProveQueryPath(ref) {
  if (queryPathProofs.has(ref)) return queryPathProofs.get(ref)
  const pending = (async () => {
    try {
      const { status, rows } = await realRunQuery(ref, 'select 1 as canary')
      if (status !== 200 && status !== 201) return { ok: false, reason: `sentinel query answered HTTP ${status}` }
      if (!Array.isArray(rows) || rows.length !== 1) return { ok: false, reason: `sentinel query returned ${Array.isArray(rows) ? `${rows.length} rows` : 'no row array'} instead of one` }
      if (Number(rows[0].canary) !== 1) return { ok: false, reason: 'sentinel query returned a row that does not say 1' }
      return { ok: true }
    } catch (e) {
      return { ok: false, reason: String(e && e.message ? e.message : e).slice(0, 160) }
    }
  })()
  queryPathProofs.set(ref, pending)
  return pending
}

async function realRunQuery(ref, sql) {
  const found = await managementTokenFor(ref)
  if (!found) throw new Error(`no management token on this disk opens ${ref}`)
  const { runSql } = await import('./lib/local-management-tokens.mjs')
  return runSql(ref, sql, found.token)
}

let networkProof = null

/**
 * THE OTHER SENTINEL. A hostname in the reserved `.invalid` TLD cannot resolve, by RFC 2606. If it
 * answers, this process's fetch is stubbed or intercepted and no status code it reports is real.
 */
async function realProveNetworkPath() {
  if (networkProof) return networkProof
  networkProof = (async () => {
    const host = `closer-canary-${Date.now().toString(36)}.invalid`
    try {
      const res = await fetch(`https://${host}/`, { signal: AbortSignal.timeout(10_000) })
      return { ok: false, reason: `a hostname that cannot exist (${host}) answered HTTP ${res.status}, so this process's fetch is not reaching the internet` }
    } catch {
      return { ok: true }
    }
  })()
  return networkProof
}

async function realProbeUrl(url) {
  try {
    const res = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': 'work-board-closer/1.0' }, signal: AbortSignal.timeout(20_000) })
    return { status: res.status }
  } catch (e) {
    return { status: null, error: String(e && e.message ? e.message : e).slice(0, 160) }
  }
}

/** No shell, no caller-supplied arguments, and only a path testPathIsRunnable already accepted. */
async function realRunTest(absPath) {
  let cwd = dirname(absPath)
  for (let dir = cwd, i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'package.json'))) { cwd = dir; break }
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  try {
    const r = spawnSync(process.execPath, [absPath], { cwd, encoding: 'utf-8', timeout: 180_000, windowsHide: true, shell: false })
    if (r.error) return { code: null, error: r.error.message }
    if (r.status === null) return { code: null, error: 'the test process was killed or timed out' }
    return { code: r.status }
  } catch (e) {
    return { code: null, error: String(e && e.message ? e.message : e).slice(0, 160) }
  }
}

async function realDeployedAt(ref, slug) {
  const found = await managementTokenFor(ref)
  if (!found) return { updated_at: null, error: `no management token on this disk opens ${ref}` }
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/functions/${encodeURIComponent(slug)}`, {
    headers: { Authorization: `Bearer ${found.token}` },
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) return { updated_at: null, error: `functions/${slug} -> HTTP ${res.status}` }
  const body = await res.json()
  if (!body || typeof body !== 'object' || Array.isArray(body) || !body.updated_at) {
    return { updated_at: null, error: `functions/${slug} answered HTTP ${res.status} with no updated_at` }
  }
  return { updated_at: new Date(body.updated_at).toISOString() }
}

/**
 * Offer one passing item to the board. THE BOARD DECIDES, not this function.
 *
 * Evidence first and close second, in that order, because sql/077's trigger looks for the receipt
 * before it will accept the close — and because a close whose reason was never written down is the
 * same shallow close this whole gate exists to refuse.
 */
/**
 * A CHECK THAT IS ITSELF A RESOLVING ARTIFACT IS ITS OWN RECEIPT.
 *
 * ══ THE MEASUREMENT ═════════════════════════════════════════════════════════════════════════
 *
 * Live board 2026-09-03: **19 finish-tests PASS right now** and every one of them is refused by
 * this function for one reason — the row carries no `documentation_ref`. Nineteen rows, finished
 * and provable, held open by a missing field. Of 207 open rows only 23 carry a receipt at all.
 *
 * ══ WHY THIS IS NOT INVENTING A RECEIPT ═════════════════════════════════════════════════════
 *
 * `work_close` refuses prose because prose is not a receipt. But for two of the seven check kinds
 * the check IS a document, and one that was just PROVEN to resolve seconds earlier by this very
 * run:
 *
 *   test_exits_zero  the test file was located AND EXECUTED AND EXITED 0. A test is the written
 *                    record of what "finished" required for that row — it is more precise than the
 *                    prose note somebody would otherwise have typed.
 *   url_answers      the URL was FETCHED and answered the expected status.
 *
 * So the reference is not derived, guessed or constructed. It is the exact artifact this run just
 * used to decide the row was finished, and `work_close` will independently re-verify it.
 *
 * ══ AND WHY THE OTHER FIVE KINDS GET NOTHING ════════════════════════════════════════════════
 *
 * `query_returns_no_rows` is 41 of the 78 open checks and CANNOT self-document: a SQL string is
 * not a file and not a URL, and writing the query text into `documentation_ref` would be exactly
 * the prose-as-receipt this gate exists to refuse. Same for `deploy_newer_than`, `metric_below`,
 * `sentry_resolved` and `human`. Those rows still need a real document, and saying so is the
 * honest answer — on 2026-09-03 a session wrote 205 finish-tests from proposals and 112 were
 * fiction, and every one of them looked like coverage.
 *
 * Returns the reference, or null when the check cannot honestly stand as its own receipt.
 */
export function selfDocumentingRef(doneWhen) {
  const dw = doneWhen && typeof doneWhen === 'object' ? doneWhen : {}
  const kind = String(dw.kind || '').trim()
  if (kind === 'test_exits_zero') {
    const path = String(dw.path || '').trim()
    return path || null
  }
  if (kind === 'url_answers') {
    const url = String(dw.url || '').trim()
    // PARSED, NOT PREFIX-MATCHED. The first version of this line tested only that the string
    // STARTED with http(s), and the very first preview run caught what that lets through: a live
    // row whose url reads "https://rlcsuqwqzoqjykdiqjye.supabase.co/rest/v1/ presenting the leaked
    // legacy service_role JWT" — a URL with prose glued on. That is one of the five ways the 112
    // fictional finish-tests of 2026-09-03 failed ("8 were not URLs, several of them prose with a
    // URL glued to the front"), and writing it into documentation_ref would have put the same
    // fiction into the receipt column. A reference must be a thing that resolves, not a sentence
    // that begins with one.
    if (/\s/.test(url)) return null
    try {
      const u = new URL(url)
      return (u.protocol === 'http:' || u.protocol === 'https:') ? url : null
    } catch { return null }
  }
  return null
}

export async function offerToBoard(item, f, { workEvidence, workClose, now = () => new Date().toISOString() }) {
  // The row's own reference wins; then the finish-test's declared one; then, ONLY for a check that
  // is itself a resolving artifact, the artifact this run just executed or fetched. See
  // selfDocumentingRef: never for a query, a deploy comparison, a metric or a human act.
  const documentation_ref = f.documentation_ref || item.documentation_ref || selfDocumentingRef(item.done_when)
  if (!documentation_ref) {
    return {
      outcome: 'refused', item: item.slug,
      why: `the item has no documentation_ref and its finish-test cannot stand as one (kind ${item.done_when && item.done_when.kind ? `"${item.done_when.kind}"` : 'unknown'} is not a file or a URL). work_close refuses to close undocumented work. Give the row a documentation_ref, or put one on its done_when.`,
    }
  }
  try {
    await workEvidence(receiptFor(item, f))
  } catch (e) {
    return { outcome: 'refused', item: item.slug, why: `the receipt could not be filed, so nothing was closed (${String(e.message).slice(0, 200)})` }
  }
  let res
  try {
    res = await workClose({
      item: item.slug,
      documentation_ref,
      production_ref: f.production_ref || null,
      summary: `Closed by its own finish-test at ${now()}: ${f.reason}`,
      outcome: 'done',
    })
  } catch (e) {
    return { outcome: 'refused', item: item.slug, why: String(e.message).slice(0, 300) }
  }
  const status = res && res.status
  if (status === 'done') return { outcome: 'closed', item: item.slug, why: (res.production || res.documentation || '').slice(0, 200) }
  if (status === 'awaiting_signoff') return { outcome: 'handed', item: item.slug, why: (res.why_he_is_being_asked || res.production || '').slice(0, 300) }
  return { outcome: 'refused', item: item.slug, why: `work_close returned status "${status}"` }
}

// ── the run ──────────────────────────────────────────────────────────────────────────────────

async function main() {
  // DRY IS THE DEFAULT AND THE FLAG ONLY EVER TIGHTENS IT. An accidental run — a scheduler aimed at
  // the wrong script, a pasted command line, a session poking around — must not be able to close
  // somebody's work. Closing takes a deliberate environment variable and nothing less.
  const dry = isDryRun()
  const asJson = process.argv.includes('--json')
  const max = closureCap()

  const creds = loadBoardCredentials()
  if (!creds.ok) {
    const v = verdict({ boardRead: false, reason: creds.reason })
    sayVerdict(v.state, v.headline)
    console.error(`::error::${v.headline}`)
    return v.code
  }

  let rows
  try {
    rows = await readBoard()
  } catch (e) {
    const v = verdict({ boardRead: false, reason: String(e.message).slice(0, 240) })
    sayVerdict(v.state, v.headline)
    console.error(`::error::${v.headline}`)
    return v.code
  }

  const { actionable, judgeOnly, untouchable } = selectItems(rows)
  console.log(`  board: ${rows.length} open item(s); ${actionable.length} this job may act on, ` +
    `${judgeOnly.length} owed to Roger but carrying a machine check (judged, never closed), ` +
    `${untouchable.length} left alone (${UNTOUCHABLE_STATUSES.join('/')})`)

  // A row in his lane that asks him nothing costs him exactly as much attention as a real
  // decision and gives him nothing to decide. Counted every run so an erased ask moves a number
  // instead of the lane quietly emptying. Never acted on here: this job does not write to his
  // lane, and a missing question is a producer's defect, not this item's.
  const silent = silentRowsInHisLane(rows)
  if (silent.length) {
    console.log(`  HIS LANE: ${silent.length} row(s) are owed to Roger but state no question — ` +
      `they ask him for nothing. A producer erased the ask, or none was ever written.`)
    for (const r of silent.slice(0, 10)) console.log(`     no ask   ${r.slug}: ${String(r.title || '').slice(0, 72)}`)
    if (silent.length > 10) console.log(`     ...and ${silent.length - 10} more`)
  } else {
    console.log('  HIS LANE: every row owed to Roger states what it wants from him.')
  }

  let offer = null
  if (!dry) {
    // Imported HERE and not at the top of the file: Cockpit/mcp/lib/db.mjs throws at
    // module-evaluation time without SUPABASE_URL/SUPABASE_SERVICE_KEY, so it may only be loaded
    // after loadBoardCredentials() has run — and a dry run must not need the board's writer at all.
    const tools = await import(pathToFileURL(COCKPIT_TOOLS).href)
    offer = (item, f) => offerToBoard(item, f, { workEvidence: tools.workEvidence, workClose: tools.workClose })
  }
  const swept = await sweep(actionable, { offer, max })
  const { results, passes, fails, unknowns, skipped, outcomes } = swept
  const evaluated = results.filter((r) => r.f.state !== SKIP)

  // HIS ROWS ARE JUDGED, NEVER CLOSED. No `offer` is passed, so nothing here can reach workClose;
  // the only effect is a verdict written onto the row. Eleven rows on the live board carried a
  // machine-checkable check and had never once been run, because they were dropped before the
  // sweep. A question that the world has already answered stays in his lane for ever otherwise.
  const hisSwept = await sweep(judgeOnly, { offer: null })
  if (hisSwept.results.length) {
    const hisPasses = hisSwept.passes
    console.log(`  HIS LANE, JUDGED: ${hisSwept.results.length} check(s) run on rows owed to Roger — ` +
      `${hisPasses.length} now pass, ${hisSwept.fails.length} do not, ${hisSwept.unknowns.length} could not be judged. ` +
      'None was closed and none can be.')
    for (const r of hisPasses) {
      console.log(`     MOOT?    ${r.item.slug}: its check now passes — the decision he is holding may already be settled`)
    }
  }

  for (const r of unknowns) console.log(`     UNKNOWN  ${r.item.slug}: ${r.f.reason}`)
  for (const r of fails) console.log(`     not yet  ${r.item.slug}: ${r.f.reason}`)
  for (const r of skipped) console.log(`     for Roger  ${r.item.slug}: ${r.f.reason}`)
  for (const r of passes) console.log(`     PASS     ${r.item.slug}: ${r.f.reason}`)

  if (dry) {
    for (const r of passes) {
      // THE SAME RESOLUTION offerToBoard uses, not a second copy of it. This line used to compute
      // the reference differently from the code that actually closes, so --dry printed "NO
      // documentation_ref, work_close would refuse it" about rows the real path would now close.
      // A preview that disagrees with the behaviour is worse than no preview: it is the shape of
      // every "reports success for doing nothing" defect in this repo, pointed the other way.
      const doc = r.f.documentation_ref || r.item.documentation_ref || selfDocumentingRef(r.item.done_when)
      console.log(`  --dry: would offer ${r.item.slug} to the board` +
        `${doc ? ` (receipt: ${doc})` : ' — but it has NO documentation_ref and its finish-test cannot stand as one, so work_close would refuse it'}` +
        `${r.f.production_ref ? ` (production proof: ${r.f.production_ref})` : ' (no production proof, so it would be handed to Roger for sign-off)'}`)
    }
  } else {
    for (const o of outcomes) console.log(`     ${o.outcome.toUpperCase().padEnd(8)} ${o.item}: ${o.why}`)
    if (swept.deferred) console.log(`  CLOSER_MAX=${max} reached: ${swept.deferred} passing item(s) were left for the next run`)
  }

  // WRITE DOWN WHAT THIS RUN DECIDED. Not in --dry: a dry run must leave no trace, and a
  // done_checked_at from a run that changed nothing would be a claim the board never earned.
  // Failures are reported, never thrown: bookkeeping must not undo a close that already happened.
  if (!dry) {
    const stamped = await recordEvaluations(swept.results.concat(hisSwept.results))
    console.log(`  recorded on the board: ${stamped.written} verdict(s) written` +
      `${stamped.failed.length ? `, ${stamped.failed.length} FAILED (${stamped.failed.slice(0, 3).join('; ')})` : ''}`)
  }

  const v = verdict({
    boardRead: true,
    open: rows.length,
    evaluated: evaluated.length,
    skipped: skipped.length,
    passes: passes.length,
    fails: fails.length,
    unknowns: unknowns.length,
    closed: outcomes.filter((o) => o.outcome === 'closed').length,
    handed: outcomes.filter((o) => o.outcome === 'handed').length,
    refused: outcomes.filter((o) => o.outcome === 'refused').length,
    dry,
  })

  if (asJson) {
    console.log(JSON.stringify({
      verdict: v.state, headline: v.headline, dry,
      open: rows.length, actionable: actionable.length,
      evaluated: evaluated.length, passes: passes.length, fails: fails.length,
      unknown: unknowns.length, skipped: skipped.length,
      results: results.map((r) => ({ item: r.item.slug, state: r.f.state, kind: r.f.kind || null, reason: r.f.reason })),
      outcomes,
    }, null, 2))
  }

  // Three-valued, out loud. The exit code cannot carry this on its own: 0 legitimately means both
  // "swept cleanly" and "found nothing it could judge", and only one of those is fine.
  sayVerdict(v.state, v.headline)
  if (v.level === 'error') console.error(`::error::${v.headline}`)
  else if (v.level === 'warning') console.error(`::warning::${v.headline}`)
  else console.log(`  OK  ${v.headline}`)
  return v.code
}

// Set exitCode rather than process.exit(): on Windows, exiting while an undici handle is still
// closing aborts the process and reports 127, and a job with an ambiguous exit status is the exact
// failure class this repo exists to catch.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().then(
    (code) => { process.exitCode = code },
    (e) => {
      const why = `the work-board closer could NOT run (${String(e && e.message ? e.message : e).slice(0, 240)}). This is unknown, not fine, and nothing was closed.`
      sayVerdict(UNKNOWN, why)
      console.error(`::error::${why}`)
      process.exitCode = 1
    },
  )
}
