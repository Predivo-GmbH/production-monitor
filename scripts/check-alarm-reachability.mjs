#!/usr/bin/env node
/**
 * CAN THE ALARMS WE ALREADY HAVE ACTUALLY REACH A HUMAN?
 *
 * -- WHY THIS EXISTS (2026-09-01) ------------------------------------------------------------
 *
 * ReplyFlow and SignalScore logins were dead for twenty hours with three checks green. Roger:
 * "I do not believe that this system is working properly as it is supposed to work." The audit
 * that followed measured the ARRIVAL path instead of the sensors, and the sensors turned out not
 * to be the problem:
 *
 *   Of the 24 signals that have EVER asked to ring his phone, 21 never rang.
 *
 * Every sensor in this repo asks "is the thing I watch healthy?". NOTHING asked "if I found
 * something, could I tell anyone?" That question has failed three separate ways already, and each
 * one was found by a person reading the database, never by an alarm:
 *
 *   1. NO POLICY ROW. upsert_signal's first suppressor is `if pol.source is null or not
 *      pol.may_page then reason := 'policy-off'`. A source nobody added to signal_page_policy is
 *      muted absolutely. Migration 155 found `healthchecks` like this — eleven scheduled jobs dark
 *      for two days, the phone never rang once — and wrote "Not switched off: NEVER ADDED".
 *      On 2026-09-01, 17 of the 23 sources that have ever written to the board still had no row,
 *      six of which had already filed something page-worthy.
 *   2. A HAND-OFF THAT LOOKED LIKE A DELIVERY. board-drainer cancelled the pending page when it
 *      moved a finding to the work board. 18 of the 21 lost pages. Fixed in board-drainer.mjs
 *      (pageFieldsOnSupersede) and migration 157.
 *   3. A CRITICAL FINDING THAT CANNOT PAGE ITSELF. The rule is `needs_human AND
 *      severity='critical'`. A signal marked critical with needs_human=false is a contradiction:
 *      the producer said it was the worst class of thing and simultaneously that nobody need be
 *      told. One was live on the board when this was written.
 *
 * -- WHAT THIS PROVES, AND HOW IT COULD LIE ---------------------------------------------------
 *
 * It proves that a signal filed TODAY, by a source that has filed before, could complete the
 * journey to a human. It does NOT prove delivery — SMTP working, a phone still subscribed. That
 * is the weekly fire drill's job (BackOffice/.github/workflows/alert-drill.yml), which fires a
 * real critical alert through the real path and fails if either channel stays quiet. The two are
 * deliberately different: the drill proves the pipe using ONE source, this proves that the other
 * twenty-two sources are connected to that pipe at all. The drill passing every week is exactly
 * how 21 lost pages stayed invisible.
 *
 * The cheapest way THIS could lie is a denominator built from what it happened to find, so:
 * the source list is read from the signals the fleet has actually filed, never from a hand-kept
 * list, and a read that fails EXITS NON-ZERO rather than reporting nothing-to-see. A source that
 * has never filed anything cannot be checked by anybody and is not counted as a pass.
 *
 * House rule, kept: A FILED ALARM EXITS 0; ONLY A FAILED READ EXITS NON-ZERO. Its own finding is
 * filed under `production-monitor`, which is armed — filing "the alarms cannot reach you" into a
 * source that cannot reach anyone is the joke this script exists to stop being.
 *
 * Contract:  node scripts/check-alarm-reachability.mjs [--dry]
 *   env: BOARD_SUPABASE_SECRET | BACKOFFICE_SERVICE_ROLE_KEY, else BackOffice Credentials.txt
 *        ALARM_LOOKBACK_DAYS (default 30)
 *   Exit 0 = reachable, or unreachable and the alarm was filed. Exit 1 = could not tell.
 */
import { readFileSync } from 'fs'
import { sayVerdict, PASS, FAIL, UNKNOWN } from './lib/check-verdict.mjs'

const BO_REF = 'xoecpzfsskalvjrtcbbl'
const BO_BASE = `https://${BO_REF}.supabase.co`
const BO_CREDS = 'C:/Business/Internal Projects/BackOffice/docs/Credentials.txt'
const UA = 'alarm-reachability-check/1.0'
const LOOKBACK_DAYS = Number(process.env.ALARM_LOOKBACK_DAYS || 30)

