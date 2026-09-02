#!/usr/bin/env node
/**
 * Fleet pg_cron heartbeat — the dead-man's switch for every product's scheduled jobs.
 *
 * The products' own watchdogs (e.g. ReplyFlow monitor-sync-health) detect and
 * auto-fix their domain problems — but a watchdog that STOPS RUNNING is
 * indistinguishable from health from the inside. This check asks each prod
 * Supabase project, from the outside: "did every active cron job actually run
 * (and succeed) recently?" — where "recently" is derived from the job's own
 * schedule (3× its interval, with floors), so only a PERSISTENTLY dead job
 * fires, never a single missed tick (alerting philosophy 2026-07-23:
 * auto-fix first, alert only what stays broken, transient = noise).
 *
 * Healing stays product-local by design — this layer only answers
 * "is anyone watching the watchers?". Nightly; a red run IS the alert
 * (send-heartbeat-alert.mjs mails the findings), so max one email/day.
 *
 * ── LAYER 2: 'succeeded' IS NOT PROOF OF DELIVERY (added 2026-09-01) ─────────
 *
 * This file used to carry the note: "Known limitation: net.http_post-based crons
 * count as 'succeeded' once the HTTP call is dispatched, even if the edge function
 * errors — function-level failures are the product watchdogs' job, not this one."
 *
 * That limitation had swallowed a real, invisible outage. `net.http_post` only
 * ENQUEUES; the cron job is marked 'succeeded' whatever the HTTP call later
 * returns. Measured on BackOffice production 2026-08-25: **3 × HTTP 401
 * `{"error":"Unauthorized"}` against 106 × 200 in the same six-hour window, and
 * every one of the 401 jobs was reporting `succeeded`.** Four daily jobs had been
 * failing that way for weeks with nothing to see.
 *
 * It matters far more than "the product watchdogs' job", because since 2026-08-25
 * the fleet's PAGER itself runs this way: pg_cron job `signal-sweep-5min` on
 * BackOffice production POSTs {"action":"sweep"} to the signal-intake edge
 * function every five minutes, reading its bearer from `vault.decrypted_secrets`
 * at run time. That job is what delivers an alert when Roger's PC is off. If the
 * Vault secret is rotated, or the function's key changes, the sweep starts
 * answering 401 and NOTHING notices — `job_run_details` says `succeeded` forever.
 * Measured 2026-09-01: 288 consecutive `succeeded` rows in 24 hours, which is
 * exactly what a totally dead pager would also show. The weekly fire drill does
 * not cover it either: the drill calls the sweep ITSELF with its own secret, so it
 * proves the delivery channels and never proves that pg_cron can reach them.
 *
 * `net._http_response` is the ONLY table that knows. So this check now reads it.
 * Three distinct ways the cloud pager can quietly stop, and where each is caught:
 *   1. pg_cron stops firing          → layer 1, the last-success age above.
 *   2. pg_net enqueues, nothing sends → layer 2, zero responses in the window.
 *   3. the call is made and REFUSED   → layer 2, a non-2xx status code.
 *   4. the call is made and ANSWERED,
 *      but not before OUR OWN deadline → layer 2, the `deadline` verdict.
 *
 * (4) was added 2026-09-02 and is the odd one out, because nothing is broken at the far
 * end. `net.http_post` defaults `timeout_milliseconds` to 5000; a worker that takes longer
 * gets its answer thrown away, and pg_net records a statusless row saying so. For a year
 * this check folded those in with 502s and refused connections and reported them as "HTTP
 * calls ... failed". On ReplyFlow that read as 27 of 239 dead, on a database where every
 * answer received was 200, no job was stranded and nothing was in error_log — and it cost
 * two sessions a full diagnosis each before anyone read the error_msg column that had said
 * `Timeout of 5000 ms reached` all along. It still fires, because an unwaited-for dispatch
 * has an outcome nobody can see; it just no longer sends the reader after a healthy
 * function. The repair is in the cron definition, not the code it calls.
 *
 * Two disciplines carried over deliberately:
 *   * A FAILED READ IS NEVER A CLEAN RESULT. If the response table cannot be read,
 *     or the window is too short to judge, that is `unverifiable`, never OK.
 *   * ONLY WHAT STAYS BROKEN FIRES. A 5xx or a timeout is transient-capable, so it
 *     needs PERSISTENT_FAILURES of them before it counts. 401/403/404 are not
 *     transient — a refused credential and a wrong route do not heal themselves —
 *     so a single one is a finding. That is the exact shape of the 3-in-106 fault.
 *
 * The counts are labelled for what they actually count: `net._http_response` is
 * per-DATABASE, shared by every pg_net caller on it, not only the cron jobs. This
 * layer therefore says "HTTP calls this database made", never "this job's calls".
 *
 * HOW MUCH OF THE DAY THIS LAYER ACTUALLY SEES, stated rather than implied. pg_net
 * keeps responses for about six hours, and this workflow runs once a night, so layer
 * 2 inspects a SIX-HOUR SAMPLE of each twenty-four. That is deliberate and it is the
 * right trade: the faults it is built for — a rotated Vault key, a dead pg_net worker,
 * a wrong route — are PERSISTENT, so they are still failing at 05:07 the next morning
 * and are caught within a day of starting, against the "never" it was before. A fault
 * that begins and ends between two runs is invisible to it, which is the same
 * transient-is-noise rule layer 1 already applies. Running this every six hours would
 * close the sample gap, and would also mail a standing breakage four times a day
 * instead of once, which is how an alarm gets muted. If that trade is ever revisited,
 * the alerting cadence has to be separated from the reading cadence first.
 *
 * Uses the Supabase Management API query endpoint with per-product PATs
 * (same contract as check-drift.mjs). Read-only. Projects without pg_cron
 * (LaunchReady, Distribution-OS, BoatBuddy, Beize Jass, ScoutCopilot as of
 * 2026-07-23) are deliberately absent.
 */

import { writeFileSync } from 'node:fs'

const PRODUCTS = [
  { name: 'ReplyFlow',    patEnv: 'SUPABASE_TOKEN_REPLYFLOW',    ref: 'dqmhsdzldkxngwjrxois' },
  { name: 'BackOffice',   patEnv: 'SUPABASE_TOKEN_BACKOFFICE',   ref: 'xoecpzfsskalvjrtcbbl' },
  { name: 'SignalScore',  patEnv: 'SUPABASE_TOKEN_MUELLER',      ref: 'ogdpgufptemcgyszmjek' },
  { name: 'ChannelMover', patEnv: 'SUPABASE_TOKEN_CHANNELMOVER', ref: 'qswluvqunswggfmesdcs' },
  { name: 'Arivioo',      patEnv: 'SUPABASE_TOKEN_ARIVIOO',      ref: 'iooexkbuxmeryeuzpxau' },
  { name: 'Valrano',      patEnv: 'SUPABASE_TOKEN_VALRANO',      ref: 'mkdeftmubrkseyrrbzvp' },
]

