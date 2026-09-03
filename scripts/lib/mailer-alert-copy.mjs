// The subject / headline / lede for the mailer alert, decided from the findings.
//
// WHY THIS IS ITS OWN FILE. A finding whose `what` is 'unaudited' means check-mailer-config.mjs
// could not READ a mailer's send history this run (an outbound HTTP 500, a rotated Postmark or
// Supabase token, a missing access token) - so it could not PROVE that mailer sent. That is NOT a
// proven "cannot send email". On 2026-08-26 the alert rendered two such unaudited findings
// (BackOffice + ChannelMover, both "send history could not be read (outbound HTTP 500)") under the
// subject "2 products cannot send email" and the lede "Customers ... get nothing", turning a
// failure to READ Postmark into a customer-facing outage on the board. Reserve "cannot send email"
// for a proven send/config failure; render an unaudited-only run as exactly that - unaudited.
// Pulled out of send-mailer-alert.mjs so this decision is unit-testable without sending a mail.
//
// THE SAME BUG, ONE LEVEL UP (2026-08-29 board). The guard can also fail to read a project AT ALL
// - a Management-API HTTP 401/403 on the secrets read, or a checkout/clone it could not open. Those
// findings carry `what` = 'the project could not be read' / 'the mailer source could not be read',
// which is NOT the literal 'unaudited' string, so the old classifier swept them into the PROVEN
// bucket and paged "N products cannot send email ... Customers ... get nothing" off a credential
// fault. The 11:50:47Z alert did exactly this: four rows, one reason for all of them ("the project
// could not be read - Supabase Management API: HTTP 401"), yet the alert itself was DELIVERED by
// the very BackOffice mailer it declared dead. A guard that lost its access knows nothing about the
// mailer; it must page UNKNOWN ("the guard lost its access"), never a customer-facing outage.
// Crying outage on a credential fault is how a real outage stops being believed.

const UNAUDITED = 'unaudited'

// The guard was BLIND, not the mailer proven broken: it could not reach the project (a 401/403 on
// the Management API) or read the source at all (a failed checkout/clone). These are the `what`
// strings check-mailer-config.mjs emits for that, and they must be classified as UNKNOWN, never as
// a proven "cannot send email".
const GUARD_BLIND = new Set([
  'the project could not be read',
  'the mailer source could not be read',
])

// THE SAME BUG A THIRD TIME, NOW INVERTED FOR GOOD (2026-09-03 board:
// mailer-guard-dormant-drift-rendered-as-cannot-send). isProven used to be a DEFAULT-PROVEN
// BLOCKLIST (NOT-unaudited AND NOT-blind), so EVERY finding type outside those two named sets
// inherited branch 1 and its customer-outage wording. On 2026-09-03 run 33730188124 the guard had
// exactly one failing row, what='a dormant environment has grown a mailer'
// (check-mailer-config.mjs:382) - STAGING GREW a mailer, the inverse of losing one - yet the mail
// went out as "[MAILERS] Distribution-OS cannot send email ... customers ... get nothing" while the
// same run's table printed that product's production SMTP OK. The two prior fixes (2026-08-26
// unaudited, 2026-09-02 guard-blind) each only added another name to the blocklist, so the next new
// finding type inherited the outage wording again. The blocklist is now an ALLOWLIST: only findings
// that genuinely PROVE a send/transport failure get the "cannot send email" wording. A new finding
// type - or any config-drift observation - DEFAULTS to the non-customer-facing drift wording below.
// Add a name here ONLY when it proves an actual failed or blocked send, never to silence a red.
const PROVEN_SEND_FAILURE = new Set([
  'the mailer is not configured at all',                            // every send throws (arivioo 2026-08-24)
  'part of the mailer configuration is missing',                    // throws, or falls back to a default nobody chose
  'the mail port is not a mail port',                               // PORT hashes to no known mail port
  'implicit TLS on a port that does not speak it',                  // handshake fails on every send (BackOffice 2026-08-20)
  'a host with no implicit-TLS listener, on the implicit-TLS port', // connection times out
  'an implicit-TLS client pointed at a host that has no implicit-TLS listener',
  'its Postmark server is gone',                                    // no sending unit exists
  'it has never sent anything',                                     // declared sending, zero in the retention window
  'it has sent nothing recently',                                   // past the silence window this product is allowed
])

