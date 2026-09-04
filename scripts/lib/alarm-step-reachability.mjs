/**
 * CAN THE STEP THAT SENDS THE ALARM ACTUALLY RUN?
 *
 * -- WHY THIS EXISTS (2026-09-02) ------------------------------------------------------------
 *
 * Run 33643774410 of Daily Dashboard Update failed and Roger was never told. Not because the
 * alert was suppressed, not because SMTP was down — because the step that sends it could not
 * start:
 *
 *     2. Verify FTP credentials (fail fast on a stale secret) -> failure
 *     3. Run actions/checkout@v5                              -> skipped
 *     7. Send alert on failure                                -> failure
 *        Error: Cannot find module '/home/runner/work/.../scripts/send-alert.mjs'
 *
 * The FTP pre-flight was deliberately placed BEFORE checkout ("curl needs no lftp, so this can
 * run before checkout"), so it would fail fast on a stale password. It did exactly that. But a
 * step that runs before checkout also runs before `scripts/` exists, so its failure — the one
 * failure that guard was written to make loud — was the single failure the mailer could not
 * report. The guard and its alarm cancelled each other out.
 *
 * `scripts/check-alarm-reachability.mjs` already asks whether a filed SIGNAL can reach a human.
 * It reads the signals board and knows nothing about YAML, so it could not see this: the alarm
 * never got as far as being filed. This is the step-level half of the same question.
 *
 * -- THE RULE, AND WHY IT IS SHAPED THIS WAY --------------------------------------------------
 *
 * "checkout appears above the handler in the file" is NOT the invariant, and believing it was is
 * what let this ship — checkout WAS on line 59 and the handler on line 76. Checkout was skipped,
 * because a step before it had already failed. So the real invariant is about what can fail:
 *
 *   In a job whose failure handler runs a file out of the repo, checkout — and, if that file
 *   needs node_modules, `npm ci` — must come before the FIRST step that can fail.
 *
 * A leading run of pure setup steps (checkout / setup-node / cache / npm ci) is allowed ahead of
 * them, because those steps are the handler's own prerequisites: if `npm ci` is what failed there
 * is no mailer to send with, and nothing written here could change that. Everything after that
 * prefix is substantive work that CAN fail while the alarm is still expected to work.
 *
 * -- THE SECOND WAY AN ALARM CANNOT RUN (2026-09-04) ------------------------------------------
 *
 * Everything above is about a step that is REACHED and cannot execute. Run 33818609882 of
 * monitor.yml found the other half: a step that executes fine and is never reached, because its
 * CONDITION went false.
 *
 *     7. Run production monitor                -> failure   (32 failed tests, 12 products dark)
 *    14. Auto-fix known failure patterns       -> success    <- if: failure(), and it RAN
 *    30. Send alert on failure                 -> SKIPPED    <- if: failure(), and it did not
 *
 * The job declared `timeout-minutes: 25` and overran it. A job killed by its own cap concludes
 * `cancelled`, not `failure`, and in a cancelled job `failure()` evaluates FALSE. So `failure()`
 * FLIPPED mid-job: steps 14 and 15 were reached at 00:03:32, before cancellation was signalled
 * at 00:05:34, and got the true reading; the mailer, reached at 00:07:55, got the false one.
 *
 * The alarm is deliberately the LAST step in every one of these workflows, which puts it on the
 * wrong side of that line by construction. Raising the cap moves the line; only the condition
 * removes it. Hence the rule:
 *
 *   In a job that declares `timeout-minutes`, a step that SENDS MAIL and is gated on `failure()`
 *   must also fire on `cancelled()` — otherwise the job's own overrun is the single failure it
 *   can never report.
 *
 * Two deliberate narrowings, both load-bearing:
 *
 *   * "sends mail", decided by walking imports to `nodemailer`, NOT by matching step names.
 *     monitor.yml's `failure()` steps also include Auto-heal, which REDEPLOYS PRODUCTION SITES.
 *     Widening a notifier is free; widening a redeploy so it fires on a timeout is not.
 *   * workflows with `cancel-in-progress: true` are EXEMPT. There a cancellation is routine —
 *     ci-runner-watchdog.yml supersedes itself several times an hour — so paging on `cancelled()`
 *     would mail on every superseded run. A step condition cannot tell a supersede from a
 *     timeout. That exemption is paid for by an `if: always()` dead-man's switch, not waived.
 *
 * Pure: parses text, reads files, touches no network. Contract:
 *   parseJobs(yaml)                      -> [{ name, attrs, steps: [{ index, name, raw }] }]
 *   needsInstalledDeps(path, seen)       -> true if the script (transitively) imports a bare module
 *   unreachableHandlers(jobs, resolve)   -> [{ job, step, line, reason }]
 *   sendsMail(path)                      -> true if the script (transitively) imports nodemailer
 *   timeoutSilencedAlarms(jobs, yaml, r) -> [{ job, step, line, cap, script, reason }]
 */