// One row per active job: schedule + most recent success + most recent outcome, plus
// whether the job's command dispatches an HTTP call (which is what makes its
// 'succeeded' status meaningless on its own — see LAYER 2 in the header).
// job_run_details is bounded to 35 days so the aggregate stays cheap even on
// */2-minute jobs; 35d still covers a monthly job's largest legitimate gap.
const HEARTBEAT_SQL = `
  select j.jobname, j.schedule, j.jobid,
    -- Rescheduling a job gives it a NEW jobid and orphans its history, because
    -- cron.job_run_details is keyed by jobid and carries no jobname. Without this the
    -- check cannot tell a job that has never run from one that was re-created minutes
    -- ago, and reports both as "NEVER RUN". See jobVerdict.
    (select max(jobid) from cron.job_run_details) as max_jobid_with_history,
    (j.command ilike '%net.http_post%') as uses_http_post,
    max(d.start_time) filter (where d.status = 'succeeded') as last_success,
    max(d.start_time) as last_run,
    (select d2.status || coalesce(': ' || left(d2.return_message, 200), '')
       from cron.job_run_details d2
      where d2.jobid = j.jobid order by d2.start_time desc limit 1) as last_result
  from cron.job j
  left join cron.job_run_details d
    on d.jobid = j.jobid and d.start_time > now() - interval '35 days'
  where j.active
  group by j.jobid, j.jobname, j.schedule, j.command
  order by j.jobname`

/**
 * What the dispatched HTTP calls actually RETURNED, from pg_net's own response table.
 * One aggregate row. `bad_codes` names the distinct offending statuses so the finding
 * says 401 rather than "something was not 200".
 *
 * Note `status_code IS NULL` counts as bad: pg_net writes a row with no status when
 * the request never completed. A missing answer is not a passing answer.
 */
const HTTP_OUTCOME_SQL = `
  select count(*)::int as calls,
         count(*) filter (where status_code between 200 and 299)::int as ok,
         count(*) filter (where status_code is null or status_code < 200 or status_code >= 300)::int as bad,
         count(*) filter (where status_code in (401, 403, 404))::int as refused,
         count(*) filter (where timed_out)::int as timed_out,
         count(*) filter (where error_msg is not null)::int as errored,
         -- The CALLER's own deadline, told apart from a call that genuinely failed.
         -- pg_net writes 'Timeout of <n> ms reached. Total time: ... (DNS time: ...,
         -- TCP/SSL handshake time: ..., HTTP Request/Response time: ...)'. That row means
         -- pg_net stopped waiting — NOT that the far end refused, errored or was unreachable.
         count(*) filter (where error_msg ~ 'Timeout of [0-9]+ ms reached')::int as deadline,
         (select string_agg(distinct substring(error_msg from 'Timeout of ([0-9]+) ms'), ', ')
            from net._http_response
           where error_msg ~ 'Timeout of [0-9]+ ms reached') as deadline_ms,
         -- Where the budget actually went, so the finding says which end to fix.
         count(*) filter (where error_msg ~ 'Timeout of [0-9]+ ms reached'
           and (substring(error_msg from 'HTTP Request/Response time: ([0-9]+)'))::numeric > 1000
         )::int as deadline_slow_answer,
         min(created) as oldest, max(created) as newest,
         (select string_agg(distinct coalesce(status_code::text, 'no-response'), ', ')
            from net._http_response
           where status_code is null or status_code < 200 or status_code >= 300) as bad_codes,
         -- The statuses of the REFUSED calls only. bad_codes spans every non-2xx call in
         -- the window, and the refused headline was printing it as though it described the
         -- refused ones: run 33657359918 read "1 of 194 HTTP calls were REFUSED (status 404,
         -- 500, no-response)" — one call carrying three statuses. Two of those three were a
         -- different call each, and one of them was the finding that actually mattered.
         (select string_agg(distinct status_code::text, ', ')
            from net._http_response
           where status_code in (401, 403, 404)) as refused_codes
  from net._http_response`

/**
 * WHICH JOB was refused — the question the alert above could not answer.
 *
 * The aggregate says "2 of 184 calls were REFUSED (401)". That is a count, and a count
 * is not something anyone can act on: it names no job, no route, and no product surface.
 * Measured on the 2026-09-02 red run, both findings read that way, and the follow-up work
 * each time was a human re-deriving the culprit by hand from the job list.
 *
 * WHY THIS IS A TIME CORRELATION AND NOT A JOIN. The obvious fix is to join
 * `net.http_request_queue` on the response id, where the URL is stored verbatim. pg_net
 * deletes the queue row once the request is processed, so for exactly the rows that carry
 * a status code — the ones we need — that join yields NULL. CONFIRMED against a live
 * database on 2026-09-02, which the note here previously said could not be done: BackOffice
 * production runs pg_net 0.20.4 and `select count(*) from net.http_request_queue` returned
 * 0 while `net._http_response` held 194 rows. The queue is genuinely empty, the join is
 * genuinely unavailable, and the time correlation is the only route to a name.
 *
 * So the URL is recovered from where it is definitely still written down — `cron.job.command`
 * — and the response is tied to the run by time: a bad row at T belongs to a job that
 * started within DISPATCH_BAND_SEC before T, because `created` is when pg_net DISPATCHED
 * the call and a cron job dispatches within a moment of starting. See DISPATCH_BAND_SEC
 * for the measurement.
 *
 * THE SENTENCE THAT USED TO BE HERE WAS WRONG, AND IT IS WHY THIS PARAGRAPH IS LONG:
 * "a wider window costs ambiguity, never a wrong name, because the count of candidates is
 * reported with the names and one candidate is the only thing ever presented as certain."
 * The safety argument only holds if every bad row was dispatched by SOME cron job, so that
 * a wider window can add candidates but never invent the wrong one. It isn't: this table is
 * per-database and anything can call pg_net. When the true caller is not a cron job at all,
 * widening the window does not produce two candidates — it produces exactly one, the
 * unrelated job that happened to run nearby, and hands it over as certain. Ambiguity was
 * the failure mode being designed against, and it was the safe one.
 *
 * ONLY THE URL LEAVES THE DATABASE, NEVER THE COMMAND. Some older migrations wrote the
 * bearer token as a literal inside the cron command (the pattern migration 160 replaces
 * with a vault lookup). This alert is emailed and printed into a public run log, so the
 * command text must never be selected — `substring()` takes the URL and nothing else.
 * `test/check-cron-heartbeats.test.mjs` holds that as a ratchet.
 */
