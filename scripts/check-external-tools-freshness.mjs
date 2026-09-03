#!/usr/bin/env node
/**
 * The anti-rot guard for the External Tools page.
 *
 * WHY IT EXISTS, and it is the whole reason the page is trustworthy. The page this one replaces
 * — Cockpit `src/pages/Infrastructure.tsx`, fed by a hardcoded `src/data/supabaseAccounts.ts`
 * with a `LAST_VERIFIED` constant — froze and kept rendering confidently. Nothing watched the
 * thing that was supposed to refresh it. A dashboard that stops updating looks exactly like a
 * dashboard where nothing has changed, and that is the failure mode this closes.
 *
 * So: if the discovery scan has not written anything for over 36 hours, that is itself an
 * incident, filed through the same `signal-intake` everything else uses. 36h is the same
 * threshold `v_external_tools.code_freshness` uses to paint a tool amber, deliberately — the
 * alarm and the page must never disagree about what "stale" means.
 *
 * It also reports the two counts that only matter together: how many tools have NEVER been
 * scanned (a wiring gap) and how many have gone stale (a stopped scan).
 *
 * Contract:  node scripts/check-external-tools-freshness.mjs [--dry]
 *   env: BOARD_SUPABASE_SECRET or BACKOFFICE_SERVICE_ROLE_KEY
 *        BO_PROJECT_REF  (defaults to prod; set to the staging ref to rehearse)
 * Exit 0 = judged. Exit 1 = could not tell, which is never "fine".
 */
import { readFileSync } from 'node:fs'
import { sayVerdict, PASS, FAIL, UNKNOWN } from './lib/check-verdict.mjs'
import { join, sep } from 'node:path'

const BO_REF = process.env.BO_PROJECT_REF || 'xoecpzfsskalvjrtcbbl'
const BO_BASE = `https://${BO_REF}.supabase.co`
const BO_CREDS = join('C:', sep, 'Business', 'Internal Projects', 'BackOffice', 'docs', 'Credentials.txt')
const UA = 'external-tools-freshness/1.0'
const SOURCE = 'external-tools-freshness'
const STALE_HOURS = 36

function readBoSecret() {
  if (process.env.BOARD_SUPABASE_SECRET) return process.env.BOARD_SUPABASE_SECRET.trim()
  if (process.env.BACKOFFICE_SERVICE_ROLE_KEY) return process.env.BACKOFFICE_SERVICE_ROLE_KEY.trim()
  const m = readFileSync(BO_CREDS, 'utf-8').match(/sb_secret_[A-Za-z0-9_]+/)
  if (!m) throw new Error(`no sb_secret_ key found in ${BO_CREDS}`)
  return m[0]
}

