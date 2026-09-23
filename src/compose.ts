import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { config } from './config.js';
import { recordWrite, writeAllowed, type DraftKind } from './db.js';
import { XctlError } from './errors.js';

export interface WriteOpts {
  dryRun: boolean;
  draftId?: number;
  /** dm send: accept a pending message request first. */
  accept?: boolean;
}

/** Mutable per-attempt state so callers know whether the send button was pressed (never retry after that). */
export interface WriteState {
  pressed: boolean;
  /** X explicitly rejected the write (nothing was posted). */
  rejected: boolean;
}

export function newWriteState(): WriteState {
  return { pressed: false, rejected: false };
}

/** Normalize composer text for comparison (nbsp, CR, trailing spaces per line). */
export function normText(s: string): string {
  return s
    .replace(/ /g, ' ')
    .replace(/\r/g, '')
    .split('\n')
    .map(l => l.trimEnd())
    .join('\n')
    .trim();
}

export function validateText(text: string, max: number): string {
  if (!text || !text.trim()) throw new XctlError('INVALID_ARGS', 'text is empty');
  if (text.length > max) throw new XctlError('INVALID_ARGS', `text is longer than ${max} characters`);
  return text;
}

/** "-" means read the text from stdin (for multi-line text / awkward quoting). */
export async function resolveText(arg: string): Promise<string> {
  if (arg !== '-') return arg;
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8').replace(/\n$/, '');
}

export function assertWriteAllowed(): void {
  const r = writeAllowed();
  if (!r.ok) throw new XctlError('RATE_LIMITED_LOCAL', `${r.reason}; retry in ${r.retry_after_sec}s`, { retry_after_sec: r.retry_after_sec });
}

/** Last check + audit record, immediately before pressing send. Runs inside the browser lock. */
export function beforeSend(kind: DraftKind, target: string, opts: WriteOpts): number {
  assertWriteAllowed();
  return recordWrite(kind, target, opts.draftId ?? null);
}

export async function dryRunScreenshot(page: Page, command: string): Promise<string> {
  fs.mkdirSync(config.dryRunDir, { recursive: true });
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const file = path.join(
    config.dryRunDir,
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}-${command}.png`,
  );
  await page.screenshot({ path: file, timeout: 10_000 });
  return file;
}
