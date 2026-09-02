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
import { metricValue, exitDecision, discover, blindSignal, coverageGaps, missingFindings, productionOnly, loadBaseline, escalation, diskSignal, diskKey, recoveredKeys, recoverySignal, dedupeByRef } from '../scripts/check-supabase-machine-health.mjs'

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
//
// Its assertion changed with the coverage-floor fix below: the real baseline file lists 20
// projects, so a run with every *_SUPABASE_URL/key stripped now fails via the NAMED coverage
// path (blind.length > 0 -> process.exit(1) naming all 20) rather than the old generic
// "no Supabase machines were discovered" message — strictly more informative, since it now
// says WHICH projects went dark instead of only that the run learned nothing.
check('CLI: discovering ZERO machines exits non-zero and names what the baseline expected', () => {
  const clean = { BOARD_SUPABASE_SECRET: 'not-a-real-secret-this-test-must-not-file' }
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.endsWith('_SUPABASE_URL') && !k.endsWith('_SERVICE_ROLE_KEY') && !k.endsWith('_SECRET_KEY')) clean[k] = v
  }
  const r = spawnSync(process.execPath, ['scripts/check-supabase-machine-health.mjs'],
    { env: clean, encoding: 'utf-8', timeout: 60_000, cwd: new URL('..', import.meta.url) })
  assert.notEqual(r.status, 0, 'a run that checked nothing at all must never read as all-clear')
  assert.match(String(r.stdout), /coverage: 0\/\d+ expected projects watched/,
    'the shipped script must report coverage, not just count what it happened to see')
  assert.match(String(r.stderr), /could not be read/,
    'and it must say WHY it failed, not just exit 1')
})

// ---------------------------------------------------------------------------------------
// COVERAGE FLOOR — 2026-09-01 board item: "Nothing watches the Jass-Tour database's disk
// usage — the alarm has the wrong key." discover() is driven ENTIRELY by which *_SUPABASE_URL
// env vars exist this run. A product whose secret was never wired into monitor.yml's env
// block for THIS step, or whose secret name was renamed/dropped, produces no target and no
// finding — it is not 'unreadable', it is invisible, and invisible reads as fine. This is a
// DIFFERENT defect from the 2026-09-01 BOM bug in lib/credentials.mjs (a key that existed but
// was unusable, honestly reported as 'unreadable'): this is a key that never reached the
// process at all, reported as nothing whatsoever.
// ---------------------------------------------------------------------------------------

// The ref here is the LIVE Jass-Tour database (account 11api@predivo.ch), not the abandoned
// dkxdlovwzsxnepoteebk this fixture used to name. Corrected 2026-09-01 together with the
// baseline itself — a test that teaches the wrong ref is how the wrong ref spreads.
const JASSTOUR_BASELINE = { projects: [
  { ref: 'uyksotlmrlxhmyeopktl', product: 'Beize Jass Tour' },
  { ref: 'aaaaaaaaaaaaaaaaaaaa', product: 'Other Product' },
] }

check('DEFECT, proven by injection: a baseline project with NO *_SUPABASE_URL anywhere in env leaves discover() with zero trace of it', () => {
  // Simulates the fleet's actual state 2026-08-30 through 2026-09-01: every OTHER product is
  // present and healthy, but Jass-Tour's secret was never wired into this env at all.
  const env = { OTHER_SUPABASE_URL: 'https://aaaaaaaaaaaaaaaaaaaa.supabase.co', OTHER_SERVICE_ROLE_KEY: 'sb_secret_x' }
  const discovered = discover(env)
  assert.equal(discovered.length, 1, 'only the wired product is discovered')
  assert.ok(!discovered.some((d) => d.ref === 'uyksotlmrlxhmyeopktl'), 'Jass-Tour never appears — not even as a reasoned/unreadable row')

  // What the CLI computed BEFORE this fix: findings straight from discover(), nothing else.
  const preFixFindings = discovered.map((t) => (t.reason ? { product: t.product, level: 'unreadable', detail: t.reason } : { product: t.product, level: 'ok' }))
  const dec = exitDecision(preFixFindings)
  assert.equal(dec.code, 0, 'THE BUG: the missing product left no trace, so the pre-fix run reads as a clean, fully-covered fleet')
})

