/**
 * THE GUARD FOR THE NINTH INSTANCE.
 *
 * -- WHAT IT ENFORCES -----------------------------------------------------------------------
 *
 *     NO CHECK IN THIS REPOSITORY MAY REPORT A PASS WITHOUT HAVING REACHED ITS DEPENDENCY.
 *
 * It enforces it the only way the failure can actually be caught: by BREAKING the dependency and
 * running the check. Every one of the eight instances found on 2026-09-02, and every one of the
 * six found on 2026-09-03, was invisible to reading. They were invisible because each check's
 * blind path is individually reasonable-looking, sits far from its own verdict line, and is
 * written in the vocabulary of the thing it monitors rather than the vocabulary of failure. You
 * cannot grep for it. You can only ask the program.
 *
 * -- WHY THIS IS A TEST AND NOT A LINT ------------------------------------------------------
 *
 * A lint would look for shapes — `exit(0)` near the word "skip", a `length === 0` with no else.
 * The six defects measured on 2026-09-03 had six different shapes, and two of them (`0 of 0
 * product(s) read` reaching an OK branch by falling through three guards; `rows.length === 0`
 * being interpreted as "the scan has never run") have no syntactic tell at all. What they share
 * is not a shape, it is a BEHAVIOUR, so the guard has to be behavioural.
 *
 * -- HOW IT WORKS ---------------------------------------------------------------------------
 *
 * For each check, for each fault, spawn the real script in a child process with an injector
 * preloaded (`--import`) that replaces the outside world:
 *
 *   netdown   every fetch throws ECONNREFUSED, and every gh/git subprocess fails.
 *             "the host is gone."
 *   unauth    every fetch answers 401 Bad credentials.
 *             "the token was revoked" — the single most likely real cause, and the one that
 *             looks most like nothing happening.
 *   empty200  every fetch answers 200 with `[]`.
 *             The cruellest and the most realistic: the dependency is UP and answers
 *             successfully, and says nothing. A renamed table, a changed PostgREST filter, a
 *             revoked row-level grant and a wrong project ref all produce exactly this, and
 *             every single one of them is indistinguishable from a healthy quiet fleet unless
 *             the check is written to know that its population is never empty.
 *   emptyinput the check's own committed baseline — the file that names the population it is
 *             supposed to sweep — is emptied, and the check is run from a shadow copy of the repo.
 *             "the dependency I could not reach is on my own disk." Half the defects found on
 *             2026-09-03 were ONLY reachable this way; see the FAULTS constant.
 *
 * Then it asserts the run did not report a pass. `reportedPass()` in scripts/lib/check-verdict.mjs
 * defines that, once, for every caller: exited 0 AND did not say `::check-verdict::unknown|fail`.
 *
 * SILENCE PLUS A ZERO EXIT COUNTS AS A PASS, deliberately, because that is exactly how a person
 * and a CI dashboard read it. A check that legitimately needs to exit 0 while blind — this fleet
 * has a real and correct house rule that a filed alarm exits 0, so it does not double-report one
 * event — satisfies this guard by SAYING so with sayVerdict(UNKNOWN, ...). It cannot satisfy it
 * by being quiet, and that is the entire contract.
 *
 * -- THE PROPERTY THAT MAKES IT A CLASS-CLOSER ----------------------------------------------
 *
 * THE POPULATION IS A GLOB, NOT A LIST. `git ls-files scripts/check-*.mjs`. The tenth check
 * written in this repo is covered on the day it is written, by somebody who has never read this
 * file and does not know it exists. A guard with a hand-maintained list of subjects is the same
 * bug it is guarding against: it reports success over the population it happens to know.
 *
 * Tracked files only, so a peer's uncommitted work-in-progress in a shared checkout is not
 * failed by this session's guard. CI has no untracked files, so nothing escapes there.
 *
 * -- PROVEN BY DEFECT INJECTION -------------------------------------------------------------
 *
 * A guard that has never been seen to fail is not evidence of anything, so on 2026-09-03 this
 * suite was watched to go RED against a deliberately reintroduced defect in each of its two
 * families, and GREEN again the moment each was removed:
 *
 *   check-pipeline-drift.mjs put back to `console.log('...skipped'); process.exit(0)`
 *     -> 3 failures (netdown, unauth, empty200), 71 passing.   The credential family.
 *   check-edge-code-live.mjs with the empty-population branch deleted from verdict()
 *     -> 1 failure (emptyinput), 95 passing.                   The empty-input family.
 *
 * The second is the one that matters most: with the emptyinput fault absent, that defect passes
 * all three network faults cleanly, which is precisely how it survived until it was injected.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, basename } from 'node:path'
import { writeFileSync, readFileSync, readdirSync, mkdtempSync, mkdirSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'

import { reportedPass, verdictOf, sayVerdict, VERDICT_MARKER, PASS, FAIL, UNKNOWN } from '../scripts/lib/check-verdict.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The faults, and what each one is a stand-in for. Kept small on purpose: four faults across
 * every check beats twenty against one, because the class is about coverage, not about depth of
 * simulation.
 *
 * `emptyinput` is the fourth because the first three MISS half the real defects. Three of the six
 * found on 2026-09-03 (check-edge-code-live, check-mailer-config, check-supabase-build-currency)
 * exit non-zero perfectly well when the network is broken, and lied only when their LOCAL input —
 * a committed baseline JSON naming the population to sweep — was empty. A network-only guard
 * would have shipped green over all three. The dependency a check fails to reach is not always
 * remote, and a guard that only knows one kind of dependency measures that kind, not coverage.
 */