/**
 * HOW WIDE THE WINDOW IS, AND WHY IT IS NOT 90 SECONDS ANY MORE.
 *
 * The first version of this correlation used 90 seconds, reasoning that pg_net records the
 * ANSWER, so the answer could land anywhere between the dispatch and the dispatch plus the
 * request timeout. That reasoning had the column backwards, and the width it produced named
 * an innocent job as a certainty on the very next run.
 *
 * `net._http_response.created` is the DISPATCH time, not the answer time. Measured on
 * BackOffice production (xoecpzfsskalvjrtcbbl, pg_net 0.20.4, 194 rows, 2026-09-02):
 *   * the origin's own `Date` response header is LATER than `created` on 134 of the 193
 *     rows that carry one, by up to 3.7s. If `created` were the moment the answer was
 *     collected, the answer could not have been generated after it.
 *   * 168 of 194 calls sit within 0.5s of a cron job's start_time, and support-send-due's
 *     call was recorded 21ms after its run began — not a possible round trip to Cloudflare.
 * So a cron job's http_post is dispatched within a few hundred milliseconds of the job
 * starting, and 2 seconds is a 4x margin on the worst case actually observed.
 *
 * WHAT THE OLD WIDTH DID. This database dispatches HTTP from somewhere other than pg_cron:
 * the Supabase auth Send Email hook is configured as `pg-functions://postgres/public/
 * handle_send_email`, which calls an edge function through pg_net on every login mail —
 * 26 of the 194 calls in the window, at times unrelated to any schedule. With gaps of 2-3
 * minutes between cron runs, a 90s look-back covers roughly 60% of the clock, so ~60% of
 * those calls landed behind an unrelated cron job and were reported under its name with
 * `candidate_count = 1`, which this file presents as identified.
 *
 * That is exactly what happened on run 33657359918: a 500 dispatched at 13:02:21.48 was
 * reported as `signal-sweep-5min -> /functions/v1/signal-intake`, and the finding it fed
 * says "if signal-sweep-5min is among them, the fleet pager is not delivering". The pager
 * was fine. signal-sweep-5min dispatched at 13:02:00.23, 21 seconds earlier; the response
 * body was `{"error":"Failed to send email"}`, which is `send-auth-email/index.ts:88` and
 * appears nowhere else in BackOffice. A login email had failed, and the alarm sent the
 * reader to audit the emergency pager instead.
 *
 * The 90 seconds is kept for ONE thing only — reporting the nearest run and its distance,
 * so an unattributed call shows its own arithmetic instead of asking to be believed.
 */
export const DISPATCH_BAND_SEC = 2
export const NEAREST_RUN_LOOKBACK_SEC = 90

const HTTP_FAILURE_ATTRIBUTION_SQL = `
  with bad as (
    select r.id, r.created,
           coalesce(r.status_code::text, 'no-response') as status,
           -- Supabase's own classification of the failure, and the one piece of the
           -- response that is safe to print: a short fixed enum set by the gateway
           -- (NOT_FOUND, EDGE_FUNCTION_ERROR, ...), present only on failures — null on
           -- all 192 successful rows measured. The response BODY is never selected: it
           -- is whatever our own functions chose to return, this text is emailed and
           -- printed into a public run log, and 'it is only an error message' is how
           -- user data leaks. The enum says whether the route was missing or the
           -- function ran and threw, which is the part anyone acts on.
           r.headers->>'sb-error-code' as sb_error_code
      from net._http_response r
     where r.status_code is null or r.status_code < 200 or r.status_code >= 300
  ),
  posts as (
    select j.jobid, j.jobname,
           -- Two shapes, because the fleet uses both. BackOffice writes the URL as a
           -- literal. ReplyFlow builds it at run time from a setting, so there is no
           -- 'https://' in the command at all and the first pattern finds nothing —
           -- measured on run 33643053842, where all nine ReplyFlow jobs came back
           -- '(command names no url)'. The route is still there, so take that.
           coalesce(
             substring(j.command from 'https?://[^[:space:]'',)]+'),
             substring(j.command from '/functions/v1/[A-Za-z0-9_-]+')
           ) as url
      from cron.job j
     where j.active and j.command ilike '%http_post%'
  ),
  runs as (
    select d.jobid, d.start_time
      from cron.job_run_details d
     where d.start_time > now() - interval '7 hours'
  ),
  matched as (
    select b.status, b.sb_error_code,
           (select count(distinct p.jobid)
              from runs rn join posts p on p.jobid = rn.jobid
             where rn.start_time <= b.created
               and rn.start_time > b.created - interval '${DISPATCH_BAND_SEC} seconds')::int as candidate_count,
           (select string_agg(distinct p.jobname || coalesce(' -> ' || p.url, ' -> (command names no url)'), ', ')
              from runs rn join posts p on p.jobid = rn.jobid
             where rn.start_time <= b.created
               and rn.start_time > b.created - interval '${DISPATCH_BAND_SEC} seconds') as candidates,
           -- Only for the calls the band did NOT claim: which run was nearest, and how far
           -- away it actually was. This is the number that makes an orphan verdict checkable
           -- instead of assertable — "21.3s after signal-sweep-5min" is a reader's own proof
           -- that signal-sweep-5min did not make the call, and it is the fact the 90s window
           -- was throwing away in order to print that job's name as the answer.
           (select round(extract(epoch from (b.created - max(rn.start_time)))::numeric, 1)
              from runs rn join posts p on p.jobid = rn.jobid
             where rn.start_time <= b.created
               and rn.start_time > b.created - interval '${NEAREST_RUN_LOOKBACK_SEC} seconds') as nearest_gap_s,
           (select p.jobname
              from runs rn join posts p on p.jobid = rn.jobid
             where rn.start_time <= b.created
               and rn.start_time > b.created - interval '${NEAREST_RUN_LOOKBACK_SEC} seconds'
             order by rn.start_time desc limit 1) as nearest_job
      from bad b
  )
  select status, sb_error_code, candidate_count, coalesce(candidates, '') as candidates,
         nearest_job, max(nearest_gap_s) as nearest_gap_s, count(*)::int as n
    from matched
   group by 1, 2, 3, 4, 5
   order by n desc, status
   limit 20`

/**
 * WHO ELSE ON THIS DATABASE CAN DISPATCH AN HTTP CALL.
 *
 * `net._http_response` is per-DATABASE, not per-job, so "no cron job made this call" is
 * only half an answer — it says where to stop looking, not where to look. The other half
 * is already written down in the catalogue: any SQL function whose body calls http_post.
 * On BackOffice that is exactly one, `public.handle_send_email`, the Supabase auth Send
 * Email hook, and naming it turns "something else dispatched this" into a place to go.
 *
 * ONLY THE NAME AND THE ROUTE LEAVE THE DATABASE. `handle_send_email`'s body carries a
 * bearer token as a literal — read and confirmed on production 2026-09-02 — so this is the
 * same rule as the cron command: `substring()` takes the route, and the definition itself
 * is never selected. `test/check-cron-heartbeats.test.mjs` holds it as a ratchet.
 */
