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

const UNAUDITED = 'unaudited'

/**
 * @param {{product:string, env:string, what:string, detail:string}[]} failures
 * @returns {{colour:string, subject:string, title:string, lede:string}}
 */
export function classifyMailerAlert(failures) {
  const proven = failures.filter((f) => f.what !== UNAUDITED)
  const unaudited = failures.filter((f) => f.what === UNAUDITED)
  const provenProducts = [...new Set(proven.map((f) => f.product))]
  const unauditedProducts = [...new Set(unaudited.map((f) => f.product))]

  // At least one PROVEN failure -> a real outage. Name the proven products in the subject and
  // keep the customer-facing lede; note any unaudited ones in the headline so they are not lost.
  if (provenProducts.length) {
    const plural = provenProducts.length > 1 ? 's' : ''
    const extra = unauditedProducts.length
      ? ` (plus ${unauditedProducts.length} unaudited)`
      : ''
    return {
      colour: '#dc2626',
      subject: `[MAILERS] ${provenProducts.join(', ')} cannot send email`,
      title: `${provenProducts.length} product${plural} cannot send email${extra}`,
      lede: 'Customers hitting signup, a password reset or a support reply on these products get nothing. This is the failure that ran for four days in August 2026 before anyone noticed.',
    }
  }

  // Only unaudited findings: the send history could not be READ, which is not the same as a proven
  // send failure. This is amber, not red, and must never say "cannot send email" or "get nothing".
  const plural = unauditedProducts.length > 1 ? 's' : ''
  return {
    colour: '#d97706',
    subject: `[MAILERS] ${unauditedProducts.join(', ')} unaudited - could not confirm email is being sent`,
    title: `${unauditedProducts.length} product${plural} unaudited - send history could not be read`,
    lede: `This is NOT a "cannot send email" notice. For the product${plural} below the send history could not be read this run (an outbound HTTP 500, a rotated token, or a missing access token), so whether ${plural ? 'they have' : 'it has'} actually sent is UNVERIFIED - not proven to have failed. Reserve action for a run that names a proven send failure.`,
  }
}
