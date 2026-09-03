#!/usr/bin/env node
/**
 * Nightly staging<->prod drift detection for the Supabase-backed products.
 *
 * Catches the classes no test run ever sees (investigation report §8):
 *  - schema drift: migrations applied to one environment only (the CHECK
 *    constraint that silently killed Auto-Pilot; staging at 1 of prod's 9 crons)
 *  - cron drift: job present in prod but not staging (or vice versa)
 *  - placeholder rot: a live cron row containing '<<' (e.g. <<CRON_SECRET>>)
 *    or a dead old project ref — fire-and-forget pg_cron masks these forever.
 *
 * Uses the Supabase Management API query endpoint with per-product PATs.
 * Read-only. Exits 1 on any drift — the workflow failure IS the alert.
 */

import { writeFileSync } from 'node:fs'

const PRODUCTS = [
  {
    name: 'ReplyFlow',
    patEnv: 'SUPABASE_TOKEN_REPLYFLOW',
    prod: 'dqmhsdzldkxngwjrxois',
    staging: 'cuvqzwvyovxvvvuddtjd',
  },
  {
    name: 'ChannelMover',
    patEnv: 'SUPABASE_TOKEN_CHANNELMOVER',
    prod: 'qswluvqunswggfmesdcs',
    staging: 'wlbykamxcgwduixcwadn',
  },
  {
    name: 'SignalScore',
    patEnv: 'SUPABASE_TOKEN_MUELLER',
    prod: 'ogdpgufptemcgyszmjek',
    staging: 'blfnyxwcriyxvsaubiqb',
  },
]

// Crons that live ONLY on prod BY DESIGN — production silent-failure monitors that watch
// real customer data (auth.users, live Google connections). Running them against staging is
// pointless and would raise false alarms, so they are deliberately never scheduled there.
// Keyed by product, matched on jobname (the part before ' ['). ONLY prod-only extras are
// tolerated — a staging-only cron is NEVER whitelisted here, that is always genuine drift.
const EXPECTED_PROD_ONLY_CRONS = {
  ReplyFlow: ['monitor-email-integrity-daily', 'monitor-sync-health-hourly'],
}

const SCHEMA_SQL = `
  SELECT table_name || '.' || column_name || ':' || data_type AS entry
  FROM information_schema.columns
  WHERE table_schema = 'public'
  ORDER BY 1`

const CONSTRAINT_SQL = `
  SELECT conrelid::regclass::text || '.' || conname || ':' || pg_get_constraintdef(oid) AS entry
  FROM pg_constraint
  WHERE connamespace = 'public'::regnamespace AND contype IN ('c','f','u','p')
  ORDER BY 1`

const CRON_SQL = `
  SELECT jobname || ' [' || schedule || ']' AS entry, command
  FROM cron.job WHERE active ORDER BY 1`

const failures = []
const fail = (m) => { failures.push(m); console.error(`  DRIFT ${m}`) }
const ok = (m) => console.log(`  OK  ${m}`)

async function query(ref, pat, sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  })
  if (!res.ok) throw new Error(`query(${ref}) HTTP ${res.status}: ${(await res.text()).slice(0, 150)}`)
  return res.json()
}

function diffSets(prodRows, stagingRows) {
  const p = new Set(prodRows)
  const s = new Set(stagingRows)
  return {
    prodOnly: [...p].filter((x) => !s.has(x)),
    stagingOnly: [...s].filter((x) => !p.has(x)),
  }
}