const isBlind = (f) => GUARD_BLIND.has(f.what)
const isUnaudited = (f) => f.what === UNAUDITED
const isProven = (f) => PROVEN_SEND_FAILURE.has(f.what)
// DRIFT: a real thing the guard SAW and wants reconciled (a dormant env that grew a mailer, a second
// reader of another mailer's variables, a stale baseline entry) that does NOT prove a send failed.
// Not proven, not unaudited, not blind. It pages amber with config-drift wording, never "cannot
// send email" - and it is the default bucket for any finding type not named in the allowlist above.
const isDrift = (f) => !isProven(f) && !isUnaudited(f) && !isBlind(f)

// AND THE SAME BUG ONE LEVEL UP AGAIN (2026-08-26 board finding, applied 2026-09-02). "Unaudited"
// is amber because it is a MINORITY report: some products could not be read, the rest were, so the
// guard still proved something. When EVERY declared product comes back unaudited, that reading is
// exactly wrong - the guard proved NOTHING about the fleet's email this run, which is the same
// blindness the guard-broken path already pages red for. Amber plus "Reserve action for a run that
// names a proven send failure" then tells Roger to stand down from the one run that most needs a
// look. So the classifier now needs to know how big the fleet IS: pass `fleetProducts` (the count
// of DECLARED products the run audited, from the report's own rows) and an all-or-nearly-all
// unaudited run goes red with guard-broken wording. An isolated minority stays amber, unchanged.
const NEARLY_ALL = 0.8

/**
 * @param {{product:string, env:string, what:string, detail:string}[]} failures
 * @param {{fleetProducts?: number}} [options] fleetProducts = how many declared products this run
 *   audited. Omitted (0) keeps the pre-2026-09-02 behaviour: an unaudited-only run reads amber.
 * @returns {{colour:string, subject:string, title:string, lede:string}}
 */
