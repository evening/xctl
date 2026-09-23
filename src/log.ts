import { config } from './config.js';

let verbose = config.verbose;
export function setVerbose(v: boolean): void {
  verbose = verbose || v;
}

/** Progress/diagnostics. Always stderr, only when verbose (agents often merge stderr into stdout). */
export function log(...args: unknown[]): void {
  if (!verbose) return;
  const t = new Date().toISOString().slice(11, 23);
  process.stderr.write(`[xctl ${t}] ${args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`);
}