import { readFileSync, existsSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, resolve as resolvePath } from 'node:path'

const BUILTINS = new Set(builtinModules)

/**
 * Split a workflow file into jobs and their steps.
 *
 * Deliberately a line scanner and not a YAML parser: the unit suite runs with no `npm ci`
 * (.github/workflows/test.yml, "CHEAP ON PURPOSE"), so it has no yaml dependency available.
 * Only two shapes matter here — a job key at two spaces, a step dash at six — and both are
 * fixed by the repo's own formatting.
 */
export function parseJobs(yaml) {
  const lines = String(yaml ?? '').split(/\r?\n/)
  const jobs = []
  let inJobs = false
  let job = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^jobs:\s*$/.test(line)) { inJobs = true; continue }
    if (!inJobs) continue
    if (/^\S/.test(line)) { inJobs = false; job = null; continue }   // back to a top-level key

    const jobKey = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/)
    if (jobKey) { job = { name: jobKey[1], attrs: '', steps: [] }; jobs.push(job); continue }
    if (!job) continue

    // Job-level keys sit at exactly four spaces (`runs-on:`, `timeout-minutes:`, `steps:`).
    // Collected because a job's OWN timeout is what decides whether its alarms can run at all.
    // Behaviour-preserving: a four-space line already fell through every branch below, which
    // require six (a step dash) or eight (a step's own keys).
    if (/^ {4}\S/.test(line)) { job.attrs += line + '\n'; continue }

    if (/^ {6}- /.test(line)) {
      job.steps.push({ index: job.steps.length, line: i + 1, raw: line, name: null })
      continue
    }
    // Continuation of the current step (any deeper-indented line).
    const step = job.steps[job.steps.length - 1]
    if (step && /^ {8}\S/.test(line)) step.raw += '\n' + line
  }

  for (const j of jobs) {
    for (const s of j.steps) {
      const named = s.raw.match(/(?:^|\n)\s*-?\s*name:\s*(.+)/)
      const used = s.raw.match(/(?:^|\n)\s*-?\s*uses:\s*(\S+)/)
      s.name = (named?.[1] ?? used?.[1] ?? 'unnamed step').trim()
    }
  }
  return jobs
}

/** A step that exists only to make later steps possible. May precede the handler's deps. */
export function isSetupStep(raw) {
  return /uses:\s*actions\/(checkout|setup-[a-z]+|cache)/.test(raw) ||
         /run:\s*npm (ci|install)\b/.test(raw)
}

export const isCheckout = (raw) => /uses:\s*actions\/checkout/.test(raw)
export const isNpmInstall = (raw) => /run:\s*npm (ci|install)\b/.test(raw)

