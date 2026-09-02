#!/usr/bin/env node
/**
 * "Build machines leave programs running, and the next job trips over them."
 *
 * Our self-hosted build host runs ~24 GitHub runners for 14 repositories inside ONE Linux
 * network namespace. A test server bound to a fixed port is therefore a fleet-wide claim, and
 * three separate products have already been bitten by it (see lib/devServerPorts.mjs for the
 * incidents). This is the regression test that would have caught all three BEFORE they merged.
 *
 * IT RUNS IN TWO HALVES, AND SAYS WHICH ONE IT DID.
 *   A. FIXTURES - the historical bugs, replayed verbatim, plus the corrected shape. These assert
 *      the checker itself and run anywhere, including in this repository's own CI where the other
 *      products are not checked out.
 *   B. THE REAL FLEET - every playwright config under the fleet tree, if that tree is present on
 *      this machine. This half is the one that actually protects the build host. When the tree is
 *      there it must find configs and every one of them must be clean; a tree that is present but
 *      yields zero configs FAILS, because a check that passes on absence is not a check.
 *
 * Run: node test/dev-server-port-hygiene.test.mjs   (exit 0 = all pass)
 * Point it elsewhere with FLEET_ROOT=/some/path.
 */
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { inspectPlaywrightConfig, extractWebServerBlocks, stripComments } from '../lib/devServerPorts.mjs'

let pass = 0
const t = (name, fn) => { fn(); pass++; console.log(`  ok - ${name}`) }
const rules = (src) => inspectPlaywrightConfig(src).map((f) => f.rule).sort()

// ── A. THE FIXTURES: the three real incidents, and the shape that fixed them ──────────────────

// Valrano before b405ada. Both halves of the bug in one block: a fixed port, and a reuse flag
// that was true even under CI - which is what let the suite adopt Factory Cockpit's server.
const VALRANO_BEFORE = `
export default defineConfig({
  use: { baseURL: 'http://localhost:5173' },
  webServer: {
    command: 'npx vite',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 30000,
  },
})`

t('the Valrano bug is caught: a fixed port AND a server it will adopt under CI', () => {
  const found = rules(VALRANO_BEFORE)
  assert.ok(found.includes('fixed-port'), 'the hardcoded 5173 must be reported')
  assert.ok(found.includes('reuse-not-gated-on-ci'), 'reuseExistingServer: true must be reported')
  const detail = inspectPlaywrightConfig(VALRANO_BEFORE).find((f) => f.rule === 'fixed-port').detail
  assert.match(detail, /5173/, 'the message must name the port, or nobody can act on it')
})

// ChannelMover before the fix: the port on the command line rather than in the url.
t('the ChannelMover bug is caught: --port 8083 written into the command', () => {
  const src = `webServer: {
    command: 'npx expo start --web --port 8083',
    url: 'http://localhost:8083',
    reuseExistingServer: !process.env.CI,
  },`
  assert.deepEqual(rules(src), ['fixed-port'])
})

// Distribution-OS before the fix: dynamic-looking but the server was free to move.
t('the Distribution-OS bug is caught: vite without --strictPort slides to the next port', () => {
  const src = 'webServer: {\n  command: `npx vite --mode test --port ${PORT}`,\n  url: BASE_URL,\n  reuseExistingServer: !process.env.CI,\n}'
  assert.deepEqual(rules(src), ['no-strict-port'])
})

t('a config that never starts a local server is not judged at all', () => {
  assert.deepEqual(rules(`export default defineConfig({ use: { baseURL: process.env.STAGING_URL } })`), [])
})

t('an omitted reuseExistingServer is a finding, not a pass', () => {
  const src = 'webServer: {\n  command: `npx vite --port ${PORT} --strictPort`,\n  url: BASE_URL,\n}'
  assert.deepEqual(rules(src), ['reuse-not-set'])
})

t('the corrected fleet shape is clean', () => {
  const src = 'webServer: {\n  command: `npx vite --port ${PORT} --strictPort`,\n  url: BASE_URL,\n  reuseExistingServer: !process.env.CI,\n  timeout: 30000,\n}'
  assert.deepEqual(rules(src), [])
})

t('serve is held to its own equivalent flag, --no-port-switching', () => {
  const bad = 'webServer: {\n  command: `npx serve out -l ${PORT}`,\n  url: BASE_URL,\n  reuseExistingServer: !process.env.CI,\n}'
  assert.deepEqual(rules(bad), ['no-strict-port'])
  const good = 'webServer: {\n  command: `npx serve out -l ${PORT} --no-port-switching`,\n  url: BASE_URL,\n  reuseExistingServer: !process.env.CI,\n}'
  assert.deepEqual(rules(good), [])
})

t('a port named in a comment while EXPLAINING the fix is not read back as the fix missing', () => {
  const src = 'webServer: {\n  // was hardcoded to 5173 and reuseExistingServer: true\n  command: `npx vite --port ${PORT} --strictPort`,\n  url: BASE_URL,\n  reuseExistingServer: !process.env.CI,\n}'
  assert.deepEqual(rules(src), [], 'stripping comments is load-bearing: every fixed config names its old port')
  assert.ok(!stripComments('a // b').includes('b'))
})

t('a nested object inside the block does not truncate it', () => {
  const src = 'webServer: {\n  command: `npx vite --port ${PORT} --strictPort`,\n  env: { FOO: "1" },\n  url: BASE_URL,\n  reuseExistingServer: !process.env.CI,\n}'
  assert.equal(extractWebServerBlocks(src).length, 1)
  assert.ok(extractWebServerBlocks(src)[0].includes('reuseExistingServer'))
})

// ── B. THE REAL FLEET, when this machine has it ───────────────────────────────────────────────

const FLEET_ROOT = process.env.FLEET_ROOT || 'C:/Business/Internal Projects'
const SKIP_DIRS = new Set(['node_modules', '.git', '.worktrees', 'dist', 'build', '.next'])

function findConfigs(dir, out = [], depth = 0) {
  if (depth > 4) return out
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) findConfigs(full, out, depth + 1)
    } else if (/^playwright[\w.-]*\.config\.(ts|js|mjs)$/.test(e.name)) {
      out.push(full)
    }
  }
  return out
}

if (!fs.existsSync(FLEET_ROOT)) {
  console.log(`\n  -- the fleet tree is not on this machine (${FLEET_ROOT}), so only the fixtures ran.`)
  console.log('     That is expected in this repository\'s own CI. On the build host both halves run.')
} else {
  const configs = findConfigs(FLEET_ROOT)
  assert.ok(
    configs.length > 0,
    `${FLEET_ROOT} exists but no playwright config was found under it - the scan silently checked nothing`,
  )
  const dirty = []
  for (const file of configs) {
    const findings = inspectPlaywrightConfig(fs.readFileSync(file, 'utf8'))
    if (findings.length) dirty.push(`${file}\n      ${findings.map((f) => `[${f.rule}] ${f.detail}`).join('\n      ')}`)
  }
  if (dirty.length) {
    console.error(`\n  FAIL - ${dirty.length} of ${configs.length} playwright configs can collide on the shared build host:\n`)
    for (const d of dirty) console.error(`    ${d}\n`)
    process.exit(1)
  }
  pass++
  console.log(`  ok - all ${configs.length} playwright configs in the fleet take their port from the OS`)
}

console.log(`\n${pass} checks passed`)
