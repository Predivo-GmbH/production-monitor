#!/usr/bin/env node
/**
 * A RED DEPLOY MUST REACH ROGER. Nothing in this repo was asking.
 *
 * WHY (2026-09-01, Roger, looking at the Deploy Status page): "I'm not informed when, for
 * example, ScoutCopilot's last run failed. I'm never being informed that this didn't work
 * properly. That keeps happening over and over again."
 *
 * He was right, and the gap was total. This repo runs nineteen checks - products down, schema
 * drift, cron heartbeats, CI budget, RLS grants, workflow cadence, Sentry, mailer config - and
 * not one of them asks whether a product's DEPLOY PIPELINE went red. The only callers of
 * send-alert.mjs are the site monitor, the drift check and the dashboard update. So the single
 * place in the whole system where a red deploy exists is the Deploy Status page, and a page is
 * pull, not push: it tells him only if he opens it.
 *
 * The two things that look like they cover this do not:
 *   flaky-retry.mjs          reruns transient failures and says so in its own header - "a second
 *                            failure is left alone, THE REAL ALERT PATH TAKES OVER". That alert
 *                            path was never built. This file is it.
 *   deploy-failure-triage.mjs opens a PR with a diagnosis. It never tells anyone. Its scheduled
 *                            task has been Disabled since 2026-08-25.
 *
 * THE FAILURE THAT PROVED IT, and the reason this reads runs and not jobs. ScoutCopilot run
 * 33392350776 went red on 2026-08-31 12:33Z and was still red 23 hours later. Its jobs endpoint
 * returns `total_count: 0`: the workflow FILE was broken, so GitHub never started a single job.
 * A watcher written the obvious way - walk the jobs, find the failed step - sees nothing wrong
 * and reports nothing. A deploy that cannot even start is the most complete failure there is and
 * it is the one shape that leaves no job behind to find. It is classified first, by name, here.
 *
 * WHAT COUNTS AS RED. Per repo, per deploy workflow file, only the NEWEST COMPLETED run on the
 * deploy branch. A failure with a green run after it is history, not an outage.
 *
 * WHAT IS DELIBERATELY NOT RED:
 *   - a promotion the staging gate REFUSED. The dispatch fails on "Verify staging gate" because
 *     the commit was not eligible. Production is untouched and healthy; the gate did its job.
 *     The Deploy Status page already renders this calm rather than red and so does this.
 *   - a cancelled run. Somebody stopped it on purpose.
 *   - a run still going. It has not failed yet.
 *
 * ONE CAUSE IS ONE ALERT. At ROLLUP_THRESHOLD or above this files ONE rollup and demotes the
 * members to board-only, exactly as check-healthchecks-down.mjs does, and for a reason already
 * observed here: on 2026-08-31 one commit ("lftp -f cannot combine with -u/URL") went out across
 * the fleet at once. Roger's measure is that more than about two alerts a week means they are
 * miscalibrated, and five pages for one bad commit is how a pager gets muted.
 *
 * Staging red and production red are not the same news. A red PRODUCTION pipeline means the
 * product cannot ship and pages; a red STAGING pipeline is filed and visible but does not ring.
 *
 * SELF-RESOLVING. signal-intake holds a page for its self-heal window, so a deploy that goes red
 * and is green again half an hour later (flaky-retry's whole job) never rings at all.
 *
 * Contract:  node scripts/check-deploy-failures.mjs [--dry]
 *   env: GH_TOKEN or GITHUB_TOKEN   actions:read on the fleet repos (FLEET_READ_TOKEN in CI)
 *        BOARD_SUPABASE_SECRET or BACKOFFICE_SERVICE_ROLE_KEY   to file the signal
 * Exit 0 = judged (clean or filed). Exit 1 = could not tell, which is never "fine".
 */
import { readFileSync } from 'fs'
import { getFleet } from '../lib/fleet.mjs'

const BO_REF = 'xoecpzfsskalvjrtcbbl'
const BO_BASE = `https://${BO_REF}.supabase.co`
const BO_CREDS = 'C:\\Business\\Internal Projects\\BackOffice\\docs\\Credentials.txt'
const GH_API = 'https://api.github.com'
const UA = 'deploy-failure-watcher/1.0'

