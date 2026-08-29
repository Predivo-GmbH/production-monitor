/**
 * Unit test for metricValue (scripts/check-supabase-machine-health.mjs).
 *
 * THE 2026-08-29 BUG (commit ce41799): the metric regex was built from a single-quoted JS
 * string, `'^' + name + '\{[^}]*\}\s+([0-9.e+-]+)'`. In a JS literal `\{`→`{`, `\}`→`}`,
 * `\s`→bare `s`, so the compiled pattern demanded a literal letter `s` after the closing
 * brace and matched NOTHING. Every metric read as null → every machine reported 'unreadable'
 * → the CLI exited 0 → the new disk-IO watchdog went green forever, exactly failing to catch
 * the 7.74 MB/s machine it was written for. These cases pin the escaping and the fact that
 * the label block is OPTIONAL (disk metrics carry {device=...}; vmstat/memory do not), so the
 * check can never again silently match nothing. No network, no secrets, no services.
 *
 * Run: node test/check-supabase-machine-health.test.mjs   (exit 0 = all pass)
 */
import assert from 'node:assert'
import { metricValue } from '../scripts/check-supabase-machine-health.mjs'

let passed = 0
let failed = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok   - ${name}`); passed++ }
  catch (e) { console.log(`  FAIL - ${name}: ${e.message}`); failed++ }
}

// A fixed Prometheus-format sample as the Supabase metrics endpoint exposes it: disk metrics
// carry a {device=...} label block, vmstat/memory are bare. Comment/HELP lines are present too.
const SAMPLE = [
  '# HELP node_disk_read_bytes_total Total bytes read',
  '# TYPE node_disk_read_bytes_total counter',
  'node_disk_read_bytes_total{device="nvme0n1"} 1234000000',
  'node_disk_written_bytes_total{device="nvme0n1"} 555000000',
  '# HELP node_vmstat_pgmajfault Major page faults',
  'node_vmstat_pgmajfault 42',
  'node_memory_MemTotal_bytes 4140000000',
  '',
].join('\n')

check('reads a LABELLED metric (disk read, with {device=...})', () => {
  assert.equal(metricValue(SAMPLE, 'node_disk_read_bytes_total'), 1234000000)
})

check('reads a LABELLED metric (disk written)', () => {
  assert.equal(metricValue(SAMPLE, 'node_disk_written_bytes_total'), 555000000)
})

check('reads an UNLABELLED metric (vmstat pgmajfault) — the label block is optional', () => {
  assert.equal(metricValue(SAMPLE, 'node_vmstat_pgmajfault'), 42)
})

check('reads an UNLABELLED metric (memory total)', () => {
  assert.equal(metricValue(SAMPLE, 'node_memory_MemTotal_bytes'), 4140000000)
})

check('the ce41799 bug is dead: none of the four metrics returns null', () => {
  for (const n of ['node_disk_read_bytes_total', 'node_disk_written_bytes_total', 'node_vmstat_pgmajfault', 'node_memory_MemTotal_bytes']) {
    assert.notEqual(metricValue(SAMPLE, n), null, `${n} must be readable — a null here is the blind-green regression`)
  }
})

check('a genuinely absent metric still returns null', () => {
  assert.equal(metricValue(SAMPLE, 'node_no_such_metric'), null)
})

check('anchors to line start: a prefix collision does not mis-read', () => {
  const s = 'x_node_vmstat_pgmajfault 999\nnode_vmstat_pgmajfault 7\n'
  assert.equal(metricValue(s, 'node_vmstat_pgmajfault'), 7)
})

check('reads scientific-notation values (Prometheus emits 4.14e+09 too)', () => {
  assert.equal(metricValue('node_memory_MemTotal_bytes 4.14e+09\n', 'node_memory_MemTotal_bytes'), 4.14e+09)
})

console.log(`\n${passed} passed, ${failed} failed.`)
process.exitCode = failed ? 1 : 0
