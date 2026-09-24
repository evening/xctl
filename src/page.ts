import { config } from './config.js';
import type { Page } from 'playwright-core';
import { markTab } from './browser.js';
import { XctlError } from './errors.js';
import { log } from './log.js';
import { PIN_INPUT_SELECTOR, unlockWithPin } from './xchat-pin.js';

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const LOGIN_PATH = /^\/(i\/flow\/(login|signup)|login|logout|signup)(\/|$)/;

export async function goto(page: Page, url: string): Promise<void> {
  log('goto', url);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  } catch (e) {
    if ((e as Error).name === 'TimeoutError') throw new XctlError('TIMEOUT', `navigation to ${url} timed out`);
    throw e;
  }
  await markTab(page);
}

function checkLoginUrl(page: Page): void {
  let p = '';
  try {
    p = new URL(page.url()).pathname;
  } catch {}
  if (LOGIN_PATH.test(p)) throw new XctlError('LOGGED_OUT', `X redirected to ${p}; the browser profile is not logged in`);
}

/** Wait for the logged-in app shell. Throws LOGGED_OUT or SELECTOR_NOT_FOUND. */
export async function ensureLoggedIn(page: Page, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    checkLoginUrl(page);
    const s = await page
      .evaluate(() => ({
        app: !!document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"], [data-testid="AppTabBar_Profile_Link"]'),
        login: !!document.querySelector('[data-testid="loginButton"], [data-testid="signupButton"], [data-testid="login"], a[href="/login"]'),
      }))
      .catch(() => ({ app: false, login: false }));
    if (s.app) return;
    if (s.login) throw new XctlError('LOGGED_OUT', 'X shows a login/signup screen; the browser profile is not logged in');
    await sleep(300);
  }
  checkLoginUrl(page);
  throw new XctlError('SELECTOR_NOT_FOUND', 'X app shell did not load (no [data-testid=SideNav_AccountSwitcher_Button])');
}

/** Handle of the logged-in account, from the side-nav account switcher avatar testid. */
export async function viewerHandle(page: Page): Promise<string | null> {
  return page
    .evaluate(() => {
      const el = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"] [data-testid^="UserAvatar-Container-"]');
      return el?.getAttribute('data-testid')?.slice('UserAvatar-Container-'.length) || null;
    })
    .catch(() => null);
}

/**
 * Wait until XChat has rendered (inbox, requests or a thread) and is not showing a PIN/passcode prompt.
 * Throws XCHAT_LOCKED if an unlock prompt is visible. Never interacts with it.
 */
export async function ensureXchatReady(page: Page, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let pinTried = false;
  // XChat renders its empty shell first and only then redirects to /i/chat/pin/... when locked,
  // so "ready" must hold for a while (or show real content) before we trust it.
  let readySince: number | null = null;
  while (Date.now() < deadline) {
    checkLoginUrl(page);
    const st = await page
      .evaluate(sel => {
        const q = (s: string) => document.querySelector(s);
        const ready = !!q('[data-testid="dm-inbox-panel"], [data-testid="dm-message-scroller"], [data-testid="dm-message-requests"]');
        const content = !!q(
          '[data-testid^="dm-conversation-item-"], [data-testid^="dm-message-request-item-"], [data-testid="dm-message-requests-empty"], [data-testid^="message-text-"], [data-testid="dm-conversation-header-item"]',
        );
        if (/^\/i\/chat\/pin(\/|$)/.test(location.pathname) || q('[data-testid="pin-code-input-container"]')) {
          return { ready, content, locked: true, reason: 'passcode screen' };
        }
        const input = document.querySelector(sel);
        if (input) return { ready, content, locked: true, reason: `unlock input ${input.getAttribute('data-testid') || input.tagName.toLowerCase()}` };
        if (!ready) {
          const text = ((q('main') as HTMLElement | null)?.innerText || '').slice(0, 3000);
          if (/passcode|enter (your )?pin\b|\bPIN\b|unlock (your )?(chat|messages)|recover (your )?(chat|messages|keys)/i.test(text)) {
            return { ready, content, locked: true, reason: 'unlock prompt text' };
          }
        }
        return { ready, content, locked: false, reason: '' };
      }, PIN_INPUT_SELECTOR)
      .catch(() => ({ ready: false, content: false, locked: false, reason: '' }));
    if (st.locked) {
      // With XCTL_XCHAT_PIN set, try it exactly once per command; otherwise report the lock.
      if (!config.xchatPin) {
        throw new XctlError('XCHAT_LOCKED', `XChat is locked (${st.reason}). Unlock it in the browser, or set XCTL_XCHAT_PIN.`);
      }
      if (pinTried) throw new XctlError('XCHAT_PIN_REJECTED', 'XChat is still locked after entering the PIN from XCTL_XCHAT_PIN', { pin_attempted: true });
      pinTried = true;
      readySince = null;
      await unlockWithPin(page);
      continue;
    }
    if (st.ready) {
      readySince ??= Date.now();
      const held = Date.now() - readySince;
      if ((st.content && held >= 600) || held >= 3000) return;
    } else readySince = null;
    await sleep(300);
  }
  throw new XctlError('SELECTOR_NOT_FOUND', 'XChat did not render (no [data-testid=dm-inbox-panel] or [data-testid=dm-message-scroller])');
}

export async function waitForSelector(page: Page, selector: string, what: string, timeoutMs = 15_000): Promise<void> {
  try {
    await page.waitForSelector(selector, { timeout: timeoutMs, state: 'attached' });
  } catch (e) {
    if ((e as Error).name === 'TimeoutError') throw new XctlError('SELECTOR_NOT_FOUND', `${what} not found (${selector})`);
    throw e;
  }
}
