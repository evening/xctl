import { config } from '../config.js';
import { XctlError } from '../errors.js';
import { ensureLoggedIn, ensureXchatReady, goto, viewerHandle } from '../page.js';
import type { Session } from '../runner.js';

export async function health(s: Session) {
  const { page, browser } = s;
  await goto(page, 'https://x.com/i/chat');
  await ensureLoggedIn(page);
  const handle = await viewerHandle(page);
  s.viewer.handle = handle;
  const base = {
    cdp: { connected: true, endpoint: config.cdpUrl, browser_version: browser.version() },
    logged_in: true,
    account: { handle, user_id: s.viewer.id },
  };
  try {
    await ensureXchatReady(page);
  } catch (e) {
    if (e instanceof XctlError) e.details = { ...e.details, status: { ...base, xchat_unlocked: false } };
    throw e;
  }
  return { ...base, xchat_unlocked: true };
}

export function formatHealth(d: any): string {
  return [
    `cdp:      connected (${d.cdp.endpoint}, ${d.cdp.browser_version})`,
    `account:  @${d.account.handle} (${d.account.user_id})`,
    `xchat:    ${d.xchat_unlocked ? 'unlocked' : 'LOCKED'}`,
  ].join('\n');
}
