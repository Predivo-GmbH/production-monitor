/**
 * A CREDENTIAL WITH AN INVISIBLE CHARACTER IN IT IS NOT A CREDENTIAL, AND NOTHING SAYS SO.
 *
 * -- THE INCIDENT (2026-09-01) --------------------------------------------------------------
 *
 * The hourly monitor went red on two unrelated-looking checks at once:
 *
 *   tests/jass-tour/user-password-login.spec.ts
 *     Failed to create test user: Cannot convert argument to a ByteString because the
 *     character at index 7 has a value of 65279 which is greater than 255.
 *   scripts/check-supabase-machine-health.mjs
 *     UNREADABLE  JASSTOUR  metrics endpoint returned no usable sample
 *
 * One cause. 65279 is 0xFEFF, a UTF-8 BYTE ORDER MARK, and "Bearer " is exactly seven
 * characters -- so index 7 is the FIRST CHARACTER OF THE KEY. The GitHub secret
 * JASSTOUR_SERVICE_ROLE_KEY had been stored with a leading BOM. The key material itself was
 * perfect: fetched from the Management API the same hour, it answered 200 on
 * /auth/v1/admin/users. Reproduced exactly, with no secret involved at all -- build a header
 * from "Bearer " plus one BOM plus any key, and undici refuses it with that same sentence.
 *
 * A BOM is what Windows PowerShell writes by default -- >, Out-File and Set-Content all emit
 * UTF-8 WITH BOM -- so any secret that reaches "gh secret set" through a file on this fleet's own
 * CI laptop can arrive carrying one. Nothing in the pipeline can see it: it is zero-width in
 * every editor, every terminal, every diff, and "gh secret list" shows only a name and a date.
 *
 * -- WHY THIS FILE, AND NOT A CAREFUL HAND-FIX ----------------------------------------------
 *
 * This is the THIRD invisible-byte failure in three days. On 2026-08-31 all eight run-*.ps1
 * wrappers held a BEL byte in a path, so Test-Path failed forever and every job silently took a
 * fallback; it was fixed by hand and left no guard, so on 2026-09-01 a BACKSPACE byte in a
 * Valrano spec reported a working login as broken while its twin made a second assertion vacuous.
 * THAT one did leave a guard -- test/no-control-bytes.test.mjs -- and the guard is why this file
 * exists rather than a fourth hand-fix: that guard scans every AUTHORED FILE in the repo, and a
 * value living in GitHub's secret store is not a file and never will be. It is the twin the
 * file-scanner structurally cannot reach, and it failed within hours of the scanner shipping.
 *
 * -- THE RULE THIS ENCODES ------------------------------------------------------------------
 *
 *     WE REMOVE EXACTLY WHAT A HUMAN CANNOT SEE, AND NOTHING ELSE.
 *
 * Invisible characters are stripped wherever they sit, and whitespace is trimmed at the ENDS
 * (a trailing newline from piping a key into "gh secret set" is the same bug wearing a different
 * byte). Interior VISIBLE whitespace is deliberately left alone: a space in the middle of a key
 * usually means two values got pasted together, and that must keep failing loudly instead of
 * being silently welded into something almost-plausible.
 *
 * A repair is always REPORTED, never silent -- the house rule from lib/supabaseToken.ts, where a
 * token fallback names itself so the stale config still gets fixed. The stored secret is still
 * defective after this module rescues a run from it, and the report is the only thing that will
 * ever get it repaired at source. The report names the VARIABLE and the CHARACTER, never the
 * value and never its length, because these strings are credentials and this log is uploaded.
 */

/**
 * The code-point ranges a person cannot see, as NUMBERS.
 *
 * Written as numbers, and assembled into a RegExp at load, on purpose. The alternative -- a
 * literal character class -- would mean typing the very bytes this module exists to remove into
 * the module that removes them, where they would be equally invisible to the next reader and
 * would trip test/no-control-bytes.test.mjs on the way past. A file about unreadable characters
 * should be readable.
 *
 * C0 controls INCLUDING tab, newline and carriage return: all three are legitimate in a file and
 * none of them is ever legitimate inside a key. Then DEL and the C1 range, then the
 * zero-width, soft-hyphen, bidirectional and word-joiner characters that cause exactly the same
 * class of bug in a wider alphabet. U+FEFF is last, and is the one that caused the outage.
 */
const INVISIBLE_RANGES = [
  [0x0000, 0x001f], // C0 controls, incl. TAB / LF / CR and the BEL and BACKSPACE of the two prior incidents
  [0x007f, 0x009f], // DEL and the C1 controls
  [0x00ad, 0x00ad], // SOFT HYPHEN
  [0x180e, 0x180e], // MONGOLIAN VOWEL SEPARATOR
  [0x200b, 0x200f], // ZERO WIDTH SPACE .. RIGHT-TO-LEFT MARK
  [0x2028, 0x2029], // LINE / PARAGRAPH SEPARATOR
  [0x202a, 0x202e], // the bidirectional overrides
  [0x2060, 0x2064], // WORD JOINER .. INVISIBLE PLUS
  [0x2066, 0x206f], // the bidi isolates and deprecated formatting characters
  [0xfeff, 0xfeff], // ZERO WIDTH NO-BREAK SPACE, a.k.a. the UTF-8 BYTE ORDER MARK
]

