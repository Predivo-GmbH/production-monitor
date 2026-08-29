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

const WARN_MB_S = 2.0   // sustained OS-disk traffic; the quiet fleet sits at 0.06-0.5
const FAIL_MB_S = 4.0   // ScoutCopilot was 7.74 when Supabase complained
const SAMPLE_GAP_MS = 30_000

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
  for (const f of findings) console.log(`${f.level.toUpperCase().padEnd(10)} ${f.product.padEnd(18)} ${f.detail}`)
  const bad = findings.filter((f) => f.level === 'fail')
  const warn = findings.filter((f) => f.level === 'warn')
  const unreadable = findings.filter((f) => f.level === 'unreadable')
  console.log(`\n${findings.length} machines checked · ${bad.length} over ${FAIL_MB_S} MB/s · ${warn.length} over ${WARN_MB_S} MB/s · ${unreadable.length} unreadable`)
  // process.exitCode (not process.exit) so a pending fetch cannot crash the exit.
  const decision = exitDecision(findings)
  if (decision.message) console.error(decision.message)
  process.exitCode = decision.code
}
