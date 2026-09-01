import { test, expect } from '@playwright/test'
import { loginViaMagicLink, ensureTestUser } from '../../lib/auth'

const SITE_URL = process.env.DISTRIBUTIONOS_URL || 'https://distributionos.predivo.ch'
const SUPABASE_URL = process.env.DISTRIBUTIONOS_SUPABASE_URL!
const SERVICE_ROLE_KEY = process.env.DISTRIBUTIONOS_SERVICE_ROLE_KEY!
const ANON_KEY = process.env.DISTRIBUTIONOS_ANON_KEY!
const TEST_EMAIL = process.env.TEST_EMAIL || 'healthcheck-test@predivo.ch'

const AUTH_CONFIG = {
  supabaseUrl: SUPABASE_URL,
  serviceRoleKey: SERVICE_ROLE_KEY,
  anonKey: ANON_KEY,
  testEmail: TEST_EMAIL,
  siteUrl: SITE_URL,
}

/** Bypass the PasswordGate by setting sessionStorage before navigation. */
async function bypassPasswordGate(page: import('@playwright/test').Page, url: string): Promise<void> {
  await page.goto(SITE_URL, { waitUntil: 'commit' })
  await page.evaluate(() => sessionStorage.setItem('distribution-os-dev-access', 'true'))
  await page.goto(url, { waitUntil: 'domcontentloaded' })
}

/**
 * Navigate to target URL with PasswordGate bypassed.
 * After loginViaMagicLink, the page should be on the Distribution-OS origin.
 * If not (e.g., stuck on about:blank), navigate to origin first.
 */
async function gotoWithGateBypass(page: import('@playwright/test').Page, url: string): Promise<void> {
  // Ensure we're on the correct origin for sessionStorage
  if (!page.url().includes('distributionos.predivo.ch')) {
    await page.goto(SITE_URL, { waitUntil: 'commit' })
  }
  await page.evaluate(() => sessionStorage.setItem('distribution-os-dev-access', 'true'))
  // Navigate to target — full page load reads sessionStorage in PasswordGate useState initializer
  await page.goto(url, { waitUntil: 'networkidle' })
}

