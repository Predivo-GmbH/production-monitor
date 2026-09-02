/**
 * Does a Playwright config bind its test server to a port that another job could already hold?
 *
 * WHY THIS EXISTS. Our self-hosted build host runs ~24 GitHub runners for 14 repositories inside
 * ONE Linux network namespace, so a TCP port is a fleet-wide resource, not a per-job one. Every
 * case below is real and cost us green-but-meaningless test runs:
 *
 *   - Valrano, 2026-08-31: the config pinned 5173 AND set reuseExistingServer: true
 *     unconditionally. Another product's leftover Vite already held 5173, Playwright cheerfully
 *     adopted it, and the suite ran against Factory Cockpit - 88 of 90 tests still passed,
 *     because only a title assertion was specific enough to notice.
 *   - ChannelMover, 2026-08-31: 8083 hardcoded, two runners of the same repo overlapped, and the
 *     loser died with "http://localhost:8083 is already used". A second runner added no
 *     throughput at all.
 *   - Distribution-OS, found 2026-09-02: the strict-port flag was missing, so Vite would slide to
 *     the next free port while Playwright kept polling the old one.
 *
 * The rule the fleet settled on (standards/deploy-standard.md RULE 3): take a free port from the
 * OS, pass it to the server AND to the url, make the server fail loudly if it cannot bind that
 * exact port, and never reuse an existing server under CI.
 *
 * This module is pure text inspection, so it can be unit-tested against the historical bugs with
 * no repository present.
 */

/** Server programs that support a hard "bind this port or die" flag, and what that flag is. */
const STRICT_FLAGS = [
  // Deliberately only the programs that HAVE such a flag. Expo and `next dev` do not; those
  // configs pin the url to the same port instead, so a failure to bind times out loudly.
  { match: /\bvite\b/, flag: '--strictPort', name: 'vite' },
  { match: /\bserve\b/, flag: '--no-port-switching', name: 'serve' },
]

/**
 * Pull out every `webServer: { ... }` block. Brace-counting rather than a regex, because these
 * blocks contain nested objects and a lazy regex stops at the first closing brace.
 */
export function extractWebServerBlocks(source) {
  const blocks = []
  const key = /webServer\s*:\s*\{/g
  let m
  while ((m = key.exec(source)) !== null) {
    let depth = 1
    let i = m.index + m[0].length
    while (i < source.length && depth > 0) {
      if (source[i] === '{') depth++
      else if (source[i] === '}') depth--
      i++
    }
    blocks.push(source.slice(m.index, i))
  }
  return blocks
}

/**
 * Remove line and block comments, so a port mentioned while EXPLAINING the fix is not read back
 * as the fix being absent. Every corrected config in the fleet names its old port in a comment.
 */
export function stripComments(text) {
  const BLOCK = new RegExp('/\\*[\\s\\S]*?\\*/', 'g')
  return text.replace(BLOCK, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/**
 * Inspect one Playwright config's source text.
 * @returns {{rule: string, detail: string}[]} one entry per problem; empty means healthy.
 */
export function inspectPlaywrightConfig(source) {
  const findings = []
  const blocks = extractWebServerBlocks(source)
  // No local server is started, so nothing can collide: a suite that only hits a deployed URL
  // is fine by definition.
  if (blocks.length === 0) return findings

  for (const raw of blocks) {
    const block = stripComments(raw)

    // 1. Never adopt whatever already holds the port when running in CI.
    const reuse = block.match(/reuseExistingServer\s*:\s*([^,\n}]+)/)
    if (!reuse) {
      findings.push({
        rule: 'reuse-not-set',
        detail: 'reuseExistingServer is not set, so Playwright will adopt a server that is already listening',
      })
    } else if (!/process\.env\.CI/.test(reuse[1])) {
      findings.push({
        rule: 'reuse-not-gated-on-ci',
        detail: `reuseExistingServer: ${reuse[1].trim()} - under CI this adopts another product's leftover server`,
      })
    }

    // 2. The port must come from outside the file. A literal is only safe as the fallback of an
    //    env override (E2E_PORT || '5173'), which reaches the block as an interpolation, never as
    //    a bare number.
    const literals = []
    for (const [, p] of block.matchAll(/localhost:(\d{2,5})/g)) literals.push(`localhost:${p}`)
    for (const [, p] of block.matchAll(/(?:^|[^\w-])port\s*:\s*(\d{2,5})/g)) literals.push(`port: ${p}`)
    for (const [, p] of block.matchAll(/--port[\s=](\d{2,5})/g)) literals.push(`--port ${p}`)
    for (const [, p] of block.matchAll(/\s-l[\s=](\d{2,5})/g)) literals.push(`-l ${p}`)
    if (literals.length > 0) {
      findings.push({
        rule: 'fixed-port',
        detail: `the test server is nailed to a fixed port (${literals.join(', ')}); it must come from E2E_PORT so the OS can hand out a free one`,
      })
    }

    // 3. The server must refuse to move if that port is taken. Checked across the whole block,
    //    because a command can be a multi-line ternary (one command for CI, another for a laptop)
    //    and both halves have to be strict.
    for (const { match, flag, name } of STRICT_FLAGS) {
      if (match.test(block) && !block.includes(flag)) {
        findings.push({
          rule: 'no-strict-port',
          detail: `the ${name} command lacks ${flag}, so it slides to another port while Playwright keeps polling this one`,
        })
        break
      }
    }
  }
  return findings
}
