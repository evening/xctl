import type { Page } from 'playwright-core';
import { markTab } from './browser.js';
import { XctlError } from './errors.js';
import { log } from './log.js';

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
  let last = { ready: false, locked: false, reason: '' };
  while (Date.now() < deadline) {
    checkLoginUrl(page);
    last = await page
      .evaluate(() => {
        const q = (s: string) => document.querySelector(s);
        const ready = !!q('[data-testid="dm-inbox-panel"], [data-testid="dm-message-scroller"], [data-testid="dm-message-requests"]');
        const input = document.querySelector(
          'input[type="password"], input[autocomplete="one-time-code"], input[inputmode="numeric"], [data-testid*="passcode" i], [data-testid*="pin-input" i], [data-testid*="pincode" i]',
        );
        if (input) return { ready, locked: true, reason: `unlock input ${input.getAttribute('data-testid') || input.tagName.toLowerCase()}` };
        if (!ready) {
          const text = ((q('main') as HTMLElement | null)?.innerText || '').slice(0, 3000);
          if (/passcode|enter (your )?pin\b|\bPIN\b|unlock (your )?(chat|messages)|recover (your )?(chat|messages|keys)/i.test(text)) {
            return { ready, locked: true, reason: 'unlock prompt text' };
          }
        }
        return { ready, locked: false, reason: '' };
      })
      .catch(() => ({ ready: false, locked: false, reason: '' }));
    if (last.locked) throw new XctlError('XCHAT_LOCKED', `XChat is locked (${last.reason}). Unlock it manually in the browser; xctl never enters the PIN.`);
    if (last.ready) return;
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
