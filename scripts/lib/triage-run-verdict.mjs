/**
 * A triage run that produced nothing must not ping green.
 *
 * WHY (2026-09-02 monitoring audit, the "success for doing nothing" pass). Both local triage
 * runners judged their own health by whether `main()` resolved. `main()` resolves whether or not
 * the agent inside it did any work, because both of them deliberately SWALLOW the agent's failure
 * so one broken run cannot loop every twenty minutes:
 *
 *   local-triage-runner.mjs   catch (e) { log(`guard-triage agent errored/timed out: …`) }
 *   local-triage-runner.mjs   catch (e) { log(`agent-triage errored/timed out: …`) }
 *
 * The dedup is right and stays. What was wrong is that the swallowed failure then reached the
 * healthcheck as a success: `agenttriage-localrunner` had 457 green pings, and an agent that timed
 * out on every single one of them would have produced exactly the same 457.
 *
 * So the ping is no longer decided by "did the process finish". It is decided by whether each
 * thing this run TRIED to triage came back with the artefact that proves it was triaged — the
 * same rule as the `phase=finish` marker the BackOffice loop runners use, which exists because
 * `claude -p` exits 0 after doing nothing at all.
 *
 * THREE OUTCOMES, and the middle one is the whole point:
 *
 *   idle       nothing was failing, so nothing was triaged  -> GREEN, and it must stay green.
 *              This is most runs. An alarm that goes red on a quiet twenty minutes is an alarm
 *              that gets muted, and then the real one is not heard either.
 *   worked     everything this run attempted produced its proof -> GREEN.
 *   unproven   at least one attempt produced no proof -> RED. The runner ran; the work did not
 *              happen; those are different facts and only one of them was ever reported.
 *
 * A DELIBERATE OFF PINGS NOTHING, not green and not red (contract §7, exit 76/77). It is neither
 * a success nor a failure, and colouring the check either way teaches Roger that his own switch
 * breaks the monitoring.
 */

/** @typedef {{ what: string, proved: boolean, reason?: string }} TriageAttempt */

/**
 * @param {TriageAttempt[]} attempts  one entry per thing this run tried to triage
 * @param {{ switchedOff?: boolean }} [opts]
 * @returns {{ verdict: 'switched-off'|'idle'|'worked'|'unproven', ping: 'none'|'success'|'fail', summary: string }}
 */
export function triageRunVerdict(attempts, opts = {}) {
  const list = Array.isArray(attempts) ? attempts : []

  if (opts.switchedOff) {
    return {
      verdict: 'switched-off',
      ping: 'none',
      summary: 'automations are switched off in the cockpit — no ping either way, because a deliberate off is not a health signal',
    }
  }

  if (list.length === 0) {
    return {
      verdict: 'idle',
      ping: 'success',
      summary: 'nothing was failing, so nothing needed triage — a quiet run is the correct answer, not a broken one',
    }
  }

  const unproven = list.filter((a) => !a.proved)
  if (unproven.length) {
    const named = unproven.map((a) => `${a.what} (${a.reason || 'no proof of work'})`).join('; ')
    return {
      verdict: 'unproven',
      ping: 'fail',
      summary: `${unproven.length} of ${list.length} triage attempt(s) produced no proof of work: ${named}`,
    }
  }

  return {
    verdict: 'worked',
    ping: 'success',
    summary: `${list.length} triage attempt(s), every one of them proved by its own output`,
  }
}

/**
 * Did THIS guard run leave the verdict file its policy demands?
 *
 * The prompt's FINAL ACTION is non-negotiable: write `guard-triage-verdict.json` with a
 * `verdicts` array. An absent file, an unparseable one, or an empty array all mean the agent
 * stopped before it finished — which is precisely what a weekly-limit stop, an expired login and
 * a wall-clock timeout look like from outside, and all three exit 0.
 *
 * Read as data, never trusted as instruction: only the SHAPE is inspected here.
 *
 * @param {string|null|undefined} raw  the file's contents, or null/undefined if it is not there
 * @returns {{ proved: boolean, reason: string }}
 */
export function guardVerdictProof(raw) {
  if (raw === null || raw === undefined) {
    return { proved: false, reason: 'the agent wrote no guard-triage-verdict.json' }
  }
  let parsed
  try { parsed = JSON.parse(raw) } catch {
    return { proved: false, reason: 'guard-triage-verdict.json is not readable JSON' }
  }
  if (!parsed || !Array.isArray(parsed.verdicts)) {
    return { proved: false, reason: 'guard-triage-verdict.json carries no verdicts array' }
  }
  if (parsed.verdicts.length === 0) {
    return { proved: false, reason: 'guard-triage-verdict.json carries an EMPTY verdicts array — an empty answer is not an answer' }
  }
  return { proved: true, reason: `${parsed.verdicts.length} verdict(s) written` }
}
