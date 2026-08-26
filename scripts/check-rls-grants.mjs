#!/usr/bin/env node
/**
 * RLS / grant-drift guard — catches the billing-bypass class found in SignalScore + ChannelMover.
 *
 * The vulnerability: a tenant SaaS grants `anon`/`authenticated` WRITE access to columns that
 * encode entitlement (tier, credits, subscription_status, quota counters, is_admin, role, …).
 * Supabase grants ALL on public tables to authenticated BY DEFAULT and relies on RLS to gate
 * rows — but a permissive UPDATE policy plus that default grant lets a signed-in user PATCH their
 * own `organizations`/`profiles` row and hand themselves an unlimited plan. The correct fix is a
 * COLUMN-LEVEL revoke: `REVOKE UPDATE (tier, credits, …) ON <table> FROM authenticated;` (grant
 * UPDATE only on the safe columns). This guard verifies that revoke is still in place. It also
 * catches the same class expressed as an anon/auth-EXECUTABLE SECURITY DEFINER RPC that mutates
 * billing (CM's 7 billing RPCs, RF `increment_user_quota`, SS `increment_checks_used`) — a SECDEF
 * function runs as owner and bypasses RLS entirely, so any user-supplied id param is spoofable.
 *
 * Three read-only catalog checks per ENFORCED prod project (Management-API query endpoint):
 *   1. CRITICAL — self-grant billing bypass: anon/authenticated holds UPDATE on a billing-named
 *      public column (information_schema.column_privileges; table-level grants are reflected here
 *      per-column, so the check sees the default grant AND disappears once the column-level revoke
 *      lands — exactly the SS `organizations` / CM `profiles` hole).
 *   2. CRITICAL — anon/auth-executable privileged SECDEF: a public SECURITY DEFINER pg_proc whose
 *      proacl grants EXECUTE to anon/authenticated (or is NULL = default PUBLIC), that TAKES an
 *      argument (a spoofable id), excluding trigger functions and the allowlist.
 *   3. WARN — over-broad posture: anon holds table-wide DELETE/TRUNCATE on a public table (not
 *      client-reachable via PostgREST, but wrong posture worth flagging).
 *
 * SCOPE: enforcement targets the real multi-tenant SaaS (SignalScore, ReplyFlow, ChannelMover,
 * BackOffice, Arivioo, DistributionOS, Valrano, ScoutCopilot, LaunchReady, Beize Jass Tour).
 * EXEMPT (reported, never fails): staging/test refs (prod is source of truth) and BoatBuddy
 * (anon-open by design — no tenants, a client-side password gate, no billing columns).
 *
 * ALLOWLIST: a genuinely-intended grant is whitelisted per project via `allow.columns`
 * ['table.column'] / `allow.functions` ['name'] on the ACCOUNTS entry (with a reason), without
 * disabling the whole check. A global function allowlist covers the fleet-wide Protected Auth
 * Patterns (handle_send_email, the send-auth-email hook path, handle_new_user).
 *
 * Tokens: SUPABASE_TOKEN_<ACCT> per account. Missing token for an ENFORCED project = a GAP and
 * fails the guard (like check-auth-email-config.mjs). Optional alert via ALERT_SMTP_*. Exit 1 when
 * any ENFORCED project FAILs or is a gap; exit 0 otherwise. Read-only — only SELECTs on catalogs.
 *
 * Run locally:  SUPABASE_TOKEN_MUELLER=... node scripts/check-rls-grants.mjs
 */

// Column names that encode billing / entitlement / privilege. anon or authenticated holding
// UPDATE on any of these (case-insensitive exact match) is a CRITICAL self-grant bypass.
const BILLING_COLUMNS = [
  'tier', 'credits', 'subscription_tier', 'subscription_status',
  'monthly_check_limit', 'checks_used_this_month', 'plan',
  'item_quota', 'items_used', 'clean_enabled', 'balance', 'is_admin',
  'role', 'stripe_customer_id', 'stripe_subscription_id',
]

// Fleet-wide SECDEF functions that are INTENTIONALLY anon/authenticated-executable.
// Names are matched case-insensitively; substrings cover the send-auth-email hook path.
const GLOBAL_FN_ALLOW = new Set([
  'handle_send_email',   // Protected Auth Pattern: GoTrue send-email hook — MUST be anon-invocable so GoTrue can call it to send signup/OTP/reset mail. It only sends mail; takes no spoofable id.
  'handle_new_user',     // AFTER INSERT trigger on auth.users (returns trigger; also auto-skipped). Provisions the tenant row from the just-created auth user — no user-supplied id.
])
// Substring allow — the send-auth-email edge/hook path family (Protected Auth Patterns).
const GLOBAL_FN_ALLOW_SUBSTR = ['send_email', 'send_auth_email']