const NON_CRON_DISPATCHER_SQL = `
  select n.nspname || '.' || p.proname as fn,
         substring(pg_get_functiondef(p.oid) from '/functions/v1/[A-Za-z0-9_-]+') as route
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where p.prokind = 'f'
     and n.nspname not in ('pg_catalog', 'information_schema', 'net', 'cron', 'extensions',
                           'graphql', 'graphql_public', 'pgbouncer', 'vault', 'storage',
                           'realtime', 'pgsodium', 'pgsodium_masks', 'supabase_functions',
                           'supabase_migrations', 'pg_toast')
     and pg_get_functiondef(p.oid) ilike '%http_post%'
   order by 1
   limit 20`

/**
 * Turn those attribution rows into the clause the alert carries, pure and testable.
 *
 * Three outcomes, kept apart on purpose, because collapsing them is how a guess starts
 * reading as a fact:
 *   * exactly one candidate  → the job is NAMED. This is the BackOffice shape: four daily
 *     jobs hours apart, so a 401 pins to one of them without ambiguity.
 *   * several candidates     → all of them are listed, explicitly as "one of N".
 *   * no candidate           → said plainly. `net._http_response` is per-database and pg_net
 *     is callable from anything, so a bad call with no cron run behind it is a real answer:
 *     something other than pg_cron made it.
 *
 * A failed attribution read returns a clause saying so. Silence would read as "nothing to
 * add", which is the same failure mode this whole file exists to remove.
 */
export function attributionClause(rows, error, dispatchers) {
  if (error) return ` — WHICH JOB: unknown, the attribution read itself failed (${error})`
  if (!Array.isArray(rows) || rows.length === 0) return ''
  const named = [], ambiguous = [], orphan = []
  // The gateway's own word for what went wrong, when it gave one. 'no-response' rows have
  // no headers at all, so most failures still show only a status — this never invents one.
  const label = (r) => (r.sb_error_code ? `${r.status} ${r.sb_error_code}` : `${r.status}`)
  for (const r of rows) {
    const n = Number(r.n) || 0
    const count = Number(r.candidate_count) || 0
    if (count === 1) named.push(`${r.candidates} (${n} × ${label(r)})`)
    else if (count > 1) ambiguous.push(`${n} × ${label(r)} came from one of ${count} jobs running together: ${r.candidates}`)
    else {
      // Show the distance, not just the conclusion. A reader who is told "no cron job did
      // this" has to take it on trust; a reader who is told the nearest run was 21.3s away
      // when pg_cron dispatches inside 2s can check the claim in their head.
      const gap = r.nearest_gap_s == null ? null : Number(r.nearest_gap_s)
      const why = gap == null || !r.nearest_job
        ? `no cron job on this database ran in the ${NEAREST_RUN_LOOKBACK_SEC}s before them at all`
        : `the nearest cron run was ${r.nearest_job}, ${gap}s earlier — well outside the ${DISPATCH_BAND_SEC}s in which pg_cron's own http_post calls are dispatched, so it was not that job`
      orphan.push(`${n} × ${label(r)}: ${why}`)
    }
  }
  const bits = []
  if (named.length) bits.push(named.join('; '))
  if (ambiguous.length) bits.push(ambiguous.join('; '))
  if (orphan.length) {
    // Naming the other dispatchers is the difference between closing this and re-opening it
    // every hour. Without it the reader is told only where NOT to look.
    const others = Array.isArray(dispatchers) && dispatchers.length
      ? ` The other things on this database that dispatch HTTP are: ${dispatchers.map((d) => `${d.fn}${d.route ? ` -> ${d.route}` : ''}`).join(', ')}.`
      : Array.isArray(dispatchers)
        ? ' No SQL function on this database calls http_post either, so the caller is outside the database.'
        : ''
    bits.push(`${orphan.join('; ')} — so something other than pg_cron on this database dispatched those.${others}`)
  }
  // The scope is stated, because it is NOT the headline's scope. The headline counts one
  // class (refused, or transient-past-the-threshold); this lists every non-2xx call in the
  // window. Run 33643053842 read "1 of 191 were REFUSED" followed by three attributed
  // calls — correct, each labelled with its own status, and still readable as "three were
  // refused" by anyone who did not stop to check.
  return bits.length ? ` — WHICH JOB (every call in this window that was not answered 2xx): ${bits.join('. ')}` : ''
}

/**
 * pg_net keeps `net._http_response` for six hours by default (`net.ttl`), and the
 * BackOffice window measured 2026-09-01 was 5.998h, so this is the real number and
 * not a guess. It decides ONE thing: whether "no rows at all" is a fact about the
 * fleet or a fact about the window being too short to hold anything.
 */
export const RESPONSE_RETENTION_MS = 6 * 3600_000

/** How many transient-capable failures (5xx, timeouts, refused connections) it takes
 *  before this stops being a blip. Same spirit as layer 1's 3× interval rule. */
export const PERSISTENT_FAILURES = 3

/** The one cron job in the fleet whose failure is not just a job failing: it is the channel
 *  that reports everything else failing. BackOffice only — it does not exist on the other
 *  five databases, which is why the warning about it must be gated rather than printed. */
export const PAGER_JOB = 'signal-sweep-5min'

/** Whether the pager could be one of the jobs behind these calls at all.
 *  Callers on the legacy `httpPostSchedules` path supply no job names — that is genuinely
 *  unknown, and unknown must not read as "ruled out". */
export function pagerCouldBeOnThisDb(httpPostJobs, jobs) {
  if (!Array.isArray(httpPostJobs)) return true
  return jobs.some((j) => j.jobname === PAGER_JOB)
}

/**
 * Was the pager actually IMPLICATED — read off the rows, never off the rendered sentence.
 *
 * The first attempt at this tested the finished clause with /signal-sweep-5min/, which is
 * the identical mistake one layer up: the orphan wording NAMES the nearest run in order to
 * rule it out ("the nearest cron run was signal-sweep-5min, 45.2s earlier ... so it was not
 * that job"), and a substring match read that as an accusation. Presence in the text is not
 * presence in the answer. Only a row that actually offers the pager as a candidate counts.
 */
export function pagerIsNamed(attribution) {
  if (!Array.isArray(attribution)) return false
  return attribution.some((r) => Number(r.candidate_count) >= 1 && String(r.candidates || '').includes(PAGER_JOB))
}

/** The raw interval a cron schedule implies, in ms — NOT layer 1's 3x allowance.
 *  Used only to decide whether a job is fast enough that it MUST have left a trace
 *  inside the response table's short retention window. */
