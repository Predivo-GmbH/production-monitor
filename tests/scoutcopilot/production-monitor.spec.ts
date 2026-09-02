import { test, expect } from '@playwright/test'
import { loginViaMagicLink, ensureTestUser } from '../../lib/auth'
import { fetchRouteManifest, checkPublicRoutes } from '../../lib/publicRoutes'

const SITE_URL = process.env.SCOUTCOPILOT_URL || 'https://scoutcopilot.com'
const SUPABASE_URL = process.env.SCOUTCOPILOT_SUPABASE_URL!
const SERVICE_ROLE_KEY = process.env.SCOUTCOPILOT_SERVICE_ROLE_KEY!
const ANON_KEY = process.env.SCOUTCOPILOT_ANON_KEY!
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
  await page.evaluate(() => sessionStorage.setItem('scoutcopilot-unlocked', 'true'))
  await page.goto(url, { waitUntil: 'networkidle' })
}

/**
 * Click the page's Search SUBMIT button — not the sidebar navigation item.
 *
 * ScoutCopilot renders TWO buttons whose text is exactly "Search": the sidebar
 * nav entry (src/components/layout/Sidebar.tsx:24 — `{ path: '/search', key:
 * 'search' }`, rendered as a <button>) and the real submit button beside
 * #player-search (src/features/search/SearchPage.tsx:105-113, onClick=handleSearch).
 * The sidebar sits OUTSIDE <main id="main-content"> (AppShell.tsx:116) and BEFORE
 * it in the DOM, so the selector all three call sites used —
 *   page.locator('button').filter({ hasText: /^search$/i }).first()
 * — resolved to the NAVIGATION item every time. Clicking it merely re-navigated to
 * the page already open, handleSearch() never ran, and the results panel sat on its
 * "Start a search / Results will appear here" placeholder for the whole 60s wait.
 *
 * Production proves it never once fired: search_queries holds 38 rows, the newest
 * 2026-05-05, while these tests have run hourly ever since. The backend was never
 * the problem — POST /functions/v1/search returns 200 with Lionel Messi in ~4s.
 *
 * The count assertion is the real fix. `.first()` on an ambiguous locator silently
 * clicking the wrong element is precisely the failure above, and it stayed invisible
 * for months because the assertions that followed could not fail either. If another
 * "Search"-labelled button ever lands inside <main>, this now fails at the click
 * with the reason, instead of quietly exercising the wrong widget.
 */
async function clickSearchSubmit(page: import('@playwright/test').Page): Promise<void> {
  const btn = page.locator('main#main-content button').filter({ hasText: /^search$/i })
  await expect(
    btn,
    'expected exactly one "Search" submit button inside <main id="main-content"> — ' +
      'the sidebar nav item is also labelled "Search", and matching that one instead ' +
      'means no search is ever run',
  ).toHaveCount(1)
  await btn.click()
}

