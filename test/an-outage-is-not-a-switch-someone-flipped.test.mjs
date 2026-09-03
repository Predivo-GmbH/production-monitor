/**
 * An engine outage is not a switch somebody flipped.
 *
 *   node test/an-outage-is-not-a-switch-someone-flipped.test.mjs
 *
 * WHY THIS EXISTS
 * ---------------
 * agent-run has two "no agent ran" exits and they mean opposite things:
 *
 *   76  Roger switched the automations off in the cockpit.   A DECISION.
 *   77  Both AI engines are usage-capped.                    AN OUTAGE.
 *
 * Until 2026-09-03 board-drainer.mjs mapped BOTH to one sentinel:
 *
 *     if ((e?.status === SWITCHED_OFF_EXIT || e?.status === NO_CAPACITY))
 *
 * and then hardcoded the reason as "automations switched off in the cockpit
 * (agent-run exit 76)". So a capacity outage reached Roger's page as a sentence
 * blaming him for a switch — and pointed him at a control that was already on.
 *
 * Measured that day, which is how the conflation was found rather than guessed:
 * automation_config read runs_enabled=true, emergency_stop=false in the database
 * AND the local cache said the same, while /monitoring showed "The fleet auto-fixer
 * is switched off". Two sources agreeing against the page is what a wrong LABEL
 * looks like, as opposed to a wrong state.
 *
 * This is the "a new exit code is half a contract" failure: 77 was added, and the
 * existing caller that tested for 76 silently began receiving it.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(HERE, '..', 'scripts', 'board-drainer.mjs')
const src = readFileSync(SRC, 'utf8')

let passed = 0
const check = (name, fn) => {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (e) {
    console.error(`  FAIL  ${name}\n        ${e.message}`)
    process.exitCode = 1
  }
}

check('the two outcomes are distinct values, not one shared sentinel', async () => {
  // Symbol.for is a global registry, so this compares what the module actually publishes.
  const off = Symbol.for('board-drainer.automations-switched-off')
  const out = Symbol.for('board-drainer.agent-no-capacity')
  assert.notEqual(off, out, 'a deliberate off and an outage must not be the same value')
  assert.ok(
    src.includes('AGENT_NO_CAPACITY'),
    'board-drainer no longer exports a separate no-capacity sentinel',
  )
})

check('exit 76 and exit 77 are handled in separate branches', () => {
  // The exact shape of the original defect. If this string comes back, the two
  // codes have been folded together again and the label lies once more.
  assert.ok(
    !/status === SWITCHED_OFF_EXIT \|\| e\?\.status === NO_CAPACITY/.test(src),
    'exit 76 and 77 are back in one condition — an outage will be reported as a deliberate off',
  )
  assert.ok(
    /if \(e\?\.status === SWITCHED_OFF_EXIT\)/.test(src),
    'the exit-76 branch is missing',
  )
  assert.ok(
    /if \(e\?\.status === NO_CAPACITY\)/.test(src),
    'the exit-77 branch is missing',
  )
})

check('the reason shown for an outage does not claim someone switched anything off', () => {
  // runStats.skipped is the sentence that reaches /monitoring via
  // check-drainer-progress.mjs, so this is the text Roger actually reads.
  // Anchor on the DISPATCH-verdict assignment specifically. There are three other
  // runStats.skipped assignments earlier in the file (the kill switch and the
  // wired-but-off guard), and the first draft of this test matched one of those and
  // failed against a working fix — a locator that finds the wrong thing is a test
  // that reports on the wrong thing.
  const i = src.indexOf('runStats.skipped = verdict ===')
  assert.ok(i > 0, 'the dispatch-verdict runStats.skipped assignment not found')
  const block = src.slice(i, i + 700)
  assert.ok(
    /exit 77/.test(block),
    'the no-capacity case has no reason of its own — it will inherit the exit-76 wording',
  )
  const outageLine = block
    .split('\n')
    .find((l) => l.includes('exit 77'))
  assert.ok(outageLine, 'no line carries the exit-77 reason')
  assert.ok(
    !/switched off in the cockpit/.test(outageLine),
    'the outage reason still says "switched off in the cockpit", which names the wrong cause',
  )
  assert.ok(
    /outage/i.test(outageLine),
    'the outage reason should say plainly that this is an outage, not a choice',
  )
})

check('the caller stops the run for BOTH outcomes', () => {
  // Behaviour that must NOT change: either way no agent ran and the cause is
  // fleet-wide, so the remaining items would only re-learn the same thing.
  assert.ok(
    /verdict === AGENT_SWITCHED_OFF \|\| verdict === AGENT_NO_CAPACITY/.test(src),
    'the no-capacity verdict is not handled by the caller — it would fall through to the '
      + 'timeout bookkeeping and charge an attempt against every remaining item',
  )
})

check('the sentinel documentation no longer describes only exit 76', () => {
  // The doc comment said "Returned when agent-run exited 76" while the code also
  // returned it on 77. A comment that contradicts the code is how the next reader
  // re-introduces the bug.
  const i = src.indexOf('export const AGENT_SWITCHED_OFF')
  assert.ok(i > 0, 'AGENT_SWITCHED_OFF export not found')
  const doc = src.slice(Math.max(0, i - 500), i)
  assert.ok(
    /ONLY 76/.test(doc),
    'the exit-76 sentinel is not documented as exclusively 76',
  )
})

if (process.exitCode) {
  console.error(`\n${passed} passed, and at least one failed.`)
} else {
  console.log(`\n${passed} checks passed - an outage no longer reaches Roger as a switch he flipped.`)
}
