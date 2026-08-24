import { test, expect, type APIRequestContext } from '@playwright/test';

/**
 * Verifies that every repo with a free-tier Supabase project has a
 * keep-alive.yml GitHub Actions workflow. Catches silent deletions
 * caused by force-pushes, rebases, or repo restructures.
 *
 * Requires DASHBOARD_PAT env var (GitHub PAT with repo read access).
 *
 * ONLY a 404-on-an-otherwise-reachable-repo proves the workflow is gone.
 * Every other non-200 (403 secondary rate limit, 429, 5xx, lost network) says
 * nothing about the file and must NOT be reported as a deletion — on 2026-08-24
 * a shared-PAT secondary rate limit 403'd all 10 lookups and the suite alerted
 * "workflow was likely deleted" for all 10 repos while every file was present.
 * Same rule as the sibling nightly-gauntlet spec: indeterminate => skip, not fail.
 */

const REPOS_REQUIRING_KEEPALIVE = [
  'Arivioo/ReplyFlow',
  'Arivioo/backoffice',
  'Arivioo/ChannelMover',
  'Arivioo/ScoutCopilot',
  'Arivioo/signalscore',
  'Arivioo/launchready',
  'Arivioo/Valrano',
  'Arivioo/BoatBuddy',
  'Arivioo/jass-tour-ui-kit',
  'Arivioo/Cursor_Arivioo',
];

const ghToken = process.env.DASHBOARD_PAT;

// Statuses that mean "ask again later", never "the file is gone".
const TRANSIENT = [403, 429, 500, 502, 503, 504];

async function ghStatus(request: APIRequestContext, url: string): Promise<number> {
  let status = 0;

  // 3 attempts: a secondary rate limit is usually over in seconds, and the whole
  // budget (<=20s of waiting) stays well inside the 60s per-test timeout.
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await request.get(url, {
      headers: {
        Authorization: `Bearer ${ghToken}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });
    status = response.status();
    if (!TRANSIENT.includes(status)) return status;

    if (attempt === 2) break;
    const retryAfter = Number(response.headers()['retry-after']);
    const waitMs =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter, 10) * 1000
        : 2000 * 2 ** attempt;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  return status;
}

for (const repo of REPOS_REQUIRING_KEEPALIVE) {
  test(`workflow-presence: ${repo} has keep-alive.yml`, async ({ request }) => {
    test.skip(!ghToken, 'DASHBOARD_PAT not set');

    const status = await ghStatus(
      request,
      `https://api.github.com/repos/${repo}/contents/.github/workflows/keep-alive.yml`
    );

    test.skip(
      status !== 200 && status !== 404,
      `${repo}: GitHub API returned ${status} for keep-alive.yml — indeterminate (rate limit / outage), skipping to avoid a false alarm`
    );

    // GitHub also answers 404 when the TOKEN cannot see the repo, so confirm the
    // repo itself is readable before claiming a deletion. Costs one extra call on
    // the rare 404 path and keeps the alert's claim airtight.
    if (status === 404) {
      const repoStatus = await ghStatus(request, `https://api.github.com/repos/${repo}`);
      test.skip(
        repoStatus !== 200,
        `${repo}: repo itself returned ${repoStatus} — DASHBOARD_PAT lost access, so the 404 on keep-alive.yml proves nothing; skipping to avoid a false alarm`
      );
    }

    expect(
      status,
      `${repo} is MISSING .github/workflows/keep-alive.yml (HTTP 404 on a repo the token CAN read) — the workflow was deleted by a later commit; its free-tier Supabase project will be paused without it`
    ).toBe(200);
  });
}
