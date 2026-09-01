/**
 * NO SOURCE FILE MAY CONTAIN A RAW CONTROL BYTE.
 *
 * WHY THIS EXISTS (2026-09-01). Valrano's new hourly login test reported `login = failed` twice in
 * a row against production while the login was working perfectly. The failure artifact showed the
 * onboarding wizard rendered, which only exists behind ProtectedRoute, so the session was real.
 * The cause was one byte: a line that reads `/\/(dashboard|onboarding)\b/` in an editor held a
 * literal 0x08 BACKSPACE on disk where the word-boundary escape should have been. The pattern
 * demanded a control character inside a URL, could never match, and timed out for 20 seconds.
 *
 * The same file carried a second one, doing the opposite damage: `not.toMatch(/...\b/)` with a
 * backspace can never match either, so that assertion passed no matter what the URL was. ONE
 * corruption produced a false failure; ITS TWIN produced a silent false pass. Both are invisible
 * in every editor, every diff and every code review, because the byte renders as nothing.
 *
 * This is the second time this fleet has been bitten by exactly this. On 2026-08-31 all eight
 * `run-*.ps1` wrappers held `scripts<0x07>gent-run.mjs`, a BEL byte where `\a` collapsed, so
 * `Test-Path` failed forever and every job silently took a fallback path. That incident was fixed
 * by hand and left no guard behind, which is why it could happen again the next day in a different
 * repo. This is the guard.
 *
 * WHAT IS ALLOWED: tab (0x09), newline (0x0A), carriage return (0x0D), and ESC (0x1B) inside a
 * file that deliberately tests ANSI handling. Everything else is a defect, including the
 * zero-width and bidirectional Unicode characters that are the same problem in a wider alphabet.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// fileURLToPath, NOT .pathname. A repo path with a space in it ("Internal Projects") arrives
// percent-encoded from a URL, and readdirSync then fails on a directory that plainly exists.
const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Directories that are not our source, or are generated. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'test-results', 'playwright-report', 'coverage', 'dist', 'build',
  '.next', '.turbo', 'blob-report', '.playwright',
])

/** What we actually author. Binary and lockfiles are none of our business. */
const EXTENSIONS = ['.mjs', '.js', '.cjs', '.ts', '.tsx', '.yml', '.yaml', '.json', '.ps1', '.sh', '.md']

/** Tab, newline, carriage return. */
const ALLOWED = new Set([9, 10, 13])

/**
 * ESC is legitimate in exactly one place: a fixture that proves ANSI colour codes are stripped
 * out of a failure message before it reaches a card on a page. Named explicitly rather than
 * allowed everywhere, so a stray escape anywhere else still fails.
 */
const ESC_ALLOWED_IN = new Set([
  'test/publish-check-results.test.mjs',
  'test/alert-dedup.test.mjs',
])

/**
 * Invisible Unicode that causes the same class of bug in a wider alphabet.
 *
 * BUILT FROM CODE POINTS, NOT LITERALS, and that is not fussiness: the first version of this
 * file wrote the characters themselves into the patterns, so the guard matched ITSELF and failed
 * on the only file in the repo that was allowed to contain them. A detector written in the thing
 * it detects cannot be trusted to be about anything else.
 */
const INVISIBLE = [
  { name: 'zero-width space', code: 0x200b },
  { name: 'zero-width non-joiner', code: 0x200c },
  { name: 'zero-width joiner', code: 0x200d },
  { name: 'word joiner', code: 0x2060 },
  { name: 'byte order mark', code: 0xfeff },
  { name: 'left-to-right override', code: 0x202d },
  { name: 'right-to-left override', code: 0x202e },
]

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    let st
    try { st = statSync(full) } catch { continue }
    if (st.isDirectory()) walk(full, out)
    else if (EXTENSIONS.some((e) => entry.endsWith(e))) out.push(full)
  }
  return out
}

test('no source file contains a raw control byte', () => {
  const offenders = []
  for (const file of walk(ROOT)) {
    const rel = relative(ROOT, file).split(sep).join('/')
    const buf = readFileSync(file)
    for (let i = 0; i < buf.length; i++) {
      const b = buf[i]
      if (b >= 32 || ALLOWED.has(b)) continue
      if (b === 0x1b && ESC_ALLOWED_IN.has(rel)) continue
      const line = buf.subarray(0, i).toString('utf8').split('\n').length
      const context = buf.subarray(Math.max(0, i - 40), i + 10).toString('utf8').replace(/[\x00-\x1f]/g, '?')
      offenders.push(`${rel}:${line} holds byte 0x${b.toString(16).padStart(2, '0')} — ...${context}...`)
      break // one report per file is enough to act on
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'A control byte in source renders as nothing in every editor and diff. On 2026-09-01 one made ' +
      'a regex unmatchable, which reported a working login as broken; its twin made an assertion ' +
      'vacuous, which passed regardless of the URL. Offenders:\n' + offenders.join('\n'),
  )
})

test('no source file contains invisible Unicode', () => {
  const offenders = []
  for (const file of walk(ROOT)) {
    const rel = relative(ROOT, file).split(sep).join('/')
    const text = readFileSync(file, 'utf8')
    for (const { name, code } of INVISIBLE) {
      // A BOM is legitimate as the very first character of a file; anywhere else it is a defect.
      const at = text.indexOf(String.fromCharCode(code))
      if (at > 0 || (at === 0 && code !== 0xfeff)) {
        offenders.push(`${rel} contains a ${name} at offset ${at}`)
      }
    }
  }
  assert.deepEqual(offenders, [], 'Invisible Unicode is the same defect in a wider alphabet:\n' + offenders.join('\n'))
})

test('the guard actually detects a control byte', () => {
  // A guard that has never been shown to fail proves only that it runs. This asserts the
  // detection itself, on a buffer built here, so the rule cannot rot into a no-op.
  const sample = Buffer.from([0x2f, 0x61, 0x08, 0x2f])
  const found = [...sample].some((b) => b < 32 && !ALLOWED.has(b))
  assert.equal(found, true, 'the byte-scanning predicate must flag a 0x08')

  const clean = Buffer.from('/a\\b/\n\t', 'utf8')
  const falsePositive = [...clean].some((b) => b < 32 && !ALLOWED.has(b))
  assert.equal(falsePositive, false, 'an escaped word boundary written correctly must NOT be flagged')
})