export const SOURCE = 'deploy'
export const ROLLUP_KEY = 'many-deploys-red'

/**
 * Three, the same number check-healthchecks-down uses and for the same reason. Two red pipelines
 * in one window are plausibly two unrelated faults and he should hear both. Three is a fleet-wide
 * commit, which is what actually happened on 2026-08-31.
 */
export const ROLLUP_THRESHOLD = 3

/** How many runs to read per repo. Enough to find the newest completed run of each deploy file. */
const RUNS_PER_REPO = 40

/**
 * A deploy workflow, by file name. Matching on the PATH and not the display name is deliberate:
 * ScoutCopilot's broken run has no display name at all - GitHub falls back to printing the file
 * path, which is the tell that the file never parsed.
 */
export function isDeployWorkflow(path) {
  return /(^|\/)deploy[^/]*\.ya?ml$/i.test(String(path || ''))
}

/** Does this workflow file ship PRODUCTION, or only staging? Staging is filed, production pages. */
export function isProductionWorkflow(path) {
  return isDeployWorkflow(path) && !/staging/i.test(String(path || ''))
}

/**
 * Which environment a JOB ships, decided by the job name rather than the file name. This fleet
 * (ReplyFlow, SignalScore, ChannelMover, Valrano, Cockpit) holds staging and production in ONE
 * deploy.yml: the `deploy-staging` job runs on push, and `deploy`/`deploy-fast` run on a manual
 * promotion. So the file name cannot tell staging from production - the failed job can.
 */
export const isStagingDeployJob = (name) => /^deploy-staging$/i.test(String(name || ''))
export const isProdDeployJob = (name) => /^(deploy|deploy-fast|prod-smoke)$/i.test(String(name || ''))

/**
 * The lane a RUN belongs to, from its trigger, used only to keep the "what is currently red"
 * decision per-lane. A push runs the staging deploy job; a manual dispatch (or a scheduled gate
 * pass) belongs to the production lane. Without this a green staging push and a red production
 * dispatch of the SAME deploy.yml share one bucket, and the newer green push silently erases the
 * red production result - the latent second half of the 2026-09-01 misfiling.
 */
export function runLane(run) {
  if (!isProductionWorkflow(run.path)) return 'staging' // a dedicated deploy-staging.yml
  return run.event === 'push' ? 'staging' : 'production'
}

/** The board key for one pipeline. Production keeps the historical `product:path` key so existing
 * open rows resolve cleanly on recovery; a staging failure of the same file gets its own suffix so
 * the two lanes never overwrite each other. */
export function deployKey(product, path, production) {
  const base = `${product}:${path}`
  return production ? base.slice(0, 56) : `${base.slice(0, 48)}:staging`
}

/**
 * The newest COMPLETED run of each deploy workflow on this branch, and whether it is red.
 * Pure, so the whole "what is currently broken" decision is testable without GitHub.
 *
 * A run that is still in progress is skipped entirely rather than treated as the newest result:
 * a deploy running right now says nothing about whether the last one worked, and letting it mask
 * the previous failure is how a permanently-red pipeline reads as healthy on a busy repo.
 */
export function currentFailures(runs) {
  const newestByLane = new Map()
  for (const r of runs || []) {
    if (!isDeployWorkflow(r.path)) continue
    if (r.status !== 'completed') continue
    // Keyed by file AND lane: a staging-push run and a production-dispatch run of the same
    // deploy.yml are two independent results, and neither may overwrite the other.
    const laneKey = `${r.path}::${runLane(r)}`
    const prev = newestByLane.get(laneKey)
    if (!prev || new Date(r.created_at) > new Date(prev.created_at)) newestByLane.set(laneKey, r)
  }
  return [...newestByLane.values()].filter(
    (r) => r.conclusion === 'failure' || r.conclusion === 'startup_failure',
  )
}

/**
 * What actually went wrong, in words that name the consequence rather than the mechanism.
 *
 * `jobs` is the raw jobs payload for the run. ZERO jobs is the ScoutCopilot shape and is checked
 * FIRST, because every other branch here assumes there is a job to look at.
 */
