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

const WARN_MB_S = Number(process.env.DISK_WARN_MB_S || 2.0)   // sustained OS-disk traffic; the quiet fleet sits at 0.06-0.5
const FAIL_MB_S = Number(process.env.DISK_FAIL_MB_S || 4.0)   // ScoutCopilot was 7.74 when Supabase complained
const SAMPLE_GAP_MS = 180_000  // Supabase refreshes these counters on its own scrape interval.
                               // At 30s BOTH samples read identical values and every machine
                               // scored a perfect 0.00 MB/s, i.e. a false all-clear across the
                               // whole fleet. 3 minutes is comfortably longer than the refresh.

// The label block is OPTIONAL: node_vmstat_pgmajfault and node_memory_MemTotal_bytes are
// exposed WITHOUT labels, while node_disk_*_bytes_total carry a {device="..."} block. The
// braces and \s MUST be regex-escaped — a single-quoted JS literal '\{' is just '{' and '\s'
// is a bare 's', which silently compiles to a pattern that matches nothing (the 2026-08-29
// bug where every machine read as 'unreadable' and the check went green forever).
export const metricValue = (text, name) => {
  const m = text.match(new RegExp('^' + name + '(\\{[^}]*\\})?\\s+([0-9.e+-]+)', 'm'))
  return m ? Number(m[2]) : null
}

async function sample(ref, key) {
  const res = await fetch(`https://${ref}.supabase.co/customer/v1/privileged/metrics`, {
    headers: { Authorization: 'Basic ' + Buffer.from('service_role:' + key).toString('base64') },
  })
  if (!res.ok) return null
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
  return prefixes.map((p) => {
    const ref = refFromUrl(env[`${p}_SUPABASE_URL`])
    const key = env[`${p}_SECRET_KEY`] || env[`${p}_SERVICE_ROLE_KEY`]
    const reason = !key ? 'no key configured' : !ref ? 'no usable project ref in the URL' : null
    return { product: p, ref, key, reason }
  })
}

export async function checkMachines(env = process.env) {
  const findings = []
  const targets = []
  for (const t of discover(env)) {
    if (t.reason) findings.push({ product: t.product, level: 'unreadable', detail: t.reason })
    else targets.push(t)
  }

  const first = await Promise.all(targets.map((t) => sample(t.ref, t.key).catch(() => null)))
  await new Promise((r) => setTimeout(r, SAMPLE_GAP_MS))
  const second = await Promise.all(targets.map((t) => sample(t.ref, t.key).catch(() => null)))

  targets.forEach((t, i) => {
    const a = first[i], b = second[i]
    // A machine we cannot read is reported, not silently skipped: a check that goes quiet
    // when it loses access reads as "all clear", which is the failure mode this file exists for.
    if (!a || !b || a.read == null || b.read == null) {
      findings.push({ product: t.product, level: 'unreadable', detail: 'metrics endpoint returned no usable sample' })
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

if (process.argv[1] && process.argv[1].endsWith('check-supabase-machine-health.mjs')) {
  const findings = await checkMachines()
  for (const f of findings) console.log(`${String(f.level).toUpperCase().padEnd(11)} ${String(f.product).padEnd(20)} ${f.detail}`)
  const loud = findings.filter((f) => f.level === 'fail' || f.level === 'warn')
  const blind = findings.filter((f) => f.level === 'unreadable')
  console.log(`${findings.length} machines checked, ${loud.length} over the line, ${blind.length} unreadable`)

  // The finding goes on the board Roger actually opens, not only into a red workflow run.
  // send-alert.mjs reads Playwright's results.json, so a bare exit(1) here would have sent an
  // alert email listing ZERO failures while the real fact appeared nowhere a person looks.
  // Same contract as every neighbouring sensor in monitor.yml: a filed alarm exits 0, and only
  // a failed READ exits non-zero, so one event is never double-reported.
  if (loud.length) {
    const dry = process.argv.includes("--dry")
    const secret = dry ? null : boardSecret()
    for (const f of loud) {
      const row = signal({
        key: `supabase-disk:${f.product}`,
        product: f.product,
        severity: f.level === 'fail' ? 'critical' : 'warning',
        needsHuman: f.level === 'fail',
        title: `${f.product} is wearing out its disk allowance`,
        summary: `${f.product} is moving ${f.mbs} MB/s of disk continuously (${f.detail}). The quiet fleet sits between 0.06 and 1.67 MB/s. ScoutCopilot was at 7.74 MB/s when Supabase emailed a Disk IO warning on 2026-08-29; that time the cause was an out-of-date Supabase platform build and the free upgrade fixed it.`,
        detail: f,
      })
      if (dry) { console.log("[dry] would file: " + row.key + " / " + row.severity + " / " + row.title); continue }
      await fileSignal(secret, row)
      console.log(`filed to the cockpit signals board: ${f.product}`)
    }
  }
  // A machine we could not read is not a clean bill of health, and unlike an over-threshold
  // finding there is nothing to file about it, so this one does red the run.
  if (blind.length) { console.error(`::error::${blind.length} Supabase machine(s) could not be read — that is not an all-clear`); process.exit(1) }
}
