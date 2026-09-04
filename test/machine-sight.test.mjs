import { test } from 'node:test'
import assert from 'node:assert/strict'
import { machineSight, sightBanner } from '../scripts/lib/machine-sight.mjs'

const tok = (t) => ({ token: t, id: t, files: [] })

test('a token that opens nothing counts as dead, not as sight', async () => {
  const s = await machineSight({
    discover: () => [tok('alive'), tok('stale')],
    projects: async (t) => (t === 'alive' ? { status: 200, projects: [{ id: 'aaa' }] } : { status: 200, projects: [] }),
  })
  assert.equal(s.tokens, 2)
  assert.equal(s.live, 1)
  assert.equal(s.dead.length, 1)
  assert.deepEqual([...s.refs], ['aaa'])
})

test('a product no token opens is named as CANNOT JUDGE, not as unknown', async () => {
  const s = await machineSight({
    discover: () => [tok('alive')],
    projects: async () => ({ status: 200, projects: [{ id: 'seen' }] }),
  })
  const { lines, blind } = sightBanner(s, ['seen', 'hidden-one', 'hidden-two'])
  assert.deepEqual(blind, ['hidden-one', 'hidden-two'])
  const text = lines.join('\n')
  assert.match(text, /CANNOT JUDGE 2 OF 3 PRODUCTS/)
  assert.match(text, /NEVER "unknown"/)
  assert.ok(text.includes('hidden-one') && text.includes('hidden-two'), 'the blind products must be named')
})

test('seeing everything is STATED, not left as silence', async () => {
  const s = await machineSight({
    discover: () => [tok('alive')],
    projects: async () => ({ status: 200, projects: [{ id: 'a' }, { id: 'b' }] }),
  })
  const { lines, blind } = sightBanner(s, ['a', 'b'])
  assert.deepEqual(blind, [])
  assert.match(lines.join('\n'), /All 2 product\(s\) this run judges are reachable/)
})

test('an unreachable API is UNKNOWN and must not be reported as blindness', async () => {
  // The dangerous confusion: no network looks identical to no keys, and calling it blindness
  // would send somebody rotating credentials that are perfectly fine.
  const s = await machineSight({
    discover: () => [tok('a'), tok('b')],
    projects: async () => ({ status: 0, projects: [], error: 'offline' }),
  })
  assert.equal(s.unreachable, true)
  const { lines, blind, unknown } = sightBanner(s, ['x', 'y'])
  assert.equal(unknown, true)
  assert.deepEqual(blind, [], 'nothing may be declared blind when the API could not be asked')
  assert.match(lines.join('\n'), /UNKNOWN/)
})

test('no token value can reach the banner', async () => {
  const secret = 'sbp_thisisaverysecretvalue_0123456789'
  const s = await machineSight({
    discover: () => [tok(secret)],
    projects: async () => ({ status: 200, projects: [] }),
  })
  const text = sightBanner(s, ['x']).lines.join('\n')
  assert.ok(!text.includes(secret), 'a token value must never appear in the banner')
  assert.equal(s.dead.length, 1)
  assert.equal(s.dead[0].length, 8, 'dead tokens are named by an 8-char fingerprint only')
})