export function classifyFailure(run, jobs) {
  const list = jobs?.jobs || []
  const total = jobs?.total_count ?? list.length
  if (run.conclusion === 'startup_failure' || total === 0) {
    return {
      kind: 'workflow-file',
      job: null,
      step: null,
      production: true, // a dead file ships neither staging nor production; nothing can go out at all
      why: 'the deploy file itself is broken, so GitHub never started a single step. Nothing can be deployed from this repo until it is fixed.',
    }
  }

  const failedJob = list.find((j) => j.conclusion === 'failure')
  const failedStep = failedJob ? (failedJob.steps || []).find((s) => s.conclusion === 'failure') : null
  const stepName = failedStep?.name || null

  // A promotion the staging gate REFUSED. Production is unchanged and healthy. Two real shapes:
  //   (a) the production deploy job started and bailed at its own "Verify staging gate" step;
  //   (b) an earlier GATE job (gate-e2e, gate-security, …) failed, so the production deploy job was
  //       skipped and never ran. This is the shape this fleet actually produces - the deploy and
  //       its gates are separate JOBS, so no step named "Verify staging gate" ever fails, and the
  //       original step-name-only carve-out never matched (verified live 2026-09-01: ReplyFlow,
  //       SignalScore, Valrano dispatch runs, gate-e2e=failure, deploy=skipped, prod untouched).
  // Only a manual promotion can be refused at its gate step (a); a push failing that step is a real
  // broken pipeline. A gate that fails while the prod deploy never ran (b) touched no environment on
  // a dispatch OR a scheduled gate run, so neither is an alarm - but on a push it is a real failure.
  const prodJobs = list.filter((j) => isProdDeployJob(j.name))
  const prodSkippedNeverRan = prodJobs.length > 0 && prodJobs.every((j) => j.conclusion === 'skipped')
  const bailedAtGateStep =
    run.event === 'workflow_dispatch' && stepName && /verify staging gate/i.test(stepName) &&
    failedJob && isProdDeployJob(failedJob.name)
  const refusedByEarlierGate =
    run.event !== 'push' && failedJob &&
    !isProdDeployJob(failedJob.name) && !isStagingDeployJob(failedJob.name) && prodSkippedNeverRan
  if (bailedAtGateStep || refusedByEarlierGate) {
    return {
      kind: 'gate-rejection',
      job: failedJob?.name || null,
      step: stepName,
      production: false,
      why: 'the promotion was refused before it reached production - the production deploy never ran. Production is unchanged.',
    }
  }

  if (!failedJob) {
    return { kind: 'unknown', job: null, step: null, why: 'the run failed without naming a failed job.' }
  }

  // Which environment actually broke is decided by the JOB that failed, not the file name.
  // null = a gate/other job failed while a deploy did run; the file name decides downstream.
  const production = isProdDeployJob(failedJob.name)
    ? true
    : isStagingDeployJob(failedJob.name)
      ? false
      : null
  return {
    kind: 'failed-step',
    job: failedJob.name,
    step: stepName,
    production,
    why: stepName
      ? `it stopped at "${stepName}" in ${failedJob.name}.`
      : `the job ${failedJob.name} failed.`,
  }
}

/** Production-vs-staging for the SIGNAL, decided from the classification's job, not the file name. */
export function isProductionFailure(run, classification) {
  if (classification.kind === 'workflow-file') return true
  if (typeof classification.production === 'boolean') return classification.production
  return isProductionWorkflow(run.path) // unknown / a gate failure where a deploy still ran
}

/** A gate rejection is the system working. Everything else that is red is news. */
export function isAlarm(classification) {
  return classification.kind !== 'gate-rejection'
}

/** What ONE red pipeline says on the cockpit. */
export function signalFor({ product, run, classification }) {
  const production = isProductionFailure(run, classification)
  const broken = classification.kind === 'workflow-file'
  const title = broken
    ? `${product}: the deploy file is broken, nothing can ship`
    : production
      ? `${product}: the production deploy is failing`
      : `${product}: the staging deploy is failing`
  return {
    source: SOURCE,
    key: deployKey(product, run.path, production),
    kind: 'incident',
    severity: production ? 'critical' : 'warning',
    state: 'open',
    needs_human: production,
    title,
    summary: `Red since ${String(run.created_at).slice(0, 16).replace('T', ' ')} UTC and still red: ${classification.why}`,
    detail: {
      repo: run.repository_full_name || null,
      workflow: run.path,
      run_id: run.id,
      event: run.event,
      head_sha: run.head_sha,
      failure_kind: classification.kind,
      failed_job: classification.job,
      failed_step: classification.step,
    },
    link: run.html_url || 'https://cockpit.predivo.ch/deploy',
  }
}

