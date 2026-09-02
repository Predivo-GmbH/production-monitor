import { createClient } from '@supabase/supabase-js'

/**
 * WHY THIS EXISTS (2026-08-29 incident, ScoutCopilot Disk IO alarm):
 *
 * loginViaMagicLink() logs the monitor's test user in and never logs out, so every
 * hourly run left live sessions behind. By the time Supabase alarmed, SEVEN production
 * projects held 111,117 abandoned sessions between them (BackOffice 43,952 with 8 real
 * users; ScoutCopilot 15,824 with 10). auth.sessions + refresh_tokens + mfa_amr_claims
 * had grown to 39 MB on BackOffice alone, on a free-tier instance with 411 MB of RAM,
 * which is what actually drained the Disk IO budget.
 *
 * A monitor must not be the heaviest user of the thing it monitors. This teardown makes
 * every run clean up after itself, so the pile can never build again.
 *
 * HOW: the admin API has no "delete this user's sessions" call, but a global sign-out
 * with any valid access token for that user revokes ALL of their sessions. So we mint one
 * throwaway session and immediately use it to revoke everything, including itself.
 */
export async function revokeAllSessions(
  supabaseUrl: string,
  serviceRoleKey: string,
  anonKey: string,
  email: string,
): Promise<number | null> {
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email })
  if (error || !data?.properties?.hashed_token) return null

  const anon = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { data: session, error: verifyError } = await anon.auth.verifyOtp({
    type: 'magiclink',
    token_hash: data.properties.hashed_token,
  })
  if (verifyError || !session?.session?.access_token) return null

  // scope 'global' revokes every session this user holds, this one included.
  const { error: signOutError } = await admin.auth.admin.signOut(session.session.access_token, 'global')
  return signOutError ? null : 1
}

/**
 * Discovers every project the run touched from its own env (<PREFIX>_SUPABASE_URL plus a
 * matching <PREFIX>_SERVICE_ROLE_KEY and <PREFIX>_ANON_KEY) and revokes the test user's
 * sessions on each. Generic on purpose: a product added to monitor.yml is covered without
 * anyone remembering to add it here.
 *
 * Never throws and never fails the run — a monitor that goes red because its own cleanup
 * hiccuped is a false alarm, and false alarms are what stop getting read.
 */
/**
 * EVERY identity the run logs in as, not just the main one.
 *
 * The 2026-08-29 fix above revoked TEST_EMAIL and stopped there, but the suite signs in as
 * TWO different accounts. tests/backoffice/production-monitor.spec.ts:177 runs a real
 * magic-link login as OTP_TEST_EMAIL, which monitor.yml:237 sets to the IMAP_USER mailbox
 * (noreply@backoffice.predivo.ch) — a different address from the TEST_EMAIL on :245. The
 * spec knows they differ; it calls ensureTestUser() for the second one at :43-44.
 *
 * So the teardown cleaned up one account hourly while the other kept accumulating: 1,682
 * live sessions for noreply@backoffice.predivo.ch on a project with 8 real users, still
 * growing after the "monitor now signs out" fix had shipped. That is why the leak was
 * reported as "not the production-monitor" — the monitor DID sign out, just not as this user.
 *
 * Collect the identities from the same env the specs read, so adding a third login to a spec
 * cannot silently reintroduce the pile.
 */
export function testIdentities(env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates = [
    env.TEST_EMAIL || 'healthcheck-test@predivo.ch',
    env.OTP_TEST_EMAIL,
    // The spec's own fallback when OTP_TEST_EMAIL is unset (spec :22).
    env.IMAP_USER,
  ]
  return [...new Set(candidates.filter((e): e is string => Boolean(e && e.includes('@'))))]
}

export default async function globalTeardown(): Promise<void> {
  const emails = testIdentities()
  const prefixes = Object.keys(process.env)
    .filter((k) => k.endsWith('_SUPABASE_URL'))
    .map((k) => k.slice(0, -'_SUPABASE_URL'.length))

  const pairs = prefixes.flatMap((p) => emails.map((email) => ({ p, email })))

  const results = await Promise.all(
    pairs.map(async ({ p, email }) => {
      const url = process.env[`${p}_SUPABASE_URL`]
      const serviceRoleKey = process.env[`${p}_SERVICE_ROLE_KEY`]
      const anonKey = process.env[`${p}_ANON_KEY`]
      if (!url || !serviceRoleKey || !anonKey) return `${p} ${email}: skipped (missing key)`
      try {
        const ok = await revokeAllSessions(url, serviceRoleKey, anonKey, email)
        // "no such user" is the normal answer for an identity that never logs in on this
        // project, so it is reported plainly rather than as a failure.
        return `${p} ${email}: ${ok ? 'sessions revoked' : 'nothing revoked (no session or no such user)'}`
      } catch (e) {
        return `${p} ${email}: revoke threw (non-fatal) — ${(e as Error).message}`
      }
    }),
  )

  console.log('[teardown] monitor sign-out:\n  ' + results.sort().join('\n  '))
}
