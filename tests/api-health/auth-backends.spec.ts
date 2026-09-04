import { test, expect } from '@playwright/test';

/**
 * CAN A CUSTOMER LOG IN? Written 2026-09-01, after nobody could, for twenty hours.
 *
 * On 2026-08-31 the auth service died on ReplyFlow and SignalScore and stayed dead until the
 * next morning. Three separate checks reported both products healthy the whole time, and the
 * one red we did get named "public routes from manifest load and render", because auth died
 * inside a test fixture and Playwright attributes a failed fixture to whatever test came first.
 * The test literally named "full login works" was SKIPPED, so it was reported as neither pass
 * nor fail, and whoever responded went looking at the frontend.
 *
 * This file exists so that failure has a name of its own. It asserts ONE thing per product, in
 * a sentence that cannot be mistaken for anything else, and it does it before any browser,
 * fixture or login flow is involved, so nothing else can absorb the failure.
 *
 * TWO RULES IT KEEPS, both learned that day:
 *
 *   1. THE PROBE CARRIES THE ANON KEY. Supabase's gateway rejects a keyless request itself and
 *      answers 401 before it ever reaches GoTrue. Measured on both dead projects that morning:
 *      keyless 401, keyed 503. A keyless probe of this endpoint reports healthy with the auth
 *      service deleted, which is exactly what check-products-down.mjs did, hourly, all night.
 *   2. ANYTHING THAT IS NOT A KEYED 200 IS A FAILURE, stated as a status, not as a guess. No
 *      "not 500" and no "under 500": this endpoint answers 200 when GoTrue is serving, and the
 *      whole point is to stop being clever about which non-200 is tolerable.
 *
 * Discovery is generic, the same way check-supabase-machine-health.mjs does it: any
 * <PREFIX>_SUPABASE_URL with a matching <PREFIX>_ANON_KEY is checked, so a new product is
 * covered the moment its secrets exist, without anyone editing this file. And the count is
 * asserted, because a suite that checks nothing passes.
 */

interface AuthTarget {
  name: string;
  ref: string;
  url: string;
  anonKey: string;
}

/** Every project the environment can actually prove something about, found rather than listed. */
export function discoverAuthTargets(env: NodeJS.ProcessEnv = process.env): AuthTarget[] {
  const targets: AuthTarget[] = [];
  for (const [key, value] of Object.entries(env)) {
    const m = /^([A-Z0-9_]+)_SUPABASE_URL$/.exec(key);
    if (!m || !value) continue;
    const anonKey = env[`${m[1]}_ANON_KEY`];
    if (!anonKey) continue;
    const ref = (value.match(/https:\/\/([a-z0-9]+)\.supabase\.co/) || [])[1];
    if (!ref) continue;
    targets.push({ name: m[1], ref, url: value.replace(/\/$/, ''), anonKey });
  }
  return targets.sort((a, b) => a.name.localeCompare(b.name));
}

const targets = discoverAuthTargets();

/**
 * The floor. 14 projects carry both secrets today (measured 2026-09-01 from the same env the
 * keep-alive suite reads, which asserts the same floor for the same reason). A dropped secret
 * silently removes a product from this file, and a suite that quietly checks fewer things is
 * the failure this whole audit is about.
 */
const MINIMUM_TARGETS = 14;

// @network-free is READ BY THE ALERT, not by a test filter. This spec counts an env-built array and
// makes no request, so it passes in a total product blackout; scripts/lib/parse-failures.mjs
// (NON_PRODUCT_SPEC_TAG) must not count it as proof the runner reached a product, or a blackout gets
// relabelled "N failure(s) across N project(s)". The exclusion used to be keyed on this test's TITLE,
// which meant rewording the sentence below — or raising MINIMUM_TARGETS past 14 — silently switched
// the gate off. Do not remove the tag; test/a-spec-exclusion-cannot-drift-on-a-reworded-title.test.mjs
// fails if you do. The keyed probes further down deliberately carry NO tag: they are the real evidence.
test('auth: at least 14 projects are actually being checked', { tag: '@network-free' }, () => {
  expect(
    targets.length,
    `Only ${targets.length} projects have both a _SUPABASE_URL and an _ANON_KEY, so the rest are not checked at all: ${targets.map((t) => t.name).join(', ')}`,
  ).toBeGreaterThanOrEqual(MINIMUM_TARGETS);
});

/** Staging counts too: the same config mistake reaches it first. It just is not a customer. */
const isStaging = (name: string) => /_STAGING$/.test(name);

for (const target of targets) {
  const what = isStaging(target.name) ? 'nobody can log in to staging' : 'a customer can log in';
  test(`auth backend answers, so ${what}: ${target.name}`, async ({ request }) => {
    const response = await request.get(`${target.url}/auth/v1/health`, {
      headers: { apikey: target.anonKey, Authorization: `Bearer ${target.anonKey}` },
      timeout: 15_000,
    });
    const status = response.status();
    const body = (await response.text()).slice(0, 200);
    expect(
      status,
      `${target.name} (${target.ref}) auth/v1/health answered ${status}: ${body}. ` +
        `A 5xx here means ${isStaging(target.name) ? 'staging logins are dead' : 'nobody can sign up or log in'}. ` +
        'A 401 means this probe lost its key and is proving nothing.',
    ).toBe(200);
  });
}