const STAGING = 'staging/test environment — prod is the source of truth for grants; not enforced'
const BOATBUDDY = 'anon-open by design — no tenants, client-side password gate (PasswordGate.tsx, SHA-256), no billing/entitlement columns; billing-bypass class does not apply'
// Not yet through the v11 audit → grant drift is un-triaged, so we do NOT enforce (would red-light CI
// on real-but-unreviewed drift = alert noise). Reported in a PENDING section; when a project is
// v11-audited + its grants triaged, remove `pending` (and add any allow{}) to enroll it as enforced.
const PENDING = 'not yet through the v11 audit — grant drift un-triaged; enroll (remove pending, add allow{}) after auditing'

// Reuses the ACCOUNTS shape from check-auth-email-config.mjs: { ref, name, exempt?, allow? }.
// `allow` = per-project whitelist: { columns: ['table.column', …], functions: ['name', …] } with a reason.
const ACCOUNTS = {
  MUELLER: [
    { ref: 'ogdpgufptemcgyszmjek', name: 'SignalScore', allow: {
      // All three are SECDEF invitation/membership helpers the SS app invokes as `authenticated`.
      functions: [
        'accept_invitation',          // gates on auth.uid() (returns "Not authenticated" if null); arg is a SECRET invite token (not a spoofable user id) and it only adds the CALLER to the org. App-invoked on invite accept.
        'get_org_members_with_email', // read-only; returns nothing unless caller is a member of p_org_id (auth.uid() membership check). App-invoked member list.
        'get_user_org_ids',           // SECDEF RLS-helper referenced by the members_read + invitation SELECT policies as get_user_org_ids(auth.uid()); `authenticated` MUST keep EXECUTE or those policies fail. anon+PUBLIC already revoked; returns only opaque org uuids, no mutation.
      ],
    } },
    { ref: 'blfnyxwcriyxvsaubiqb', name: 'SignalScore Staging', exempt: STAGING },
  ],
  REPLYFLOW: [
    { ref: 'dqmhsdzldkxngwjrxois', name: 'ReplyFlow' },
    { ref: 'cuvqzwvyovxvvvuddtjd', name: 'ReplyFlow Staging', exempt: STAGING },
  ],
  ARIVIOO: [{ ref: 'iooexkbuxmeryeuzpxau', name: 'Arivioo', pending: PENDING }],
  CHANNELMOVER: [{ ref: 'qswluvqunswggfmesdcs', name: 'ChannelMover', allow: {
    columns: [
      'youtube_accounts.role', // NOT a permission role — a source/destination account-TYPE discriminator (values only 'source'|'destination'); set server-side by the connect-youtube-account edge fn (upsert onConflict user_id,role). No billing/entitlement meaning; generic 'role' name false-positive.
    ],
  } }],
  API: [{ ref: 'dkxdlovwzsxnepoteebk', name: 'Beize Jass Tour', pending: PENDING }],
  LAUNCHREADY: [{ ref: 'hcfeoescybfngjsphekq', name: 'LaunchReady', pending: PENDING }],
  DISTRIBUTIONOS: [
    { ref: 'jxjpbmkgmuunpayqgbsx', name: 'DistributionOS', pending: PENDING },
    { ref: 'mkdeftmubrkseyrrbzvp', name: 'Valrano', pending: PENDING },
    { ref: 'vfwpcgdkrwqhdivfzmrg', name: 'Valrano Staging', exempt: STAGING },
  ],
  SCOUTCOPILOT: [{ ref: 'rlcsuqwqzoqjykdiqjye', name: 'ScoutCopilot', pending: PENDING }],
  BACKOFFICE: [
    { ref: 'xoecpzfsskalvjrtcbbl', name: 'BackOffice', allow: {
      // BackOffice is SINGLE-USER (Roger only, OTP login, RLS user_id-scoped own books): `authenticated`
      // IS the sole owner editing his own ledger, so the multi-tenant self-grant/escalation class does not apply.
      columns: [
        'accounts.balance',                // own chart-of-accounts ledger; ALL policy auth.uid()=user_id (anon denied). Single owner's own books.
        'bank_statement_balances.balance', // own imported bank-statement balances; UPDATE policy auth.uid()=user_id. Single owner's own books.
        'contacts.stripe_customer_id',     // owner's own contacts (his customers/vendors); ALL policy auth.uid()=user_id. Not tenant billing.
        'organization_members.role',       // UPDATE policy is org-OWNER-gated (organizations.owner_id=auth.uid()); non-owner cannot escalate, and single-user = only Roger.
        'product_ideas.tier',              // product-idea SCORE band (Fable5 board), not a user entitlement; internal single-user data.
      ],
      functions: [
        'perform_year_end_closing', // client-called as authenticated (useYearEndClosing supabase.rpc, p_user_id=user.id); single owner's own books. anon+PUBLIC revoked separately.
        'reconcile_match',          // client-called as authenticated (useReconciliation supabase.rpc); anon+PUBLIC already revoked; verifies tx ownership internally. Single owner.
        'support_accuracy',         // read-only analytics, client-called as authenticated (useSupport supabase.rpc); single-user dashboard. anon+PUBLIC revoked separately.
        // Fleet-signals + push RPCs (BackOffice DB, but the UI on top of them is the Cockpit).
        // All three are called from the browser as authenticated, so service_role-only would
        // break the Cockpit; single-user still holds - `authenticated` is Roger.
        'set_signal_state',         // client-called as authenticated (Cockpit useFleetSignals supabase.rpc); acks/snoozes a fleet signal. anon+PUBLIC revoked in 130.
        'set_page_policy',          // client-called as authenticated (Cockpit useFleetSignals supabase.rpc); per-source paging prefs. anon+PUBLIC revoked in 130.
        'register_push_device',     // client-called as authenticated (Cockpit lib/push.ts supabase.rpc); upserts THIS browser's push endpoint. anon+PUBLIC revoked in 132.
      ],
    } },
    { ref: 'vvgqkwiqauafcflshsec', name: 'BackOffice Staging', exempt: STAGING },
  ],
  BOATBUDDY: [
    { ref: 'xzythvxmuxmczuiophwp', name: 'BoatBuddy', exempt: BOATBUDDY },
    { ref: 'svpewgbwousyheohlrtt', name: 'BoatBuddy Staging', exempt: STAGING },
  ],
}

