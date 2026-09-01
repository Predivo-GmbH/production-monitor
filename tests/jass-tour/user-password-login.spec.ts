import { test, expect, request as playwrightRequest } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import { ensureTestUser, resolveUserIdByEmail } from '../../lib/auth'

/**
 * JASS-TOUR'S REAL SIGN-IN IS EMAIL + PASSWORD, AND IT IS THE ONLY ONE THIS PRODUCT HAS.
 *
 * ── WHY NOT loginViaMagicLink, WHICH EVERY OTHER SIGNING-IN PRODUCT USES ────────────────────
 *
 * The product does not offer it. src/pages/Auth.tsx has three tabs — a shared password checked by
 * the verify-jass-password edge function, signInWithPassword, and signUp. There is no
 * signInWithOtp anywhere in jass-tour-ui-kit, so a magic-link test would prove a flow no person
 * can use here.
 *
 * ── WHY THIS TEST NO LONGER TYPES THE PASSWORD (2026-09-01, AFTER A REAL LEAK) ──────────────
 *
 * The first version of this file drove the real form: it typed the monitor account's password
 * into the login field and let GoTrue decide. It carried `test.use({ trace: 'off' })` and a
 * comment explaining that screenshots were safe because a password field renders as dots. Both
 * statements were true, and the credential leaked anyway.
 *
 * The sign-in failed against production, and Playwright wrote test-results/<test>/error-context.md
 * — an accessibility snapshot of the page, which it writes on EVERY failure, independently of the
 * trace and screenshot settings. In an accessibility tree a password input's contribution is its
 * VALUE, so the file contained the line `- textbox "Passwort" [ref=e27]: <the real password>`,
 * and monitor.yml's upload-artifact step published test-results/ as a downloadable artifact. The
 * artifacts were deleted and the secret rotated.
 *
 * The lesson is not "switch off one more recorder". It is that a defence assembled from a list of
 * Playwright outputs is only as good as the list, and there is no way to know the list is
 * complete. The reliable rule is that the secret must not be in the DOM at a moment an assertion
 * can fail. lib/secretInput.ts implements that rule for the case where typing IS the claim, which
 * is BoatBuddy's site password gate: it has no API behind it, so tests/boatbuddy still submits the
 * form and blanks the field in the same breath.
 *
 * HERE THERE IS AN API, so the far better answer is to never put the credential on a page at all.
 * This test:
 *
 *   a) calls signInWithPassword from Node with the product's own anon key, so GoTrue itself
 *      decides whether the real password is accepted — that is the claim, and it is decided by
 *      the same endpoint and the same account the browser form would have used;
 *   b) injects the session GoTrue returned into the browser's localStorage under the key
 *      supabase-js derives from the project ref, then hard-navigates to a route that exists only
 *      behind ProtectedRoute, so the app has to honour a real session to let us in;
 *   c) reads the session back out of the browser and checks it carries an access token and
 *      belongs to the monitor's address.
 *
 * That is STRICTLY MORE than typing proved. The old test proved the credential and then leaned on
 * the app's own navigation; this one proves the credential AND that the app admits a genuine
 * Supabase session, with the shortcut flag stripped. Nothing is ever typed, so there is nothing
 * for an accessibility snapshot to record.
 *
 * ── THE TRAP THIS ROUTE STILL HAS TO AVOID ──────────────────────────────────────────────────
 *
 * src/components/ProtectedRoute.tsx admits anyone carrying sessionStorage['jass-access'] ===
 * 'granted' WITHOUT consulting Supabase. The init script below therefore REMOVES that flag on
 * every document load, which forces ProtectedRoute down its supabase.auth.getUser() path — a
 * network call to the project, with the injected token. /rangliste exists only behind
 * ProtectedRoute, so rendering it is entry earned by the session alone.
 *
 * The outer PasswordGate (sessionStorage['jasstour-unlocked']) is set directly here. It is a beta
 * door, not a sign-in, and it is proven separately and honestly by 'wrong site password is
 * refused' in production-monitor.spec.ts.
 *
 * ── WHY TRACING IS STILL OFF ────────────────────────────────────────────────────────────────
 *
 * No password reaches the browser, but a live access token does, as an argument to addInitScript,
 * and Playwright records init-script arguments in the trace. A bearer token is a credential for
 * as long as it lives. Screenshots stay ON: a token is never rendered, and a screenshot of a
 * bounced ProtectedRoute is the single most useful thing to look at when this check goes red.
 *
 * The DIRECTORY is what maps a spec to a product (publish-check-results.mjs slugForFile), so the
 * split from production-monitor.spec.ts changes nothing about how these results are published,
 * and the title 'full password login works...' is what classifies this as login_method
 * 'user-password'. Neither may drift without updating that classifier.
 */
test.use({ trace: 'off' })

