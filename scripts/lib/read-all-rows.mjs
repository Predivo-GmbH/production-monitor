/**
 * READ EVERY ROW, OR SAY SO. A capped read with no order is a silent, arbitrary sample.
 *
 * Ported into production-monitor from the fleet original (Cockpit scripts/lib/read-all-rows.mjs,
 * commit 6652a9a, 2026-09-03) so the board drainer and the board measurers stop naming a `limit`
 * above the PostgREST 1000-row ceiling.
 *
 * ══ WHY ═══════════════════════════════════════════════════════════════════════════════════════
 *
 * Measured live against xoecpzfsskalvjrtcbbl on 2026-09-03: this project hard-caps a PostgREST
 * request at 1000 rows. `work_evidence?select=id&limit=5000` returned exactly 1000, HTTP 200,
 * Content-Range 0-999/*, with NO error and nothing in the response saying rows were dropped.
 * So a `limit=2000`/`limit=5000` read is a silent, arbitrary 1000-row sample the moment the table
 * crosses 1000 rows — and `fleet_signals` grew 659 → 731 in a single day. `board-drainer.mjs`
 * asked `fleet_signals?...&limit=2000` and treated the answer as "EVERY signal, in every state";
 * `measure-the-board.mjs` and `the-monthly-no.mjs` asked `work_items?...&limit=5000` and computed
 * board gates over whatever 1000 rows came back.
 *
 * So: page until the server returns a short page, ordered on a UNIQUE column so pages cannot
 * overlap or skip, and THROW rather than return a truncated sample quietly.
 */

/** PostgREST's own ceiling per request. Asking for more than this silently returns less. */
const PAGE = 1000

/**
 * Make an order TOTAL by ending it in a unique column, so no two rows can tie and no page boundary
 * can fall inside a tie group. A no-op when the caller already named that column, or opted out.
 */
export function withTiebreak(order, unique = 'id') {
  const terms = String(order || '').split(',').map((s) => s.trim()).filter(Boolean)
  if (!unique) return terms.join(',')
  if (terms.some((t) => t.split('.')[0] === unique)) return terms.join(',')
  const dir = /\.desc$/i.test(terms[terms.length - 1] || '') ? 'desc' : 'asc'
  return [...terms, `${unique}.${dir}`].join(',')
}

/**
 * @param {(path: string) => Promise<any[]>} rest   the caller's REST reader (injected, so this is testable offline)
 * @param {string} path   a PostgREST path WITHOUT limit/offset, e.g. 'fleet_signals?select=*'
 * @param {object} [opts]
 * @param {string} [opts.order]     the ordering column(s); a unique tiebreaker is appended for you
 * @param {string} [opts.unique]    the unique column that makes the order total (null to opt out)
 * @param {number} [opts.maxRows]   refuse (throw) rather than truncate beyond this
 * @param {number} [opts.page]      page size, for tests
 * @returns {Promise<any[]>} every row, in `order`
 */
export async function readAllRows(rest, path, { order = 'id.asc', unique = 'id', maxRows = 20000, page = PAGE } = {}) {
  if (typeof rest !== 'function') throw new Error('readAllRows needs a rest reader')
  if (/[?&](limit|offset)=/.test(path)) {
    // A caller that already caps is the bug this exists to remove; refuse rather than fight it.
    throw new Error(`readAllRows was given a path that already caps itself (${path}). Remove the limit/offset — paging is this function's job.`)
  }
  const sep = path.includes('?') ? '&' : '?'
  const ordered = withTiebreak(order, unique)
  const out = []
  for (let offset = 0; ; offset += page) {
    if (offset >= maxRows) {
      throw new Error(`readAllRows refused to keep paging past ${maxRows} rows on "${path}". That is not a limit to raise casually — it means something is producing rows faster than anything is consuming them, and returning the first ${maxRows} would be an arbitrary sample presented as the whole set.`)
    }
    const chunk = (await rest(`${path}${sep}order=${encodeURIComponent(ordered)}&limit=${page}&offset=${offset}`)) || []
    out.push(...chunk)
    // A short page means the end. Only an exactly-full page can hide more.
    if (chunk.length < page) return out
  }
}
