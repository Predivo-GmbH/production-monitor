import { test, expect } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import { ensureTestUser, resolveUserIdByEmail } from '../../lib/auth'

/**
 * JASS-TOUR'S REAL SIGN-IN IS EMAIL + PASSWORD, AND IT IS THE ONLY ONE THIS PRODUCT HAS.
 *
 * ── WHY NOT loginViaMagicLink, WHICH EVERY OTHER SIGNING-IN PRODUCT USES ────────────────────
 *
 * Two independent reasons, the second of them decisive and measured rather than assumed:
 *
 *   1. THE PRODUCT DOES NOT OFFER IT. src/pages/Auth.tsx has three tabs — a shared password
 *      checked by the verify-jass-password edge function, signInWithPassword, and signUp. There
 *      is no signInWithOtp anywhere in jass-tour-ui-kit. A magic-link test would prove a flow no
 *      person can use here.
 *
 *   2. GOTRUE WOULD NOT SEND THE BROWSER TO THE PRODUCT. Measured 2026-09-01 against the live
 *      project by asking /auth/v1/verify to redirect with a deliberately invalid token, which
 *      needs no credential of any kind and reveals exactly how the allowlist treats a URL:
 *
 *        dkxdlovwzsxnepoteebk (Jass-Tour), redirect_to=https://beize-jass-tour.mueller.ro
 *                                       -> Location: http://localhost:3000#error=...
 *        hcfeoescybfngjsphekq (LaunchReady), redirect_to=https://launchready.predivo.ch
 *                                       -> Location: https://launchready.predivo.ch#error=...
 *
 *      An ALLOWED redirect is echoed back; a disallowed one falls back to the project's Site
 *      URL. Jass-Tour's Site URL is still http://localhost:3000 and its production domain is not
 *      in the redirect allowlist, so loginViaMagicLink would navigate the browser to a dev
 *      server that does not exist. The calibration against LaunchReady and Distribution-OS is
 *      part of the evidence on purpose: a probe that has not been run against a KNOWN-GOOD case
 *      only tells you about the probe.
 *
 * ── WHAT THIS TEST PROVES, AND THE TRAP IT AVOIDS ───────────────────────────────────────────
 *
 * src/components/ProtectedRoute.tsx admits anyone carrying sessionStorage['jass-access'] ===
 * 'granted' WITHOUT consulting Supabase, and src/pages/Auth.tsx sets that flag itself the moment
 * signInWithPassword succeeds. So "the dashboard rendered after I submitted the form" is a
 * weaker claim than it looks, and asserting merely that the URL is no longer /auth is weaker
 * still — on Valrano that exact assertion turned out to be vacuous and would have passed a run
 * in which no session was ever created.
 *
 * This test therefore does three things instead of one:
 *   a) it drives the real form in a real browser, so GoTrue decides;
 *   b) it reads the persisted Supabase session back out of localStorage and checks it belongs to
 *      the monitor's user — a session that exists, not a flag that was set;
 *   c) it then hard-navigates to /rangliste with 'jass-access' STRIPPED on every document load,
 *      which forces ProtectedRoute down its supabase.auth.getUser() path. Rangliste exists only
 *      behind ProtectedRoute, so rendering it is entry earned by the session alone.
 *
 * The outer PasswordGate (sessionStorage['jasstour-unlocked']) is set directly here. It is a beta
 * door, not a sign-in, and it is proven separately and honestly by 'wrong site password is
 * refused' in production-monitor.spec.ts.
 *
 * ── WHY THIS IS ITS OWN FILE, WITH TRACING OFF ──────────────────────────────────────────────
 *
 * Playwright records fill() action parameters verbatim into the trace, and monitor.yml uploads
 * test-results/ and playwright-report/ as a 7-day downloadable artifact. With the config's
 * `trace: 'on-first-retry'` in force, one retried run would ship this account's plaintext
 * password into that artifact. `test.use({ trace: 'off' })` is only legal at the top level of a
 * file, so the test that types the credential lives here rather than in
 * production-monitor.spec.ts, which keeps its full diagnostics. Screenshots stay on: a password
 * field renders as dots, so a failure screenshot leaks nothing.
 *
 * The DIRECTORY is what maps a spec to a product (publish-check-results.mjs slugForFile), so
 * splitting the file changes nothing about how these results are published.
 */
test.use({ trace: 'off' })

const SITE_URL = process.env.JASSTOUR_URL || 'https://beize-jass-tour.mueller.ro'
const SUPABASE_URL = process.env.JASSTOUR_SUPABASE_URL || ''
const SERVICE_ROLE_KEY = process.env.JASSTOUR_SERVICE_ROLE_KEY || ''
const TEST_EMAIL = process.env.TEST_EMAIL || 'healthcheck-test@predivo.ch'

/**
 * The monitor user's password on the Jass-Tour project ONLY. Every Supabase project has its own
 * auth.users table, so setting it here cannot touch the same address on any other product — and
 * every other product signs in by magic link, which does not use a password at all.
 *
 * Never written to a file, never echoed into an assertion message, never printed in a log line.
 */
const TEST_PASSWORD = process.env.JASSTOUR_TEST_PASSWORD || ''

