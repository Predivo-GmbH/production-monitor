/**
 * Unit test for check-supabase-build-currency.mjs — the BLIND path.
 *
 * THE 2026-08-30 BUG: 986d205 moved this check's findings onto the Cockpit signals board,
 * because a bare process.exit(1) only reds the workflow and send-alert.mjs reads Playwright's
 * results.json — so the alert email lists ZERO failures while the real fact appears nowhere a
 * person looks. That fix was applied to the `behind` path only. The `unreadable` path kept the
 * bare exit, and `unreadable` was the path that was actually red: on 2026-08-30 the monitor
 * failed hourly on SUPABASE_TOKEN_CHANNELMOVER (401), YTMIGRATION_SUPABASE_ACCESS_TOKEN (401)
 * and arivioo-staging (no build version), and the reason existed only inside a workflow log.
 *
 * Blindness still exits non-zero — the house rule in fleet-signal.mjs is that only a failed
 * READ exits non-zero, and a watchdog that could not read IS a failed read. These cases pin
 * that the fact is FILED as well, and that a dead token reads differently from a dead project,
 * because the remedies differ: one needs a new token minted by a person, the other needs the
 * project looked at. No network, no secrets, no services.
 *
 * Run: node test/check-supabase-build-currency.test.mjs   (exit 0 = all pass)
 */
import assert from 'node:assert'
import { spawnSync } from 'node:child_process'
import { blindSignal, coverageGaps, deadTokenSignal, exitDecision, missingFindings, managementApiOnly, outOfManagementApiReach, outOfReachSignal } from '../scripts/check-supabase-build-currency.mjs'
import { loadBaseline, outOfReachLine } from '../scripts/lib/supabase-coverage.mjs'

