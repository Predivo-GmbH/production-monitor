#!/usr/bin/env node
/**
 * The GitHub REST allowance is one shared pool, and until now nothing watched it.
 *
 * WHY (2026-08-27): every token on the account draws on ONE 5,000-requests-per-hour core
 * allowance (account `Predivo-GmbH`, user id 251853205). On 2026-08-27 something drained it to
 * 0/5000 twice in one afternoon and the account started REFUSING our own work — a Cockpit
 * production promotion could not be dispatched and `gh run watch` died mid-watch with HTTP 403
 * "API rate limit exceeded for user ID 251853205". The FIRST anyone knew was the refused deploy,
 * because the only thing watching GitHub was `check-ci-budget` and it watches the MONEY (the
 * Actions bill), not the request quota. The dominant consumer is our own `gh run watch` polling
 * (default 3s interval, ~40 core calls/min per watch) across the concurrent agent sessions —
 * 443 invocations counted across the session transcripts on 2026-08-27.
 *
 * WHAT THIS DOES: once an hour, inside the existing production monitor, read `.resources.core`
 * (the /rate_limit endpoint is FREE — it does not itself consume the allowance) and file a
 * signal when the pool is exhausted or is on track to exhaust before the window resets. So a
 * runaway consumer surfaces on the cockpit within the hour instead of via a refused deploy.
 *
 * It reuses the hourly monitor and the signal path — NO new scheduled job and NO new
 * healthchecks check (the primary healthchecks account is at its 20-of-20 free ceiling).
 *
 * The source is `github-api-budget`, which deliberately has no `signal_page_policy` row, so the
 * first signal it files lands on /signals under "nobody ever decided whether these may alert
 * you" and does NOT ring Roger's phone until he chooses — the house default-nobody-chose rule.
 *
 * Contract:  node scripts/check-github-api-budget.mjs [--dry]
 *   env: GH_TOKEN  a PAT on the shared account (DASHBOARD_PAT in CI). Locally falls back to
 *                  `gh auth token`. We measure the USER pool on purpose — that is what runs dry.
 *        BOARD_SUPABASE_SECRET or BACKOFFICE_SERVICE_ROLE_KEY  to file the signal.
 * Exit 0 = judged (healthy or alarm filed). Exit 1 = could not tell, which is never "fine".
 */
import { readFileSync } from 'fs'
import { execSync } from 'child_process'

const BO_REF = 'xoecpzfsskalvjrtcbbl'
const BO_BASE = `https://${BO_REF}.supabase.co`
const BO_CREDS = 'C:\\Business\\Internal Projects\\BackOffice\\docs\\Credentials.txt'
const NON_BROWSER_UA = 'github-api-budget-producer/1.0'
const SOURCE = 'github-api-budget'
const RATE_URL = 'https://api.github.com/rate_limit'

function readBoSecret() {
  if (process.env.BOARD_SUPABASE_SECRET) return process.env.BOARD_SUPABASE_SECRET.trim()
  if (process.env.BACKOFFICE_SERVICE_ROLE_KEY) return process.env.BACKOFFICE_SERVICE_ROLE_KEY.trim()
  const txt = readFileSync(BO_CREDS, 'utf-8')
  const m = txt.match(/sb_secret_[A-Za-z0-9_]+/)
  if (!m) throw new Error(`no sb_secret_ key found in ${BO_CREDS}`)
  return m[0]
}

function readToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN.trim()
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim()
  try { return execSync('gh auth token', { encoding: 'utf-8' }).trim() } catch { /* fall through */ }
  throw new Error('no GH_TOKEN and `gh auth token` unavailable — cannot read the shared allowance')
}

/**
 * The whole decision, pure and testable. Given the core resource block from /rate_limit and the
 * current time, decide whether the shared allowance is healthy, at risk, or already dead.
 *
 *   - exhausted   remaining is 0 with real time still on the clock — work is being REFUSED now.
 *   - draining    on track to hit 0 before the window resets (projected use over the ceiling),
 *                 once enough of the window has passed for the projection to mean anything.
 *   - low         a large slice already gone but not yet projected to blow the ceiling.
 *   - healthy     nothing to say.
 *
 * The early-window guard matters: right after the top-of-hour reset a mere 200 calls in the
 * first 30s projects to a wild number. We refuse to project until both a floor of the window has
 * elapsed AND an absolute floor of calls has been spent, so a normal burst never cries wolf.
 */
