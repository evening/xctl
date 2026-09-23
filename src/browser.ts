import fs from 'node:fs';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { config, ensureHome } from './config.js';
import { XctlError } from './errors.js';
import { log } from './log.js';

export const TAB_MARKER = 'xctl';

export interface Viewer {
  id: string | null;
  handle: string | null;
}

export async function connect(): Promise<Browser> {
  log('connecting to', config.cdpUrl);
  try {
    return await chromium.connectOverCDP(config.cdpUrl, { timeout: 10_000 });
  } catch (e) {
    throw new XctlError('CDP_UNAVAILABLE', `cannot connect to Chrome over CDP at ${config.cdpUrl} (set CDP_URL): ${(e as Error).message.split('\n')[0]}`);
  }
}

/** Disconnect without closing the user's browser. For connectOverCDP, close() only drops the connection. */
export async function disconnect(browser: Browser | undefined): Promise<void> {
  if (!browser) return;
  await Promise.race([browser.close().catch(() => {}), new Promise(r => setTimeout(r, 3000))]);
}

function race<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p.catch(() => fallback), new Promise<T>(r => setTimeout(() => r(fallback), ms))]);
}

async function targetId(ctx: BrowserContext, page: Page): Promise<string | null> {
  try {
    const s = await ctx.newCDPSession(page);
    const r = (await s.send('Target.getTargetInfo')) as { targetInfo: { targetId: string } };
    await s.detach().catch(() => {});
    return r.targetInfo.targetId;
  } catch {
    return null;
  }
}

function savedTargetId(): string | null {
  try {
    return JSON.parse(fs.readFileSync(config.tabPath, 'utf8')).targetId ?? null;
  } catch {
    return null;
  }
}

/**
 * Find the tab xctl owns (window.name marker, or remembered CDP target id), or open a new one.
 * Never navigates or closes other tabs.
 */
export async function getOwnedPage(browser: Browser): Promise<Page> {
  const ctx = browser.contexts()[0];
  if (!ctx) throw new XctlError('CDP_UNAVAILABLE', 'connected over CDP but found no browser context');
  const saved = savedTargetId();
  let found: Page | undefined;
  for (const p of ctx.pages()) {
    if (saved && (await race(targetId(ctx, p), 2000, null)) === saved) {
      found = p;
      break;
    }
  }
  if (!found) {
    for (const p of ctx.pages()) {
      if (!p.url().startsWith('https://x.com/')) continue;
      if ((await race(p.evaluate(() => window.name), 2000, '')) === TAB_MARKER) {
        found = p;
        break;
      }
    }
  }
  if (!found) {
    log('opening a new xctl tab');
    found = await ctx.newPage();
  } else {
    log('reusing xctl tab', found.url());
  }
  const id = await race(targetId(ctx, found), 2000, null);
  if (id && id !== saved) {
    ensureHome();
    fs.writeFileSync(config.tabPath, JSON.stringify({ targetId: id }));
  }
  found.setDefaultTimeout(15_000);
  found.setDefaultNavigationTimeout(30_000);
  // Background tabs get throttled (timers, rendering, virtualized lists), so make ours the active tab.
  await found.bringToFront().catch(() => {});
  return found;
}

export async function markTab(page: Page): Promise<void> {
  await page.evaluate(m => {
    window.name = m;
  }, TAB_MARKER).catch(() => {});
}

/** Viewer identity from cookies (auth_token presence, twid = u%3D<id>). */
export async function viewerFromCookies(page: Page): Promise<{ loggedIn: boolean; id: string | null }> {
  const cookies = await page.context().cookies('https://x.com');
  const auth = cookies.find(c => c.name === 'auth_token' && c.value);
  const twid = cookies.find(c => c.name === 'twid')?.value;
  const m = twid ? decodeURIComponent(twid).match(/u=(\d+)/) : null;
  return { loggedIn: !!auth, id: m ? m[1] : null };
}