/** A step that runs on failure/always AND executes a file out of this repo. */
export function repoFileHandler(raw) {
  if (!/\bif:\s*[^\n]*(failure\(\)|always\(\))/.test(raw)) return null
  const m = raw.match(/run:\s*(?:node|bash|sh)\s+((?:scripts|test)\/[^\s'"]+)/)
  return m ? m[1] : null
}

/**
 * Does this script need `npm ci` to have run? True when it — or anything it imports,
 * transitively — pulls in a bare module specifier that is not a Node builtin.
 *
 * Catches BOTH `import x from 'nodemailer'` and `await import('nodemailer')`. The dynamic
 * form is not a detail: scripts/lib/smtp.mjs uses exactly that, so a static-import-only
 * check would call every mailer in this repo dependency-free and pass a job that cannot send.
 */
export function needsInstalledDeps(file, seen = new Set()) {
  const abs = resolvePath(file)
  if (seen.has(abs) || !existsSync(abs)) return false
  seen.add(abs)

  let src
  try { src = readFileSync(abs, 'utf-8') } catch { return false }

  // Strip comments first. Without this the checker reads the PROSE around an import as an
  // import — this very file documents `await import('nodemailer')` in its header and was
  // therefore reported as needing nodemailer. The line-comment pattern keeps the character
  // before `//` so that a `https://` inside a string is not mistaken for a comment.
  src = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

  const specs = [...src.matchAll(/(?:from\s*|import\s*\(\s*)['"]([^'"]+)['"]/g)].map((m) => m[1])
  for (const spec of specs) {
    if (spec.startsWith('.')) {
      if (needsInstalledDeps(resolvePath(dirname(abs), spec), seen)) return true
    } else if (!spec.startsWith('node:') && !BUILTINS.has(spec)) {
      return true
    }
  }
  return false
}

/**
 * Find failure handlers that cannot run. `resolveScript` maps a repo-relative script path to
 * an absolute path (injected so the unit cases can run without touching the real tree).
 */
export function unreachableHandlers(jobs, resolveScript = (p) => p) {
  const problems = []

  for (const job of jobs) {
    const handlers = job.steps
      .map((s) => ({ step: s, script: repoFileHandler(s.raw) }))
      .filter((h) => h.script)
    if (handlers.length === 0) continue

    // Everything up to the first non-setup step is the allowed prefix.
    const firstSubstantive = job.steps.findIndex((s) => !isSetupStep(s.raw))
    const boundary = firstSubstantive === -1 ? job.steps.length : firstSubstantive
    const checkoutIdx = job.steps.findIndex((s) => isCheckout(s.raw))
    const npmIdx = job.steps.findIndex((s) => isNpmInstall(s.raw))

    for (const { step, script } of handlers) {
      if (checkoutIdx === -1) {
        problems.push({
          job: job.name, step: step.name, line: step.line, script,
          reason: `runs ${script} but the job never checks the repo out`,
        })
        continue
      }
      if (checkoutIdx > boundary) {
        const blocker = job.steps[boundary]
        problems.push({
          job: job.name, step: step.name, line: step.line, script,
          reason: `runs ${script}, but checkout is step ${checkoutIdx + 1} and step ${boundary + 1} ` +
                  `("${blocker.name}") can fail before it — checkout would be skipped and ${script} ` +
                  `would not exist`,
        })
        continue
      }
      if (needsInstalledDeps(resolveScript(script)) && (npmIdx === -1 || npmIdx > boundary)) {
        const where = npmIdx === -1 ? 'the job never runs it' : `it is step ${npmIdx + 1}`
        const blocker = job.steps[boundary]
        problems.push({
          job: job.name, step: step.name, line: step.line, script,
          reason: `${script} needs node_modules but ${where}, after step ${boundary + 1} ` +
                  `("${blocker.name}") which can fail first`,
        })
      }
    }
  }
  return problems
}

// ── DOES THE ALARM SURVIVE THE JOB'S OWN TIMEOUT? ───────────────────────────────────────────
// See the second block of the header for the run that proved this was a separate defect from
// everything above it.

/**
 * Drop whole-line `#` comments.
 *
 * NOT defensive tidying — the gate below shipped BROKEN without it, in the few minutes between
 * writing it and testing it (2026-09-04). `cancelsInProgress` scanned the raw file for
 * `cancel-in-progress: true`, and monitor.yml now carries a COMMENT at :817 reading
 * "ci-runner-watchdog.yml, which does set cancel-in-progress: true, is exempt". The regex read
 * that sentence as configuration and exempted the one file the fix was written for: with the fix
 * reverted, the ratchet still passed. A gate born disabled, in this repo's own words — and it was
 * the fix's own explanatory comment that disabled it.
 *
 * The header of this very file already warned about the identical trap one function up: the
 * import walker reads prose about `await import('nodemailer')` as an import unless comments go
 * first. These workflows are mostly comment by volume. Anything matching a config pattern
 * against their text strips comments first.
 */
export const stripYamlComments = (text) =>
  String(text ?? '').split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n')

/** A job-level `timeout-minutes`, or null. THE SILENT CAP: it concludes `cancelled`. */
export function jobTimeout(attrs) {
  const m = stripYamlComments(attrs).match(/(?:^|\n) {4}timeout-minutes:\s*(\d+)/)
  return m ? Number(m[1]) : null
}

/** A step's `if:` expression with any `${{ }}` wrapper stripped, or null when it carries none. */
export function stepCondition(raw) {
  const m = stripYamlComments(raw).match(/(?:^|\n)?\s*-?\s*if:\s*(.+)/)
  if (!m) return null
  return m[1].trim().replace(/^\$\{\{\s*/, '').replace(/\s*\}\}$/, '').trim()
}

/**
 * Does this script reach `target` through its imports, transitively?
 *
 * Same comment-stripping and dynamic-import handling as needsInstalledDeps, and for the same
 * reason: scripts/lib/smtp.mjs reaches nodemailer with `await import('nodemailer')`, so a
 * static-import-only walk would classify every mailer in this repo as not sending mail — and
 * this gate would then sweep zero steps while reporting a clean pass.
 */
export function reachesModule(file, target, seen = new Set()) {
  const abs = resolvePath(file)
  if (seen.has(abs) || !existsSync(abs)) return false
  seen.add(abs)

  let src
  try { src = readFileSync(abs, 'utf-8') } catch { return false }
  src = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

  const specs = [...src.matchAll(/(?:from\s*|import\s*\(\s*)['"]([^'"]+)['"]/g)].map((m) => m[1])
  for (const spec of specs) {
    if (spec === target) return true
    if (spec.startsWith('.') && reachesModule(resolvePath(dirname(abs), spec), target, seen)) return true
  }
  return false
}

/**
 * A step that can TELL A HUMAN — decided by what it imports, not by what it is called.
 * Naming it by name is how `auto-heal.mjs` (which redeploys production) would end up in the
 * same bucket as a mailer, and how a rename would quietly empty this gate.
 */
export const sendsMail = (file) => reachesModule(file, 'nodemailer')

/** The repo script a step runs, or null. */
export function stepScript(raw) {
  const m = stripYamlComments(raw).match(/run:\s*(?:node|bash|sh)\s+((?:scripts|test)\/[^\s'"]+)/)
  return m ? m[1] : null
}

/**
 * Whether this workflow cancels its own in-flight runs, making `cancelled()` routine.
 *
 * Anchored to the real key under the top-level `concurrency:` block (two spaces), with comments
 * stripped first. Both halves are load-bearing: an unanchored scan of the raw text matched a
 * sentence ABOUT another workflow's setting and silently exempted this one.
 */
export const cancelsInProgress = (yaml) =>
  /^ {2}cancel-in-progress:\s*true\s*$/m.test(stripYamlComments(yaml))

/**
 * Mail-sending alarms that the job's OWN `timeout-minutes` would silence.
 *
 * Returns [] for a workflow that sets `cancel-in-progress: true` — see the header for why that
 * exemption is correct rather than convenient.
 */
export function timeoutSilencedAlarms(jobs, yaml, resolveScript = (p) => p) {
  if (cancelsInProgress(yaml)) return []

  const problems = []
  for (const job of jobs) {
    const cap = jobTimeout(job.attrs)
    if (cap === null) continue          // no job cap -> no cancelled-by-timeout path to survive

    for (const step of job.steps) {
      const cond = stepCondition(step.raw)
      if (!cond) continue
      // `steps.x.outcome == 'failure'` is a string comparison, not the status function, and a
      // step carrying always() already runs in a cancelled job. Only a bare failure() is at risk.
      if (!/\bfailure\(\)/.test(cond)) continue
      if (/\bcancelled\(\)/.test(cond) || /\balways\(\)/.test(cond)) continue

      const script = stepScript(step.raw)
      if (!script || !sendsMail(resolveScript(script))) continue

      problems.push({
        job: job.name, step: step.name, line: step.line, cap, script,
        reason: `sends mail via ${script} gated on failure() alone, but the job caps itself at ` +
                `${cap} minutes — an overrun concludes "cancelled", where failure() is false, so ` +
                `the one failure this alarm could not report is the job's own timeout`,
      })
    }
  }
  return problems
}