const SITE_URL = process.env.JASSTOUR_URL || 'https://beize-jass-tour.mueller.ro'
const SUPABASE_URL = process.env.JASSTOUR_SUPABASE_URL || ''
const ANON_KEY = process.env.JASSTOUR_ANON_KEY || ''
const SERVICE_ROLE_KEY = process.env.JASSTOUR_SERVICE_ROLE_KEY || ''
const TEST_EMAIL = process.env.TEST_EMAIL || 'healthcheck-test@predivo.ch'

/**
 * The monitor user's password on the Jass-Tour project ONLY. Every Supabase project has its own
 * auth.users table, so setting it here cannot touch the same address on any other product.
 *
 * It is handed to exactly one function — supabase.auth.signInWithPassword, in Node — and never
 * reaches a page, a locator, a log line or an assertion message.
 */
const TEST_PASSWORD = process.env.JASSTOUR_TEST_PASSWORD || ''

const READY = Boolean(SUPABASE_URL && ANON_KEY && SERVICE_ROLE_KEY && TEST_PASSWORD)

/** `https://<ref>.supabase.co` -> `<ref>`. Empty string for anything that is not a project URL. */
function projectRefOf(url: string): string {
  try {
    return new URL(url).hostname.split('.')[0] || ''
  } catch {
    return ''
  }
}

/**
 * WHICH SUPABASE PROJECT DOES THE DEPLOYED SITE ACTUALLY TALK TO?
 *
 * Measured, not assumed, and this is the check that would have saved a day. The monitor's
 * JASSTOUR_* secrets and the product's VITE_SUPABASE_URL are two entirely separate pieces of
 * configuration that nothing has ever compared, and on 2026-09-01 they disagreed: see the
 * comment on the 'the monitored Supabase project' test below. When they disagree, every
 * credential this suite prepares is prepared in the wrong database, and the resulting failure
 * reads as "users cannot sign in to Jass-Tour" when the truth is "the monitor is looking at the
 * wrong project".
 *
 * The site is a Vite SPA, so its Supabase URL is a literal in the shipped bundle: fetch the
 * document, fetch every /assets/*.js it references, and collect every project host that appears.
 * No credential of any kind is needed for this — it is all public bytes.
 */
async function projectRefsTheSiteUses(siteUrl: string): Promise<string[]> {
  const api = await playwrightRequest.newContext()
  try {
    const refs = new Set<string>()
    const scan = (text: string) => {
      for (const m of text.matchAll(/https:\/\/([a-z0-9]{16,32})\.supabase\.co/g)) refs.add(m[1])
    }

    const indexRes = await api.get(siteUrl, { timeout: 30_000 })
    const html = await indexRes.text()
    scan(html)

    const assets = new Set<string>()
    for (const m of html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.js)"/g)) assets.add(m[1])
    for (const asset of assets) {
      const res = await api.get(new URL(asset, siteUrl).toString(), { timeout: 30_000 })
      if (res.ok()) scan(await res.text())
    }

    return [...refs].sort()
  } finally {
    await api.dispose()
  }
}

/** Resolved once per worker by the beforeAll below, and read by both tests. */
let siteRefs: string[] = []
let configuredRef = ''
/** True only when the monitor's project and the site's project are provably the same one. */
let watchingTheRightProject = false

