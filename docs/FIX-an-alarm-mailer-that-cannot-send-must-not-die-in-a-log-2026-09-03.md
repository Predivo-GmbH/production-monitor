# The monitor found problems and could not email you — 2026-09-03

## What happened

At `2026-09-02T23:38Z` the hourly monitor detected 4 failures. Six minutes later, at
`23:44:18Z` in run `33695562762`, `scripts/send-alert.mjs` tried to tell Roger and got:

```
Invalid login: 535 5.7.8
```

`send-alert.mjs` ended in a bare, unguarded `await transporter.sendMail(...)`. The rejection
killed the process, the step went red inside a job that was **already red**, and nothing else
happened.

**The failure was detected and the notification died.** The only record was a line in a log
nobody opens.

## Root cause, and the part that was not previously connected

The monitor's mail account is on Metanet — `tertia.sui-inter.net`. Two things on **the same
server** stopped accepting **the same kind of credential** within hours of each other:

| Service | Port | Symptom | First seen |
|---|---|---|---|
| IMAP (the monitor's OTP test mailbox) | 993 | `AUTHENTICATIONFAILED` | 2026-09-02 ~20:18Z |
| SMTP (`send-alert.mjs`, `noreply@backoffice.predivo.ch`) | 465 | `535 5.7.8` | 2026-09-02 23:44Z |

Every OTP spec pins the host explicitly — `tests/backoffice/production-monitor.spec.ts:18`,
`tests/replyflow/…:21`, `tests/signalscore/…:19`, `tests/valrano/…:18`,
`tests/ytmigration/…:19` all read `process.env.IMAP_HOST || 'tertia.sui-inter.net'`. So the
mailbox that four OTP tests cannot read and the account that cannot send the alert about it are
on one box.

**Probed live 2026-09-03T01:29Z from this host** — the server is emphatically *not* down:

```
A     80.74.145.155        AAAA 2a00:1128:1:1::145:155
:993  Dovecot ready.                       (75 ms)
:465  220 tertia2.sui-inter.net ESMTP Postfix (136 ms)
:587  tcp-open      :143  tcp-open
```

This **corrects** the board note on `closer-mailer-on-dead-metanet-smtp-2026-09-02`, which
recorded "the host is unreachable from here" at 22:13Z. It is reachable now and both daemons
answer. The server is alive and serving; it is **the accounts** that are being refused.

Two different mailboxes on one server refusing passwords nobody changed is provider-side and
account-level — not a per-mailbox lockout, and not something a password reset is known to fix.

## What was fixed (and what was not)

Restoring the mail account needs Roger. **Making the alarm audible did not**, and that is what
this change does.

`scripts/lib/alert-fallback.mjs` (new) — `sendOrEscalate()`. If the send fails, the alarm is
filed to the signals board instead, and the call **still throws** so the step stays red.

Why the board is a genuinely different pipe, verified this turn rather than assumed:

- `signal_page_policy` has `production-monitor` `may_page=true` (read live `01:30Z`).
- A page to Roger's address matches **none** of BackOffice's `TEST_RECIPIENT_PATTERNS`
  (`_shared/email.ts:86-90` — `@backoffice-test.local`, `+e2e@`, `pmverify-`), so it takes the
  **Postmark HTTP** branch at `email.ts:126-133`, not the Metanet SMTP branch at `:152`.
  The dead account is not in that path at all.

Design points that matter:

- The **content survives**, not just the fact of failure — the failures the email would have
  reported are embedded in the signal, because a link is something you have to go and open and
  the push channel is precisely what is down.
- `severity: critical` **and** `needs_human: true`. `check-alarm-reachability.mjs` treats
  critical-with-`needs_human=false` as a contradiction it files a separate alarm about; a signal
  saying "you are not being told things" that cannot itself tell anyone is the joke.
- Transport construction is **inside** the guard. `createMailTransport` pins the MX A record, so
  DNS/connect failures throw before `sendMail` is ever reached — just as undeliverable.
- If the board write **also** fails, both errors are reported and it still throws. A fallback
  that returns success because it caught something is the bug, not the fix.
- Secret values are redacted from every string before it reaches a log or the board.

## Two bugs the tests caught in my own fix

1. **A leak through the other hand.** The first version scrubbed the prose and then attached the
   raw failures array to `detail`, putting the credential straight back on the board. Caught by
   the leak test, not by reading it.

2. **A vacuous ratchet — the repeat offence.** The first ratchet asked
   `/try\s*{[\s\S]*?\.sendMail/`. `[\s\S]*?` spans the whole file, so any unrelated `try {` near
   the top made every mailer look guarded. **It reported zero violations on a tree that had
   eight.** This is the same shape as the 2026-09-02 alarm-step probe that "found" nothing.
   Replaced with a brace scanner (`sendMailCallSites`), proven both ways on injected fixtures
   *before* being trusted on the real tree — including the exact false-positive shape that fooled
   v1.

## Known debt, frozen and named

The honest ratchet reports **13 mailers, 8 unguarded**. `send-alert.mjs` — the one that actually
failed — is fixed. These eight are not, because each also needs a board credential wired into its
own workflow, and doing eight of those blind in one unattended run is how you break the alerting
you are trying to repair:

```
send-automation-alert.mjs     send-automation-resolved.mjs
send-ci-runner-alert.mjs      send-dashboard-alert.mjs
send-drift-alert.mjs          send-heartbeat-alert.mjs
send-mailer-alert.mjs         send-resolved.mjs
```

`test/alert-fallback.test.mjs` asserts **set equality**, not "no new ones": a name that gets
fixed must leave the list, so it cannot rot into an allowlist that excuses everything.

Also still true and not fixed here: `check-mailer-config.mjs` ran **green** 9 minutes after the
alert died (`23:51:03Z`, "All declared mailers OK") because its scope is the 8 products'
edge-function secrets. It has **zero coverage of the fleet's own alarm mailers, by construction.**

## Verification

- `node test/alert-fallback.test.mjs` → **23 passed**
- All suites: `for f in test/*.test.mjs` → **52 passed, 0 failed**
- `node --check` on both changed scripts; imports resolve.
- Escalation logic proven with an injected `fetch`. The signal body uses the same shape
  `check-alarm-reachability.mjs` posted successfully to `signal-intake` at `01:23:21Z` this run.
  **Not** proven end-to-end against live `signal-intake`: doing so would file a fabricated alarm
  on the production board. The natural end-to-end exercise will not fire while the failure set is
  unchanged either, because `send-alert.mjs` suppresses duplicate alerts *before* it attempts a
  send — which is also why no email has been attempted since 23:44Z.

## The keeper

**A fallback channel is only a fallback if it is a different pipe, and that has to be proven, not
assumed.** SMTP and the board looked like one alerting system; only one of them was broken. The
reason this sat unseen is the other half: the alarm that says "you are not being told things" was
itself an email.