check('FIX: coverageGaps() catches the same missing product, and folding it in makes the run fail and name it', () => {
  const env = { OTHER_SUPABASE_URL: 'https://aaaaaaaaaaaaaaaaaaaa.supabase.co', OTHER_SERVICE_ROLE_KEY: 'sb_secret_x' }
  const discovered = discover(env)
  const gaps = coverageGaps(discovered, JASSTOUR_BASELINE)
  assert.equal(gaps.length, 1)
  assert.equal(gaps[0].product, 'Beize Jass Tour')
  assert.equal(gaps[0].ref, 'uyksotlmrlxhmyeopktl')

  const findings = [...discovered.map((t) => ({ product: t.product, level: 'ok' })), ...missingFindings(gaps)]
  const dec = exitDecision(findings)
  assert.equal(dec.code, 1, 'a product with no env presence at all must now fail the run, exactly like a rotated key does')
  assert.match(dec.message, /Beize Jass Tour/, 'the alert must name the specific product that has no watchdog, not just say "something is missing"')
})

check('missingFindings: a gap becomes a named, actionable finding, not a bare count', () => {
  const [f] = missingFindings([{ ref: 'uyksotlmrlxhmyeopktl', product: 'Beize Jass Tour' }])
  assert.equal(f.level, 'unreadable')
  assert.equal(f.product, 'Beize Jass Tour')
  assert.match(f.detail, /uyksotlmrlxhmyeopktl/, 'the ref must be in the text — that is what a person needs to go look it up')
  assert.equal(missingFindings(null).length, 0, 'unproven coverage (no baseline) invents no findings')
  assert.equal(missingFindings(undefined).length, 0)
})

// ---------------------------------------------------------------------------------------
// STAGING EXCLUSION — the shared baseline is the WHOLE fleet (20 projects, 9 of them
// staging). This step of monitor.yml has never wired a *_STAGING_SUPABASE_URL secret, so
// comparing raw against the full baseline would report all 9 staging projects as a gap on
// EVERY run — a false alarm the fix itself would manufacture. productionOnly() must strip
// them before coverageGaps() ever sees the baseline.
// ---------------------------------------------------------------------------------------

check('DEFECT, proven by injection: the UNFILTERED shared baseline manufactures a false alarm for every staging project', () => {
  const real = loadBaseline()
  assert.ok(real && real.projects.length >= 15, 'sanity: the real fleet baseline loaded and is not suspiciously small')
  const stagingCount = real.projects.filter((p) => /staging/i.test(p.product)).length
  assert.ok(stagingCount > 0, 'sanity: the real baseline does contain staging projects')
  // discover() sees only what THIS step actually wires — no staging secret among them, by design.
  const prodEnv = { JASSTOUR_SUPABASE_URL: 'https://uyksotlmrlxhmyeopktl.supabase.co', JASSTOUR_SERVICE_ROLE_KEY: 'sb_secret_x' }
  const gapsAgainstRawBaseline = coverageGaps(discover(prodEnv), real)
  assert.ok(gapsAgainstRawBaseline.length >= stagingCount,
    'THE BUG: comparing against the unfiltered fleet baseline reports every staging project as missing, every single run, forever')
})

check('FIX: productionOnly() strips every staging entry, so coverage compares against what this step actually wires', () => {
  const real = loadBaseline()
  const prod = productionOnly(real)
  assert.ok(!prod.projects.some((p) => /staging/i.test(p.product)), 'no staging product name may survive the filter')
  assert.equal(prod.projects.some((p) => p.product === 'Beize Jass Tour'), true, 'Jass-Tour itself is production and must survive the filter')
  assert.ok(prod.projects.length < real.projects.length, 'the filter must actually remove something')
})

check('productionOnly() is a no-op on null/empty baselines (unproven coverage stays unproven)', () => {
  assert.equal(productionOnly(null), null)
  assert.equal(productionOnly({ projects: [] }).projects.length, 0)
})