for (const { name, patEnv, prod, staging } of PRODUCTS) {
  console.log(`\n== ${name} (prod ${prod} vs staging ${staging})`)
  const pat = process.env[patEnv]
  if (!pat) { fail(`${name}: env ${patEnv} not set`); continue }

  try {
    // 1. Schema columns
    const [pCols, sCols] = await Promise.all([
      query(prod, pat, SCHEMA_SQL),
      query(staging, pat, SCHEMA_SQL),
    ])
    // AN EMPTY READ IS NOT PARITY (2026-09-03 audit, proven by injection). If either side returns
    // zero rows — a permission-scoped PAT, a query against the wrong schema, a Management-API quirk
    // that answers 200 with `[]` instead of erroring — then two empty sets are trivially
    // "identical" and every leg below reports total health over a database nobody actually read.
    // A LIVE SUPABASE PROJECT ALWAYS HAS PUBLIC COLUMNS, so zero columns is a failed read, never an
    // empty schema. Fail loud and skip this product's remaining legs, whose "identical (0)" would
    // be the same lie one line down. (The schema read is the sentinel: if the connection or PAT is
    // broken for this product, the constraint and cron reads are empty too.)
    if (pCols.length === 0 || sCols.length === 0) {
      fail(`${name} schema: read ${pCols.length} column(s) from PROD and ${sCols.length} from STAGING — a live project always has public columns, so this is a FAILED READ (scoped PAT / wrong schema / empty API response), not parity. Not trusting constraints or cron parity either.`)
      continue
    }
    const colDiff = diffSets(pCols.map((r) => r.entry), sCols.map((r) => r.entry))
    if (colDiff.prodOnly.length || colDiff.stagingOnly.length) {
      fail(`${name} schema: ${colDiff.prodOnly.length} column(s) only in PROD, ${colDiff.stagingOnly.length} only in STAGING`)
      colDiff.prodOnly.slice(0, 10).forEach((e) => console.error(`      prod-only:    ${e}`))
      colDiff.stagingOnly.slice(0, 10).forEach((e) => console.error(`      staging-only: ${e}`))
    } else ok(`${name} schema columns identical (${pCols.length})`)

    // 2. Constraints (CHECK/FK/UNIQUE/PK definitions)
    const [pCon, sCon] = await Promise.all([
      query(prod, pat, CONSTRAINT_SQL),
      query(staging, pat, CONSTRAINT_SQL),
    ])
    const conDiff = diffSets(pCon.map((r) => r.entry), sCon.map((r) => r.entry))
    if (conDiff.prodOnly.length || conDiff.stagingOnly.length) {
      fail(`${name} constraints: ${conDiff.prodOnly.length} only in PROD, ${conDiff.stagingOnly.length} only in STAGING`)
      conDiff.prodOnly.slice(0, 6).forEach((e) => console.error(`      prod-only:    ${e.slice(0, 140)}`))
      conDiff.stagingOnly.slice(0, 6).forEach((e) => console.error(`      staging-only: ${e.slice(0, 140)}`))
    } else ok(`${name} constraints identical (${pCon.length})`)

    // 3. Cron jobs: parity + placeholder rot (checked per environment)
    const [pCron, sCron] = await Promise.all([
      query(prod, pat, CRON_SQL),
      query(staging, pat, CRON_SQL),
    ])
    const cronDiff = diffSets(pCron.map((r) => r.entry), sCron.map((r) => r.entry))
    const allowProdOnly = EXPECTED_PROD_ONLY_CRONS[name] ?? []
    const jobOf = (entry) => entry.split(' [')[0]
    const expectedProdOnly = cronDiff.prodOnly.filter((e) => allowProdOnly.includes(jobOf(e)))
    const unexpectedProdOnly = cronDiff.prodOnly.filter((e) => !allowProdOnly.includes(jobOf(e)))
    if (unexpectedProdOnly.length || cronDiff.stagingOnly.length) {
      fail(`${name} cron jobs differ — prod-only: [${unexpectedProdOnly.join('; ')}], staging-only: [${cronDiff.stagingOnly.join('; ')}]`)
    } else {
      ok(`${name} cron jobs in parity (${sCron.length} shared${expectedProdOnly.length ? `, +${expectedProdOnly.length} expected prod-only monitor: ${expectedProdOnly.map(jobOf).join(', ')}` : ''})`)
    }

    for (const [env, rows] of [['PROD', pCron], ['STAGING', sCron]]) {
      for (const row of rows) {
        if ((row.command ?? '').includes('<<')) {
          fail(`${name} ${env} cron '${row.entry}' contains an unsubstituted <<placeholder>>`)
        }
      }
    }
  } catch (e) {
    fail(`${name}: ${String(e).slice(0, 200)}`)
  }
}

console.log('')
if (failures.length) {
  // Machine-readable payload so send-drift-alert.mjs renders the real findings,
  // not the Playwright-shaped "no report produced" fallback of send-alert.mjs.
  writeFileSync('drift-results.json', JSON.stringify(failures, null, 2))
  console.error(`DRIFT DETECTED (${failures.length} finding(s)) — staging is not a truthful rehearsal of prod until resolved.`)
  process.exitCode = 1
} else {
  console.log('No drift across all products.')
}
