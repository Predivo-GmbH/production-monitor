/**
 * Supabase machine health — the check that should have existed before 2026-08-29.
 *
 * WHY: Supabase emailed Roger at 05:07 that ScoutCopilot was running out of Disk IO
 * budget. Nothing of ours had noticed, for months. The cause turned out to be the
 * platform build the project was running on: on supabase-postgres-17.6.1.084 the machine
 * read ~74 KB from disk per page fault, ~96 times a second, around the clock. Measured
 * before and after the free upgrade to 17.6.1.166:
 *     before  96 faults/s · 7.11 MB/s read · 7.74 MB/s total · 74.1 KB per fault
 *     after   20 faults/s · 0.66 MB/s read · 0.67 MB/s total · 32.3 KB per fault
 * i.e. 0.67/7.74 = 8.7% of the previous disk traffic.
 *
 * Two failures made that possible and this check closes both:
 *   1. nothing measured our machines' disk load, so only the vendor could tell us;
 *   2. nothing noticed a project sitting on a stale platform build.
 *
 * Discovery is generic: any <PREFIX>_SUPABASE_URL with a matching key is checked, so a
 * new product is covered without anyone editing this file.
 */

import { boardSecret, fileSignal, signal } from "./lib/fleet-signal.mjs"
import { sanitizeEnvAndReport } from "./lib/credentials.mjs"
// The coverage-floor half of the fix, in the house style of check-supabase-build-currency.mjs
// and expire-stale-sessions.mjs (scripts/lib/supabase-coverage.mjs, extracted 2026-08-30 when
// build-currency and the session sweep hit the identical hole on the same day). This file did
// NOT have it: discover() is driven entirely by which *_SUPABASE_URL env vars exist THIS run,
// so a product whose secret was never wired into monitor.yml's env block for this step, or
// whose secret name was renamed/deleted, does not produce a finding at all — not 'unreadable',
// not counted, not printed. It is simply absent, and absent reads as fine: "N-1 machines
// checked, 0 over the line, 0 unreadable" is indistinguishable from a clean fleet. Board item
// 2026-09-01 "Nothing watches the Jass-Tour database's disk usage — the alarm has the wrong
// key": Jass-Tour's disk secret only entered this step's env block on 2026-08-30 and only got
// a real value on 2026-09-01 — for the ten days between, discover() never once produced a
// JASSTOUR row, and nothing said so. That is a DIFFERENT defect from the 2026-09-01 BOM bug in
// lib/credentials.mjs (a key that existed but was unusable, reported honestly as 'unreadable');
// this is a key that never reached the process at all, reported as nothing.
import { coverageGaps, coverageLine, loadBaseline } from './lib/supabase-coverage.mjs'

export { coverageGaps, loadBaseline }

/**
 * This check currently watches PRODUCTION disk usage only: monitor.yml's "Supabase machine
 * health" step has never wired a single *_STAGING_SUPABASE_URL secret into its env block (11
 * production prefixes plus YTMIGRATION, no staging ones — see the same workflow's other steps,
 * which DO carry staging secrets for other purposes). scripts/lib/supabase-projects-baseline.json
 * is the WHOLE fleet's inventory, staging included (9 of its 20 entries have "Staging" in the
 * name), because that is what expire-stale-sessions.mjs and check-supabase-build-currency.mjs
 * are each responsible for. Comparing this check's coverage against the unfiltered baseline
 * would report all 9 staging projects as a permanent gap on every single run — a self-inflicted
 * false alarm manufactured by the fix itself, not a genuine finding, and exactly the kind of
 * noise the open board signal "supabase-disk-pressure-rotates-across-projects" is already
 * complaining about. Filtered here, not forked into a second file, so there is still exactly
 * one written-down inventory; "staging is out of scope for this particular watchdog" is a fact
 * about what monitor.yml wires, not a fact about the fleet, so it does not belong in the shared
 * baseline itself. That staging disk usage is unwatched at all is real and is NOT this fix —
 * see the handover note filed alongside this change.
 */
export function productionOnly(baseline) {
  if (!baseline?.projects?.length) return baseline
  return { ...baseline, projects: baseline.projects.filter((p) => !/staging/i.test(p.product)) }
}

