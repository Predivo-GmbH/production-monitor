import { test, expect } from '@playwright/test';

/**
 * Nightly-gauntlet health.
 *
 * For each tiered (Supabase-staged) product, verify the most recent SCHEDULED run of
 * deploy.yml — the nightly gate-critical / gate-integration / gate-e2e gauntlet against
 * LIVE STAGING (deploy-standard.md §4b) — did not fail.
 *
 * WHY HERE (consolidation, not a parallel system): this is the ALERT path for the nightly
 * gauntlet. It runs inside the hourly production-monitor, so a failed nightly rides the
 * SAME notification chain as every other monitor check — send-alert.mjs email to Roger,
 * auto-resolve ("all clear") email, and the healthchecks.io dead-man's-switch. No per-repo
 * "send alert on failure" steps, no second alerting system. The Deploy-Status page already
 * VIEWS each repo's latest run; this adds the missing PUSH alert through the one engine that
 * already owns alerting. (Health Monitor = on-demand LIVE-PROD health view; this = STAGING
 * regression alert — different target, complementary, not duplicative.)
 *
 * A red nightly means ONE OF THIS PRODUCT'S GATES FAILED, and this file does not know which until
 * it asks. It used to say "a real-login / integration / E2E gate regressed against staging" here
 * and in the alert text, for every red run whatever caused it. On 2026-09-02 that sentence was
 * wrong on both products it fired for: Valrano run 33592350429 and ReplyFlow run 33592503987 had
 * gate-e2e GREEN and only gate-security red, on a browserslist advisory that `npm audit fix`
 * clears. The alert sent somebody to debug end-to-end tests that were passing, and it nearly
 * stopped a release that had nothing wrong with it.
 *
 * So the alert NAMES THE JOB THAT FAILED and states no cause beyond that, and when the job list
 * cannot be read it says so instead of guessing. An alarm that asserts the wrong cause with full
 * confidence is worse than no alarm, because people act on it.
 *
 * Defensive by design: only a definitive 'failure'/'timed_out' conclusion alerts. A GitHub
 * API error, no-run-yet (first nightly hasn't fired), an in-progress run, or a 'cancelled'
 * run all SKIP — a transient API blip must never raise a false alarm.
 *
 * PERSISTENCE GATE (Roger's alerting philosophy, 2026-07-23: "alert only on persistent breakage,
 * transient = noise"). A staging gauntlet can go red for a few minutes on a self-healing blip —
 * e.g. Supabase momentarily rotating its ES256 signing key so an admin auth call 403s — which
 * flaky-retry.mjs then reruns green. We must NOT page on that window. So a failure alerts ONLY
 * once it has PERSISTED past the auto-retry self-heal window: either the run was already retried
 * (run_attempt >= 2 and still red = a rerun didn't fix it), OR it is old enough (> 2h) that
 * flaky-retry's window has elapsed without recovery. A fresh first-attempt failure SKIPS — the
 * auto-fix layer gets its chance first. This is the exact false page from 2026-07-24 (SignalScore
 * attempt-1 JWT teardown blip, reran green minutes later — should never have emailed).
 *
 * Requires DASHBOARD_PAT (GitHub PAT with actions:read). Already provided to the monitor job.
 */

const TIERED_REPOS = [
  'Arivioo/signalscore',
  'Arivioo/ChannelMover',
  'Arivioo/Valrano',
  'Arivioo/ReplyFlow',
  'Arivioo/BoatBuddy',
];

const ghToken = process.env.DASHBOARD_PAT;

