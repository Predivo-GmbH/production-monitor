/**
 * PROOF that the fleet-wide gitleaks secret-scan gate is fixed — LIVE, on every repo's default
 * branch, checked here the way the condition itself is defined rather than against a local copy.
 *
 * THE CONDITION THIS RETIRES (fleet signal `fleet-gitleaks-pr-gate-403-and-missing-worktree-scan`,
 * first seen 2026-08-25, work-board item `monitor-fleet-gitleaks-pr-gate-403-and-missing-648b0cf3`):
 * across the fleet the gitleaks gate scanned only the COMMIT RANGE of the triggering event — which
 * misses a secret introduced by a merge commit (proven on ReplyFlow 2026-08-20, run 32339544931) —
 * and on pull requests it died with a 403 ("Resource not accessible by integration") before scanning
 * anything, because the workflow lacked `pull-requests: read`. Some repos were also missing the gate.
 *
 * WHY THIS IS A TEST AND NOT PROSE. A gitleaks run has no production deploy job and no customer URL,
 * so the work-board's two other auto-close proofs cannot apply to it (mcp/lib/prodref.mjs). The proof
 * a machine CAN re-run is this file: it asks GitHub, for each repo, on its real default branch,
 * whether the gate now (1) grants `pull-requests: read` and (2) runs a working-tree scan
 * (`gitleaks dir .`) that sees files as they stand regardless of how they arrived. Both present on
 * all ten => the condition is gone. Pass this file's absolute path as work_close's production_ref and
 * the row closes itself; if a repo ever regresses, this suite goes red and the row cannot close on it.
 *
 * It reads the LIVE default branch via the `gh` CLI (keyring-authenticated on both machines, the same
 * credential prodref.mjs uses for its own GitHub checks). "Could not read" fails the test on purpose:
 * not-confirmed is never the same as green.
 *
 * Run: node --test test/fleet-gitleaks-gate-live.test.mjs   (exit 0 = the whole fleet is fixed)
 */
import { test } from 'node:test'
import assert from 'node:assert'
import { execFileSync } from 'node:child_process'

// Every repo the fleet signal covered. Default branch is DISCOVERED from GitHub, not hardcoded, so a
// branch rename cannot make this pass by looking at the wrong ref.
const REPOS = [
  'Predivo-GmbH/backoffice',
  'Predivo-GmbH/ChannelMover',
  'Predivo-GmbH/cockpit',
  'Predivo-GmbH/distribution-os',
  'Predivo-GmbH/ReplyFlow',
  'Predivo-GmbH/ScoutCopilot',
  'Predivo-GmbH/signalscore',
  'Predivo-GmbH/Valrano',
  'Predivo-GmbH/production-monitor',
  'Predivo-GmbH/BoatBuddy',
]

const GH = process.platform === 'win32' ? 'gh.exe' : 'gh'

function gh(apiPath) {
  // execFile, not a shell: apiPath is a fixed string, no interpolation of anything external.
  return execFileSync(GH, ['api', apiPath], {
    encoding: 'utf8', timeout: 20000, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
  })
}

function defaultBranch(repo) {
  return JSON.parse(gh(`repos/${repo}`)).default_branch
}

function gitleaksYaml(repo, ref) {
  const body = JSON.parse(gh(`repos/${repo}/contents/.github/workflows/gitleaks.yml?ref=${encodeURIComponent(ref)}`))
  return Buffer.from(body.content, body.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8')
}

for (const repo of REPOS) {
  test(`${repo}: gitleaks gate has pull-requests:read and a working-tree scan on its default branch`, () => {
    const branch = defaultBranch(repo)
    const yaml = gitleaksYaml(repo, branch)

    // 1. THE 403 FIX. Without `pull-requests: read` every pull_request run dies before scanning.
    assert.match(
      yaml,
      /pull-requests:\s*read/,
      `${repo}@${branch}: gitleaks.yml is missing "pull-requests: read" — pull_request runs will 403 before scanning a single file`,
    )

    // 2. THE MERGE-COMMIT FIX. The action scans only the event's commit range; a working-tree scan
    //    (`gitleaks dir .`) sees the files as they now stand however they arrived.
    assert.match(
      yaml,
      /gitleaks\s+dir\s+\./,
      `${repo}@${branch}: gitleaks.yml has no working-tree scan ("gitleaks dir .") — a secret merged in is still invisible`,
    )
  })
}