export function scheduleIntervalMs(schedule) {
  const parts = String(schedule).trim().split(/\s+/)
  if (parts.length !== 5) return 24 * 3600_000
  const [min, hour, dom, , dow] = parts
  const every = (f) => { const m = /^\*\/(\d+)$/.exec(f); return m ? parseInt(m[1], 10) : null }
  // '2-59/5' and '*/5' both mean every five minutes; the range form is what
  // migration 135 used for signal-sweep-5min, and a parser that only knew '*/n'
  // would have called the fleet pager a daily job and never demanded a trace.
  const step = (f) => { const m = /^(?:\*|\d+-\d+)\/(\d+)$/.exec(f); return m ? parseInt(m[1], 10) : null }
  const eMin = step(min) ?? every(min)
  if (eMin) return eMin * 60_000
  const eHour = step(hour) ?? every(hour)
  if (eHour) return eHour * 3600_000
  if (hour === '*') return 3600_000            // hourly at a fixed minute
  if (dom !== '*') return 30 * 24 * 3600_000   // monthly
  if (dow !== '*') return 7 * 24 * 3600_000    // weekly
  return 24 * 3600_000                         // daily
}

/**
 * How long ago a cron schedule last fired, in ms — an UPPER BOUND, never an underestimate.
 *
 * Layer 2 reads a table that only remembers six hours. Whether a given job's call CAN be
 * in there is therefore a question about that job's clock, not about its health, and it
 * had never been asked. For step schedules ('*\/5', '2-59/5', '0 *\/6') the interval is
 * already the worst case, so the interval IS the answer. For a job pinned to a wall-clock
 * time the answer has to be computed, because '17 7 * * *' is between 0 and 24 hours old
 * depending only on when you look.
 *
 * Returns null when the shape is not recognised — unknown, which the caller reports as
 * unknown rather than quietly folding into either bucket.
 */
export function msSinceLastFire(schedule, nowMs) {
  const parts = String(schedule).trim().split(/\s+/)
  if (parts.length !== 5) return null
  const [min, hour, dom, , dow] = parts
  const step = (f) => { const m = /^(?:\*|\d+-\d+)\/(\d+)$/.exec(f); return m ? parseInt(m[1], 10) : null }
  const fixed = (f) => (/^\d+$/.test(f) ? parseInt(f, 10) : null)

  // Step schedules repeat within their own interval, so the interval bounds the age.
  // Each field is validated before the next is trusted: 'H/5 * * * *' has an hour of
  // '*' and would otherwise be called hourly on the strength of a minute field nobody
  // could parse — a guess wearing the costume of a measurement.
  const sMin = step(min)
  if (sMin) return sMin * 60_000
  if (min === '*') return 60_000
  const mm = fixed(min)
  if (mm == null) return null

  const sHour = step(hour)
  if (sHour) return sHour * 3600_000
  if (hour === '*') return 3600_000
  const hh = fixed(hour)
  if (hh == null) return null

  const d = new Date(nowMs)
  let fire = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hh, mm, 0, 0)

  if (dom === '*' && dow === '*') {                       // daily at HH:MM UTC
    if (fire > nowMs) fire -= 24 * 3600_000
    return nowMs - fire
  }
  if (dow !== '*') {                                      // weekly on one weekday
    const want = fixed(dow)
    if (want == null) return null
    if (fire > nowMs) fire -= 24 * 3600_000
    for (let i = 0; i < 7; i++) {
      if (new Date(fire).getUTCDay() === want % 7) return nowMs - fire
      fire -= 24 * 3600_000
    }
    return null
  }
  const wantDom = fixed(dom)                              // monthly on one day-of-month
  if (wantDom == null) return null
  for (let back = 0; back < 14; back++) {
    const c = new Date(nowMs)
    c.setUTCMonth(c.getUTCMonth() - back, 1)
    const cand = Date.UTC(c.getUTCFullYear(), c.getUTCMonth(), wantDom, hh, mm, 0, 0)
    if (new Date(cand).getUTCDate() === wantDom && cand <= nowMs) return nowMs - cand
  }
  return null
}

/**
 * WHICH http_post jobs this run could actually have seen, and which it could not.
 *
 * THE HOLE THIS CLOSES (measured 2026-09-02). cron-heartbeat.yml ran once a day at 05:07
 * UTC and pg_net keeps six hours, so layer 2 only ever saw calls dispatched between about
 * 23:07 and 05:07 — 6 hours of every 24. BackOffice's four broken jobs fire at 06:23,
 * 06:31, 07:00 and 07:17, so they sat permanently in the unobservable 18 hours. The run at
 * 05:24 that morning printed "OK HTTP delivery — all 175 HTTP calls this database
 * dispatched in the last ~6h answered 2xx", which was TRUE and told nobody anything: every
 * call it counted came from jobs that were fine, and every job that was 401ing had fired
 * outside the window. A dispatch at 12:28 the same day, with a window that did contain
 * them, found all three immediately.
 *
 * So the sentence "all N answered 2xx" was never a statement about this database's
 * delivery path — only about the part of it that happened to fall inside the window. This
 * is the same three-valued discipline the Supabase coverage baseline already uses: proven
 * clean, proven broken, and NOT LOOKED AT are three different answers, and the third one
 * must say so out loud instead of borrowing the first one's wording.
 *
 * Not a finding on its own: with any single window some jobs are always outside it, so
 * reddening on that would be an alarm nobody could ever clear. It is a sentence, and the
 * schedule is what shrinks it.
 */
export function deliveryCoverage({ httpPostJobs, nowMs, retentionMs = RESPONSE_RETENTION_MS }) {
  const observed = [], unobserved = [], unknown = []
  for (const j of httpPostJobs || []) {
    const age = msSinceLastFire(j.schedule, nowMs)
    if (age == null) unknown.push(j)
    else if (age <= retentionMs) observed.push(j)
    else unobserved.push({ ...j, age })
  }
  return { observed, unobserved, unknown }
}

/** The clause appended to every layer-2 verdict so no wording can imply coverage the
 *  window did not have. Empty string when the window really did cover everything. */
function coverageClause(coverage) {
  if (!coverage) return ''
  const bits = []
  if (coverage.unobserved.length) {
    const names = coverage.unobserved
      .slice().sort((a, b) => a.age - b.age)
      .map((j) => `${j.jobname} [${j.schedule}], last fired ${fmtAge(j.age)} ago`)
    bits.push(`${coverage.unobserved.length} http_post job(s) last fired OUTSIDE this window, so their delivery is UNOBSERVED here — ${names.join('; ')}`)
  }
  if (coverage.unknown.length) {
    bits.push(`${coverage.unknown.length} job(s) have a schedule this check cannot place in time (${coverage.unknown.map((j) => `${j.jobname} [${j.schedule}]`).join('; ')})`)
  }
  return bits.length ? ` — NOTE: ${bits.join('; ')}` : ''
}

/**
 * THE WHOLE LAYER-2 DECISION, pure and testable: given what pg_net recorded and which
 * cron jobs dispatch HTTP, is the delivery path working, broken, or unjudgeable?
 *
 * `httpPostJobs` ({jobname, schedule}[]) is preferred and enables the coverage clause;
 * `httpPostSchedules` (string[]) stays accepted so older callers and tests keep working.
 *
 * `attribution`/`attributionError` carry the per-failure culprit lookup. They are optional:
 * a caller that does not supply them gets the verdict it always got, minus the naming.
 *
 * @param {{stats: object|null, queryError: string|null, httpPostJobs?: {jobname: string, schedule: string}[], httpPostSchedules?: string[], nowMs?: number, attribution?: object[]|null, attributionError?: string|null}} input
 * @returns {{verdict: 'ok'|'dead'|'unverifiable'|'not-applicable', detail: string}}
 */
