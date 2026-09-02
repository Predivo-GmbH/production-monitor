import { test, expect } from '@playwright/test'
import { loginViaMagicLink, ensureTestUser } from '../../lib/auth'

const SITE_URL = process.env.LAUNCHREADY_URL || 'https://launchready.predivo.ch'
const SUPABASE_URL = process.env.LAUNCHREADY_SUPABASE_URL!
const SERVICE_ROLE_KEY = process.env.LAUNCHREADY_SERVICE_ROLE_KEY!
const ANON_KEY = process.env.LAUNCHREADY_ANON_KEY!
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
  // Use domcontentloaded so the page JS context is available for sessionStorage
  await page.goto(SITE_URL, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => sessionStorage.setItem('launchready-unlocked', 'true'))
  await page.goto(url, { waitUntil: 'networkidle' })
  // Wait for the PasswordGate to hydrate and reveal the page content (main or section)
  await page.locator('main, section').first().waitFor({ state: 'visible', timeout: 15_000 })
}

test.describe('LaunchReady — Production Monitor', () => {
  test.beforeAll(async () => {
    await ensureTestUser(SUPABASE_URL, SERVICE_ROLE_KEY, TEST_EMAIL)
  })

  // ── Public pages ───────────────────────────────────────────────────

  test('site loads', async ({ page }) => {
    await page.goto(SITE_URL)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('body')).not.toBeEmpty()
  })

  test('landing page has audit form', async ({ page }) => {
    await bypassPasswordGate(page, SITE_URL)
    const h1 = page.locator('h1').first()
    await expect(h1).toBeVisible({ timeout: 10_000 })
    // AuditForm has a text input with placeholder "Enter your website URL..."
    const urlInput = page.locator('input[type="url"], input[type="text"]').first()
    await expect(urlInput).toBeVisible({ timeout: 10_000 })
  })

  test('privacy page loads', async ({ page }) => {
    await bypassPasswordGate(page, `${SITE_URL}/privacy`)
    const body = page.locator('body')
    await expect(body).not.toBeEmpty()
    const text = await body.textContent()
    expect((text || '').length).toBeGreaterThan(50)
  })

  test('terms page loads', async ({ page }) => {
    await bypassPasswordGate(page, `${SITE_URL}/terms`)
    const body = page.locator('body')
    await expect(body).not.toBeEmpty()
    const text = await body.textContent()
    expect((text || '').length).toBeGreaterThan(50)
  })

  test('impressum page loads', async ({ page }) => {
    await bypassPasswordGate(page, `${SITE_URL}/impressum`)
    const body = page.locator('body')
    await expect(body).not.toBeEmpty()
    const text = await body.textContent()
    expect((text || '').length).toBeGreaterThan(50)
  })

  // ── Authenticated tests ────────────────────────────────────────────

  test('full login works and dashboard loads', async ({ page }) => {
    // WHAT THE OLD ASSERTION COULD NOT CATCH: it was `expect(page.url()).not.toContain('/auth')`,
    // and it was UNFALSIFIABLE. LaunchReady has no /auth route and no /login route at all — auth
    // is a modal opened from <Header> (src/components/layout/Header.tsx) — so no URL this app can
    // produce contains '/auth'. A run where the magic link created no session sat on the landing
    // page and reported a healthy login.
    //
    // NO localStorage sb-*-auth-token PROBE HERE, unlike the Valrano login test
    // (tests/valrano/production-monitor.spec.ts:170). LaunchReady's Supabase client is a lazy
    // Proxy (src/lib/supabase.ts) that only calls createClient() on first property access, and the
    // one thing that touches it on the landing page is useAuth inside <Header>, which sits inside
    // <PasswordGate> and is not rendered until the gate is unlocked. So the storage key can be
    // absent after a PERFECTLY GOOD login — the probe would be measuring whether this harness woke
    // the client, not whether the product signed anyone in.
    //
    // What proves the session instead is the dashboard's own signed-in content:
    // src/app/dashboard/page.tsx renders <h2>My Audits</h2> only when `user` is truthy, and shows
    // "Log in to see your audit history." otherwise. Both branches render an h1 "Dashboard", so
    // the h1 proves nothing and is deliberately not used.
    //
    // The gate bypass is set BEFORE the magic-link navigation, so <Header> mounts on the landing
    // page, wakes the lazy client, and lets it persist the session out of the URL hash before we
    // navigate away.
    await page.addInitScript(() => { try { sessionStorage.setItem('launchready-unlocked', 'true') } catch {} })
    await loginViaMagicLink(page, AUTH_CONFIG)
    await page.waitForLoadState('networkidle')

    await page.goto(`${SITE_URL}/dashboard`, { waitUntil: 'networkidle' })
    await page.locator('[role="status"]').waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => {})
    await expect(
      page.locator('h2', { hasText: 'My Audits' }),
      'a signed-in session must render the dashboard audits section',
    ).toBeVisible({ timeout: 20_000 })
    await expect(
      page.locator('text=Log in to see your audit history'),
      'the signed-out dashboard must not be what we are looking at',
    ).toHaveCount(0)
  })

  test('dashboard shows content after login', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_CONFIG)
    await page.goto(`${SITE_URL}/dashboard`, { waitUntil: 'networkidle' })
    await expect(page.locator('body')).not.toBeEmpty()
    const text = await page.locator('body').textContent()
    expect((text || '').length).toBeGreaterThan(50)
  })

  // ── Interaction tests ──────────────────────────────────────────────

  test('audit form accepts URL input and submit button is available', async ({ page }) => {
    await bypassPasswordGate(page, SITE_URL)
    // The AuditForm renders an input with aria-label="Website URL"
    const urlInput = page.locator('input[aria-label="Website URL"]')
    await expect(urlInput).toBeVisible({ timeout: 10_000 })
    await urlInput.fill('https://example.com')
    await expect(urlInput).toHaveValue('https://example.com')
    // Submit button is enabled only when input is non-empty
    const submitBtn = page.locator('button[type="submit"]')
    await expect(submitBtn).toBeVisible()
    await expect(submitBtn).toBeEnabled()
    // Do not submit — would trigger expensive edge function call
  })

  test('dashboard shows audit history or empty-state prompt after login', async ({ page }) => {
    await page.addInitScript(() => { try { sessionStorage.setItem('launchready-unlocked', 'true') } catch {} })
    await loginViaMagicLink(page, AUTH_CONFIG)
    await page.goto(`${SITE_URL}/dashboard`, { waitUntil: 'networkidle' })
    // Wait for the dashboard to finish loading (loading spinner disappears)
    await page.locator('[role="status"]').waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => {})
    // Dashboard renders "My Audits" heading for authenticated users
    const auditsHeading = page.locator('h2', { hasText: 'My Audits' })
    await expect(auditsHeading).toBeVisible({ timeout: 15_000 })
    // Either audit cards or the empty-state prompt must be present. Scope to the
    // "My Audits" section — MonitoredSites renders its own `.space-y-3` above it.
    const auditCards = page.locator('h2', { hasText: 'My Audits' })
      .locator('xpath=../following-sibling::div[contains(@class,"space-y-3")]/div')
    const emptyPrompt = page.locator('p', { hasText: 'No audits yet' })
    const hasCards = await auditCards.count() > 0
    const hasEmpty = await emptyPrompt.isVisible().catch(() => false)
    expect(hasCards || hasEmpty).toBe(true)
  })

  test('dashboard audit cards have scores and dates when audits exist', async ({ page }) => {
    await page.addInitScript(() => { try { sessionStorage.setItem('launchready-unlocked', 'true') } catch {} })
    await loginViaMagicLink(page, AUTH_CONFIG)
    await page.goto(`${SITE_URL}/dashboard`, { waitUntil: 'networkidle' })
    // Wait for loading spinner to disappear before reading dashboard state
    await page.locator('[role="status"]').waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => {})
    await page.locator('h2', { hasText: 'My Audits' }).waitFor({ timeout: 15_000 })
    // Scope to the "My Audits" section only. The dashboard's MonitoredSites
    // component renders its own `.space-y-3` list ABOVE the audits section, so a
    // bare `.space-y-3 > div` would grab a monitored-site card (which has no
    // score <span>, only a ScoreRing) as the "first audit card" and fail.
    const auditCards = page.locator('h2', { hasText: 'My Audits' })
      .locator('xpath=../following-sibling::div[contains(@class,"space-y-3")]/div')
    const count = await auditCards.count()
    if (count > 0) {
      const firstCard = auditCards.first()
      // Each AuditCard shows a numeric score in a <span> with bold styling
      const scoreSpan = firstCard.locator('span.text-2xl')
      await expect(scoreSpan).toBeVisible()
      const scoreVal = await scoreSpan.textContent()
      // NOT `>= 0`: Number('') and Number(null) are both 0, so an EMPTY score span passed, and
      // every score the product can emit is >= 0 anyway. The score is an integer 0-100.
      expect(String(scoreVal ?? '').trim(), 'the audit score must render as an integer').toMatch(/^\d{1,3}$/)
      expect(Number(scoreVal)).toBeLessThanOrEqual(100)
      // Each AuditCard shows a date (month abbreviation from toLocaleDateString)
      const cardText = await firstCard.textContent()
      expect(cardText).toMatch(/Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec/)
    }
    // If no audits exist, the empty-state "Run Audit" link must be present instead
    if (count === 0) {
      await expect(page.locator('a', { hasText: 'Run Audit' })).toBeVisible()
    }
  })

  test('landing page sections all load', async ({ page }) => {
    await bypassPasswordGate(page, SITE_URL)
    // Hero section — badge text is always present
    await expect(page.locator('text=Free audit — no signup required')).toBeVisible({ timeout: 10_000 })
    // Feature pill list below the form (spans rendered with exact text)
    await expect(page.locator('span', { hasText: 'Meta tags' }).first()).toBeVisible()
    await expect(page.locator('span', { hasText: 'Sitemap' }).first()).toBeVisible()
    // "How it works" section — id is on a <div> wrapper around the HowItWorks <section>
    await expect(page.locator('#how-it-works')).toBeAttached()
    await expect(page.locator('h2', { hasText: 'How it works' })).toBeVisible()
    // Four step cards rendered inside HowItWorks
    const steps = page.locator('h3')
    await steps.first().waitFor({ state: 'visible', timeout: 10_000 })
    const stepTitles = await steps.allTextContents()
    expect(stepTitles).toContain('Paste your URL')
    expect(stepTitles).toContain('Get copy-paste fixes')
    // Comparison section
    await expect(page.locator('h2', { hasText: 'Why not just use Lighthouse' })).toBeVisible()
    // Comparison table — LaunchReady column header
    await expect(page.locator('th', { hasText: 'LaunchReady' })).toBeVisible()
  })

  test('privacy page has substantial paragraph content', async ({ page }) => {
    await bypassPasswordGate(page, `${SITE_URL}/privacy`)
    await expect(page.locator('h1', { hasText: 'Privacy Policy' })).toBeVisible({ timeout: 10_000 })
    // Must have multiple headings — scoped to main content section (11 in source)
    const contentSection = page.locator('section').first()
    const h2s = contentSection.locator('h2')
    await expect(h2s).toHaveCount(11)
    // Must contain substantive prose — check unique phrases from the source
    await expect(page.locator('text=Predivo GmbH').first()).toBeVisible()
    await expect(page.locator('text=Küssnacht am Rigi').first()).toBeVisible()
    // Body text must exceed 500 characters of meaningful content
    const bodyText = await contentSection.textContent()
    expect((bodyText || '').replace(/\s+/g, ' ').trim().length).toBeGreaterThan(500)
  })

  test('terms page has substantial paragraph content', async ({ page }) => {
    await bypassPasswordGate(page, `${SITE_URL}/terms`)
    await expect(page.locator('h1', { hasText: 'Terms of Service' })).toBeVisible({ timeout: 10_000 })
    // Must have multiple headings — scoped to main content section (12 in source)
    const contentSection = page.locator('section').first()
    const h2s = contentSection.locator('h2')
    await expect(h2s).toHaveCount(12)
    // Key legal terms from the source must be present
    await expect(page.locator('text=Predivo GmbH').first()).toBeVisible()
    await expect(page.locator('text=CHE-374.611.592').first()).toBeVisible()
    const bodyText = await contentSection.textContent()
    expect((bodyText || '').replace(/\s+/g, ' ').trim().length).toBeGreaterThan(500)
  })

  test('login form: auth modal opens and email input accepts keystrokes', async ({ page }) => {
    // LaunchReady uses modal-based auth (no /login route) — trigger via nav button
    await bypassPasswordGate(page, SITE_URL)

    const authTrigger = page.getByRole('button', { name: /sign in|log in|get started/i }).first()
      .or(page.locator('button:has-text("Sign"), button:has-text("Log"), button:has-text("Get Started")').first())
    if (!(await authTrigger.isVisible({ timeout: 5_000 }).catch(() => false))) {
      test.skip(true, 'No auth trigger button found on landing page')
      return
    }
    await authTrigger.click()
    await page.waitForTimeout(500)

    const emailInput = page.locator('input[type="email"]').first()
    await expect(emailInput).toBeVisible({ timeout: 10_000 })

    const opacity = await emailInput.evaluate(
      (el: HTMLElement) => parseFloat(getComputedStyle(el).opacity),
    )
    expect(opacity, 'Login email input must have opacity > 0').toBeGreaterThan(0)

    await emailInput.fill('test-monitor@example.com')
    expect(await emailInput.inputValue()).toBe('test-monitor@example.com')
  })

  test('site identity — title contains launchready', async ({ page }) => {
    await bypassPasswordGate(page, SITE_URL)
    const title = await page.title()
    const body = await page.textContent('body')
    const combined = `${title} ${body}`.toLowerCase()
    expect(combined, 'launchready.predivo.ch must contain "launchready" branding').toContain('launchready')
  })

  test('impressum page has company details and legal content', async ({ page }) => {
    await bypassPasswordGate(page, `${SITE_URL}/impressum`)
    await expect(page.locator('h1', { hasText: 'Impressum' })).toBeVisible({ timeout: 10_000 })
    // Company name, address, UID must all be present
    await expect(page.locator('text=Predivo GmbH').first()).toBeVisible()
    await expect(page.locator('text=Bahnhofstrasse 55').first()).toBeVisible()
    await expect(page.locator('text=CHE-374.611.592').first()).toBeVisible()
    await expect(page.locator('text=Roger Müller').first()).toBeVisible()
    // Key section headings present (from <h2> elements in the page source)
    await expect(page.locator('h2', { hasText: 'Authorized Representative' })).toBeVisible()
    await expect(page.locator('h2', { hasText: 'Commercial Register' })).toBeVisible()
    const contentSection = page.locator('section').first()
    const bodyText = await contentSection.textContent()
    expect((bodyText || '').replace(/\s+/g, ' ').trim().length).toBeGreaterThan(200)
  })
})
