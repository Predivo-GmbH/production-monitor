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
export default async function globalTeardown(): Promise<void> {
  const email = process.env.TEST_EMAIL || 'healthcheck-test@predivo.ch'
  const prefixes = Object.keys(process.env)
    .filter((k) => k.endsWith('_SUPABASE_URL'))
    .map((k) => k.slice(0, -'_SUPABASE_URL'.length))

  const results = await Promise.all(
    prefixes.map(async (p) => {
      const url = process.env[`${p}_SUPABASE_URL`]
      const serviceRoleKey = process.env[`${p}_SERVICE_ROLE_KEY`]
      const anonKey = process.env[`${p}_ANON_KEY`]
      if (!url || !serviceRoleKey || !anonKey) return `${p}: skipped (missing key)`
      try {
        const ok = await revokeAllSessions(url, serviceRoleKey, anonKey, email)
        return `${p}: ${ok ? 'sessions revoked' : 'revoke failed (non-fatal)'}`
      } catch (e) {
        return `${p}: revoke threw (non-fatal) — ${(e as Error).message}`
      }
    }),
  )

  console.log('[teardown] monitor sign-out:\n  ' + results.sort().join('\n  '))
}