async function boGet(secret, path) {
  const res = await fetch(`${BO_BASE}/rest/v1/${path}`, {
    headers: { apikey: secret, Authorization: `Bearer ${secret}`, 'User-Agent': UA },
  })
  if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`)
  return res.json()
}

/**
 * The judgement, pure and testable. `newest` is the most recent last_seen_in_code_at across the
 * register; null means the scan has never run at all.
 */
export function judge(newest, now = Date.now(), staleHours = STALE_HOURS) {
  if (!newest) return { stale: true, hours: null, reason: 'the scan has never run' }
  // AN UNREADABLE TIMESTAMP IS NOT A FRESH ONE (2026-09-01 audit). `hours` came out NaN for any
  // value this could not parse, and `NaN > 36` is false, so the page reported itself up to date.
  // That is the exact failure this guard exists to close, reproduced inside the guard.
  const t = new Date(newest).getTime()
  if (!Number.isFinite(t)) {
    // `unknown` because "I cannot establish freshness" is a statement about this check, not about
    // the scan. It still reports stale so the existing alarm path is unchanged; the flag is what
    // stops it being printed as a pass. (Additive field: the suite asserts on `.stale` only.)
    return { stale: true, unknown: true, hours: null, reason: `the newest scan timestamp is unreadable (${String(newest)}), so freshness cannot be established` }
  }
  const hours = Math.round((now - t) / 3_600_000)
  return { stale: hours > staleHours, hours, reason: `last scan wrote ${hours} h ago` }
}

export function signalFor(v, neverScanned) {
  return {
    source: SOURCE,
    key: 'external-tools-scan-stale',
    kind: 'incident',
    severity: 'warning',
    state: 'open',
    needs_human: false,
    title: 'The external tools page has stopped updating itself',
    summary: `${v.reason}. Until the daily scan runs again the page still looks current but is not — it cannot notice a new outside service, or one nothing uses any more.`
      + (neverScanned ? ` ${neverScanned} tool(s) have never been scanned at all.` : ''),
    detail: { hours_since_scan: v.hours, never_scanned: neverScanned, threshold_hours: STALE_HOURS },
    link: 'https://cockpit.predivo.ch/external-tools',
  }
}

async function main() {
  const dry = process.argv.includes('--dry')
  const secret = readBoSecret()

  const rows = await boGet(secret, 'api_entries?select=name,last_seen_in_code_at&retired_at=is.null&order=last_seen_in_code_at.desc.nullslast')
  const newest = rows.find((r) => r.last_seen_in_code_at)?.last_seen_in_code_at ?? null
  const neverScanned = rows.filter((r) => !r.last_seen_in_code_at).length

  // AN EMPTY REGISTER IS A FAILED READ, NOT A QUIET FLEET (2026-09-03, found by fault injection).
  //
  // Made the endpoint answer 200 with `[]` -- the shape a PostgREST filter change, a renamed
  // table, a revoked row-level grant or a wrong project ref all produce -- and this check said:
  //
  //     external tools: 0 live tool(s), 0 never scanned, the scan has never run
  //     ::warning::the external-tools scan is stale (> 36h)
  //     signal filed.                                                              exit 0
  //
  // Two separate defects in three lines. First, `judge(null)` cannot tell "the register is empty
  // because the scan never ran" from "the register is empty because I could not read it", and it
  // asserts the former, which is a claim about the WORLD made from an absence of DATA. Measured
  // 2026-09-01: 48 live tools. The register is never empty, so zero rows is this check being
  // broken. Second -- and this is the half that made it invisible -- it was filed at
  // `severity: warning, needs_human: false`, which by this fleet's own paging rule can never
  // reach anybody, and `::warning::` leaves the workflow GREEN. So the sensor announced its own
  // blindness into a channel guaranteed not to deliver it.
  //
  // The wording below is borrowed deliberately from check-alarm-reachability.mjs, which got this
  // right ("The board is never empty, so this is a failed read, not a quiet fleet. Unknown is
  // never healthy."). It was in this repo, correct, and eight rows away.
  if (rows.length === 0) {
    const reason = 'the external-tools register returned no rows at all, so nothing could be judged. '
      + 'The register is never empty — 48 live tools were counted on 2026-09-01 — so zero rows is a failed read, '
      + 'not a fleet with no external tools. Unknown is never healthy.'
    sayVerdict(UNKNOWN, reason)
    console.error(`::error::${reason}`)
    if (dry) { console.log('--dry: nothing written.'); return 1 }
    // Filed CRITICAL and needs_human, unlike the staleness row below. A stale scan means the page
    // is ageing; a register that cannot be read means this alarm is off, and an alarm being off is
    // the one condition under which every other reading is worthless. Best-effort: if the board is
    // unreachable too, the non-zero exit is the remaining wire and it must not be lost to a throw.
    try {
      const res = await fetch(`${BO_BASE}/functions/v1/signal-intake`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', 'User-Agent': UA },
        body: JSON.stringify({
          source: SOURCE,
          key: 'external-tools-register-unreadable',
          kind: 'incident',
          severity: 'critical',
          state: 'open',
          needs_human: true,
          title: 'The external-tools freshness alarm has gone blind',
          summary: reason + ' Until this is fixed the External Tools page can rot with nothing to notice, which is the exact failure this guard was built to prevent.',
          detail: { rows_returned: 0, project_ref: BO_REF, threshold_hours: STALE_HOURS },
          link: 'https://cockpit.predivo.ch/external-tools',
        }),
      })
      if (!res.ok) console.error(`::error::could not file the blindness finding: HTTP ${res.status}`)
      else console.log('signal filed: external-tools-register-unreadable (critical, needs a human).')
    } catch (e) {
      console.error(`::error::could not file the blindness finding: ${e.message}`)
    }
    return 1
  }

  const v = judge(newest)
  console.log(`external tools: ${rows.length} live tool(s), ${neverScanned} never scanned, ${v.reason}`)

  // THE COUNT USED TO BE PRINTED AND THEN DROPPED (2026-09-01 audit). `neverScanned` was computed
  // and logged, and this line returned before anything could raise it - so on every healthy run
  // the number reached nobody. Measured the day this was fixed: 48 live tools, 17 of them never
  // scanned once. One row for the whole set, warning and needs_human false, because it is a
  // wiring gap and not an outage: the scan IS running, it is simply not reaching these entries.
  if (!v.stale && !neverScanned) {
    sayVerdict(PASS, `${rows.length} live tool(s) read, ${v.reason}, every tool scanned.`)
    console.log('fresh, and every tool has been scanned - nothing to raise.')
    return 0
  }
  if (!v.stale) {
    sayVerdict(FAIL, `${neverScanned} of ${rows.length} external tool(s) have never been scanned`)
    console.log(`::warning::${neverScanned} of ${rows.length} external tool(s) have never been scanned`)
    if (dry) { console.log('--dry: nothing written.'); return 0 }
    const res = await fetch(`${BO_BASE}/functions/v1/signal-intake`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({
        source: SOURCE,
        key: 'external-tools-never-scanned',
        kind: 'incident',
        severity: 'warning',
        state: 'open',
        needs_human: false,
        title: `${neverScanned} external tool(s) have never been scanned`,
        summary: `${neverScanned} of ${rows.length} live entries carry no scan timestamp at all, so the page cannot say whether anything still uses them. The scan is running and reaching the others; it is not reaching these. A wiring gap, not an outage.`,
        detail: { never_scanned: neverScanned, total: rows.length },
        link: 'https://cockpit.predivo.ch/external-tools',
      }),
    })
    if (!res.ok) throw new Error(`signal-intake -> HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`)
    console.log('signal filed: external-tools-never-scanned.')
    return 0
  }
  // `unknown` when the timestamp itself could not be parsed: freshness was never established, so
  // this is a blind sensor wearing a staleness verdict. `fail` when the scan genuinely is stale.
  sayVerdict(v.unknown ? UNKNOWN : FAIL, v.reason)
  console.log(`::warning::the external-tools scan is stale (> ${STALE_HOURS}h)`)
  if (dry) { console.log('--dry: nothing written.'); return 0 }

  const res = await fetch(`${BO_BASE}/functions/v1/signal-intake`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify(signalFor(v, neverScanned)),
  })
  if (!res.ok) throw new Error(`signal-intake -> HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`)
  console.log('signal filed.')
  return 0
}

if (process.argv[1] && process.argv[1].endsWith('check-external-tools-freshness.mjs')) {
  // Set process.exitCode and let the event loop drain naturally instead of calling process.exit().
  // On Windows + Node 24, process.exit() while an undici/fetch handle is still closing aborts with
  // the libuv assertion `!(handle->flags & UV_HANDLE_CLOSING)` (src\win\async.c) and a bogus exit
  // 127 — a healthy fleet read as a hard failure by any Windows runner. (House standard; see the
  // same fix in engine/run-station.mjs and check-ci-watchdog-alive.mjs.)
  main().then((c) => { process.exitCode = c }).catch((e) => {
    console.error(`::error::freshness check failed: ${e.message}`)
    process.exitCode = 1
  })
}