export function classifyMailerAlert(failures, options = {}) {
  const fleetProducts = Number(options.fleetProducts) || 0
  const provenProducts = [...new Set(failures.filter(isProven).map((f) => f.product))]
  const unauditedProducts = [...new Set(failures.filter(isUnaudited).map((f) => f.product))]
  const blindProducts = [...new Set(failures.filter(isBlind).map((f) => f.product))]
  const driftProducts = [...new Set(failures.filter(isDrift).map((f) => f.product))]

  // 1. At least one PROVEN failure -> a real outage. Name the proven products in the subject and
  // keep the customer-facing lede; note any unproven ones (unaudited or guard-blind) in the
  // headline so they are not lost.
  if (provenProducts.length) {
    const plural = provenProducts.length > 1 ? 's' : ''
    const parts = []
    if (unauditedProducts.length) parts.push(`${unauditedProducts.length} unaudited`)
    if (blindProducts.length) parts.push(`${blindProducts.length} the guard could not read`)
    if (driftProducts.length) parts.push(`${driftProducts.length} config drift`)
    const extra = parts.length ? ` (plus ${parts.join(', ')})` : ''
    return {
      colour: '#dc2626',
      subject: `[MAILERS] ${provenProducts.join(', ')} cannot send email`,
      title: `${provenProducts.length} product${plural} cannot send email${extra}`,
      lede: 'Customers hitting signup, a password reset or a support reply on these products get nothing. This is the failure that ran for four days in August 2026 before anyone noticed.',
    }
  }

  // 2. No proven failure, but the guard LOST ITS ACCESS to one or more projects: it knows nothing
  // about whether those mailers can send. This is UNKNOWN, not an outage. It must never say "cannot
  // send email" or "get nothing"; it pages Roger to fix the guard's access, not the product.
  if (blindProducts.length) {
    const plural = blindProducts.length > 1 ? 's' : ''
    const extra = unauditedProducts.length ? ` (plus ${unauditedProducts.length} unaudited)` : ''
    return {
      colour: '#d97706',
      subject: `[MAILERS] the guard lost access to ${blindProducts.join(', ')} - email status UNKNOWN`,
      title: `${blindProducts.length} product${plural}: the guard lost its access - email status UNKNOWN${extra}`,
      lede: `This is NOT a "cannot send email" notice. The guard could not read ${plural ? 'these projects' : 'this project'} this run (a Supabase Management API HTTP 401/403, or a checkout it could not open), so whether ${plural ? 'they can' : 'it can'} send is UNKNOWN - not proven to have failed. This is a credential/access fault in the GUARD, not a product outage: refresh the guard's access (the expired/rotated token) and re-run.`,
    }
  }

  // 3. Only unaudited findings: the send history could not be READ, which is not the same as a
  // proven send failure. This is amber, not red, and must never say "cannot send email"...
  const plural = unauditedProducts.length > 1 ? 's' : ''

  // ...UNLESS it is the WHOLE FLEET. Nothing was read, so nothing was proved, and calling that
  // amber - and then telling Roger to reserve action - is a guard reporting its own blindness as
  // reassurance. Still never "cannot send email": no send was proven to have failed. It is red
  // because the WATCH is down, and the wording says so.
  if (fleetProducts > 0 && unauditedProducts.length >= fleetProducts * NEARLY_ALL) {
    const allOfThem = unauditedProducts.length >= fleetProducts
    return {
      colour: '#dc2626',
      subject: `[MAILERS] send history unreadable for ${allOfThem ? 'EVERY' : 'nearly every'} product - nothing is confirming product email`,
      title: `${unauditedProducts.length} of ${fleetProducts} product${fleetProducts > 1 ? 's' : ''} unaudited - this run proved nothing about the fleet's email`,
      lede: `This is NOT a "cannot send email" notice - no send was proven to have failed. It is worse than one product going quiet: the send history could not be read for ${allOfThem ? 'any product at all' : 'nearly the whole fleet'}, so right now nothing is confirming that the fleet's email is arriving. That is the guard itself being down (a rotated Postmark or Supabase token, or an upstream HTTP 500), and it needs fixing before the next real outage has nobody watching it.`,
    }
  }

  // 4. No proven failure, the guard could see fine, and it is not an all-fleet blind spot - but the
  // guard SAW something that needs reconciling and is NOT a send failure: a dormant environment that
  // grew a mailer, a second reader of another mailer's variables, a baseline entry gone stale. This
  // is config drift. It is amber and it names the drift; it must NEVER say "cannot send email" or
  // "customers get nothing" - as far as this run proved, the mailer it is talking about is sending
  // fine. This is the branch a dormant-drift-only run now lands in, instead of inheriting branch 1's
  // customer-outage wording off a default-proven blocklist (2026-09-03 board).
  if (driftProducts.length) {
    const plural = driftProducts.length > 1 ? 's' : ''
    const reasons = [...new Set(failures.filter(isDrift).map((f) => f.what))]
    const extra = unauditedProducts.length ? ` (plus ${unauditedProducts.length} unaudited)` : ''
    return {
      colour: '#d97706',
      subject: `[MAILERS] mailer config drift on ${driftProducts.join(', ')} - not a send failure`,
      title: `${driftProducts.length} product${plural} with mailer config drift: ${reasons.join('; ')}${extra}`,
      lede: `This is NOT a "cannot send email" notice - no send was proven to have failed. The guard found the mailer configuration no longer matches the recorded baseline (${reasons.join('; ')}). As far as this run proved, the mailer${plural ? 's are' : ' is'} sending fine; this is a baseline-vs-deployment drift to reconcile, not a customer-facing outage. Update the baseline if the change is intended, or undo the change if it is not.`,
    }
  }

  return {
    colour: '#d97706',
    subject: `[MAILERS] ${unauditedProducts.join(', ')} unaudited - could not confirm email is being sent`,
    title: `${unauditedProducts.length} product${plural} unaudited - send history could not be read`,
    lede: `This is NOT a "cannot send email" notice. For the product${plural} below the send history could not be read this run (an outbound HTTP 500, a rotated token, or a missing access token), so whether ${plural ? 'they have' : 'it has'} actually sent is UNVERIFIED - not proven to have failed. Reserve action for a run that names a proven send failure.`,
  }
}
