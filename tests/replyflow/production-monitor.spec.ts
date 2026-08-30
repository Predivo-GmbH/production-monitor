import { test, expect } from '@playwright/test'
import { loginViaMagicLink, ensureTestUser, setUserPlan } from '../../lib/auth'
import { waitForOtpEmail } from '../../lib/imap'
import { createClient } from '@supabase/supabase-js'
import {
  projectRefFromUrl,
  listDeployedFunctions,
  isFunctionReachable,
} from '../../lib/edgeFunctions'
import { fetchRouteManifest, checkPublicRoutes } from '../../lib/publicRoutes'
import { ensureOnboardedBusiness } from '../../lib/replyflow'

const SITE_URL = process.env.REPLYFLOW_URL || 'https://replyflow.help'
const SUPABASE_URL = process.env.REPLYFLOW_SUPABASE_URL!
const SERVICE_ROLE_KEY = process.env.REPLYFLOW_SERVICE_ROLE_KEY!
const ANON_KEY = process.env.REPLYFLOW_ANON_KEY!
const TEST_EMAIL = process.env.TEST_EMAIL || 'healthcheck-test@predivo.ch'

// Shared IMAP config — same mailbox used by all project monitors for OTP email verification.
// IMAP_USER is used as both IMAP login AND OTP recipient. Must have a Supabase auth user in each project.
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

