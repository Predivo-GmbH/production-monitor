#!/usr/bin/env node
// Tests the fleet registry helper (lib/fleet.mjs). The load-bearing assertion is the SAFETY one:
// any DB failure must fall back to the full hardcoded fleet, never a shrunken list (no blind spot).
// Run: node test/fleet.test.mjs   (optionally with BACKOFFICE_SUPABASE_URL/KEY set to test the DB path)
import assert from 'node:assert'
import { getFleet, FALLBACK_FLEET } from '../lib/fleet.mjs'

let pass = 0
const ok = (m) => { console.log('  ok -', m); pass++ }

async function run() {
  // 1) SAFETY: with no DB env, getFleet falls back to the full hardcoded fleet.
  const savedUrl = process.env.BACKOFFICE_SUPABASE_URL
  const savedKey = process.env.BACKOFFICE_SERVICE_ROLE_KEY
  delete process.env.BACKOFFICE_SUPABASE_URL
  delete process.env.BACKOFFICE_SERVICE_ROLE_KEY
  const fb = await getFleet()
  assert.equal(fb.source, 'fallback', 'no-env -> fallback')
  assert.equal(fb.fleet.length, FALLBACK_FLEET.length, 'fallback returns the FULL fleet (no shrink)')
  assert.ok(fb.fleet.find((p) => p.name === 'ReplyFlow'), 'fallback includes ReplyFlow')
  ok(`no DB env -> fallback with all ${fb.fleet.length} products (fail-safe)`)

  // THE ASSERTION ABOVE COMPARES THE LIST TO ITSELF. `fb.fleet.length === FALLBACK_FLEET.length`
  // holds no matter what FALLBACK_FLEET contains, so if somebody trimmed it to seven products the
  // suite would stay green and five products would quietly stop being watched — with a passing test
  // as the reason nobody looked. That is exactly the fear the board row
  // "watching-all-twelve-products-is-switched-on-in-the-live" was raised about, and it was not
  // covered. It is now, by naming the fleet rather than counting it.
  //
  // WHY THE NAMES AND NOT JUST A NUMBER: a count catches a deletion and misses a swap. This list is
  // the fleet as it stood on 2026-09-02, and it matches Cockpit's own registry (public.fleet_projects,
  // seeded by sql/049) product for product, checked that day. A product genuinely joining or leaving
  // the fleet is a real event and should require editing this line, in a commit, on purpose.
  const EXPECTED = [
    'ReplyFlow', 'SignalScore', 'ChannelMover', 'BoatBuddy', 'BackOffice', 'Valrano',
    'ScoutCopilot', 'Distribution-OS', 'launchready', 'arivioo', 'jass-tour-ui-kit', 'predivo',
  ]
  const got = FALLBACK_FLEET.map((p) => p.name).sort()
  const missing = EXPECTED.filter((n) => !got.includes(n))
  const added = got.filter((n) => !EXPECTED.includes(n))
  assert.deepEqual(
    { missing, added }, { missing: [], added: [] },
    `the watched fleet changed without this list changing: missing=[${missing}] unexpected=[${added}]`,
  )
  ok(`all ${EXPECTED.length} products are named in the fallback fleet, so a shrink cannot pass silently`)

  // 2) SAFETY: a bad URL (network/HTTP error) also falls back, never throws.
  process.env.BACKOFFICE_SUPABASE_URL = 'https://invalid.example.doesnotexist'
  process.env.BACKOFFICE_SERVICE_ROLE_KEY = 'x'
  const bad = await getFleet()
  assert.equal(bad.source, 'fallback', 'bad URL -> fallback (no throw)')
  assert.equal(bad.fleet.length, FALLBACK_FLEET.length, 'bad URL still returns the full fleet')
  ok('unreachable DB -> fallback, never throws')

  // restore
  if (savedUrl) process.env.BACKOFFICE_SUPABASE_URL = savedUrl; else delete process.env.BACKOFFICE_SUPABASE_URL
  if (savedKey) process.env.BACKOFFICE_SERVICE_ROLE_KEY = savedKey; else delete process.env.BACKOFFICE_SERVICE_ROLE_KEY

  // 3) DB path (only if real creds are present): getFleet reads fleet_products.
  if (process.env.BACKOFFICE_SUPABASE_URL && process.env.BACKOFFICE_SERVICE_ROLE_KEY) {
    const db = await getFleet()
    assert.ok(db.fleet.length >= 1, 'db path returns rows')
    ok(`live DB path -> source=${db.source}, ${db.fleet.length} products`)
  } else {
    console.log('  (skip DB path - BACKOFFICE_SUPABASE_URL/KEY not set)')
  }
}

run()
  .then(() => { console.log(`\nPASS - ${pass} assertions.`); process.exit(0) })
  .catch((e) => { console.error(`\nFAIL: ${e.message}`); process.exit(1) })
