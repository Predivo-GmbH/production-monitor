/**
 * Unit tests for the "is the code we committed the code that is running?" check.
 *
 * The check exists because on 2026-09-01 BackOffice's largest production error had been FIXED
 * nine days earlier and the fix had never been deployed. Every case below is one way the
 * sentence "it is fixed" can be false.
 *
 * Run: node test/check-edge-code-live.test.mjs   (exit 0 = all pass)
 */
import assert from 'node:assert'
import { compareInventories, describeBehind, summarise, loadBaseline, HOUR_MS }
  from '../scripts/check-edge-code-live.mjs'

let n = 0
const t = (name, fn) => { fn(); n++; console.log(`  ok - ${name}`) }
const GRACE = 6 * HOUR_MS
const m = (o) => new Map(Object.entries(o))

// ── DEFECT INJECTION: the real BackOffice case, with its real dates ──────────────────────
// _shared/outreach.ts + smartlead-plan.ts committed 2026-08-29; production sync-outreach was
// last deployed 2026-08-20. Nine days. Nothing anywhere said so.
t('DEFECT: the nine-day BackOffice gap is caught, and named', () => {
  const { stale } = compareInventories(
    m({ 'sync-outreach': '2026-08-29T14:18:21.000Z' }),
    m({ 'sync-outreach': '2026-08-20T09:34:24.446Z' }),
    GRACE,
  )
  assert.equal(stale.length, 1)
  assert.equal(stale[0].slug, 'sync-outreach')
  assert.equal(describeBehind(stale[0].behindMs), '9d')
})

t('and the same pair AFTER the promotion is clean', () => {
  const { stale } = compareInventories(
    m({ 'sync-outreach': '2026-08-29T14:18:21.000Z' }),
    m({ 'sync-outreach': '2026-09-01T20:52:53.927Z' }),
    GRACE,
  )
  assert.deepEqual(stale, [])
})

// ── The _shared rule, which is the whole reason the BackOffice case was invisible ────────
t('a function is stale when only _shared changed — a shared fix reaches nothing until redeploy', () => {
  // committedFunctions() folds in the shared files a function IMPORTS; this asserts the
  // consequence that must produce, so an edit dropping shared files from the walk fails here.
  const sharedChangedAt = '2026-08-29T14:00:00.000Z'
  const { stale } = compareInventories(
    m({ 'sync-outreach': sharedChangedAt, 'sync-usage': sharedChangedAt }),
    m({ 'sync-outreach': '2026-08-20T09:00:00.000Z', 'sync-usage': '2026-08-20T09:00:00.000Z' }),
    GRACE,
  )
  assert.equal(stale.length, 2, 'every function importing the changed shared module is behind')
})

// ── Never deployed: the Distribution-OS shape ────────────────────────────────────────────
t('in the repo but absent from production -> NEVER_DEPLOYED, not merely stale', () => {
  const { stale, neverDeployed } = compareInventories(
    m({ 'send-auth-email': '2026-09-02T13:00:00.000Z' }), m({}), GRACE)
  assert.deepEqual(stale, [])
  assert.equal(neverDeployed.length, 1)
  assert.equal(neverDeployed[0].slug, 'send-auth-email')
})

t('live but absent from the repo -> ORPHAN: running code nobody can read', () => {
  const { orphan } = compareInventories(m({}), m({ 'ghost-fn': '2026-01-01T00:00:00.000Z' }), GRACE)
  assert.equal(orphan.length, 1)
  assert.equal(orphan[0].slug, 'ghost-fn')
})

// ── The grace window is a floor, not a licence ───────────────────────────────────────────
t('a deploy in flight is not an alarm (inside the grace window)', () => {
  const { stale } = compareInventories(
    m({ a: '2026-09-02T12:00:00.000Z' }), m({ a: '2026-09-02T09:00:00.000Z' }), GRACE)
  assert.deepEqual(stale, [], '3h behind with a 6h grace is a deploy still running')
})

t('one minute past the grace window IS reported — the boundary is not a rounding-down', () => {
  const deployed = '2026-09-02T00:00:00.000Z'
  const committed = new Date(Date.parse(deployed) + GRACE + 60_000).toISOString()
  const { stale } = compareInventories(m({ a: committed }), m({ a: deployed }), GRACE)
  assert.equal(stale.length, 1)
})

t('deployed AHEAD of the commit is fine, never negative-stale', () => {
  const { stale } = compareInventories(
    m({ a: '2026-08-01T00:00:00.000Z' }), m({ a: '2026-09-02T00:00:00.000Z' }), GRACE)
  assert.deepEqual(stale, [])
})