let passed = 0
let failed = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok   - ${name}`); passed++ }
  catch (e) { console.log(`  FAIL - ${name}: ${e.message}`); failed++ }
}

check('a fully readable sweep files nothing', () => {
  assert.equal(blindSignal([{ product: 'ReplyFlow', level: 'ok' }, { product: 'Valrano', level: 'warn' }]), null,
    'only blindness files a blindness row')
})

check('the row asks for a human and is keyed stably', () => {
  const row = blindSignal([{ product: 'SUPABASE_TOKEN_CHANNELMOVER', level: 'unreadable', isToken: true, detail: 'management API returned 401 — token dead or rotated' }])
  assert.equal(row.needs_human, true, 'only a person can mint a replacement management token')
  assert.equal(row.severity, 'critical')
  assert.equal(row.key, 'supabase-build-currency-blind', 'a stable key updates one row instead of breeding duplicates every hour')
})

// The real 2026-08-30 run: two dead tokens and one project that would not report a version.
check('dead TOKENS and unreadable PROJECTS are counted and described separately', () => {
  const row = blindSignal([
    { product: 'Valrano Production', level: 'ok' },
    { product: 'SUPABASE_TOKEN_CHANNELMOVER', level: 'unreadable', isToken: true, detail: 'management API returned 401 — token dead or rotated' },
    { product: 'YTMIGRATION_SUPABASE_ACCESS_TOKEN', level: 'unreadable', isToken: true, detail: 'management API returned 401 — token dead or rotated' },
    { product: 'arivioo-staging', level: 'unreadable', detail: 'could not read build version' },
  ])
  assert.match(row.summary, /2 management token\(s\)/, 'the two dead tokens must be counted as tokens')
  assert.match(row.summary, /1 project\(s\)/, 'the unreadable project must NOT be lumped in with the tokens')
  assert.match(row.summary, /SUPABASE_TOKEN_CHANNELMOVER/)
  assert.match(row.summary, /YTMIGRATION_SUPABASE_ACCESS_TOKEN/, 'every dead token must be named, not just the first')
  assert.match(row.summary, /arivioo-staging/)
  assert.equal(row.title, 'The Supabase build watchdog is blind for 3 subject(s)')
  assert.equal(row.detail.blind.length, 3, 'the machine-readable detail must carry all three')
  assert.equal(row.detail.blind.filter((b) => b.isToken).length, 2)
})

check('an unreadable-projects-only sweep does not claim any token is dead', () => {
  const row = blindSignal([{ product: 'arivioo-staging', level: 'unreadable', detail: 'could not read build version' }])
  assert.ok(!/management token/.test(row.summary), 'no dead token must be implied when every token authenticated')
  assert.match(row.summary, /1 project\(s\)/)
})

// ---------------------------------------------------------------------------------------
// COVERAGE — the 2026-08-30 hole. The sweep only reported projects a token handed it, so a
// project no token could see was ABSENT rather than unreadable, and absent read as fine.
// ---------------------------------------------------------------------------------------

const BASELINE = { projects: [{ ref: 'aaa', product: 'ReplyFlow' }, { ref: 'bbb', product: 'Valrano Production' }] }

check('a project no token can see is a GAP, not a silent pass', () => {
  const gaps = coverageGaps([{ ref: 'aaa', product: 'ReplyFlow', level: 'ok' }], BASELINE)
  assert.deepEqual(gaps.map((p) => p.product), ['Valrano Production'],
    'the project that no token listed is the whole point of the baseline')
})

check('no baseline is UNPROVEN coverage, which is not the same fact as nothing missing', () => {
  assert.equal(coverageGaps([{ ref: 'aaa', level: 'ok' }], null), null, 'null means we never established what to expect')
  assert.deepEqual(coverageGaps([{ ref: 'aaa', level: 'ok' }, { ref: 'bbb', level: 'ok' }], BASELINE), [],
    'an empty array means PROVEN complete — collapsing these two into one value is the original bug')
})

check('a dead token is never mistaken for coverage of a project', () => {
  // The token finding carries no ref, so it must not satisfy any baseline entry.
  const gaps = coverageGaps([
    { ref: 'aaa', product: 'ReplyFlow', level: 'ok' },
    { product: 'YTMIGRATION_SUPABASE_ACCESS_TOKEN', level: 'unreadable', isToken: true },
  ], BASELINE)
  assert.deepEqual(gaps.map((p) => p.ref), ['bbb'])
})

check('a gap becomes a named, actionable finding rather than a count', () => {
  const [f] = missingFindings([{ ref: 'bbb', product: 'Valrano Production' }])
  assert.equal(f.level, 'unreadable')
  assert.equal(f.product, 'Valrano Production')
  assert.match(f.detail, /bbb/, 'the ref must be in the text — that is what a person needs to go look it up')
  assert.equal(missingFindings(null).length, 0, 'unproven coverage invents no findings')
})

// ---------------------------------------------------------------------------------------
// EXIT POLICY — the real 2026-08-30 red was a dead token whose projects were all being read
// by other tokens. It could not be cleared by anything the automation is allowed to do.
// ---------------------------------------------------------------------------------------

const DEAD_TOKEN = { product: 'YTMIGRATION_SUPABASE_ACCESS_TOKEN', level: 'unreadable', isToken: true, detail: 'management API returned 401 — token dead or rotated' }

check('a dead token does NOT red the run once the sweep is proven complete without it', () => {
  const { code, reasons } = exitDecision([{ ref: 'aaa', product: 'ReplyFlow', level: 'ok' }, DEAD_TOKEN], [])
  assert.equal(code, 0, 'every expected project was read, so the READ succeeded — the house rule is that only a failed read exits non-zero')
  assert.deepEqual(reasons, [])
})

check('the same dead token DOES red the run while coverage is unproven', () => {
  const { code, reasons } = exitDecision([{ ref: 'aaa', level: 'ok' }, DEAD_TOKEN], null)
  assert.equal(code, 1, 'with no baseline nothing establishes what the sweep should have found')
  assert.match(reasons.join(' '), /no project baseline/)
})

check('an unwatched project reds the run and is named', () => {
  const findings = [{ ref: 'aaa', product: 'ReplyFlow', level: 'ok' }, ...missingFindings([{ ref: 'bbb', product: 'Valrano Production' }])]
  const { code, reasons } = exitDecision(findings, [{ ref: 'bbb', product: 'Valrano Production' }])
  assert.equal(code, 1)
  assert.match(reasons.join(' '), /Valrano Production/, 'a red that does not say which product is a red nobody can act on')
})

check('behind-but-not-eligible still reds, and behind-but-eligible still does not', () => {
  assert.equal(exitDecision([{ ref: 'a', product: 'X', level: 'blocked' }], []).code, 1)
  assert.equal(exitDecision([{ ref: 'a', product: 'X', level: 'warn' }], []).code, 0, 'an eligible upgrade is a board decision, not an hourly alarm')
})

// ---------------------------------------------------------------------------------------
// THE TWO BOARD ROWS — never the wrong one, never only one when both are true.
// ---------------------------------------------------------------------------------------

check('a harmless dead token files housekeeping, and does not claim anything is unwatched', () => {
  const row = deadTokenSignal([{ ref: 'aaa', level: 'ok' }, DEAD_TOKEN], [], BASELINE)
  assert.equal(row.severity, 'warning', 'it cannot be fixed by anyone on duty, so it must not ring like an outage')
  assert.equal(row.needs_human, true, 'only a person may delete a secret')
  assert.equal(row.key, 'supabase-dead-management-token')
  assert.ok(!/nobody is watching/.test(row.summary), 'the projects WERE read this run — saying otherwise is simply false')
  assert.match(row.summary, /gh secret delete YTMIGRATION_SUPABASE_ACCESS_TOKEN/, 'the remedy must be the actual command')
})

check('housekeeping is withheld whenever the sweep was not proven complete', () => {
  assert.equal(deadTokenSignal([DEAD_TOKEN], null, null), null, 'unproven coverage may not call a dead token harmless')
  assert.equal(deadTokenSignal([DEAD_TOKEN], [{ ref: 'bbb', product: 'Valrano Production' }], BASELINE), null,
    'with a project actually missing, the dead token is a suspect, not housekeeping')
})

check('a harmless dead token never silences a real unreadable project', () => {
  // Both true at once: the token cost nothing, and arivioo-staging would not report a version.
  const findings = [{ ref: 'aaa', product: 'ReplyFlow', level: 'ok' }, DEAD_TOKEN, { ref: 'ccc', product: 'arivioo-staging', level: 'unreadable', detail: 'could not read build version' }]
  const stillBlind = findings.filter((f) => !(f.isToken && f.level === 'unreadable'))
  const row = blindSignal(stillBlind)
  assert.match(row.summary, /arivioo-staging/, 'the real blindness must still reach the board')
  assert.ok(!/management token/.test(row.summary), 'and it must not blame the token that was fine')
  assert.equal(exitDecision(findings, []).code, 1, 'the unreadable project still reds the run')
})

// ---------------------------------------------------------------------------------------
// WIRING — 6f2fd93: an exit policy here was exported, documented and unit-tested while the
// CLI had quietly stopped calling it. A green test on an exported function proves nothing
// about what the product does, so this spawns the real script.
// ---------------------------------------------------------------------------------------

check('the SHIPPED script enforces coverage and exits on it', () => {
  // No management tokens in the environment -> the sweep sees nothing -> every baseline
  // project is a gap. BOARD_SUPABASE_SECRET is a dummy on purpose: it makes the board POST
  // fail authentication so this test cannot write a row to the live signals board, and the
  // filing failure is caught by the script by design, so the exit code still comes from the
  // policy under test.
  const env = { ...process.env, BOARD_SUPABASE_SECRET: 'not-a-real-secret-this-test-must-not-file' }
  for (const k of Object.keys(env)) if (/^SUPABASE_TOKEN_|_SUPABASE_ACCESS_TOKEN$|^SUPABASE_ACCESS_TOKEN$/.test(k)) delete env[k]
  const r = spawnSync(process.execPath, ['scripts/check-supabase-build-currency.mjs'], { env, encoding: 'utf8', cwd: new URL('..', import.meta.url) })
  assert.equal(r.status, 1, 'a run that read nothing must never exit 0')
  assert.match(r.stdout, /coverage: 0\//, 'the shipped script must report coverage, not just count what it happened to see')
  assert.match(r.stderr, /project\(s\) could not be read/, 'and it must say why it failed where a person will read it')
})

// ---------------------------------------------------------------------------------------
// OUT OF MANAGEMENT REACH — 2026-09-01. The baseline named dkxdlovwzsxnepoteebk as "Beize
// Jass Tour". That is the OLD project, found EMPTY on 2026-08-22 and abandoned; the live
// database is uyksotlmrlxhmyeopktl in a NEW account (11api@predivo.ch) that no token in this
// repo belongs to. So this sweep spent ten days printing "OK Beize Jass Tour current" about a
// database with nothing in it — a green reading standing in for the real one, which is the
// exact class of lie the baseline file was created to end.
//
// Correcting the ref is necessary and not sufficient: on its own it would make this sweep
// report a coverage gap EVERY HOUR that nobody on duty can close, because closing it means
// adding a credential the automation is forbidden to set. These cases pin both halves.
// ---------------------------------------------------------------------------------------

const REACH_BASELINE = () => ({ projects: [
  { ref: 'uyksotlmrlxhmyeopktl', product: 'Beize Jass Tour', managementApi: false },
  { ref: 'aaaaaaaaaaaaaaaaaaaa', product: 'Other Product' },
] })
const OTHER_SWEPT = [{ ref: 'aaaaaaaaaaaaaaaaaaaa', product: 'Other Product', level: 'ok', detail: 'current' }]

check('the real baseline now names the LIVE Jass-Tour database, not the abandoned one', () => {
  const jt = loadBaseline().projects.filter((p) => /Jass/i.test(p.product))
  assert.equal(jt.length, 1, 'exactly one Jass-Tour entry')
  assert.equal(jt[0].ref, 'uyksotlmrlxhmyeopktl',
    'the live project the deployed bundle at beize-jass-tour.mueller.ro signs into')
  assert.notEqual(jt[0].ref, 'dkxdlovwzsxnepoteebk', 'the empty abandoned project must never be what a sweep reports on')
})

check('DEFECT, proven by injection: the corrected ref alone reds this sweep forever, with a gap nobody on duty can close', () => {
  // Every token works and lists everything it CAN list. It still cannot list a project in an
  // account it has no membership of, so that project is simply absent from the sweep.
  const gapsUnfiltered = coverageGaps(OTHER_SWEPT, REACH_BASELINE())
  assert.equal(gapsUnfiltered.length, 1)
  assert.equal(gapsUnfiltered[0].product, 'Beize Jass Tour')
  const dec = exitDecision([...OTHER_SWEPT, ...missingFindings(gapsUnfiltered)], gapsUnfiltered)
  assert.equal(dec.code, 1, 'THE TRAP: an hourly red whose only remedy is a human adding a credential — it can never be cleared on duty')
})

check('FIX: managementApiOnly() removes it from the comparison, so a healthy sweep is green', () => {
  const reachable = managementApiOnly(REACH_BASELINE())
  assert.equal(reachable.projects.length, 1)
  const gaps = coverageGaps(OTHER_SWEPT, reachable)
  assert.deepEqual(gaps, [], 'coverage is PROVEN complete over what a token could reach')
  assert.equal(exitDecision([...OTHER_SWEPT, ...missingFindings(gaps)], gaps).code, 0)
})

check('the excluded project is never silently dropped — it is named on its own line and on the board', () => {
  const unreachable = outOfManagementApiReach(REACH_BASELINE())
  assert.equal(unreachable.length, 1)
  const line = outOfReachLine(unreachable, 'read')
  assert.match(line, /Beize Jass Tour/)
  assert.match(line, /uyksotlmrlxhmyeopktl/, 'the ref must be in the text — that is what a person needs to go look it up')

  const row = outOfReachSignal(unreachable)
  assert.equal(row.key, 'supabase-project-out-of-management-reach')
  assert.equal(row.needs_human, false, 'adding a token is not an outage and must not ring a phone at 03:00')
  assert.match(row.detail, /SUPABASE_TOKEN_JASSTOUR/, 'the row must say exactly what closes it')
  assert.equal(outOfReachSignal([]), null, 'a fleet fully in reach files nothing')
  assert.equal(outOfReachLine([], 'read'), null)
})

check('a project reachable by NO route is still a gap — the flag routes the finding, it does not excuse the project', () => {
  // The flag is only ever consulted by the PAT-driven sweeps. check-supabase-machine-health.mjs
  // reaches this same project directly with its service-role key and compares against the
  // unfiltered (production) baseline, so nothing here removes it from every watchdog at once.
  const baseline = { projects: [{ ref: 'uyksotlmrlxhmyeopktl', product: 'Beize Jass Tour', managementApi: false }] }
  assert.equal(managementApiOnly(baseline).projects.length, 0, 'the PAT sweeps stop expecting it')
  assert.equal(coverageGaps([], baseline).length, 1, 'a sweep that reaches it another way still demands it')
})

check('managementApiOnly() is a no-op on null/empty baselines and on an unflagged fleet', () => {
  assert.equal(managementApiOnly(null), null)
  assert.equal(managementApiOnly({ projects: [] }).projects.length, 0)
  const plain = { projects: [{ ref: 'a', product: 'A' }, { ref: 'b', product: 'B' }] }
  assert.equal(managementApiOnly(plain).projects.length, 2, 'an entry with no flag is reachable — the exception must be written down on purpose')
  assert.equal(outOfManagementApiReach(plain).length, 0)
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