/**
 * The whole flood decision, pure and testable: given what is red, what gets filed and what may
 * ring. Mirrors planSignals in check-healthchecks-down.mjs deliberately, so the two producers
 * behave the same way when the fleet breaks all at once.
 *
 * Only PRODUCTION failures count toward the threshold. Staging rows never page on their own, so
 * counting them would roll up a set that was never going to ring and hide the one row that was.
 */
export function planSignals(failures) {
  const bodies = failures.map(signalFor)
  const pageable = bodies.filter((b) => b.needs_human)
  if (pageable.length < ROLLUP_THRESHOLD) return { rollup: null, members: bodies }

  const names = pageable.map((b) => b.title.split(':')[0])
  return {
    rollup: {
      source: SOURCE,
      key: ROLLUP_KEY,
      kind: 'incident',
      severity: 'critical',
      state: 'open',
      needs_human: true,
      title: `${pageable.length} products cannot deploy to production`,
      summary:
        `They went red inside the same window, so this is most likely one cause and not ${pageable.length}. ` +
        `Cannot ship right now: ${names.join(', ')}. Each one is on the board with its own detail.`,
      detail: { count: pageable.length, products: names },
      link: 'https://cockpit.predivo.ch/deploy',
    },
    // Still filed, still carrying every detail, but not eligible to ring. `warning` plus
    // needs_human:false is the pair upsert_signal records as 'not-eligible'.
    members: bodies.map((b) => ({ ...b, severity: 'warning', needs_human: false })),
  }
}

/**
 * Which open rows a recovery run may resolve. Scoped to keys this run actually produced a verdict
 * for, never "everything under this source that is not red" - the 2026-08-30 lesson from the
 * healthchecks producer, which force-resolved diagnosis rows it had no business touching.
 */
export function recoveredKeys({ openKeys, judgedKeys, redKeys }) {
  return [...openKeys].filter((k) => k !== ROLLUP_KEY && judgedKeys.has(k) && !redKeys.has(k))
}

// ── I/O shell ────────────────────────────────────────────────────────────────

function readToken() {
  const t = (process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '').trim()
  if (!t) throw new Error('no GH_TOKEN / GITHUB_TOKEN. Without it this cannot tell red from green, which is not "fine".')
  return t
}

function readBoSecret() {
  if (process.env.BOARD_SUPABASE_SECRET) return process.env.BOARD_SUPABASE_SECRET.trim()
  if (process.env.BACKOFFICE_SERVICE_ROLE_KEY) return process.env.BACKOFFICE_SERVICE_ROLE_KEY.trim()
  const txt = readFileSync(BO_CREDS, 'utf-8')
  const m = txt.match(/sb_secret_[A-Za-z0-9_]+/)
  if (!m) throw new Error(`no sb_secret_ key found in ${BO_CREDS}`)
  return m[0]
}

async function ghGet(token, path) {
  const res = await fetch(`${GH_API}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': UA },
  })
  if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`)
  return res.json()
}

