import { test, expect } from '@playwright/test'
import { assertNoSecretInDom, submitSecret } from '../../lib/secretInput'

/**
 * BOATBUDDY'S SITE PASSWORD GATE IS ITS LOGIN.
 *
 * This product has no user accounts, no Supabase auth, no magic link and no OTP. Its entire
 * access control is one component — src/components/shared/PasswordGate.tsx — which SHA-256s
 * whatever you type, compares it to VITE_GATE_PASSWORD_HASH, and on a match sets
 * sessionStorage['boatbuddy-unlocked'] and renders the app. Every route except /phone-upload sits
 * behind it. Typing that password IS the sign-in a real person performs, so it is what "login"
 * means for BoatBuddy and it is what the Fleet health page must report.
 *
 * ── WHY THESE TESTS TYPE THE PASSWORD ───────────────────────────────────────────────────────
 *
 * Setting sessionStorage['boatbuddy-unlocked'] directly would open the app without ever touching
 * the gate. It would prove that React renders children when a flag is set — a fact nobody needs
 * monitored — while the one thing standing between the public internet and this product's data
 * went unchecked. That bypass is exactly the habit this monitoring exists to break, so the tests
 * below drive the real form in a real browser and let the app decide.
 *
 * The NEGATIVE case matters as much as the positive one. A gate that has started accepting
 * anything passes 'full site password login works' perfectly, and nothing else in the BoatBuddy
 * suite would notice, because every other check opens a page that is public anyway. 'wrong site
 * password is refused' is the only assertion in the fleet that the lock is still locked.
 *
 * ── WHY THIS IS ITS OWN FILE, WITH TRACING OFF ──────────────────────────────────────────────
 *
 * Playwright records fill() action parameters verbatim into the trace, and monitor.yml uploads
 * test-results/ and playwright-report/ as a downloadable CI artifact (monitor.yml, "Upload test
 * results"). With the config's `trace: 'on-first-retry'` in force, one retried run would ship the
 * plaintext gate password into that artifact.
 *
 * `test.use({ trace: 'off' })` is only legal at the top level of a file — Playwright rejects it
 * inside a describe group because it forces a new worker — so the two tests that handle the
 * secret live here rather than in production-monitor.spec.ts, which keeps its full diagnostics.
 *
 * ── AND WHY TRACING OFF WAS NOT ENOUGH (2026-09-01) ─────────────────────────────────────────
 *
 * The paragraph above used to end "Screenshots stay on: a password field renders as dots, so a
 * failure screenshot leaks nothing." That was true and it was beside the point. On 2026-09-01 the
 * sister spec tests/jass-tour/user-password-login.spec.ts, carrying the same `trace: 'off'` and
 * the same reasoning, shipped a real plaintext password into a downloadable CI artifact — through
 * neither the trace nor a screenshot, but through test-results/<test>/error-context.md, the
 * accessibility snapshot Playwright writes on EVERY failure, in which a password input's
 * contribution is its value. A defence built from a list of recorders to switch off is only ever
 * as good as the list, and the list was wrong.
 *
 * So the real defence is now lib/secretInput.ts: submitSecret() hands the password to the form
 * and blanks the field in the same breath, inside a `finally`, so the secret is not in the DOM at
 * any moment an assertion below could fail. assertNoSecretInDom() then proves that window is
 * shut rather than assuming it. `trace: 'off'` and `screenshot: 'off'` stay as belt and braces,
 * but they are no longer what is holding this up.
 *
 * BOATBUDDY STILL TYPES, AND MUST. Its password gate IS the login a person performs, so proving
 * it means submitting it; there is no API behind it to call instead. The mitigation here is the
 * blanking, not avoidance.
 *
 * The directory is what maps a spec to a product (scripts/publish-check-results.mjs slugForFile),
 * so splitting the file changes nothing about how these results are published.
 */
test.use({ trace: 'off', screenshot: 'off' })

const SITE_URL = process.env.BOATBUDDY_URL || 'https://boatbuddy.predivo.ch'

/**
 * The shared site password. Never written to a file, never echoed into an assertion message,
 * never printed in a log line.
 */
const GATE_PASSWORD = process.env.BOATBUDDY_GATE_PASSWORD || ''

/** The gate form as PasswordGate.tsx renders it (German UI: "Passwort" / "Weiter"). */
const PASSWORD_FIELD = 'input[type="password"]'
const SUBMIT_BUTTON = 'button[type="submit"]'
/** Only exists inside AppLayout, which only renders once the gate has been passed. */
const APP_SHELL = '#main-content'

test.describe('BoatBuddy — site password gate', () => {
  test('full site password login works and the app opens', async ({ page }) => {
    // SKIP LOUDLY. A missing secret must read as "not tested", never as a pass — an unrun check
    // reported green is the exact defect product_check_run was created to end. The classifier
    // counts a skip in neither checks_total nor checks_passed, so `login` stays grey.
    test.skip(!GATE_PASSWORD, 'BOATBUDDY_GATE_PASSWORD is not set — the site password sign-in was NOT tested')

    await page.goto(SITE_URL, { waitUntil: 'networkidle' })

    const password = page.locator(PASSWORD_FIELD)
    await expect(password, 'a fresh visitor must be met by the password gate').toBeVisible({ timeout: 10_000 })

    // Fills, submits, and blanks the field before returning — see lib/secretInput.ts for the
    // incident that made that mandatory. Everything after this line can fail freely.
    await submitSecret(page, password, GATE_PASSWORD, page.locator(SUBMIT_BUTTON))
    await assertNoSecretInDom(page)

    // '/' is an index route INSIDE the gate that redirects to /dashboard (src/App.tsx), so
    // arriving there is the app opening — it cannot happen while the gate is still holding.
    await page.waitForURL(/\/dashboard/, { timeout: 15_000 })
    await expect(
      page.locator(APP_SHELL),
      'the app shell must render once the gate has been passed',
    ).toBeVisible({ timeout: 10_000 })
    await expect(password, 'the gate must be gone once it has been passed').toHaveCount(0)
  })

  test('wrong site password is refused', async ({ page }) => {
    // Needs no secret, so it never skips: it runs on every hourly run whether or not
    // BOATBUDDY_GATE_PASSWORD is configured. It classifies to no field in
    // scripts/publish-check-results.mjs — "the gate rejects" is not the claim "login works" — but
    // it still counts as a check, so a gate that has started letting anyone in reds the run and
    // fires the alert email.
    await page.goto(SITE_URL, { waitUntil: 'networkidle' })

    const password = page.locator(PASSWORD_FIELD)
    await expect(password, 'a fresh visitor must be met by the password gate').toBeVisible({ timeout: 10_000 })

    // DELIBERATELY NOT submitSecret(). This string is a literal in a public repo, so there is
    // nothing to blank — and blanking would race the app: PasswordGate's handler awaits
    // crypto.subtle.digest before calling setError(true), while the helper's clearing `input`
    // event calls setError(false), so on an unlucky ordering the helper would erase the very
    // alert this test exists to see. The rule is about secrets, and this is not one.
    await password.fill('definitely-not-the-gate-password')
    await page.locator(SUBMIT_BUTTON).click()

    await expect(
      page.locator('[role="alert"]'),
      'a wrong password must be refused with a visible error',
    ).toBeVisible({ timeout: 10_000 })
    await expect(password, 'the gate must still be holding after a wrong password').toBeVisible()
    await expect(
      page.locator(APP_SHELL),
      'A WRONG PASSWORD OPENED THE APP — the site password gate is not enforcing anything',
    ).toHaveCount(0)
  })
})