/**
 * THRESHOLDS, RE-DERIVED 2026-09-02 FROM MEASURED DATA. The old pair (2.0 warn / 4.0 fail) was
 * chosen on 2026-08-29 against numbers produced by the BROKEN parser — the one that read a
 * single block device and dropped the rest of the machine (fixed in 7bf492c). Every reading the
 * old line was calibrated against was therefore an UNDERCOUNT, so when the sum was corrected the
 * whole fleet stepped over a line that had been drawn for half a machine. That is why ten
 * products were sitting on the signals board titled "is wearing out its disk allowance" and why
 * the board's own hygiene row says the numbers "flip OK to FAIL within half an hour".
 *
 * THE MEASUREMENT (this is the arithmetic, not a feeling). 216 samples = 12 production machines
 * x 18 consecutive monitor runs, read out of the "Supabase machine health" step logs of runs
 * 33556826606 .. 33620858198, window 2026-09-01T21:07Z -> 2026-09-02T10:54Z (13.8 h). Every one
 * of those runs is post-7bf492c, i.e. all-device sums, verified with `git merge-base
 * --is-ancestor 7bf492c <run sha>`.
 *
 *   fleet percentiles   p50 1.21   p75 2.52   p90 4.33   p95 4.86   p99 6.27   max 9.09 MB/s
 *   samples at or above the OLD warn line (2.0): 68/216 = 31.5%
 *   samples at or above the OLD fail line (4.0): 26/216 = 12.0%
 *   worst single machine p90: BACKOFFICE 6.22   (per-product p90s: ARIVIOO 2.42, BOATBUDDY 3.06,
 *   CHANNELMOVER 3.45, DISTRIBUTIONOS 4.51, JASSTOUR 3.68, LAUNCHREADY 4.00, REPLYFLOW 4.98,
 *   SCOUTCOPILOT 4.15, SIGNALSCORE 0.56, VALRANO 4.70, YTMIGRATION 3.46)
 *
 * A line that 31.5% of all normal samples cross is not a line, it is a metronome. Worse, it is a
 * line nobody outside this repo agrees with: Supabase sent ZERO disk warnings in the 21 days
 * covering that traffic (2026-09-01 mailbox sweep, 1 Supabase mail in the period and it was a
 * password reset). So the entire observed band up to p99 6.27 MB/s is traffic the vendor who
 * actually meters and bills the disk allowance is demonstrably fine with.
 *
 * THE ONE HARD ANCHOR is the 2026-08-29 ScoutCopilot email — the only time the vendor did
 * complain. The machine measured 7.74 MB/s then, BUT that figure came off the one-device parser,
 * so 7.74 is a LOWER BOUND on what the machine was really doing. Setting the warn line at or
 * just above it is therefore conservative in the safe direction.
 *
 *   WARN 8.0 = above the vendor's proven lower-bound complaint level (7.74), above the fleet p99
 *              (6.27) and above every single machine's p90 (worst 6.22). Reached by 1/216 = 0.5%
 *              of measured samples — one REPLYFLOW reading of 9.09.
 *   FAIL 12.0 = 1.5 x WARN, and 1.9 x the fleet p99. Nothing in the fleet has ever been observed
 *              there; the highest reading in 216 samples is 9.09.
 *
 * These are still env-overridable, so a machine class with a genuinely different floor can be
 * tuned in monitor.yml without a code change.
 */
const WARN_MB_S = Number(process.env.DISK_WARN_MB_S || 8.0)
const FAIL_MB_S = Number(process.env.DISK_FAIL_MB_S || 12.0)

/**
 * SUSTAINED-SAMPLE DEBOUNCE. A threshold alone cannot fix this alarm, because the reading itself
 * is one 180-second delta and a single checkpoint or autovacuum burst inside those three minutes
 * moves it by a factor of four: BACKOFFICE ranged 1.57 -> 6.66 MB/s across the same 18 runs, with
 * nothing wrong with it. Board item 62512b15 ("The new disk alarm can wake you for a machine that
 * was fine 25 minutes later") pins the original sighting: run 33307618045 called VALRANO critical
 * at 4.23 MB/s and 25 minutes later run 33308941358 read the same machine at 1.50 while flagging
 * two entirely different products.
 *
 * So being over the line ONCE is a board row and nothing else. `needs_human` — the flag that is
 * allowed to ring Roger's phone at 03:00 — is set only when the SAME machine is over the line on
 * two consecutive monitor runs, which at the hourly cadence means the load held for about an
 * hour. A half-hour blip cannot page, by construction.
 *
 * This is deliberately the SAME two-run rule check-products-down.mjs already runs ("a single bad
 * hour is not an outage"), read from the same place: the previously filed signal row. Copying the
 * house pattern rather than inventing a second one is the point.
 */
const SUSTAINED_RUNS = Number(process.env.DISK_SUSTAINED_RUNS || 2)
const SAMPLE_GAP_MS = 180_000  // Supabase refreshes these counters on its own scrape interval.
                               // At 30s BOTH samples read identical values and every machine
                               // scored a perfect 0.00 MB/s, i.e. a false all-clear across the
                               // whole fleet. 3 minutes is comfortably longer than the refresh.

// The label block is OPTIONAL: node_vmstat_pgmajfault and node_memory_MemTotal_bytes are
// exposed WITHOUT labels, while node_disk_*_bytes_total carry a {device="..."} block. The
// braces and \s MUST be regex-escaped — a single-quoted JS literal '\{' is just '{' and '\s'
// is a bare 's', which silently compiles to a pattern that matches nothing (the 2026-08-29
// bug where every machine read as 'unreadable' and the check went green forever).
//
// SUMS ALL matching series. node_disk_read/written_bytes_total appear ONCE PER BLOCK DEVICE —
// a machine with two NVMe volumes emits node_disk_read_bytes_total{device="nvme0n1"} AND
// {device="nvme1n1"}. A non-global .match() returned only the FIRST device, silently dropping
// the rest of the machine's disk traffic (2026-08-30: 88% of ReplyFlow's writes lived on the
// second device, so every published figure and the spend decision built on it were wrong).
// For the unlabelled scalars (majfault, MemTotal) there is exactly one series, so the sum is
// just that value — behaviour is unchanged for them. Returns null only when NO series matches,
// preserving the 'unreadable' detection the exit policy depends on.
export const metricValue = (text, name) => {
  const re = new RegExp('^' + name + '(\\{[^}]*\\})?\\s+([0-9.e+-]+)', 'mg')
  let sum = null
  for (const m of text.matchAll(re)) sum = (sum ?? 0) + Number(m[2])
  return sum
}