export function httpDeliveryVerdict({ stats, queryError, httpPostJobs, httpPostSchedules, nowMs, attribution, attributionError, dispatchers }) {
  const jobs = httpPostJobs
    ?? (httpPostSchedules || []).map((schedule, i) => ({ jobname: `job#${i + 1}`, schedule }))
  httpPostSchedules = jobs.map((j) => j.schedule)
  const coverage = nowMs == null ? null : deliveryCoverage({ httpPostJobs: jobs, nowMs })
  const cov = coverageClause(coverage)
  // Named culprit first, then the coverage caveat: what to act on before what was not seen.
  const attr = attributionClause(attribution, attributionError, dispatchers)
  // "The attribution read failed" is a non-empty clause that names nobody. Treating it as
  // knowledge would rule the pager out on the strength of an error message.
  const namesSomething = Boolean(attr) && !attributionError
  const pagerNamed = pagerIsNamed(attribution)
  if (!httpPostSchedules.length) {
    return { verdict: 'not-applicable', detail: 'no active cron job on this database dispatches an HTTP call' }
  }
  // A read that did not happen is not a read that came back clean. This is the same
  // rule as layer 1's "Management API query failed" branch and it is the reason the
  // whole check can be trusted: nothing here has a silent path to OK.
  if (queryError) {
    return { verdict: 'unverifiable', detail: `could not read net._http_response (${queryError}) — so whether the dispatched calls are being answered is unknown, which is never "fine"` }
  }
  if (!stats || typeof stats.calls !== 'number') {
    return { verdict: 'unverifiable', detail: 'net._http_response returned no aggregate row, so nothing could be judged' }
  }

  const fastest = Math.min(...httpPostSchedules.map(scheduleIntervalMs))

  if (stats.calls === 0) {
    // Fast enough that the retention window must contain several of its calls. Zero
    // means the calls are not being made or not being recorded: pg_net's background
    // worker is not running, and every http_post cron on this database is a no-op
    // while `job_run_details` cheerfully reports 'succeeded'.
    if (fastest * 2 <= RESPONSE_RETENTION_MS) {
      return { verdict: 'dead', detail: `pg_net recorded ZERO HTTP responses in its ~${(RESPONSE_RETENTION_MS / 3600_000).toFixed(0)}h retention window, but a cron job dispatches one every ${fmtAge(fastest)}. The calls are being enqueued and never sent (or never recorded), so every http_post cron here is silently doing nothing while cron.job_run_details reports 'succeeded'.${cov}` }
    }
    return { verdict: 'unverifiable', detail: `no HTTP responses inside pg_net's ~${(RESPONSE_RETENTION_MS / 3600_000).toFixed(0)}h retention window; the fastest http_post cron runs every ${fmtAge(fastest)}, so an empty window proves nothing either way${cov}` }
  }

  const refused = stats.refused || 0
  const transient = (stats.bad || 0) - refused

  if (refused > 0) {
    // 401/403/404 do not heal themselves. One is a finding. This is the exact fault
    // that hid for weeks: 3 × 401 among 106 × 200, every job reporting 'succeeded'.
    //
    // The pager warning has THREE states now, because it used to have one. It was printed
    // on every refusal on every database — including ReplyFlow, which has no such job — and
    // on run 33657359918 it rode along with a 404 that no cron job made, next to an
    // attribution line that (wrongly) named signal-sweep-5min. Two independent-looking
    // statements, one shared mistake, and the reader's whole hour went to the pager.
    //
    // The hedge ("if it is among them") is kept for the case it was written for: we have no
    // attribution, so we genuinely do not know. What is removed is saying it when we DO
    // know, and know it is not the pager. An alarm that hedges when it is ignorant and
    // commits when it is informed is readable; one that hedges always is noise.
    const pagerRuledOut = !pagerCouldBeOnThisDb(httpPostJobs, jobs) || (namesSomething && !pagerNamed)
    const pager = pagerNamed
      ? ` ${PAGER_JOB} IS among them, so the fleet pager is not delivering.`
      : pagerRuledOut
        ? ''
        : ` If ${PAGER_JOB} is among them, the fleet pager is not delivering.`
    return { verdict: 'dead', detail: `${refused} of ${stats.calls} HTTP calls this database dispatched were REFUSED (status ${stats.refused_codes ?? stats.bad_codes ?? 'unknown'}). A refused credential or a wrong route does not recover on its own, and cron.job_run_details still reports these as 'succeeded'.${pager}${attr}${cov}` }
  }
  // ── THE CALLER HUNG UP IS NOT THE CALL FAILED ────────────────────────────────
  // `net.http_post` takes `timeout_milliseconds` and DEFAULTS IT TO 5000. When a worker
  // takes longer than that, pg_net records a row with no status code and the message
  // 'Timeout of 5000 ms reached' — which this check used to fold in with 502s and refused
  // connections and report as "HTTP calls ... failed". They are not the same fact. A 5xx
  // is the far end answering badly; this is OUR end walking away mid-sentence, and the
  // function usually finished the work fine a moment later.
  //
  // Measured on ReplyFlow production 2026-09-02: 27 of its 239 calls read as failures, and
  // ALL 27 were this. Every call that WAS answered returned 200, `api_job_queue` held zero
  // rows stuck in processing (90 of 90 jobs created in the window completed on attempt 1),
  // and error_log had no process-queue entry in 24h. Nothing was broken except the wait.
  // The wording cost two sessions a full diagnosis each, the second of which named
  // process-queue-every-2min as "the culprit" — it was the victim of a 5-second deadline.
  //
  // It still FIRES, and deliberately so: a dispatch nobody waits for is a dispatch whose
  // outcome this monitor cannot see, and the repair (raise `timeout_milliseconds` in the
  // cron definition) is real work that will not happen if the run goes green. What changes
  // is that the finding now names the caller, the budget and the end to fix — instead of
  // sending the reader to hunt a healthy function.
  const deadline = stats.deadline || 0
  if (deadline > 0 && deadline >= transient && transient >= PERSISTENT_FAILURES) {
    const budget = stats.deadline_ms ?? 'unknown'
    const slow = stats.deadline_slow_answer || 0
    const where = slow >= deadline
      ? 'in every case the connection was made and the far end simply had not answered yet'
      : slow > 0
        ? `${slow} of them had the connection open and were still waiting on the answer; the other ${deadline - slow} never got past name resolution`
        : 'none of them got past name resolution, so this is DNS, not a slow worker'
    return { verdict: 'deadline', detail: `${deadline} of ${stats.calls} HTTP calls this database dispatched got no answer within THE CALLER'S OWN ${budget} ms timeout — ${where}. This is not a refused call and not a failing function: net.http_post defaults timeout_milliseconds to 5000, and past that pg_net stops listening and throws the answer away, so cron.job_run_details AND this check both lose the outcome. Fix it in the cron job definition (pass timeout_milliseconds), not in the edge function.${attr}${cov}` }
  }
  if (transient >= PERSISTENT_FAILURES) {
    // Count the ROWS, not the columns. `timed_out` and `error_msg is not null` overlap
    // almost completely — a timeout sets both — so printing "27 timed out, 27 errored"
    // for 27 rows read as 54 problems on the 2026-09-02 run. Say what is left after the
    // deadline rows are named above, and say it once.
    const other = transient - deadline
    const breakdown = deadline > 0
      ? `${deadline} were the caller's own ${stats.deadline_ms ?? '?'} ms timeout, ${other} were something else`
      : `status ${stats.bad_codes ?? 'unknown'}`
    return { verdict: 'dead', detail: `${transient} of ${stats.calls} HTTP calls this database dispatched failed (${breakdown}). Past ${PERSISTENT_FAILURES} in one window this is no longer a blip.${attr}${cov}` }
  }
  if (transient > 0) {
    return { verdict: 'ok', detail: `${stats.ok} of ${stats.calls} dispatched HTTP calls answered 2xx; ${transient} transient failure(s) (${stats.bad_codes}), under the ${PERSISTENT_FAILURES} needed to count${cov}` }
  }
  return { verdict: 'ok', detail: `all ${stats.calls} HTTP calls this database dispatched in the last ~${(RESPONSE_RETENTION_MS / 3600_000).toFixed(0)}h answered 2xx${cov}` }
}

