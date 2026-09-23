import type { Browser, Page } from 'playwright-core';
import { config } from './config.js';
import { connect, disconnect, getOwnedPage, viewerFromCookies, type Viewer } from './browser.js';
import { dumpDebug } from './debug.js';
import { RETRYABLE, XctlError, toXctlError } from './errors.js';
import { acquireLock, releaseLock } from './lock.js';
import { log } from './log.js';
import { emitError, emitOk } from './output.js';

export interface Session {
  browser: Browser;
  page: Page;
  viewer: Viewer;
}

export interface RunOpts {
  pretty: boolean;
  /** Reads may be retried once; writes never. */
  kind: 'read' | 'write';
  format?: (data: any) => string;
}

let cleanupHooks: (() => void)[] = [];

function installSignalHandlers(pretty: boolean, getPage: () => Page | undefined, command: string) {
  const onSignal = (sig: string) => {
    releaseLock();
    void emitError(new XctlError('INTERNAL', `interrupted by ${sig}`), pretty);
  };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));
  process.on('exit', () => releaseLock());
  const timer = setTimeout(async () => {
    const err = new XctlError('TIMEOUT', `command exceeded ${config.commandTimeoutMs / 1000}s (XCTL_COMMAND_TIMEOUT_SEC)`);
    const dir = await dumpDebug(getPage(), command, err);
    if (dir) {
      err.message += `; debug: ${dir}`;
      err.details = { ...err.details, debug_dir: dir };
    }
    releaseLock();
    void emitError(err, pretty);
  }, config.commandTimeoutMs);
  cleanupHooks.push(() => clearTimeout(timer));
}

/** Run a command that needs no browser (sqlite-only commands). */
export async function runLocal<T>(fn: () => Promise<T> | T, opts: { pretty: boolean; format?: (d: any) => string }): Promise<never> {
  try {
    const data = await fn();
    return emitOk(data, opts.pretty, opts.format);
  } catch (e) {
    return emitError(toXctlError(e), opts.pretty);
  }
}

/**
 * Lock -> connect -> owned tab -> fn (one retry for reads on TIMEOUT/SELECTOR_NOT_FOUND)
 * -> debug dump on failure -> disconnect -> unlock -> emit exactly one JSON object.
 */
export async function runBrowser<T>(command: string, opts: RunOpts, fn: (s: Session) => Promise<T>): Promise<never> {
  let browser: Browser | undefined;
  let page: Page | undefined;
  installSignalHandlers(opts.pretty, () => page, command);
  let result: { ok: true; data: T } | { ok: false; err: XctlError };
  try {
    await acquireLock(command);
    browser = await connect();
    page = await getOwnedPage(browser);
    const cookie = await viewerFromCookies(page);
    if (!cookie.loggedIn) throw new XctlError('LOGGED_OUT', 'no auth_token cookie for x.com in this browser profile; log in to X in the browser');
    const session: Session = { browser, page, viewer: { id: cookie.id, handle: null } };
    const attempts = opts.kind === 'read' ? 2 : 1;
    let lastErr: XctlError | undefined;
    let data: T | undefined;
    for (let i = 1; i <= attempts; i++) {
      try {
        data = await fn(session);
        lastErr = undefined;
        break;
      } catch (e) {
        lastErr = toXctlError(e);
        if (i < attempts && RETRYABLE.has(lastErr.code)) {
          log(`attempt ${i} failed (${lastErr.code}: ${lastErr.message}); retrying once`);
          continue;
        }
        break;
      }
    }
    if (lastErr) throw lastErr;
    result = { ok: true, data: data as T };
  } catch (e) {
    const err = toXctlError(e);
    // Expected outcomes (not UI failures) get no debug dump.
    if (!['LOCKED_BUSY', 'QUEUED', 'RATE_LIMITED_LOCAL', 'REQUEST_PENDING', 'INVALID_ARGS'].includes(err.code)) {
      const dir = await dumpDebug(page, command, err);
      if (dir) {
        err.message += `; debug: ${dir}`;
        err.details = { ...err.details, debug_dir: dir };
      }
    }
    result = { ok: false, err };
  }
  await disconnect(browser);
  releaseLock();
  for (const h of cleanupHooks) h();
  cleanupHooks = [];
  return result.ok ? emitOk(result.data, opts.pretty, opts.format) : emitError(result.err, opts.pretty);
}
