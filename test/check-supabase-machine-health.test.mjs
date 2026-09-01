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
import fs2 from 'node:fs'
import { spawnSync } from 'node:child_process'
import { metricValue, exitDecision, discover, blindSignal } from '../scripts/check-supabase-machine-health.mjs'

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

// 2026-08-30: node_disk_read/written_bytes_total carry a {device=...} label and appear ONCE
// PER BLOCK DEVICE. A non-global .match() took only the FIRST device, so a machine with two
// NVMe volumes had the whole second device silently dropped — 88% of ReplyFlow's writes lived
// on nvme1n1, so every published MB/s figure (and the spend decision built on it) undercounted.
// metricValue now SUMS every matching series.
const TWO_DEVICE = [
  'node_disk_read_bytes_total{device="nvme0n1"} 1000000000',
  'node_disk_read_bytes_total{device="nvme1n1"} 250000000',
  'node_disk_written_bytes_total{device="nvme0n1"} 30000000',
  'node_disk_written_bytes_total{device="nvme1n1"} 170000000',
  'node_vmstat_pgmajfault 42',
  '',
].join('\n')

check('sums ALL device series for a labelled disk metric (the dropped-second-device bug)', () => {
  assert.equal(metricValue(TWO_DEVICE, 'node_disk_read_bytes_total'), 1250000000)
  assert.equal(metricValue(TWO_DEVICE, 'node_disk_written_bytes_total'), 200000000)
})

check('device order does not change the sum (non-deterministic which device is listed first)', () => {
  const reordered = [
    'node_disk_written_bytes_total{device="nvme1n1"} 170000000',
    'node_disk_written_bytes_total{device="nvme0n1"} 30000000',
    '',
  ].join('\n')
  assert.equal(metricValue(reordered, 'node_disk_written_bytes_total'), 200000000)
})

check('an unlabelled single-series scalar is unchanged by summing (majfault, MemTotal)', () => {
  assert.equal(metricValue(TWO_DEVICE, 'node_vmstat_pgmajfault'), 42)
  assert.equal(metricValue('node_memory_MemTotal_bytes 4.14e+09\n', 'node_memory_MemTotal_bytes'), 4.14e+09)
})

check('anchors to line start: a prefix collision does not mis-read', () => {
  const s = 'x_node_vmstat_pgmajfault 999\nnode_vmstat_pgmajfault 7\n'
  assert.equal(metricValue(s, 'node_vmstat_pgmajfault'), 7)
})

check('reads scientific-notation values (Prometheus emits 4.14e+09 too)', () => {
  assert.equal(metricValue('node_memory_MemTotal_bytes 4.14e+09\n', 'node_memory_MemTotal_bytes'), 4.14e+09)
})

// --- exitDecision: the exit policy, not just the parser (2026-08-29 residual gap) ---
// The bug this pins: only an ALL-unreadable fleet went red, so ONE product losing its key
// (sample() -> null -> level 'unreadable') read as green and its disk-IO watchdog went dark
// with nobody told. And a run that discovered zero machines printed "0 machines checked" green.

check('ONE-of-six unreadable is non-zero and names the product (the residual bug)', () => {
  const findings = [
    { product: 'ReplyFlow', level: 'ok' }, { product: 'BackOffice', level: 'ok' },
    { product: 'Valrano', level: 'ok' }, { product: 'ChannelMover', level: 'ok' },
    { product: 'SignalScore', level: 'ok' }, { product: 'ScoutCopilot', level: 'unreadable' },
  ]
  const d = exitDecision(findings)
  assert.equal(d.code, 1, 'one unreadable machine must fail loudly, not read as all-clear')
  assert.match(d.message, /ScoutCopilot/, 'the unreadable product must be named in the alert')
})

check('ZERO machines discovered is non-zero (no *_SUPABASE_URL/key found)', () => {
  const d = exitDecision([])
  assert.equal(d.code, 1, 'a run that checked nothing must not read as "all clear"')
  assert.match(d.message, /no Supabase machines/, 'the empty-fleet case must say why it failed')
})

check('all machines ok -> exit 0 (the only green)', () => {
  const d = exitDecision([{ product: 'ReplyFlow', level: 'ok' }, { product: 'BackOffice', level: 'warn' }])
  assert.equal(d.code, 0)
  assert.equal(d.message, null)
})

check('a machine burning disk (fail) -> exit 1 and named', () => {
  const d = exitDecision([{ product: 'ReplyFlow', level: 'ok' }, { product: 'ScoutCopilot', level: 'fail' }])
  assert.equal(d.code, 1)
  assert.match(d.message, /ScoutCopilot/)
})

// --- discover(): a configured product with a missing key/ref must be REPORTED, not dropped ---
// The bug this pins (commit 3c90757 residual): checkMachines() filtered targets with
// `.filter(t => t.ref && t.key)` BEFORE any finding was created, so a product whose key secret
// was rotated/deleted/renamed-to-'' (or a URL refFromUrl() can't parse) produced NO finding at
// all — not 'unreadable'. The run printed "N-1 machines checked" and exited 0 green while that
// product's disk-IO watchdog was dark. discover() now keeps it with a `reason` so checkMachines()
// reports it and exitDecision()'s unreadable branch makes the run non-zero and names it.