/** Max tolerated age of the last SUCCESSFUL run, derived from the cron schedule.
 *  3× the interval (with floors) = several consecutive misses, never one blip. */
export function allowanceMs(schedule) {
  const parts = String(schedule).trim().split(/\s+/)
  if (parts.length !== 5) return 26 * 3600_000 // unrecognized → treat as daily
  const [min, hour, dom, , dow] = parts
  const every = (f) => { const m = /^\*\/(\d+)$/.exec(f); return m ? parseInt(m[1], 10) : null }
  const eMin = every(min)
  if (eMin) return Math.max(3 * eMin, 90) * 60_000          // */n min → ≥90 min
  const eHour = every(hour)
  if (eHour) return Math.max(3 * eHour, 12) * 3600_000      // every k hours
  if (hour === '*') return 3 * 3600_000                     // hourly at fixed minute
  if (dom !== '*') return 33 * 24 * 3600_000                // monthly
  if (dow !== '*') return 8 * 24 * 3600_000                 // weekly
  return 26 * 3600_000                                      // daily
}

function fmtAge(ms) {
  if (ms == null) return 'never'
  const h = ms / 3600_000
  if (h < 1) return `${Math.round(ms / 60_000)}min`
  return h < 48 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)}d`
}

/**
 * LAYER 1, made explicit and testable: is this job's last SUCCESS recent enough for its
 * own schedule — and, when it is not, WHY.
 *
 * WHY THIS IS A FUNCTION AND NOT THREE LINES INSIDE THE LOOP (2026-09-01). The console
 * line stopped at `DEAD affiliate-monitor-daily [0 7 * * *] last success 37.4h ago >
 * allowed 26.0h`. The two fields that answer the only question that follows — did pg_cron
 * ATTEMPT it, and what did the attempt say — were already being read by HEARTBEAT_SQL,
 * folded into the finding, and then left the machine by email and nowhere else. The
 * runbook's first diagnostic step is "download the failed run's logs", so the evidence was
 * missing from the first place anyone looks. Measured that night on run 33555239704: three
 * findings, and the log could not tell any of them apart.
 *
 * `last_run` is the field that separates the two very different failures that both arrive
 * as "no recent success":
 *   * a run happened and did not succeed  → pg_cron is fine, the JOB is broken, and
 *     `last_result` carries the database's own error message.
 *   * no run was ever recorded            → pg_cron never attempted it. On a database
 *     whose other jobs are ticking, that means the job is younger than its first tick,
 *     not that it has been dead for weeks — a distinction the old line erased, and the
 *     reason BackOffice's freshly scheduled `product-check-run-prune-daily` read exactly
 *     like a job that had been failing since July.
 *
 * Pure: no clock, no network. `nowMs` is passed in so a test can place the facts in time.
 *
 * @param {{jobname: string, schedule: string, last_success: string|null, last_run: string|null, last_result: string|null}} row
 * @param {number} nowMs
 * @returns {{verdict: 'ok'|'dead', neverRan: boolean, detail: string}}
 */
export function jobVerdict(row, nowMs) {
  const allow = allowanceMs(row.schedule)
  const lastSuccess = row.last_success ? new Date(row.last_success).getTime() : null
  const age = lastSuccess == null ? null : nowMs - lastSuccess

  if (age != null && age <= allow) {
    return { verdict: 'ok', neverRan: false, detail: `last success ${fmtAge(age)} ago` }
  }

  // Never attempted. Say that, rather than "last success never ago", which reads as a
  // job that has been failing forever and is the same sentence for a job added an hour ago.
  if (!row.last_run) {
    // ── RE-CREATED IS NOT NEVER RUN ─────────────────────────────────────────────
    // pg_cron keys cron.job_run_details by jobid and stores no jobname, so `cron.unschedule`
    // + `cron.schedule` — the normal way a migration edits a job — hands the job a fresh
    // jobid and strands every row of its history under the old one. From this table the
    // result is indistinguishable from a job that has never fired.
    //
    // Seen on BackOffice production 2026-09-02: deploy 33644046336 applied migration 160 at
    // 14:44 UTC, re-scheduling four daily jobs to read their token from the vault. The 14:39
    // run had just called all four healthy ("last success 8.3h ago"); the 16:47 run called
    // the same four "NEVER RUN". Nothing had changed except their jobids — and the very same
    // run still said "last fired 9.4h ago" about them three lines further down, because that
    // number is derived from the schedule rather than read from the table. A check that
    // contradicts itself inside one run is worse than one that says nothing.
    //
    // jobids come from a sequence, so a job numbered ABOVE every jobid that has any recorded
    // run was created after the most recent thing this database ran: it has not reached its
    // first tick yet. That is genuinely unproven, not dead, and this deliberately does not
    // fire — the four above would otherwise page tomorrow at 05:07 for jobs that go on to
    // run normally at 06:23.
    //
    // It cannot hide a permanently dead job for long, which is the whole reason it is safe:
    // the moment ANY newer job records a run, this one stops being the highest and goes
    // straight back to DEAD. And if pg_cron itself has stopped, nothing new gets recorded,
    // every other job on the database ages out, and layer 1 fires on all of them.
    const jobid = Number(row.jobid)
    const highestThatHasRun = Number(row.max_jobid_with_history)
    if (Number.isFinite(jobid) && Number.isFinite(highestThatHasRun) && jobid > highestThatHasRun) {
      return {
        verdict: 'unproven',
        neverRan: true,
        detail: `NOT YET PROVEN — no run recorded, but this job (id ${jobid}) is newer than every job that has run on this database (highest with history: ${highestThatHasRun}), so it was created or re-scheduled since the last recorded run and has not reached its first tick. Re-scheduling a job gives it a new id and strands its old history, so this is what a migration that just edited it looks like. It will be judged normally from its next run; if it is still saying this tomorrow, it really is not firing.`,
      }
    }
    return {
      verdict: 'dead',
      neverRan: true,
      detail: `NEVER RUN — cron.job_run_details holds no attempt at all for this job (allowed ${fmtAge(allow)} between successes). Either it was scheduled after its most recent tick was due — check whether the previous heartbeat run knew this job at all — or pg_cron is not firing it.`,
    }
  }

  return {
    verdict: 'dead',
    neverRan: false,
    detail: `last success ${fmtAge(age)} ago (allowed ${fmtAge(allow)}); last run ${row.last_run}; last result: ${row.last_result ?? 'none in 35d'}`,
  }
}

/** Management API query with retries — api.supabase.com intermittently 502s
 *  (observed 2026-07-23); a transient gateway blip must not page anyone. */
async function query(ref, pat, sql) {
  let lastErr
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: sql }),
        signal: AbortSignal.timeout(30_000),
      })
      const text = await res.text()
      if (res.ok && !text.startsWith('<')) return JSON.parse(text)
      lastErr = new Error(`HTTP ${res.status}: ${text.slice(0, 150)}`)
    } catch (e) {
      lastErr = e
    }
    if (attempt < 4) await new Promise((r) => setTimeout(r, attempt * 5000))
  }
  throw lastErr
}

async function main() {
  const findings = []
  const now = Date.now()

  for (const { name, patEnv, ref } of PRODUCTS) {
    console.log(`\n== ${name} (${ref})`)
    const pat = process.env[patEnv]
    if (!pat) {
      findings.push({ product: name, job: '(all)', schedule: '', problem: 'unverifiable', detail: `env ${patEnv} not set — heartbeats cannot be checked` })
      console.error(`  UNVERIFIABLE env ${patEnv} not set`)
      continue
    }
    let rows
    try {
      rows = await query(ref, pat, HEARTBEAT_SQL)
    } catch (e) {
      findings.push({ product: name, job: '(all)', schedule: '', problem: 'unverifiable', detail: `Management API query failed after retries: ${e.message}` })
      console.error(`  UNVERIFIABLE ${e.message}`)
      continue
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      // A cron-bearing product losing ALL its jobs would be a real incident, but a
      // legitimately emptied project shouldn't page forever — flag it as dead.
      findings.push({ product: name, job: '(all)', schedule: '', problem: 'dead', detail: 'no active cron jobs found — expected at least one (remove the product from check-cron-heartbeats.mjs if intentional)' })
      console.error('  DEAD no active cron jobs found')
      continue
    }
    for (const r of rows) {
      const v = jobVerdict(r, now)
      if (v.verdict === 'ok') {
        console.log(`  OK   ${r.jobname} [${r.schedule}] ${v.detail}${r.uses_http_post ? ' (dispatches HTTP — see delivery line below)' : ''}`)
      } else if (v.verdict === 'unproven') {
        // Printed loudly, deliberately not a finding: there is nothing here anyone could
        // act on tonight, and paging on it trains people to skim the ones that matter.
        console.log(`  NEW? ${r.jobname} [${r.schedule}] ${v.detail}`)
      } else {
        findings.push({ product: name, job: r.jobname, schedule: r.schedule, problem: 'dead', detail: v.detail })
        // The SAME detail that goes in the email goes in the log. An alert whose evidence
        // only exists in someone's inbox is an alert nobody can act on from the run page.
        console.error(`  DEAD ${r.jobname} [${r.schedule}] ${v.detail}`)
      }
    }

    // ── LAYER 2 ─────────────────────────────────────────────────────────────
    // Every 'succeeded' printed above is, for an http_post job, a statement about
    // the ENQUEUE and nothing else. Ask pg_net what the calls actually returned.
    const httpPostJobs = rows.filter((r) => r.uses_http_post).map((r) => ({ jobname: r.jobname, schedule: r.schedule }))
    const httpPostSchedules = httpPostJobs.map((j) => j.schedule)
    let stats = null, queryError = null, attribution = null, attributionError = null, dispatchers = null
    if (httpPostSchedules.length) {
      try {
        const out = await query(ref, pat, HTTP_OUTCOME_SQL)
        stats = Array.isArray(out) ? out[0] : null
      } catch (e) {
        queryError = e.message
      }
      // A second round-trip only when the first one found something to attribute. A green
      // database pays nothing for this, which is what keeps the nightly run cheap.
      if (stats && Number(stats.bad) > 0) {
        try {
          const out = await query(ref, pat, HTTP_FAILURE_ATTRIBUTION_SQL)
          attribution = Array.isArray(out) ? out : null
        } catch (e) {
          attributionError = e.message
        }
        // Same rule, same reason: only paid for on a database that has a failure to explain.
        // A failure here leaves `dispatchers` null and the clause simply says less, rather
        // than claiming there is no other caller — which would be the wrong half to guess.
        try {
          const out = await query(ref, pat, NON_CRON_DISPATCHER_SQL)
          dispatchers = Array.isArray(out) ? out : null
        } catch { /* stays null: unknown, not "none" */ }
      }
    }
    const delivery = httpDeliveryVerdict({ stats, queryError, httpPostJobs, nowMs: now, attribution, attributionError, dispatchers })
    if (delivery.verdict === 'not-applicable') {
      // Say nothing: a database with no http_post cron has no delivery path to judge.
    } else if (delivery.verdict === 'ok') {
      console.log(`  OK   HTTP delivery — ${delivery.detail}`)
    } else {
      findings.push({
        product: name,
        job: `(${httpPostSchedules.length} http_post cron job(s))`,
        schedule: '',
        problem: delivery.verdict,
        detail: delivery.detail,
      })
      console.error(`  ${delivery.verdict.toUpperCase()} HTTP delivery — ${delivery.detail}`)
    }
  }

  writeFileSync('heartbeat-findings.json', JSON.stringify(findings, null, 2))

  if (findings.length > 0) {
    console.error(`\n${findings.length} heartbeat finding(s) — failing the run (the red run is the alert).`)
    return 1
  }
  console.log('\nAll fleet cron heartbeats healthy, and every dispatched HTTP call was answered.')
  return 0
}

if (import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1] || '').href) {
  main().then(
    (code) => { process.exitCode = code },
    (e) => {
      console.error(`::error::the cron heartbeat check could NOT run (${e.message}). Unknown is not healthy.`)
      process.exitCode = 1
    },
  )
}