function readBoSecret(env = process.env) {
  if (env.BOARD_SUPABASE_SECRET) return env.BOARD_SUPABASE_SECRET.trim()
  if (env.BACKOFFICE_SERVICE_ROLE_KEY) return env.BACKOFFICE_SERVICE_ROLE_KEY.trim()
  const m = readFileSync(BO_CREDS, 'utf-8').match(/sb_secret_[A-Za-z0-9_-]+/)
  if (!m) throw new Error(`no sb_secret_ key found in ${BO_CREDS}`)
  return m[0]
}

/**
 * The whole decision, pure and testable.
 *
 * @param signals  fleet_signals rows: {source, key, severity, needs_human, state, paged_at, page_suppressed_reason}
 * @param policies signal_page_policy rows: {source, may_page}
 */
export function judgeReachability({ signals, policies }) {
  // A read that returned nothing is NOT a clean bill of health. The board has never been empty;
  // an empty answer means the query, the key or the network failed, and "could not tell" reported
  // as "fine" is the single most common shape in this whole audit.
  if (!Array.isArray(signals) || signals.length === 0) {
    return {
      verdict: 'unknown',
      severity: 'critical',
      title: 'Cannot tell whether any alarm can reach you',
      summary: 'The signals board returned no rows at all, so no source could be checked. The board is never empty, so this is a failed read, not a quiet fleet. Unknown is never healthy.',
      faults: [],
    }
  }
  if (!Array.isArray(policies)) {
    return {
      verdict: 'unknown',
      severity: 'critical',
      title: 'Cannot tell whether any alarm can reach you',
      summary: 'The paging policy table could not be read, so whether any source is armed cannot be established. Unknown is never healthy.',
      faults: [],
    }
  }

  const armed = new Set(policies.filter((p) => p.may_page).map((p) => p.source))
  const faults = []

  // ── fault 1: a source that has asked to page and structurally cannot ────────────────
  const bySource = new Map()
  for (const s of signals) {
    const o = bySource.get(s.source) || { source: s.source, total: 0, wanted: 0, policyOff: 0 }
    o.total++
    if (s.needs_human === true && s.severity === 'critical') o.wanted++
    if (s.page_suppressed_reason === 'policy-off') o.policyOff++
    bySource.set(s.source, o)
  }
  for (const o of bySource.values()) {
    if (o.wanted > 0 && !armed.has(o.source)) {
      faults.push({
        kind: 'mute-source',
        source: o.source,
        detail: `${o.source}: has filed ${o.wanted} finding(s) marked critical and needing a person, and has no entry in the paging policy — so every one of them was silenced ("policy-off" ${o.policyOff} time(s)). Not switched off: never added.`,
      })
    }
  }

  // ── fault 2: a CRITICAL finding that cannot page itself ─────────────────────────────
  // A contradiction, not a threshold: the producer graded it the worst class of thing AND said
  // nobody need be told. One of the two is wrong and only a person can say which.
  //
  // BUT a finding that ALREADY PAGED (paged_at set) has demonstrably reached a human, so it is NOT
  // unreachable: its needs_human was flipped to false AFTER the page went out, and every re-file
  // since is deduped against that sent page (page_suppressed_reason='dedup'), not muted. Reporting
  // "this cannot ring your phone" about something whose paged_at proves it rang is a false red —
  // workpc-push-reverts-laptop-script-edits paged 2026-09-04T17:04:33Z and was still called
  // unreachable 50 minutes later. A never-paged critical+needs_human=false finding still fires: the
  // genuine "the worst class of thing, and nobody was ever told" case is fully preserved.
  for (const s of signals) {
    if (s.severity === 'critical' && s.needs_human !== true && !s.paged_at && (s.state === 'open' || s.state === 'acknowledged')) {
      faults.push({
        kind: 'critical-cannot-page',
        source: s.source,
        detail: `${s.source}/${s.key}: severity is critical but needs_human is false, so the paging rule (needs_human AND critical) refuses it, and it has never paged. It is filed as the most serious class of problem and simultaneously as something nobody needs to be told about.`,
      })
    }
  }

  if (faults.length === 0) {
    return {
      verdict: 'ok',
      severity: 'info',
      title: 'Every alarm that has asked to reach you can',
      summary: `${bySource.size} source(s) have filed to the board; every source that has ever raised a page-worthy finding is armed, and no open critical finding is blocked from paging.`,
      faults,
    }
  }

  const mutes = faults.filter((f) => f.kind === 'mute-source')
  const criticals = faults.filter((f) => f.kind === 'critical-cannot-page')
  return {
    verdict: 'unreachable',
    severity: 'critical',
    title: mutes.length
      ? `${mutes.length} alarm source(s) cannot reach you at all`
      : `${criticals.length} critical finding(s) cannot ring your phone`,
    summary: [
      mutes.length ? `${mutes.length} source(s) have raised something critical needing a person and are not armed to page, so those findings were silenced.` : '',
      criticals.length ? `${criticals.length} open finding(s) are marked critical but carry needs_human=false, which the paging rule refuses.` : '',
      'These exist only on the /signals page, and a page is something you have to go and open.',
    ].filter(Boolean).join(' '),
    faults,
  }
}

