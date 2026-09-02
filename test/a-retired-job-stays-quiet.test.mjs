#!/usr/bin/env node
/**
 * A JOB THAT WAS DELIBERATELY SWITCHED OFF MUST NOT KEEP RINGING.
 *
 * THE DEFECT, reported 2026-08-13 and still open on 2026-09-02: `KB Phase0 Daily` finished its
 * backlog and was disabled on purpose on 2026-08-27, but its healthchecks watch stayed armed with a
 * one-day period, so it expired and paged EVERY NIGHT for a job nobody wanted running. There is no
 * committed allowlist of retired checks to edit - `scripts/check-healthchecks-down.mjs` says so in
 * its own header, and its rule is `paused is a deliberate human act, only down files a signal`. So
 * PAUSING IS THE RETIREMENT MECHANISM, and the only thing that can undo it is somebody re-arming the
 * check by hand months later, long after the reason is forgotten.
 *
 * That is exactly the shape of failure this fleet keeps paying for: a state nobody re-checks. This
 * file re-checks it, against healthchecks.io itself rather than against a note about it.
 *
 * IT READS, IT NEVER WRITES. Read-only keys only (`api_key_readonly`), no ping, no pause, no
 * unpause. Nothing here can silence a live alarm, which is the one thing a test near the monitoring
 * must never be able to do.
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

/**
 * THE KEYS, in the same order and from the same two places as
 * scripts/check-healthchecks-down.mjs, so this cannot end up asking a different account than the
 * producer it guards: HEALTHCHECKS_API_KEYS (comma-separated read-only keys, how CI has them),
 * falling back to every account in ~/.claude/scripts/hc-config.json when run on a fleet machine.
 *
 * IF NEITHER EXISTS THIS SUITE SKIPS, AND SAYS SO IN CAPITALS. It is a live read of an external
 * account, so a host with no credentials genuinely cannot make the check - but a suite that
 * reports success for doing nothing is worse than one that fails, so the skip is loud, names the
 * host, and states plainly that ZERO checks were made. Wire HEALTHCHECKS_API_KEYS into the gate
 * and it stops skipping.
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
  process.exit(0)
}
ok(`${accounts.length} healthchecks account(s) configured`)

/** Every check across every account, by slug. Read-only keys only. */
const all = new Map()
for (const [name, key] of accounts) {
  const res = await fetch('https://healthchecks.io/api/v3/checks/', { headers: { 'X-Api-Key': key } })
  assert.equal(res.status, 200, `healthchecks account "${name}" answered HTTP ${res.status}`)
  const body = await res.json()
  for (const c of body.checks || []) all.set(c.slug || c.name, { ...c, account: name })
}
assert.ok(all.size > 0, 'no checks were readable under any account')
ok(`${all.size} checks readable across those accounts`)

for (const r of RETIRED) {
  const c = all.get(r.check)
  assert.ok(c, `"${r.check}" is not present in any account — it was retired by PAUSING, not by deleting, so it must still exist`)
  ok(`"${r.check}" still exists, so the record of why it was retired has not been thrown away`)

  assert.equal(c.status, 'paused',
    `"${r.check}" is "${c.status}", not paused. ${r.why} An armed watch over a switched-off job pages every night for nothing, which is how a real alarm gets muted.`)
  ok(`"${r.check}" is paused, so it cannot page for a job that is meant to be off`)
}

// The other half of the same rule, fleet-wide: a paused check must not be one somebody is still
// pinging. That would mean the job is alive and its alarm is off — the dangerous direction, and the
// one a nightly false-red trains people into.
const GRACE_MS = 36 * 3600 * 1000
const alive = [...all.values()].filter((c) =>
  c.status === 'paused' && c.last_ping && (Date.now() - new Date(c.last_ping).getTime()) < GRACE_MS)
assert.equal(alive.length, 0,
  `paused but still being pinged in the last 36h: ${alive.map((c) => c.slug || c.name).join(', ')} — a running job with its alarm switched off`)
ok('no paused check is still being pinged, so nothing is running with its alarm off')

console.log(`\n${n} checks passed`)
