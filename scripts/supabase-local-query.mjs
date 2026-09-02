#!/usr/bin/env node
/**
 * LOOK INSIDE A LIVE PRODUCT DATABASE FROM THIS MACHINE.
 *
 * This is the thing the critical signal fleet:supabase-mgmt-tokens-dead-on-disk said was
 * impossible for four days. It was never impossible; there was simply no route from "the product
 * I want to look at" to "the one token out of fourteen that opens it". See
 * scripts/lib/local-management-tokens.mjs for the full account of how that became a critical.
 *
 *   node scripts/supabase-local-query.mjs --list
 *   node scripts/supabase-local-query.mjs ReplyFlow "select count(*) from auth.users"
 *   node scripts/supabase-local-query.mjs dqmhsdzldkxngwjrxois "select 1"
 *
 * The project can be named or given by ref. --list prints the whole local inventory: which
 * accounts have a working token on this disk and what each one opens.
 *
 * NO TOKEN VALUE IS EVER PRINTED, not in full, not as a prefix, not as a length. Tokens are named
 * by an eight-character hash and nothing else, and the same goes for anything this script's
 * output is pasted into. A prefix is a secret in the only sense that matters: it narrows a guess.
 */
import { inventory, tokenForProject, runSql, FLEET_ROOT } from './lib/local-management-tokens.mjs'

const [target, ...rest] = process.argv.slice(2)
const sql = rest.join(' ')

if (!target || target === '--help' || target === '-h') {
  console.log(`usage:
  node scripts/supabase-local-query.mjs --list
  node scripts/supabase-local-query.mjs <project name or ref> "<sql>"

fleet root: ${FLEET_ROOT}`)
  process.exit(target ? 0 : 2)
}

if (target === '--list') {
  const rows = await inventory()
  const alive = rows.filter((r) => r.alive)
  console.log(`management tokens on this disk: ${rows.length}  (live ${alive.length}, dead ${rows.length - alive.length})\n`)
  console.log('token     status  account                              opens')
  for (const r of rows.sort((a, b) => Number(b.alive) - Number(a.alive) || String(a.account).localeCompare(String(b.account)))) {
    const opens = r.projects.map((p) => `${p.name} (${p.ref})`).join(', ') || '-'
    console.log(`${r.id}  ${String(r.status).padEnd(6)}  ${String(r.account ?? '(dead - unknown)').padEnd(35)} ${opens}`)
  }
  process.exit(0)
}

if (!sql) {
  console.error('A query is required. Example: node scripts/supabase-local-query.mjs ReplyFlow "select 1"')
  process.exit(2)
}

const found = await tokenForProject(target)
if (!found) {
  // NOT "the token is dead" - the honest statement is that nothing on this disk opens it, which
  // is the only one of the two facts that is ever worth escalating to a person.
  console.error(`No management token on this disk opens "${target}".`)
  console.error('Run --list to see which accounts this machine can reach.')
  process.exit(1)
}

const { status, rows } = await runSql(found.project.ref, sql, found.token)
// A successful POST to database/query answers 201, not 200.
if (status !== 200 && status !== 201) {
  console.error(`Query refused: HTTP ${status} on ${found.project.name} (${found.project.ref}) using token ${found.id}.`)
  process.exit(1)
}
console.log(`${found.project.name} (${found.project.ref})  via token ${found.id}  HTTP ${status}  rows: ${Array.isArray(rows) ? rows.length : 0}`)
console.log(JSON.stringify(rows, null, 1))