const INVISIBLE = new RegExp(
  '[' + INVISIBLE_RANGES.map(([lo, hi]) => `\\u${lo.toString(16).padStart(4, '0')}-\\u${hi.toString(16).padStart(4, '0')}`).join('') + ']',
  'g',
)

/** Reports one character as U+FEFF, so a log line is greppable and a value is not guessable. */
function codePointName(ch) {
  return `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`
}

/**
 * A COARSE location, never the raw index -- because the raw index of a TRAILING byte IS the
 * value's length. "Bearer " is seven characters, so a newline echoed onto the end of a 28-char
 * key sits at index 28, and emitting that number prints the credential's length into a public
 * CI log -- the exact thing this module's report promises never to do. start / end / interior
 * says where the byte was, usefully, while no arithmetic recovers the length from it.
 */
function positionLabel(index, length) {
  if (index === 0) return 'at the start'
  if (index === length - 1) return 'at the end'
  return 'in the interior'
}

/**
 * Splits a raw value into what it should have been and a description of what was wrong with it.
 *
 * The returned removals describe POSITIONS AND CODE POINTS ONLY. They never contain, quote or
 * measure the surrounding value -- a credential's length is itself worth knowing to an attacker,
 * and this output is written into a public CI log.
 */
export function inspectCredential(raw) {
  const value = String(raw ?? '')
  const removals = []
  for (let i = 0; i < value.length; i++) {
    INVISIBLE.lastIndex = 0
    if (INVISIBLE.test(value[i])) removals.push(`${codePointName(value[i])} ${positionLabel(i, value.length)}`)
  }
  INVISIBLE.lastIndex = 0
  const stripped = value.replace(INVISIBLE, '')
  const clean = stripped.trim()
  if (clean !== stripped) removals.push('surrounding whitespace')
  return { clean, removals, repaired: clean !== value }
}

/**
 * Env var names whose value we put on the wire -- a header, a URL, an SMTP/IMAP login.
 *
 * Matched as whole underscore-delimited SEGMENTS, never as substrings, so the ordinary
 * environment is not caught by accident: PATH is not PAT, HOSTNAME is not HOST. Being matched is
 * harmless in any case -- a value with nothing invisible in it comes back byte-identical -- but a
 * predicate that is precise about what it claims to cover is one that can be reasoned about.
 *
 * Derived from the env block of .github/workflows/monitor.yml rather than imagined: it covers
 * every one of the secret-backed variables that workflow passes, except GITHUB_REPOSITORY, which
 * GitHub itself supplies and no human ever pastes.
 */
const WIRE_SEGMENTS = new Set([
  'KEY', 'KEYS', 'SECRET', 'TOKEN', 'PAT', 'PASSWORD', 'PASS',
  'USER', 'HOST', 'PORT', 'URL', 'EMAIL', 'DSN', 'WEBHOOK',
])

export function isWireValueName(name) {
  return String(name).split('_').some((segment) => WIRE_SEGMENTS.has(segment))
}

/**
 * Repairs every wire-value variable in env, IN PLACE, and returns a report of what it had to
 * repair -- one entry per variable, [] when everything was already clean.
 *
 * In place, because the whole point is that callers downstream -- a spec reading process.env, a
 * createClient() three files away, a fetch() inside a helper -- get the clean value without
 * knowing this module exists. A sanitiser you have to remember to call at each use site is a
 * sanitiser that will be missed at one of them.
 */
export function sanitizeEnv(env = process.env) {
  const report = []
  for (const name of Object.keys(env)) {
    if (!isWireValueName(name)) continue
    const raw = env[name]
    if (!raw) continue
    const { clean, removals, repaired } = inspectCredential(raw)
    if (!repaired) continue
    env[name] = clean
    report.push({ name, removals })
  }
  return report
}

/** The exact sentence written to the log for one repaired variable. Never includes the value. */
export function repairMessage({ name, removals }) {
  return (
    `[credentials] ${name} contained ${removals.join(', ')} and was repaired in memory for this ` +
    `run. THE STORED SECRET IS STILL WRONG and every other consumer of it is still broken: ` +
    `re-set it from a value with no invisible characters in it. A UTF-8 BOM is what PowerShell's ` +
    `>, Out-File and Set-Content all write by default, which is how one gets in.`
  )
}

/**
 * The one call a program makes: repair the environment and say so.
 *
 * Returns the report so a caller can also act on it; most callers only need the logging.
 */
export function sanitizeEnvAndReport(env = process.env, log = console.warn) {
  const report = sanitizeEnv(env)
  for (const entry of report) log(repairMessage(entry))
  return report
}
