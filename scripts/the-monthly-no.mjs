#!/usr/bin/env node
/**
 * THE ONE WAY THE BOARD SHRINKS WITHOUT ANYBODY DOING THE WORK: Roger says no, once, to many.
 *
 * -- WHY THIS EXISTS -------------------------------------------------------------------------
 *
 * A board empties two ways: something is finished, or somebody decides it will never be done.
 * The work-board requirement had only the first for its entire v1, which was checked and found
 * literally true -- zero mentions of abandoning, dropping or not-doing anywhere in the document.
 * With only one exit, "the never-ending story" Roger named is guaranteed by construction: the
 * board can only grow by exactly the amount of work nobody will ever choose to do.
 *
 * The second exit is a DECISION, and decisions are his. So this does not abandon anything. It
 * takes every `low` row nobody has touched in a month and turns them into ONE question. One act
 * of his attention, N rows off the board -- or N rows with their clock reset, which is also a
 * real answer and costs him the same single act.
 *
 * -- WHY `low` AND WHY 30 DAYS ---------------------------------------------------------------
 *
 * `low` is defined in this house (2026-08-27, sql/068) as "hygiene; when there is time". A
 * hygiene item nobody has touched in a month is the honest definition of something that is not
 * going to happen. Deliberately NOT included: `unjudged`, which means nobody has LOOKED yet --
 * bundling those would ask him to drop work that was never assessed, which is the opposite of
 * the point. `normal` and above are never bundled at all.
 *
 * -- WHAT IT WILL NOT DO ---------------------------------------------------------------------
 *
 *   * It never abandons a row. Only his word closes one, through the normal sign-off path.
 *   * It never bundles a row already in his lane -- that row is already costing him attention,
 *     and asking a second question about it is noise.
 *   * It never bundles a claimed or in-progress row: somebody is on it, so it is not abandoned.
 *   * It never files a second bundle while one is still open and unanswered. A pile of monthly
 *     bundles is the thing it exists to prevent.
 *
 *   node scripts/the-monthly-no.mjs           show what would be asked
 *   node scripts/the-monthly-no.mjs --write   file the one question
 */
import { readFileSync } from 'fs'
import { sayVerdict, PASS, UNKNOWN } from './lib/check-verdict.mjs'

const CLAUDE_CONFIG = 'C:/Users/roger_rwjnmnz/.claude.json'
const DAY = 86_400_000
export const UNTOUCHED_DAYS = Number(process.env.NO_BUNDLE_DAYS || 30)
export const BUNDLE_SLUG = 'the-monthly-no-shall-we-drop-these'

export function loadBoardCredentials({ configPath = CLAUDE_CONFIG, read = readFileSync, env = process.env } = {}) {
  let raw
  try { raw = JSON.parse(read(configPath, 'utf8')) } catch (e) { return { ok: false, why: `could not read the board registration (${e.code || e.message})` } }
  const found = raw?.mcpServers?.['cockpit-mcp']?.env || {}
  for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY']) {
    if (!found[k]) return { ok: false, why: `the board registration is missing ${k}` }
    env[k] = found[k]
  }
  return { ok: true }
}

/** A row already costing Roger attention is never bundled — a second question about it is noise. */
export function alreadyOnHisPlate(r) {
  if (String(r?.blocked_owner || '').toLowerCase() === 'roger') return true
  return r?.status === 'awaiting_signoff'
}

/**
 * The rows the question is about. Pure, so the selection can be argued with offline.
 * Touched means: any evidence, any claim, any state change. `last_evidence_at` is bumped by every
 * mutating board command, which is exactly "somebody did something to this".
 */
export function selectForTheNoBundle({ rows = [], now = Date.now(), days = UNTOUCHED_DAYS } = {}) {
  const cutoff = now - days * DAY
  return (rows || []).filter((r) => {
    if (!r) return false
    if (['done', 'abandoned'].includes(r.status)) return false
    if (r.priority !== 'low') return false                     // never `unjudged`: nobody LOOKED yet
    if (r.status === 'in_progress' || r.owner_session) return false   // somebody is on it
    if (alreadyOnHisPlate(r)) return false
    if (r.merged_into) return false
    const touched = Date.parse(r.last_evidence_at || r.state_since || r.opened_at || '')
    if (!Number.isFinite(touched)) return false                // cannot tell how old: leave it alone
    return touched < cutoff
  })
}

