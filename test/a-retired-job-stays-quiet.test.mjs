#!/usr/bin/env node
/**
 * NO ALARM IS SWITCHED OFF WITHOUT A REASON WRITTEN DOWN.
 *
 * THE ORIGINAL DEFECT, reported 2026-08-13: `KB Phase0 Daily` finished its backlog and was disabled
 * on purpose on 2026-08-27, but its healthchecks watch stayed armed with a one-day period, so it
 * expired and paged EVERY NIGHT for a job nobody wanted running. There is no committed allowlist of
 * retired checks to edit - `scripts/check-healthchecks-down.mjs` says so in its own header, and its
 * rule is `paused is a deliberate human act, only down files a signal`. So PAUSING IS THE RETIREMENT
 * MECHANISM, and the only thing that can undo it is somebody re-arming the check by hand months
 * later, long after the reason is forgotten.
 *
 * THE SECOND DEFECT, found 2026-09-02 when this suite had been red in CI for three runs. It caught
 * `knowledge-apply-loop` — paused at 18:36 that afternoon while its job was still running daily — by
 * asking "is a paused check still being pinged in the last 36h?". Right instinct, wrong subject: it
 * measured the JOB's pulse rather than the ALARM's state, and a paused check can never go `down`, so
 * when a muted job actually stops, its last ping simply ages out of the window and the guard goes
 * GREEN over the exact catastrophe it was written for. Demonstrated: with the job silent 400h, the
 * old predicate returned false. The rule now has no clock in it at all and lives in
 * `scripts/lib/retired-check-rules.mjs`, where it is exercised offline by
 * `test/retired-check-rules.test.mjs` on hosts that have no healthchecks key.
 *
 * IT READS, IT NEVER WRITES. Read-only keys only (`api_key_readonly`), no ping, no pause, no
 * unpause. Nothing here can silence a live alarm, which is the one thing a test near the monitoring
 * must never be able to do — and equally it can never ping a check on a job's behalf, which would
 * report a dead job as healthy.
 *
 * NO CREDENTIAL IS PRINTED, on success or on failure. Keys are loaded from
 * ~/.claude/scripts/hc-config.json into a variable and go straight into a header.
 *
 *   node test/a-retired-job-stays-quiet.test.mjs
 */
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { auditRetirement, keyOf } from '../scripts/lib/retired-check-rules.mjs'

/**
 * THE KEYS, in the same order and from the same two places as
 * scripts/check-healthchecks-down.mjs, so this cannot end up asking a different account than the
 * producer it guards: HEALTHCHECKS_API_KEYS (comma-separated read-only keys, how CI has them),
 * falling back to every account in ~/.claude/scripts/hc-config.json when run on a fleet machine.
 *
 * IF NEITHER EXISTS THIS SUITE SKIPS, AND SAYS SO IN CAPITALS. It is a live read of an external
 * account, so a host with no credentials genuinely cannot make the check - but a suite that
 * reports success for doing nothing is worse than one that fails, so the skip is loud, names the
 * host, and states plainly that ZERO checks were made. The RULE itself is not skipped anywhere:
 * test/retired-check-rules.test.mjs runs it offline on every host.
 */
function readKeys() {
  const fromEnv = String(process.env.HEALTHCHECKS_API_KEYS || '').split(',').map((s) => s.trim()).filter(Boolean)
  if (fromEnv.length) return fromEnv.map((key, i) => [`env#${i + 1}`, key])
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), '.claude', 'scripts', 'hc-config.json'), 'utf8'))
    return Object.entries(cfg.accounts || {})
      .map(([name, a]) => [name, a.api_key_readonly || a.api_key])
      .filter(([, k]) => k)
  } catch { return [] }
}

// The jobs this fleet has deliberately switched off, and the record that says so. Adding a row here
// is a decision; it belongs next to the assertion that enforces it, not in a comment somewhere else.
// A paused check that is NOT in this list fails the suite until somebody either arms it again or
// writes the reason here.
const RETIRED = [
  {
    check: 'kb-learning-phase0',
    job: 'KB Phase0 Daily',
    why: 'Phase 0 completed and documented 2026-08-27; the scheduled task was disabled on purpose.',
  },
]

let n = 0
const ok = (m) => { console.log('  ok -', m); n++ }

const accounts = readKeys()
if (accounts.length === 0) {
  console.log('SKIPPED — no healthchecks credentials on this host, so ZERO checks were made.')
  console.log('  This suite reads healthchecks.io live. Set HEALTHCHECKS_API_KEYS (comma-separated')
  console.log('  read-only keys) on the runner, or run it on a machine that has')
  console.log('  ~/.claude/scripts/hc-config.json, and it will check for real.')
  console.log('  The rule itself is still covered offline by test/retired-check-rules.test.mjs.')
  process.exit(0)
}
ok(`${accounts.length} healthchecks account(s) configured`)

/** Every check across every account, by slug. Read-only keys only. */
const all = new Map()
for (const [name, key] of accounts) {
  const res = await fetch('https://healthchecks.io/api/v3/checks/', { headers: { 'X-Api-Key': key } })
  assert.equal(res.status, 200, `healthchecks account "${name}" answered HTTP ${res.status}`)
  const body = await res.json()
  for (const c of body.checks || []) all.set(keyOf(c), { ...c, account: name })
}
assert.ok(all.size > 0, 'no checks were readable under any account')
ok(`${all.size} checks readable across those accounts`)

const checks = [...all.values()]
const findings = auditRetirement(checks, RETIRED)

// Every offender is printed before the throw, so one run tells you the whole story rather than
// making you fix them one CI failure at a time.
if (findings.length) {
  for (const f of findings) console.error(`  FAIL - [${f.kind}] ${f.message}`)
}
assert.equal(findings.length, 0,
  `${findings.length} alarm(s) switched off without a recorded reason: ${findings.map((f) => f.check).join(', ')}`)

for (const r of RETIRED) ok(`"${r.check}" is present and paused, so a retired job cannot page and the reason is on record`)

const paused = checks.filter((c) => c.status === 'paused').map(keyOf)
ok(`every paused check is a declared retirement (${paused.length} paused of ${checks.length}: ${paused.join(', ') || 'none'})`)

console.log(`\n${n} checks passed`)