check('a fully-covered run has zero gaps and stays green on coverage alone', () => {
  const env = {
    JASSTOUR_SUPABASE_URL: 'https://uyksotlmrlxhmyeopktl.supabase.co', JASSTOUR_SERVICE_ROLE_KEY: 'sb_secret_x',
    OTHER_SUPABASE_URL: 'https://aaaaaaaaaaaaaaaaaaaa.supabase.co', OTHER_SERVICE_ROLE_KEY: 'sb_secret_y',
  }
  const gaps = coverageGaps(discover(env), JASSTOUR_BASELINE)
  assert.deepEqual(gaps, [], 'both baseline projects are wired — coverage is PROVEN complete, not merely quiet')
})

// ---------------------------------------------------------------------------------------
// THE TWO-DEVICE CASE, PINNED AGAINST A REAL CAPTURE (not a hand-written string).
//
// test/fixtures/supabase-metrics-two-device.prom is the verbatim disk/vmstat/memory block of a
// live 200 response from https://xoecpzfsskalvjrtcbbl.supabase.co/customer/v1/privileged/metrics
// (BackOffice), captured 2026-09-02. It is here because the inline TWO_DEVICE string above was
// written from a DESCRIPTION of the endpoint's format, and the two things a hand-written fixture
// got wrong are exactly the two that let the bug through:
//   1. the real values are in Prometheus SCIENTIFIC NOTATION (5.292687872e+10), not plain digits;
//   2. the real label block is not just {device="..."} — it carries supabase_project_ref,
//      supabase_identifier and service_type BEFORE device, so anything matching on a short or
//      anchored label block matches nothing at all.
// The same capture also disproves this file's old claim that vmstat/memory are UNLABELLED: they
// carry labels too, minus the device. The optional-label-block regex handles both, and that is
// now pinned by a real sample rather than by a belief about the format.
// ---------------------------------------------------------------------------------------

const REAL = fs2.readFileSync(new URL('./fixtures/supabase-metrics-two-device.prom', import.meta.url), 'utf8')

