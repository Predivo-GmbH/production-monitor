import { test, expect } from '@playwright/test'
import { loginViaMagicLink, ensureTestUser } from '../../lib/auth'
import { waitForOtpEmail } from '../../lib/imap'
import { createClient } from '@supabase/supabase-js'
import {
  projectRefFromUrl,
  listDeployedFunctions,
  isFunctionReachable,
} from '../../lib/edgeFunctions'

const SITE_URL = process.env.VALRANO_URL || 'https://valrano.com'
const SUPABASE_URL = process.env.VALRANO_SUPABASE_URL || 'https://mkdeftmubrkseyrrbzvp.supabase.co'
const SERVICE_ROLE_KEY = process.env.VALRANO_SERVICE_ROLE_KEY!
const ANON_KEY = process.env.VALRANO_ANON_KEY!
const TEST_EMAIL = process.env.TEST_EMAIL || 'healthcheck-test@predivo.ch'

// Shared IMAP config for OTP email delivery verification
const IMAP_HOST = process.env.IMAP_HOST || 'tertia.sui-inter.net'
const IMAP_PORT = parseInt(process.env.IMAP_PORT || '993')
const IMAP_USER = process.env.IMAP_USER || ''
const IMAP_PASS = process.env.IMAP_PASS || ''
const OTP_TEST_EMAIL = process.env.OTP_TEST_EMAIL || IMAP_USER

const IMAP_OPTS = {
  host: IMAP_HOST,
  port: IMAP_PORT,
  user: IMAP_USER,
  pass: IMAP_PASS,
}

