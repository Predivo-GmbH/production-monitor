// Where a heartbeat's ping URL comes from.
//
// It used to be a literal `https://hc-ping.com/<uuid>` in the source. This repo is PUBLIC, so
// that URL was world-readable, and a healthchecks ping URL needs no authentication: anyone who
// read it could ping it on a schedule and hold the check GREEN over a dead automation, or ping
// /fail and manufacture an outage. A dead-man's switch that a stranger can hold down is not a
// dead-man's switch. Four of them were exposed this way; all four uuids were rotated 2026-08-27
// and the old ones are now inert.
//
// So the URL lives in `~/.claude/scripts/hc-config.json` under `ping_urls`, keyed by check slug.
// That file is machine-local, is in no git worktree, and is already named in backup-credentials.sh
// so it rides the encrypted offsite bundle. Plaintext local, encrypted offsite, never in a repo.
//
// FAILURE DIRECTION IS DELIBERATE. If the file or the key is missing this returns null and the
// caller SKIPS the ping, which makes the check go DOWN and email us. It must never fall back to
// a hardcoded URL: a fallback would turn a broken config into a silent green, which is the exact
// failure the heartbeat exists to catch.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function pingUrl(slug) {
  const p = join(homedir(), '.claude', 'scripts', 'hc-config.json')
  try {
    const cfg = JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
    const url = cfg.ping_urls?.[slug]
    if (!url) {
      console.error(`::heartbeat:: no ping_urls["${slug}"] in ${p} - NOT pinging, so the check will go DOWN and alert`)
      return null
    }
    return url
  } catch (e) {
    console.error(`::heartbeat:: cannot read ${p} (${e.message}) - NOT pinging, so the check will go DOWN and alert`)
    return null
  }
}