const FAULTS = ['netdown', 'unauth', 'empty200', 'emptyinput']

/**
 * Checks exempt from the network faults, each with a REASON that has to be true.
 *
 * An entry here is a claim, and the suite verifies the claim rather than trusting it: an exempt
 * check must make ZERO outbound calls under injection. The moment one grows a fetch, its
 * exemption stops applying and it is held to the same contract as everything else. An allowlist
 * nobody can quietly widen is the only kind worth having.
 */
const EXEMPT = {
  // (empty today — every tracked check reaches something over the network)
}

/**
 * The injector. Written to a temp file at run time rather than committed as a fixture, so it
 * cannot drift away from the contract it is testing and cannot be imported by production code
 * by accident.
 */
function writeInjector() {
  const dir = mkdtempSync(join(tmpdir(), 'check-fault-'))
  const file = join(dir, 'inject.mjs')
  writeFileSync(file, `
import cp from 'node:child_process'
const MODE = process.env.FI_MODE
let calls = 0
globalThis.fetch = async () => {
  calls++
  if (MODE === 'netdown') {
    const e = new TypeError('fetch failed')
    e.cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' })
    throw e
  }
  if (MODE === 'unauth') return new Response('{"message":"Bad credentials"}', { status: 401, statusText: 'Unauthorized', headers: { 'content-type': 'application/json' } })
  return new Response('[]', { status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' } })
}
for (const fn of ['execSync', 'execFileSync', 'spawnSync']) {
  cp[fn] = () => {
    const err = new Error('Command failed: injected ' + MODE)
    err.status = 1
    err.stdout = Buffer.from('')
    err.stderr = Buffer.from('injected ' + MODE + '\\n')
    throw err
  }
}
process.on('exit', () => process.stderr.write('##fetch-calls##' + calls + '\\n'))
`)
  return file
}

/** Every check this repo TRACKS. A glob, never a list — see the header. */
function trackedChecks() {
  const out = execFileSync('git', ['ls-files', 'scripts/check-*.mjs'], { cwd: REPO, encoding: 'utf-8' })
  return out.split(/\r?\n/).filter(Boolean)
}

/**
 * A SHADOW COPY OF THE REPO WITH EVERY DECLARED POPULATION EMPTIED.
 *
 * Built as a real directory rather than by monkey-patching `fs`, because that does not work and
 * quietly appears to: a `--import` preload CAN replace `fs.readFileSync`, and every affected
 * check uses `import { readFileSync } from 'node:fs'`, whose binding is snapshotted when the
 * builtin's ESM wrapper is instantiated and is therefore untouched. Measured 2026-09-03 — the
 * patched member answered, the named import threw ENOENT past it. A fault injector that silently
 * fails to inject is the same class of bug as the one being hunted, so it gets a real directory.
 *
 * Lives under `test-results/`, which is already gitignored, and INSIDE the repo so that Node's
 * upward `node_modules` resolution still finds the real dependencies.
 */
function buildEmptyInputShadow() {
  const root = join(REPO, 'test-results', 'fault-shadow')
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  for (const d of ['scripts', 'lib']) cpSync(join(REPO, d), join(root, d), { recursive: true })
  for (const f of ['package.json', 'ci-budget.json']) {
    try { cpSync(join(REPO, f), join(root, f)) } catch { /* optional */ }
  }
  // Empty every ARRAY in every baseline: that is where a check's population is declared, in every
  // one of them (`repos`, `products`, `projects`, `machines`). Emptying the array rather than the
  // file keeps the document structurally valid, so what is under test is the check's handling of
  // "nothing to look at" and not its JSON error handling — a different bug with a different fix.
  const libDir = join(root, 'scripts', 'lib')
  for (const f of readdirSync(libDir)) {
    if (!f.endsWith('.json')) continue
    const p = join(libDir, f)
    try {
      const doc = JSON.parse(readFileSync(p, 'utf-8'))
      for (const k of Object.keys(doc)) if (Array.isArray(doc[k])) doc[k] = []
      writeFileSync(p, JSON.stringify(doc, null, 2))
    } catch { /* not a baseline document */ }
  }
  writeFileSync(join(root, 'ci-budget.json'), JSON.stringify({ workflows: {} }, null, 2))
  return root
}

