/**
 * A CHECK THAT CANNOT TELL "REFUSED" FROM "NEVER SUPPLIED" HANDS THE WRONG JOB TO A PERSON.
 *
 * 2026-09-01 audit, item "Two health checks alarm on a dead password while a working one sits
 * unused". The fallback branch in lib/edgeFunctions.ts is entered for two different reasons — the
 * pinned token was REFUSED (401/403), or no token was supplied at all — and it printed the same
 * sentence for both: "<key> is no longer accepted for this project".
 *
 * What had actually happened: the repo secret YTMIGRATION_SUPABASE_ACCESS_TOKEN was DELETED on
 * 2026-08-30, so `${{ secrets.YTMIGRATION_SUPABASE_ACCESS_TOKEN }}` expanded to an empty string
 * and the spec was handed `''`. Nothing was refused. Nothing was dead. But the log said "no
 * longer accepted", and from that one wrong word the board grew a HIGH-priority item titled
 * "One dead key is keeping the production alarm red, and only you can replace it", two night
 * shifts were spent on it, and Roger was asked to go to Supabase and mint a PAT. Measured on
 * 2026-09-01: nothing was red, and a live token for the same project was already in the repo's
 * secrets AND on disk in ChannelMover/docs/Credentials.txt.
 *
 * A REFUSED credential may genuinely need a person. A MISSING one is a name in our own repo, and
 * this process can see which of the two it is. So it must say which.
 *
 * Run: node test/pinned-token-note.test.mjs
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { pinnedTokenNote } from '../scripts/lib/supabase-token.mjs'

const REF = 'qswluvqunswggfmesdcs'

test('a token that was REFUSED is reported as refused, and names the key that was refused', () => {
  const note = pinnedTokenNote({
    projectRef: REF,
    pinnedKey: 'YTMIGRATION_SUPABASE_ACCESS_TOKEN',
    hadToken: true,
    fallbackKey: 'SUPABASE_TOKEN_CHANNELMOVER',
  })
  assert.match(note, /YTMIGRATION_SUPABASE_ACCESS_TOKEN/)
  assert.match(note, /REFUSED/)
  assert.match(note, /SUPABASE_TOKEN_CHANNELMOVER/)
})

test('NO token supplied is never reported as a refusal — the exact state a deleted secret produces', () => {
  // `${{ secrets.DELETED_NAME }}` expands to '', so the caller passes a falsy token and
  // `pinnedKey` cannot be resolved from the environment either. This is the case the old
  // message got wrong, and the whole reason this file exists.
  const note = pinnedTokenNote({
    projectRef: REF,
    pinnedKey: undefined,
    hadToken: false,
    fallbackKey: 'SUPABASE_TOKEN_CHANNELMOVER',
  })
  assert.doesNotMatch(
    note,
    /refused|no longer accepted|rejected|expired|revoked|dead/i,
    'a missing secret must NOT be described as a credential that was turned down — that wording ' +
      'is what sent two night shifts after a token nobody needed to mint',
  )
  assert.match(note, /resolves to nothing/i, 'it must say the name resolves to nothing')
  assert.match(note, /SUPABASE_TOKEN_CHANNELMOVER/, 'it must still name what it used instead')
})

test('both messages still name the project and still ask for the pinned name to be repaired', () => {
  for (const hadToken of [true, false]) {
    const note = pinnedTokenNote({
      projectRef: REF,
      pinnedKey: hadToken ? 'SOME_TOKEN' : undefined,
      hadToken,
      fallbackKey: 'SUPABASE_TOKEN_CHANNELMOVER',
    })
    assert.match(note, new RegExp(REF), 'the project ref is how you find which check this was')
    assert.match(note, /pinned name should be repaired/, 'the fallback is never silent')
  }
})