export function judgeQuota(core, now = Date.now()) {
  const { limit = 5000, remaining = 0, used = limit - remaining, reset } = core || {}
  const resetMs = (reset || 0) * 1000
  const secsToReset = Math.max(0, Math.round((resetMs - now) / 1000))
  const WINDOW = 3600
  const elapsed = Math.min(WINDOW, Math.max(0, WINDOW - secsToReset))
  const fracElapsed = elapsed / WINDOW
  const base = { limit, remaining, used, secsToReset, source: SOURCE }

  // Already at zero with more than a couple minutes to wait: this is the refused-deploy state.
  if (remaining <= 0 && secsToReset > 120) {
    return { ...base, verdict: 'exhausted', severity: 'critical',
      title: 'GitHub API allowance is fully spent — our own deploys are being refused',
      summary: `The shared 5,000/hour GitHub allowance is at 0 with ${Math.round(secsToReset / 60)} min until it resets. While it is empty, dispatching deploys and watching workflow runs fail with "rate limit exceeded". The usual cause is our own \`gh run watch\` polling across concurrent agent sessions — wait and \`gh run view <id>\` once instead of watching.` }
  }

  // A FLOOR THAT NEEDS NO PROJECTION (2026-09-01 audit). Both alarm branches below are gated on
  // `canProject`, which refuses to speak in the first six minutes of the window or under 1,500
  // calls spent. That guard is right about PROJECTIONS and wrong as a gate on the whole judgement:
  // a burst that drains 4,900 calls in the first four minutes has fracElapsed 0.07, reaches
  // neither branch, is not yet at zero, and is therefore reported healthy - after which main()
  // files a `resolved` signal that clears whatever the previous hour raised. The fast burst is the
  // incident this file was written for. Nothing here is a projection: this little left, this far
  // from the reset, is the refused-deploy state in all but name whatever the clock says.
  const floor = Math.round(limit * 0.05)
  if (remaining <= floor && secsToReset > 120) {
    return { ...base, verdict: 'draining', severity: 'critical',
      title: 'GitHub API allowance is almost gone',
      summary: `${used} of ${limit} calls are spent with ${Math.round(secsToReset / 60)} min still to run in the window and only ${remaining} left. It will start refusing deploys before it resets. The usual cause is our own \`gh run watch\` polling across concurrent sessions - wait and \`gh run view <id>\` once instead of watching.` }
  }

  // Only project once the window has run far enough and enough has been spent for it to mean
  // something — otherwise a normal post-reset burst projects to nonsense.
  const canProject = fracElapsed >= 0.1 && used >= 1500
  const projectedUse = canProject ? Math.round(used / Math.max(fracElapsed, 0.01)) : used

  if (canProject && projectedUse >= limit && remaining < 1500) {
    return { ...base, verdict: 'draining', severity: 'critical', projectedUse,
      title: 'GitHub API allowance is on track to run out this hour',
      summary: `${used} of ${limit} calls already spent with ${Math.round(secsToReset / 60)} min left in the window — at this pace it projects to ~${projectedUse}, over the ceiling, and will start refusing deploys before it resets. Most of this is our own \`gh run watch\` polling across concurrent sessions.` }
  }

  if (canProject && projectedUse >= limit * 0.9) {
    return { ...base, verdict: 'low', severity: 'warning', projectedUse,
      title: 'GitHub API allowance is being spent faster than the hour can refill it',
      summary: `${used} of ${limit} calls spent with ${Math.round(secsToReset / 60)} min left — projects to ~${projectedUse}, close to the ceiling. Worth checking what is polling.` }
  }

  return { ...base, verdict: 'healthy', severity: 'info',
    title: 'GitHub API allowance is healthy',
    summary: `${remaining} of ${limit} left, ${Math.round(secsToReset / 60)} min to reset.` }
}

async function fetchCore(token) {
  const res = await fetch(RATE_URL, {
    headers: { Authorization: `token ${token}`, 'User-Agent': NON_BROWSER_UA, Accept: 'application/vnd.github+json' },
  })
  if (!res.ok) throw new Error(`GET /rate_limit -> HTTP ${res.status}`)
  const body = await res.json()
  const core = body?.resources?.core
  if (!core) throw new Error('rate_limit response had no resources.core')
  return core
}

function signalFor(j) {
  return {
    source: SOURCE,
    key: 'core-allowance',
    kind: 'incident',
    severity: j.severity,
    state: 'open',
    needs_human: true,
    title: j.title,
    summary: j.summary,
    detail: { limit: j.limit, remaining: j.remaining, used: j.used, secsToReset: j.secsToReset, projectedUse: j.projectedUse, verdict: j.verdict },
    link: 'https://cockpit.predivo.ch/signals',
  }
}

async function fileSignal(secret, body) {
  const res = await fetch(`${BO_BASE}/functions/v1/signal-intake`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', 'User-Agent': NON_BROWSER_UA },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`signal-intake -> HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`)
  return res.json()
}

async function main() {
  const dry = process.argv.includes('--dry')
  const core = await fetchCore(readToken())
  const j = judgeQuota(core)
  console.log(`github core allowance: ${j.remaining}/${j.limit} left, ${Math.round(j.secsToReset / 60)} min to reset -> ${j.verdict}`)

  if (dry) { console.log('--dry: nothing written.'); return 0 }

  const secret = readBoSecret()
  const alarming = j.severity === 'critical' || j.severity === 'warning'
  if (alarming) {
    await fileSignal(secret, signalFor(j))
    console.error(`::${j.severity === 'critical' ? 'error' : 'warning'}::${j.title}. Filed on /signals.`)
  } else {
    // Resolve a prior open signal so a recovered allowance stops showing as "needs you".
    await fileSignal(secret, {
      source: SOURCE, key: 'core-allowance', kind: 'incident', severity: 'info', state: 'resolved',
      title: 'GitHub API allowance recovered',
      summary: j.summary,
      link: 'https://cockpit.predivo.ch/signals',
    })
    console.log('  allowance healthy — any open signal resolved.')
  }
  return 0
}

if (import.meta.url === (await import('url')).pathToFileURL(process.argv[1] || '').href) {
  main().then(
    (code) => { process.exitCode = code },
    (e) => {
      console.error(`::error::the GitHub allowance check could NOT run (${e.message}). Unknown is not healthy.`)
      process.exitCode = 1
    },
  )
}
