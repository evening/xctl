import fs from 'node:fs';
import crypto from 'node:crypto';
import { config, ensureHome } from './config.js';
import { XctlError } from './errors.js';
import { log } from './log.js';

interface LockInfo {
  pid: number;
  token: string;
  command: string;
  acquired_at: string;
}

function readLock(): { raw: string; info: LockInfo | null; mtimeMs: number } | null {
  try {
    const raw = fs.readFileSync(config.lockPath, 'utf8');
    const mtimeMs = fs.statSync(config.lockPath).mtimeMs;
    let info: LockInfo | null = null;
    try {
      info = JSON.parse(raw);
    } catch {}
    return { raw, info, mtimeMs };
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isStale(l: { info: LockInfo | null; mtimeMs: number }): boolean {
  const started = l.info ? Date.parse(l.info.acquired_at) : l.mtimeMs;
  if (Date.now() - (Number.isFinite(started) ? started : l.mtimeMs) > config.lockStaleMs) return true;
  if (l.info && !pidAlive(l.info.pid)) return true;
  return false;
}

let held: LockInfo | null = null;

export function releaseLock(): void {
  if (!held) return;
  const cur = readLock();
  if (cur?.info?.token === held.token) {
    try {
      fs.unlinkSync(config.lockPath);
    } catch {}
  }
  held = null;
}

/** Acquire ~/.xctl/browser.lock, waiting up to lockWaitMs. Throws LOCKED_BUSY. */
export async function acquireLock(command: string): Promise<void> {
  ensureHome();
  const deadline = Date.now() + config.lockWaitMs;
  const info: LockInfo = { pid: process.pid, token: crypto.randomUUID(), command, acquired_at: '' };
  let announced = false;
  for (;;) {
    info.acquired_at = new Date().toISOString();
    try {
      fs.writeFileSync(config.lockPath, JSON.stringify(info), { flag: 'wx', mode: 0o600 });
      held = info;
      log('lock acquired');
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const cur = readLock();
    if (cur && isStale(cur)) {
      // Only remove it if it is still the same stale lock we inspected.
      const again = readLock();
      if (again && again.raw === cur.raw) {
        log('removing stale lock', cur.info ?? cur.raw);
        try {
          fs.unlinkSync(config.lockPath);
        } catch {}
      }
      continue;
    }
    if (Date.now() >= deadline) {
      const h = cur?.info;
      throw new XctlError(
        'LOCKED_BUSY',
        `another xctl command is driving the browser${h ? ` (pid ${h.pid}, "${h.command}", since ${h.acquired_at})` : ''}; retry later`,
        h ? { holder: { pid: h.pid, command: h.command, acquired_at: h.acquired_at } } : undefined,
      );
    }
    if (!announced) {
      log('waiting for browser lock held by', cur?.info?.command ?? '?');
      announced = true;
    }
    await new Promise(r => setTimeout(r, 250));
  }
}
