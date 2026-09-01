/**
 * Edge-function reachability via auto-discovery.
 *
 * WHY: hardcoding the list of edge functions per project drifts the moment a
 * function is added or removed — a removed function left in the list produces a
 * permanent false 404 alarm (exactly what happened with ChannelMover's extension
 * retirement). Instead we ask Supabase what is ACTUALLY deployed and check each
 * one responds. Add/remove a function and the monitor follows automatically — no
 * spec edit, no drift.
 */

import { findTokenForProject, managementTokenKeys } from './supabaseToken'

/** Extract the Supabase project ref from its URL (https://<ref>.supabase.co). */
export function projectRefFromUrl(supabaseUrl: string): string {
  const host = new URL(supabaseUrl).hostname
  const ref = host.split('.')[0]
  if (!ref) throw new Error(`Cannot derive project ref from ${supabaseUrl}`)
  return ref
}

async function fetchFunctions(projectRef: string, accessToken: string) {
  return fetch(`https://api.supabase.com/v1/projects/${projectRef}/functions`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
}

/** A refusal of the TOKEN, as opposed to anything about the project itself. */
const isTokenRefused = (status: number) => status === 401 || status === 403

/**
 * List the slugs of every edge function currently deployed to a project.
 *
 * `accessToken` is the token the caller believes owns this project. If it is
 * missing or refused, we do NOT go red on that alone — a token name is a guess
 * about account ownership and guesses go stale (see lib/supabaseToken.ts: a
 * pinned 401 here reddened the monitor hourly from 2026-08-27 while a working
 * token for the same project sat unused in the same environment). We ask the
 * other management tokens who actually owns the project and carry on, loudly.
 */
export async function listDeployedFunctions(
  projectRef: string,
  accessToken: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  let res = accessToken ? await fetchFunctions(projectRef, accessToken) : undefined

  if (!res || isTokenRefused(res.status)) {
    const pinnedKey = accessToken
      ? managementTokenKeys(env).find((k) => env[k] === accessToken)
      : undefined
    const fallback = await findTokenForProject(projectRef, env, pinnedKey)
    if (!fallback) {
      const why = res
        ? `the token it was given returned HTTP ${res.status}`
        : 'it was given no token'
      throw new Error(
        `listDeployedFunctions(${projectRef}) failed: ${why}, and no other Supabase ` +
          `management token in this environment can see that project. Either the project ` +
          `ref is stale or its account's token was never added as a secret — both need a person.`,
      )
    }
    console.warn(
      `[supabase] ${projectRef}: ${pinnedKey ?? 'the pinned token'} is no longer accepted ` +
        `for this project; used ${fallback.key} instead. The pinned name should be repaired.`,
    )
    res = await fetchFunctions(projectRef, fallback.token)
  }

  if (!res.ok) {
    throw new Error(
      `listDeployedFunctions(${projectRef}) failed: HTTP ${res.status} ${await res.text()}`,
    )
  }
  const data = (await res.json()) as Array<{ slug?: string }>
  if (!Array.isArray(data)) {
    throw new Error(`listDeployedFunctions(${projectRef}) returned non-array`)
  }
  return data.map((f) => f.slug).filter((s): s is string => Boolean(s))
}

/**
 * Supabase's platform answer when a slug has NO deployment at all. A booted
 * function that happens to answer 404 never produces this shape.
 * Verified live 2026-08-20: POST /functions/v1/nonexistent-fn-xyz ->
 * {"code":"NOT_FOUND","message":"Requested function was not found"}
 */
function isPlatformNotFound(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { code?: unknown; message?: unknown }
    if (parsed?.code === 'NOT_FOUND') return true
  } catch {
    // not JSON — cannot be the platform shape
  }
  return /Requested function was not found/i.test(body)
}

/**
 * Cap how many probes are in flight at once, ACROSS every caller in the run.
 *
 * WHY: each spec probes its project with `Promise.all(deployed.map(...))`, so a
 * 41-function project fires 41 simultaneous POSTs at cold isolates. Supabase's
 * edge runtime sheds that boot storm with 503s on an arbitrary subset — Valrano
 * reddened the monitor on 2026-08-24 with 15 functions "down" on the first
 * attempt and a DIFFERENT 5 on the retry, while all 20 answered 401 (healthy)
 * when probed one at a time seconds later. A real outage fails the same
 * functions every time; a boot storm fails a different lottery each time.
 *
 * The gate is module-level (not per-call) because Playwright runs 3 workers in
 * one process — two projects probing at once would otherwise double the burst.
 */
const MAX_CONCURRENT_PROBES = 8
let activeProbes = 0
const probeQueue: Array<() => void> = []

async function withProbeSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeProbes >= MAX_CONCURRENT_PROBES) {
    await new Promise<void>((resolve) => probeQueue.push(resolve))
  }
  activeProbes++
  try {
    return await fn()
  } finally {
    activeProbes--
    probeQueue.shift()?.()
  }
}

/** Total attempts before a 5xx is believed, and the backoff before each retry. */
const PROBE_ATTEMPTS = 3
const PROBE_BACKOFF_MS = [800, 2000]
/** Per-request cap so one hung function cannot burn the whole 60s test timeout. */
const PROBE_TIMEOUT_MS = 8_000
/**
 * Stop RETRYING (never stop reporting) once the probe phase has run this long.
 * The spec's Playwright timeout is 60s; if the whole fleet hangs, three attempt
 * rounds would blow past it and the run would die as a bare timeout with no list
 * of what was down. Past the budget we report the last answer we actually got.
 */
const PROBE_BUDGET_MS = 40_000