async function sample(ref, key) {
  const res = await fetch(`https://${ref}.supabase.co/customer/v1/privileged/metrics`, {
    headers: { Authorization: 'Basic ' + Buffer.from('service_role:' + key).toString('base64') },
  })
  // An HTTP error carries WHY the read failed — 401 (key rotated/expired), 429 (scrape rate
  // limited), 5xx (vendor). It returns a status-only object rather than null so checkMachines()
  // can put that code on the board and in the log: the 2026-09-05 ARIVIOO blind drain could not
  // tell 401-vs-429-vs-timeout apart because this path swallowed the status silently. The object
  // has no `read` field, so the `a.read == null` unreadable guard below still fires exactly as
  // before. A network throw (timeout, DNS) never reaches here — it is caught to null by the
  // caller, and a null status reads as "timeout/network".
  if (!res.ok) return { httpStatus: res.status }
  const t = await res.text()
  return {
    at: Date.now(),
    majfault: metricValue(t, 'node_vmstat_pgmajfault'),
    read: metricValue(t, 'node_disk_read_bytes_total'),
    written: metricValue(t, 'node_disk_written_bytes_total'),
    ramMB: Math.round((metricValue(t, 'node_memory_MemTotal_bytes') || 0) / 1e6),
  }
}

function refFromUrl(url) {
  const m = String(url).match(/https:\/\/([a-z0-9]{20})\.supabase\.co/)
  return m ? m[1] : null
}

// Discover every product from *_SUPABASE_URL and resolve its project ref + key. A product whose
// key or ref resolves FALSY is KEPT here with a `reason`, never filtered out: a rotated/deleted
// GitHub secret, a renamed secret that expands to '' (monitor.yml wires <PREFIX>_SERVICE_ROLE_KEY
// by name), or a malformed/custom-domain URL that refFromUrl() can't parse must still be REPORTED
// as unreadable. Filtering it out before any finding exists is exactly how one product goes dark
// while the run prints "N-1 machines checked" and exits 0 green — the "goes quiet on access loss
// reads as all clear" failure this file exists to prevent. Exported so the discovery→report path
// is unit-tested without the network or the 30s sample gap.
export function discover(env = process.env) {
  const prefixes = Object.keys(env).filter((k) => k.endsWith('_SUPABASE_URL')).map((k) => k.slice(0, -'_SUPABASE_URL'.length))
  return dedupeByRef(prefixes.map((p) => {
    const ref = refFromUrl(env[`${p}_SUPABASE_URL`])
    const key = env[`${p}_SECRET_KEY`] || env[`${p}_SERVICE_ROLE_KEY`]
    const reason = !key ? 'no key configured' : !ref ? 'no usable project ref in the URL' : null
    return { product: p, ref, key, reason }
  }))
}

/**
 * ONE MACHINE, ONE ROW — collapse env prefixes that resolve to the SAME project ref.
 *
 * WHY (2026-09-02): a product that got RENAMED keeps its old secret names alive for the specs
 * that still reference them. ChannelMover was YTMigration, and monitor.yml wires BOTH
 * CHANNELMOVER_SUPABASE_URL and YTMIGRATION_SUPABASE_URL into this step. They are the same
 * database. The check therefore sampled project qswluvqunswggfmesdcs twice, printed "12 machines
 * checked" for 11 machines, and filed a second board row under the product name YTMIGRATION —
 * a product that does not exist and that nobody can act on. Two of the ten "is wearing out its
 * disk allowance" rows on the signals board were that one machine counted twice.
 *
 * It also poisoned the diagnosis of the alarm itself. The 2026-09-01 hygiene signal
 * `supabase-disk-pressure-rotates-across-projects` argued the metric could not be per-project
 * because "YTMIGRATION and CHANNELMOVER keep reporting BYTE-IDENTICAL figures", and treated that
 * as the decisive tell. It is not a tell at all: those two names ARE one machine, so identical
 * readings are the correct answer. (Other same-run collisions in that signal, e.g. SCOUTCOPILOT
 * landing on the same 1.05 MB/s, are NOT explained by this and remain open on item 62512b15.)
 *
 * WHICH NAME SURVIVES is decided, never left to Object.keys order. A USABLE entry always beats an
 * unusable one, and among equals the alphabetically-first prefix wins. Both halves matter:
 *   - key preference: if CHANNELMOVER carries a working key and the legacy YTMIGRATION name does
 *     not, the machine IS being watched. Letting the keyless twin survive would file "the disk
 *     watchdog is blind for YTMIGRATION" — a blind alarm, naming a product that does not exist,
 *     about a database that was in fact read this run.
 *   - alphabetical tie-break: the same environment then always produces the same product name, so
 *     the signal key `supabase-disk:<product>` is stable across runs instead of flapping between
 *     two names and breeding a second board row every time the order changed.
 *
 * The losers are NOT dropped silently — they travel on the survivor as `aliases`, and the CLI
 * prints the collapse, because "the count went down" with no reason printed is the same class of
 * quiet blindness the rest of this file exists to prevent.
 *
 * An entry with NO parseable ref is never collapsed onto anything: it has no identity to be the
 * same machine as, and it must still be reported as unreadable on its own.
 */