test.describe('ReplyFlow — Production Monitor', () => {
  test.beforeAll(async () => {
    await ensureTestUser(SUPABASE_URL, SERVICE_ROLE_KEY, TEST_EMAIL)
    // Seed the test user onto the highest paid tier so plan-gated pages
    // (Analytics = Pro+, weekly digest = Business, etc.) render their real
    // content. Without this the monitor depends on ambient prod plan state and
    // a future gating change silently becomes a false alarm. (See setUserPlan.)
    await setUserPlan(SUPABASE_URL, SERVICE_ROLE_KEY, TEST_EMAIL, {
      plan: 'business',
      status: 'active',
    })
    // Seed the user as genuinely onboarded (a business + a completed
    // reply_profiles row). ReplyFlow's OnboardingGate is a mandatory modal for
    // any account without one and it swallows every click — see
    // lib/replyflow.ts for why the old localStorage seam no longer works.
    await ensureOnboardedBusiness(SUPABASE_URL, SERVICE_ROLE_KEY, TEST_EMAIL)
    // Ensure the shared IMAP test user exists for OTP email delivery tests
    if (OTP_TEST_EMAIL && OTP_TEST_EMAIL !== TEST_EMAIL) {
      await ensureTestUser(SUPABASE_URL, SERVICE_ROLE_KEY, OTP_TEST_EMAIL)
    }
  })

  // Belt-and-braces only: rf_e2e_no_onboarding is compiled OUT of the
  // production bundle (ReplyFlow 4de26ba gated the E2E seams behind
  // VITE_E2E_SEAMS so devtools couldn't disable the trial paywall), so on
  // replyflow.help this flag is inert. The real defence is the seeded
  // completed business in beforeAll; the flag is kept for staging/dev runs of
  // this spec where the seam does ship.
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('rf_e2e_no_onboarding', '1'))
  })

  // ── Existing tests ──────────────────────────────────────────────────

  // ── Public routes: manifest-driven ──────────────────────────────────
  // Every public route is smoke-tested from the deployed manifest at
  // ${SITE_URL}/monitor-routes.json, generated from ReplyFlow's single source
  // of truth (scripts/monitor-routes.mjs). Adding/removing a public route there
  // updates this automatically — a removed page can't leave a stale assertion
  // behind. The build gate (scripts/check-monitor-routes.mjs) keeps the list
  // honest against the prerendered output.
  test('public routes from manifest load and render (not 404/empty)', async ({ page, request }) => {
    // Manifest fetch + per-route render checks live in lib/publicRoutes.ts so
    // all projects share one correct implementation (no per-spec drift).
    const { isJsonManifest, status, contentType, manifest } = await fetchRouteManifest(request, SITE_URL)
    test.skip(!isJsonManifest, `monitor-routes.json not deployed yet (got ${status} ${contentType || 'no content-type'})`)
    expect((manifest!.routes ?? []).length, 'manifest contains no routes').toBeGreaterThan(0)
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

  // ── Public page tests ───────────────────────────────────────────────

  test('login page has form', async ({ page }) => {
    await page.goto(`${SITE_URL}/login`, { waitUntil: 'networkidle' })

    // Email input should be present
    const emailInput = page.locator('input[type="email"], input[name="email"], input[placeholder*="email" i]').first()
    await expect(emailInput).toBeVisible({ timeout: 10_000 })

    // Submit button should be present
    const submitButton = page.locator('button[type="submit"], button:has-text("Log in"), button:has-text("Sign in"), button:has-text("Continue")').first()
    await expect(submitButton).toBeVisible({ timeout: 10_000 })
  })

  // ── Protected route redirect test ───────────────────────────────────

  test('protected route requires auth', async ({ page }) => {
    // Go to /app without logging in — should either redirect or show login prompt
    await page.goto(`${SITE_URL}/app`, { waitUntil: 'networkidle' })
    await expect(page.locator('body')).not.toBeEmpty()
    // Should not show actual app content (reviews, analytics) without auth
    const url = page.url()
    const body = await page.locator('body').textContent()
    // Either redirected to login/auth page OR shows login prompt on the page
    const isOnAuthPage = url.includes('/login') || url.includes('/auth') || url.includes('/signup')
    const hasLoginPrompt = (body || '').match(/sign.?in|log.?in|anmeld/i)
    expect(isOnAuthPage || hasLoginPrompt, 'Should require auth to access /app').toBeTruthy()
  })

  // ── Authenticated page tests ────────────────────────────────────────

  test('dashboard loads after login', async ({ page }) => {
    await loginViaMagicLink(page, {
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_ROLE_KEY,
      anonKey: ANON_KEY,
      testEmail: TEST_EMAIL,
      siteUrl: SITE_URL,
    })
    await page.waitForLoadState('networkidle')

    // Should be on /app or dashboard area
    await page.goto(`${SITE_URL}/app`, { waitUntil: 'networkidle' })

    // Dashboard should show stats cards, review list, or an empty state
    const dashboardContent = page.locator(
      '[class*="dashboard"], [class*="Dashboard"], [class*="stats"], [class*="card"], [class*="empty"], [class*="review"], main, [role="main"]'
    ).first()
    await expect(dashboardContent).toBeVisible({ timeout: 15_000 })
  })

  test('reviews page loads', async ({ page }) => {
    await loginViaMagicLink(page, {
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_ROLE_KEY,
      anonKey: ANON_KEY,
      testEmail: TEST_EMAIL,
      siteUrl: SITE_URL,
    })
    await page.waitForLoadState('networkidle')

    await page.goto(`${SITE_URL}/app/reviews`, { waitUntil: 'networkidle' })

    // Should not redirect away (still on reviews page)
    expect(page.url()).toContain('/app/reviews')

    // Page should render review list or empty state
    const reviewsContent = page.locator(
      '[class*="review"], [class*="Review"], [class*="empty"], [class*="Empty"], table, [role="table"], main, [role="main"]'
    ).first()
    await expect(reviewsContent).toBeVisible({ timeout: 15_000 })
  })

  test('analytics page loads', async ({ page }) => {
    await loginViaMagicLink(page, {
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_ROLE_KEY,
      anonKey: ANON_KEY,
      testEmail: TEST_EMAIL,
      siteUrl: SITE_URL,
    })
    await page.waitForLoadState('networkidle')

    await page.goto(`${SITE_URL}/app/analytics`, { waitUntil: 'networkidle' })

    // Should stay on analytics page
    expect(page.url()).toContain('/app/analytics')

    // Page should render charts, stats, or empty state
    const analyticsContent = page.locator(
      '[class*="analytics"], [class*="Analytics"], [class*="chart"], [class*="Chart"], [class*="empty"], [class*="Empty"], canvas, svg, main, [role="main"]'
    ).first()
    await expect(analyticsContent).toBeVisible({ timeout: 15_000 })
  })

  test('settings page loads with tabs', async ({ page }) => {
    await loginViaMagicLink(page, {
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_ROLE_KEY,
      anonKey: ANON_KEY,
      testEmail: TEST_EMAIL,
      siteUrl: SITE_URL,
    })
    await page.waitForLoadState('networkidle')

    await page.goto(`${SITE_URL}/app/settings`, { waitUntil: 'networkidle' })

    // Should stay on settings page
    expect(page.url()).toContain('/app/settings')

    // Settings should have tabs or sections
    const settingsTabs = page.locator(
      '[role="tablist"], [class*="tab"], [class*="Tab"], [class*="settings"], [class*="Settings"], nav, [class*="section"], [class*="Section"]'
    ).first()
    await expect(settingsTabs).toBeVisible({ timeout: 15_000 })
  })

  // ── Feature interaction tests ────────────────────────────────────────

  const AUTH_OPTS = () => ({
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: SERVICE_ROLE_KEY,
    anonKey: ANON_KEY,
    testEmail: TEST_EMAIL,
    siteUrl: SITE_URL,
  })

  test('dashboard data loads — stat cards and sections render with content', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_OPTS())
    await page.goto(`${SITE_URL}/app`, { waitUntil: 'networkidle' })

    // Page heading "Dashboard" must be visible
    // The h1 is sr-only on some layouts — check by title or main presence instead
    const heading = page.locator('h1', { hasText: 'Dashboard' })
    await expect(heading).toBeVisible({ timeout: 15_000 })

    // All four stat card labels must appear.
    // Labels are rendered as text nodes inside StatCard spans — matched via partial text.
    // "Needs Reply" card is wrapped in a <Link>; use the span label text directly.
    await expect(page.locator('span', { hasText: 'Total Reviews' }).first()).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('span', { hasText: 'Average Rating' }).first()).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('span', { hasText: 'Response Rate' }).first()).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('span', { hasText: 'Needs Reply' }).first()).toBeVisible({ timeout: 15_000 })

    // Reviews section heading — shows "Needs Reply (N)" when unreplied exist, or "Reviews" otherwise
    const reviewsHeading = page.locator('h2', { hasText: /Needs Reply|Reviews/ })
    await expect(reviewsHeading).toBeVisible({ timeout: 15_000 })

    // Quick-action row: since 2219de3 (no dead actions without a set-up business)
    // the primary action is "Review & Reply" (formerly "Generate AI Replies") only when
    // setup is complete; fresh accounts (like the monitor user) get "Set Up Business"/"Finish
    // Setup" and no "View All Reviews" link. Accept either state.
    const generateAction = page.locator('a, button').filter({ hasText: /Review & Reply/i }).first()
    const setupAction = page.locator('a, button').filter({ hasText: /Set Up Business|Finish Setup/i }).first()
    const hasGenerate = await generateAction.isVisible({ timeout: 15_000 }).catch(() => false)
    const hasSetup = hasGenerate ? false : await setupAction.isVisible({ timeout: 3_000 }).catch(() => false)
    expect(hasGenerate || hasSetup, 'Quick-action row must show either "Review & Reply" or a setup CTA').toBeTruthy()
    if (hasGenerate) {
      // Business is set up — the secondary "View All Reviews" link must render too
      await expect(page.locator('a').filter({ hasText: /View All Reviews|View all/i }).first()).toBeVisible({ timeout: 15_000 })
    }

    // The reviews section must show either review cards, "All caught up!", or a setup empty-state.
    const emptyState = page.locator('p').filter({ hasText: /Set up your business|No reviews yet|All caught up/i }).first()
    const reviewCard = page.locator('[aria-label^="Review from"]').first()
    const hasEmpty = await emptyState.isVisible({ timeout: 20_000 }).catch(() => false)
    const hasReviews = await reviewCard.isVisible({ timeout: 3_000 }).catch(() => false)
    expect(hasEmpty || hasReviews, 'Reviews section must show either reviews or an empty/caught-up message').toBeTruthy()
  })

  test('reviews interaction — list loads, filters work, detail panel opens', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_OPTS())
    await page.goto(`${SITE_URL}/app/reviews`, { waitUntil: 'networkidle' })

    // Page heading "Reviews" must be visible
    const heading = page.locator('h1', { hasText: 'Reviews' })
    await expect(heading).toBeVisible({ timeout: 15_000 })

    // All status tabs must be present (role="tab" after a11y audit)
    for (const label of ['All', 'New & Drafts', 'Draft Ready', 'Edited', 'Scheduled', 'Posted']) {
      await expect(page.getByRole('tab', { name: new RegExp(label, 'i') }).first()).toBeVisible({ timeout: 10_000 })
    }

    // Rating and sort dropdowns must be rendered
    const ratingSelect = page.locator('select[aria-label="Filter by rating"]')
    await expect(ratingSelect).toBeVisible({ timeout: 10_000 })
    const sortSelect = page.locator('select[aria-label="Sort reviews"]')
    await expect(sortSelect).toBeVisible({ timeout: 10_000 })

    // Switch sort to "Oldest First" and verify the dropdown reflects the change
    await sortSelect.selectOption('oldest')
    await expect(sortSelect).toHaveValue('oldest')

    // Switch sort back to "Newest First"
    await sortSelect.selectOption('newest')
    await expect(sortSelect).toHaveValue('newest')

    // Click the "New & Drafts" status tab (formerly "Needs Reply")
    await page.getByRole('tab', { name: /New & Drafts/i }).first().click()
    // The right panel should show the placeholder when nothing is selected, or reviews are visible
    const rightPanel = page.locator('text=/Select a review to view details|No reviews match/i').first()
    await expect(rightPanel).toBeVisible({ timeout: 10_000 })

    // Click "All" tab to reset
    await page.getByRole('tab', { name: /^All/i }).first().click()

    // If any review rows exist, click the first one and verify detail panel opens
    const firstReviewBtn = page.locator('[aria-label^="Review from"]').first()
    const hasReviews = await firstReviewBtn.isVisible({ timeout: 5_000 }).catch(() => false)
    if (hasReviews) {
      await firstReviewBtn.click()
      // Detail panel should show the reviewer name as an h2
      const detailHeading = page.locator('h2').first()
      await expect(detailHeading).toBeVisible({ timeout: 10_000 })
      // Review body card should be present (contains the review text)
      const reviewBodyCard = page.locator('.rounded-xl.border').first()
      await expect(reviewBodyCard).toBeVisible({ timeout: 10_000 })
    } else {
      // Empty state — verify the no-match message is shown
      await expect(page.locator('text=/No reviews match the current filters/i').first()).toBeVisible({ timeout: 10_000 })
    }
  })

  test('analytics interaction — stat cards, date range buttons and distribution sections render', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_OPTS())
    await page.goto(`${SITE_URL}/app/analytics`, { waitUntil: 'networkidle' })

    // Page heading "Analytics" must be visible
    const heading = page.locator('h1', { hasText: 'Analytics' })
    await expect(heading).toBeVisible({ timeout: 15_000 })

    // Subheading copy must be present
    await expect(page.locator('p', { hasText: 'Track your review performance over time.' }).first()).toBeVisible({ timeout: 10_000 })

    // All five date range buttons must be present
    for (const range of ['7D', '30D', '3M', '12M', 'All']) {
      await expect(page.getByRole('button', { name: range }).first()).toBeVisible({ timeout: 10_000 })
    }

    // Default active range is "30D" — click "7D" and verify it becomes active
    const btn7D = page.getByRole('button', { name: '7D' }).first()
    await btn7D.click()
    // After click the button should have accent styling (border-accent bg-accent text-white)
    await expect(btn7D).toHaveClass(/bg-accent/, { timeout: 5_000 })

    // Click "All" range
    await page.getByRole('button', { name: 'All' }).first().click()

    // Stat card labels are rendered as spans inside StatCard — use span locator to avoid
    // matching the outer wrapper button's combined accessible text.
    await expect(page.locator('span', { hasText: 'Total Reviews' }).first()).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('span', { hasText: 'Avg Rating' }).first()).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('span', { hasText: 'Response Rate' }).first()).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('span', { hasText: 'Replies Posted' }).first()).toBeVisible({ timeout: 10_000 })

    // Section headings for both distribution panels must appear
    await expect(page.locator('h2', { hasText: 'Rating Distribution' })).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('h2', { hasText: 'Sentiment Breakdown' })).toBeVisible({ timeout: 10_000 })

    // Sentiment labels (Positive/Neutral/Negative) only render when reviews exist.
    // With a fresh test account there may be zero reviews, in which case the section shows
    // "No reviews in this time period." — accept either state.
    const hasReviews = await page.locator('span', { hasText: 'Positive' }).first().isVisible({ timeout: 3_000 }).catch(() => false)
    if (hasReviews) {
      await expect(page.locator('span', { hasText: 'Positive' }).first()).toBeVisible({ timeout: 5_000 })
      await expect(page.locator('span', { hasText: 'Neutral' }).first()).toBeVisible({ timeout: 5_000 })
      await expect(page.locator('span', { hasText: 'Negative' }).first()).toBeVisible({ timeout: 5_000 })
    } else {
      // No reviews — both distribution sections show the empty-state message
      const emptyMessages = page.locator('p', { hasText: 'No reviews in this time period.' })
      await expect(emptyMessages.first()).toBeVisible({ timeout: 5_000 })
    }
  })

  test('settings interaction — profile tab fields populated, tab switching works, business tab has name field', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_OPTS())
    // Navigate directly to the profile tab via URL — the page uses useSearchParams for tab state
    await page.goto(`${SITE_URL}/app/settings?tab=profile`, { waitUntil: 'networkidle' })

    expect(page.url()).toContain('/app/settings')

    // ── Profile tab ────────────────────────────────────────────────────

    // The email input (#settings-email) must be present and contain the test email address.
    // It is rendered as a disabled/readOnly input on the profile tab.
    const emailInput = page.locator('#settings-email')
    await expect(emailInput).toBeVisible({ timeout: 15_000 })
    await expect(emailInput).toHaveValue(TEST_EMAIL, { timeout: 10_000 })

    // The full-name input must be present (value may be empty for a fresh test user)
    const nameInput = page.locator('#settings-fullname')
    await expect(nameInput).toBeVisible({ timeout: 10_000 })

    // "Change password" and "Update email" buttons must be present
    await expect(page.getByRole('button', { name: /Change password/i }).first()).toBeVisible({ timeout: 10_000 })
    await expect(page.getByRole('button', { name: /Update email/i }).first()).toBeVisible({ timeout: 10_000 })

    // Danger zone section must be present
    await expect(page.locator('h3', { hasText: 'Danger Zone' }).first()).toBeVisible({ timeout: 10_000 })

    // ── Switch to Locations tab (formerly "Business") ──────────────────
    // The settings page uses URL query param ?tab=<key> for navigation.
    // Since the connect-first settings redesign, the old ?tab=business (and
    // ?tab=integrations) deep links normalize to the Locations tab
    // (SettingsPage.tsx normalizeTab → LocationsTab.tsx). Navigate via URL to
    // avoid desktop-vs-mobile nav ambiguity.
    await page.goto(`${SITE_URL}/app/settings?tab=business`, { waitUntil: 'networkidle' })

    // The Locations tab always renders its "Locations" heading. Accounts with
    // no location (like the monitor user) get a "No locations yet" empty state
    // with an "Add Location" CTA; accounts with locations render a location
    // detail card. Accept either — the heading + one of the two states.
    await expect(page.getByRole('heading', { name: 'Locations', exact: true }).first())
      .toBeVisible({ timeout: 15_000 })
    // Both states (empty "No locations yet" and a rendered location detail) expose
    // an "Add Location" control, so it's the stable cross-state assertion.
    await expect(page.getByRole('button', { name: /Add Location/i }).first()).toBeVisible({ timeout: 10_000 })

    // ── Switch to Billing tab ──────────────────────────────────────────
    await page.goto(`${SITE_URL}/app/settings?tab=billing`, { waitUntil: 'networkidle' })

    // Billing tab must render — look for "Plan" or "Billing" or "Upgrade" or "Trial" text
    const billingContent = page.locator('body').filter({ hasText: /Plan|Billing|Upgrade|Trial/i })
    await expect(billingContent).toBeVisible({ timeout: 15_000 })

    // ── Switch to Notifications tab ────────────────────────────────────
    await page.goto(`${SITE_URL}/app/settings?tab=notifications`, { waitUntil: 'networkidle' })

    // Notifications tab renders toggles with labels like "New review alerts", "Weekly digest"
    const notifContent = page.locator('body').filter({ hasText: /review alerts|Weekly digest|Notification/i })
    await expect(notifContent).toBeVisible({ timeout: 15_000 })
  })

  test('site identity — title contains replyflow', async ({ page }) => {
    await page.goto(SITE_URL, { waitUntil: 'networkidle' })
    const title = await page.title()
    const body = await page.textContent('body')
    const combined = `${title} ${body}`.toLowerCase()
    expect(combined, 'replyflow.help must contain "replyflow" branding').toContain('replyflow')
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
    expect(
      status !== 404 && status !== 500,
      `send-auth-email returned ${status} — not deployed or crashed`
    ).toBe(true)
  })

  test.describe('Edge Functions Reachable', () => {
    const ACCESS_TOKEN = process.env.REPLYFLOW_SUPABASE_ACCESS_TOKEN

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
      const unreachable = results.filter((r) => !r.reachable)
      expect(
        unreachable,
        `Deployed functions not answering (missing or 5xx): ${unreachable.map((r) => `${r.slug} [${r.status}]${r.detail ? ' ' + r.detail : ''}`).join(', ')}`,
      ).toEqual([])
    })
  })

  test('navigation flow — sidebar has all nav items, clicking each loads the correct page without errors', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_OPTS())
    await page.goto(`${SITE_URL}/app`, { waitUntil: 'networkidle' })

    // The sidebar brand label must be visible
    await expect(page.getByText('ReplyFlow').first()).toBeVisible({ timeout: 15_000 })

    // Dismiss any welcome/onboarding dialog that might block navigation
    const welcomeDialog = page.locator('div[role="dialog"][aria-label*="Welcome"]')
    if (await welcomeDialog.isVisible({ timeout: 3_000 }).catch(() => false)) {
      const closeBtn = welcomeDialog.locator('button:has-text("Skip"), button:has-text("Close"), button:has-text("Got it"), button[aria-label="Close"]').first()
      if (await closeBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await closeBtn.click()
      } else {
        await page.keyboard.press('Escape')
      }
      await welcomeDialog.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {})
    }

    // All four nav links must be visible in the sidebar
    const expectedNavLabels = ['Dashboard', 'Reviews', 'Analytics', 'Settings']
    for (const label of expectedNavLabels) {
      await expect(page.getByRole('link', { name: label }).first()).toBeVisible({ timeout: 10_000 })
    }

    // Helper: click sidebar link with explicit actionability wait
    const clickNav = async (name: string) => {
      const link = page.getByRole('link', { name }).first()
      await expect(link).toBeVisible({ timeout: 10_000 })
      await link.click({ timeout: 30_000 })
      await page.waitForLoadState('networkidle')
    }

    // Navigate to Reviews via sidebar link
    await clickNav('Reviews')
    expect(page.url()).toContain('/app/reviews')
    await expect(page.locator('body')).not.toContainText('Something went wrong', { timeout: 5_000 })
    await expect(page.locator('h1', { hasText: 'Reviews' })).toBeVisible({ timeout: 10_000 })

    // Navigate to Analytics via sidebar link
    await clickNav('Analytics')
    expect(page.url()).toContain('/app/analytics')
    await expect(page.locator('body')).not.toContainText('Something went wrong', { timeout: 5_000 })
    await expect(page.locator('h1', { hasText: 'Analytics' })).toBeVisible({ timeout: 10_000 })

    // Navigate to Settings via sidebar link
    await clickNav('Settings')
    expect(page.url()).toContain('/app/settings')
    await expect(page.locator('body')).not.toContainText('Something went wrong', { timeout: 5_000 })
    await expect(page.locator('#settings-email')).toBeVisible({ timeout: 15_000 })

    // Navigate back to Dashboard via sidebar link
    await clickNav('Dashboard')
    expect(page.url()).toMatch(/\/app\/?$/)
    await expect(page.locator('body')).not.toContainText('Something went wrong', { timeout: 5_000 })
    await expect(page.locator('h1', { hasText: 'Dashboard' })).toBeVisible({ timeout: 10_000 })
  })

  // ── Real Login Form Interaction (not magic link bypass) ─────────────

  test('login form: fields accept input, opacity > 0, tab switching works', async ({ page }) => {
    await page.goto(`${SITE_URL}/login`, { waitUntil: 'networkidle' })

    // Verify email input is visible AND has opacity > 0
    const emailInput = page.locator('input[type="email"]').first()
    await expect(emailInput).toBeVisible({ timeout: 10_000 })
    const emailOpacity = await emailInput.evaluate(
      (el: HTMLElement) => parseFloat(getComputedStyle(el).opacity),
    )
    expect(emailOpacity, 'Login email input must have opacity > 0').toBeGreaterThan(0)

    // Type into the email field (catches stale cloneElement / frozen inputs)
    await emailInput.fill('test-monitor@example.com')
    expect(await emailInput.inputValue()).toBe('test-monitor@example.com')

    // Switch to Password tab and verify it works
    const passwordTab = page.getByRole('tab', { name: /password/i }).first()
      .or(page.locator('button:has-text("Password")').first())
    if (await passwordTab.isVisible().catch(() => false)) {
      await passwordTab.click()
      await page.waitForTimeout(500)
      const passwordInput = page.locator('input[type="password"]').first()
      await expect(passwordInput).toBeVisible({ timeout: 10_000 })

      const passOpacity = await passwordInput.evaluate(
        (el: HTMLElement) => parseFloat(getComputedStyle(el).opacity),
      )
      expect(passOpacity, 'Password input must have opacity > 0').toBeGreaterThan(0)

      await passwordInput.fill('TestPassword123!')
      expect(await passwordInput.inputValue()).toBe('TestPassword123!')
    }

    // Switch to Email Code tab and verify
    const emailCodeTab = page.getByRole('tab', { name: /email|code/i }).first()
      .or(page.locator('button:has-text("Email Code")').first())
      .or(page.locator('button:has-text("Email")').first())
    if (await emailCodeTab.isVisible().catch(() => false)) {
      await emailCodeTab.click()
      await page.waitForTimeout(500)
      const codeEmailInput = page.locator('input[type="email"]').first()
      await expect(codeEmailInput).toBeVisible({ timeout: 10_000 })

      // Password should NOT be visible in email code mode
      const passwordVisible = await page.locator('input[type="password"]').isVisible().catch(() => false)
      expect(passwordVisible).toBe(false)
    }
  })

  // ── E2E OTP Email Delivery Verification (IMAP) ─────────────────────

  test('E2E OTP: trigger email → verify IMAP delivery → check OTP format', async ({ page }) => {
    test.skip(!IMAP_PASS, 'IMAP_PASS not configured — skipping E2E OTP email delivery test')
    test.setTimeout(150_000)

    // 1. Trigger OTP email via Supabase Auth API (real SMTP delivery through send-auth-email)
    const anonClient = createClient(SUPABASE_URL, ANON_KEY)
    const { error } = await anonClient.auth.signInWithOtp({
      email: OTP_TEST_EMAIL,
      options: { shouldCreateUser: false },
    })

    // Rate limit is acceptable (means the function is working, just throttled)
    if (error?.message?.includes('security purposes') || error?.message?.includes('rate')) {
      // Wait and retry once
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

    // 2. Read OTP email from IMAP — proves full chain works:
    //    GoTrue → handle_send_email → pg_net → send-auth-email → SMTP → mailbox
    //    subjectFilter prevents race conditions when multiple projects share the same IMAP inbox
    let email: Awaited<ReturnType<typeof waitForOtpEmail>>
    try {
      email = await waitForOtpEmail(IMAP_OPTS, { timeoutMs: 90_000, deleteAfter: true, subjectFilter: 'ReplyFlow' })
    } catch {
      // This is the CRITICAL failure case this test was built to catch:
      // If the email never arrives, the send-auth-email chain is broken
      throw new Error(
        'OTP email NOT delivered within 90s — send-auth-email chain is broken. ' +
        'Check: pg_net Authorization header, edge function signature guard, SMTP credentials.'
      )
    }

    // 4. Verify OTP format (6-digit code)
    expect(email.otp, 'Email should contain a 6-digit OTP code').toBeTruthy()
    expect(email.otp).toMatch(/^\d{6}$/)

    // 5. Verify email came from the right sender
    expect(email.from, 'OTP email must have a sender address').toBeTruthy()

    // 6. Verify subject contains the OTP (so Outlook/mobile shows it in notification)
    expect(email.subject).toContain(email.otp!)
  })
})