/**
 * Deadline for the CURRENT burst, shared by every function in it — a per-call
 * budget would not bound the total, since 41 calls through 8 slots is ~5 waves
 * of it. Re-anchored whenever a burst starts from idle (no probe in flight and
 * none queued), so each spec's probe test gets its own full budget rather than
 * inheriting an exhausted clock from the project probed minutes earlier.
 */
let burstDeadline = 0

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type ProbeAttempt = { status: number; body: string }

/** One POST. status 0 means the request never completed (timeout / network). */
async function probeOnce(supabaseUrl: string, slug: string): Promise<ProbeAttempt> {
  return withProbeSlot(async () => {
    try {
      const res = await fetch(`${supabaseUrl}/functions/v1/${slug}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      })
      // Only 404 and 5xx need the body; reading it for every 401 is wasted time.
      const body =
        res.status === 404 || res.status >= 500 ? await res.text().catch(() => '') : ''
      return { status: res.status, body }
    } catch (err) {
      return { status: 0, body: err instanceof Error ? err.message : String(err) }
    }
  })
}

/**
 * POST to a function and report whether it is healthy. 401/403/400/422 without
 * auth/body are fine (the function booted and rejected us). A 5xx that SURVIVES
 * every retry means the function is DOWN — a crashed function, a dead edge
 * secret, or a BOOT_ERROR all surface as 5xx, and "reachable = not 404" let
 * every one of those pass for weeks (ReplyFlow post-reply 503 x2 days,
 * ChannelMover SB_SECRET_KEY x5 days — see
 * Audits/BREAKAGE_ROOT_CAUSE_INVESTIGATION_2026-07-14.md section 8).
 *
 * A SINGLE 5xx proves nothing, which is why we retry: a genuinely broken
 * function fails all PROBE_ATTEMPTS, while a cold-start 503 answers on the next
 * one. That distinction is the whole alarm — it must stay sharp in both
 * directions, so we neither ignore 5xx nor trust the first one.
 *
 * A bare 404 is AMBIGUOUS and must not be failed on its own: functions that route
 * on a query param or path segment answer our empty probe with their OWN 404
 * (BackOffice client-project-steps + client-open-items resolve ?p=<slug> and
 * return {"error":"Not found"} for the empty probe — both fully deployed and
 * healthy, yet they reddened the monitor on 2026-08-20). Only the platform's
 * NOT_FOUND body proves a function is missing, so that is what we key on.
 */
/**
 * `exercised` added 2026-09-01 by the monitoring audit. A 401/403 means the GATEWAY answered and
 * the function was never invoked, so its boot health is unknown - the same distinction that let a
 * keyless /auth/v1/health probe report a dead auth service as healthy for twenty hours that day.
 *
 * Measured across the fleet before adding this: nearly every function declares `verify_jwt = false`
 * in its project's supabase/config.toml (ReplyFlow 41 of 41, ChannelMover 35, Valrano 41,
 * ScoutCopilot 16, BackOffice 37), so the keyless probe really does reach them and a crash really
 * does surface as 5xx. The exception is Distribution-OS, where stripe-checkout, stripe-portal,
 * call-ai and save-api-key default to verify_jwt = true. Measured on that project: stripe-portal
 * answers 401 both keyless AND with the publishable key, while send-auth-email (verify_jwt=false)
 * answers 400 either way. So sending a key does NOT fix it; only a real JWT would, and the monitor
 * deliberately does not hold credentials that would let it invoke a payment endpoint for real.
 *
 * So this reports the truth instead of hiding it: those functions are not counted as failures,
 * because nothing is known to be wrong, and they are not counted as proven either.
 */
export async function isFunctionReachable(
  supabaseUrl: string,
  slug: string,
): Promise<{ slug: string; status: number; reachable: boolean; exercised: boolean; detail?: string }> {
  let last: ProbeAttempt = { status: 0, body: 'no attempt made' }
  let made = 0

  if (activeProbes === 0 && probeQueue.length === 0) {
    burstDeadline = Date.now() + PROBE_BUDGET_MS
  }

  for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt++) {
    // Out of budget: keep the answer we have rather than risk a bare test timeout.
    if (attempt > 0 && Date.now() > burstDeadline) break
    if (attempt > 0) await sleep(PROBE_BACKOFF_MS[attempt - 1] ?? 2000)
    last = await probeOnce(supabaseUrl, slug)
    made++

    // Anything that is not a 5xx and not a failed request is a definitive answer.
    if (last.status !== 0 && last.status < 500) {
      if (last.status !== 404) {
        const gatewayRejected = last.status === 401 || last.status === 403
        return {
          slug,
          status: last.status,
          reachable: true,
          exercised: !gatewayRejected,
          ...(gatewayRejected
            ? { detail: 'the gateway rejected the probe before the function ran, so its boot health is unknown' }
            : {}),
        }
      }
      if (!isPlatformNotFound(last.body)) return { slug, status: 404, reachable: true, exercised: true }
      return {
        slug,
        status: 404,
        reachable: false,
        exercised: false,
        detail: 'no deployment for this slug (platform NOT_FOUND)',
      }
    }
  }

  // Every attempt was a 5xx or a dead request — believe it, and say WHY. The body
  // is what tells a BOOT_ERROR apart from a resource limit; the 2026-08-24 alarm
  // reported bare "503" and cost a full diagnosis round to establish which it was.
  return {
    slug,
    exercised: true,
    status: last.status,
    reachable: false,
    detail: `${made}x ${last.status || 'request failed'}, last body: ${last.body.slice(0, 200) || '(empty)'}`,
  }
}
