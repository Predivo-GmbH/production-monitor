/**
 * Find a Supabase MANAGEMENT token that can actually see a given project.
 *
 * The .mjs twin of lib/supabaseToken.ts — same rule, same reasoning; the split
 * exists only because the Playwright specs are TypeScript and the fleet scripts
 * are plain ESM. Keep the two in step.
 *
 * WHY: a check that pins one token BY NAME is trusting a guess about which
 * account owns a project, and that guess rots quietly — accounts get split (the
 * 2026-07-30 DistributionOS/Valrano split), projects move, tokens get revoked.
 * On 2026-08-30 this guard reported "LaunchReady - HTTP 401" and failed the run,
 * not because anything was wrong with LaunchReady's auth email, but because the
 * name SUPABASE_TOKEN_LAUNCHREADY no longer opens that project. Meanwhile
 * check-supabase-build-currency.mjs read the same account without trouble — it
 * asks every token what it can see rather than trusting a label.
 *
 * So: pinned token first, other tokens second, and ALWAYS say when the pinned
 * one had to be worked around. Silently routing around stale config would trade
 * a false alarm for a blind spot, which is the worse of the two.
 */

/** Token-shaped env vars, matching check-supabase-build-currency.mjs exactly. */
export function managementTokenKeys(env = process.env) {
  return Object.keys(env)
    .filter((k) => /^SUPABASE_TOKEN_|_SUPABASE_ACCESS_TOKEN$|^SUPABASE_ACCESS_TOKEN$/.test(k))
    .filter((k) => Boolean(env[k]))
    .sort()
}

/** Asked at most once per token per process — several projects resolve per run. */
const projectsByToken = new Map()

async function visibleProjects(token) {
  if (projectsByToken.has(token)) return projectsByToken.get(token)
  const pending = (async () => {
    try {
      const res = await fetch('https://api.supabase.com/v1/projects', {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) return new Set() // dead or revoked token simply sees nothing
      const projects = await res.json()
      return new Set((Array.isArray(projects) ? projects : []).map((p) => p.ref).filter(Boolean))
    } catch {
      return new Set()
    }
  })()
  projectsByToken.set(token, pending)
  return pending
}

/** A token refusal, as opposed to anything about the project itself. */
export const isTokenRefused = (status) => status === 401 || status === 403

/**
 * The first management token in `env` that lists `projectRef` as its own.
 * `skip` is the name already tried and refused. null means NO token here can
 * see the project — a different fact from "the pinned one was wrong", and one
 * that needs a person: either the ref is stale or that account's token was
 * never added as a secret.
 */
export async function findTokenForProject(projectRef, env = process.env, skip) {
  for (const key of managementTokenKeys(env)) {
    if (key === skip) continue
    if ((await visibleProjects(env[key])).has(projectRef)) return { key, token: env[key] }
  }
  return null
}

/**
 * What the log says when the PINNED name did not work and a fallback did.
 *
 * WHY THIS IS A FUNCTION AND NOT A TEMPLATE LITERAL (2026-09-01 audit). The line used to be
 * inline in lib/edgeFunctions.ts and read, unconditionally:
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
 * process can see which. The message now names which of the two it is, in words that do not
 * invite the other reading.
 *
 * Pure and exported so it is testable without a network or a secret; kept in step with the
 * identical function in lib/supabaseToken.ts, exactly like the rest of this twin pair.
 */
export function pinnedTokenNote({ projectRef, pinnedKey, hadToken, fallbackKey }) {
  const cause = hadToken
    ? `${pinnedKey ?? 'the token this check was handed'} was REFUSED for this project`
    : `NO management token was supplied for this project — the pinned secret name resolves to nothing, so no credential was ever sent`
  return `[supabase] ${projectRef}: ${cause}; used ${fallbackKey} instead. The pinned name should be repaired.`
}
