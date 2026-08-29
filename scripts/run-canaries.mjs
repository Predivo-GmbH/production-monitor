#!/usr/bin/env node
/**
 * Out-of-band canaries — the checks that catch what no commit-triggered
 * pipeline can: secrets rotated to dead values, vendor-side retirements,
 * platform key disablement. Runs as a step of the hourly monitor; any
 * failure fails the run and rides the existing alert email + healthchecks
 * dead-man switch.
 *
 * Origin: BREAKAGE_ROOT_CAUSE_INVESTIGATION_2026-07-14.md §8 — out-of-band
 * changes were the #1 severe-incident class (ChannelMover SB_SECRET_KEY dead
 * 5 days; Anthropic model retirement; legacy-key disablement), and every one
 * passed the pipeline because nothing exercised the LIVE credential.
 */

import { writeFileSync } from 'fs'

const failures = []
const ok = (msg) => console.log(`  OK  ${msg}`)
const fail = (msg) => { failures.push(msg); console.error(`  FAIL ${msg}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Non-browser UA — Supabase rejects sb_secret_ keys from browser user-agents.
const UA = 'production-monitor-canary'

async function probe(name, fn) {
  console.log(`\n== ${name}`)
  try { await fn() } catch (e) { fail(`${name}: ${String(e).slice(0, 200)}`) }
}

// ---------------------------------------------------------------------------
// 1. Per-product Supabase service-key validity (the 2026-07-09 rotation class).
//    GET the PostgREST root with the service key: valid key => 200 (OpenAPI),
//    disabled/rotated-dead key => 401/403.
// ---------------------------------------------------------------------------
const PRODUCTS = [
  ['ReplyFlow', 'REPLYFLOW_SUPABASE_URL', 'REPLYFLOW_SERVICE_ROLE_KEY'],
  ['ChannelMover', 'YTMIGRATION_SUPABASE_URL', 'YTMIGRATION_SERVICE_ROLE_KEY'],
  ['SignalScore', 'SIGNALSCORE_SUPABASE_URL', 'SIGNALSCORE_SERVICE_ROLE_KEY'],
  ['Valrano', 'VALRANO_SUPABASE_URL', 'VALRANO_SERVICE_ROLE_KEY'],
  ['BackOffice', 'BACKOFFICE_SUPABASE_URL', 'BACKOFFICE_SERVICE_ROLE_KEY'],
  ['LaunchReady', 'LAUNCHREADY_SUPABASE_URL', 'LAUNCHREADY_SERVICE_ROLE_KEY'],
  ['ScoutCopilot', 'SCOUTCOPILOT_SUPABASE_URL', 'SCOUTCOPILOT_SERVICE_ROLE_KEY'],
  ['Distribution-OS', 'DISTRIBUTIONOS_SUPABASE_URL', 'DISTRIBUTIONOS_SERVICE_ROLE_KEY'],
  ['BoatBuddy', 'BOATBUDDY_SUPABASE_URL', 'BOATBUDDY_SERVICE_ROLE_KEY'],
]

for (const [name, urlEnv, keyEnv] of PRODUCTS) {
  const url = process.env[urlEnv]
  const key = process.env[keyEnv]
  await probe(`service-key: ${name}`, async () => {
    if (!url || !key) { fail(`service-key: ${name} — env ${!url ? urlEnv : keyEnv} not set`); return }
    const hit = () => fetch(`${url}/rest/v1/`, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'User-Agent': UA },
    })
    let res = await hit()
    // A 5xx is Supabase's REST layer being unavailable, NOT an auth problem — a dead/rotated
    // key answers 401/403, never 503. These blips are transient, so retry once before we
    // believe it (a lone 503 mailed as "dead/rotated key?" was the 2026-08-29 false lead).
    if (res.status >= 500) { await sleep(2000); res = await hit() }
    if (res.status === 200) ok(`${name} service key valid (REST 200)`)
    else if (res.status >= 500) fail(`service-key: ${name} — REST root returned ${res.status} (Supabase REST unavailable, not a key problem — retried once)`)
    else if (res.status === 401 || res.status === 403) fail(`service-key: ${name} — REST root returned ${res.status} (dead/rotated key?)`)
    else fail(`service-key: ${name} — REST root returned ${res.status} (unexpected)`)
  })
}

// ---------------------------------------------------------------------------
// 2. Anthropic: production API key valid + model families still alive
//    (model-retirement class: prod AI was down for days when
//    claude-sonnet-4-20250514 was retired — no test called the real API).
// ---------------------------------------------------------------------------
await probe('anthropic: key + model families', async () => {
  const key = process.env.ANTHROPIC_API_KEY_CANARY
  // PAID-KEY GATE: wiring a paid key needs Roger's explicit approval, so this
  // canary self-disables (loudly) until the secret exists. /v1/models is free.
  if (!key) { console.warn('  SKIP anthropic canary — ANTHROPIC_API_KEY_CANARY not set (awaiting paid-key approval)'); return }
  const res = await fetch('https://api.anthropic.com/v1/models?limit=100', {
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'User-Agent': UA },
  })
  if (!res.ok) { fail(`anthropic — /v1/models returned ${res.status} (dead key?)`); return }
  const ids = ((await res.json()).data ?? []).map((m) => m.id)
  ok(`anthropic key valid, ${ids.length} models listed`)
  // claude-opus is included because agent-triage.mjs and deploy-failure-triage.mjs
  // hard-pin claude-opus-4-8 and have NO _shared/anthropic-model.ts fallback — an
  // opus retirement would break them silently (audit 2026-07-21).
  for (const family of ['claude-sonnet', 'claude-haiku', 'claude-opus']) {
    if (ids.some((id) => id.startsWith(family))) ok(`model family ${family}* alive`)
    else fail(`anthropic — no live model in family ${family}* (fleet AI fns pin this family)`)
  }
})

// ---------------------------------------------------------------------------
// 3. Stripe: production secret key valid (rotated-dead key class).
//    GET /v1/balance is read-only and permission-sensitive.
// ---------------------------------------------------------------------------
await probe('stripe: secret key', async () => {
  const key = process.env.STRIPE_SECRET_KEY_CANARY
  // PAID-KEY GATE: see above — self-disables until Roger adds the secret.
  if (!key) { console.warn('  SKIP stripe canary — STRIPE_SECRET_KEY_CANARY not set (awaiting paid-key approval)'); return }
  const res = await fetch('https://api.stripe.com/v1/balance', {
    headers: { Authorization: `Bearer ${key}`, 'User-Agent': UA },
  })
  if (res.status === 200) ok('stripe secret key valid (balance 200)')
  else fail(`stripe — /v1/balance returned ${res.status} (dead/rotated key?)`)
})

// ---------------------------------------------------------------------------
// Record the failures so send-alert.mjs can name the failing check + its error. A canary
// failure is a STEP failure, not a Playwright test, so it is invisible in results.json;
// without this file the alert falls through to a content-free "no per-test detail" line.
// Each message is "check — detail"; split on the first " — " to fill the alert columns.
const structured = failures.map((line) => {
  const idx = line.indexOf(' — ')
  return {
    project: 'Out-of-band canary',
    check: idx > -1 ? line.slice(0, idx) : 'canary',
    error: idx > -1 ? line.slice(idx + 3) : line,
  }
})
writeFileSync('canary-results.json', JSON.stringify({ generated_at: new Date().toISOString(), failures: structured }, null, 2))

console.log('')
if (failures.length) {
  console.error(`CANARIES FAILED (${failures.length}):`)
  failures.forEach((f) => console.error(` - ${f}`))
  process.exitCode = 1
} else {
  console.log(`All canaries passed.`)
}
