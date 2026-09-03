#!/usr/bin/env node
/**
 * Deploy-PIPELINE drift detection for the Supabase-staged fleet.
 *
 * Complements check-drift.mjs (which checks DB schema/cron drift). This checks that
 * every product's .github/workflows/deploy.yml still conforms to the hardened
 * cross-project deploy standard (standards/deploy-standard.md), so a future edit
 * cannot silently regress the pipeline back to the fragile shape that caused the
 * recurring prod-promotion failures (2026-07-15):
 *
 *   §4a  prod promotion must NOT re-run the staging pipeline — it gates on the
 *        recorded staging result instead (no `needs: e2e-staging`; a "Verify
 *        staging gate" step present; staging chain gated `if: github.event_name == 'push'`).
 *   §3e  every `supabase functions deploy` wrapped in retry-with-backoff (no bare one-liner).
 *   §3c  Supabase CLI pinned, never `version: latest`.
 *
 * Read-only. Exits 1 on any drift — the workflow failure IS the alert.
 *
 * Source of each deploy.yml:
 *   - CI mode: fetches via `gh api repos/<owner/repo>/contents/...` (needs GH_TOKEN
 *     with read access to the fleet repos — secret FLEET_READ_TOKEN).
 *   - Local mode (LOCAL_FLEET_ROOT set, e.g. "C:\\Business\\Internal Projects"):
 *     reads each repo's working copy directly, zero auth.
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { getFleet } from '../lib/fleet.mjs'
import { sayVerdict, PASS, FAIL, UNKNOWN } from './lib/check-verdict.mjs'

// Fleet from the DB-backed registry (fleet_products) via getFleet(); each product carries `staged`
// (=staging-gated → §4a applies). Falls back to the identical hardcoded superset on any DB failure, so
// this drift check can never lose a product. A launched product auto-appears once its row exists.
// Static/push-to-prod repos (staged:false): §4a N/A, but §1/§3 FTP resilience + cancel-in-progress still apply.
const { fleet: FLEET, source: FLEET_SOURCE } = await getFleet()
console.log(`pipeline-drift: fleet source = ${FLEET_SOURCE} (${FLEET.length} products, ${FLEET.filter((p) => p.staged).length} staged)`)

const LOCAL_ROOT = process.env.LOCAL_FLEET_ROOT

// CI mode needs a token with read access to the fleet repos (secret FLEET_READ_TOKEN,
// a classic PAT with `repo` read scope, exposed to the script as GH_TOKEN).
//
// A CHECK THAT CANNOT LOOK MUST NOT EXIT 0 (2026-09-03, found by fault injection).
//
// This block used to print "pipeline-drift check skipped: set the FLEET_READ_TOKEN secret ..."
// and exit 0, leaving drift-check.yml GREEN. Run it with no token — which is exactly what a
// revoked or expired PAT looks like from in here — and the guard that exists to stop a deploy
// pipeline silently regressing to the shape that caused the 2026-07-15 prod-promotion failures
// simply stops existing: no red run, no email, no trace anywhere a person looks.
//
// drift-check.yml records that this already happened once, for a different reason: "FLEET_READ_
// TOKEN was never created, so this check skipped silently in CI (dormant safety net)". It was
// dormant, that was known, and the only thing that ever said so was a human reading a log. The
// rationalisation in the old comment — "skip cleanly rather than fail the nightly" — optimises
// for the day the guard is being wired up and pays for it every day after, when the identical
// silence means the opposite thing.
//
// drift-check.yml already runs send-drift-alert.mjs on `if: failure()`, so a non-zero exit is
// wired to a person. The fix is simply to stop lying to the wire that already exists.
if (!LOCAL_ROOT && !process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
  const reason = 'the deploy-pipeline drift guard could not read a single deploy.yml: no FLEET_READ_TOKEN / '
    + 'DASHBOARD_PAT in the environment and no LOCAL_FLEET_ROOT. Nothing was compared against the deploy '
    + 'standard, so nothing is known — this is a dormant guard, not a conformant fleet.'
  sayVerdict(UNKNOWN, reason)
  console.error(`::error::${reason}`)
  process.exit(1)
}

const failures = []
const fail = (m) => { failures.push(m); console.error(`  DRIFT ${m}`) }
const ok = (m) => console.log(`  OK  ${m}`)

function loadYaml({ repo, dir }) {
  if (LOCAL_ROOT) {
    const p = join(LOCAL_ROOT, dir, '.github', 'workflows', 'deploy.yml')
    if (!existsSync(p)) throw new Error(`local deploy.yml not found at ${p}`)
    return readFileSync(p, 'utf8')
  }
  // CI: fetch via gh api (base64 contents)
  const raw = execSync(
    `gh api repos/${repo}/contents/.github/workflows/deploy.yml --jq .content`,
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
  return Buffer.from(raw.replace(/\s/g, ''), 'base64').toString('utf8')
}

for (const p of FLEET) {
  console.log(`\n== ${p.name}`)
  let yml
  try { yml = loadYaml(p) } catch (e) { fail(`${p.name}: cannot load deploy.yml — ${String(e).slice(0, 160)}`); continue }

  // ── §4a — only staging-gated repos (static push-to-prod repos have no separate prod dispatch) ──
  if (p.staged) {
    // §4a-1 — the prod deploy job must not re-run staging via a needs on the E2E gate.
    // Match only a real YAML `needs:` KEY (line-anchored) — not the string inside an
    // explanatory comment like "does NOT `needs: e2e-staging`" (comment lines start with #).
    if (/^\s*needs:\s*(\[[^\]]*e2e-staging|e2e-staging)\b/m.test(yml)) {
      fail(`${p.name}: a job still has "needs: ...e2e-staging" — prod must gate on the recorded staging run, not re-run it (§4a)`)
    } else ok(`${p.name}: no job re-runs the staging E2E chain via needs (§4a)`)

    // §4a-2 — the staging-gate step must be present (proves the recorded-result gate exists).
    if (yml.includes('Verify staging gate')) ok(`${p.name}: "Verify staging gate" step present (§4a)`)
    else fail(`${p.name}: missing the "Verify staging gate" step — prod deploy has no recorded-staging-result gate (§4a)`)

    // §4a-3 — the staging chain root must be push-only.
    if (yml.includes("if: github.event_name == 'push'")) ok(`${p.name}: staging chain gated push-only (§4a)`)
    else fail(`${p.name}: no "if: github.event_name == 'push'" gate — staging chain may re-run on prod dispatch (§4a)`)
  }

  // ── Universal checks (apply to EVERY pipeline, staged or static) ──

  // Concurrency — never cancel a mid-flight FTP mirror (leaves prod half-applied; breakage §6).
  if (/cancel-in-progress:\s*true/.test(yml)) fail(`${p.name}: concurrency has "cancel-in-progress: true" — set false so a mid-flight FTP mirror is never cancelled (breakage §6)`)
  else ok(`${p.name}: cancel-in-progress not true`)

  // §3 — any FTP `mirror --reverse` deploy must be wrapped in a retry loop (marker: `until [ $n`).
  if (/mirror\s+--reverse/.test(yml) && !/until \[ \$n/.test(yml)) {
    fail(`${p.name}: FTP "mirror --reverse" present but no retry loop ("until [ $n") — wrap it (§3, intermittent-FTP-hang class)`)
  } else if (/mirror\s+--reverse/.test(yml)) ok(`${p.name}: FTP mirror steps wrapped in a retry loop (§3)`)

  // §3e — no bare `run: supabase functions deploy` one-liner (all wrapped in retry).
  const bare = (yml.match(/run:\s*supabase functions deploy/g) || []).length
  if (bare > 0) fail(`${p.name}: ${bare} bare "run: supabase functions deploy" one-liner(s) — wrap in retry-with-backoff (§3e)`)
  else if (yml.includes('supabase functions deploy')) ok(`${p.name}: all functions-deploy steps wrapped in retry (§3e)`)
  else ok(`${p.name}: no edge functions to deploy`)

  // §3c — Supabase CLI must be pinned, never `version: latest`.
  if (/version:\s*latest/.test(yml)) fail(`${p.name}: uses "version: latest" for a setup action — pin the Supabase CLI (§3c)`)
  else ok(`${p.name}: no "version: latest" (§3c)`)

  // Lockfile integrity — project deps must install with `npm ci` (enforces the
  // committed lockfile). `npm install` silently tolerates/mutates a drifted
  // package-lock.json — exactly how the arivioo vitest/esbuild drift reached prod
  // undetected. `npm install -g <cli>` (global tooling like the Supabase CLI) is exempt.
  // Strip inline comments so a `# npm ci (not npm install)` note doesn't self-trip.
  const badInstall = yml.split('\n').filter((line) => /npm install(?!\s+-g)/.test(line.split('#')[0])).length
  if (badInstall > 0) fail(`${p.name}: ${badInstall} "npm install" for project deps — use "npm ci" to enforce lockfile integrity (lockfile-drift class)`)
  else ok(`${p.name}: project deps installed with npm ci (lockfile-enforcing)`)

  // §3f — command-substitution FTP steps (VAR=$(lftp …)) MUST carry `set +e`.
  // GitHub runs steps with `bash -eo pipefail`; a failing `OUT=$(lftp …)` assignment
  // aborts the step on the FIRST attempt, BEFORE the retry loop can iterate — so the
  // retry loop is dead code (the class fixed fleet-wide 2026-07-16; a transient FTP
  // flake on attempt 1 otherwise fails the deploy with no retry). The `if lftp …; then`
  // form puts the failing command in an `if` condition and is already -e-safe. Rule:
  // if the file has ANY unguarded `VAR=$(lftp` command substitution, it must also
  // contain a `set +e`. Prevents a future edit from silently regressing the fix.
  const cmdSubLftp = yml
    .split('\n')
    .filter((l) => /^\s*[A-Za-z_][A-Za-z0-9_]*=\$\(lftp\b/.test(l) && !/\|\|/.test(l)).length
  if (cmdSubLftp > 0 && !/^\s*set \+e\s*$/m.test(yml)) {
    fail(`${p.name}: uses VAR=$(lftp…) command substitution but has no "set +e" — under bash -e the assignment aborts before the retry loop runs, so every FTP retry is dead code (§3f)`)
  } else if (cmdSubLftp > 0) {
    ok(`${p.name}: command-substitution FTP steps protected by set +e (§3f)`)
  } else {
    ok(`${p.name}: no unguarded VAR=$(lftp command substitution — §3f n/a (if-lftp form)`)
  }
}

console.log('')
if (failures.length) {
  // Machine-readable payload so send-drift-alert.mjs renders the real findings,
  // not the Playwright-shaped "no report produced" fallback of send-alert.mjs.
  writeFileSync('pipeline-drift-results.json', JSON.stringify(failures, null, 2))
  sayVerdict(FAIL, `${failures.length} deploy.yml finding(s) against the hardened standard.`)
  console.error(`PIPELINE DRIFT DETECTED (${failures.length} finding(s)) — a deploy.yml has regressed from the hardened standard (standards/deploy-standard.md).`)
  process.exitCode = 1
} else {
  sayVerdict(PASS, `${FLEET.length} fleet deploy.yml read and conformant.`)
  console.log('No pipeline drift — all fleet deploy.yml conform to the hardened standard.')
}
