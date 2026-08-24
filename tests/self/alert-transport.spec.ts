import { test, expect } from '@playwright/test';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Guards the monitor's own alerting path.
 *
 * On 2026-08-24 the monitor caught a 33-test production failure and then could not
 * report it: `Send alert on failure` died with
 *   Error: connect ENETUNREACH 2a00:1128:1:1::145:155:465
 * GitHub-hosted runners have no IPv6 egress, our SMTP host publishes both an A and an
 * AAAA record, and nodemailer 8 resolves both then picks one AT RANDOM — so every alert
 * was a coin flip. The pre-existing `family: 4` option on all 8 senders did nothing:
 * SMTPConnection.connect() rebuilds its options object and never copies `family`.
 *
 * A silently-ignored option looks exactly like a working fix, which is why this is a
 * static guard and not a "we sent an email once and it worked" check.
 */

const SCRIPTS_DIR = join(process.cwd(), 'scripts');

function scriptSources(): { name: string; src: string }[] {
  return readdirSync(SCRIPTS_DIR)
    .filter((f) => f.endsWith('.mjs'))
    .map((name) => ({ name, src: readFileSync(join(SCRIPTS_DIR, name), 'utf-8') }));
}

test.describe('Alerting — SMTP transport', () => {
  test('no script builds a nodemailer transport directly', () => {
    const offenders = scriptSources()
      .filter(({ src }) => /createTransport\s*\(/.test(src))
      .map(({ name }) => name);

    expect(
      offenders,
      `These scripts call nodemailer.createTransport() directly and will resolve the SMTP ` +
        `host to a random A/AAAA address — on a GH runner that is a coin flip between ` +
        `working and ENETUNREACH. Use createMailTransport() from scripts/lib/smtp.mjs.`,
    ).toEqual([]);
  });

  test('no script passes the silently-ignored `family` option', () => {
    const offenders = scriptSources()
      .filter(({ src }) => /^\s*family:\s*\d/m.test(src))
      .map(({ name }) => name);

    expect(
      offenders,
      `nodemailer ignores \`family\` (SMTPConnection.connect() never copies it), so this ` +
        `reads as an IPv4 pin while doing nothing. Pin IPv4 by resolving the A record instead.`,
    ).toEqual([]);
  });

  test('every mail-sending script routes through lib/smtp.mjs', () => {
    const offenders = scriptSources()
      .filter(({ name, src }) => name !== 'lib' && /\.sendMail\s*\(/.test(src))
      .filter(({ src }) => !/createMailTransport/.test(src))
      .map(({ name }) => name);

    expect(offenders, 'Scripts that sendMail() must obtain their transport from lib/smtp.mjs')
      .toEqual([]);
  });

  test('an IP literal host is passed through untouched and needs no SNI override', async () => {
    const { createMailTransport, resolveIPv4 } = await import('../../scripts/lib/smtp.mjs');

    expect(await resolveIPv4('80.74.145.155')).toBe('80.74.145.155');

    const t = await createMailTransport({
      host: '80.74.145.155', port: 465, user: 'u', pass: 'p',
    });
    expect(t.options.host).toBe('80.74.145.155');
    expect(t.options.secure).toBe(true);
    expect(t.options.servername).toBeUndefined();
  });

  test('a hostname is pinned to its IPv4 address with SNI preserved', async () => {
    const { createMailTransport, resolveIPv4 } = await import('../../scripts/lib/smtp.mjs');

    const host = process.env.SMTP_HOST || 'tertia.sui-inter.net';
    const resolved = await resolveIPv4(host);

    // Fail-open: resolveIPv4 returns the input when DNS is unreachable. That is a broken
    // network, not a broken transport — skip rather than cry wolf (same rule as the
    // keepalive/nightly-gauntlet specs).
    test.skip(resolved === host, `DNS unavailable for ${host} — cannot assert the IPv4 pin`);

    const t = await createMailTransport({ host, port: 465, user: 'u', pass: 'p' });
    expect(t.options.host, 'transport must receive a literal IPv4 address, never a hostname')
      .toMatch(/^\d{1,3}(\.\d{1,3}){3}$/);
    expect(t.options.servername, 'SNI/cert validation must still target the real hostname')
      .toBe(host);
  });
});