test.describe('Jass-Tour — user password login', () => {
  test.beforeAll(async () => {
    configuredRef = projectRefOf(SUPABASE_URL)
    siteRefs = await projectRefsTheSiteUses(SITE_URL)
    watchingTheRightProject = Boolean(configuredRef) && siteRefs.length === 1 && siteRefs[0] === configuredRef

    // Do NOT seed an account into a project we have just proved is not the one serving this
    // domain. Writing a password into the wrong database is how the misconfiguration stayed
    // invisible: every run "succeeded" at preparing something nobody was ever going to read.
    if (!READY || !watchingTheRightProject) return

    // Establish the precondition rather than depending on whatever the prod project happens to
    // hold: the account exists, is confirmed, and its password is the one this run will present.
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

  /**
   * THE CHECK THAT EXPLAINS THE OTHER ONE.
   *
   * On 2026-09-01 this suite reported Jass-Tour's login as broken, with the app's own
   * 'E-Mail oder Passwort falsch' on screen, while the product's sign-in was working perfectly.
   * The monitor's JASSTOUR_SUPABASE_URL points at one Supabase project; the bundle served from
   * https://beize-jass-tour.mueller.ro provably calls a DIFFERENT one. The beforeAll set the
   * monitor account's password in project A and the browser then presented it to project B,
   * which refused it exactly as it should.
   *
   * That is not a product defect and no amount of work on the test can fix it: the monitor's
   * secrets have to be repointed at the project the deployed site uses. So this failure is
   * reported on its own, in its own words, and the login test above it SKIPS rather than
   * lying — an unrun check reported red is as wrong as an unrun check reported green.
   *
   * Deliberately classifies to NO field in scripts/publish-check-results.mjs (the title avoids
   * every classifier pattern): "the monitor is misconfigured" is not a statement about the
   * product's login, site, identity or backend. It still counts as a check, so it reds the run
   * and fires the alert.
   */
  test('the monitored Supabase project is the one this product signs in against', async () => {
    test.skip(!SUPABASE_URL, 'JASSTOUR_SUPABASE_URL is not set — there is nothing to compare')

    expect(
      siteRefs,
      'no Supabase project host could be found in the deployed bundle, so this check proved ' +
        'nothing. Either the site is not serving its normal assets, or the build stopped inlining ' +
        'VITE_SUPABASE_URL and projectRefsTheSiteUses() needs updating.',
    ).not.toHaveLength(0)

    expect(
      siteRefs,
      `THE MONITOR IS WATCHING THE WRONG SUPABASE PROJECT. ${SITE_URL} authenticates against ` +
        `[${siteRefs.join(', ')}], but JASSTOUR_SUPABASE_URL points at '${configuredRef}'. Every ` +
        'credential this suite prepares is being written into a database the product never reads, ' +
        'so the sign-in check cannot run and its result would be meaningless if it did. THIS IS ' +
        'NOT A PRODUCT OUTAGE: fix the JASSTOUR_SUPABASE_URL / JASSTOUR_ANON_KEY / ' +
        'JASSTOUR_SERVICE_ROLE_KEY secrets, and check supabase-keep-alive.yml, ' +
        'check-auth-email-config.mjs, check-rls-grants.mjs and ' +
        'scripts/lib/supabase-projects-baseline.json, which all name the same wrong project.',
    ).toEqual([configuredRef])
  })

  test('full password login works and a protected route opens', async ({ page }) => {
    // SKIP LOUDLY. A missing secret must read as "not tested", never as a pass — an unrun check
    // reported green is the exact defect product_check_run was created to end. The classifier
    // counts a skip in neither checks_total nor checks_passed, so `login` stays grey.
    test.skip(
      !READY,
      'JASSTOUR_SUPABASE_URL / JASSTOUR_ANON_KEY / JASSTOUR_SERVICE_ROLE_KEY / ' +
        'JASSTOUR_TEST_PASSWORD are not all set — the user sign-in was NOT tested',
    )
    test.skip(
      !watchingTheRightProject,
      'the monitor is pointed at a different Supabase project than the deployed site uses, so no ' +
        'credential here belongs to the product — the user sign-in was NOT tested. The check above ' +
        'reports it.',
    )

    // ── (a) THE CREDENTIAL ITSELF. GoTrue decides, using the product's own anon key against the
    //    product's own project, which is precisely what the form would have done. Nothing is
    //    typed, so nothing can be snapshotted.
    const asUser = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    const { data, error } = await asUser.auth.signInWithPassword({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    })
    expect(
      error?.message ?? null,
      'GoTrue refused the monitor account — Jass-Tour cannot sign a real user in with a correct ' +
        'email and password',
    ).toBeNull()
    const session = data?.session
    expect(session, 'signInWithPassword returned no session').toBeTruthy()
    expect(session!.access_token.length, 'the session GoTrue returned carries no access token').toBeGreaterThan(0)
    expect(session!.user?.email, 'the session belongs to a different account than the one that signed in')
      .toBe(TEST_EMAIL)

    // ── (b) THE APP HAS TO HONOUR IT. supabase-js derives its storage key from the project ref
    //    (`sb-${hostname.split('.')[0]}-auth-token`) and jass-tour-ui-kit does not override it,
    //    so writing the session there is exactly what a real sign-in would have left behind.
    const storageKey = `sb-${configuredRef}-auth-token`
    await page.addInitScript(
      ([key, serialised]: [string, string]) => {
        try {
          localStorage.setItem(key, serialised)
          sessionStorage.setItem('jasstour-unlocked', 'true')
          // The shortcut ProtectedRoute would otherwise accept INSTEAD of a session. Removed on
          // every document load, so entry has to be earned by supabase.auth.getUser().
          sessionStorage.removeItem('jass-access')
        } catch {
          /* first-party storage unavailable; the assertions below will say so */
        }
      },
      [storageKey, JSON.stringify(session)] as [string, string],
    )

    await page.goto(`${SITE_URL}/rangliste`, { waitUntil: 'networkidle' })
    await expect(
      page.locator('h1', { hasText: 'Ewige Rangliste' }),
      'ProtectedRoute did not admit a real Supabase session — the app is not honouring a genuine sign-in',
    ).toBeVisible({ timeout: 15_000 })
    expect(
      new URL(page.url()).pathname,
      'ProtectedRoute bounced the signed-in session back to /auth',
    ).toBe('/rangliste')
    await expect(page.locator('#main-content'), 'the app shell must render once signed in').toBeVisible({
      timeout: 15_000,
    })

    // ── (c) A SESSION THAT SURVIVED, read back out of the browser rather than out of the variable
    //    we put there. Only what is safe to assert on comes back across.
    const persisted = await page.evaluate(() => {
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
    expect(persisted.found, 'no Supabase session survived in the browser — nothing was actually signed in').toBe(true)
    expect(persisted.hasAccessToken, 'the persisted session carries no access token').toBe(true)
    expect(persisted.email, 'the persisted session belongs to a different account').toBe(TEST_EMAIL)
  })
})
