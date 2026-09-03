/**
 * Integration test for the deploy-PIPELINE drift guard's empty/truncated-file blindness.
 *
 * THE DEFECT (2026-09-03 audit, proven by injection). Every check in check-pipeline-drift.mjs is a
 * NEGATIVE pattern match — it fails only when a BAD pattern is FOUND. So a 0-byte or truncated
 * deploy.yml (a bad checkout, a `gh api` content truncation, an accidental empty commit) matched no
 * bad pattern and passed every universal check as fully conformant. The §4a content-PRESENCE checks
 * that would have caught it run only for `staged` products, so the static/push-to-prod products had
 * no content assertion at all — an empty file read as "conforms to the hardened standard".
 *
 * This drives the REAL script against a temp fleet root: a conforming deploy.yml for every product
 * the fleet registry names, then ONE static product's file truncated to empty. Before the fix that
 * run was green; after it, the empty file is named as drift. Revert the guard and the last two
 * assertions go red.
 *
 * Run: node test/check-pipeline-drift.test.mjs   (exit 0 = all pass)
 */
import assert from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { getFleet } from '../lib/fleet.mjs'

const SCRIPT = fileURLToPath(new URL('../scripts/check-pipeline-drift.mjs', import.meta.url))

// A minimal deploy.yml that passes EVERY check in check-pipeline-drift.mjs (staged and static):
// carries jobs:/runs-on:, the §4a "Verify staging gate" step and the push-only gate, no
// cancel-in-progress:true, no version:latest, no bare functions-deploy, no npm install, no lftp.
const CONFORMING = `name: Deploy
concurrency:
  group: deploy
  cancel-in-progress: false
on:
  push:
    branches: [main]
jobs:
  gate:
    if: github.event_name == 'push'
    runs-on: ubuntu-latest
    steps:
      - name: Verify staging gate
        run: echo ok
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: echo deploy
`

function runAgainst(root) {
  try {
    const out = execFileSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, LOCAL_FLEET_ROOT: root },
    })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` }
  }
}

let n = 0
const t = (name, cond) => { assert.ok(cond, name); n++; console.log(`  ok - ${name}`) }

// Enumerate the fleet the SAME way the script does, so the temp root matches exactly what it reads.
const { fleet } = await getFleet()
assert.ok(fleet.length > 0, 'the fleet registry must name at least one product')
const target = fleet.find((p) => !p.staged) || fleet[0]

const root = mkdtempSync(join(tmpdir(), 'pipeline-drift-'))
try {
  for (const p of fleet) {
    const dir = join(root, p.dir, '.github', 'workflows')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'deploy.yml'), CONFORMING)
  }

  // Baseline: a fleet of conforming files is clean, and the target is NOT falsely flagged empty.
  const clean = runAgainst(root)
  t('a fleet of conforming deploy.yml files has no pipeline drift', clean.code === 0)
  t('the conforming target is not falsely reported empty (the fix does not cry wolf on a real file)',
    !/empty or truncated/.test(clean.out))

  // Inject the failure the check is meant to catch: truncate one STATIC product's file to empty.
  writeFileSync(join(root, target.dir, '.github', 'workflows', 'deploy.yml'), '')
  const injected = runAgainst(root)
  t('an empty deploy.yml now fails the run (it was silently conformant before the fix)',
    injected.code === 1)
  t('the empty file is NAMED as empty/truncated, not passed as conforming',
    /empty or truncated/.test(injected.out) && injected.out.includes(target.name))
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n${n} passed`)