check('a discovered product with an EMPTY key is reported, not dropped (the residual bug)', () => {
  const d = discover({ SCOUTCOPILOT_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co', SCOUTCOPILOT_SERVICE_ROLE_KEY: '' })
  assert.equal(d.length, 1, 'the product must still be discovered, not filtered out')
  assert.equal(d[0].product, 'SCOUTCOPILOT')
  assert.equal(d[0].reason, 'no key configured', 'an empty key must carry an unreadable reason')
})

check('a discovered product with a MISSING (absent) key is reported', () => {
  const d = discover({ SCOUTCOPILOT_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co' })
  assert.equal(d.length, 1)
  assert.equal(d[0].reason, 'no key configured')
})

check('a malformed / custom-domain URL (no parseable ref) is reported, not dropped', () => {
  const d = discover({ SCOUTCOPILOT_SUPABASE_URL: 'https://db.scoutcopilot.com', SCOUTCOPILOT_SERVICE_ROLE_KEY: 'sb_secret_xyz' })
  assert.equal(d.length, 1)
  assert.equal(d[0].ref, null)
  assert.equal(d[0].reason, 'no usable project ref in the URL')
})

check('a fully-configured product has no reason (it goes on to be sampled)', () => {
  const d = discover({ SCOUTCOPILOT_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co', SCOUTCOPILOT_SERVICE_ROLE_KEY: 'sb_secret_xyz' })
  assert.equal(d[0].reason, null)
  assert.equal(d[0].ref, 'abcdefghijklmnopqrst')
})

check('SECRET_KEY is accepted as well as SERVICE_ROLE_KEY', () => {
  const d = discover({ SCOUTCOPILOT_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co', SCOUTCOPILOT_SECRET_KEY: 'sb_secret_xyz' })
  assert.equal(d[0].reason, null)
})

check('end-to-end: a keyless product maps to an unreadable finding that exitDecision fails on', () => {
  // mimics what checkMachines() does with discover()'s reasoned rows
  const findings = discover({ SCOUTCOPILOT_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co', SCOUTCOPILOT_SERVICE_ROLE_KEY: '' })
    .filter((t) => t.reason)
    .map((t) => ({ product: t.product, level: 'unreadable', detail: t.reason }))
  const dec = exitDecision(findings)
  assert.equal(dec.code, 1, 'a keyless configured product must make the run non-zero')
  assert.match(dec.message, /SCOUTCOPILOT/, 'and it must be named in the alert')
})


// A pair of samples whose counters have not moved means we sampled inside one metrics-refresh
// window, NOT that the machine is idle. Before 2026-08-30 the gap was 30s, shorter than the
// refresh, so ALL 20 machines reported a perfect 0.00 MB/s and the check went green across the
// whole fleet — the same false all-clear as the regex bug, arriving by a different road.
check('identical counters between samples must NOT read as 0.00 MB/s OK', () => {
  const src = fs2.readFileSync(new URL('../scripts/check-supabase-machine-health.mjs', import.meta.url), 'utf8')
  assert.ok(/SAMPLE_GAP_MS = 180_000/.test(src), 'sample gap must be longer than the metrics refresh (180s)')
  assert.ok(/counters did not move/.test(src), 'a no-movement sample pair must be reported as inconclusive')
  const guardBeforeMath = src.indexOf('counters did not move') < src.indexOf('const dt = (b.at - a.at)')
  assert.ok(guardBeforeMath, 'the no-movement guard must run BEFORE the rate is computed')
})

// --- 2026-08-30: the blind path reached nobody, and the tested exit policy had been unwired ---
// Both regressions come from 986d205, which moved the "we found something" path onto the
// signals board and left the "we could not look" path behind. See blindSignal()'s comment.

check('blindSignal returns null when every machine was readable', () => {
  assert.equal(blindSignal([{ product: 'ReplyFlow', level: 'ok' }, { product: 'Valrano', level: 'fail' }]), null,
    'a readable fleet must not file a blindness row')
})

check('blindSignal names every blind machine and asks for a human', () => {
  const row = blindSignal([
    { product: 'ReplyFlow', level: 'ok' },
    { product: 'ChannelMover', level: 'unreadable', detail: 'no key configured' },
    { product: 'YTMigration', level: 'unreadable', detail: 'metrics endpoint returned no usable sample' },
  ])
  assert.equal(row.needs_human, true, 'a switched-off watchdog needs a person')
  assert.equal(row.severity, 'critical')
  assert.equal(row.key, 'supabase-disk-blind', 'the key must be stable so repeat sightings update one row')
  assert.match(row.summary, /ChannelMover/)
  assert.match(row.summary, /YTMigration/, 'every blind machine must be named, not just the first')
  assert.match(row.summary, /no key configured/, 'the reason must travel with the row')
})

// This one deliberately runs the REAL CLI in a subprocess. A function-level test is exactly
// what let the bug through: exitDecision() was green-tested all along while the CLI had
// stopped calling it, so the wiring — not the policy — is what needs pinning here.
check('CLI: discovering ZERO machines exits non-zero (the unwired exitDecision guard)', () => {
  const clean = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.endsWith('_SUPABASE_URL') && !k.endsWith('_SERVICE_ROLE_KEY') && !k.endsWith('_SECRET_KEY')) clean[k] = v
  }
  const r = spawnSync(process.execPath, ['scripts/check-supabase-machine-health.mjs'],
    { env: clean, encoding: 'utf-8', timeout: 60_000 })
  assert.notEqual(r.status, 0, 'a run that checked nothing at all must never read as all-clear')
  assert.match(String(r.stderr), /no Supabase machines were discovered/,
    'and it must say WHY it failed, not just exit 1')
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