/** The one question, written in his words. Never a file path, never a slug standing alone. */
export function composeTheQuestion(items, days = UNTOUCHED_DAYS) {
  const n = items.length
  const lines = items.map((r, i) => `${i + 1}. ${r.title}`).join('\n')
  return {
    title: `${n} small jobs nobody has touched in ${days} days — shall we drop them?`,
    question:
      `These ${n} are all filed as "when there is time", and nothing has happened on any of them for `
      + `at least ${days} days. Say DROP THEM and they close as decided-against; say KEEP and the clock `
      + `starts again. You can also name the ones you want to keep and drop the rest — one answer either way.\n\n`
      + lines,
  }
}

// ── the run ───────────────────────────────────────────────────────────────────────────────────

const H = () => ({
  apikey: process.env.SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
  'Content-Type': 'application/json',
})

async function board(path, opts = {}) {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, { headers: H(), ...opts })
  const text = await res.text()
  if (!res.ok) throw new Error(`board ${res.status}: ${text.slice(0, 160)}`)
  return text ? JSON.parse(text) : null
}

async function main() {
  const write = process.argv.includes('--write')
  const cred = loadBoardCredentials()
  if (!cred.ok) { sayVerdict(UNKNOWN, `the monthly no could NOT run: ${cred.why}. This is unknown, not fine.`); return 1 }

  // NEVER A SECOND BUNDLE WHILE ONE IS OPEN. A stack of unanswered monthly questions is precisely
  // the pile-up this exists to prevent, and it would be filed under his own name.
  const existing = await board(`work_items?slug=eq.${BUNDLE_SLUG}&status=not.in.(done,abandoned)&select=slug,status,opened_at`)
  if (existing?.length) {
    console.log(`  a bundle from ${String(existing[0].opened_at).slice(0, 10)} is still open and unanswered — not filing a second one`)
    sayVerdict(PASS, 'the monthly no is already waiting on Roger; nothing new filed')
    return 0
  }

  const rows = await board('work_items?status=not.in.(done,abandoned)&select=id,slug,title,status,priority,owner_session,blocked_owner,merged_into,opened_at,state_since,last_evidence_at&limit=5000')
  const picked = selectForTheNoBundle({ rows })
  if (!picked.length) {
    console.log(`  no "when there is time" row has gone ${UNTOUCHED_DAYS} days untouched — nothing to ask about`)
    sayVerdict(PASS, 'nothing to bundle')
    return 0
  }

  const q = composeTheQuestion(picked)
  console.log(`\n  ${q.title}\n`)
  for (const r of picked) console.log(`    - ${r.title}`)
  if (!write) { console.log(`\n  (dry run — pass --write to file the one question)`); return 0 }

  const [item] = await board('work_items', {
    method: 'POST',
    headers: { ...H(), Prefer: 'return=representation' },
    body: JSON.stringify({
      slug: BUNDLE_SLUG, title: q.title, kind: 'task', source: 'monitor',
      opened_by: 'the-monthly-no', status: 'blocked', blocked_owner: 'roger',
      blocked_question: q.question, priority: 'low',
    }),
  })
  await board('work_evidence', {
    method: 'POST', headers: { ...H(), Prefer: 'return=minimal' },
    body: JSON.stringify({
      item_id: item.id, kind: 'decision', verified: false,
      title: `${picked.length} rows bundled into one question`,
      detail: `Every row here is filed "when there is time" and untouched for at least ${UNTOUCHED_DAYS} days. `
        + `Nothing has been abandoned: machines never drop work in this house, and this row exists so that ONE `
        + `answer settles all ${picked.length}. The rows: ${picked.map((r) => r.slug).join(', ')}`,
    }),
  })
  console.log(`\n  filed as "${BUNDLE_SLUG}" — one question, ${picked.length} rows`)
  sayVerdict(PASS, `the monthly no is filed: ${picked.length} rows in one question`)
  return 0
}

if (import.meta.url === (await import('url')).pathToFileURL(process.argv[1] || '').href) {
  main().then(
    (code) => { process.exitCode = code },
    (e) => { sayVerdict(UNKNOWN, `the monthly no could NOT run (${e.message}). This is unknown, not fine.`); process.exitCode = 1 },
  )
}