const sqlList = (arr) => arr.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ')

// CHECK 1 — anon/authenticated holds UPDATE on a billing-named public column.
// Uses has_column_privilege() rather than information_schema.column_privileges: the latter applies
// an enabled-role visibility filter (can hide anon/authenticated grants depending on the querying
// role's memberships), whereas has_column_privilege() reads the EFFECTIVE grant — true whether the
// UPDATE came from a column-level grant OR the Supabase default table-level GRANT ALL, which is
// exactly the reflected-per-column semantics the fix (column-level REVOKE) toggles off.
const BILLING_GRANT_SQL = `
  SELECT r.rolname AS grantee, c.relname AS table_name, a.attname AS column_name
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
  CROSS JOIN (VALUES ('anon'), ('authenticated')) AS r(rolname)
  WHERE c.relkind IN ('r', 'p', 'v')
    AND lower(a.attname) IN (${sqlList(BILLING_COLUMNS)})
    AND has_column_privilege(r.rolname, c.oid, a.attnum, 'UPDATE')
  ORDER BY c.relname, a.attname, r.rolname`

// CHECK 2 — public SECURITY DEFINER function EXECUTE-able by anon/authenticated (or PUBLIC via
// NULL/explicit grant), excluding trigger functions. `pronargs` is returned so JS can treat a
// zero-arg helper (no spoofable id — cron/refresh helper) as WARN and an arg-taking one as FAIL.
// grantee 0 in aclexplode = PUBLIC.
const SECDEF_SQL = `
  SELECT p.proname AS function,
         pg_get_function_identity_arguments(p.oid) AS args,
         p.pronargs AS nargs,
         COALESCE(p.proacl::text, 'NULL (default → PUBLIC EXECUTE)') AS acl
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.prosecdef = true
    AND n.nspname = 'public'
    AND pg_get_function_result(p.oid) <> 'trigger'
    AND (
      p.proacl IS NULL
      OR EXISTS (
        SELECT 1 FROM aclexplode(p.proacl) a
        LEFT JOIN pg_roles r ON r.oid = a.grantee
        WHERE a.privilege_type = 'EXECUTE'
          AND (a.grantee = 0 OR r.rolname IN ('anon', 'authenticated'))
      )
    )
  ORDER BY p.proname`

// CHECK 3 — anon holds table-wide DELETE or TRUNCATE on a public table (effective-privilege read).
const BROAD_GRANT_SQL = `
  SELECT 'anon' AS grantee, c.relname AS table_name, p.priv AS privilege_type
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  CROSS JOIN (VALUES ('DELETE'), ('TRUNCATE')) AS p(priv)
  WHERE c.relkind IN ('r', 'p')
    AND has_table_privilege('anon', c.oid, p.priv)
  ORDER BY c.relname, p.priv`

