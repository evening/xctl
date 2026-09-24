import type { Page } from 'playwright-core';
import { config } from './config.js';
import { recentPinFailures, recordPinAttempt } from './db.js';
import { XctlError } from './errors.js';
import { log } from './log.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Inputs that make up the XChat unlock prompt. Kept in one place so page.ts and this file agree. */
export const PIN_INPUT_SELECTOR =
  '[data-testid="pin-code-input-container"] input, input[type="password"], input[autocomplete="one-time-code"], input[inputmode="numeric"], input[aria-label^="Digit " i]';

type UnlockState = 'unlocked' | 'locked' | 'error';

async function state(page: Page): Promise<UnlockState> {
  return page
    .evaluate(sel => {
      const ready = !!document.querySelector('[data-testid="dm-inbox-panel"], [data-testid="dm-message-scroller"], [data-testid="dm-message-requests"]');
      const input = document.querySelector(sel) || document.querySelector('[data-testid="pin-code-input-container"], [data-testid="pin-title"]');
      if (ready && !input && !/^\/i\/chat\/pin(\/|$)/.test(location.pathname)) return 'unlocked';
      const text = (document.body.innerText || '').slice(0, 5000);
      if (/incorrect|wrong (pin|passcode|code)|invalid (pin|passcode|code)|try again|attempts? (left|remaining)/i.test(text)) return 'error';
      return 'locked';
    }, PIN_INPUT_SELECTOR)
    .catch(() => 'locked' as const);
}

/**
 * Enter XCTL_XCHAT_PIN into the XChat unlock prompt, exactly once. Throws XCHAT_PIN_REJECTED if XChat
 * does not unlock. The PIN is never logged or put into error messages.
 */
export async function unlockWithPin(page: Page): Promise<void> {
  const pin = config.xchatPin;
  if (!pin) throw new XctlError('XCHAT_LOCKED', 'XChat is locked and XCTL_XCHAT_PIN is not set; unlock it in the browser or set XCTL_XCHAT_PIN');
  if (!/^\d{4,12}$/.test(pin)) throw new XctlError('INVALID_ARGS', 'XCTL_XCHAT_PIN must be 4-12 digits');
  const failures = recentPinFailures();
  if (failures >= config.pinMaxFailuresPerHour) {
    throw new XctlError(
      'XCHAT_PIN_REJECTED',
      `not entering the PIN: it was rejected ${failures} time(s) in the last hour (XCTL_PIN_MAX_FAILURES). Fix XCTL_XCHAT_PIN or unlock XChat by hand.`,
      { pin_attempted: false },
    );
  }
  const specific = page.locator('[data-testid="pin-code-input-container"] input');
  const inputs = (await specific.count()) ? specific : page.locator(PIN_INPUT_SELECTOR);
  const n = await inputs.count();
  if (!n) throw new XctlError('SELECTOR_NOT_FOUND', 'XChat unlock prompt has no PIN input');
  log(`entering XChat PIN (${n} input field(s))`);
  if (n > 1 && n === pin.length) {
    // One box per digit.
    for (let i = 0; i < n; i++) await inputs.nth(i).fill(pin[i], { timeout: 5_000 });
  } else {
    // A single field, or boxes that auto-advance: type into the first one like a person would.
    await inputs.first().click({ timeout: 5_000 });
    await page.keyboard.type(pin, { delay: 60 });
  }
  // Some prompts need an explicit submit; press Enter only if a submit button is still enabled.
  await sleep(600);
  if ((await state(page)) === 'locked') {
    const submit = page.locator('[role="dialog"] button[type="submit"], main button[type="submit"]').first();
    if ((await submit.count()) && (await submit.isEnabled().catch(() => false))) await submit.click({ timeout: 3_000 }).catch(() => {});
  }
  const deadline = Date.now() + 15_000;
  let st: UnlockState = 'locked';
  while (Date.now() < deadline) {
    st = await state(page);
    if (st !== 'locked') break;
    await sleep(400);
  }
  if (st === 'unlocked') {
    recordPinAttempt(true);
    log('XChat unlocked');
    return;
  }
  recordPinAttempt(false);
  // X says e.g. "After 19 more incorrect attempts, your messages will be locked."
  const remaining = await page
    .evaluate(() => {
      const m = (document.body.innerText || '').match(/after (\d+) more incorrect attempts?/i);
      return m ? Number(m[1]) : null;
    })
    .catch(() => null);
  throw new XctlError(
    'XCHAT_PIN_REJECTED',
    (st === 'error' ? 'XChat rejected the PIN from XCTL_XCHAT_PIN' : 'entered the PIN from XCTL_XCHAT_PIN but XChat did not unlock within 15s') +
      (remaining !== null ? `; X will lock messages after ${remaining} more incorrect attempts` : '') +
      '. Do not retry with the same PIN.',
    { pin_attempted: true, attempts_remaining: remaining },
  );
}
