/**
 * Tests for "does the edge env still hold a key the project no longer recognises?".
 *
 * Every DEFECT case below is the real ReplyFlow production outage of 2026-09-02, or one of the
 * three false alarms that sat next to it in the same env and would have buried it.
 *
 * Then one LIVE assertion against the two production projects that were fixed, so this file is
 * also the receipt: if a future rotation shadows a live key again, this goes red. It reads its
 * own management tokens off disk and needs no secret passed to it.
 *
 * Run: node test/check-edge-env-keys.test.mjs   (exit 0 = all pass)
 */
import assert from 'node:assert'
import {
  classifySecret, auditProject, summarise, digest, OUTBOUND_CREDENTIALS, COMPARISON_ONLY, sweep,
} from '../scripts/check-edge-env-keys.mjs'

let n = 0
const t = (name, fn) => { fn(); n++; console.log(`  ok - ${name}`) }

// The real ReplyFlow production shape on 2026-09-02 at 21:4xZ, by digest.
const LIVE_SECRET = 'secret:rotated_2026_09_02'
const known = new Map([
  [digest('live-secret'), LIVE_SECRET],
  [digest('live-publishable'), 'publishable:default'],
  [digest('old-legacy-service-role'), 'legacy:service_role'],
  [digest('old-legacy-anon'), 'legacy:anon'],
])
const ctx = { known, legacyDisabled: true }
const s = (name, v) => ({ name, value: digest(v) })

// ── DEFECT INJECTION: the outage itself ──────────────────────────────────────────────────
// SB_SECRET_KEY held the key revoked at ~20:14Z. SUPABASE_SERVICE_ROLE_KEY next to it was
// correctly updated — which is exactly why nobody saw it: one of the pair looked right.
t('DEFECT: a revoked key in SB_SECRET_KEY is a FAILURE, even beside a correct fallback', () => {
  const a = auditProject({
    name: 'ReplyFlow', ref: 'dqmhsdzldkxngwjrxois', legacyDisabled: true, known,
    secrets: [s('SB_SECRET_KEY', 'revoked-2026-09-02'), s('SUPABASE_SERVICE_ROLE_KEY', 'live-secret')],
  })
  assert.equal(a.failures.length, 1)
  assert.equal(a.failures[0].name, 'SB_SECRET_KEY')
  assert.match(a.failures[0].reason, /does not recognise/)
  assert.equal(summarise([a]).verdict, 'fail')
})

// SignalScore threw nothing all evening and was broken the whole time. A check that only looks
// where an error was reported would have called it healthy.
t('DEFECT: the silent twin fails too — no traffic is not the same as no fault', () => {
  const a = auditProject({
    name: 'SignalScore', ref: 'ogdpgufptemcgyszmjek', legacyDisabled: true, known,
    secrets: [s('SB_SECRET_KEY', 'revoked-2026-09-02'), s('SB_PUBLISHABLE_KEY', 'live-publishable')],
  })
  assert.equal(a.failures.length, 1)
  assert.equal(a.warnings.length, 0)
})

t('DEFECT: a legacy key presented AS a credential fails once legacy keys are disabled', () => {
  const a = auditProject({
    name: 'p', ref: 'r', legacyDisabled: true, known,
    secrets: [s('SUPABASE_SERVICE_ROLE_KEY', 'old-legacy-service-role')],
  })
  assert.equal(a.failures.length, 1)
  assert.match(a.failures[0].reason, /legacy keys are disabled/)
})

// ── THE THREE FALSE ALARMS THAT SHARE THE SAME ENV ───────────────────────────────────────
t('the platform JSON lists are not judged — they are not single keys', () => {
  for (const name of ['SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_SECRET_KEYS']) {
    assert.equal(classifySecret(s(name, 'a json array'), ctx).level, 'skip')
  }
})

t('a foreign vendor key is not this check’s business', () => {
  assert.equal(classifySecret(s('STRIPE_SECRET_KEY', 'sk_live_x'), ctx).level, 'skip')
})