// ── A timestamp we cannot compare is UNKNOWN, never "fine" ───────────────────────────────
// NaN comparisons are always false, so an unparseable date would silently pass the `> grace`
// test. That is the reassuring direction, and this repo's whole doctrine is that unknown is
// never reported as healthy.
t('an unparseable timestamp is reported, not silently passed', () => {
  const { stale } = compareInventories(
    m({ a: 'not-a-date' }), m({ a: '2026-09-02T00:00:00.000Z' }), GRACE)
  assert.equal(stale.length, 1)
  assert.equal(stale[0].unparseable, true)
})

t('an unparseable DEPLOYED timestamp is caught too', () => {
  const { stale } = compareInventories(
    m({ a: '2026-09-02T00:00:00.000Z' }), m({ a: 'whenever' }), GRACE)
  assert.equal(stale.length, 1)
  assert.equal(stale[0].unparseable, true)
})

// ── Ordering: the longest-stranded fix is the one that has been wrong longest ────────────
t('worst-first, so the board row leads with the oldest gap', () => {
  const { stale } = compareInventories(
    m({ recent: '2026-09-02T00:00:00.000Z', ancient: '2026-09-02T00:00:00.000Z' }),
    m({ recent: '2026-09-01T00:00:00.000Z', ancient: '2026-06-01T00:00:00.000Z' }),
    GRACE,
  )
  assert.equal(stale[0].slug, 'ancient')
})

// ── A clean fleet says nothing ───────────────────────────────────────────────────────────
t('everything current -> no summary at all (no alarm on a healthy fleet)', () => {
  const findings = [{ repo: 'replyflow', stale: [], neverDeployed: [], orphan: [] }]
  assert.equal(summarise(findings), null)
})

t('an orphan alone does not raise the alarm — it is information, not a stranded fix', () => {
  const findings = [{ repo: 'replyflow', stale: [], neverDeployed: [], orphan: [{ slug: 'ghost' }] }]
  assert.equal(summarise(findings), null)
})

// ── The sentence Roger reads ─────────────────────────────────────────────────────────────
t('the summary names the product, the function and the age — not just a count', () => {
  const findings = [{
    repo: 'BackOffice',
    stale: [{ slug: 'sync-outreach', behindMs: 9 * 24 * HOUR_MS }],
    neverDeployed: [], orphan: [],
  }]
  const s = summarise(findings)
  assert.match(s, /BackOffice/)
  assert.match(s, /sync-outreach/)
  assert.match(s, /9d/)
  assert.match(s, /still running the old version/)
})

t('never-deployed functions are named in the summary too', () => {
  const findings = [{ repo: 'Distribution-OS', stale: [], orphan: [],
    neverDeployed: [{ slug: 'send-auth-email' }] }]
  const s = summarise(findings)
  assert.match(s, /never been deployed/)
  assert.match(s, /Distribution-OS\/send-auth-email/)
})

// ── Coverage: absent must never read as fine ─────────────────────────────────────────────
t('the baseline lists every repo that has edge functions, including the unproven ones', () => {
  const repos = loadBaseline()
  // Measured 2026-09-02: 11 repos under C:\Business\Internal Projects have supabase/functions.
  assert.equal(repos.length, 11, 'a repo missing from the baseline is a blind spot, not a pass')
  const verified = repos.filter((r) => r.prod)
  assert.ok(verified.length >= 5, 'the five verified on 2026-09-02 must stay covered')
  for (const r of repos) {
    assert.ok(r.repo && r.branch, `${r.repo}: every row needs a repo and a deployable branch`)
    assert.ok('prod' in r, `${r.repo}: prod must be present, null means UNPROVEN not absent`)
  }
})

