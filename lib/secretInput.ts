import type { Frame, Locator, Page } from '@playwright/test'

/**
 * TYPING A SECRET INTO A FORM PUTS IT IN THE DOM, AND PLAYWRIGHT PUBLISHES THE DOM ON FAILURE.
 *
 * ── THE INCIDENT (2026-09-01) ───────────────────────────────────────────────────────────────
 *
 * tests/jass-tour/user-password-login.spec.ts typed the monitor account's real password into
 * Jass-Tour's login form. The sign-in failed against production, and Playwright did what it does
 * for every failed test: it wrote test-results/<test>/error-context.md, an accessibility snapshot
 * of the page at the moment of failure. That snapshot contained the line
 *
 *     - textbox "Passwort" [ref=e27]: <the account's real password, in plaintext>
 *
 * and monitor.yml's actions/upload-artifact step published the whole test-results/ directory as a
 * downloadable CI artifact. The artifacts have been deleted and the secret rotated.
 *
 * ── WHY THE EXISTING MITIGATION DID NOT STOP IT, WHICH IS THE WHOLE POINT ────────────────────
 *
 * Both password-typing specs already carried `test.use({ trace: 'off' })`, added precisely to
 * keep a credential out of the uploaded artifact, and both carried a comment explaining that
 * screenshots were safe because a password field renders as dots. Both statements were true. The
 * leak happened anyway, because THE ERROR-CONTEXT ATTACHMENT IS NEITHER OF THOSE THINGS. It is a
 * third artifact, written on every failure regardless of the trace and screenshot settings, and
 * it records the accessibility tree, in which a password input's contribution is its VALUE.
 *
 * So the defence cannot be a list of recording channels to switch off. There is no way to know
 * that the list is complete, and the list was not complete. The only defence that does not depend
 * on enumerating Playwright's outputs is this:
 *
 *     THE SECRET MUST NOT BE SITTING IN THE DOM AT A MOMENT WHEN AN ASSERTION CAN FAIL.
 *
 * That is what this module is for. submitSecret() hands the value to the form and takes it back
 * out again in the same breath, so the window in which any recorder could capture it is the few
 * milliseconds the app itself needs to read it, not the remainder of the test.
 *
 * ── WHAT THIS IS NOT ────────────────────────────────────────────────────────────────────────
 *
 * This is a mitigation for the case where typing the secret IS the thing under test, which is
 * true for exactly one product in this repo: BoatBuddy's site password gate is that product's
 * entire login, so a monitor that refuses to type it is a monitor that checks nothing. Where the
 * credential can be proved without a form at all, that is strictly better and it is what
 * tests/jass-tour/user-password-login.spec.ts now does. Reach for this helper only when the form
 * is the claim.
 */

/** Every frame of the page, so an input inside an iframe is not quietly exempt. */
function framesOf(page: Page): Frame[] {
  try {
    return page.frames()
  } catch {
    return []
  }
}

/**
 * Empties every password input in every frame, and tells the framework about it.
 *
 * Assigning `input.value = ''` on a React-controlled input changes the DOM node and nothing else:
 * React's state still holds the old string, and the very next render puts it straight back. The
 * value has to go through the prototype's native setter (which is what React's own change
 * tracking watches) and then be announced with a bubbling `input` event, which is how a real
 * keystroke reaches a React onChange handler. Vue and Svelte listen for the same event.
 *
 * Never throws. A destroyed execution context means the document that held the value is already
 * gone, which is the outcome this function exists to produce.
 */
async function blankPasswordFields(page: Page): Promise<void> {
  for (const frame of framesOf(page)) {
    try {
      await frame.evaluate(() => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
        for (const el of Array.from(document.querySelectorAll('input[type="password"]'))) {
          const input = el as HTMLInputElement
          if (!input.value) continue
          if (setter) setter.call(input, '')
          else input.value = ''
          input.dispatchEvent(new Event('input', { bubbles: true }))
          input.dispatchEvent(new Event('change', { bubbles: true }))
        }
      })
    } catch {
      /* frame detached, navigated or closed: the value went with the document. */
    }
  }
}

/**
 * Fills `field` with `value`, clicks `submit`, and blanks every password input on the page before
 * returning. The blanking is in a `finally`, so it happens even when the fill or the click throws
 * — a failed click is exactly the case where a failure artifact is about to be written, and it is
 * the case a `try` alone would miss.
 *
 * The secret is safe to hand over at submit time because a form handler reads it synchronously
 * from the closure or from React state before its first `await` (BoatBuddy's PasswordGate does
 * `const inputHash = await sha256(password)` on a `password` already captured by the render), so
 * clearing the field afterwards cannot change what the app compares.
 *
 * `value` is never returned, logged, or put in an error message by anything in this module.
 */
export async function submitSecret(
  page: Page,
  field: Locator,
  value: string,
  submit: Locator,
): Promise<void> {
  try {
    await field.fill(value)
    await submit.click()
  } finally {
    await blankPasswordFields(page)
  }
}

/**
 * Throws unless every password input on the page is empty, so a caller can PROVE the window is
 * closed rather than trust that it is. Use it immediately after submitSecret() in any test that
 * goes on to make assertions which could fail while the form is still on screen.
 *
 * The message names the offending field by its label and never mentions its content — not the
 * value, and not the length, which is itself worth knowing to an attacker and would otherwise end
 * up in the same failure artifact this whole module exists to keep clean.
 */
export async function assertNoSecretInDom(page: Page): Promise<void> {
  const offenders: string[] = []
  for (const frame of framesOf(page)) {
    let held: string[] = []
    try {
      held = await frame.evaluate(() =>
        Array.from(document.querySelectorAll('input[type="password"]'))
          .map((el, i) => {
            const input = el as HTMLInputElement
            if (!input.value) return ''
            const name =
              input.getAttribute('aria-label') ||
              input.getAttribute('name') ||
              input.getAttribute('placeholder') ||
              input.id ||
              `input[type=password] #${i + 1}`
            return name
          })
          .filter((name) => name !== ''),
      )
    } catch {
      /* frame gone: nothing can be holding a value in a document that no longer exists. */
    }
    offenders.push(...held)
  }
  if (offenders.length > 0) {
    throw new Error(
      'A password field is still holding a value. Playwright writes the page\'s accessibility ' +
        'tree into test-results/<test>/error-context.md on every failure, and a password input ' +
        'contributes its VALUE to that tree, so any assertion failing from here would publish ' +
        'the credential into the uploaded CI artifact. Fields still holding: ' +
        offenders.join(', '),
    )
  }
}