async function query(ref, token, sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  })
  if (!res.ok) throw new Error(`query(${ref}) HTTP ${res.status}: ${(await res.text()).slice(0, 150)}`)
  return res.json()
}

function fnAllowed(name, projectAllow) {
  const n = name.toLowerCase()
  if (GLOBAL_FN_ALLOW.has(n)) return true
  if (GLOBAL_FN_ALLOW_SUBSTR.some((s) => n.includes(s))) return true
  return (projectAllow?.functions ?? []).map((s) => s.toLowerCase()).includes(n)
}

function colAllowed(table, column, projectAllow) {
  const key = `${table}.${column}`.toLowerCase()
  return (projectAllow?.columns ?? []).map((s) => s.toLowerCase()).includes(key)
}

async function auditProject(p, token) {
  const fails = []   // CRITICAL — fails the guard
  const warns = []   // WARN — reported only

  // CHECK 1 — self-grant billing bypass. Group by table.column so both grantees collapse into a
  // single REVOKE. NOTE: Supabase's default `GRANT ALL ON ALL TABLES TO anon, authenticated`
  // makes has_column_privilege() true for these columns until a column-level REVOKE is applied —
  // so a hit here means the hardening (the SS/CM fix) is NOT in place on this project.
  const billing = await query(p.ref, token, BILLING_GRANT_SQL)
  const billingByCol = new Map() // 'table.column' -> { table, column, grantees:Set }
  for (const r of billing) {
    if (colAllowed(r.table_name, r.column_name, p.allow)) continue
    const key = `${r.table_name}.${r.column_name}`
    if (!billingByCol.has(key)) billingByCol.set(key, { table: r.table_name, column: r.column_name, grantees: new Set() })
    billingByCol.get(key).grantees.add(r.grantee)
  }
  for (const { table, column, grantees } of billingByCol.values()) {
    const gl = [...grantees].join(', ')
    fails.push({
      check: 'billing-column UPDATE grant',
      detail: `${gl} can UPDATE ${table}.${column} (entitlement column — self-grant bypass)`,
      fix: `REVOKE UPDATE (${column}) ON public.${table} FROM ${gl};  -- or add "${table}.${column}" to this project's allow.columns with a reason`,
    })
  }

  // CHECK 2 — anon/auth-executable privileged SECDEF
  const secdef = await query(p.ref, token, SECDEF_SQL)
  for (const r of secdef) {
    if (fnAllowed(r.function, p.allow)) continue
    const sig = `${r.function}(${r.args || ''})`
    if (Number(r.nargs) > 0) {
      fails.push({
        check: 'anon/auth-executable SECURITY DEFINER RPC',
        detail: `${sig} is SECDEF and EXECUTE-able by anon/authenticated/PUBLIC [acl ${r.acl}] — takes ${r.nargs} arg(s) (spoofable id → bypasses RLS)`,
        fix: `REVOKE EXECUTE ON FUNCTION public.${sig} FROM anon, authenticated, PUBLIC;  -- then grant to service_role only, or add to this project's allow.functions with a reason`,
      })
    } else {
      warns.push({
        check: 'zero-arg SECURITY DEFINER helper',
        detail: `${sig} is SECDEF and EXECUTE-able by anon/authenticated/PUBLIC [acl ${r.acl}] — no args (likely a cron/refresh helper). Confirm it is safe, then allowlist it.`,
      })
    }
  }

  // CHECK 3 — over-broad anon DELETE/TRUNCATE. Supabase's default GRANT ALL usually makes this
  // true for every table, so aggregate into ONE summary WARN per project (log-only, never alerts)
  // rather than one line per table — surfaces the posture without flooding the report.
  const broad = await query(p.ref, token, BROAD_GRANT_SQL)
  if (broad.length) {
    const tables = [...new Set(broad.map((r) => r.table_name))]
    const sample = tables.slice(0, 8).join(', ')
    warns.push({
      check: 'over-broad anon grant',
      detail: `anon holds table-wide DELETE/TRUNCATE on ${tables.length} public table(s) (likely Supabase default GRANT ALL; RLS-gated, not PostgREST-reachable, but wrong posture): ${sample}${tables.length > 8 ? ', …' : ''}`,
      fixHint: `REVOKE DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public FROM anon;`,
    })
  }

  return { fails, warns }
}