t('the deployable branch is a REMOTE ref — a local-only commit is not shippable', () => {
  for (const r of loadBaseline()) {
    assert.match(r.branch, /^origin\//, `${r.repo}: ${r.branch} is not a remote ref`)
  }
})

console.log(`\n${n} passed`)

// ── Import-graph precision: the difference between a signal and noise ────────────────────
// The first version of this check folded the whole _shared directory into every function and
// reported "49 of BackOffice's 55 are behind" every time anyone touched any shared file. These
// pin the precise behaviour so that cannot come back.
import { relativeImports, resolvePosix, dependencyFiles, parseCommitTimes, repoSource }
  from '../scripts/check-edge-code-live.mjs'

t('relative imports are found in every form Deno actually uses', () => {
  const src = `
    import { a } from './helper.ts'
    import '../_shared/side-effect.ts'
    const m = await import('../_shared/lazy.ts')
    import x from 'npm:nodemailer@6'
    import y from 'https://esm.sh/@supabase/supabase-js@2'
    import z from 'jsr:@std/assert'
  `
  const found = relativeImports(src)
  assert.ok(found.includes('./helper.ts'))
  assert.ok(found.includes('../_shared/side-effect.ts'))
  assert.ok(found.includes('../_shared/lazy.ts'))
  assert.equal(found.length, 3, 'npm:/https:/jsr: are someone else\u2019s code and cannot make OUR deploy stale')
})

t('paths resolve POSIX-style, because git paths are forward-slashed on every platform', () => {
  assert.equal(resolvePosix('supabase/functions/sync-outreach/index.ts', '../_shared/outreach.ts'),
    'supabase/functions/_shared/outreach.ts')
  assert.equal(resolvePosix('supabase/functions/a/index.ts', './b.ts'), 'supabase/functions/a/b.ts')
  assert.equal(resolvePosix('supabase/functions/_shared/a.ts', './deep/../b.ts'), 'supabase/functions/_shared/b.ts')
})

t('the dependency walk is transitive and terminates on a cycle', () => {
  const files = {
    'supabase/functions/f/index.ts': "import './a.ts'",
    'supabase/functions/f/a.ts': "import '../_shared/b.ts'",
    'supabase/functions/_shared/b.ts': "import '../f/a.ts'", // cycle, on purpose
  }
  const got = dependencyFiles('f', (p) => files[p] ?? null).sort()
  assert.deepEqual(got, [
    'supabase/functions/_shared/b.ts',
    'supabase/functions/f/a.ts',
    'supabase/functions/f/index.ts',
  ])
})

t('DEFECT: a shared file a function does NOT import must not make it stale', () => {
  // send-invoice does not import the Smartlead classifier. Before the precision fix it was
  // reported as behind anyway, purely because that classifier lived in the same directory.
  const files = {
    'supabase/functions/send-invoice/index.ts': "import '../_shared/email.ts'",
    'supabase/functions/_shared/email.ts': '',
    'supabase/functions/_shared/smartlead-plan.ts': '', // changed today, imported by nobody here
  }
  const deps = dependencyFiles('send-invoice', (p) => files[p] ?? null)
  assert.ok(!deps.includes('supabase/functions/_shared/smartlead-plan.ts'),
    'an unimported shared file is not a dependency')
})

t('a missing entry point yields no dependencies rather than throwing', () => {
  assert.deepEqual(dependencyFiles('ghost', () => null), [])
})

t('commit times parse newest-first, one entry per file', () => {
  const raw = '\x012026-09-01T10:00:00Z\nsupabase/functions/a/index.ts\nsupabase/functions/_shared/x.ts\n' +
              '\x012026-08-01T10:00:00Z\nsupabase/functions/a/index.ts\n'
  const map = parseCommitTimes(raw)
  assert.equal(map.get('supabase/functions/a/index.ts'), '2026-09-01T10:00:00Z', 'newest wins')
  assert.equal(map.get('supabase/functions/_shared/x.ts'), '2026-09-01T10:00:00Z')
  assert.equal(map.size, 2)
})

// ── CI mode ──────────────────────────────────────────────────────────────────────────────
t('a local checkout is used as-is, and nothing is cloned', () => {
  let cloned = false
  const src = repoSource({ repo: 'replyflow' },
    { root: '/fleet', workdir: '/tmp', token: 'tok' },
    { exists: (q) => q.split(String.fromCharCode(92)).join('/') === '/fleet/replyflow/.git', exec: () => { cloned = true } })
  assert.equal(src.mode, 'local')
  assert.equal(cloned, false)
})

t('no checkout and no token -> UNAVAILABLE, never a silent pass', () => {
  const src = repoSource({ repo: 'x' }, { root: '/fleet', workdir: '/tmp', token: '' },
    { exists: () => false, exec: () => {} })
  assert.equal(src.mode, 'unavailable')
  assert.ok(src.why)
})

t('CI clone is blobless and full-history — --depth would make old files look never-changed', () => {
  let args = null
  repoSource({ repo: 'BackOffice' }, { root: '/fleet', workdir: '/tmp', token: 'tok' },
    { exists: () => false, exec: (_cmd, a) => { args = a } })
  assert.ok(args.includes('--filter=blob:none'), 'blobless keeps history without downloading every file')
  assert.ok(!args.some((a) => String(a).startsWith('--depth')), 'a shallow clone would hide old commits')
})

t('a clone failure never leaks the token into the message', () => {
  const token = 'ghp_supersecretvalue'
  assert.throws(
    () => repoSource({ repo: 'x' }, { root: '/f', workdir: '/tmp', token },
      { exists: () => false, exec: () => { throw new Error(`fatal: https://x-access-token:${token}@github.com/x`) } }),
    (e) => !e.message.includes(token) && e.message.includes('***'),
  )
})

console.log(`\n${n} passed (total)`)
