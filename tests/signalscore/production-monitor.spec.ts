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

const SITE_URL = process.env.SIGNALSCORE_URL || 'https://signalscore.ch'
const SUPABASE_URL = process.env.SIGNALSCORE_SUPABASE_URL!
const SERVICE_ROLE_KEY = process.env.SIGNALSCORE_SERVICE_ROLE_KEY!
const ANON_KEY = process.env.SIGNALSCORE_ANON_KEY!
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

/**
 * Bypass the PasswordGate by setting the sessionStorage key before navigation.
 * The gate checks sessionStorage('signalscore-unlocked') === 'true'.
 */
async function bypassPasswordGate(page: import('@playwright/test').Page, url: string): Promise<void> {
  // Navigate to origin first to establish the storage context, then set the key
  await page.goto(SITE_URL, { waitUntil: 'commit' })
  await page.evaluate(() => sessionStorage.setItem('signalscore-unlocked', 'true'))
  await page.goto(url, { waitUntil: 'networkidle' })
}

/**
 * Login via magic link AND bypass the PasswordGate.
 *
 * The magic link flow navigates through supabase.co then redirects back to the
 * site — this creates a fresh page context where sessionStorage is empty, so
 * the PasswordGate would block the app. We pre-register an initScript so the
 * key is injected on every document (including the redirect target), then
 * perform the magic-link login as normal.
 */
async function loginWithGateBypass(
  page: import('@playwright/test').Page,
  config: { supabaseUrl: string; serviceRoleKey: string; anonKey: string; testEmail: string; siteUrl: string },
): Promise<void> {
  // addInitScript runs before any script on every subsequent navigation,
  // ensuring the PasswordGate state is 'true' from the very first render.
  await page.addInitScript(() => {
    try { sessionStorage.setItem('signalscore-unlocked', 'true') } catch { /* ignore */ }
  })
  await loginViaMagicLink(page, config)
}

