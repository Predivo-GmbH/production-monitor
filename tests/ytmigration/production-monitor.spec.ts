import { test, expect } from '@playwright/test'
import { loginViaMagicLink, ensureTestUser } from '../../lib/auth'
import { waitForOtpEmail } from '../../lib/imap'
import { createClient } from '@supabase/supabase-js'
import {
  projectRefFromUrl,
  listDeployedFunctions,
  isFunctionReachable,
} from '../../lib/edgeFunctions'
import { fetchRouteManifest, checkPublicRoutes } from '../../lib/publicRoutes'

const SITE_URL = process.env.YTMIGRATION_URL || 'https://channelmover.com'
const SUPABASE_URL = process.env.YTMIGRATION_SUPABASE_URL!
const SERVICE_ROLE_KEY = process.env.YTMIGRATION_SERVICE_ROLE_KEY!
const ANON_KEY = process.env.YTMIGRATION_ANON_KEY!
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

test.describe('ChannelMover — Production Monitor', () => {
  test.beforeAll(async () => {
    await ensureTestUser(SUPABASE_URL, SERVICE_ROLE_KEY, TEST_EMAIL)
    if (OTP_TEST_EMAIL && OTP_TEST_EMAIL !== TEST_EMAIL) {
      await ensureTestUser(SUPABASE_URL, SERVICE_ROLE_KEY, OTP_TEST_EMAIL)
    }
  })

  // ── Existing tests ──────────────────────────────────────────────────

  test('full login works and dashboard loads', async ({ page }) => {
    await loginViaMagicLink(page, {
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_ROLE_KEY,
      anonKey: ANON_KEY,
      testEmail: TEST_EMAIL,
      siteUrl: SITE_URL,
    })
    await page.waitForLoadState('networkidle')
    const url = page.url()
    expect(url).not.toContain('/auth')
  })

  // ── Public routes: manifest-driven ──────────────────────────────────
  // Every public route is smoke-tested from the deployed manifest at
  // ${SITE_URL}/monitor-routes.json, generated from ChannelMover's single
  // source of truth (scripts/monitor-routes.mjs). Adding or removing a public
  // route there updates this automatically — no spec edit — so a removed page
  // can never leave a stale content assertion behind a false alarm. The
  // project's deploy gate (scripts/check-monitor-routes.mjs) keeps that list
  // honest against the app/ filesystem.
  test('public routes from manifest load and render (not 404/empty)', async ({ page, request }) => {
    // Manifest fetch + per-route render checks live in lib/publicRoutes.ts so
    // all projects share one correct implementation (no per-spec drift).
    const { isJsonManifest, status, contentType, manifest } = await fetchRouteManifest(request, SITE_URL)
    test.skip(!isJsonManifest, `monitor-routes.json not deployed yet (got ${status} ${contentType || 'no content-type'})`)
    expect((manifest!.routes ?? []).length, 'manifest contains no routes').toBeGreaterThan(0)
    const failures = await checkPublicRoutes(page, SITE_URL, manifest!)
    expect(failures, `Public route checks failed:\n${failures.join('\n')}`).toEqual([])
  })

  test('auth login page loads', async ({ page }) => {
    await page.goto(`${SITE_URL}/auth/login`)
    await page.waitForLoadState('networkidle')
    // ChannelMover uses Google OAuth — verify the page loads with sign-in content
    await expect(page.locator('body')).not.toBeEmpty()
    const text = await page.locator('body').textContent()
    expect((text || '').length).toBeGreaterThan(50)
  })

  test('migrate page shows sign-in prompt without auth', async ({ page }) => {
    // Visit /migrate without auth — shows empty state with "Sign In Required"
    await page.goto(`${SITE_URL}/migrate`, { waitUntil: 'networkidle' })
    await expect(page.locator('body')).not.toBeEmpty()
    const text = await page.locator('body').textContent()
    expect((text || '').length).toBeGreaterThan(50)
  })

  test('dashboard loads after login', async ({ page }) => {
    await loginViaMagicLink(page, {
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_ROLE_KEY,
      anonKey: ANON_KEY,
      testEmail: TEST_EMAIL,
      siteUrl: SITE_URL,
    })
    await page.waitForLoadState('networkidle')

    // Should be on dashboard (not auth, not landing)
    const url = page.url()
    expect(url).not.toContain('/auth')

    // Dashboard should have meaningful content
    const body = page.locator('body')
    await expect(body).not.toBeEmpty()
    const text = await body.textContent()
    expect((text || '').length).toBeGreaterThan(50)
  })

  // ── Interaction tests ────────────────────────────────────────────

  test('dashboard data verification — sections and data type labels visible after login', async ({ page }) => {
    await loginViaMagicLink(page, {
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_ROLE_KEY,
      anonKey: ANON_KEY,
      testEmail: TEST_EMAIL,
      siteUrl: SITE_URL,
    })
    await page.waitForLoadState('networkidle')

    const body = page.locator('body')

    // Quota / usage card — always rendered on the dashboard
    await expect(body).toContainText(/items left/i, { timeout: 15_000 })

    // Plan card
    await expect(body).toContainText(/plan/i)

    // Quick-action buttons present on the dashboard
    await expect(body).toContainText(/accounts/i)

    // Recent activity section
    await expect(body).toContainText(/recent activity/i)
  })

  test('migrate page interaction — wizard UI loads with step indicators and data toggles', async ({ page }) => {
    await loginViaMagicLink(page, {
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_ROLE_KEY,
      anonKey: ANON_KEY,
      testEmail: TEST_EMAIL,
      siteUrl: SITE_URL,
    })
    await page.waitForLoadState('networkidle')

    await page.goto(`${SITE_URL}/migrate`)
    await page.waitForLoadState('networkidle')

    const body = page.locator('body')

    // Migration wizard heading (ScreenHeader title="Migration Wizard")
    await expect(body).toContainText(/migration wizard/i, { timeout: 15_000 })

    // Step 1 and 2 labels from YTStepIndicator
    await expect(body).toContainText(/source/i)
    await expect(body).toContainText(/destination/i)

    // Step 3 — data type toggles (YTToggleRow labels)
    await expect(body).toContainText(/subscriptions/i)
    await expect(body).toContainText(/playlists/i)

    // "Review & Start" CTA button must be present (may be disabled, still rendered)
    await expect(body).toContainText(/review & start/i)
  })

  test('pricing page interaction — 3 tiers with prices, feature lists, and CTA buttons', async ({ page }) => {
    await page.goto(`${SITE_URL}/pricing`)
    await page.waitForLoadState('networkidle')

    const body = page.locator('body')

    // Tier names from PRICING array in pricing.tsx
    await expect(body).toContainText('Free')
    await expect(body).toContainText('Standard')
    await expect(body).toContainText('Pro')

    // Prices — $0, $4.99, $7.99
    await expect(body).toContainText('$0')
    await expect(body).toContainText('$4.99')
    await expect(body).toContainText('$7.99')

    // Feature list items
    await expect(body).toContainText(/subscriptions transfer/i)
    await expect(body).toContainText(/50 items included/i)
    await expect(body).toContainText(/playlists with all videos/i)

    // CTA buttons rendered for each tier
    await expect(body).toContainText('Get Started')
    await expect(body).toContainText('Choose Standard')
    await expect(body).toContainText('Choose Pro')

    // Top-Up Packs section
    await expect(body).toContainText(/top-up packs/i)

    // Verify "Get Started" CTA is clickable (exists and is not hidden)
    const getStartedBtn = page.locator('text=Get Started').first()
    await expect(getStartedBtn).toBeVisible({ timeout: 10_000 })
    await getStartedBtn.click()
    // After click, should navigate toward auth login (Google OAuth page)
    await page.waitForLoadState('networkidle')
    const urlAfterClick = page.url()
    // NOT `|channelmover.com`: SITE_URL IS channelmover.com, so that alternative matched before the
    // click and after any navigation at all. Both CTAs call router.push('/auth/login').
    expect(urlAfterClick, 'the pricing CTA must navigate to /auth/login').toMatch(/\/auth\/login/)
  })

  // (extension page interaction test removed — extension retired, see note above)

  test('guide page interaction — step-by-step guide content with data type sections', async ({ page }) => {
    await page.goto(`${SITE_URL}/guide/youtube-account-migration`)
    await page.waitForLoadState('networkidle')

    const body = page.locator('body')

    // Guide must have substantial content
    const text = await body.textContent()
    expect((text || '').length).toBeGreaterThan(500)

    // Data type sections from DATA_TYPES array in the guide page
    await expect(body).toContainText('Subscriptions', { timeout: 10_000 })
    await expect(body).toContainText('Playlists')
    await expect(body).toContainText('Liked Videos')
    await expect(body).toContainText('Watch History')

    // Comparison methods section (METHODS array)
    await expect(body).toContainText(/manual/i)
    await expect(body).toContainText(/google takeout/i)

    // YouTube migration context
    await expect(body).toContainText(/youtube/i)
    await expect(body).toContainText(/migration/i)
  })

  test('site identity — title contains channelmover branding', async ({ page }) => {
    await page.goto(SITE_URL, { waitUntil: 'networkidle' })
    const title = await page.title()
    const body = await page.textContent('body')
    const combined = `${title} ${body}`.toLowerCase()
    expect(
      combined.includes('channelmover') || combined.includes('channel mover'),
      'channelmover.com must contain "channelmover" branding',
    ).toBe(true)
  })

  test('CSP connect-src includes correct Supabase ref', async () => {
    // Use curl via child_process — Playwright and Node fetch both miss headers in GitHub Actions CI
    const { execSync } = await import('child_process')
    const headers = execSync(`curl -sI "${SITE_URL}"`, { encoding: 'utf-8' })
    const cspLine = headers.split('\n').find((l) => l.toLowerCase().startsWith('content-security-policy'))
    const csp = cspLine ? cspLine.replace(/^[^:]+:\s*/, '').trim() : ''
    expect(csp, 'CSP header or meta tag must be present').toBeTruthy()

    const connectSrc = csp
      .split(';')
      .map((d) => d.trim())
      .find((d) => d.startsWith('connect-src'))

    expect(connectSrc, 'CSP must contain a connect-src directive').toBeTruthy()
    expect(
      connectSrc,
      'connect-src must include the correct Supabase project ref',
    ).toContain('qswluvqunswggfmesdcs.supabase.co')
  })

  test('landing page CTA flow — hero buttons present and Get Started navigates to auth', async ({ page }) => {
    // Landing page is at /landing (unauthenticated public page)
    await page.goto(`${SITE_URL}/landing`)
    await page.waitForLoadState('networkidle')

    const body = page.locator('body')

    // Hero headline from landing.tsx
    await expect(body).toContainText(/switch youtube accounts/i, { timeout: 10_000 })

    // Hero CTA buttons: "Get Started Free" and "See How It Works"
    await expect(body).toContainText(/get started free/i)
    await expect(body).toContainText(/see how it works/i)

    // Trust line beneath hero CTAs
    await expect(body).toContainText(/no credit card required/i)

    // Pricing section on landing page (section-pricing)
    await expect(body).toContainText(/simple, item-based pricing/i)

    // Click the primary hero "Get Started Free" CTA
    const heroBtn = page.locator('[accessibilityLabel="Get started free"]').first()
    const heroBtnAlt = page.locator('text=Get Started Free').first()
    const target = (await heroBtn.count()) > 0 ? heroBtn : heroBtnAlt
    await expect(target).toBeVisible({ timeout: 10_000 })
    await target.click()
    await page.waitForLoadState('networkidle')

    // Should navigate to /auth/login (Google OAuth sign-in page)
    const urlAfter = page.url()
    // Same as the pricing CTA above: the site's own domain can never be evidence that a click worked.
    expect(urlAfter, 'the hero CTA must navigate to /auth/login').toMatch(/\/auth\/login/)
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
    const ACCESS_TOKEN = process.env.YTMIGRATION_SUPABASE_ACCESS_TOKEN

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

  // ── Real Login Form Interaction (not magic link bypass) ─────────────

  test('login form: fields accept input and opacity > 0', async ({ page }) => {
    await page.goto(`${SITE_URL}/auth/login`, { waitUntil: 'networkidle' })

    // ChannelMover uses Google OAuth — check for email input or Google sign-in button
    const emailInput = page.locator('input[type="email"]').first()
    const googleBtn = page.locator('button:has-text("Google"), a:has-text("Google"), button:has-text("Sign in")').first()

    const hasEmail = await emailInput.isVisible().catch(() => false)
    const hasGoogle = await googleBtn.isVisible().catch(() => false)

    expect(hasEmail || hasGoogle, 'Login page must have email input or Google sign-in').toBe(true)

    if (hasEmail) {
      const opacity = await emailInput.evaluate(
        (el: HTMLElement) => parseFloat(getComputedStyle(el).opacity),
      )
      expect(opacity, 'Login email input must have opacity > 0').toBeGreaterThan(0)
      await emailInput.fill('test-monitor@example.com')
      expect(await emailInput.inputValue()).toBe('test-monitor@example.com')
    }
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
      email = await waitForOtpEmail(IMAP_OPTS, { timeoutMs: 90_000, deleteAfter: true, subjectFilter: 'ChannelMover' })
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