for (const repo of TIERED_REPOS) {
  test(`nightly-gauntlet: ${repo} last scheduled staging gauntlet is not failing`, async ({ request }) => {
    test.skip(!ghToken, 'DASHBOARD_PAT not set');

    const res = await request.get(
      `https://api.github.com/repos/${repo}/actions/workflows/deploy.yml/runs?event=schedule&per_page=1`,
      { headers: { Authorization: `Bearer ${ghToken}`, Accept: 'application/vnd.github.v3+json' } },
    );
    test.skip(res.status() !== 200, `GitHub API returned ${res.status()} for ${repo} — skipping to avoid a false alarm`);

    const body = await res.json();
    const runs = body.workflow_runs ?? [];
    test.skip(runs.length === 0, `${repo}: no scheduled gauntlet run yet (nightly schedule not fired)`);

    const latest = runs[0];
    test.skip(latest.status !== 'completed', `${repo}: latest scheduled gauntlet still ${latest.status}`);

    // Only a definitive failure is a candidate; a green/cancelled latest run is healthy.
    const isFail = ['failure', 'timed_out'].includes(latest.conclusion);
    test.skip(!isFail, `${repo}: latest scheduled gauntlet is '${latest.conclusion}' — healthy`);

    // PERSISTENCE GATE — page only once the failure has outlived the auto-retry self-heal window
    // (see header). run_attempt >= 2 → flaky-retry already reran it and it's STILL red = persistent.
    // Otherwise require the failure to be > 2h old so flaky-retry's window has passed.
    const startedAt = latest.run_started_at ?? latest.created_at;
    const ageHours = (Date.now() - new Date(startedAt).getTime()) / 3_600_000;
    const attempt = latest.run_attempt ?? 1;
    const persistent = attempt >= 2 || ageHours >= 2;
    test.skip(
      !persistent,
      `${repo}: scheduled gauntlet failed on attempt ${attempt}, ${ageHours.toFixed(1)}h ago — inside the auto-retry self-heal window, not yet persistent (no page).`,
    );

    // SUPERSEDED GATE (Roger's "transient = noise" philosophy, applied to the fix-landed-before-next-
    // nightly window). A red scheduled gauntlet reflects the code AT latest.head_sha. The common real
    // case: a nightly goes red, the fix is pushed the SAME day, but the next scheduled run that would
    // re-confirm green is up to ~24h away (cron '50 4 * * *'). Paging every hour across that window is
    // noise about an ALREADY-FIXED failure (this exact case: 2026-08-15 ReplyFlow v13-gates config
    // misroute, fixed in e58b7a1 minutes after the 05:08Z nightly failed). So if the failed run is
    // SUPERSEDED — a newer commit has landed on the default branch since — AND we are still inside one
    // nightly cycle (<26h, i.e. the next scheduled run has not yet had its turn), SKIP and let the next
    // nightly reconfirm. This does NOT weaken prod safety: the ACTUAL promotion gate is deploy.yml's
    // gate-e2e at workflow_dispatch time (independent of this notification), and once >26h elapse with
    // no fresh scheduled run the suppression lifts and we page again (a stuck cron is itself worth a page).
    // Fail-safe: any error resolving the default-branch tip → do NOT suppress (fall through and page).
    if (ageHours < 26 && latest.head_sha) {
      const tipRes = await request.get(
        `https://api.github.com/repos/${repo}/commits?per_page=1`,
        { headers: { Authorization: `Bearer ${ghToken}`, Accept: 'application/vnd.github.v3+json' } },
      );
      if (tipRes.ok()) {
        const tip = (await tipRes.json())[0]?.sha;
        test.skip(
          !!tip && tip !== latest.head_sha,
          `${repo}: failed scheduled gauntlet (${String(latest.head_sha).slice(0, 7)}) is SUPERSEDED by a newer commit (${String(tip).slice(0, 7)}) — a fix likely already landed; awaiting the next nightly to reconfirm. Real regressions still block prod at the promotion gate.`,
        );
      }
    }

    // NAME THE ACTUALLY-FAILING GATE, don't hardcode E2E wording. A red nightly can be ANY gate
    // (gate-security/audit, gate-integration, gate-edge-typecheck, gate-e2e). Hardcoding
    // "real-login / integration / E2E gate regressed" masked a browserslist advisory that only
    // failed gate-security for hours and pointed at the wrong subsystem (Valrano run 33592350429,
    // 2026-09-02: gate-integration/edge-typecheck/e2e all green, only gate-security red).
    // Defensive: any error resolving the job list → fall back to a generic phrasing, never block
    // the alert or SKIP on it.
    // A FAILED READ IS SAID OUT LOUD, never smoothed into a plausible sentence. "one or more
    // gates regressed against staging" reads like a finding; it is the absence of one.
    let whatFailed = 'the failing job could not be read from GitHub, so this alert cannot say which gate it was';
    const jobsRes = await request.get(
      `https://api.github.com/repos/${repo}/actions/runs/${latest.id}/jobs?per_page=100`,
      { headers: { Authorization: `Bearer ${ghToken}`, Accept: 'application/vnd.github.v3+json' } },
    );
    if (jobsRes.ok()) {
      const jobs = (await jobsRes.json()).jobs ?? [];
      const failed = jobs.filter((j: { conclusion: string }) => ['failure', 'timed_out'].includes(j.conclusion));
      // The failing STEP is what a person needs; "gate-security" alone still sends them looking.
      const named = failed.map((j: { name: string; steps?: Array<{ name: string; conclusion: string }> }) => {
        const step = (j.steps ?? []).find((s) => ['failure', 'timed_out'].includes(s.conclusion));
        return step ? `${j.name} (step "${step.name}")` : j.name;
      });
      if (named.length) {
        whatFailed = `the job(s) that failed: ${named.join('; ')}`;
      } else {
        // The run is red and no job is. That is a real state (a workflow-level failure, a
        // cancelled matrix) and it is not the same as "we did not look".
        whatFailed = 'the run is red but no individual job reports a failure, so the fault is at the workflow level';
      }
    }

    expect(
      isFail && persistent,
      `${repo} NIGHTLY GAUNTLET PERSISTENTLY FAILING — ${whatFailed}. The auto-retry did not recover it (attempt ${attempt}, ${ageHours.toFixed(1)}h, ${latest.html_url}). Read that job before promoting ${repo} to production; whether it blocks the promotion depends on which gate it is.`,
    ).toBe(false);
  });
}
