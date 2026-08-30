#!/usr/bin/env node
/**
 * Auth-email config guard.
 *
 * Supabase auth emails are gated by GoTrue rate_limit_email_sent, which DEFAULTS to
 * 2/hour and is HARD-CAPPED at 2 unless the project has custom SMTP OR a send-email
 * hook. This silently breaks signup/OTP/password-reset and has recurred >=5 times.
 * This guard GETs every project /config/auth and fails if an ENFORCED project is at risk.
 *
 * A project is AT RISK when rate_limit_email_sent < MIN_RATE_LIMIT, OR neither custom
 * SMTP (smtp_host) nor the send-email hook is configured.
 *
 * SCOPE: the GoTrue cap only matters for projects that send auth email THROUGH GoTrue.
 * Auditing every project produced permanent false "at risk" reds for projects that do
 * not (password-gate apps, no-signup admin tools, projects with their own SMTP edge
 * functions that bypass GoTrue, and staging/test envs with no real users). Those are
 * marked exempt below and are REPORTED but never fail. A project marked warn is a known
 * latent risk (pre-launch MVP that DOES use the GoTrue mailer): prints WARNING, does not
 * fail. Each verdict was source-audited; see memory session_three_red_workflows_2026_06_18.
 *
 * Tokens: SUPABASE_TOKEN_<ACCT> per account, treated as a HINT about ownership rather
 * than a fact — the ACCOUNTS map is documentation and documentation drifts. A pinned
 * token that is refused falls back to any management token that can actually see the
 * project (lib/supabase-token.mjs), and the stale name is reported, not hidden. Only a
 * project NO token can see is reported unaudited, for ENFORCED projects.
 * Optional alert via ALERT_SMTP_*. Exit 1 when any ENFORCED project is at risk/missing.
 */

import { findTokenForProject, isTokenRefused } from './lib/supabase-token.mjs'

const MIN_RATE_LIMIT = 10
const STAGING = 'staging/test environment - no real users; e2e auth tests bypass email (password-grant)'

const ACCOUNTS = {
  MUELLER: [
    { ref: 'ogdpgufptemcgyszmjek', name: 'SignalScore' },
    { ref: 'blfnyxwcriyxvsaubiqb', name: 'SignalScore Staging', exempt: STAGING },
  ],
  REPLYFLOW: [
    { ref: 'dqmhsdzldkxngwjrxois', name: 'ReplyFlow' },
    { ref: 'cuvqzwvyovxvvvuddtjd', name: 'ReplyFlow Staging', exempt: STAGING },
  ],
  ARIVIOO: [{ ref: 'iooexkbuxmeryeuzpxau', name: 'Arivioo', exempt: 'auth email via custom SMTP edge functions (request-signup-code / request-password-reset) that bypass GoTrue - rate cap does not apply (verified: no signUp/OTP/resetPasswordForEmail in frontend)' }],
  CHANNELMOVER: [{ ref: 'qswluvqunswggfmesdcs', name: 'ChannelMover' }],
  API: [
    // APIs project SUNSET 2026-07-02 (API Dashboard decommissioned) — account api@predivo.ch still hosts Beize Jass Tour
    { ref: 'dkxdlovwzsxnepoteebk', name: 'Beize Jass Tour', warn: 'PRE-LAUNCH MVP - uses GoTrue built-in mailer via supabase.auth.signUp() (jass-tour-ui-kit Auth.tsx:92). Configure custom SMTP/hook + rate_limit_email_sent>=10 BEFORE public launch.' },
  ],
  LAUNCHREADY: [{ ref: 'hcfeoescybfngjsphekq', name: 'LaunchReady' }],
  // 2026-07-30: DistributionOS + Valrano split into two dedicated Supabase accounts
  // (old shared distributionos account hit the free-tier 2-project cap). Project refs
  // unchanged, but each now needs its OWN account PAT — the old distributionos PAT returns
  // HTTP 403 for both prod refs. DistributionOS -> new distributionos account
  // (SUPABASE_TOKEN_DISTRIBUTIONOS); Valrano + staging -> new valrano account (SUPABASE_TOKEN_VALRANO).
  DISTRIBUTIONOS: [
    { ref: 'jxjpbmkgmuunpayqgbsx', name: 'DistributionOS' },
  ],
  VALRANO: [
    { ref: 'mkdeftmubrkseyrrbzvp', name: 'Valrano' },
    { ref: 'vfwpcgdkrwqhdivfzmrg', name: 'Valrano Staging', exempt: STAGING },
  ],
  SCOUTCOPILOT: [{ ref: 'rlcsuqwqzoqjykdiqjye', name: 'ScoutCopilot' }],
  BACKOFFICE: [
    { ref: 'xoecpzfsskalvjrtcbbl', name: 'BackOffice' },
    { ref: 'vvgqkwiqauafcflshsec', name: 'BackOffice Staging', exempt: STAGING },
  ],
  BOATBUDDY: [
    { ref: 'xzythvxmuxmczuiophwp', name: 'BoatBuddy', exempt: 'not Supabase Auth - client-side password gate (PasswordGate.tsx, SHA-256); no signup/OTP/reset email flows' },
    { ref: 'svpewgbwousyheohlrtt', name: 'BoatBuddy Staging', exempt: 'not Supabase Auth - client-side password gate; no auth email flows' },
  ],
}

