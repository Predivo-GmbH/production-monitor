import { test, expect } from '@playwright/test'

/**
 * JASS-TOUR — THE LAST PRODUCT THE HOURLY SUITE HAD NEVER LOOKED AT.
 *
 * `fleet_projects` carries twelve active products. Eleven had a tests/ directory and therefore a
 * row in product_check_run; this one had none at all, so its Fleet health card read "Not checked
 * by the hourly monitor, no run has ever filed a result for this product". That is an honest
 * blank rather than a false green, but it is still a product nobody watches.
 *
 * ── WHAT A VISITOR ACTUALLY MEETS ───────────────────────────────────────────────────────────
 *
 * Everything below https://beize-jass-tour.mueller.ro sits behind THREE layers, and it matters
 * for reading these tests which one each assertion is about:
 *
 *   1. src/components/shared/PasswordGate.tsx — a shared site gate wrapping the ENTIRE app
 *      (App.tsx renders <PasswordGate> outside the router, so even /auth is behind it). It
 *      SHA-256s what you type, compares it to a hash compiled into the bundle, and on a match
 *      sets sessionStorage['jasstour-unlocked'].
 *   2. src/pages/Auth.tsx, "Passwort" tab — a second shared password, checked server-side by the
 *      edge function verify-jass-password, which sets sessionStorage['jass-access'].
 *   3. src/pages/Auth.tsx, "Login" tab — REAL user accounts via supabase.auth.signInWithPassword.
 *
 * Layer 3 is the only per-user identity in the product, and it is what
 * tests/jass-tour/user-password-login.spec.ts proves. It lives in its own file because it types a
 * real credential and Playwright writes fill() arguments verbatim into traces.
 *
 * ── WHY THERE IS NO POSITIVE GATE TEST HERE ─────────────────────────────────────────────────
 *
 * BoatBuddy has one ('full site password login works and the app opens') because its gate IS its
 * login. Jass-Tour's gate is not a login — it is a beta door in front of a product that has real
 * accounts — and no JASSTOUR_GATE_PASSWORD secret exists on this repo, so there is nothing to
 * type. The NEGATIVE case needs no secret and is worth having on its own: a gate that has started
 * accepting anything would be noticed by nothing else in this suite, because every other check
 * here opens a page that the gate serves to the public anyway.
 *
 * Every test in this file drives the gate page as a stranger sees it. Nothing here sets
 * sessionStorage, so nothing here can pass by pretending to be already inside.
 */

const SITE_URL = process.env.JASSTOUR_URL || 'https://beize-jass-tour.mueller.ro'

/** The gate form as PasswordGate.tsx renders it (German UI: "Zugangscode" / "Eintreten"). */
const GATE_FIELD = 'input[type="password"]'
const GATE_SUBMIT = 'button[type="submit"]'
/** Only exists inside Layout, which only renders for a route that cleared ProtectedRoute. */
const APP_SHELL = '#main-content'

test.describe('Jass-Tour — Production Monitor', () => {
  test('landing page loads', async ({ page }) => {
    await page.goto(SITE_URL)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('body')).not.toBeEmpty()
    const text = await page.textContent('body')
    expect(text?.length).toBeGreaterThan(50)
  })

  test('site identity — title contains Beize Jass Tour', async ({ page }) => {
    await page.goto(SITE_URL, { waitUntil: 'networkidle' })
    const title = await page.title()
    const body = await page.textContent('body')
    const combined = `${title} ${body}`.toLowerCase()
    // 'beize jass tour' is the brand_keyword the registry already carries for this slug
    // (Cockpit/sql/049_projects_registry.sql), and it is the <title> the live document serves.
    expect(combined, 'beize-jass-tour.mueller.ro must contain "beize jass tour" branding').toContain('beize jass tour')
    expect(title.toLowerCase(), 'Title must not be hijacked').not.toContain('lovable')
    expect(title.toLowerCase(), 'Title must not be hijacked').not.toContain('boatbuddy')
  })

  test('root document is served (not 5xx / not paused)', async ({ request }) => {
    const res = await request.get(SITE_URL, { failOnStatusCode: false })
    expect(res.status(), `Jass-Tour returned ${res.status()} — site DOWN`).toBeLessThan(500)
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

  test('wrong site password is refused', async ({ page }) => {
    // Needs no secret, so it never skips. It classifies to no field in
    // scripts/publish-check-results.mjs — "the gate rejects" is not the claim "login works" — but
    // it counts as a check, so a gate that has started letting anyone in reds the run and fires
    // the alert email. It is the only assertion anywhere that this beta door is still shut.
    await page.goto(SITE_URL, { waitUntil: 'networkidle' })

    const code = page.locator(GATE_FIELD)
    await expect(code, 'a fresh visitor must be met by the site password gate').toBeVisible({ timeout: 10_000 })

    await code.fill('definitely-not-the-jass-tour-access-code')
    await page.locator(GATE_SUBMIT).click()

    await expect(
      page.locator('[role="alert"]'),
      'a wrong access code must be refused with a visible error',
    ).toBeVisible({ timeout: 10_000 })
    await expect(code, 'the gate must still be holding after a wrong access code').toBeVisible()
    await expect(
      page.locator(APP_SHELL),
      'A WRONG ACCESS CODE OPENED THE APP — the site password gate is not enforcing anything',
    ).toHaveCount(0)
  })
})
