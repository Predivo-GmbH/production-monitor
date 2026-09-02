/**
 * Detect `page.waitForFunction(fn, { timeout })` — options handed to the ARG slot.
 *
 * Playwright's signature is waitForFunction(pageFunction, arg, options). Called with
 * only two arguments, an options-shaped object becomes the ARG passed into the browser
 * callback, and the real timeout silently falls back to `use.actionTimeout`. Nothing
 * throws, nothing warns; the wait is simply shorter than the code says it is, and the
 * error message the author wrote ("no result within 60s") becomes a lie about
 * production.
 *
 * This module is a pure source scanner so the rule can be unit-tested both ways —
 * a ratchet that silently matches nothing is not a gate.
 */

const OPTION_KEYS = ['timeout', 'polling']

/**
 * Split a call's argument list into top-level argument texts.
 * Returns null when the parentheses are unbalanced (truncated/unparsable source).
 */
function splitArgs(src, openParenIndex) {
  let depth = 0
  let i = openParenIndex
  const commas = []
  let prevMeaningful = '('

  while (i < src.length) {
    const c = src[i]
    const next = src[i + 1]

    // Line comment
    if (c === '/' && next === '/') {
      i = src.indexOf('\n', i)
      if (i === -1) return null
      continue
    }
    // Block comment
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2)
      if (end === -1) return null
      i = end + 2
      continue
    }
    // Strings and template literals. Templates may nest ${...}, but no call in this
    // repo puts a paren-unbalanced template inside a waitForFunction arg list, and an
    // unbalanced scan returns null rather than guessing.
    if (c === '"' || c === "'" || c === '`') {
      i++
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') i++
        i++
      }
      i++
      prevMeaningful = 'x'
      continue
    }
    // Regex literal — only where a value may start, else it is division.
    if (c === '/' && '(,=:[!&|?{};+*%~^<>'.includes(prevMeaningful)) {
      i++
      let inClass = false
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue }
        if (src[i] === '[') inClass = true
        else if (src[i] === ']') inClass = false
        else if (src[i] === '/' && !inClass) break
        else if (src[i] === '\n') return null
        i++
      }
      i++
      prevMeaningful = 'x'
      continue
    }

    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') {
      depth--
      if (depth === 0) {
        // Closing paren of the call itself.
        const inner = src.slice(openParenIndex + 1, i)
        const parts = []
        let start = 0
        for (const rel of commas) {
          parts.push(inner.slice(start, rel))
          start = rel + 1
        }
        parts.push(inner.slice(start))
        return parts.map((p) => p.trim()).filter((p, idx, all) => !(p === '' && idx === all.length - 1))
      }
    } else if (c === ',' && depth === 1) {
      commas.push(i - openParenIndex - 1)
    }

    if (!/\s/.test(c)) prevMeaningful = c
    i++
  }
  return null
}

/**
 * True when `text` is an object literal carrying a Playwright option key at its TOP
 * level. Depth matters: `{ opts: { timeout: 5 } }` is ordinary data for the callback,
 * not options, and flagging it would push authors to "fix" a correct call.
 */
export function looksLikeOptionsObject(text) {
  const t = text.trim()
  if (!t.startsWith('{') || !t.endsWith('}')) return false

  let depth = 0
  for (let i = 0; i < t.length; i++) {
    const c = t[i]
    if (c === '"' || c === "'" || c === '`') {
      i++
      while (i < t.length && t[i] !== c) {
        if (t[i] === '\\') i++
        i++
      }
      continue
    }
    if (c === '{' || c === '[' || c === '(') { depth++; continue }
    if (c === '}' || c === ']' || c === ')') { depth--; continue }
    if (depth !== 1) continue
    for (const k of OPTION_KEYS) {
      if (!t.startsWith(k, i)) continue
      const before = t[i - 1]
      if (before && /[A-Za-z0-9_$.]/.test(before)) continue // part of a longer identifier
      let j = i + k.length
      while (j < t.length && /\s/.test(t[j])) j++
      if (t[j] === ':') return true
    }
  }
  return false
}

/**
 * Every waitForFunction call in `source`, with the argument count and whether the
 * second argument is an options object sitting in the arg slot.
 */
export function findWaitForFunctionCalls(source) {
  const out = []
  const needle = 'waitForFunction'
  let from = 0
  for (;;) {
    const at = source.indexOf(needle, from)
    if (at === -1) break
    from = at + needle.length
    // Must be a call: the next non-space character is '('
    let p = at + needle.length
    while (p < source.length && /\s/.test(source[p])) p++
    if (source[p] !== '(') continue
    const args = splitArgs(source, p)
    if (!args) continue
    out.push({
      line: source.slice(0, at).split('\n').length,
      argCount: args.length,
      args,
      misplacedOptions: args.length === 2 && looksLikeOptionsObject(args[1]),
    })
  }
  return out
}

/** Violations only — the shape the ratchet asserts is empty. */
export function misplacedOptionViolations(source, file) {
  return findWaitForFunctionCalls(source)
    .filter((c) => c.misplacedOptions)
    .map((c) => `${file}:${c.line} — waitForFunction(fn, ${c.args[1].replace(/\s+/g, ' ')}) passes options as the ARG; pass \`undefined\` (or the real arg) second and options third`)
}
