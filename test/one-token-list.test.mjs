/**
 * TWO HOURLY SWEEPS, ONE ANSWER TO "WHAT IS A MANAGEMENT TOKEN".
 *
 * scripts/expire-stale-sessions.mjs and scripts/check-supabase-build-currency.mjs are graded
 * against the same written-down inventory (scripts/lib/supabase-projects-baseline.json) through
 * the same coverageGaps(). Commit f11a065 unified that half on 2026-08-30 and left each script
 * holding its own regex for token DISCOVERY, and the two regexes were not the same:
 *
 *   expire-stale-sessions.mjs         /^SUPABASE_TOKEN_|_SUPABASE_ACCESS_TOKEN$/ && env[k]
 *   check-supabase-build-currency.mjs /^SUPABASE_TOKEN_|_SUPABASE_ACCESS_TOKEN$|^SUPABASE_ACCESS_TOKEN$/
 *
 * The baseline is authored by the WIDER one — only the build check prints the "observed project
 * inventory (ground truth for supabase-projects-baseline.json)" block, and the baseline's own
 * sourceOfTruth/capturedFrom fields name a build-currency run — and the NARROWER one is graded
 * against it. Add a bare SUPABASE_ACCESS_TOKEN and its projects enter the baseline invisibly to
 * the session sweep, which then reports them missing every hour: an alarm about products it
 * never looked at, with nothing at the other end for anyone to fix.
 *
 * Both now import managementTokenKeys() from scripts/lib/supabase-token.mjs. The two source
 * assertions below are the part that lasts: a shared helper that nothing checks is a shared
 * helper one careless edit forks back into two dialects, silently, exactly as happened here.
 *
 * Pure: no network, no secrets, no services. Run: node test/one-token-list.test.mjs
 */
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { managementTokenKeys } from '../scripts/lib/supabase-token.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPTS = join(HERE, '..', 'scripts')
const SWEEPS = ['expire-stale-sessions.mjs', 'check-supabase-build-currency.mjs']
const src = (f) => readFileSync(join(SCRIPTS, f), 'utf8')
/**
 * Comments stripped before any source assertion. Both sweeps QUOTE the two old regexes in their
 * explanations of why they no longer have one, and a scanner that cannot tell an explanation
 * from an implementation would fail on the very note that documents the fix.
 */
const code = (f) => src(f).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ')

let passed = 0
let failed = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok   - ${name}`); passed++ }
  catch (e) { console.log(`  FAIL - ${name}: ${e.message}`); failed++ }
}

// --- the shared helper answers what both sweeps need ---------------------------------------

check('the bare SUPABASE_ACCESS_TOKEN form counts — the difference that made the two lists disagree', () => {
  assert.deepEqual(managementTokenKeys({ SUPABASE_ACCESS_TOKEN: 'sbp_x' }), ['SUPABASE_ACCESS_TOKEN'])
})

check('both prefixed forms count', () => {
  assert.deepEqual(
    managementTokenKeys({ SUPABASE_TOKEN_CHANNELMOVER: 'a', VALRANO_SUPABASE_ACCESS_TOKEN: 'b' }),
    ['SUPABASE_TOKEN_CHANNELMOVER', 'VALRANO_SUPABASE_ACCESS_TOKEN'])
})

check('an UNSET GitHub secret expands to an empty string and is not a token', () => {
  assert.deepEqual(managementTokenKeys({ SUPABASE_TOKEN_DEAD: '', SUPABASE_TOKEN_LIVE: 'sbp_x' }), ['SUPABASE_TOKEN_LIVE'])
})

check('things that merely look token-shaped are not management tokens', () => {
  assert.deepEqual(managementTokenKeys({
    REPLYFLOW_SUPABASE_URL: 'https://x.supabase.co',
    REPLYFLOW_SERVICE_ROLE_KEY: 'sb_secret_x',
    BOARD_SUPABASE_SECRET: 'sb_secret_y',
    SUPABASE_ACCESS_TOKEN_OLD: 'sbp_x',
  }), [])
})

check('the order is sorted, so a run does not depend on how the environment happened to be built', () => {
  assert.deepEqual(
    managementTokenKeys({ ZZ_SUPABASE_ACCESS_TOKEN: 'a', AA_SUPABASE_ACCESS_TOKEN: 'b', SUPABASE_TOKEN_M: 'c' }),
    ['AA_SUPABASE_ACCESS_TOKEN', 'SUPABASE_TOKEN_M', 'ZZ_SUPABASE_ACCESS_TOKEN'])
})

// --- the part that stops it forking again ---------------------------------------------------

for (const f of SWEEPS) {
  check(`${f} imports the shared list rather than defining its own`, () => {
    assert.match(src(f), /import \{[^}]*managementTokenKeys[^}]*\} from '\.\/lib\/supabase-token\.mjs'/,
      'the sweep must take its token list from scripts/lib/supabase-token.mjs')
  })

  check(`${f} contains no token-name regex of its own`, () => {
    const own = code(f).match(/\/\^?SUPABASE_TOKEN_[^\n]*\//g)
    assert.equal(own, null, `a second dialect has reappeared in ${f}: ${own?.join(' | ')}`)
  })
}

check('exactly ONE file in scripts/ decides what a management token is', () => {
  // The two sweeps plus the helper itself; the helper is the only legitimate home.
  const owners = ['lib/supabase-token.mjs', ...SWEEPS].filter((f) => /\/\^?SUPABASE_TOKEN_[^\n]*\//.test(code(f)))
  assert.deepEqual(owners, ['lib/supabase-token.mjs'],
    'the token-name pattern must live in scripts/lib/supabase-token.mjs and nowhere else')
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
