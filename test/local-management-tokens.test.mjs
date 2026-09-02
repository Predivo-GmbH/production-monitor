/**
 * THE TWO MISTAKES THAT TURNED A HEALTHY FLEET INTO A FOUR-DAY CRITICAL, AS ASSERTIONS.
 *
 * Signal fleet:supabase-mgmt-tokens-dead-on-disk stood critical from 2026-08-29 to 2026-09-02
 * saying every Supabase management token on disk was revoked and that only Roger could fix it.
 * Fourteen were live and every one of them ran SQL. The two mistakes behind it are the two things
 * this file exists to keep from happening again, and both are testable with no network and no
 * secret:
 *
 *   1. A `.bak` FILE WAS COUNTED AS CONFIG. The 2026-08-29 rotation left a
 *      `Credentials.txt.bak-<date>-before-key-rotation` beside each live file, holding exactly the
 *      tokens it had just revoked. Any sweep globbing `Credentials.txt*` finds a dead token beside
 *      every live one. Seventeen of the twenty-one dead tokens exist ONLY in such a file.
 *
 *   2. A LIVE TOKEN WAS TESTED AGAINST A PROJECT IN ANOTHER ACCOUNT, got the 401 that guarantees,
 *      and the 401 was reported as "too narrowly scoped to run SQL". There is one Supabase account
 *      per product, so for any given project THIRTEEN OF FOURTEEN TOKENS ANSWER 401 and that is
 *      the healthy state. A resolver that stops at the first refusal finds nothing, every time.
 *
 * And the standing rule that both of those reports broke on the way out:
 *
 *   3. A TOKEN IS NAMED BY A HASH, NEVER BY ITS VALUE OR ANY PREFIX OF IT.
 *
 * Pure: no network, no filesystem, no secrets. Every token below is a made-up string.
 * Run: node test/local-management-tokens.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  fingerprint,
  isSupersededCopy,
  credentialFiles,
  extractTokens,
  discoverLocalTokens,
  projectsFor,
  tokenForProject,
  runSql,
} from '../scripts/lib/local-management-tokens.mjs'

/** Shaped like the real thing, belonging to nobody. */
const FAKE_A = 'sbp_' + 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const FAKE_B = 'sbp_' + 'f0e1d2c3b4a59687786958473625140312345678'
const FAKE_C = 'sbp_' + '0123456789abcdef0123456789abcdef01234567'

// ---------------------------------------------------------------- mistake 1: the .bak files

test('every backup naming convention the fleet has used is recognised as superseded', () => {
  for (const name of [
    'Credentials.txt.bak-2026-08-29-before-key-rotation',
    'Credentials.txt.bak-2026-08-30-before-mailbox-pw',
    'Credentials.txt.bak-2026-08-29-before-mgmt-token-refresh',
    'Credentials.txt.bak',
  ]) {
    assert.equal(isSupersededCopy(name), true, `${name} must not be read as config`)
  }
  assert.equal(isSupersededCopy('Credentials.txt'), false)
})

test('credentialFiles enumerates one live file per product and never a backup', () => {
  const dirs = ['replyflow', 'BackOffice', 'Valrano', 'node_modules_lookalike']
  const present = new Set([
    'replyflow/docs/Credentials.txt',
    'BackOffice/docs/Credentials.txt',
    'Valrano/docs/Credentials.txt',
    // The trap: a backup sitting right beside a live file.
    'Valrano/docs/Credentials.txt.bak-2026-08-29-before-key-rotation',
  ])
  const files = credentialFiles('/fleet', {
    readdir: () => dirs.map((name) => ({ name, isDirectory: () => true })),
    exists: (p) => present.has(p.replace(/\\/g, '/').replace('/fleet/', '')),
  })
  const rel = files.map((f) => f.replace(/\\/g, '/').replace('/fleet/', ''))
  assert.deepEqual(rel, ['BackOffice/docs/Credentials.txt', 'Valrano/docs/Credentials.txt', 'replyflow/docs/Credentials.txt'])
  assert.equal(rel.some((f) => f.includes('.bak')), false, 'a revoked token must never enter the inventory')
})

test('a product added tomorrow is enumerated, because the list is not a list of names', () => {
  const files = credentialFiles('/fleet', {
    readdir: () => [{ name: 'brand-new-product', isDirectory: () => true }],
    exists: () => true,
  })
  assert.equal(files.length, 1)
  assert.match(files[0].replace(/\\/g, '/'), /brand-new-product\/docs\/Credentials\.txt$/)
})

// ---------------------------------------------------------------- extraction and identity

test('tokens are extracted and deduplicated, and one token in three files is one token', () => {
  const files = ['a', 'b', 'c']
  const text = { a: `x ${FAKE_A} y`, b: `${FAKE_A}\n${FAKE_B}`, c: 'nothing here' }
  const found = discoverLocalTokens({ files, readFile: (f) => text[f] })
  assert.equal(found.length, 2)
  const a = found.find((f) => f.token === FAKE_A)
  assert.deepEqual(a.files, ['a', 'b'])
})

test('a file that cannot be read is skipped, not fatal', () => {
  const found = discoverLocalTokens({
    files: ['locked', 'ok'],
    readFile: (f) => {
      if (f === 'locked') throw new Error('EACCES')
      return FAKE_C
    },
  })
  assert.equal(found.length, 1)
})