function runUnderFault(script, fault, injector, shadow) {
  // emptyinput runs the check from the shadow tree, and pairs it with the empty200 network stub so
  // the run is hermetic. Pairing it with `netdown` would be worse than useless: the check would go
  // red for the network, the assertion would pass, and a regression in the empty-population path
  // would ship green behind it.
  const isEmptyInput = fault === 'emptyinput'
  const target = isEmptyInput ? join(shadow, script) : script
  const r = spawnSync(process.execPath, [target], {
    cwd: REPO,
    encoding: 'utf-8',
    timeout: 120_000,
    env: {
      ...process.env,
      FI_MODE: isEmptyInput ? 'empty200' : fault,
      NODE_OPTIONS: `--import ${pathToFileURL(injector).href}`,
    },
  })
  const output = `${r.stdout || ''}\n${r.stderr || ''}`
  const m = /##fetch-calls##(\d+)/.exec(r.stderr || '')
  return { exitCode: r.status === null ? 124 : r.status, output, fetchCalls: m ? Number(m[1]) : 0 }
}

// ── the contract ─────────────────────────────────────────────────────────────────────────────

const injector = writeInjector()
const shadow = buildEmptyInputShadow()
const checks = trackedChecks()

test('the population is discovered, not declared', () => {
  // If this ever reads zero, the guard has become the very thing it guards against: a check
  // reporting success over an empty population. It is the first assertion for that reason.
  assert.ok(checks.length >= 20, `expected the repo's checks to be found by glob, got ${checks.length}`)
})

for (const script of checks) {
  const name = basename(script)
  for (const fault of FAULTS) {
    test(`${name} does not report a pass when its dependency is broken (${fault})`, () => {
      const r = runUnderFault(script, fault, injector, shadow)

      if (EXEMPT[name]) {
        // An exemption is a claim that this check has no outbound dependency. Verify the claim.
        assert.equal(r.fetchCalls, 0,
          `${name} is exempt on the grounds "${EXEMPT[name]}", but it made ${r.fetchCalls} outbound call(s) under ${fault}. ` +
          'It has a dependency after all, so the exemption is void — remove it from EXEMPT and give the check an unknown state.')
        return
      }

      const v = verdictOf(r.output)
      assert.equal(
        reportedPass(r), false,
        `${name} reported a PASS while its dependency was broken (${fault}): exit ${r.exitCode}, ` +
        `verdict ${v ? v.state : 'NONE DECLARED'}.\n` +
        'This is the failure class this suite exists to close: the check could not look, and said fine.\n' +
        'Fix it one of two ways — exit non-zero, or, if it must exit 0 because it files its own alarm ' +
        `(the house rule in scripts/lib/fleet-signal.mjs), call sayVerdict(UNKNOWN, "<why>") so the ` +
        'blindness is visible and reaches a human.\n' +
        `--- what it actually printed ---\n${r.output.trim().slice(0, 1200)}`,
      )
    })
  }
}

// ── the primitive's own behaviour, so the contract above cannot be satisfied by a broken parser ──

test('a run that exits 0 and says nothing counts as a pass', () => {
  assert.equal(reportedPass({ exitCode: 0, output: 'everything is fine\n' }), true)
})

test('a declared unknown is not a pass, even on exit 0', () => {
  assert.equal(reportedPass({ exitCode: 0, output: `${VERDICT_MARKER}${UNKNOWN} could not read the register\n` }), false)
})

test('a declared fail is not a pass, even on exit 0', () => {
  assert.equal(reportedPass({ exitCode: 0, output: `${VERDICT_MARKER}${FAIL} three products are down\n` }), false)
})

test('a non-zero exit is never a pass, whatever it printed', () => {
  assert.equal(reportedPass({ exitCode: 1, output: `${VERDICT_MARKER}${PASS} all good\n` }), false)
})

test('the LAST verdict wins, because a check may narrow its answer as it learns', () => {
  const out = `${VERDICT_MARKER}${PASS} early\n...work...\n${VERDICT_MARKER}${UNKNOWN} actually I could not read it\n`
  assert.equal(verdictOf(out).state, UNKNOWN)
  assert.equal(reportedPass({ exitCode: 0, output: out }), false)
})

test('a GitHub annotation is not a verdict', () => {
  // ::warning:: and ::error:: decorate a log line and leave the step green. Treating them as a
  // third state is exactly how check-external-tools-freshness.mjs announced its own blindness
  // into a channel that could not deliver it.
  assert.equal(reportedPass({ exitCode: 0, output: '::warning::the scan is stale\n::error::something\n' }), true)
})

test('sayVerdict refuses a state that is not one of the three', () => {
  assert.throws(() => sayVerdict('probably-fine', 'hmm'), /not one of/)
})