t('SERVICE_ROLE_JWT holding a disabled legacy key WARNS, never fails — it is compared, not presented', () => {
  const r = classifySecret(s('SERVICE_ROLE_JWT', 'old-legacy-service-role'), ctx)
  assert.equal(r.level, 'warn')
  assert.match(r.reason, /comparison value/)
})

// ── THE SAME DIGEST IS FINE ON STAGING ───────────────────────────────────────────────────
// Every staging project in this fleet still has legacy keys ENABLED. Judging against a constant
// instead of the project's own answer would have condemned nine healthy projects.
t('the identical legacy key passes where legacy keys are still enabled', () => {
  const r = classifySecret(s('SUPABASE_SERVICE_ROLE_KEY', 'old-legacy-service-role'), { known, legacyDisabled: false })
  assert.equal(r.level, 'ok')
})

// ── A SWEEP THAT JUDGED NOTHING IS NOT A PASS ────────────────────────────────────────────
t('DEFECT: zero credentials judged reports INCONCLUSIVE, not pass', () => {
  const a = auditProject({ name: 'p', ref: 'r', legacyDisabled: true, known, secrets: [s('STRIPE_SECRET_KEY', 'x')] })
  assert.equal(a.checked, 0)
  assert.equal(summarise([a]).verdict, 'inconclusive')
})

t('a clean project passes and says how many it judged', () => {
  const a = auditProject({
    name: 'p', ref: 'r', legacyDisabled: true, known,
    secrets: [s('SB_SECRET_KEY', 'live-secret'), s('SUPABASE_SERVICE_ROLE_KEY', 'live-secret'), s('SUPABASE_ANON_KEY', 'live-publishable')],
  })
  assert.equal(a.failures.length, 0)
  assert.equal(a.checked, 3)
  assert.equal(summarise([a]).verdict, 'pass')
})

t('a value that is not a digest is skipped rather than guessed at', () => {
  assert.equal(classifySecret({ name: 'SB_SECRET_KEY', value: 'not-a-digest' }, ctx).level, 'skip')
})

t('the two variable sets do not overlap', () => {
  for (const k of COMPARISON_ONLY) assert.ok(!OUTBOUND_CREDENTIALS.has(k))
})

// ── LIVE: the receipt for the 2026-09-02 fix ─────────────────────────────────────────────
// Skipped without network or tokens rather than failing, so the pure tests above stay runnable
// anywhere; when it does run it is the only assertion that proves production is actually well.
const LIVE_REFS = { dqmhsdzldkxngwjrxois: 'ReplyFlow prod', ogdpgufptemcgyszmjek: 'SignalScore prod' }
if (!process.env.SKIP_LIVE) {
  const audits = await sweep().catch((e) => { console.log(`  -- live sweep unavailable (${String(e.message).slice(0, 60)})`); return null })
  if (audits && audits.length) {
    for (const [ref, label] of Object.entries(LIVE_REFS)) {
      const a = audits.find((x) => x.ref === ref)
      if (!a) { console.log(`  -- ${label}: no local token opens it, skipped`); continue }
      t(`LIVE ${label}: every credential in the edge env is a key the project recognises`, () => {
        assert.ok(a.checked > 0, `${label} judged 0 credentials — that is a broken check, not a clean project`)
        assert.deepEqual(a.failures.map((f) => `${f.name}: ${f.reason}`), [])
      })
    }
    const s2 = summarise(audits)
    console.log(`  -- fleet sweep: ${s2.projects} projects, ${s2.checked} credentials judged, ${s2.failing} failing, ${s2.warnings} warnings`)
    t('LIVE: no project in the fleet presents a key its own project refuses', () => {
      const bad = audits.filter((a) => a.failures.length).map((a) => `${a.name}(${a.ref}): ${a.failures.map((f) => f.name).join(',')}`)
      assert.deepEqual(bad, [])
    })
  } else if (audits) {
    console.log('  -- live sweep reached no projects, skipped')
  }
}

console.log(`\n${n} passed`)
