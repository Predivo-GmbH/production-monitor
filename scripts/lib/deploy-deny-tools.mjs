/**
 * THE deny list that keeps an autonomous agent off a production edge function.
 *
 * WHY THIS EXISTS (ChannelMover/docs/INCIDENTS.md, 2026-08-25): production was running a
 * build of `lifecycle-tick` WITHOUT its once-per-person guard, and one customer received
 * the same email twice. Every script in this repo that dispatches a Claude agent hands it
 * WRITE verbs including `Bash(node:*)`, `Bash(npm:*)`, `Bash(npx:*)` and `Bash(pnpm:*)`,
 * every one of which can run `supabase functions deploy` DIRECTLY from the on-disk
 * checkout — stale or not — with none of prod-deploy-guard's allowlist / in-sync /
 * green-CI / probe checks. That is a deployer that ships whatever is in a stale tree, and
 * it can silently undo any fix on any product.
 *
 * WHAT THIS IS AND IS NOT. Deny rules beat the allow list in Claude Code, so this turns
 * "prod-deploy-guard is the only permitted path" from prose into a mechanism for the
 * straightforward direct deploy. It is NOT a jail: an adversarial or careless agent could
 * still shell out from a hand-rolled `node -e`, because `Bash(node:*)` remains granted.
 * The load-bearing control is and remains prod-deploy-guard's own allowlist, which refuses
 * every product function (auth, payments, email, lifecycle-tick, ...) outright.
 *
 * SINGLE HOME. Every dispatcher imports from here. Do not copy this list into a script:
 * a copy is what drifts, and a drifted copy is a hole nobody sees.
 */
export const DEPLOY_DENY_TOOLS = [
  'Bash(supabase functions deploy:*)',
  'Bash(npx supabase functions deploy:*)',
  'Bash(npx -y supabase functions deploy:*)',
  'Bash(npx --yes supabase functions deploy:*)',
  'Bash(npm exec supabase functions deploy:*)',
  'Bash(npm exec -- supabase functions deploy:*)',
  'Bash(pnpm supabase functions deploy:*)',
  'Bash(pnpm dlx supabase functions deploy:*)',
  'Bash(pnpm exec supabase functions deploy:*)',
  'Bash(yarn supabase functions deploy:*)',
  'Bash(yarn dlx supabase functions deploy:*)',
  'Bash(bunx supabase functions deploy:*)',
]

/** The CLI flag pair every dispatcher must pass: its allow list, plus the deny list that
 *  makes prod-deploy-guard the only path to a production edge-function deploy. Exported so
 *  a test can prove the WIRING (that --disallowedTools really is passed), not merely the
 *  content of the list. */
export function agentToolFlags(allowedTools) {
  return ['--allowedTools', allowedTools, '--disallowedTools', DEPLOY_DENY_TOOLS.join(',')]
}

/** The sentence appended to a dispatched agent's system policy, so it is told the rule as
 *  well as blocked by it. A refusal it does not understand becomes a workaround attempt. */
export const DEPLOY_DENY_POLICY_NOTE = '\n\nA DIRECT `supabase functions deploy` (in ANY form: bare, npx, npm exec, pnpm, yarn, bunx) is BLOCKED by the harness itself and will be denied, so do not attempt it. prod-deploy-guard is the only path that can reach production, and it refuses every product function (auth, payments, email, lifecycle-tick, connect-platform, process-queue, ...). A product function that genuinely needs a production deploy is therefore NOT yours to ship: fix it, deploy to STAGING, and ESCALATE the production promotion to Roger. Shipping a product function directly from your checkout is exactly the failure that gave one customer the same email twice on 2026-08-25.'