async function boGet(secret, path) {
  const res = await fetch(`${BO_BASE}/rest/v1/${path}`, {
    headers: { apikey: secret, Authorization: `Bearer ${secret}`, 'User-Agent': UA },
  })
  if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.json()
}

async function fileSignal(secret, body) {
  const res = await fetch(`${BO_BASE}/functions/v1/signal-intake`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`signal-intake -> HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.json()
}

async function main() {
  const secret = readBoSecret()
  const dry = process.argv.includes('--dry')
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86400_000).toISOString()

  const [signals, policies] = await Promise.all([
    boGet(secret, `fleet_signals?select=source,key,severity,needs_human,state,paged_at,page_suppressed_reason&first_seen_at=gte.${since}&limit=5000`),
    boGet(secret, 'signal_page_policy?select=source,may_page'),
  ])

  const j = judgeReachability({ signals, policies })
  console.log(`alarm reachability: ${j.verdict} — ${j.summary}`)
  for (const f of j.faults) console.log(`  - ${f.detail}`)

  // Three-valued, out loud (lib/check-verdict.mjs). This check already got the WORDS right -- it
  // says "unknown" and it says "the board is never empty, so this is a failed read" -- and it
  // still exited 0 with no machine-readable trace of that, because the house rule is that a filed
  // alarm exits 0. Correct prose in a log a person is not reading is not a channel. `unknown` is
  // now declared, so anything downstream can tell "the fleet is fine" from "this sensor is blind".
  sayVerdict(j.verdict === 'ok' ? PASS : j.verdict === 'unknown' ? UNKNOWN : FAIL, j.summary)

  if (dry) { console.log('--dry: nothing written.'); return 0 }

  if (j.verdict === 'ok') return 0

  // Filed under `production-monitor`, which IS armed, and never under the source being reported:
  // an alarm about a mute source, filed into that mute source, is silent by construction.
  await fileSignal(secret, {
    source: 'production-monitor',
    key: 'alarms-cannot-reach-a-human',
    kind: 'incident',
    severity: j.severity,
    state: 'open',
    needs_human: true,
    title: j.title,
    summary: j.summary,
    detail: { verdict: j.verdict, faults: j.faults, checked_at: new Date().toISOString() },
    link: 'https://cockpit.predivo.ch/signals',
  })
  console.error(`::error::${j.title} — ${j.summary}`)
  return 0
}

// Set exitCode rather than process.exit(): on Windows, exiting while an undici handle is still
// closing aborts the process and reports 127, and an alarm with an ambiguous exit status is the
// exact failure class this script exists to catch.
if (import.meta.url === (await import('url')).pathToFileURL(process.argv[1] || '').href) {
  main().then(
    (code) => { process.exitCode = code },
    (e) => {
      console.error(`::error::alarm reachability check could NOT run (${e.message}). This is unknown, not fine.`)
      process.exitCode = 1
    },
  )
}
