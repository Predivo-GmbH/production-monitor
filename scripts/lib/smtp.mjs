import net from 'node:net'
import { promises as dns } from 'node:dns'

/**
 * Resolve a hostname to a single IPv4 address.
 * Returns the input unchanged if it is already an IP, or if the A lookup fails —
 * a degraded send attempt beats no send attempt at all.
 */
export async function resolveIPv4(host) {
  if (!host || net.isIP(host)) return host
  try {
    const [addr] = await dns.resolve4(host)
    return addr || host
  } catch {
    return host
  }
}

/**
 * Build an SMTP transport pinned to IPv4.
 *
 * GitHub-hosted runners have no IPv6 egress. Our SMTP host publishes BOTH an A and an
 * AAAA record (tertia.sui-inter.net -> 80.74.145.155 / 2a00:1128:1:1::145:155), and
 * nodemailer 8 resolves both, concatenates them, then picks one AT RANDOM
 * (lib/shared/index.js, formatDNSValue). So roughly every other alert died with
 * `connect ENETUNREACH 2a00:1128:1:1::145:155` — including the 33-failure run on
 * 2026-08-24, where the monitor detected the outage and then could not report it.
 *
 * The obvious `family: 4` transport option does NOT fix this: SMTPConnection.connect()
 * rebuilds its options object from scratch and never copies `family`
 * (lib/smtp-connection/index.js:258). It was set on all 8 senders and did nothing.
 *
 * So resolve the A record here and hand nodemailer a literal IPv4 address —
 * resolveHostname() short-circuits on net.isIP(host) and skips its own lookup entirely.
 * `servername` keeps SNI *and* certificate validation pointed at the real hostname
 * (Node checks the cert against options.servername in preference to options.host).
 */
export async function createMailTransport({ host, port, user, pass }) {
  const { createTransport } = await import('nodemailer')
  const address = await resolveIPv4(host)
  return createTransport({
    host: address,
    port: Number(port || 465),
    secure: true,
    ...(address === host ? {} : { servername: host }),
    auth: { user, pass },
  })
}
