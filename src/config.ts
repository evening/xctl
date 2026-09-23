import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

function num(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

function bool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return !/^(0|false|no|off)$/i.test(v.trim());
}

const home = process.env.XCTL_HOME || path.join(os.homedir(), '.xctl');

export const config = {
  home,
  cdpUrl: process.env.CDP_URL || 'http://127.0.0.1:9222',
  dbPath: path.join(home, 'xctl.db'),
  lockPath: path.join(home, 'browser.lock'),
  tabPath: path.join(home, 'tab.json'),
  debugDir: path.join(home, 'debug'),
  dryRunDir: path.join(home, 'dryrun'),
  lockWaitMs: num('XCTL_LOCK_WAIT_SEC', 30) * 1000,
  lockStaleMs: num('XCTL_LOCK_STALE_SEC', 180) * 1000,
  commandTimeoutMs: num('XCTL_COMMAND_TIMEOUT_SEC', 150) * 1000,
  requireApproval: bool('XCTL_REQUIRE_APPROVAL', true),
  writeMinIntervalSec: num('XCTL_WRITE_MIN_INTERVAL_SEC', 20),
  writesPerHour: num('XCTL_WRITES_PER_HOUR', 30),
  verbose: bool('XCTL_VERBOSE', false),
  /** Ignore React/app state in XChat and use only the rendered DOM (kill switch for the fiber heuristics). */
  domOnly: bool('XCTL_DOM_ONLY', false),
};

export function ensureHome(): void {
  fs.mkdirSync(config.home, { recursive: true, mode: 0o700 });
}