async function getAuthConfig(ref, token) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/config/auth`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

/**
 * Read a project's auth config, preferring the token this file says owns it.
 *
 * The ACCOUNTS map above is documentation of who owns what, and documentation
 * drifts. When the pinned token is refused we ask the other tokens rather than
 * failing the guard over a stale label — but we return WHICH token answered, so
 * the drift gets reported instead of buried. Returns null when nothing in the
 * environment can see the project at all; that one really is unauditable.
 */
async function readAuthConfig(ref, pinnedKey, env = process.env) {
  const pinned = env[pinnedKey]
  if (pinned) {
    try {
      return { cfg: await getAuthConfig(ref, pinned), usedKey: pinnedKey, fellBackFrom: null }
    } catch (err) {
      // A non-auth error is about the PROJECT, not the token — no other token fixes it.
      const status = Number(String(err.message).replace('HTTP ', ''))
      if (!isTokenRefused(status)) throw err
    }
  }
  const fallback = await findTokenForProject(ref, env, pinnedKey)
  if (!fallback) return null
  return {
    cfg: await getAuthConfig(ref, fallback.token),
    usedKey: fallback.key,
    // Report the fallback whether the pinned token was REFUSED or simply ABSENT.
    // An unset/empty SUPABASE_TOKEN_<ACCT> (a deleted or never-renewed secret, which
    // in CI expands to '') is exactly the blind spot this commit warned against:
    // it would resolve via a sibling token and vanish from the output. Surface it.
    fellBackFrom: pinnedKey,
    pinnedMissing: !pinned,
  }
}

function evaluate(cfg) {
  const rate = cfg.rate_limit_email_sent
  const hasCustomDelivery = Boolean(cfg.smtp_host) || cfg.hook_send_email_enabled === true
  const reasons = []
  if (typeof rate !== 'number' || rate < MIN_RATE_LIMIT) reasons.push(`rate_limit_email_sent=${rate} (< ${MIN_RATE_LIMIT})`)
  if (!hasCustomDelivery) reasons.push('no custom SMTP and no send-email hook (built-in mailer hard-capped at 2/hr)')
  return reasons
}

async function main() {
  const violations = []
  const missingTokens = []
  const rows = []
  const exempt = []
  const warnings = []
  const staleTokens = []

  for (const [acct, projects] of Object.entries(ACCOUNTS)) {
    const pinnedKey = `SUPABASE_TOKEN_${acct}`
    for (const p of projects) {
      if (p.exempt) { exempt.push({ name: p.name, reason: p.exempt }); continue }
      if (p.warn) { warnings.push({ name: p.name, reason: p.warn }); continue }
      try {
        const read = await readAuthConfig(p.ref, pinnedKey)
        if (!read) { missingTokens.push(`${p.name} (account ${acct}, ref ${p.ref}) — no management token in this environment can see it`); continue }
        const { cfg, usedKey, fellBackFrom, pinnedMissing } = read
        // Audited fine, so it must NOT fail the guard — but the map is wrong and says so.
        if (fellBackFrom) {
          const why = pinnedMissing ? 'is not set' : 'is no longer accepted'
          staleTokens.push(`${p.name}: ${fellBackFrom} ${why}; audited with ${usedKey} instead`)
        }
        const reasons = evaluate(cfg)
        rows.push({ name: p.name, rate: cfg.rate_limit_email_sent, smtp: cfg.smtp_host || 'null', hook: cfg.hook_send_email_enabled, ok: reasons.length === 0 })
        if (reasons.length) violations.push({ project: p.name, testName: 'auth-email config', error: reasons.join('; ') })
      } catch (err) {
        rows.push({ name: p.name, rate: '?', smtp: '?', hook: '?', ok: false, err: err.message })
        violations.push({ project: p.name, testName: 'auth-email config', error: `lookup failed: ${err.message}` })
      }
    }
  }

  console.log('ENFORCED (GoTrue email auth):')
  console.log('PROJECT'.padEnd(22), 'RATE'.padEnd(5), 'SMTP'.padEnd(22), 'HOOK'.padEnd(6), 'STATUS')
  for (const r of rows) {
    console.log(String(r.name).padEnd(22), String(r.rate).padEnd(5), String(r.smtp).padEnd(22), String(r.hook).padEnd(6), r.ok ? 'OK' : '*** AT RISK ***')
  }
  const lookupFailures = rows.filter((r) => r.err)
  if (lookupFailures.length) {
    console.log('\nLOOKUP FAILURES (project could not be audited - Management-API error, not a config value):')
    for (const r of lookupFailures) console.log('  -', String(r.name).padEnd(20), '-', r.err)
  }
  if (staleTokens.length) {
    console.log('')
    console.log('STALE TOKEN NAMES (audited via another token - fix the ACCOUNTS map, or add/renew the missing SUPABASE_TOKEN_<ACCT> secret):')
    for (const t of staleTokens) console.log('  -', t)
  }
  if (warnings.length) {
    console.log('\nWARN (latent - does not fail the guard, but act before launch):')
    for (const w of warnings) console.log('  [WARN]', w.name, '-', w.reason)
  }
  if (exempt.length) {
    console.log('\nEXEMPT (GoTrue email cap does not apply):')
    for (const e of exempt) console.log('  -', e.name.padEnd(20), '-', e.reason)
  }
  if (missingTokens.length) {
    console.log('\nUNAUDITED (missing SUPABASE_TOKEN_* secret for an ENFORCED project):')
    for (const m of missingTokens) console.log('  -', m)
  }

  if (violations.length && process.env.ALERT_SMTP_HOST) {
    try {
      const { createMailTransport } = await import('./lib/smtp.mjs')
      const t = await createMailTransport({
        host: process.env.ALERT_SMTP_HOST,
        port: process.env.ALERT_SMTP_PORT,
        user: process.env.ALERT_SMTP_USER,
        pass: process.env.ALERT_SMTP_PASS,
      })
      const list = violations.map((v) => `<li><b>${v.project}</b>: ${v.error}</li>`).join('')
      await t.sendMail({
        from: `Auth Config Guard <${process.env.ALERT_SMTP_USER}>`,
        to: process.env.ALERT_TO,
        subject: `[ALERT] ${violations.length} Supabase project(s) at-risk auth-email config`,
        html: `<p>${violations.length} project(s) at risk:</p><ul>${list}</ul><p>Fix: custom SMTP or send-email hook + rate_limit_email_sent &ge; ${MIN_RATE_LIMIT}.</p>`,
      })
    } catch (e) {
      console.error('alert email failed:', e.message)
    }
  }

  if (violations.length || missingTokens.length) {
    console.error(`\nFAIL: ${violations.length} enforced project(s) at risk, ${missingTokens.length} unaudited.`)
    process.exit(1)
  }
  console.log(`\nAll enforced projects OK (${exempt.length} exempt, ${warnings.length} warn).`)
}

main()