const READY = Boolean(SUPABASE_URL && SERVICE_ROLE_KEY && TEST_PASSWORD)

/** Auth.tsx, "Login" tab (German UI). Radix mounts only the ACTIVE tab panel. */
const LOGIN_TAB = '[role="tab"]:has-text("Login")'
const PANEL = '[role="tabpanel"]'

test.describe('Jass-Tour — user password login', () => {
  test.beforeAll(async () => {
    if (!READY) return
    // Establish the precondition rather than depending on whatever the prod project happens to
    // hold: the account exists, is confirmed, and its password is the one this run will type.
    // Same reasoning as lib/auth.ts setUserPlan — a test that assumes state it did not create
    // turns into a false alarm the first time that state drifts.
    await ensureTestUser(SUPABASE_URL, SERVICE_ROLE_KEY, TEST_EMAIL)
    const userId = await resolveUserIdByEmail(SUPABASE_URL, SERVICE_ROLE_KEY, TEST_EMAIL, 'jass-tour password login')
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    const { error } = await admin.auth.admin.updateUserById(userId, {
      password: TEST_PASSWORD,
      email_confirm: true,
    })
    if (error) throw new Error(`could not prepare the monitor account on Jass-Tour: ${error.message}`)
  })

  test('full password login works and dashboard loads', async ({ page }) => {
    // SKIP LOUDLY. A missing secret must read as "not tested", never as a pass — an unrun check
    // reported green is the exact defect product_check_run was created to end. The classifier
    // counts a skip in neither checks_total nor checks_passed, so `login` stays grey.
    test.skip(
      !READY,
      'JASSTOUR_SUPABASE_URL / JASSTOUR_SERVICE_ROLE_KEY / JASSTOUR_TEST_PASSWORD are not all set — the user sign-in was NOT tested',
    )

    // Runs before every document: opens the beta gate, and STRIPS the shortcut flag that
    // ProtectedRoute would otherwise accept in place of a session (see the header).
    await page.addInitScript(() => {
      try {
        sessionStorage.setItem('jasstour-unlocked', 'true')
        sessionStorage.removeItem('jass-access')
      } catch { /* first-party storage unavailable; the assertions below will say so */ }
    })

    await page.goto(`${SITE_URL}/auth`, { waitUntil: 'networkidle' })
    await page.locator(LOGIN_TAB).click()

    const panel = page.locator(PANEL)
    const email = panel.locator('input[type="email"]')
    const password = panel.locator('input[type="password"]')
    await expect(email, 'the Login tab must render an email field').toBeVisible({ timeout: 10_000 })

    await email.fill(TEST_EMAIL)
    await password.fill(TEST_PASSWORD)
    await panel.locator('button[type="submit"]').click()

    // Auth.tsx navigates to '/' only after signInWithPassword returned without an error.
    await expect(
      page.locator('[role="alert"]'),
      'GoTrue refused the monitor account — Jass-Tour cannot sign a real user in',
    ).toHaveCount(0)
    await page.waitForURL((url) => new URL(url.toString()).pathname === '/', { timeout: 20_000 })

    // A SESSION THAT EXISTS, not a flag that was set. supabase-js persists it under
    // localStorage['sb-<ref>-auth-token']; we read back only what is safe to assert on.
    const session = await page.evaluate(() => {
      const key = Object.keys(localStorage).find((k) => /^sb-.*-auth-token$/.test(k))
      if (!key) return { found: false, hasAccessToken: false, email: null as string | null }
      try {
        const parsed = JSON.parse(localStorage.getItem(key) || '{}')
        return {
          found: true,
          hasAccessToken: typeof parsed.access_token === 'string' && parsed.access_token.length > 0,
          email: (parsed.user && parsed.user.email) || null,
        }
      } catch {
        return { found: true, hasAccessToken: false, email: null as string | null }
      }
    })
    expect(session.found, 'no Supabase session was persisted — nothing actually signed in').toBe(true)
    expect(session.hasAccessToken, 'the persisted session carries no access token').toBe(true)
    expect(session.email, 'the session belongs to a different account than the one that signed in').toBe(TEST_EMAIL)

    // The dashboard is the route Auth.tsx sends a signed-in user to.
    await expect(page.locator('#main-content'), 'the app shell must render once signed in').toBeVisible({ timeout: 15_000 })
    await expect(page.locator('h1', { hasText: 'Willkommen' })).toBeVisible({ timeout: 15_000 })

    // THE ASSERTION THAT CANNOT BE VACUOUS. A full document load re-runs the init script above,
    // so 'jass-access' is gone and ProtectedRoute has nothing left but supabase.auth.getUser().
    // /rangliste exists only behind ProtectedRoute; reaching it is the session doing the work.
    await page.goto(`${SITE_URL}/rangliste`, { waitUntil: 'networkidle' })
    await expect(page.locator('h1', { hasText: 'Ewige Rangliste' })).toBeVisible({ timeout: 15_000 })
    expect(
      new URL(page.url()).pathname,
      'ProtectedRoute bounced the signed-in session back to /auth',
    ).toBe('/rangliste')
  })
})