test('mistake 3: a fingerprint identifies a token and leaks no part of it', () => {
  const id = fingerprint(FAKE_A)
  assert.match(id, /^[0-9a-f]{8}$/)
  assert.equal(fingerprint(FAKE_A), id, 'stable, so two reports can be compared')
  assert.notEqual(fingerprint(FAKE_B), id)
  // The real rule: no run of the token survives into the identifier.
  for (let n = 4; n <= FAKE_A.length; n++) {
    assert.equal(id.includes(FAKE_A.slice(0, n)), false)
    assert.equal(id.includes(FAKE_A.slice(-n)), false)
  }
})

test('nothing printable that this module returns carries a token value', async () => {
  const found = discoverLocalTokens({ files: ['f'], readFile: () => FAKE_A })
  assert.equal(JSON.stringify(found.map((f) => ({ id: f.id, files: f.files }))).includes(FAKE_A), false)
})

// ---------------------------------------------------------------- mistake 2: the wrong door

test('a 401 yields no projects and never throws, because it is the normal answer', async () => {
  const r = await projectsFor(FAKE_A, { fetchImpl: async () => ({ ok: false, status: 401 }) })
  assert.deepEqual(r, { status: 401, projects: [] })
})

test('a network failure is reported, not thrown', async () => {
  const r = await projectsFor(FAKE_A, {
    fetchImpl: async () => {
      throw new Error('ETIMEDOUT')
    },
  })
  assert.equal(r.status, 0)
  assert.equal(r.projects.length, 0)
  assert.match(r.error, /ETIMEDOUT/)
})

test('mistake 2: the search survives thirteen refusals to find the fourteenth token', async () => {
  // Twelve dead-looking refusals, then a token that is simply for another account, then the one.
  const tokens = [
    ...Array.from({ length: 12 }, (_, i) => ({ token: `sbp_dead${i}`.padEnd(24, '0'), id: `dead${i}`, files: [] })),
    { token: FAKE_B, id: 'otheracct', files: [] },
    { token: FAKE_A, id: 'theone', files: [] },
  ]
  let asked = 0
  const fetchImpl = async (_url, init) => {
    asked++
    const bearer = init.headers.Authorization
    if (bearer.endsWith(FAKE_A)) {
      return { ok: true, status: 200, json: async () => [{ ref: 'dqmhsdzldkxngwjrxois', name: 'ReplyFlow' }] }
    }
    // A healthy token for a DIFFERENT account: 200, and simply not your project.
    if (bearer.endsWith(FAKE_B)) return { ok: true, status: 200, json: async () => [{ ref: 'zzz', name: 'BackOffice' }] }
    return { ok: false, status: 401 }
  }
  const hit = await tokenForProject('ReplyFlow', { tokens, fetchImpl })
  assert.equal(hit.id, 'theone')
  assert.equal(hit.project.ref, 'dqmhsdzldkxngwjrxois')
  assert.equal(asked, 14, 'every token must be asked; stopping at the first 401 is the incident')
})

test('a project is found by ref as well as by name, and the name match ignores case', async () => {
  const tokens = [{ token: FAKE_A, id: 'x', files: [] }]
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => [{ ref: 'abc123', name: 'ReplyFlow' }] })
  assert.equal((await tokenForProject('abc123', { tokens, fetchImpl })).project.name, 'ReplyFlow')
  assert.equal((await tokenForProject('replyflow', { tokens, fetchImpl })).project.ref, 'abc123')
})

test('no token opening the project returns null - a different fact from a dead token', async () => {
  const tokens = [{ token: FAKE_A, id: 'x', files: [] }]
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => [{ ref: 'other', name: 'Something Else' }] })
  assert.equal(await tokenForProject('ReplyFlow', { tokens, fetchImpl }), null)
})

// ---------------------------------------------------------------- the query itself

test('runSql posts the query and treats 201 - not 200 - as the success of a POST', async () => {
  let seen
  const fetchImpl = async (url, init) => {
    seen = { url, method: init.method, body: JSON.parse(init.body) }
    return { ok: true, status: 201, json: async () => [{ count: 42 }] }
  }
  const r = await runSql('dqmhsdzldkxngwjrxois', 'select count(*) from auth.users', FAKE_A, { fetchImpl })
  assert.equal(seen.url, 'https://api.supabase.com/v1/projects/dqmhsdzldkxngwjrxois/database/query')
  assert.equal(seen.method, 'POST')
  assert.equal(seen.body.query, 'select count(*) from auth.users')
  assert.equal(r.status, 201)
  assert.deepEqual(r.rows, [{ count: 42 }])
})

test('a refused query returns its status and no rows, rather than pretending', async () => {
  const r = await runSql('ref', 'select 1', FAKE_A, { fetchImpl: async () => ({ ok: false, status: 403 }) })
  assert.equal(r.status, 403)
  assert.equal(r.rows, null)
})

// ---------------------------------------------------------------- the twin stays a twin

test('the CLI never formats a token value into its output', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../scripts/supabase-local-query.mjs', import.meta.url), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')
  // `found.token` may be PASSED to runSql; it may never be interpolated into a printed string.
  assert.equal(/console\.(log|error)\([^)]*\.token\b/.test(code), false)
  assert.match(code, /found\.id/, 'the CLI must name the token it used, by fingerprint')
})