test.describe('ScoutCopilot — Production Monitor', () => {
  test.beforeAll(async () => {
    await ensureTestUser(SUPABASE_URL, SERVICE_ROLE_KEY, TEST_EMAIL)
  })

  // ─── Public Pages ─────────────────────────────────────────────

  // ── Public routes: manifest-driven ──────────────────────────────────
  // Every public route is smoke-tested from the deployed manifest at
  // ${SITE_URL}/monitor-routes.json, generated from ScoutCopilot's single
  // source of truth (scripts/monitor-routes.mjs). Adding/removing a public
  // route there updates this automatically. ScoutCopilot is a pure SPA (no
  // prerender), so there is no build-time route gate — this not-found check is
  // what catches a broken/removed route.
  test('public routes from manifest load and render (not 404/empty)', async ({ page, request }) => {
    // Manifest fetch + per-route render checks live in lib/publicRoutes.ts so
    // all projects share one correct implementation (no per-spec drift).
    const { isJsonManifest, status, contentType, manifest } = await fetchRouteManifest(request, SITE_URL)
    test.skip(!isJsonManifest, `monitor-routes.json not deployed yet (got ${status} ${contentType || 'no content-type'})`)
    expect((manifest!.routes ?? []).length, 'manifest contains no routes').toBeGreaterThan(0)

    // Bypass the client-side PasswordGate on every navigation (persists across
    // the goto()s inside checkPublicRoutes).
    await page.addInitScript(() => {
      try { sessionStorage.setItem('scoutcopilot-unlocked', 'true') } catch { /* ignore */ }
    })

    const failures = await checkPublicRoutes(page, SITE_URL, manifest!)
    expect(failures, `Public route checks failed:\n${failures.join('\n')}`).toEqual([])
  })

  test('login page loads', async ({ page }) => {
    await bypassPasswordGate(page, `${SITE_URL}/login`)
    await expect(page.locator('body')).not.toBeEmpty()
    const text = await page.locator('body').textContent()
    expect((text || '').length).toBeGreaterThan(50)
  })

  // ─── Authenticated Pages ──────────────────────────────────────

  test('full login works and dashboard loads', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_CONFIG)
    await page.waitForLoadState('networkidle')

    // WHY THIS READS THE SESSION INSTEAD OF ASSERTING not.toContain('/auth').
    //
    // ScoutCopilot signs in at /:lang/login (src/App.tsx:76) — only the Supabase
    // callbacks live under /auth. loginViaMagicLink redirects to SITE_URL, and '/'
    // is <Navigate to="/en">, the public LandingPage. So a run where the session was
    // never established sits on 'https://scoutcopilot.com/en': a URL containing no
    // '/auth' at all, and the old assertion passed with nobody logged in. It could
    // not fail for the failure it was written to catch.
    //
    // What proves a session is the session itself: supabase-js persists it in
    // localStorage under sb-<project-ref>-auth-token (src/lib/supabase.ts uses the
    // default storage). Same fix as tests/valrano/production-monitor.spec.ts.
    // Polled, because the SPA writes the key while it consumes the URL hash.
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            Object.keys(localStorage).some(
              (k) => k.startsWith('sb-') && k.endsWith('-auth-token') && !!localStorage.getItem(k),
            ),
          ),
        {
          message: 'a real Supabase session must exist in localStorage after the magic link',
          timeout: 15_000,
        },
      )
      .toBe(true)

    const url = page.url()
    expect(url, 'a signed-in session must not be sitting on a login route').not.toMatch(
      /\/(login|signup|auth)(?![a-z])/,
    )
  })

  test('dashboard loads after login', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_CONFIG)
    // Navigate to dashboard — let the app handle language prefix
    await page.goto(`${SITE_URL}/dashboard`, { waitUntil: 'networkidle' })
    await expect(page.locator('body')).not.toBeEmpty()
    const text = await page.locator('body').textContent()
    expect((text || '').length).toBeGreaterThan(50)
  })

  test('search page loads after login', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_CONFIG)
    await page.goto(`${SITE_URL}/search`, { waitUntil: 'networkidle' })
    await expect(page.locator('body')).not.toBeEmpty()
    const text = await page.locator('body').textContent()
    expect((text || '').length).toBeGreaterThan(50)
  })

  test('settings page loads after login', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_CONFIG)
    await page.goto(`${SITE_URL}/settings`, { waitUntil: 'networkidle' })
    await expect(page.locator('body')).not.toBeEmpty()
    const text = await page.locator('body').textContent()
    expect((text || '').length).toBeGreaterThan(50)
  })

  // ─── Real User Interaction Tests ──────────────────────────────

  test('player search flow: enter query and verify results table loads', async ({ page }) => {
    // A real ScoutCopilot search is slow on purpose: Claude parses the query, the
    // providers are polled, then Claude ranks the result set. Measured against
    // production on 2026-09-02: 'Messi' (name lookup) 4.2s, 'Strikers with goals'
    // (filter query) 15.8s server-side, 22.7s to the browser, 25.1s to painted rows.
    // The 60s wait below therefore needs a test budget bigger than 60s — the config
    // default is exactly 60s (playwright.config.ts:21), so login and navigation would
    // eat into the very window this test is trying to measure.
    test.setTimeout(120_000)
    await page.addInitScript(() => { try { sessionStorage.setItem('scoutcopilot-unlocked', 'true') } catch {} })
    await loginViaMagicLink(page, AUTH_CONFIG)
    await page.goto(`${SITE_URL}/search`, { waitUntil: 'networkidle' })

    // The search input has id="player-search" (confirmed in SearchPage.tsx)
    const searchInput = page.locator('#player-search')
    await expect(searchInput).toBeVisible({ timeout: 15_000 })

    // Type a query
    await searchInput.fill('Messi')

    // Click the Search SUBMIT button. The comment that used to sit here said "same
    // selector as passing 'player detail' test" — both were clicking the sidebar nav
    // item, and "passing" was the lenient assertion below, not a working search.
    await clickSearchSubmit(page)

    // Wait for the search to ANSWER: a result count, the empty state, or a row.
    // Strings confirmed in SearchResultsTable.tsx + src/i18n/en.json:
    //   search.playersFound = 'players found' / search.playerFound = 'player found'
    //   search.noResults    = 'No players found'  (the empty state)
    //
    // THE `undefined` IS LOAD-BEARING, NOT NOISE — do not "tidy" it away. The signature is
    // waitForFunction(pageFunction, arg, options): with only two arguments the object
    // becomes the ARG handed to the callback, and the timeout silently falls back to
    // use.actionTimeout (playwright.config.ts:47 — 15s). All six call sites in this
    // file were written that way. The recorded trace of the 2026-09-02 red run shows
    // it exactly: arg={"k":"timeout","v":{"n":60000}} beside timeout:15000, and the
    // wait ending 15.0s after the click. So this test announced "no result within 60s"
    // having waited 15 — while the search it was watching answers in 16-23s. It was
    // reporting the harness's own deadline as a production outage. lib/publicRoutes.ts
    // passes the arg correctly; test/waitforfunction-timeout.test.mjs now enforces it.
    const gotResponse = await page.waitForFunction(
      () => {
        const body = document.body.textContent?.toLowerCase() ?? ''
        return (
          body.includes('players found') ||
          body.includes('player found') ||
          body.includes('no players found') ||
          document.querySelector('table tbody tr') !== null
        )
      },
      undefined,
      { timeout: 60_000 },
    ).then(() => true).catch(() => false)

    // A search backend that never answers must turn this test red. The old form
    // swallowed the timeout and asserted only bodyText.length > 50 — but the shell,
    // nav and headings are always > 50 characters, so a total search outage passed
    // as green. Same leniency tests/signalscore/production-monitor.spec.ts deleted
    // for its Zefix search (§'"Migros" MUST return results').
    expect(
      gotResponse,
      'search for "Messi" produced no result count, no empty state and no row within 60s — search pipeline down?',
    ).toBe(true)
    // The re-read of body text that used to follow was implied by the assertion
    // above: it tested the same three signals waitForFunction had just matched.
  })

  test('player detail view: search then click first result to view profile', async ({ page }) => {
    // Same reason as the search-flow test above, plus a profile navigation afterwards.
    test.setTimeout(120_000)
    await page.addInitScript(() => { try { sessionStorage.setItem('scoutcopilot-unlocked', 'true') } catch {} })
    await loginViaMagicLink(page, AUTH_CONFIG)
    await page.goto(`${SITE_URL}/search`, { waitUntil: 'networkidle' })

    const searchInput = page.locator('#player-search')
    await expect(searchInput).toBeVisible({ timeout: 10_000 })
    await searchInput.fill('Strikers with goals')

    // Button text is "Search" (t('search.searchBtn')) — but so is the sidebar nav
    // item's, so the submit button is resolved inside <main> (see clickSearchSubmit).
    await clickSearchSubmit(page)

    // SearchResultsTable renders <tr role="link"> rows in table view (default on desktop).
    // Grid view renders [role="button"][aria-label="<player>: <name>"].
    // Wait for rows or the empty state. The empty-state string used to be 'no results'
    // — that is the i18n KEY (search.noResults); the rendered English text is
    // 'No players found' (src/i18n/en.json). Matching the key meant a genuine empty
    // state was never recognised, which only stayed invisible because the timeout
    // below was non-fatal.
    const hasResults = await page.waitForFunction(
      () => {
        const rows = document.querySelectorAll('table tbody tr[role="link"]')
        const cards = document.querySelectorAll('[role="button"][aria-label^="Player:"]')
        const body = document.body.textContent ?? ''
        return rows.length > 0 || cards.length > 0 || body.toLowerCase().includes('no players found')
      },
      undefined,
      { timeout: 60_000 },
    ).then(() => true).catch(() => false)

    // Must fail when the search answered with nothing at all. The old form caught the
    // timeout and asserted bodyText.length > 50, which the app shell satisfies even
    // when the search backend is dead — so it could not detect the outage it was
    // watching for (leniency removed in tests/signalscore/production-monitor.spec.ts).
    expect(
      hasResults,
      'search produced no row, no card and no empty state within 60s — search pipeline down?',
    ).toBe(true)

    // Check if we got actual results or the empty state
    const bodyText = (await page.locator('body').textContent()) ?? ''
    if (bodyText.toLowerCase().includes('no players found')) {
      // Empty state is a valid outcome — return. The expect() that used to sit here
      // re-asserted the exact substring this `if` had just matched, so it could never
      // fail; taking this branch already proves the empty state rendered.
      return
    }

    // Click the first player row (table view) — rows have role="link" and navigate to /players/:id
    const firstRow = page.locator('table tbody tr[role="link"]').first()
    await firstRow.click()

    // Verify we landed on a player detail page (/en/players/:id or /players/:id)
    await page.waitForLoadState('networkidle')
    expect(page.url()).toMatch(/\/players\//)

    // Player profile should contain meaningful content
    const profileText = (await page.locator('body').textContent()) ?? ''
    const hasProfileContent =
      profileText.length > 200 &&
      (profileText.toLowerCase().includes('age') ||
       profileText.toLowerCase().includes('club') ||
       profileText.toLowerCase().includes('position') ||
       profileText.toLowerCase().includes('goals') ||
       profileText.toLowerCase().includes('report'))
    expect(hasProfileContent).toBe(true)
  })

  test('dashboard interaction: metric cards and quick actions are present', async ({ page }) => {
    await page.addInitScript(() => { try { sessionStorage.setItem('scoutcopilot-unlocked', 'true') } catch {} })
    await loginViaMagicLink(page, AUTH_CONFIG)
    await page.goto(`${SITE_URL}/dashboard`, { waitUntil: 'networkidle' })

    // Wait for the dashboard h1 heading (t('dashboard.heading') = "Dashboard")
    const heading = page.locator('h1').first()
    await expect(heading).toBeVisible({ timeout: 10_000 })

    // Wait until the stats grid role="status" is gone (loading complete) or
    // at least one metric card div is present (bg-surface-container + border + min-h).
    // DashboardPage renders 4 metric cards as <div class="bg-surface-container border ...">
    // during loading it renders skeleton divs with the same outer classes — so we wait
    // for the role="status" attribute to be removed from the grid.
    await page.waitForFunction(
      () => {
        // role="status" is set on the grid only while statsLoading is true
        const statusGrid = document.querySelector('[role="status"][aria-live="polite"]')
        // Also accept if we can find a non-skeleton card (has a <p> child with font-data text)
        const cards = document.querySelectorAll('.bg-surface-container.border')
        return !statusGrid || cards.length >= 1
      },
      undefined,
      { timeout: 15_000 },
    )

    // Quick actions: 3 role="button" cards — "New Player Search", "View Players", "Compare Players"
    // Confirmed in DashboardPage.tsx — each has role="button" and aria-label from t() keys
    const bodyText = (await page.locator('body').textContent()) ?? ''
    const hasQuickActions =
      bodyText.toLowerCase().includes('search') &&
      bodyText.toLowerCase().includes('player')
    expect(hasQuickActions).toBe(true)

    // "SYSTEM LIVE" badge: <span class="...font-data...">t('dashboard.systemLive')</span>
    // In English this renders as "SYSTEM LIVE". We match the containing span loosely.
    const liveIndicator = page.locator('span').filter({ hasText: /live/i }).first()
    await expect(liveIndicator).toBeVisible({ timeout: 5_000 })

    // Recent searches section is always rendered (table or empty state).
    // DashboardPage renders it as an <h3> holding t('dashboard.recentSearches') =
    // 'Recent Searches' (DashboardPage.tsx:107), outside the has-rows conditional.
    // The old check was an OR that included 'search' — a substring the quick-actions
    // assertion five lines above had already proven present — so it could not fail
    // even if the whole Recent Searches panel had disappeared. Assert the heading.
    await expect(
      page.getByRole('heading', { name: /recent searches/i }).first(),
      'the Recent Searches panel must render (header is unconditional)',
    ).toBeVisible({ timeout: 10_000 })
  })

  test('settings interaction: settings tabs and profile form load', async ({ page }) => {
    await page.addInitScript(() => { try { sessionStorage.setItem('scoutcopilot-unlocked', 'true') } catch {} })
    await loginViaMagicLink(page, AUTH_CONFIG)
    await page.goto(`${SITE_URL}/settings`, { waitUntil: 'domcontentloaded' })

    // SettingsPage renders two tab UIs:
    //   - Mobile: <ScrollableTabBar> (horizontal scrollable buttons, rendered in a div, visible on < md)
    //   - Desktop: <nav class="hidden md:block"> with <button> elements (visible on >= md)
    // The desktop nav is always in the DOM; we don't need to worry about viewport
    // because Playwright's default viewport is 1280x720 (desktop), so md: styles apply.
    await page.waitForFunction(
      () => {
        const nav = document.querySelector('nav')
        return nav !== null && (nav.textContent ?? '').length > 20
      },
      undefined,
      { timeout: 15_000 },
    )

    // Default active tab is 'profile' — ProfileSettings renders account form content
    const bodyText = (await page.locator('body').textContent()) ?? ''
    const hasSettingsTabs =
      bodyText.toLowerCase().includes('account') ||
      bodyText.toLowerCase().includes('billing') ||
      bodyText.toLowerCase().includes('api') ||
      bodyText.toLowerCase().includes('settings')
    expect(hasSettingsTabs).toBe(true)

    // Click the Billing tab — in the desktop sidebar nav (hidden md:block nav > button)
    // t('settings.tabs.billing') = "Billing" in English
    // We target nav button directly; Playwright default viewport is 1280px so nav is visible.
    const billingBtn = page.locator('nav button').filter({ hasText: /billing/i }).first()
    await expect(billingBtn).toBeVisible({ timeout: 5_000 })
    await billingBtn.click()

    // BillingSettings renders a section with heading t('settings.billing.heading') = "Billing"
    // and a plan info div containing t('settings.billing.plan') = "Plan" alongside the tier name.
    await page.waitForFunction(
      () => {
        const body = document.body.textContent ?? ''
        return body.toLowerCase().includes('plan') || body.toLowerCase().includes('billing')
      },
      undefined,
      { timeout: 10_000 },
    )

    // The old assertion here matched /plan|billing|subscription|tier/ against the body —
    // but the waitForFunction directly above had already waited for 'plan' or 'billing',
    // and the word "Billing" is on the page before any click, in the nav tab we just
    // pressed. It therefore could not fail even if BillingSettings never mounted.
    // 'Current Usage' (t('settings.billing.currentUsage'), BillingSettings.tsx:82) exists
    // ONLY in the loaded panel — not in the nav, not in the role="status" loading state —
    // so it proves the panel actually rendered.
    await expect(
      page.getByText(/current usage/i).first(),
      'clicking the Billing tab must render the loaded BillingSettings panel',
    ).toBeVisible({ timeout: 15_000 })
  })

  test('site identity — title contains scoutcopilot', async ({ page }) => {
    await bypassPasswordGate(page, SITE_URL)
    const title = await page.title()
    const body = await page.textContent('body')
    const combined = `${title} ${body}`.toLowerCase()
    expect(combined, 'scoutcopilot.com must contain "scoutcopilot" branding').toContain('scoutcopilot')
  })

  test('login form: fields accept input and opacity > 0', async ({ page }) => {
    await bypassPasswordGate(page, `${SITE_URL}/login`)

    const emailInput = page.locator('input[type="email"]').first()
    await expect(emailInput).toBeVisible({ timeout: 10_000 })

    const opacity = await emailInput.evaluate(
      (el: HTMLElement) => parseFloat(getComputedStyle(el).opacity),
    )
    expect(opacity, 'Login email input must have opacity > 0').toBeGreaterThan(0)

    await emailInput.fill('test-monitor@example.com')
    expect(await emailInput.inputValue()).toBe('test-monitor@example.com')
  })

  test('search filters: position filter changes and UI reflects the update', async ({ page }) => {
    await page.addInitScript(() => { try { sessionStorage.setItem('scoutcopilot-unlocked', 'true') } catch {} })
    await loginViaMagicLink(page, AUTH_CONFIG)
    await page.goto(`${SITE_URL}/search`, { waitUntil: 'networkidle' })

    // SearchFilters renders 3 native <select> elements with stable IDs:
    //   #filter-position  (options: filterOptions.allPositions, filterOptions.goalkeeper, ...)
    //   #filter-age-range (options: filterOptions.allAges, "16 - 19", "20 - 23", ...)
    //   #filter-league    (options: filterOptions.allLeagues, filterOptions.premierLeague, ...)
    // Option VALUES are i18n keys (e.g. "filterOptions.goalkeeper"), NOT the display text.
    const positionSelect = page.locator('#filter-position')
    const ageSelect = page.locator('#filter-age-range')
    await expect(positionSelect).toBeVisible({ timeout: 10_000 })
    await expect(ageSelect).toBeVisible({ timeout: 5_000 })

    // Confirm all 3 filter selects are present
    const selectCount = await page.locator('select').count()
    expect(selectCount).toBeGreaterThanOrEqual(3)

    // Get the VALUE of option at index 1 (not the text — option values are i18n keys)
    const positionOptionValue = await positionSelect.locator('option').nth(1).getAttribute('value')
    expect(positionOptionValue).toBeTruthy()

    // Select the second option by value (the i18n key, e.g. "filterOptions.goalkeeper")
    await positionSelect.selectOption({ index: 1 })
    const selectedPosition = await positionSelect.inputValue()
    expect(selectedPosition).toBe(positionOptionValue)

    // Select age range option at index 1 (value = "16 - 19" — age options use literal values)
    const ageOptionValue = await ageSelect.locator('option').nth(1).getAttribute('value')
    expect(ageOptionValue).toBeTruthy()
    await ageSelect.selectOption({ index: 1 })
    const selectedAge = await ageSelect.inputValue()
    expect(selectedAge).toBe(ageOptionValue)

    // Run a search to confirm filters are retained across the search action
    const searchInput = page.locator('#player-search')
    await searchInput.fill('Messi')
    // Same ambiguity as the two search tests: this one claims to prove the filters
    // survive "the search action", and was clicking the sidebar nav item, so no
    // search action ever happened and the retention assertions below were vacuous.
    await clickSearchSubmit(page)

    // Wait for search to complete (results or timeout — non-fatal)
    await page.waitForFunction(
      () => {
        const body = document.body.textContent?.toLowerCase() ?? ''
        return (
          body.includes('found') ||
          body.includes('no player') ||
          document.querySelector('table tbody tr') !== null
        )
      },
      undefined,
      { timeout: 60_000 },
    ).catch(() => {})

    // Verify position select retained its chosen value after search
    const positionAfterSearch = await positionSelect.inputValue()
    expect(positionAfterSearch).toBe(positionOptionValue)
  })
})