async function main() {
  const violations = []     // { project, findings:[...] } — enforced FAILs (drives exit 1 + alert)
  const missingTokens = []
  const exempt = []
  const pending = []        // reported, never fails — awaiting v11 audit enrollment
  const okProjects = []
  const warnOnly = []       // projects with only WARNs
  const errored = []

  for (const [acct, projects] of Object.entries(ACCOUNTS)) {
    const token = process.env[`SUPABASE_TOKEN_${acct}`]
    for (const p of projects) {
      if (p.exempt) { exempt.push({ name: p.name, reason: p.exempt }); continue }
      if (p.pending) { pending.push({ name: p.name, reason: p.pending }); continue }
      if (!token) { missingTokens.push(`${p.name} (account ${acct})`); continue }
      try {
        const { fails, warns } = await auditProject(p, token)
        if (fails.length) violations.push({ project: p.name, findings: fails, warns })
        else if (warns.length) warnOnly.push({ project: p.name, warns })
        else okProjects.push(p.name)
      } catch (err) {
        errored.push({ project: p.name, error: String(err).slice(0, 200) })
        // A catalog-query failure is a real gap in coverage → treat as a violation so CI goes red.
        violations.push({ project: p.name, findings: [{ check: 'audit error', detail: String(err).slice(0, 200), fix: 'investigate token scope / Management-API access' }], warns: [] })
      }
    }
  }

  // ── Report ────────────────────────────────────────────────────────────────
  console.log('RLS / grant-drift guard — billing-bypass class (SS/CM). ENFORCED prod projects:\n')

  for (const v of violations) {
    console.log(`*** FAIL *** ${v.project}`)
    for (const f of v.findings) {
      console.log(`   [${f.check}] ${f.detail}`)
      console.log(`      fix: ${f.fix}`)
    }
    for (const w of v.warns ?? []) console.log(`   [WARN ${w.check}] ${w.detail}`)
  }
  for (const w of warnOnly) {
    console.log(`WARN  ${w.project}`)
    for (const x of w.warns) console.log(`   [${x.check}] ${x.detail}${x.fixHint ? ` (fix: ${x.fixHint})` : ''}`)
  }
  for (const name of okProjects) console.log(`OK    ${name} — no anon/auth billing grants, no privileged SECDEF holes`)

  if (exempt.length) {
    console.log('\nEXEMPT (reported, never fails):')
    for (const e of exempt) console.log(`  - ${e.name.padEnd(22)} - ${e.reason}`)
  }
  if (pending.length) {
    console.log('\nPENDING v11 audit (reported, never fails — enroll as enforced once audited):')
    for (const e of pending) console.log(`  - ${e.name.padEnd(22)} - ${e.reason}`)
  }
  if (missingTokens.length) {
    console.log('\nUNAUDITED GAP (missing SUPABASE_TOKEN_* secret for an ENFORCED project):')
    for (const m of missingTokens) console.log(`  - ${m}`)
  }

  // ── Alert (inline ALERT_SMTP_*, mirroring check-auth-email-config.mjs) ───────
  if (violations.length && process.env.ALERT_SMTP_HOST) {
    try {
      const { createMailTransport } = await import('./lib/smtp.mjs')
      const t = await createMailTransport({
        host: process.env.ALERT_SMTP_HOST,
        port: process.env.ALERT_SMTP_PORT,
        user: process.env.ALERT_SMTP_USER,
        pass: process.env.ALERT_SMTP_PASS,
      })
      const items = violations.map((v) => {
        const li = v.findings.map((f) => `<li><b>[${f.check}]</b> ${f.detail}<br><code>${f.fix}</code></li>`).join('')
        return `<p><b>${v.project}</b></p><ul>${li}</ul>`
      }).join('')
      await t.sendMail({
        from: `RLS Grant Guard <${process.env.ALERT_SMTP_USER}>`,
        to: process.env.ALERT_TO,
        subject: `[ALERT] ${violations.length} Supabase project(s) with billing-bypass grant drift`,
        html: `<p>${violations.length} enforced project(s) expose the billing-bypass class (self-grant on entitlement columns or anon/auth-executable SECDEF RPC):</p>${items}<p>Fix: column-level REVOKE UPDATE on the billing columns, or REVOKE EXECUTE from anon/authenticated/PUBLIC on the SECDEF function.</p>`,
      })
    } catch (e) {
      console.error('alert email failed:', e.message)
    }
  }

  if (violations.length || missingTokens.length) {
    console.error(`\nFAIL: ${violations.length} enforced project(s) with grant drift, ${missingTokens.length} unaudited gap(s).`)
    process.exit(1)
  }
  console.log(`\nAll enforced projects OK (${okProjects.length} clean, ${warnOnly.length} warn-only, ${exempt.length} exempt, ${pending.length} pending v11 audit).`)
}

main()
