#!/usr/bin/env node
/**
 * The invariant: every workflow file in this repo must be one GitHub will ACCEPT.
 *
 * A workflow GitHub refuses is not an ordinary red. It starts no jobs, so it has no
 * `Send alert on failure` step, so the failure cannot be reported by the thing that
 * reports failures. On 2026-09-04 b6336e1 wrote `RUN_WAS_CANCELLED: ${{ cancelled() &&
 * !failure() }}` into the alert step's `env:`. Status check functions are legal in an
 * `if:` and nowhere else, so run 33872552961 concluded `failure` with 0 jobs, no log,
 * and no mail - the monitor died and could not say so. The dispatch API named it exactly:
 * HTTP 422 (Line: 837, Col: 30): Unrecognized function: 'cancelled'.
 *
 * Both checks on that commit were green. The unit tests tested the new alerter logic and
 * passed; gitleaks passed. Nothing read the workflow the way GitHub reads it. That gap is
 * what the ratchet below closes, over every workflow here including ones not written yet.
 *
 * Run: node test/a-refused-workflow-file-has-no-alarm.test.mjs   (exit 0 = all pass)
 */
import assert from 'node:assert'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  illegalStatusFunctions,
  stripComment,
  expressionSpans,
  isIfLine,
} from '../scripts/lib/workflow-expressions.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WORKFLOWS = join(ROOT, '.github', 'workflows')

