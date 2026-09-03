#!/usr/bin/env node
// A CHECK THAT NEVER RUNS LOOKS EXACTLY LIKE A CHECK THAT FINDS NOTHING - and on 2026-09-03 I told
// Roger a watcher had never run, then found it had; the measurement was what was broken. This
// suite asks the boring question about the promoter instead of assuming: is it actually CALLED,
// from the workflow, on the branch that runs?
//
// It matters more here than anywhere else in this repo, because this is the one step that changes
// production by itself. Both failure directions are guarded: wired-but-broken, and quietly
// unwired.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { AUTO_PROMOTABLE } from '../scripts/lib/auto-promote.mjs'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const yml = readFileSync(join(repo, '.github', 'workflows', 'monitor.yml'), 'utf8')

test('the promoter is actually CALLED by the monitor - not just present on disk', () => {
  assert.match(yml, /node scripts\/promote-internal\.mjs/,
    'monitor.yml never runs promote-internal.mjs, so "auto-promote internal" would be a file nobody executes')
})

test('it runs only when the monitor got that far - if: success(), never always()', () => {
  // The sensors around it use always() because they are independent observers. This one CHANGES
  // production, so it must not fire on the back of a run whose earlier checks were red.
  const step = yml.slice(yml.indexOf('Ship the internal tools'), yml.indexOf('node scripts/promote-internal.mjs'))
  assert.match(step, /if:\s*success\(\)/, 'the promoting step must be if: success()')
  assert.doesNotMatch(step, /if:\s*always\(\)/)
})

test('it has a kill switch that does not require editing the workflow', () => {
  assert.match(yml, /PROMOTE_INTERNAL_OFF/,
    'there must be a way to stop automatic production deploys without a commit')
})

test('it is given a token, or it would fail every hour', () => {
  const step = yml.slice(yml.indexOf('Ship the internal tools'))
  assert.match(step.slice(0, 800), /GH_TOKEN:/)
})

test('THE ALLOWLIST IS THE SAFETY, and it holds only the three Roger named', () => {
  assert.deepEqual([...AUTO_PROMOTABLE].sort(), ['backoffice', 'cockpit', 'distribution-os'],
    'adding a name here ships that product to production with nobody present - it needs Roger, ' +
    'and a customer-facing product needs him every single time, not once')
})

test('the workflow still runs the two sensors this sits between', () => {
  // If the promoter ever replaced the watchers rather than joining them, a product could be
  // shipped automatically while nothing was still asking whether products can ship at all.
  assert.match(yml, /node scripts\/check-promotion-backlog\.mjs/)
  assert.match(yml, /node scripts\/check-deploy-failures\.mjs/)
})
