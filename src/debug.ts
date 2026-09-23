import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { config } from './config.js';
import type { XctlError } from './errors.js';
import { log } from './log.js';

function stamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([p, new Promise<undefined>(r => setTimeout(() => r(undefined), ms))]);
}

/** Save screenshot + page HTML + error info. Returns the directory, or undefined if even that failed. */
export async function dumpDebug(page: Page | undefined, command: string, err: XctlError): Promise<string | undefined> {
  try {
    const dir = path.join(config.debugDir, `${stamp()}-${command.replace(/[^\w-]+/g, '_')}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'error.json'),
      JSON.stringify({ code: err.code, message: err.message, details: err.details, url: page?.url(), stack: err.stack, at: new Date().toISOString() }, null, 2),
    );
    if (page && !page.isClosed()) {
      await withTimeout(page.screenshot({ path: path.join(dir, 'screenshot.png'), timeout: 8000 }).catch(() => undefined), 9000);
      const html = await withTimeout(page.content().catch(() => undefined), 5000);
      if (html) fs.writeFileSync(path.join(dir, 'page.html'), html);
    }
    log('debug dump at', dir);
    return dir;
  } catch {
    return undefined;
  }
}
