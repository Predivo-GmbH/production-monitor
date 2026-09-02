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
 * Pure: parses text, reads files, touches no network. Contract:
 *   parseJobs(yaml)                      -> [{ name, steps: [{ index, name, raw }] }]
 *   needsInstalledDeps(path, seen)       -> true if the script (transitively) imports a bare module
 *   unreachableHandlers(jobs, resolve)   -> [{ job, step, line, reason }]
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
    if (jobKey) { job = { name: jobKey[1], steps: [] }; jobs.push(job); continue }
    if (!job) continue

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
