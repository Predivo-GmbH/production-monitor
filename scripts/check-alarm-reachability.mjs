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
 *   3. A CRITICAL FINDING THAT CANNOT PAGE ITSELF. The rule WAS `needs_human AND
 *      severity='critical'`, and `needs_human` does not mean "a human must be told" -- it means
 *      "ROGER'S HANDS ARE REQUIRED", derived from the "Roger - " / "Claude - " prefix of
 *      who_must_act (migrations 136 and 162). So every critical whose fix belongs to Claude was
 *      graded the worst class of problem and muted in the same call. Measured 2026-09-04 across
 *      the whole history: 33 of the 64 criticals ever filed carried needs_human=false -- HALF of
 *      every critical this fleet has raised could not ring anything, by construction. Fixed at the
 *      write contract by BackOffice migration 169: severity decides whether the phone rings,
 *      needs_human decides whose lane the row lands in. This check therefore no longer looks for
 *      that field combination; it looks for the outcome 169 makes impossible. See fault 2.
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
 * @param signals  fleet_signals rows: {source, key, severity, needs_human, state, page_suppressed_reason}
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
  // "Asked to page" is SEVERITY ALONE since BackOffice migration 169. It used to be
  // `needs_human && critical`, which was the paging rule as it then stood -- and that made this
  // check blind in exactly the direction that mattered: a source whose findings are all owned by
  // Claude files critical after critical with needs_human=false, so it never looked like it had
  // asked for anything, and a missing policy row on it stayed invisible here.
  const bySource = new Map()
  for (const s of signals) {
    const o = bySource.get(s.source) || { source: s.source, total: 0, wanted: 0, policyOff: 0 }
    o.total++
    if (s.severity === 'critical') o.wanted++
    if (s.page_suppressed_reason === 'policy-off') o.policyOff++
    bySource.set(s.source, o)
  }
  for (const o of bySource.values()) {
    if (o.wanted > 0 && !armed.has(o.source)) {
      faults.push({
        kind: 'mute-source',
        source: o.source,
        detail: `${o.source}: has filed ${o.wanted} finding(s) at severity critical, and has no entry in the paging policy — so every one of them was silenced ("policy-off" ${o.policyOff} time(s)). Not switched off: never added.`,
      })
    }
  }

  // ── fault 2: a CRITICAL finding that cannot page itself ─────────────────────────────
  //
  // REWRITTEN 2026-09-04, together with BackOffice migration 169. This used to test
  // `critical && !needs_human`, and that test was re-implementing the OLD PAGING RULE rather than
  // measuring a fault. `needs_human` does not mean "a human must be told"; it means "ROGER'S HANDS
  // ARE REQUIRED", and it is derived -- not supplied -- from the "Roger - " / "Claude - " prefix of
  // who_must_act (migrations 136 and 162). Every critical whose fix belongs to Claude therefore
  // carried false: 33 of the 64 criticals ever filed, i.e. HALF of them, each one a permanent and
  // unfixable "contradiction" here. Migration 169 took needs_human out of the paging branch --
  // severity decides whether the phone rings, needs_human decides whose lane the row lands in.
  //
  // So the fault to look for is no longer a field combination. It is the RULE THAT ACTUALLY RAN:
  // an OPEN critical, on an armed source, that upsert_signal nevertheless recorded as
  // 'not-eligible'. After 169 that is impossible -- 'not-eligible' is only written for a severity
  // below critical -- so seeing it means the function running in production is not the one this
  // fleet believes is running: a reverted migration, a restore from before it, or a second
  // definition shadowing it. That is a stronger question than the old one, because it reads the
  // OUTCOME of the paging decision instead of guessing at the decision.
  for (const s of signals) {
    const openish = s.state === 'open' || s.state === 'acknowledged'
    if (s.severity === 'critical' && openish && armed.has(s.source) && s.page_suppressed_reason === 'not-eligible') {
      faults.push({
        kind: 'critical-cannot-page',
        source: s.source,
        detail: `${s.source}/${s.key}: an OPEN critical on an armed source, and the database recorded page_suppressed_reason='not-eligible' -- which BackOffice migration 169 makes impossible for a critical. The paging rule running in production is not the one we think is running.`,
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
      criticals.length ? `${criticals.length} open critical finding(s) were refused a page as "not-eligible" by the live paging rule, which migration 169 makes impossible -- so the rule running in production is not the one we think is running.` : '',
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
    boGet(secret, `fleet_signals?select=source,key,severity,needs_human,state,page_suppressed_reason&first_seen_at=gte.${since}&limit=5000`),
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

  // A CHECK THAT GOES GREEN MUST CLEAR ITS OWN ALARM (added 2026-09-04).
  // Until today this branch was `if (j.verdict === 'ok') return 0` — file when red, say nothing
  // when green. So `production-monitor/alarms-cannot-reach-a-human` could be raised and could
  // never be lowered by the thing that raised it: it sat open from 2026-09-01T20:23Z through 97
  // sightings, and the only way off the board was a person clicking it away. A red that cannot
  // go green teaches the reader to ignore it, which is the same end state as no alarm at all.
  // `unknown` deliberately does NOT clear: a blind sensor is not a healthy one.
  if (j.verdict === 'ok') {
    await fileSignal(secret, {
      source: 'production-monitor',
      key: 'alarms-cannot-reach-a-human',
      kind: 'incident',
      severity: 'info',
      state: 'resolved',
      needs_human: false,
      title: 'Every alarm that has asked to reach you can',
      summary: j.summary,
      detail: { verdict: j.verdict, faults: [], checked_at: new Date().toISOString() },
      link: 'https://cockpit.predivo.ch/signals',
    })
    return 0
  }

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