check('REAL CAPTURE: the endpoint really does expose two devices per disk counter', () => {
  assert.equal((REAL.match(/^node_disk_written_bytes_total\{/mg) || []).length, 2,
    'the fixture must actually contain the two-device case it is here to pin')
  assert.equal((REAL.match(/^node_disk_read_bytes_total\{/mg) || []).length, 2)
})

check('REAL CAPTURE: written bytes SUM both devices (first-series-only would drop 46% here)', () => {
  const nvme0 = 5.292687872e+10, nvme1 = 4.5584490496e+10
  assert.equal(metricValue(REAL, 'node_disk_written_bytes_total'), nvme0 + nvme1)
  // The receipt for why this matters on THIS machine: the dropped device is not a rounding error.
  const dropped = nvme1 / (nvme0 + nvme1)
  assert.ok(dropped > 0.4, `the second device carries ${(dropped * 100).toFixed(0)}% of BackOffice's writes — a first-series-only read undercounts by that much`)
})

check('REAL CAPTURE: read bytes SUM both devices', () => {
  assert.equal(metricValue(REAL, 'node_disk_read_bytes_total'), 9.3461862144e+11 + 5.3061108736e+10)
})

check('REAL CAPTURE: the labelled single-series scalars are still read exactly once', () => {
  assert.equal(metricValue(REAL, 'node_vmstat_pgmajfault'), 4.5032897e+07)
  assert.equal(metricValue(REAL, 'node_memory_MemTotal_bytes'), 4.26258432e+08)
})

check('DEFECT, proven by injection: the old first-series-only parser undercounts the real capture', () => {
  // The exact pre-7bf492c implementation, run against the real bytes.
  const oldMetricValue = (text, name) => {
    const m = text.match(new RegExp('^' + name + '(\\{[^}]*\\})?\\s+([0-9.e+-]+)', 'm'))
    return m ? Number(m[2]) : null
  }
  const old = oldMetricValue(REAL, 'node_disk_written_bytes_total')
  const now = metricValue(REAL, 'node_disk_written_bytes_total')
  assert.ok(old < now, 'THE BUG: the old parser returns strictly less than the machine actually wrote')
  assert.equal(old, 5.292687872e+10, 'and what it returns is exactly the first device, nothing more')
})

// ---------------------------------------------------------------------------------------
// THRESHOLDS + SUSTAINED-SAMPLE DEBOUNCE (2026-09-02, board item 62512b15).
//
// Two separate defects met here. The thresholds (2.0 warn / 4.0 fail) were calibrated against
// readings taken by the BROKEN one-device parser, so correcting the sum stepped the whole fleet
// over a line drawn for half a machine — 31.5% of 216 measured samples crossed the warn line and
// ten products sat on the board "wearing out its disk allowance". And a single 180-second sample
// was allowed to set needs_human, the flag that rings a phone, even though the same fleet swings
// by 4x between consecutive runs (BACKOFFICE 1.57 -> 6.66 MB/s, nothing wrong with it).
// ---------------------------------------------------------------------------------------

check('the warn line sits ABOVE the fleet p99 measured after the sum was fixed', () => {
  const src = fs2.readFileSync(new URL('../scripts/check-supabase-machine-health.mjs', import.meta.url), 'utf8')
  const warn = Number(src.match(/DISK_WARN_MB_S \|\| ([\d.]+)/)[1])
  const fail = Number(src.match(/DISK_FAIL_MB_S \|\| ([\d.]+)/)[1])
  // Measured 2026-09-01T21:07Z..2026-09-02T10:54Z, 216 samples over 18 post-7bf492c monitor runs.
  const FLEET_P99 = 6.27, FLEET_MAX = 9.09, WORST_MACHINE_P90 = 6.22, VENDOR_COMPLAINED_AT = 7.74
  assert.ok(warn > FLEET_P99, `a warn line at or below the fleet p99 (${FLEET_P99}) alarms on normal traffic`)
  assert.ok(warn > WORST_MACHINE_P90, 'and it must clear the worst single machine p90, or that machine alarms forever')
  assert.ok(warn >= VENDOR_COMPLAINED_AT, 'it must not sit above the level the vendor itself complained at — 7.74 is a LOWER bound (one-device reading)')
  assert.ok(fail > FLEET_MAX, `a fail line at or below the highest reading ever measured (${FLEET_MAX}) pages for observed-normal load`)
  assert.ok(fail > warn, 'fail must be louder than warn')
})

check('DEFECT, proven by injection: the OLD 2.0/4.0 pair alarms on a third of all measured samples', () => {
  // The real measured p50/p75/p90/p95/p99 of the post-fix fleet, as a stand-in for the 216 samples.
  const measured = [1.21, 2.52, 4.33, 4.86, 6.27]
  const overOld = measured.filter((v) => v >= 2.0).length
  const overNew = measured.filter((v) => v >= 8.0).length
  assert.equal(overOld, 4, 'THE BUG: 4 of the 5 fleet percentiles are at or above the old 2.0 warn line')
  assert.equal(overNew, 0, 'the re-derived line clears every one of them')
})

check('DEBOUNCE: a machine over the line for the FIRST time files a row but may not page', () => {
  const { consecutive, confirmed } = escalation(undefined)
  assert.equal(consecutive, 1)
  assert.equal(confirmed, false, 'THE BUG 62512b15 names: one 180s sample must not be allowed to ring a phone')
  const row = diskSignal({ product: 'VALRANO', mbs: 8.4, detail: '8.40 MB/s sustained disk' }, { consecutive, confirmed })
  assert.equal(row.needs_human, false, 'needs_human is the flag that rings at 03:00 — a single sample must never set it')
  assert.equal(row.severity, 'warning')
  assert.match(row.summary, /NOT alerted/, 'and the board row must say so, so a reader is not misled')
})

check('DEBOUNCE: the SECOND consecutive run over the line is what escalates and may page', () => {
  const prior = { key: 'supabase-disk:VALRANO', detail: { consecutive: 1 } }
  const { consecutive, confirmed } = escalation(prior)
  assert.equal(consecutive, 2)
  assert.equal(confirmed, true, 'sustained load across two hourly runs is a real finding')
  const row = diskSignal({ product: 'VALRANO', mbs: 8.4, detail: '8.40 MB/s sustained disk' }, { consecutive, confirmed })
  assert.equal(row.needs_human, true)
  assert.equal(row.severity, 'critical')
  assert.match(row.title, /2 runs in a row/, 'the title must say what makes it real, not just that it is loud')
})

check('DEBOUNCE: the half-hour blip from run 33307618045 -> 33308941358 cannot page', () => {
  // VALRANO measured 4.23 MB/s, then 1.50 MB/s 25 minutes later. Under the re-derived line it is
  // not even loud; and even at a hypothetical over-line first reading it only files a warning.
  const first = escalation(undefined)
  assert.equal(first.confirmed, false)
  // The next run finds it quiet, so nothing carries forward and the row is resolved instead.
  const stillOpen = ['supabase-disk:VALRANO']
  const thisRun = [{ product: 'VALRANO', level: 'ok', mbs: 1.5 }]
  assert.deepEqual(recoveredKeys(stillOpen, thisRun), ['supabase-disk:VALRANO'],
    'a machine measured back under the line must have its row closed, not left standing forever')
})

check('an old row with no consecutive count is treated as a prior sighting, not a fresh one', () => {
  // Rows filed before this change carry no `consecutive`. Reading that as zero would restart the
  // clock every run and a genuinely sustained machine could never escalate.
  const { consecutive, confirmed } = escalation({ key: 'supabase-disk:REPLYFLOW', detail: {} })
  assert.equal(consecutive, 2)
  assert.equal(confirmed, true)
})

check('RECOVERY: a machine that was UNREADABLE this run keeps its open row', () => {
  const open = ['supabase-disk:REPLYFLOW', 'supabase-disk:VALRANO']
  const thisRun = [{ product: 'REPLYFLOW', level: 'unreadable' }, { product: 'VALRANO', level: 'ok' }]
  assert.deepEqual(recoveredKeys(open, thisRun), ['supabase-disk:VALRANO'],
    '"we could not look" is not "it recovered" — closing on absence turns a blind spot into a clean bill of health')
})

check('RECOVERY: a machine still over the line is never resolved', () => {
  const open = ['supabase-disk:REPLYFLOW']
  assert.deepEqual(recoveredKeys(open, [{ product: 'REPLYFLOW', level: 'warn', mbs: 9.1 }]), [])
  assert.deepEqual(recoveredKeys(open, [{ product: 'REPLYFLOW', level: 'fail', mbs: 13 }]), [])
})

check('RECOVERY: rows belonging to other sensors are never touched', () => {
  const open = ['supabase-disk:VALRANO', 'products-down:ReplyFlow', 'supabase-disk-blind']
  assert.deepEqual(recoveredKeys(open, [{ product: 'VALRANO', level: 'ok' }]), ['supabase-disk:VALRANO'],
    'only this check\'s own per-product keys are eligible to be closed by this check')
})

check('recoverySignal closes the row and says what re-measurement proved it', () => {
  const r = recoverySignal(diskKey('VALRANO'))
  assert.equal(r.state, 'resolved')
  assert.equal(r.key, 'supabase-disk:VALRANO')
  assert.match(r.title, /VALRANO/)
  assert.match(r.summary, /below/)
})

check('diskKey is stable, so repeat sightings update one row instead of breeding duplicates', () => {
  assert.equal(diskKey('REPLYFLOW'), 'supabase-disk:REPLYFLOW')
})


// --- ONE MACHINE, ONE ROW: two secret names for the same renamed project ------------------
// The live defect, read off Production Monitor run 33620858198 (2026-09-02T10:54Z): the step
// printed "12 machines checked" while coverage said "11/11 expected projects watched", and
// YTMIGRATION and CHANNELMOVER both reported 0.54 MB/s, 16 faults/s, 26.1 KB per fault - the
// same three figures to three significant digits, because ChannelMover WAS YTMigration and
// monitor.yml still wires both names at the same database. One machine was sampled twice,
// counted twice, and filed a second board row under a product that no longer exists.

check('two env prefixes pointing at ONE project are counted once', () => {
  const d = discover({
    CHANNELMOVER_SUPABASE_URL: 'https://qswluvqunswggfmesdcs.supabase.co',
    CHANNELMOVER_SERVICE_ROLE_KEY: 'sb_secret_a',
    YTMIGRATION_SUPABASE_URL: 'https://qswluvqunswggfmesdcs.supabase.co',
    YTMIGRATION_SERVICE_ROLE_KEY: 'sb_secret_a',
  })
  assert.equal(d.length, 1, 'one database must produce one target, not two')
  assert.equal(d[0].product, 'CHANNELMOVER', 'the alphabetically-first prefix survives, so the name is stable across runs')
  assert.deepEqual(d[0].aliases, ['YTMIGRATION'], 'the collapsed name is carried, never silently dropped')
})

check('the surviving name does not depend on the order the env happens to be in', () => {
  const a = discover({
    YTMIGRATION_SUPABASE_URL: 'https://qswluvqunswggfmesdcs.supabase.co', YTMIGRATION_SERVICE_ROLE_KEY: 'k',
    CHANNELMOVER_SUPABASE_URL: 'https://qswluvqunswggfmesdcs.supabase.co', CHANNELMOVER_SERVICE_ROLE_KEY: 'k',
  })
  assert.equal(a.length, 1)
  assert.equal(a[0].product, 'CHANNELMOVER')
})

check('the signal key is therefore stable: one machine can never breed two disk rows', () => {
  const d = discover({
    CHANNELMOVER_SUPABASE_URL: 'https://qswluvqunswggfmesdcs.supabase.co', CHANNELMOVER_SERVICE_ROLE_KEY: 'k',
    YTMIGRATION_SUPABASE_URL: 'https://qswluvqunswggfmesdcs.supabase.co', YTMIGRATION_SERVICE_ROLE_KEY: 'k',
  })
  assert.deepEqual(d.map((t) => diskKey(t.product)), ['supabase-disk:CHANNELMOVER'])
})

check('DIFFERENT projects are never collapsed', () => {
  const d = discover({
    REPLYFLOW_SUPABASE_URL: 'https://dqmhsdzldkxngwjrxois.supabase.co', REPLYFLOW_SERVICE_ROLE_KEY: 'k',
    CHANNELMOVER_SUPABASE_URL: 'https://qswluvqunswggfmesdcs.supabase.co', CHANNELMOVER_SERVICE_ROLE_KEY: 'k',
  })
  assert.equal(d.length, 2)
  assert.ok(d.every((t) => !t.aliases), 'no alias is recorded when nothing was collapsed')
})

check('two keyless prefixes for ONE database are one blind machine, not two', () => {
  const d = discover({
    CHANNELMOVER_SUPABASE_URL: 'https://qswluvqunswggfmesdcs.supabase.co',
    YTMIGRATION_SUPABASE_URL: 'https://qswluvqunswggfmesdcs.supabase.co',
  })
  assert.equal(d.length, 1, 'one unwatched database is one unreadable finding')
  assert.equal(d[0].reason, 'no key configured')
  assert.deepEqual(d[0].aliases, ['YTMIGRATION'])
})

check('a USABLE entry beats its keyless twin, so no blind alarm is raised for a watched machine', () => {
  const d = discover({
    YTMIGRATION_SUPABASE_URL: 'https://qswluvqunswggfmesdcs.supabase.co', YTMIGRATION_SERVICE_ROLE_KEY: 'k',
    CHANNELMOVER_SUPABASE_URL: 'https://qswluvqunswggfmesdcs.supabase.co',
  })
  assert.equal(d.length, 1)
  assert.equal(d[0].product, 'YTMIGRATION', 'the one that can actually be read survives, alphabetical order notwithstanding')
  assert.equal(d[0].reason, null, 'the machine is watched, so nothing may be reported blind for it')
})

check('collapsing does not hide a project from the coverage floor', () => {
  const env = {
    CHANNELMOVER_SUPABASE_URL: 'https://qswluvqunswggfmesdcs.supabase.co', CHANNELMOVER_SERVICE_ROLE_KEY: 'k',
    YTMIGRATION_SUPABASE_URL: 'https://qswluvqunswggfmesdcs.supabase.co', YTMIGRATION_SERVICE_ROLE_KEY: 'k',
  }
  const base = { projects: [{ product: 'ChannelMover', ref: 'qswluvqunswggfmesdcs' }] }
  assert.deepEqual(coverageGaps(discover(env), base), [], 'the surviving row still carries the ref that proves coverage')
})

check('dedupeByRef is pure and leaves a ref-less entry alone', () => {
  const out = dedupeByRef([{ product: 'A', ref: null, reason: 'no usable project ref in the URL' }])
  assert.equal(out.length, 1)
  assert.equal(out[0].ref, null)
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