test.describe('SignalScore — Production Monitor', () => {
  test.beforeAll(async () => {
    await ensureTestUser(SUPABASE_URL, SERVICE_ROLE_KEY, TEST_EMAIL)
    if (OTP_TEST_EMAIL && OTP_TEST_EMAIL !== TEST_EMAIL) {
      await ensureTestUser(SUPABASE_URL, SERVICE_ROLE_KEY, OTP_TEST_EMAIL)
    }
  })

  // ── Existing tests ──

  // ── Public routes: manifest-driven ──────────────────────────────────
  // Every public route is smoke-tested from the deployed manifest at
  // ${SITE_URL}/monitor-routes.json, generated from SignalScore's single source
  // of truth (scripts/monitor-routes.mjs). Adding/removing a public route there
  // updates this automatically. The build gate (scripts/check-monitor-routes.mjs)
  // keeps the list honest against the prerendered output.
  test('public routes from manifest load and render (not 404/empty)', async ({ page, request }) => {
    // Manifest fetch + per-route render checks live in lib/publicRoutes.ts so
    // all projects share one correct implementation (no per-spec drift).
    const { isJsonManifest, status, contentType, manifest } = await fetchRouteManifest(request, SITE_URL)
    test.skip(!isJsonManifest, `monitor-routes.json not deployed yet (got ${status} ${contentType || 'no content-type'})`)
    expect((manifest!.routes ?? []).length, 'manifest contains no routes').toBeGreaterThan(0)

    // Bypass the client-side PasswordGate on every navigation (persists across
    // the goto()s inside checkPublicRoutes).
    await page.addInitScript(() => {
      try { sessionStorage.setItem('signalscore-unlocked', 'true') } catch { /* ignore */ }
    })

    const failures = await checkPublicRoutes(page, SITE_URL, manifest!)
    expect(failures, `Public route checks failed:\n${failures.join('\n')}`).toEqual([])
  })

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

  // ── Authenticated tests ──

  test('dashboard loads after login', async ({ page }) => {
    await loginViaMagicLink(page, {
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_ROLE_KEY,
      anonKey: ANON_KEY,
      testEmail: TEST_EMAIL,
      siteUrl: SITE_URL,
    })
    await page.waitForLoadState('networkidle')

    if (!page.url().includes('/dashboard')) {
      await page.goto(`${SITE_URL}/dashboard`, { waitUntil: 'networkidle' })
    }

    await expect(page.locator('body')).not.toBeEmpty()
    const text = await page.locator('body').textContent()
    expect((text || '').length).toBeGreaterThan(50)
    // Should not be on auth page
    expect(page.url()).not.toContain('/auth')
  })

  test('settings page loads after login', async ({ page }) => {
    await loginViaMagicLink(page, {
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_ROLE_KEY,
      anonKey: ANON_KEY,
      testEmail: TEST_EMAIL,
      siteUrl: SITE_URL,
    })
    await page.waitForLoadState('networkidle')

    await page.goto(`${SITE_URL}/settings`, { waitUntil: 'networkidle' })

    await expect(page.locator('body')).not.toBeEmpty()
    const text = await page.locator('body').textContent()
    expect((text || '').length).toBeGreaterThan(50)
    expect(page.url()).not.toContain('/auth')
  })

  test('check history page loads after login', async ({ page }) => {
    await loginViaMagicLink(page, {
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_ROLE_KEY,
      anonKey: ANON_KEY,
      testEmail: TEST_EMAIL,
      siteUrl: SITE_URL,
    })
    await page.waitForLoadState('networkidle')

    await page.goto(`${SITE_URL}/dashboard/history`, { waitUntil: 'networkidle' })
    await expect(page.locator('body')).not.toBeEmpty()
    // Page should not redirect to auth
    expect(page.url()).toContain('/dashboard/history')
  })

  // ── Interaction tests ──

  test('company search flow: search input accepts text and shows results or empty state', async ({ page }) => {
    await loginWithGateBypass(page, {
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_ROLE_KEY,
      anonKey: ANON_KEY,
      testEmail: TEST_EMAIL,
      siteUrl: SITE_URL,
    })
    await page.waitForLoadState('networkidle')

    if (!page.url().includes('/dashboard')) {
      await page.goto(`${SITE_URL}/dashboard`, { waitUntil: 'networkidle' })
    }

    // The dashboard shows the CompanySearchInput — look for any input with search-related placeholder or role
    const searchInput = page.locator('input[type="text"], input[placeholder*="ompany" i], input[placeholder*="earch" i], [role="combobox"]').first()
    await expect(searchInput).toBeVisible({ timeout: 15_000 })

    // Type a company name — the input debounces at 2 chars
    await searchInput.fill('Migros')

    // "Migros" MUST return results: it is a guaranteed-present Zefix entry, so
    // an empty state here means the search-companies -> Zefix pipeline (the
    // core product) is down. The old assertion accepted "No companies found."
    // — a full Zefix outage would have passed monitoring (investigation
    // report §7.2). Generous timeout covers debounce + Zefix roundtrip.
    await expect(
      page.locator('[cmdk-group-heading]'),
      'company search for "Migros" returned no results — search-companies/Zefix pipeline down?',
    ).toBeVisible({ timeout: 20_000 })

    // Click the first result and verify company card + "Run Company Check" button appear
    const firstResult = page.locator('[cmdk-item]').first()
    await firstResult.click()
    await page.waitForTimeout(300)

    // After selection, search card is replaced by company detail card with "Run Company Check" button
    await expect(page.locator('button:has-text("Run Company Check")')).toBeVisible({ timeout: 5_000 })
  })

  test('check history: page structure, search input, and status filters render', async ({ page }) => {
    await loginWithGateBypass(page, {
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_ROLE_KEY,
      anonKey: ANON_KEY,
      testEmail: TEST_EMAIL,
      siteUrl: SITE_URL,
    })
    await page.waitForLoadState('networkidle')

    await page.goto(`${SITE_URL}/dashboard/history`, { waitUntil: 'networkidle' })

    // Page heading
    await expect(page.locator('h1:has-text("Check History")')).toBeVisible({ timeout: 10_000 })

    // Search input is rendered
    const historySearch = page.locator('[aria-label="Search credit checks"]')
    await expect(historySearch).toBeVisible({ timeout: 10_000 })

    // Status filter buttons are all present
    await expect(page.locator('button:has-text("All")')).toBeVisible({ timeout: 5_000 })
    await expect(page.locator('button:has-text("Completed")')).toBeVisible({ timeout: 5_000 })
    await expect(page.locator('button:has-text("Failed")')).toBeVisible({ timeout: 5_000 })

    // Either a list of checks rendered or the empty state
    const hasChecks = await page.locator('text=/\\d+ checks?/').isVisible().catch(() => false)
    const hasEmpty = await page.locator('text=No checks yet.').isVisible().catch(() => false)
    const hasFilteredEmpty = await page.locator('text=No checks match your filters.').isVisible().catch(() => false)
    expect(hasChecks || hasEmpty || hasFilteredEmpty).toBe(true)

    // If checks exist, clicking the first one should navigate to the report
    if (hasChecks) {
      // The check rows are <button> elements inside a CardContent div-y
      const firstCheckRow = page.locator('button.flex.w-full.items-center').first()
      const isVisible = await firstCheckRow.isVisible().catch(() => false)
      if (isVisible) {
        await firstCheckRow.click()
        await page.waitForLoadState('networkidle')
        // Should navigate to /dashboard/check/:id
        expect(page.url()).toMatch(/\/dashboard\/check\//)
        // The report page shows a back button and the subject name
        await expect(page.locator('body')).not.toBeEmpty()
        const text = await page.locator('body').textContent()
        expect((text || '').length).toBeGreaterThan(50)
      }
    }
  })

  test('dashboard data: heading, search card, and recent checks section all render', async ({ page }) => {
    await loginWithGateBypass(page, {
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_ROLE_KEY,
      anonKey: ANON_KEY,
      testEmail: TEST_EMAIL,
      siteUrl: SITE_URL,
    })
    await page.waitForLoadState('networkidle')

    if (!page.url().includes('/dashboard')) {
      await page.goto(`${SITE_URL}/dashboard`, { waitUntil: 'networkidle' })
    }

    // Dashboard heading
    await expect(page.locator('h1:has-text("Dashboard")')).toBeVisible({ timeout: 10_000 })

    // "Recent Checks" section always renders (heading present)
    await expect(page.locator('h2:has-text("Recent Checks")')).toBeVisible({ timeout: 10_000 })

    // Either shows recent checks or the empty-state prompt
    const hasChecks = await page.locator('[role="button"]').first().isVisible().catch(() => false)
    const hasEmptyState = await page.locator('text=No credit checks yet').isVisible().catch(() => false)
    expect(hasChecks || hasEmptyState).toBe(true)

    // If there are recent checks, the score badge or status badge is visible
    if (hasChecks) {
      // RecentCheckRow renders shadcn Badge elements (data-slot="badge")
      const badges = page.locator('[data-slot="badge"]')
      const badgeCount = await badges.count()
      expect(badgeCount).toBeGreaterThan(0)
    }

    // The methodology link is always shown on the dashboard
    await expect(page.locator('text=How is the score calculated?')).toBeVisible({ timeout: 5_000 })
  })

  test('settings interaction: account email displays, nav tabs render, billing plan section visible', async ({ page }) => {
    await loginWithGateBypass(page, {
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_ROLE_KEY,
      anonKey: ANON_KEY,
      testEmail: TEST_EMAIL,
      siteUrl: SITE_URL,
    })
    await page.waitForLoadState('networkidle')

    await page.goto(`${SITE_URL}/settings`, { waitUntil: 'networkidle' })

    // Settings heading
    await expect(page.locator('h1:has-text("Settings")')).toBeVisible({ timeout: 10_000 })

    // Side nav is rendered with labelled section links
    const settingsNav = page.locator('nav[aria-label="Settings sections"]')
    await expect(settingsNav).toBeVisible({ timeout: 5_000 })
    await expect(settingsNav.locator('a:has-text("Account")')).toBeVisible({ timeout: 5_000 })
    await expect(settingsNav.locator('a:has-text("Billing")')).toBeVisible({ timeout: 5_000 })

    // The Account sub-page is the default outlet — email input is visible
    const emailInput = page.locator('#account-email')
    await expect(emailInput).toBeVisible({ timeout: 5_000 })
    // Email input shows the test user's email (non-empty)
    const emailValue = await emailInput.inputValue()
    expect(emailValue.length).toBeGreaterThan(0)
    expect(emailValue).toContain('@')

    // Navigate to Billing tab and verify plan/subscription info renders
    await settingsNav.locator('a:has-text("Billing")').click()
    await page.waitForLoadState('networkidle')
    expect(page.url()).toContain('/settings/billing')

    // "Current Usage" card is always shown (requires org data to load)
    await expect(page.locator('text=Current Usage')).toBeVisible({ timeout: 10_000 })

    // Plans section heading
    await expect(page.locator('h2:has-text("Plans")')).toBeVisible({ timeout: 5_000 })

    // At least the Free plan card is visible with a "Current Plan" badge (test user is on free tier)
    await expect(page.locator('text=Free').first()).toBeVisible({ timeout: 5_000 })
  })

  test('site identity — title contains signalscore', async ({ page }) => {
    await bypassPasswordGate(page, SITE_URL)
    const title = await page.title()
    const body = await page.textContent('body')
    const combined = `${title} ${body}`.toLowerCase()
    expect(combined, 'signalscore.ch must contain "signalscore" branding').toContain('signalscore')
  })

  test('methodology page: all 7 sections render and dimension cards are visible', async ({ page }) => {
    // Methodology is accessible both as a public page and as an authenticated route.
    // Test the public route so no login is needed.
    await bypassPasswordGate(page, `${SITE_URL}/legal/methodology`)

    // Hero heading is split across two lines in JSX: "Scoring" + "Methodology"
    await expect(page.locator('h1').filter({ hasText: 'Scoring' })).toBeVisible({ timeout: 10_000 })

    // All 7 section headers render (SectionHeader emits "Section 01" … "Section 07" labels)
    for (const num of ['01', '02', '03', '04', '05', '06', '07']) {
      await expect(page.locator(`text=Section ${num}`)).toBeVisible({ timeout: 10_000 })
    }

    // Section 01 — "How It Works" with its three step cards
    await expect(page.locator('h2:has-text("How It Works")')).toBeVisible({ timeout: 5_000 })
    await expect(page.locator('h3:has-text("Collect")')).toBeVisible({ timeout: 5_000 })
    await expect(page.locator('h3:has-text("Analyze")')).toBeVisible({ timeout: 5_000 })
    // Use .first() because h3:has-text("Score") also matches "Altman Omega Score" in the academic refs section
    await expect(page.locator('h3:has-text("Score")').first()).toBeVisible({ timeout: 5_000 })

    // Section 02 — "The 7 Scoring Dimensions" and the weight distribution bar
    await expect(page.locator('h2:has-text("The 7 Scoring Dimensions")')).toBeVisible({ timeout: 5_000 })
    await expect(page.locator('text=Weight Distribution')).toBeVisible({ timeout: 5_000 })

    // At least one dimension card label is visible (Registry & Legal Stability is first)
    await expect(page.locator('h3:has-text("Registry & Legal Stability")')).toBeVisible({ timeout: 5_000 })

    // Section 03 — Scoring Scale with grade labels
    await expect(page.locator('h2:has-text("Scoring Scale")')).toBeVisible({ timeout: 5_000 })
    // Grade "A" tile is visible
    await expect(page.locator('text=Very Low Risk').first()).toBeVisible({ timeout: 5_000 })

    // Section 04 — Data Sources
    await expect(page.locator('h2:has-text("Data Sources")')).toBeVisible({ timeout: 5_000 })
    await expect(page.locator('text=Zefix').first()).toBeVisible({ timeout: 5_000 })

    // Section 07 — Calibration & Transparency (last section before disclaimer)
    await expect(page.locator('h2:has-text("Calibration & Transparency")')).toBeVisible({ timeout: 5_000 })
    await expect(page.locator('h3:has-text("Current Limitations")')).toBeVisible({ timeout: 5_000 })
    await expect(page.locator('h3:has-text("Planned Improvements")')).toBeVisible({ timeout: 5_000 })

    // Disclaimer banner at the bottom
    await expect(page.locator('h3:has-text("Important Limitations")')).toBeVisible({ timeout: 10_000 })
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
    const ACCESS_TOKEN = process.env.SIGNALSCORE_SUPABASE_ACCESS_TOKEN

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

  // ── Data-source API health (the check that would have caught the dead
  //    GOOGLE_MAPS_API_KEY on day 1 instead of 5 weeks later) ──────────────
  test.describe('Data-Source API Health', () => {
    const ACCESS_TOKEN = process.env.SIGNALSCORE_SUPABASE_ACCESS_TOKEN

    // Every credit-check data source logs its outbound calls to api_request_logs
    // with the real HTTP status. A source whose key expired / quota-capped / API
    // disabled returns only 4xx/5xx — and the app degrades silently to "no data".
    // Alert when any service has failed with NO successful calls in the last 24h
    // (a sustained outage), while ignoring transient blips that still have 2xx.
    test('no external data source is failing with zero successes (24h)', async ({ request }) => {
      test.skip(!ACCESS_TOKEN, 'SIGNALSCORE_SUPABASE_ACCESS_TOKEN not set')

      const ref = projectRefFromUrl(SUPABASE_URL)
      const sql = `select service,
        count(*) filter (where status_code >= 400) as errors,
        count(*) filter (where status_code between 200 and 299) as successes,
        max(created_at) filter (where status_code >= 400) as last_error
        from api_request_logs
        where created_at > now() - interval '24 hours'
        group by service
        having count(*) filter (where status_code >= 400) >= 2
           and count(*) filter (where status_code between 200 and 299) = 0`

      const resp = await request.post(
        `https://api.supabase.com/v1/projects/${ref}/database/query`,
        {
          headers: {
            Authorization: `Bearer ${ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
          },
          data: { query: sql },
        },
      )
      expect(resp.ok(), `Management API query failed: ${resp.status()}`).toBe(true)

      const rows = (await resp.json()) as Array<{
        service: string
        errors: number
        successes: number
        last_error: string
      }>
      const down = Array.isArray(rows) ? rows : []
      expect(
        down,
        `Data sources DOWN (only errors, no successes in 24h): ${down
          .map((r) => `${r.service} (${r.errors} errors, last ${r.last_error})`)
          .join('; ')}`,
      ).toEqual([])
    })
  })

  // ── Real Login Form Interaction (not magic link bypass) ─────────────

  test('login form: fields accept input and opacity > 0', async ({ page }) => {
    await bypassPasswordGate(page, `${SITE_URL}/auth`)

    const emailInput = page.locator('input[type="email"]').first()
    await expect(emailInput).toBeVisible({ timeout: 10_000 })

    // Verify opacity > 0 (catches invisible form regressions)
    const opacity = await emailInput.evaluate(
      (el: HTMLElement) => parseFloat(getComputedStyle(el).opacity),
    )
    expect(opacity, 'Login email input must have opacity > 0').toBeGreaterThan(0)

    // Verify input accepts keystrokes
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
      email = await waitForOtpEmail(IMAP_OPTS, { timeoutMs: 90_000, deleteAfter: true, subjectFilter: 'SignalScore' })
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