export function dedupeByRef(targets) {
  const byRef = new Map()
  const out = []
  const order = [...(targets ?? [])].sort((a, b) =>
    (a.reason ? 1 : 0) - (b.reason ? 1 : 0) || String(a.product).localeCompare(String(b.product)))
  for (const t of order) {
    if (!t.ref) { out.push(t); continue }
    const kept = byRef.get(t.ref)
    if (!kept) { byRef.set(t.ref, t); out.push(t); continue }
    kept.aliases = [...(kept.aliases ?? []), t.product]
  }
  return out.sort((a, b) => String(a.product).localeCompare(String(b.product)))
}

export async function checkMachines(env = process.env) {
  const findings = []
  const targets = []
  for (const t of discover(env)) {
    if (t.reason) findings.push({ product: t.product, level: 'unreadable', detail: t.reason })
    else targets.push(t)
  }

  const first = await Promise.all(targets.map((t) => sample(t.ref, t.key).catch(() => null)))
  // Only wait out the metrics refresh when there is actually a second sample to take. With zero
  // targets the gap bought nothing and cost 3 minutes, which also made the no-machines-discovered
  // guard untestable in practice.
  if (targets.length) await new Promise((r) => setTimeout(r, SAMPLE_GAP_MS))
  const second = await Promise.all(targets.map((t) => sample(t.ref, t.key).catch(() => null)))

  targets.forEach((t, i) => {
    const a = first[i], b = second[i]
    // A machine we cannot read is reported, not silently skipped: a check that goes quiet
    // when it loses access reads as "all clear", which is the failure mode this file exists for.
    if (!a || !b || a.read == null || b.read == null) {
      const httpStatus = a?.httpStatus ?? b?.httpStatus ?? null
      const detail = httpStatus
        ? `metrics endpoint returned HTTP ${httpStatus} — no usable sample`
        : 'metrics endpoint returned no usable sample'
      findings.push({ product: t.product, level: 'unreadable', detail, httpStatus })
      return
    }
    // Counters that did not move at all mean we sampled inside one refresh window, not that
    // the machine is idle. Reporting that as 0.00 MB/s OK is the false all-clear this check exists to avoid.
    if (b.read === a.read && b.majfault === a.majfault) {
      findings.push({ product: t.product, level: 'unreadable', detail: 'counters did not move between samples — window shorter than the metrics refresh' })
      return
    }
    const dt = (b.at - a.at) / 1000
    const mbs = ((b.read - a.read) + (b.written - a.written)) / dt / 1e6
    const faults = (b.majfault - a.majfault) / dt
    const kbPerFault = faults > 0 ? ((b.read - a.read) / dt) / faults / 1024 : 0
    const level = mbs >= FAIL_MB_S ? 'fail' : mbs >= WARN_MB_S ? 'warn' : 'ok'
    findings.push({
      product: t.product, level, ramMB: a.ramMB,
      mbs: +mbs.toFixed(2), faultsPerSec: Math.round(faults), kbPerFault: +kbPerFault.toFixed(1),
      detail: `${mbs.toFixed(2)} MB/s sustained disk, ${Math.round(faults)} faults/s at ${kbPerFault.toFixed(1)} KB each`,
    })
  })
  return findings
}

// A check that learned NOTHING must not read as all-clear — that is the exact failure mode the
// comment at checkMachines() exists to prevent. So a machine burning disk, ANY machine that came
// back unreadable (a single rotated/revoked key or a drifted metrics format blinds the watchdog
// for THAT product — it does not have to be the whole fleet), and a run that discovered no
// machines at all are each non-zero. Exported (not inlined) so this exit policy is unit-tested,
// not merely the metric parser: the 2026-08-29 residual gap was that only an ALL-unreadable fleet
// went red, so one product silently going dark read as green.
export function exitDecision(findings) {
  const bad = findings.filter((f) => f.level === 'fail')
  const unreadable = findings.filter((f) => f.level === 'unreadable')
  if (bad.length) {
    return { code: 1, message: `::error::a Supabase machine is burning disk IO — this is what the 2026-08-29 vendor email was: ${bad.map((f) => f.product).join(', ')}` }
  }
  if (unreadable.length) {
    return { code: 1, message: `::error::a Supabase machine was unreadable — the watchdog is blind for it (broken/rotated key or drifted metrics), not "all clear": ${unreadable.map((f) => f.product).join(', ')}` }
  }
  if (!findings.length) {
    return { code: 1, message: '::error::no Supabase machines were discovered — every *_SUPABASE_URL/key pair was missing, so nothing was checked; this is not "all clear"' }
  }
  return { code: 0, message: null }
}