let passed = 0
let failed = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok   - ${name}`); passed++ }
  catch (e) { console.log(`  FAIL - ${name}: ${e.message}`); failed++ }
}

// The exact shape that shipped and killed the monitor.
const BROKEN = [
  'name: x',
  'jobs:',
  '  monitor:',
  '    steps:',
  '      - name: Send alert on failure',
  '        if: ${{ failure() || cancelled() }}',
  '        run: node scripts/send-alert.mjs',
  '        env:',
  '          RUN_WAS_CANCELLED: ${{ cancelled() && !failure() }}',
  '',
].join('\n')

// The repair: the status functions move into an `if:`, the alerter reads the steps context.
const FIXED = [
  'name: x',
  'jobs:',
  '  monitor:',
  '    steps:',
  '      - name: Record a clean cancellation for the alerter',
  '        id: clean_cancel',
  '        if: ${{ cancelled() && !failure() }}',
  '        run: echo "value=true" >> "$GITHUB_OUTPUT"',
  '',
  '      - name: Send alert on failure',
  '        if: ${{ failure() || cancelled() }}',
  '        run: node scripts/send-alert.mjs',
  '        env:',
  "          RUN_WAS_CANCELLED: ${{ steps.clean_cancel.outputs.value == 'true' }}",
  '',
].join('\n')

check('the env spelling that GitHub refused is flagged, with its line and function named', () => {
  const hits = illegalStatusFunctions(BROKEN)
  assert.strictEqual(hits.length, 1, `expected 1 violation, got ${hits.length}`)
  assert.strictEqual(hits[0].fn, 'cancelled')
  assert.strictEqual(hits[0].line, 9)
  assert.match(hits[0].text, /RUN_WAS_CANCELLED/)
})

check('the repaired spelling is clean', () => {
  assert.deepStrictEqual(illegalStatusFunctions(FIXED), [])
})

check('a status function in an if: is legal in every form GitHub allows', () => {
  const legal = [
    'jobs:',
    '  a:',
    "    if: ${{ github.event_name == 'schedule' }}",
    '    steps:',
    '      - if: ${{ failure() || cancelled() }}',
    '        run: x',
    '      - name: y',
    '        if: always()',
    '        run: x',
    '      - name: z',
    "        if: always() && steps.collect.outcome == 'success'",
    '        run: x',
    '',
  ].join('\n')
  assert.deepStrictEqual(illegalStatusFunctions(legal), [])
})

// The trap this repo has already fallen into once: on 2026-09-04 cancelsInProgress() scanned raw
// text, and the COMMENT explaining an exemption made the gate exempt the very file it was written
// for - the gate shipped disabled and still passed green. Prose is not configuration, and the fix
// for THIS bug describes the broken spelling in a comment, so a scanner that cannot tell the two
// apart would fail the file it had just repaired.
check('a comment that quotes the broken spelling is prose, not a violation', () => {
  const commented = [
    'jobs:',
    '  a:',
    '    steps:',
    '      # NOT written here as `cancelled() && !failure()` - GitHub refuses the whole file.',
    '      - name: y',
    '        run: echo ${{ github.run_id }}   # not ${{ cancelled() }} either',
    '',
  ].join('\n')
  assert.deepStrictEqual(illegalStatusFunctions(commented), [])
})

check('a status function outside any ${{ }} is not an expression and is not flagged', () => {
  assert.deepStrictEqual(illegalStatusFunctions('      - run: echo "always() is fine in a shell"\n'), [])
})

check('a violation is still caught when it shares a block with a legal expression', () => {
  const mixed = [
    '        env:',
    '          A: ${{ github.run_id }}',
    '          B: ${{ success() }}',
    '',
  ].join('\n')
  const hits = illegalStatusFunctions(mixed)
  assert.strictEqual(hits.length, 1)
  assert.strictEqual(hits[0].fn, 'success')
})

check('stripComment drops a comment without eating a # that opens nothing', () => {
  assert.strictEqual(stripComment('  a: b # tail').trim(), 'a: b')
  assert.strictEqual(stripComment('# whole line').trim(), '')
  assert.strictEqual(stripComment('  a: x#y').trim(), 'a: x#y')
})

check('expressionSpans keeps an unterminated ${{ instead of dropping it silently', () => {
  assert.deepStrictEqual(expressionSpans('a: ${{ cancelled() '), [' cancelled() '])
  assert.deepStrictEqual(expressionSpans('a: ${{ x }} and ${{ y }}'), [' x ', ' y '])
})

check('isIfLine recognises the job, step and list forms and nothing else', () => {
  assert.ok(isIfLine('    if: always()'))
  assert.ok(isIfLine('      - if: always()'))
  assert.ok(!isIfLine('          NOTIFY_IF: always()'))
  assert.ok(!isIfLine('        run: echo if: always()'))
})

// --- the ratchet: every workflow here, including ones not written yet ---

const files = readdirSync(WORKFLOWS).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'))

check('the ratchet is actually reading workflows (a gate that matches nothing is not a gate)', () => {
  assert.ok(files.length >= 5, `expected the workflow dir to hold files, found ${files.length}`)
  assert.ok(files.includes('monitor.yml'), 'monitor.yml must be among the scanned files')
})

check(`no workflow calls a status function outside an if: (${files.length} files)`, () => {
  const offenders = []
  for (const f of files) {
    for (const hit of illegalStatusFunctions(readFileSync(join(WORKFLOWS, f), 'utf8'))) {
      offenders.push(`${f}:${hit.line} ${hit.fn}() in ${hit.text}`)
    }
  }
  assert.deepStrictEqual(offenders, [],
    'GitHub will REFUSE these files, and a refused workflow runs no jobs and sends no alert:\n  ' +
    offenders.join('\n  '))
})

// --- the specific repair, pinned so it cannot drift back ---

check('monitor.yml records the clean cancellation immediately before the alerter', () => {
  const src = readFileSync(join(WORKFLOWS, 'monitor.yml'), 'utf8')
  assert.match(src, /id: clean_cancel/, 'the recorder step is gone')
  assert.match(src, /RUN_WAS_CANCELLED: \$\{\{ steps\.clean_cancel\.outputs\.value == 'true' \}\}/,
    'the alerter no longer reads the recorder')
  const from = src.indexOf('id: clean_cancel')
  const to = src.indexOf('- name: Send alert on failure')
  assert.ok(from > 0 && to > from, 'the recorder must come before the alerter')
  const between = src.slice(from, to).match(/^ {6}- name:/gm) || []
  assert.strictEqual(between.length, 0,
    `failure() flips mid-job, so the two must read the same moment; ${between.length} step(s) sit between them`)
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