test.describe('Valrano — Production Monitor', () => {
  test.beforeAll(async () => {
    // The monitor's own sign-in identity. Seeded here for the same reason every other product
    // seeds it: the login test must establish its own precondition rather than depend on
    // whatever the production auth table happens to hold this hour.
    await ensureTestUser(SUPABASE_URL, SERVICE_ROLE_KEY, TEST_EMAIL)
    if (OTP_TEST_EMAIL && OTP_TEST_EMAIL !== TEST_EMAIL) {
      await ensureTestUser(SUPABASE_URL, SERVICE_ROLE_KEY, OTP_TEST_EMAIL)
    }
  })

  test('landing page loads', async ({ page }) => {
    await page.goto(SITE_URL)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('body')).not.toBeEmpty()
  })

  test('site identity — title contains Valrano', async ({ page }) => {
    await page.goto(SITE_URL, { waitUntil: 'networkidle' })
    const title = await page.title()
    const body = await page.textContent('body')
    const combined = `${title} ${body}`.toLowerCase()
    expect(combined, 'valrano.com must contain "valrano" branding').toContain('valrano')
  })

  test('no console errors on landing page', async ({ page }) => {
    const errors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text())
    })
    await page.goto(SITE_URL)
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(2000)
    const criticalErrors = errors.filter(
      (e) => !e.includes('favicon') && !e.includes('manifest') && !e.includes('third-party') && !e.includes('Content Security Policy') && !e.includes('X-Frame-Options'),
    )
    expect(criticalErrors, `Console errors: ${criticalErrors.join('; ')}`).toHaveLength(0)
  })

  // ── Edge function reachability — catches missing deploys after migration ──

  test('send-auth-email edge function is reachable', async ({ request }) => {
    const response = await request.fetch(
      `${SUPABASE_URL}/functions/v1/send-auth-email`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        data: {},
      }
    )
    const status = response.status()
    // ANY 5xx, not only 500. A gateway that cannot reach the function answers 502/503/504,
    // and `status !== 500` passed every one of those - the same defect that let the 2026-09-01
    // auth outage read as healthy for twenty hours (see lib/edgeFunctions.ts, which got this
    // right, and BackOffice health-monitor/verdict.ts otpWorkingFrom).
    expect(
      status !== 404 && status < 500,
      `send-auth-email returned ${status} — not deployed or crashed`
    ).toBe(true)
  })

  test.describe('Edge Functions Reachable', () => {
    const ACCESS_TOKEN = process.env.VALRANO_SUPABASE_ACCESS_TOKEN

    // Auto-discovered, not hardcoded: ask Supabase what is ACTUALLY deployed and
    // verify each function responds. Add/remove a function and this test follows
    // automatically — there is no list to keep in sync, so an intentional
    // removal can never leave a stale entry behind a false 404 alarm.
    test('all deployed edge functions are reachable (auto-discovered)', async () => {
      // No assertion that ACCESS_TOKEN is set: the token NAME is only a hint about
      // which account owns this project, and listDeployedFunctions falls back to any
      // management token that can actually see the ref. Demanding this exact name is
      // what turned one stale label into an hourly red run (lib/supabaseToken.ts).
      const ref = projectRefFromUrl(SUPABASE_URL)
      const deployed = await listDeployedFunctions(ref, ACCESS_TOKEN)
      expect(deployed.length, 'No edge functions discovered for project').toBeGreaterThan(0)

      const results = await Promise.all(
        deployed.map((slug) => isFunctionReachable(SUPABASE_URL, slug)),
      )
      // A 401/403 means the gateway answered and the function never ran, so its boot health is
      // unknown. Not a failure - nothing is known to be wrong - but not proof either, and the run
      // says which ones rather than letting them pass as verified (2026-09-01 audit).
      const unexercised = results.filter((r) => r.reachable && r.exercised === false)
      if (unexercised.length) {
        console.log(`  NOT EXERCISED (gateway rejected the probe, boot health unknown): ${unexercised.map((r) => r.slug).join(', ')}`)
      }
      const unreachable = results.filter((r) => !r.reachable)
      expect(
        unreachable,
        `Deployed functions not answering (missing or 5xx): ${unreachable.map((r) => `${r.slug} [${r.status}]${r.detail ? ' ' + r.detail : ''}`).join(', ')}`,
      ).toEqual([])
    })
  })

  // ── Real sign-in, in a real browser ─────────────────────────────

  test('full login works and dashboard loads', async ({ page }) => {
    await loginViaMagicLink(page, {
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_ROLE_KEY,
      anonKey: ANON_KEY,
      testEmail: TEST_EMAIL,
      siteUrl: SITE_URL,
    })

    // WHY THIS WAITS FOR A ROUTE INSTEAD OF ONLY ASSERTING not.toContain('/auth').
    //
    // Every other product's login test ends on `expect(url).not.toContain('/auth')`. On Valrano
    // that assertion proves NOTHING: this app signs in at /login, and the magic link redirects to
    // '/', which is the public landing page. A run where the session was never established
    // therefore sits on 'https://valrano.com/' — a URL containing neither '/auth' nor '/login'
    // — and the assertion passes with nobody logged in. That is the same shape of defect as the
    // /auth/v1/otp probe this monitoring exists to replace.
    //
    // What actually proves a session here is that the app ADMITTED us. '/' wraps the landing page
    // in RedirectIfAuthenticated (src/components/auth/RedirectIfAuthenticated.tsx), so a real
    // session moves it to /dashboard; ProtectedRoute sends anyone without one back to /login. A
    // user who has not finished the wizard is forwarded on by OnboardingGuard to /onboarding —
    // also behind ProtectedRoute, so either destination proves the session is real.
    // ROOT CAUSE OF THE FIRST LIVE FAILURE (2026-09-01), recorded because the symptom lied.
    // This line read as a dashboard-or-onboarding route followed by a word-boundary escape and held a literal 0x08
    // BACKSPACE byte on disk where that word-boundary escape should have been - the same class of corruption as
    // the BEL byte that silently broke all eight agent-run wrappers on 2026-08-31. The regex
    // therefore demanded a control character after the route name, could never match any URL,
    // and timed out twice for 20s while the login was working perfectly: the failure artifact
    // shows the onboarding wizard rendered, which only exists behind ProtectedRoute.
    //
    // So the assertion no longer hangs on a URL at all. It waits for something a signed-in
    // person can SEE, then reads the session back out of the browser. A URL is a symptom of
    // being logged in; the session is the claim.
    await expect(
      page.getByRole('button', { name: /skip setup/i })
        .or(page.getByRole('heading', { level: 1 }))
        .first(),
      'a signed-in session must render something behind ProtectedRoute',
    ).toBeVisible({ timeout: 20_000 })
    await page.waitForLoadState('networkidle')

    const hasSession = await page.evaluate(() =>
      Object.keys(localStorage).some(
        (k) => k.startsWith('sb-') && k.endsWith('-auth-token') && !!localStorage.getItem(k),
      ),
    )
    expect(hasSession, 'a real Supabase session must exist after the magic link').toBe(true)
    const url = page.url()
    expect(url, 'a signed-in session must not be sitting on an auth route').not.toMatch(/\/(login|signup|auth)(?![a-z])/)
  })

  // ── Login form rendering — NOT a login (see the test above for that) ─────

  test('login form: fields accept input and opacity > 0', async ({ page }) => {
    // NO PASSWORD GATE. This test used to set localStorage 'bs_unlocked' to "bypass Valrano's
    // PasswordGate". That component no longer exists: `grep -rn PasswordGate` over the Valrano
    // repo finds it only in legacy e2e specs and pre-2026-08 docs, and docs/FEATURES.md records
    // it as removed in favour of Supabase auth. The bypass was writing a key nothing reads.
    // Reload-retry: a deploy-in-progress (Metanet FTP file swap) can briefly
    // serve a partial SPA with no login form. Reload a few times before failing,
    // so a transient mid-deploy moment self-heals instead of alerting. A
    // genuinely broken form still fails the final assertion below.
    const emailInput = page.locator('input[type="email"]').first()
    let rendered = false
    for (let attempt = 0; attempt < 3 && !rendered; attempt++) {
      await page.goto(`${SITE_URL}/login`, { waitUntil: 'networkidle' })
      rendered = await emailInput
        .waitFor({ state: 'visible', timeout: 8_000 })
        .then(() => true)
        .catch(() => false)
      if (!rendered) await page.waitForTimeout(3_000)
    }
    await expect(emailInput).toBeVisible({ timeout: 5_000 })

    const opacity = await emailInput.evaluate(
      (el: HTMLElement) => parseFloat(getComputedStyle(el).opacity),
    )
    expect(opacity, 'Login email input must have opacity > 0').toBeGreaterThan(0)

    await emailInput.fill('test-monitor@example.com')
    expect(await emailInput.inputValue()).toBe('test-monitor@example.com')
  })

  // ── E2E OTP Email Delivery Verification (IMAP) ─────────────────────

  test('E2E OTP: trigger email → verify IMAP delivery → check OTP format', async ({ page }) => {
    test.skip(!IMAP_PASS, 'IMAP_PASS not configured — skipping E2E OTP email delivery test')
    test.setTimeout(150_000)

    const anonClient = createClient(SUPABASE_URL, ANON_KEY)
    const { error } = await anonClient.auth.signInWithOtp({
      email: OTP_TEST_EMAIL,
      options: { shouldCreateUser: false },
    })

    if (error?.message?.includes('security purposes') || error?.message?.includes('rate')) {
      await new Promise((r) => setTimeout(r, 10_000))
      const retry = await anonClient.auth.signInWithOtp({
        email: OTP_TEST_EMAIL,
        options: { shouldCreateUser: false },
      })
      if (retry.error) {
        test.skip(true, `OTP request rate-limited: ${retry.error.message}`)
        return
      }
    } else if (error) {
      throw new Error(`signInWithOtp failed: ${error.message}`)
    }

    let email: Awaited<ReturnType<typeof waitForOtpEmail>>
    try {
      email = await waitForOtpEmail(IMAP_OPTS, { timeoutMs: 90_000, deleteAfter: true, subjectFilter: 'Valrano' })
    } catch {
      throw new Error(
        'OTP email NOT delivered within 90s — send-auth-email chain is broken. ' +
        'Check: pg_net Authorization header, edge function signature guard, SMTP credentials.'
      )
    }

    expect(email.otp, 'Email should contain a 6-digit OTP code').toBeTruthy()
    expect(email.otp).toMatch(/^\d{6}$/)
    expect(email.from, 'OTP email must have a sender address').toBeTruthy()
    expect(email.subject).toContain(email.otp!)
  })
})