/**
 * Coverage gaps rendered as ordinary unreadable findings, so the ONE blindness path
 * (blindSignal + exitDecision's unreadable branch) reports a totally-missing product exactly
 * like a rotated/empty key. From the fleet's point of view there is no difference between the
 * two: nobody is watching that project's disk either way, and a person fixing this needs the
 * same board row and the same non-zero exit regardless of which one happened.
 *
 * `ref` travels on the finding so the alert names something a person can look up even though
 * discover() itself never saw this product this run — it has no `product` env-var-prefix to
 * report because no *_SUPABASE_URL for it existed in this run's environment at all.
 */
export function missingFindings(gaps) {
  return (gaps ?? []).map((p) => ({
    ref: p.ref,
    product: p.product,
    level: 'unreadable',
    detail: `no *_SUPABASE_URL/key pair in this run's environment resolves to project ${p.ref} — it is expected by scripts/lib/supabase-projects-baseline.json but discover() never produced a row for it, so its disk-IO watchdog has been dark, not merely unreadable`,
  }))
}

/**
 * The board row for a watchdog that has gone BLIND for ONE machine, as opposed to one that found
 * something. Blindness is now debounced and recovered per machine, exactly like the disk-LOAD
 * path (escalation()/diskSignal()/recoveredKeys()), because it had neither and that is the whole
 * bug this replaces.
 *
 * 986d205 routed the "we found something" path onto the signals board, because a bare exit(1)
 * only reds the run and send-alert.mjs reads Playwright's results.json — so the email lists
 * ZERO failures while the fact appears nowhere a person looks. The `unreadable` path was left
 * on the old bare-exit route, so the one state that means "this watchdog is switched off for
 * that product" was also the one state nobody could see. Pure, so it is tested without network.
 *
 * THE BUG THIS FIXES (2026-09-05, 2nd drain: JASSTOUR 09-01, ARIVIOO now). The predecessor filed
 * ONE aggregate `supabase-disk-blind` row with needs_human on ANY unreadable finding — no
 * consecutive-run debounce — so a single transient metrics-scrape miss on any of 11 machines
 * (ARIVIOO read fine 12 of the prior 13 runs) filed a paging critical, at 03:00, for a machine
 * that was fine an hour later. And recoveredKeys() only ever resolved `supabase-disk:` keys, so
 * the aggregate row could never self-clear. This is the disk-LOAD debounce (item 62512b15,
 * "the disk alarm can wake you for a machine fine 25 min later") applied to the blindness half:
 * a first unreadable sighting is a WARNING nobody is woken for that STILL reds the run, and only
 * the SAME machine unreadable on two consecutive runs may page.
 *
 * This does NOT make blindness green: the caller still exits non-zero afterwards on ANY unreadable
 * machine, per the house rule in fleet-signal.mjs that only a failed READ exits non-zero. Safety
 * is preserved (every blind run is red); only the 03:00 PAGE waits for confirmation.
 */
export const blindKey = (product) => `supabase-disk-blind:${product}`

// The single aggregate key this check filed before blindness was tracked per machine. No run
// files it any more, so an open one would stand open forever; the CLI supersedes it once (see
// legacyBlindRecoverySignal) in favour of the per-machine rows.
export const LEGACY_BLIND_KEY = 'supabase-disk-blind'

export function blindSignalFor(f, { confirmed, consecutive }) {
  const status = f.httpStatus ? ` (HTTP ${f.httpStatus})` : ''
  return signal({
    key: blindKey(f.product),
    product: f.product,
    severity: confirmed ? 'critical' : 'warning',
    needsHuman: confirmed,
    title: confirmed
      ? `The Supabase disk watchdog has been blind for ${f.product} on ${consecutive} runs in a row`
      : `The Supabase disk watchdog could not read ${f.product} once — confirming on the next run`,
    summary: confirmed
      ? `No disk reading could be taken for ${f.product}${status} on ${consecutive} consecutive monitor runs (latest: ${f.detail}). For this machine nothing is watching disk IO at all — the state the fleet was in on 2026-08-29 when only Supabase's own billing email revealed ScoutCopilot burning 7.74 MB/s. A machine going quiet on two runs running is not a machine behaving.`
      : `No disk reading could be taken for ${f.product}${status} in this run (${f.detail}). Filed but NOT alerted: a single scrape miss is not a blind watchdog — the metrics endpoint routinely drops one sample (a 429, a momentary timeout) and reads fine the next run. If the NEXT monitor run also cannot read ${f.product}, this escalates and is allowed to ring. The run is still red now, so the miss is never silently green.`,
    detail: { product: f.product, reason: f.detail, httpStatus: f.httpStatus ?? null, ref: f.ref ?? null, consecutive, confirmed },
  })
}

export const diskKey = (product) => `supabase-disk:${product}`

