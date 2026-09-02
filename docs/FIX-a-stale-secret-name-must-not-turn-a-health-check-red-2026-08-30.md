# A stale secret NAME must not turn a health check red

**Closed 2026-09-02.** Work-board row: *"Two health checks alarm on a dead password while a working one sits unused"*
(`two-health-checks-alarm-on-a-dead-password-while-a-worki`, raised by the monitoring feed 2026-08-30).

## What Roger saw

The hourly Production Monitor went red on 2026-08-27 and stayed red. The Auth Email Config
Guard failed in the same way in its own workflow. Both said a credential had been refused.
Neither of them was wrong about the refusal — and neither of them needed a new credential,
because a credential that could do the job was already sitting in the same environment,
under a different name.

## What was actually broken

Every check that talks to the Supabase Management API had a secret **pinned by name**. A
pinned name is a guess about which account owns a project, and account ownership moved:

- `YTMIGRATION_SUPABASE_ACCESS_TOKEN` was pinned for project `qswluvqunswggfmesdcs`
  (ChannelMover) and returned 401 from 2026-08-27. The token that actually owns that project,
  `SUPABASE_TOKEN_CHANNELMOVER`, was present in the same environment the whole time and was
  never tried.
- The Auth Email Config Guard hit the identical shape on LaunchReady: the pinned
  `SUPABASE_TOKEN_LAUNCHREADY` was refused for a ref that another token could read fine.

So two checks alarmed for a credential nobody had to mint, while a working one sat unused.

Then it got worse before it got better. On 2026-08-30 the dead secret was **deleted** from the
repo. In a workflow an unset secret expands to an empty string, so the pinned name resolved to
nothing — and the code reported that the *token* had been refused. It had not: no token had been
sent at all. That single wrong word cost two more nights chasing a token that did not need to exist.

## The fix

**A pinned token is now a hint, not a fact.** `lib/supabaseToken.ts` asks every token-shaped
variable in the environment which projects it can actually see, and uses the one that owns the
project. The name is only where it starts looking.

```ts
// lib/supabaseToken.ts
export async function findTokenForProject(
  projectRef: string, env: NodeJS.ProcessEnv = process.env, skip?: string,
): Promise<ResolvedToken | null> {
  for (const key of managementTokenKeys(env)) {
    if (key === skip) continue
    const token = env[key]!
    if ((await visibleProjects(token)).has(projectRef)) return { key, token }
  }
  return null
}
```

Two rules fall out of it, and both are enforced by tests:

1. **A fallback is not silence.** When a pinned name stops working, the check still passes
   using the token that works, and it *reports* that the pinned name needs repairing. Working
   around a stale name quietly is how a name stays stale for a year.
2. **"Refused" and "never sent" are different sentences.** `lib/supabaseToken.ts` now says which
   one happened, so a deleted secret can never again be read as a rejected credential:

```ts
const cause = hadToken
  ? `${pinnedKey ?? 'the token this check was handed'} was REFUSED for this project`
  : `NO management token was supplied for this project — the pinned secret name resolves to nothing, so no credential was ever sent`
```

Commits: `5b5e0f6` (2026-08-30, the fallback and the reporting) and `91569b0` (2026-09-01, the
three dead `YTMIGRATION_SUPABASE_ACCESS_TOKEN` env lines removed from `monitor.yml` and the
deleted-vs-refused wording). Both on `origin/master`.

## How we know it holds

- **Auth Email Config Guard**: red on run [33288387258](https://github.com/Predivo-GmbH/production-monitor/actions/runs/33288387258)
  (2026-08-30 02:36, before the fix), then green on
  [33314617083](https://github.com/Predivo-GmbH/production-monitor/actions/runs/33314617083) (13:36, after it),
  [33363039273](https://github.com/Predivo-GmbH/production-monitor/actions/runs/33363039273) and
  [33598178946](https://github.com/Predivo-GmbH/production-monitor/actions/runs/33598178946) (2026-09-02).
- **Production Monitor** run 33620858198 (2026-09-02 10:42): every
  `all deployed edge functions are reachable (auto-discovered)` check passes — BackOffice,
  ReplyFlow, Valrano, SignalScore — and all four ChannelMover checks pass, including
  `full login works and dashboard loads`.
- `node --test test/supabase-token.test.mjs test/pinned-token-note.test.mjs` — 12 passed,
  0 failed, including the case named *"the real 2026-08-30 case: the pinned token is refused,
  a sibling owns the project"* and *"a missing/empty pinned secret is still reported, not
  silently worked around"*.

## What is still red, and why it is NOT this

The Production Monitor was still failing hourly on 2026-09-02, so read the run before
concluding anything from its colour. The three failures are
`tests/ci-health/nightly-gauntlet.spec.ts` for Arivioo/Valrano, Arivioo/ReplyFlow and
Arivioo/BoatBuddy — staging E2E gauntlets that regressed and that auto-retry did not recover.
That is a separate fault with a separate cause. **No credential check is among the failures.**

## The lesson

A secret's NAME is a guess about who owns something; only the API knows. When a check can ask,
it must ask — and when it works around a stale name it must say so, or the workaround becomes
the new silence.
