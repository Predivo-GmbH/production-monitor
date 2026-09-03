import { test, expect } from '@playwright/test';
// @ts-expect-error — plain-JS libs, shared with the node unit tests that own their rules.
import { scheduleFreshness, corroborateStopped, STOPPED_VERDICTS, FRESH_FLOOR_HOURS, OVERDUE_FACTOR } from '../../scripts/lib/gauntlet-staleness.mjs';
// @ts-expect-error — see above.
import { extractCronSchedules, cronPeriodHours } from '../../scripts/lib/cron-cadence.mjs';
// @ts-expect-error — see above.
import { pickJudgeableRun, describeSkipped } from '../../scripts/lib/gauntlet-verdict.mjs';
// @ts-expect-error — see above.
import { recoveredSince, failedJobNames } from '../../scripts/lib/gauntlet-recovery.mjs';

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
 * AND A GREEN RUN IS ONLY EVIDENCE WHILE IT IS RECENT (2026-09-03). "Did the newest scheduled
 * run fail" answers nothing once there stops being a new one, so a gauntlet that quietly stops
 * firing used to read as healthy forever. The freshness gate in the green branch below closes
 * that; the rule lives in scripts/lib/gauntlet-staleness.mjs and is unit-tested separately.
 * NOTE the older sentence in the SUPERSEDED block — "a stuck cron is itself worth a page" —
 * described only the failure path when it was written; the green path is what this gate adds.
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

    // One constant, used by BOTH the first read and the corroborating read below, so the second
    // read cannot silently drift into asking a different question than the one it is confirming.
    const runsUrl = `https://api.github.com/repos/${repo}/actions/workflows/deploy.yml/runs?event=schedule&per_page=10`;
    const ghHeaders = { Authorization: `Bearer ${ghToken}`, Accept: 'application/vnd.github.v3+json' };

    const res = await request.get(runsUrl, { headers: ghHeaders });
    test.skip(res.status() !== 200, `GitHub API returned ${res.status()} for ${repo} — skipping to avoid a false alarm`);

    const body = await res.json();
    const runs = body.workflow_runs ?? [];

    // A CANCELLED RUN IS NOT A PASS (2026-09-03). Until this block existed the check judged
    // runs[0] and asked only "did it fail?" — so a cancelled nightly answered "no" and was
    // reported healthy, in this file's own words "latest scheduled gauntlet is 'cancelled' —
    // healthy". Worse, being a NEW run its recent timestamp also made the freshness gate below
    // answer FRESH, reopening through a different door the hole 863c731 had closed hours
    // earlier the same morning. Measured on the live fleet over ~240 scheduled runs: ReplyFlow
    // runs 33049024073 (2026-08-27) and 31080989158 (2026-08-06) each ran gate-e2e for roughly
    // twenty minutes and were then cancelled — gauntlets that genuinely did not finish.
    // A cancel is NOT turned into a failure here (it has benign causes and paging on one would
    // be the false alarm this repo forbids); it is simply not allowed to stand in for a verdict.
    // The rule lives in scripts/lib/gauntlet-verdict.mjs, unit-tested in
    // test/gauntlet-verdict.test.mjs against the original behaviour. The window widened from 1
    // run to 10 — the same single API call — so an inconclusive run can be stepped over.
    const pick = pickJudgeableRun(runs);
    test.skip(pick.verdict === 'NO_RUNS', `${repo}: no scheduled gauntlet run yet (nightly schedule not fired)`);
    test.skip(pick.verdict === 'PENDING', `${repo}: ${pick.reason} — not judged this hour.`);
    test.skip(pick.verdict === 'UNPROVEN', `${repo}: ${pick.reason}. One blip is not an alarm.`);
    expect(
      pick.verdict,
      `${repo} NIGHTLY GAUNTLET IS NEVER COMPLETING — ${pick.reason}. Nothing has gone red because a cancelled run is not a failed run, but nothing has been tested against live staging either. Check whether the gauntlet is hitting a job timeout, losing its runner, or being cancelled by a concurrency group.`,
    ).not.toBe('NONE_CONCLUSIVE');

    // From here `latest` is the newest run that ACTUALLY CONCLUDED, so every question below —
    // did it fail, is it still fresh, has it been superseded — is asked of a run that ran.
    const latest = pick.judged;
    const skippedNote = describeSkipped(pick.skipped);

    // Only a definitive failure is a candidate; a green latest run is healthy.
    const isFail = ['failure', 'timed_out'].includes(latest.conclusion);

    // IS THAT GREEN RUN STILL SAYING ANYTHING? (2026-09-03.) Until this block existed, the line
    // below returned "healthy" the instant the newest scheduled run was green, whatever its age
    // — so a nightly gauntlet that STOPS FIRING reported healthy forever and the whole staging
    // regression net for this product disappeared without one red. The header above already
    // claimed a stuck cron was covered ("once >26h elapse ... we page again"); that arithmetic
    // lived inside the failure branch below and a green run never reached it. Measured the same
    // morning: three fleet repos had been silent 62 days and were still counted green.
    // The rule itself lives in scripts/lib/gauntlet-staleness.mjs and is unit-tested there
    // (test/nightly-gauntlet-staleness.test.mjs) against injected defects; this block only
    // gathers the facts it judges. Under FRESH_FLOOR_HOURS nothing extra is fetched, so the
    // normal hourly path costs no additional GitHub calls.
    if (!isFail) {
      const startedMs = new Date(latest.run_started_at ?? latest.created_at).getTime();
      const greenAgeHours = (Date.now() - startedMs) / 3_600_000;

      let archived: boolean | null = null;
      let yamlRead = false;
      let cronCount = 0;
      let periodHours: number | null = null;

      if (greenAgeHours >= FRESH_FLOOR_HOURS) {
        // An archived repo legitimately stops scheduling; that is retirement, not breakage.
        const repoRes = await request.get(`https://api.github.com/repos/${repo}`, { headers: ghHeaders });
        if (repoRes.ok()) archived = !!(await repoRes.json()).archived;

        const wfRes = await request.get(
          `https://api.github.com/repos/${repo}/contents/.github/workflows/deploy.yml`,
          { headers: ghHeaders },
        );
        if (wfRes.ok()) {
          const yaml = Buffer.from((await wfRes.json()).content ?? '', 'base64').toString('utf-8');
          yamlRead = true;
          const crons: string[] = extractCronSchedules(yaml);
          cronCount = crons.length;
          // Several crons on one workflow = it fires on the SHORTEST of them; being judged
          // against the longest would forgive a schedule that had already stopped.
          const periods = crons.map((c) => cronPeriodHours(c)).filter((p: number | null) => Number.isFinite(p));
          if (periods.length) periodHours = Math.min(...(periods as number[]));
        }
      }

      // FRESH-FLOOR SOUNDNESS — asserted against the REAL cron just read from deploy.yml, not a
      // literal. The 26h fresh-floor is only a safe stand-in for an UNKNOWN period while
      // OVERDUE_FACTOR x the real period still clears it (see gauntlet-staleness.mjs). Under the
      // fast path (a fresh green run) the period is never fetched, so the floor could silently go
      // unsound the day a gauntlet is made sub-daily. Here — the one place we do hold the real
      // period — we make that unsoundness a loud finding instead: if 3x the actual interval no
      // longer clears the floor, this fails so the floor is brought down with the schedule.
      if (periodHours !== null) {
        expect(
          OVERDUE_FACTOR * periodHours,
          `${repo} FRESH-FLOOR IS UNSOUND FOR THIS SCHEDULE — deploy.yml now fires every ${periodHours}h, so it is overdue after ${OVERDUE_FACTOR}x = ${OVERDUE_FACTOR * periodHours}h, but the unknown-period floor holds a stopped run FRESH until ${FRESH_FLOOR_HOURS}h. Lower FRESH_FLOOR_HOURS in scripts/lib/gauntlet-staleness.mjs to <= ${OVERDUE_FACTOR * periodHours}, or a stopped ${repo} gauntlet reads FRESH for up to ${FRESH_FLOOR_HOURS - OVERDUE_FACTOR * periodHours}h.`,
        ).toBeGreaterThanOrEqual(FRESH_FLOOR_HOURS);
      }

      const f = scheduleFreshness({ ageHours: greenAgeHours, archived, yamlRead, cronCount, periodHours });
      // Only a stopped schedule pages. RETIRED and UNPROVEN are named out loud and stay quiet —
      // a GitHub API blip must never red the hourly monitor.
      test.skip(
        f.verdict === 'RETIRED' || f.verdict === 'UNPROVEN',
        `${repo}: latest scheduled gauntlet is green but ${greenAgeHours.toFixed(1)}h old and its freshness is ${f.verdict} — ${f.reason}. Not treated as an alarm.`,
      );

      // SEE THE ABSENCE TWICE BEFORE ANNOUNCING IT (2026-09-03, the second hole found in this
      // gate the same day). On run 33723882661 this endpoint answered 200 with a page whose
      // newest scheduled run was NINETEEN DAYS old, and ChannelMover's nightly had in fact run
      // 2h earlier; the Playwright retry 2.2s later read the true page. The alarm below asserts
      // that something is NOT THERE, and the only evidence for that is one list we were handed
      // once — so unlike every other paging path in this file it could not survive a single bad
      // read. It now re-asks and requires both reads to name the same newest run and agree.
      // Costs one extra GitHub call ONLY on the stopped path, which is empty on a healthy fleet.
      // Rule and full incident: scripts/lib/gauntlet-staleness.mjs.
      if (STOPPED_VERDICTS.includes(f.verdict)) {
        let second: { ok: boolean; verdict?: string; newestRunId?: unknown } = { ok: false };
        const res2 = await request.get(runsUrl, { headers: ghHeaders });
        if (res2.ok()) {
          const pick2 = pickJudgeableRun((await res2.json()).workflow_runs ?? []);
          if (pick2.verdict === 'JUDGE') {
            const started2 = new Date(pick2.judged.run_started_at ?? pick2.judged.created_at).getTime();
            // Only the RUN LIST is re-read. archived/cron come from the repo and the workflow
            // file, which are not what a stale run page gets wrong, so re-fetching them would
            // add calls and prove nothing.
            const f2 = scheduleFreshness({
              ageHours: (Date.now() - started2) / 3_600_000,
              archived,
              yamlRead,
              cronCount,
              periodHours,
            });
            second = { ok: true, verdict: f2.verdict, newestRunId: pick2.judged.id };
          }
        }
        const seenTwice = corroborateStopped({ verdict: f.verdict, newestRunId: latest.id }, second);
        test.skip(
          !seenTwice.confirmed,
          `${repo}: the newest scheduled gauntlet read as ${f.verdict} (${f.reason}) but that was NOT CONFIRMED — ${seenTwice.reason}. Staying quiet; the next hourly run asks again, and a schedule that has really stopped answers the same way every time.`,
        );
        expect(
          f.verdict,
          `${repo} NIGHTLY GAUNTLET HAS STOPPED RUNNING — ${f.reason}. Its last scheduled run PASSED, which is why nothing has gone red: this check reports on the newest scheduled run, and there has not been a new one. Nothing has tested ${repo} against live staging since ${new Date(startedMs).toISOString()}. Check whether deploy.yml's schedule was removed, the workflow was disabled, or GitHub disabled it for repository inactivity (${latest.html_url}). This was ${seenTwice.reason}.${skippedNote}`,
        ).toBe('FRESH');
      }

      // NO VERDICT GETS A FREE PASS. The block above is entered only for the verdicts named in
      // STOPPED_VERDICTS, so a verdict added to scheduleFreshness later and classified nowhere
      // would fall straight through to "healthy" — the precise shape of the bug this whole gate
      // exists to close. FRESH is the only thing allowed past here; RETIRED and UNPROVEN have
      // already skipped out above. (test/nightly-gauntlet-staleness.test.mjs also asserts the
      // classification is exhaustive, so this should be unreachable — which is the point.)
      expect(
        f.verdict,
        `${repo}: freshness verdict '${f.verdict}' is not classified as fresh, retired, unproven or stopped, so this check does not know whether it is an alarm. Classify it in scripts/lib/gauntlet-staleness.mjs rather than letting it read as healthy.`,
      ).toBe('FRESH');
    }

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
    // The bare job names, kept alongside the human phrasing, so the recovery gate below looks up
    // exactly the gates this alert is about to name. Empty = we could not read them, which never
    // clears a page.
    let failedNames: string[] = [];
    const jobsRes = await request.get(
      `https://api.github.com/repos/${repo}/actions/runs/${latest.id}/jobs?per_page=100`,
      { headers: { Authorization: `Bearer ${ghToken}`, Accept: 'application/vnd.github.v3+json' } },
    );
    if (jobsRes.ok()) {
      const jobs = (await jobsRes.json()).jobs ?? [];
      const failed = jobs.filter((j: { conclusion: string }) => ['failure', 'timed_out'].includes(j.conclusion));
      failedNames = failedJobNames(jobs);
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

    // AN UNREADABLE JOBS ENDPOINT IS A WARN, NEVER A PAGE (2026-09-03, BoatBuddy run 33591920887).
    // Everything below decides "persistently failing" and phrases the alert from the judged run's
    // JOB list, and the recovery gate that follows can only ask "has that gate passed since?" when
    // it knows the gate's NAME. When this endpoint could not be read we have neither: `failedNames`
    // is empty, so the recovery check is skipped, and the run still counts as `isFail && persistent`
    // — so the page fires asserting "the failing job could not be read from GitHub", a staging
    // regression we never actually observed. Proven that night: this endpoint returned non-200 for
    // the monitor's DASHBOARD_PAT (it was readable with another PAT, rate limit 3384/5000 — a
    // token/permission failure, not availability) while `gate-security` had in fact concluded
    // SUCCESS in the newer scheduled run 33718969126, so the page chased a gate that had already
    // recovered. A jobs-read failure is a GitHub/token problem, not proof of a regression, and this
    // file already skips on exactly that shape for the runs-list read above (`res.status() !== 200`).
    // Skipping here does not blind the monitor: the DASHBOARD_PAT-present floor test still fails if
    // the token vanishes entirely, and the next hourly run re-reads — a real persistent failure with
    // a readable job list still pages through the unchanged path below.
    test.skip(
      !jobsRes.ok(),
      `${repo}: the judged scheduled gauntlet (${latest.id}) concluded '${latest.conclusion}', but its job list could not be read from GitHub (jobs endpoint returned ${jobsRes.status()}). Not paging — an unreadable jobs endpoint is a monitor/token problem, not a proven staging regression, and without the failing gate's name the recovery check cannot ask whether it has passed since. The next hourly monitor re-reads.${skippedNote}`,
    );

    // HAS THAT GATE PASSED SINCE? (2026-09-03, monitor run 33731470295.) Everything above decides
    // "persistently failing" from the judged run's own age and attempt count — a good proxy when
    // there is nothing newer to look at, and simply wrong when there is. `pick.skipped` holds
    // scheduled runs NEWER than the judged one that gave no verdict ABOUT THE RUN, and the alert
    // already prints them in its NOTE clause. A run can fail to conclude and still hold a perfectly
    // conclusive result for a JOB inside it: BoatBuddy was paged at 08:10Z for `gate-security`
    // (step "Dependency audit (blocking at high)") on a 27.4h-old run, while in the stepped-over
    // run 33718969126 at 05:28:31Z that same job and that same step had concluded SUCCESS, on the
    // commit that patched the advisory. The evidence was in this check's hand and it never looked.
    // Only a positive job-level `success` suppresses; the rule and its fail-safe directions live in
    // scripts/lib/gauntlet-recovery.mjs, unit-tested in test/gauntlet-recovery.test.mjs.
    // COST: these reads happen only on the path that is otherwise about to PAGE and only when a
    // newer run was stepped over — rare, and bounded by the ≤9 runs pickJudgeableRun can skip.
    if (pick.skipped.length && failedNames.length) {
      const newer = [];
      for (const r of pick.skipped) {
        // A read that fails contributes `jobs: null` — unread is not empty, and an absence of
        // evidence must never be counted as evidence of recovery.
        let jobsOfRun = null;
        try {
          const sres = await request.get(
            `https://api.github.com/repos/${repo}/actions/runs/${r.id}/jobs?per_page=100`,
            { headers: ghHeaders },
          );
          if (sres.ok()) jobsOfRun = (await sres.json()).jobs ?? [];
        } catch { /* leave null — see above */ }
        newer.push({ run: r, jobs: jobsOfRun });
      }
      const rec = recoveredSince(failedNames, newer);
      test.skip(
        rec.recovered,
        `${repo}: the gate that failed in the judged scheduled gauntlet (${failedNames.join('; ')}) HAS PASSED SINCE — ${rec.reason}. That newer run gave no overall verdict, so it could not clear the run, but it did clear the gate. Not paging on a fixed gate; the next completed nightly reconfirms.`,
      );
    }

    expect(
      isFail && persistent,
      `${repo} NIGHTLY GAUNTLET PERSISTENTLY FAILING — ${whatFailed}. The auto-retry did not recover it (attempt ${attempt}, ${ageHours.toFixed(1)}h, ${latest.html_url}). Read that job before promoting ${repo} to production; whether it blocks the promotion depends on which gate it is.${skippedNote}`,
    ).toBe(false);
  });
}

test('nightly-gauntlet: DASHBOARD_PAT is present in CI', () => {
  // The per-test `test.skip(!ghToken)` above is right for a developer running locally, but in CI
  // it is a silent off-switch: if DASHBOARD_PAT is ever lost, expired or renamed, all 5 checks
  // turn into SKIPs and the hourly monitor still reports green — a job that reports success for
  // doing nothing. This test is the floor: in CI the token must exist. Local runs stay optional
  // (GitHub Actions sets CI=true on every step; a developer's shell does not).
  test.skip(!process.env.CI, 'local run — DASHBOARD_PAT is optional outside CI');

  expect(
    ghToken,
    `DASHBOARD_PAT is not set in CI — all ${TIERED_REPOS.length} nightly-gauntlet checks would silently SKIP and the monitor would still report green. Restore the secret.`,
  ).toBeTruthy();
});