/**
 * How many consecutive runs this machine has now been over the line, and whether that is enough
 * to be allowed to wake anybody. Pure, because this is the whole debounce and it must be tested
 * without a network: the previous run's count travels on the previously filed signal row.
 *
 * `prior` is the open fleet_signals row for this product, or undefined when there is none. A row
 * that exists but carries no count is treated as ONE prior sighting rather than zero — rows filed
 * before this change have no `consecutive` field, and reading that absence as "never seen before"
 * would silently restart the clock on every genuinely sustained machine.
 */
export function escalation(prior, needed = SUSTAINED_RUNS) {
  const before = prior ? Number(prior.detail?.consecutive) || 1 : 0
  const consecutive = before + 1
  return { consecutive, confirmed: consecutive >= needed }
}

/**
 * The board row for a machine over the disk line. First sighting is a WARNING nobody is woken
 * for and it says so in its own text, so a person reading the board is not misled into thinking
 * it has been checked twice. Only a confirmed, sustained breach sets needs_human.
 */
export function diskSignal(f, { confirmed, consecutive }) {
  return signal({
    key: diskKey(f.product),
    product: f.product,
    severity: confirmed ? 'critical' : 'warning',
    needsHuman: confirmed,
    title: confirmed
      ? `${f.product} has been over its disk line for ${consecutive} runs in a row`
      : `${f.product} read high on disk once — confirming on the next run`,
    summary: confirmed
      ? `${f.product} has measured at or above ${WARN_MB_S} MB/s of sustained disk traffic on ${consecutive} consecutive monitor runs (latest ${f.mbs} MB/s: ${f.detail}). That is roughly ${consecutive - 1} hour(s) of held load, not a burst. The line sits at ${WARN_MB_S} MB/s because that is above this fleet's measured p99 of 6.27 MB/s and at/above the 7.74 MB/s at which Supabase itself sent a Disk IO warning for ScoutCopilot on 2026-08-29.`
      : `${f.product} measured ${f.mbs} MB/s of disk traffic in one 180-second sample (${f.detail}). Filed but NOT alerted: one sample is not a sustained problem — the same fleet routinely swings by a factor of four between runs with nothing wrong. If the next monitor run finds it over the line again, this escalates and is allowed to ring.`,
    detail: { ...f, consecutive, confirmed, warnLine: WARN_MB_S, failLine: FAIL_MB_S },
  })
}

/**
 * Rows to close: a machine that has an open disk signal and is no longer over the line. Without
 * this the check only ever ADDS rows — which is exactly how ten "is wearing out its disk
 * allowance" rows accumulated on the board for machines that had long since gone quiet, and why
 * "self-resolved" on the cockpit has to be a fact about the fleet rather than an artefact of
 * whether anybody happened to tidy up. Same shape as check-products-down.mjs's recovery path.
 */
export function recoveredKeys(openKeys, measuredFindings) {
  const quietNow = new Set(
    (measuredFindings ?? []).filter((f) => f.level === 'ok').map((f) => diskKey(f.product)),
  )
  // A row is closed ONLY when this run took a reading for that exact machine and the reading was
  // under the line. A machine that came back unreadable, or that this run never sampled at all,
  // keeps its open row: "we did not look" is not "it recovered", and closing on absence is how a
  // watchdog turns its own blind spot into a clean bill of health.
  return [...(openKeys ?? [])].filter((k) => k.startsWith('supabase-disk:') && quietNow.has(k))
}

export function recoverySignal(key) {
  return {
    source: 'production-monitor', key, kind: 'incident', severity: 'info', state: 'resolved',
    title: `${key.slice('supabase-disk:'.length)} is back under its disk line`,
    summary: `Its sustained disk traffic is below ${WARN_MB_S} MB/s again. This cleared without anyone doing anything, which is what a burst does.`,
    link: 'https://cockpit.predivo.ch/signals',
  }
}

/**
 * Blind rows to close: a machine that had an open `supabase-disk-blind:` row and was READ again
 * this run. Any readable level clears it — a machine reading high on disk is no longer BLIND, it
 * has a disk-LOAD row of its own. Guarded on genuine re-measurement exactly like recoveredKeys():
 * a machine still unreadable, or one this run never sampled at all, keeps its open row, because
 * "we did not look" is not "it recovered" and closing on absence turns a blind spot into a clean
 * bill of health. This is the recovery path the aggregate `supabase-disk-blind` row never had —
 * why the ARIVIOO/JASSTOUR transients could file but never self-clear.
 */
export function recoveredBlindKeys(openKeys, measuredFindings) {
  const readableNow = new Set(
    (measuredFindings ?? []).filter((f) => f.level !== 'unreadable').map((f) => blindKey(f.product)),
  )
  return [...(openKeys ?? [])].filter((k) => k.startsWith('supabase-disk-blind:') && readableNow.has(k))
}

export function blindRecoverySignal(key) {
  const product = key.slice(`${LEGACY_BLIND_KEY}:`.length)
  return {
    source: 'production-monitor', key, kind: 'incident', severity: 'info', state: 'resolved',
    title: `The Supabase disk watchdog can read ${product} again`,
    summary: `${product}'s metrics endpoint returned a usable disk reading again, so its watchdog is no longer blind. This cleared on a re-read, which is what a transient scrape miss does.`,
    link: 'https://cockpit.predivo.ch/signals',
  }
}

