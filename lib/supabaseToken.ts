/**
 * Find a Supabase MANAGEMENT token that can actually see a given project.
 *
 * WHY: every management-API check used to pin one token BY NAME —
 * `YTMIGRATION_SUPABASE_ACCESS_TOKEN` for ChannelMover, `SUPABASE_TOKEN_<ACCT>`
 * for the auth-email guard. A name is a GUESS about which account owns a
 * project, and that guess goes stale on its own: accounts get split (the
 * 2026-07-30 DistributionOS/Valrano split), projects get moved, tokens get
 * revoked. Nothing in the repo changes when that happens, so the check keeps
 * confidently presenting a token the project no longer accepts.
 *
 * That is exactly what reddened the monitor EVERY HOUR from 2026-08-27: the
 * pinned `YTMIGRATION_SUPABASE_ACCESS_TOKEN` answered 401 for project
 * `qswluvqunswggfmesdcs`, while `SUPABASE_TOKEN_CHANNELMOVER` — sitting in the
 * same environment, in the same repo's secrets — read that very project without
 * complaint (the auth-email guard audited it in the same fleet run). The alarm
 * was not about production at all; it was about a stale label.
 *
 * `check-supabase-build-currency.mjs` never had this failure mode, because it
 * asks EVERY token what it can see instead of trusting a name. This is that
 * same idea, made reusable: keep the pinned token as the fast path, and when it
 * is refused, ASK the others before going red.
 *
 * A fallback is always REPORTED, never silent. The pinned name is still
 * documentation worth repairing, and a check that quietly routes around its own
 * stale config just moves the rot somewhere nobody is looking.
 */

/**
 * Env vars that hold a Supabase MANAGEMENT (PAT) token. Deliberately the same
 * shapes `check-supabase-build-currency.mjs` accepts, so adding an account's
 * token as a secret is all it takes to cover a new project everywhere at once.
 */
export function managementTokenKeys(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(env)
    .filter((k) => /^SUPABASE_TOKEN_|_SUPABASE_ACCESS_TOKEN$|^SUPABASE_ACCESS_TOKEN$/.test(k))
    .filter((k) => Boolean(env[k]))
    .sort()
}

/**
 * Which project refs a token can see, asked at most once per token per process.
 * Playwright runs 3 workers in one process and several specs resolve at once;
 * without the cache each would re-list the whole fleet for every token.
 */
const projectsByToken = new Map<string, Promise<Set<string>>>()

async function visibleProjects(token: string): Promise<Set<string>> {
  const cached = projectsByToken.get(token)
  if (cached) return cached
  const pending = (async () => {
    try {
      const res = await fetch('https://api.supabase.com/v1/projects', {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) return new Set<string>() // dead or revoked token — it simply sees nothing
      const projects = (await res.json()) as Array<{ ref?: string }>
      return new Set(projects.map((p) => p.ref).filter((r): r is string => Boolean(r)))
    } catch {
      return new Set<string>()
    }
  })()
  projectsByToken.set(token, pending)
  return pending
}

export type ResolvedToken = { key: string; token: string }

/**
 * The first management token in `env` that lists `projectRef` among its own
 * projects. `skip` is the name that was already tried and refused, so a token
 * is never blamed twice for the same request.
 *
 * Returns null when NO token in the environment can see the project. That is a
 * genuinely different fact from "the pinned token was wrong", and the callers
 * say so: it means either the project ref is stale, or this account's token was
 * never added as a secret — both of which need a person, not a retry.
 */
export async function findTokenForProject(
  projectRef: string,
  env: NodeJS.ProcessEnv = process.env,
  skip?: string,
): Promise<ResolvedToken | null> {
  for (const key of managementTokenKeys(env)) {
    if (key === skip) continue
    const token = env[key]!
    if ((await visibleProjects(token)).has(projectRef)) return { key, token }
  }
  return null
}

/**
 * What the log says when the PINNED name did not work and a fallback did.
 *
 * WHY THIS IS A FUNCTION AND NOT A TEMPLATE LITERAL (2026-09-01 audit). The line used to be
 * inline in edgeFunctions.ts and read, unconditionally:
 *
 *   "<key> is no longer accepted for this project; used <fallback> instead."
 *
 * It said that even when NO TOKEN HAD BEEN SUPPLIED AT ALL, because the fallback branch is
 * entered both when the pinned token is REFUSED and when there was never a token to send. Those
 * are different faults with different owners, and conflating them cost two days:
 *
 *   YTMIGRATION_SUPABASE_ACCESS_TOKEN was DELETED from the repo's secrets on 2026-08-30, so
 *   `${{ secrets.YTMIGRATION_SUPABASE_ACCESS_TOKEN }}` expanded to an empty string. The check
 *   read that as "the token was refused", printed "no longer accepted", and the board, two night
 *   shifts and three sessions concluded a live token had died and that only Roger could mint a
 *   replacement. Nothing had died. The name simply pointed at nothing, and a working token for
 *   the same project was sitting in the same environment the whole time.
 *
 * A REFUSED credential may need a person. A MISSING one is a name in our own repo, and this
 * process can see which. The message now names which of the two it is.
 *
 * Twin of pinnedTokenNote in scripts/lib/supabase-token.mjs, where it is unit-tested.
 */
export function pinnedTokenNote({
  projectRef,
  pinnedKey,
  hadToken,
  fallbackKey,
}: {
  projectRef: string
  pinnedKey?: string
  hadToken: boolean
  fallbackKey: string
}): string {
  const cause = hadToken
    ? `${pinnedKey ?? 'the token this check was handed'} was REFUSED for this project`
    : `NO management token was supplied for this project — the pinned secret name resolves to nothing, so no credential was ever sent`
  return `[supabase] ${projectRef}: ${cause}; used ${fallbackKey} instead. The pinned name should be repaired.`
}
