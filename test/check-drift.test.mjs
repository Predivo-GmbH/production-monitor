/**
 * Integration test for the staging<->prod schema-drift guard's empty-read blindness.
 *
 * THE DEFECT (2026-09-03 audit, proven by injection). check-drift.mjs compares prod and staging
 * schema/constraint/cron sets and reports "identical" when the two sets are equal. But it never
 * checked that anything was actually READ: if both `query(prod)` and `query(staging)` return `[]`
 * — a permission-scoped PAT, a query against the wrong schema, a Management-API response that
 * answers 200 with an empty array instead of erroring — the two empty sets are trivially equal and
 * every leg reports total health, fleet-wide, over databases nobody read. The guard silently
 * disables itself while printing the cleanest possible "No drift".
 *
 * This drives the REAL script with `--import` shims that replace `fetch`, so no live system is
 * touched. An all-empty response must now FAIL the run (it exited 0 "No drift" before the fix); a
 * non-empty identical response must still PASS, proving the guard does not break the happy path.
 * Revert the guard in check-drift.mjs and the empty-read assertion goes red.
 *
 * Run: node test/check-drift.test.mjs   (exit 0 = all pass)
 */
import assert from 'node:assert'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../scripts/check-drift.mjs', import.meta.url))

// A shim that intercepts every fetch and answers the Supabase Management API `query` endpoint with
// a fixed body. check-drift only ever calls that endpoint, so replacing fetch wholesale is safe.
const shimSource = (rowsExpr) => `globalThis.fetch = async () => ({
  ok: true, status: 200,
  json: async () => (${rowsExpr}),
  text: async () => '[]',
})
`

const FAKE_PATS = {
  SUPABASE_TOKEN_REPLYFLOW: 'fake', SUPABASE_TOKEN_CHANNELMOVER: 'fake', SUPABASE_TOKEN_MUELLER: 'fake',
}

function runWithShim(rowsExpr) {
  const dir = mkdtempSync(join(tmpdir(), 'check-drift-'))
  const shim = join(dir, 'shim.mjs')
  writeFileSync(shim, shimSource(rowsExpr))
  try {
    const out = execFileSync(process.execPath, ['--import', pathToFileURL(shim).href, SCRIPT], {
      encoding: 'utf8',
      cwd: dir, // keep any drift-results.json out of the repo
      env: { ...process.env, ...FAKE_PATS },
    })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

let n = 0
const t = (name, cond) => { assert.ok(cond, name); n++; console.log(`  ok - ${name}`) }

// THE INJECTED FAILURE: both sides read empty. Before the fix this was exit 0, "No drift".
const empty = runWithShim('[]')
t('an all-empty read now FAILS the run (it read "No drift" over an unread database before the fix)',
  empty.code === 1)
t('the empty read is NAMED a failed read, not reported as parity',
  /FAILED READ/.test(empty.out) && !/No drift across all products/.test(empty.out))

// THE HAPPY PATH must survive: a non-empty, identical response on both sides is real parity.
const identical = runWithShim("[{ entry: 'users.id:uuid', command: 'select 1' }]")
t('a non-empty identical read still passes as parity (the guard does not cry wolf)',
  identical.code === 0 && /No drift across all products/.test(identical.out))

console.log(`\n${n} passed`)
