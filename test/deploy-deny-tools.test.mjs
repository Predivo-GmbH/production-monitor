#!/usr/bin/env node
/**
 * The invariant: NO autonomous agent this repo spawns can deploy a production edge
 * function directly. prod-deploy-guard is the only path, and it refuses every product
 * function outright.
 *
 * The 2026-08-25 ChannelMover incident (ChannelMover/docs/INCIDENTS.md) is what this
 * protects: production ran a build of lifecycle-tick without its once-per-person guard
 * and a customer received the same email twice. On 2026-08-28 the deny list was added to
 * board-drainer.mjs only, while three sibling dispatchers handed out the very same
 * Bash(node:*) / Bash(npm:*) / Bash(npx:*) / Bash(pnpm:*) verbs and kept the hole open.
 * Fixing one caller of a shared mistake is what makes an incident a repeat visitor, so
 * this file asserts the property across EVERY spawner, including ones not written yet.
 */
import assert from 'assert'
import { readdirSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { DEPLOY_DENY_TOOLS, agentToolFlags, DEPLOY_DENY_POLICY_NOTE } from '../scripts/lib/deploy-deny-tools.mjs'

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts')
let n = 0
const t = (name, fn) => { fn(); n++; console.log(`  ok - ${name}`) }

t('the deny list covers every way a shell can reach "supabase functions deploy"', () => {
  for (const form of [
    'supabase functions deploy', 'npx supabase functions deploy', 'npx -y supabase functions deploy',
    'npx --yes supabase functions deploy', 'npm exec supabase functions deploy',
    'npm exec -- supabase functions deploy', 'pnpm supabase functions deploy',
    'pnpm dlx supabase functions deploy', 'pnpm exec supabase functions deploy',
    'yarn supabase functions deploy', 'yarn dlx supabase functions deploy',
    'bunx supabase functions deploy',
  ]) assert.ok(DEPLOY_DENY_TOOLS.includes(`Bash(${form}:*)`), `deny list must cover: ${form}`)
})

t('agentToolFlags actually WIRES the deny list, it does not merely define it', () => {
  const flags = agentToolFlags('Read,Edit')
  assert.deepStrictEqual(flags.slice(0, 2), ['--allowedTools', 'Read,Edit'])
  assert.strictEqual(flags[2], '--disallowedTools')
  assert.strictEqual(flags[3], DEPLOY_DENY_TOOLS.join(','))
})

t('the agent is TOLD the rule as well as blocked by it', () => {
  // A refusal an agent does not understand becomes an attempt to work around the refusal.
  assert.ok(/BLOCKED by the harness/.test(DEPLOY_DENY_POLICY_NOTE))
  assert.ok(/ESCALATE the production promotion to Roger/.test(DEPLOY_DENY_POLICY_NOTE))
})

// ── The property that survives the next script somebody adds ──────────────────
// UPDATED 2026-08-30 — the dispatchers no longer name `claude` at all.
// Every automation now launches through one shim, Cockpit/scripts/agent-run.mjs, which reads
// Roger's on/off and Claude-or-Kimi switches. The old detector looked for the literal string
// `claude` / `CLAUDE_BIN`, so the moment the dispatchers were converted it found 2 instead of 5 -
// and one of those two was a false positive (`owner: 'claude'`). The assertion went red, which is
// the detector doing its job: IT NOTICED THE SHAPE CHANGED RATHER THAN QUIETLY COVERING NOTHING.
// Had it been written loosely enough to keep passing, the deny-list invariant would have stopped
// covering four dispatchers with no signal at all - the exact silent-coverage-loss this file exists
// to prevent. So it is taught the new shape rather than relaxed.
const LAUNCHES_AN_AGENT = [
  /agent-run\.mjs/,                 // the shim - the shape every dispatcher uses from 2026-08-30
  /['"]claude(\.exe)?['"]\s*[,)]/,  // a direct spawn: the argument position, not the word anywhere
  /CLAUDE_BIN/,
]
const spawners = readdirSync(SCRIPTS)
  .filter((f) => f.endsWith('.mjs'))
  .map((f) => ({ f, src: readFileSync(join(SCRIPTS, f), 'utf-8') }))
  .filter((s) => LAUNCHES_AN_AGENT.some((re) => re.test(s.src)))

t('every script that spawns an agent was found (a rename or a shim must not empty this list)', () => {
  // Five is the floor because five is what the fleet has: board-drainer, deploy-failure-triage,
  // ux-scout, agent-triage and local-triage-runner. A number that only ever goes up is not a
  // constraint; this one is here so that a refactor which hides a dispatcher fails loudly.
  assert.ok(spawners.length >= 5, `expected at least 5 spawners, found ${spawners.length}: ${spawners.map((s) => s.f).join(', ')}`)
})

for (const { f, src } of spawners) {
  t(`${f} passes the deny list to the CLI`, () => {
    assert.ok(
      /from '\.\/lib\/deploy-deny-tools\.mjs'/.test(src),
      `${f} spawns the CLI but does not import the shared deny list`,
    )
    assert.ok(
      /agentToolFlags\(/.test(src) || /'--disallowedTools'/.test(src),
      `${f} spawns the CLI but never passes --disallowedTools`,
    )
  })

  t(`${f} does not hand-roll --allowedTools around the guard`, () => {
    // Passing the allow list directly is how the deny list gets silently dropped: the
    // flags must come from agentToolFlags so the two can never be separated.
    const handRolled = /['"]--allowedTools['"]\s*,/.test(src)
    assert.ok(!handRolled, `${f} passes '--allowedTools' directly; use agentToolFlags(allowedTools)`)
  })

  t(`${f} keeps ONE copy of the deny list (the shared module's)`, () => {
    assert.ok(
      !/Bash\(supabase functions deploy:\*\)/.test(src),
      `${f} contains its own copy of the deny list; a copy drifts, import it instead`,
    )
  })
}

console.log(`\n${n} assertions passed.`)