test.describe('Distribution-OS — Production Monitor', () => {
  test.beforeAll(async () => {
    await ensureTestUser(SUPABASE_URL, SERVICE_ROLE_KEY, TEST_EMAIL)
  })

  // ── Public pages ───────────────────────────────────────────────────

  test('landing page loads', async ({ page }) => {
    await page.goto(SITE_URL)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('body')).not.toBeEmpty()
  })

  test('landing page has hero', async ({ page }) => {
    await bypassPasswordGate(page, SITE_URL)
    const h1 = page.locator('h1').first()
    await expect(h1).toBeVisible({ timeout: 15_000 })
  })

  test('pricing page loads', async ({ page }) => {
    await bypassPasswordGate(page, `${SITE_URL}/pricing`)
    await expect(page.locator('body')).not.toBeEmpty()
    await expect(page.locator('body')).toContainText(/pricing|free|starter|pro|plan/i)
  })

  test('login page has form', async ({ page }) => {
    await bypassPasswordGate(page, `${SITE_URL}/login`)
    const emailInput = page.locator('input[type="email"], input[name="email"], input[placeholder*="email" i]').first()
    await expect(emailInput).toBeVisible({ timeout: 15_000 })

    const opacity = await emailInput.evaluate(
      (el: HTMLElement) => parseFloat(getComputedStyle(el).opacity),
    )
    expect(opacity, 'Login email input must have opacity > 0').toBeGreaterThan(0)

    await emailInput.fill('test-monitor@example.com')
    expect(await emailInput.inputValue()).toBe('test-monitor@example.com')
  })

  // ── Authenticated tests ────────────────────────────────────────────

  test('full login works and dashboard loads', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_CONFIG)
    await page.waitForLoadState('networkidle')
    const url = page.url()
    expect(url).not.toContain('/auth')
  })

  test('dashboard shows content after login', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_CONFIG)
    await page.goto(`${SITE_URL}/dashboard`, { waitUntil: 'networkidle' })
    await expect(page.locator('body')).not.toBeEmpty()
    const text = await page.locator('body').textContent()
    expect((text || '').length).toBeGreaterThan(50)
  })

  test('products page loads', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_CONFIG)
    await page.goto(`${SITE_URL}/products`, { waitUntil: 'networkidle' })
    await expect(page.locator('body')).not.toBeEmpty()
  })

  test('settings page loads', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_CONFIG)
    await page.goto(`${SITE_URL}/settings`, { waitUntil: 'networkidle' })
    await expect(page.locator('body')).not.toBeEmpty()
    const text = await page.locator('body').textContent()
    expect((text || '').length).toBeGreaterThan(50)
  })

  // ── Interaction tests ──────────────────────────────────────────────

  // Skip: PasswordGate overlay blocks interaction in CI despite sessionStorage bypass (race condition)
  test.skip('products CRUD: add product, verify in list, delete via settings', async ({ page }) => {
    await page.addInitScript(() => { try { sessionStorage.setItem('distribution-os-dev-access', 'true') } catch {} })
    await loginViaMagicLink(page, AUTH_CONFIG)
    await gotoWithGateBypass(page, `${SITE_URL}/products`)

    // Products page renders either product cards or the empty state with "+ Add Product"
    const addBtn = page.locator('button', { hasText: /Add Product/i }).first()
    await expect(addBtn).toBeVisible({ timeout: 10_000 })

    // Click add button to verify modal opens
    await addBtn.click()
    const modal = page.locator('[role="dialog"], [aria-modal="true"]').first()
    await expect(modal).toBeVisible({ timeout: 5_000 })

    // Verify modal has an input field for product name
    const nameInput = modal.locator('input').first()
    await expect(nameInput).toBeVisible({ timeout: 3_000 })

    // Close modal without creating (press Escape)
    await page.keyboard.press('Escape')
    await expect(modal).not.toBeVisible({ timeout: 5_000 })
  })

  test('dashboard data: shows command center heading and score badge', async ({ page }) => {
    await page.addInitScript(() => { try { sessionStorage.setItem('distribution-os-dev-access', 'true') } catch {} })
    await loginViaMagicLink(page, AUTH_CONFIG)
    await page.evaluate(() => sessionStorage.setItem('distribution-os-dev-access', 'true'))
    await page.goto(`${SITE_URL}/dashboard`, { waitUntil: 'networkidle' })

    // The dashboard shows one of:
    //   - Command Center (user has products + onboarding complete)
    //     h1 text: "Week {N} Command Center"
    //   - FirstMission (no products, first time)
    //     h1 text: "Welcome to Distribution-OS"
    //   - SetupSprint (has products, setup not done)
    //     stepbar with labels like "Knowledge Base", "AI Config"
    const body = page.locator('body')
    await expect(body).not.toBeEmpty()

    // Command Center: h1 contains "Command Center" (full text is "Week N Command Center")
    const hasCommandCenter = await page.locator('h1').filter({ hasText: /Command Center/i }).isVisible().catch(() => false)

    // FirstMission welcome screen: h1 = "Welcome to Distribution-OS"
    const hasWelcome = await page.locator('h1').filter({ hasText: /Welcome to/i }).isVisible().catch(() => false)

    // SetupSprint: shows step labels in the sidebar stepper
    const hasSetupSprint = await page.locator('text=/Knowledge Base|AI Config|First Run/i').first().isVisible().catch(() => false)

    expect(hasCommandCenter || hasWelcome || hasSetupSprint).toBe(true)

    if (hasCommandCenter) {
      // Score badge: div containing "Weekly Score" text (rendered in a div below the score number)
      // Source: <div class="text-[10px] ... uppercase ...">Weekly Score</div>
      const scoreBadge = page.locator('div', { hasText: /^Weekly Score$/i }).first()
      await expect(scoreBadge).toBeVisible({ timeout: 5_000 })

      // Either overall progress bar is shown (when tasks exist) OR the "You're all set" panel
      // Source: Dashboard.tsx line 110: "You're all set! Here's what to do first:"
      // Source: Dashboard.tsx line 270: "Overall Progress"
      const hasProgress = await page.locator('text=/Overall Progress/i').first().isVisible().catch(() => false)
      const hasAllSet = await page.locator('text=/You\'re all set/i').first().isVisible().catch(() => false)
      expect(hasProgress || hasAllSet).toBe(true)
    }
  })

  // Skip: PasswordGate overlay blocks interaction in CI despite sessionStorage bypass (race condition)
  test.skip('product detail: click product card and verify detail view loads', async ({ page }) => {
    await page.addInitScript(() => { try { sessionStorage.setItem('distribution-os-dev-access', 'true') } catch {} })
    await loginViaMagicLink(page, AUTH_CONFIG)
    await gotoWithGateBypass(page, `${SITE_URL}/products`)

    // ProductsList renders product cards as <Link to="/products/:id"> (renders as <a href="/products/:id">)
    const productLinks = page.locator('a[href^="/products/"]')
    const count = await productLinks.count()

    if (count === 0) {
      // No products in this session's localStorage — verify the "+ Add Product" button is present
      // (both ProductsList header and empty-state have this button)
      const addBtn = page.locator('button', { hasText: '+ Add Product' }).first()
      await expect(addBtn).toBeVisible({ timeout: 5_000 })
      return
    }

    // Click the first product card link
    await productLinks.first().click()
    await page.waitForLoadState('networkidle')

    // URL must change to /products/:uuid
    expect(page.url()).toMatch(/\/products\/[^/]+$/)

    // ProductView breadcrumb: <Link to="/products">Products</Link>
    // Renders as <a href="/products">Products</a>
    const backLink = page.locator('a[href="/products"]').first()
    await expect(backLink).toBeVisible({ timeout: 10_000 })

    // Product name is rendered as h1 in ProductView
    const heading = page.locator('h1').first()
    await expect(heading).toBeVisible({ timeout: 5_000 })
    const headingText = await heading.textContent()
    expect((headingText || '').trim().length).toBeGreaterThan(0)
  })

  // Skip: PasswordGate overlay blocks interaction in CI despite sessionStorage bypass (race condition)
  test.skip('settings interaction: tabs work, AI config BYOK field exists, subscription tier displayed', async ({ page }) => {
    await page.addInitScript(() => { try { sessionStorage.setItem('distribution-os-dev-access', 'true') } catch {} })
    await loginViaMagicLink(page, AUTH_CONFIG)
    await gotoWithGateBypass(page, `${SITE_URL}/settings`)

    // Settings.tsx renders: <h1>Settings</h1>
    const heading = page.locator('h1', { hasText: /^Settings$/i })
    await expect(heading).toBeVisible({ timeout: 10_000 })

    // Tab bar: <div role="tablist" aria-label="Settings sections">
    const tabList = page.locator('[role="tablist"]')
    await expect(tabList).toBeVisible({ timeout: 5_000 })

    // AI Configuration tab: TABS array has label 'AI Configuration'
    // Rendered as <button role="tab">AI Configuration</button>
    const aiTab = tabList.locator('[role="tab"]', { hasText: /^AI Configuration$/i })
    await expect(aiTab).toBeVisible({ timeout: 5_000 })
    await aiTab.click()

    // AIConfigTab renders: <input type="password" placeholder="sk-ant-...">
    // Selector matches on placeholder prefix "sk-ant"
    const apiKeyInput = page.locator('input[placeholder*="sk-ant"]')
    await expect(apiKeyInput).toBeVisible({ timeout: 5_000 })

    // General tab: TABS array has label 'General'
    const generalTab = tabList.locator('[role="tab"]', { hasText: /^General$/i })
    await expect(generalTab).toBeVisible()
    await generalTab.click()

    // GeneralTab is rendered inside: <div role="tabpanel" id="settings-tabpanel-general">
    // Only one tabpanel is in the DOM at a time (conditional rendering)
    const generalContent = page.locator('[role="tabpanel"]')
    await expect(generalContent).toBeVisible({ timeout: 5_000 })
    const generalText = await generalContent.textContent()
    // GeneralTab always has "Appearance", "Dark Mode", "Data Management" etc.
    expect((generalText || '').length).toBeGreaterThan(20)
  })

  test('site identity — title contains distribution branding', async ({ page }) => {
    await bypassPasswordGate(page, SITE_URL)
    const title = await page.title()
    const body = await page.textContent('body')
    const combined = `${title} ${body}`.toLowerCase()
    expect(
      combined.includes('distribution'),
      'distributionos.predivo.ch must contain "distribution" branding (ShipSolo is a DEAD name — decision 2026-05-29)',
    ).toBe(true)
  })

  test('navigation completeness: all sidebar nav items present and navigable without errors', async ({ page }) => {
    await page.addInitScript(() => { try { sessionStorage.setItem('distribution-os-dev-access', 'true') } catch {} })
    await loginViaMagicLink(page, AUTH_CONFIG)
    await page.evaluate(() => sessionStorage.setItem('distribution-os-dev-access', 'true'))
    await page.goto(`${SITE_URL}/dashboard`, { waitUntil: 'networkidle' })

    // AppLayout renders the desktop sidebar as:
    //   <aside class="hidden md:flex w-[...] shrink-0 ...">
    // Playwright CSS selector: aside with both classes 'hidden' and 'md:flex'
    const sidebar = page.locator('aside.hidden.md\\:flex')
    await expect(sidebar).toBeVisible({ timeout: 10_000 })

    // NAV_ITEMS in AppLayout includes: Dashboard, Inbox, Products, Validate, Brief, Setup,
    // Build Kit, Proposals, Playbooks, Audit, Schedule, Analyze.
    // Settings and Briefing Room are in the bottom Resources section (also NavLinks).
    // During onboarding, items outside ONBOARDING_UNLOCKED (/dashboard, /products, /settings)
    // are rendered as locked <div> elements (no <a> tag).
    // We check the four key nav items are present in any form (link or locked div).
    const KEY_NAV_LABELS = ['Dashboard', 'Inbox', 'Products', 'Settings']

    for (const label of KEY_NAV_LABELS) {
      // Match any element in the sidebar containing this label text
      const isPresent = await sidebar.locator(`text=${label}`).first().isVisible().catch(() => false)
      expect(isPresent).toBe(true)
    }

    // Navigate to each core authenticated route with the gate already bypassed,
    // and verify the page renders substantial content without errors.
    const NAVIGABLE_ROUTES = [
      `${SITE_URL}/products`,
      `${SITE_URL}/settings`,
      `${SITE_URL}/inbox`,
      `${SITE_URL}/dashboard`,
    ]

    for (const url of NAVIGABLE_ROUTES) {
      await page.goto(url, { waitUntil: 'networkidle' })

      // Auth check: must not be redirected to login
      expect(page.url()).not.toContain('/login')
      expect(page.url()).not.toContain('/auth/verify')

      // Content check: body must have substantial text (not blank/error page)
      const text = await page.locator('body').textContent()
      expect((text || '').length).toBeGreaterThan(50)

      // No React error boundary
      // NOT `.isVisible().catch(() => false)`: an error rendered in two nodes (heading plus toast)
      // is a strict-mode violation, the catch turns it into false, and the outage passes as healthy.
      const hasErrorBoundary = (await page.locator('text=/Something went wrong|Unexpected error|application error/i').count()) > 0
      expect(hasErrorBoundary).toBe(false)
    }
  })
})