async function boGet(secret, path) {
  const res = await fetch(`${BO_BASE}/rest/v1/${path}`, {
    headers: { apikey: secret, Authorization: `Bearer ${secret}`, 'User-Agent': UA },
  })
  if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`)
  return res.json()
}

async function fileSignal(secret, body) {
  const res = await fetch(`${BO_BASE}/functions/v1/signal-intake`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`signal-intake -> HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`)
  return res.json()
}

async function main() {
  const dry = process.argv.includes('--dry')
  const token = readToken()

  const { fleet, source: fleetSource } = await getFleet()
  const products = fleet.filter((p) => p.branch)
  console.log(`deploy-watch: fleet source = ${fleetSource} (${products.length} deploy-monitored)`)

  const failures = []   // { product, run, classification }
  const judgedKeys = new Set()

  for (const p of products) {
    // A repo we cannot read is NOT a clean result. Throwing fails the run, which is the point.
    const body = await ghGet(token, `/repos/${p.repo}/actions/runs?branch=${encodeURIComponent(p.branch)}&per_page=${RUNS_PER_REPO}`)
    const runs = (body.workflow_runs || []).map((r) => ({ ...r, repository_full_name: p.repo }))

    // Every deploy workflow this repo HAS is judged, green or red, so a recovery can resolve it.
    // Both lane keys, because staging and production of one deploy.yml are separate board rows.
    for (const r of runs) {
      if (!isDeployWorkflow(r.path)) continue
      judgedKeys.add(deployKey(p.name, r.path, true))
      judgedKeys.add(deployKey(p.name, r.path, false))
    }

    for (const run of currentFailures(runs)) {
      const jobs = await ghGet(token, `/repos/${p.repo}/actions/runs/${run.id}/jobs`)
      const classification = classifyFailure(run, jobs)
      if (!isAlarm(classification)) {
        console.log(`  ok    ${p.name} ${run.path}: promotion refused by the staging gate, production unchanged`)
        continue
      }
      console.log(`  RED   ${p.name} ${run.path}: ${classification.kind} - ${classification.why}`)
      failures.push({ product: p.name, run, classification })
    }
  }

  const { rollup, members } = planSignals(failures)
  console.log(`deploy-watch: ${failures.length} pipeline(s) currently red across ${products.length} product(s)`)

  if (dry) {
    console.log(rollup
      ? `--dry: would file ONE rollup ("${rollup.title}") plus ${members.length} board-only entries. Nothing written.`
      : `--dry: would file ${members.length} signal(s). Nothing written.`)
    return 0
  }

  const secret = readBoSecret()
  // 'superseded' is read alongside 'open' for the same reason the healthchecks producer does it:
  // board-drainer stamps a signal superseded when it moves it onto the work board, and a pipeline
  // that goes green while it sits there still has to be resolved.
  const open = await boGet(secret, `fleet_signals?source=eq.${SOURCE}&state=in.(open,superseded)&select=key`)
  const openKeys = new Set(open.map((r) => r.key))
  const redKeys = new Set(members.map((m) => m.key))

  // The rollup goes FIRST: it is the one that may ring, so if this process dies half way through,
  // the alert he actually needs is the one already sent.
  if (rollup) {
    const res = await fileSignal(secret, rollup)
    console.log(`  ROLLUP: filed as one alert - ${res.will_page ? `page due ${res.page_due_at}` : `not paging (${res.suppressed})`}`)
  }
  for (const m of members) {
    const res = await fileSignal(secret, m)
    console.log(`  filed ${m.key} - ${res.will_page ? `page due ${res.page_due_at}` : `not paging (${res.suppressed ?? 'not eligible'})`}`)
  }

  for (const key of recoveredKeys({ openKeys, judgedKeys, redKeys })) {
    await fileSignal(secret, {
      source: SOURCE, key, kind: 'incident', severity: 'info', state: 'resolved',
      title: `Deploy is green again: ${key}`,
      summary: 'The newest run of this pipeline succeeded, so this cleared itself.',
      link: 'https://cockpit.predivo.ch/deploy',
    })
    console.log(`  recovered: ${key} - signal resolved.`)
  }

  if (!rollup && openKeys.has(ROLLUP_KEY)) {
    await fileSignal(secret, {
      source: SOURCE, key: ROLLUP_KEY, kind: 'incident', severity: 'info', state: 'resolved',
      title: 'The fleet can deploy to production again',
      summary: failures.length
        ? `Down to ${failures.length} red pipeline(s), each now reported on its own.`
        : 'Every deploy pipeline is green.',
      link: 'https://cockpit.predivo.ch/deploy',
    })
    console.log('  rollup cleared: back below the threshold.')
  }

  if (failures.length) console.error(`::error::${failures.length} deploy pipeline(s) are red. Filed on /signals.`)
  return 0
}

// Importable for tests; only runs when executed directly.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('check-deploy-failures.mjs')) {
  main().then((c) => process.exit(c)).catch((e) => {
    console.error(`::error::deploy-watch could not tell red from green: ${e.message}`)
    process.exit(1)
  })
}