/**
 * Supersede the one aggregate `supabase-disk-blind` row this check filed before blindness was
 * tracked per machine. No run writes that key any more, so without an explicit resolve it stands
 * open forever; the per-machine rows now carry the true, debounced, self-clearing state.
 */
export function legacyBlindRecoverySignal() {
  return {
    source: 'production-monitor', key: LEGACY_BLIND_KEY, kind: 'incident', severity: 'info', state: 'resolved',
    title: 'The fleet-wide "disk watchdog is blind" row is superseded by per-machine rows',
    summary: `Blindness is now tracked per machine under ${blindKey('<product>')} keys, each of which pages only after the SAME machine is unreadable on two consecutive runs and self-clears when it reads again. This single aggregate row could neither debounce a one-run transient nor recover, which is what filed a paging critical for ARIVIOO (fine 12 of the prior 13 runs). Resolved in favour of the granular rows.`,
    link: 'https://cockpit.predivo.ch/signals',
  }
}

const BO_BASE = 'https://xoecpzfsskalvjrtcbbl.supabase.co'

async function boGet(secret, path) {
  const res = await fetch(`${BO_BASE}/rest/v1/${path}`, {
    headers: { apikey: secret, Authorization: `Bearer ${secret}`, 'User-Agent': 'supabase-watchdog/1.0' },
  })
  if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`)
  return res.json()
}

if (process.argv[1] && process.argv[1].endsWith('check-supabase-machine-health.mjs')) {
  // One invisible character in a key blinds this check without ever naming the key. On
  // 2026-09-01 a UTF-8 BOM on JASSTOUR_SERVICE_ROLE_KEY made the metrics request unsendable,
  // sample() caught the throw, and the run reported "UNREADABLE JASSTOUR — metrics endpoint
  // returned no usable sample": honest, and completely unactionable. Repaired here and named in
  // the log so the cause is visible. See lib/credentials.mjs for the incident.
  //
  // Inside the CLI guard, not at module scope: the unit tests import discover()/checkMachines()
  // and must not have the real process.env rewritten underneath them as a side effect of an
  // import. main() reads process.env after this line, so the repair still reaches it.
  sanitizeEnvAndReport()

  // Coverage floor: what discover() actually saw this run, compared against the written-down
  // expectation. A product with no *_SUPABASE_URL/key in this run's environment at all never
  // reaches checkMachines() — it has no target to sample — so without this comparison it leaves
  // no trace whatsoever, which is the exact "Jass-Tour" gap the 2026-09-01 board item names.
  const baseline = productionOnly(loadBaseline())
  const discovered = discover()
  const gaps = coverageGaps(discovered, baseline)

  // Say out loud when two secret names turned out to be one database, so "12 machines" becoming
  // "11 machines" is never a silent drop somebody has to reverse-engineer from a diff.
  for (const t of discovered.filter((d) => d.aliases?.length)) {
    console.log(`NOTE        ${t.product.padEnd(20)} also wired as ${t.aliases.join(', ')} — same project ${t.ref}, counted once`)
  }

  const findings = [...await checkMachines(), ...missingFindings(gaps)]
  for (const f of findings) console.log(`${String(f.level).toUpperCase().padEnd(11)} ${String(f.product).padEnd(20)} ${f.detail}`)
  const loud = findings.filter((f) => f.level === 'fail' || f.level === 'warn')
  const blind = findings.filter((f) => f.level === 'unreadable')
  console.log(`${findings.length} machines checked, ${loud.length} over the line, ${blind.length} unreadable`)
  console.log(coverageLine(gaps, baseline, 'watched'))

  // The finding goes on the board Roger actually opens, not only into a red workflow run.
  // send-alert.mjs reads Playwright's results.json, so a bare exit(1) here would have sent an
  // alert email listing ZERO failures while the real fact appeared nowhere a person looks.
  // Same contract as every neighbouring sensor in monitor.yml: a filed alarm exits 0, and only
  // a failed READ exits non-zero, so one event is never double-reported.
  // BOTH the over-the-line path AND the blindness path file a board row on the FIRST sighting and
  // are allowed to page only on the second consecutive one. The previous run's count is read back
  // off the board, which is the only durable store this check has: the runner is ephemeral, so
  // there is nowhere else a count could survive between runs. Recovered machines — over-the-line
  // AND blind — are resolved in the same pass, so the board reflects the fleet rather than the
  // history of everything that ever spiked or ever missed a scrape.
  const measured = findings.filter((f) => f.level !== 'unreadable')
  if (findings.length) {
    const dry = process.argv.includes("--dry")
    // --dry still READS the board. The read is what decides warning-vs-page, so a preview that
    // skipped it would preview the wrong decision for every machine — which is the whole thing
    // being tested when somebody runs --dry. Only the writes below are suppressed.
    const secret = boardSecret()

    // Read BEFORE writing (once this run files, every key looks "already open") the WHOLE
    // supabase-disk* family in one query: the disk-LOAD rows (supabase-disk:*), the per-machine
    // blind rows (supabase-disk-blind:*), and the legacy aggregate (supabase-disk-blind).
    // `like.supabase-disk*` is SQL LIKE 'supabase-disk%', which matches all three.
    let openRows = []
    try {
      openRows = await boGet(secret, `fleet_signals?source=eq.production-monitor&key=like.supabase-disk*&state=eq.open&select=key,detail`)
    } catch (e) {
      // A board read failure must not silently downgrade every machine to "first sighting" — that
      // would switch the pager off for a genuinely sustained breach (load OR blindness) and read
      // as normal. Both paths fall back to first-sighting warnings below; the run still reds via
      // exitCode/exit(1), so nothing goes silently green.
      console.error(`::error::could not read the open disk signals, so this run cannot tell a first sighting from a sustained one: ${e.message}`)
      process.exitCode = 1
      openRows = null
    }
    const priorByKey = new Map((openRows ?? []).map((r) => [r.key, r]))

    // disk-LOAD: page only on the second consecutive run over the line.
    for (const f of loud) {
      const { consecutive, confirmed } = escalation(priorByKey.get(diskKey(f.product)))
      const row = diskSignal(f, { confirmed, consecutive })
      if (dry) { console.log("[dry] would file: " + row.key + " / " + row.severity + " / " + row.title); continue }
      await fileSignal(secret, row)
      console.log(`filed to the cockpit signals board: ${f.product} (run ${consecutive} over the line, ${confirmed ? 'CONFIRMED — may page' : 'unconfirmed — no page'})`)
    }

    // BLINDNESS: the same debounce. A first unreadable sighting of a machine is a WARNING nobody
    // is woken for; only the SAME machine unreadable on two consecutive runs may page. Every blind
    // run is still red (the exit below), so safety is preserved — only the 03:00 PAGE waits for
    // confirmation. This is the ARIVIOO/JASSTOUR one-run-transient fix.
    for (const f of blind) {
      const { consecutive, confirmed } = escalation(priorByKey.get(blindKey(f.product)))
      const row = blindSignalFor(f, { confirmed, consecutive })
      if (dry) { console.log("[dry] would file: " + row.key + " / " + row.severity + " / " + row.title); continue }
      try {
        await fileSignal(secret, row)
        console.log(`filed to the cockpit signals board: ${row.key} (run ${consecutive} blind, ${confirmed ? 'CONFIRMED — may page' : 'unconfirmed — no page'})`)
      } catch (e) {
        console.error(`::error::could not file the blind finding to the board: ${e.message}`)
      }
    }

    // Only resolve what is genuinely open and genuinely re-measured this run. Never blanket-resolve:
    // a row closed without its claim being re-measured is the same lie as a row opened without one.
    if (openRows) {
      // disk-LOAD recoveries: needs a reading UNDER the line this run.
      for (const key of recoveredKeys(priorByKey.keys(), measured)) {
        if (dry) { console.log(`[dry] would resolve: ${key}`); continue }
        await fileSignal(secret, recoverySignal(key))
        console.log(`recovered: ${key} — signal resolved (measured under ${WARN_MB_S} MB/s this run).`)
      }
      // BLINDNESS recoveries: a machine we could READ again this run — the path the old aggregate
      // row never had, so a transient could file but never self-clear.
      for (const key of recoveredBlindKeys(priorByKey.keys(), measured)) {
        if (dry) { console.log(`[dry] would resolve: ${key}`); continue }
        await fileSignal(secret, blindRecoverySignal(key))
        console.log(`recovered: ${key} — blind signal resolved (read a usable sample this run).`)
      }
      // One-time migration: supersede the single aggregate row no run writes any more, so the
      // pre-fix `supabase-disk-blind` incident self-clears in favour of the per-machine rows.
      if (priorByKey.has(LEGACY_BLIND_KEY)) {
        if (dry) { console.log(`[dry] would resolve: ${LEGACY_BLIND_KEY} (superseded by per-machine rows)`) }
        else {
          await fileSignal(secret, legacyBlindRecoverySignal())
          console.log(`recovered: ${LEGACY_BLIND_KEY} — superseded by per-machine blind rows.`)
        }
      }
    }
  }
  // A machine we could not read is not a clean bill of health, so this reds the run regardless of
  // whether it paged. The filing above never converts it to green; this is the safety floor that
  // the per-machine page debounce is deliberately built on top of, not in place of.
  if (blind.length) {
    console.error(`::error::${blind.length} Supabase machine(s) could not be read — that is not an all-clear: ${blind.map((f) => f.product).join(', ')}`)
    process.exit(1)
  }

  // exitDecision() owns the "this run learned NOTHING" case and is unit-tested, but 986d205
  // rewrote this block to compute loud/blind inline and stopped calling it — so the guard it
  // exists for silently left the product while its test kept passing. If every *_SUPABASE_URL
  // secret were renamed or dropped, discover() returns [], findings is empty, loud and blind
  // are both 0, and the run printed "0 machines checked" and exited GREEN: the exact
  // false all-clear this file was written to prevent. Re-wired to the tested policy.
  if (!findings.length) {
    const d = exitDecision(findings)
    console.error(d.message)
    process.exit(d.code)
  }
}
