import { ERROR_CODES, XctlError } from './errors.js';

let emitted = false;

function write(text: string, exitCode: number): Promise<never> {
  if (emitted) return new Promise(() => {});
  emitted = true;
  return new Promise(() => {
    process.stdout.write(text.endsWith('\n') ? text : text + '\n', () => process.exit(exitCode));
  });
}

export function isEmitted(): boolean {
  return emitted;
}

export function emitOk(data: unknown, pretty: boolean, format?: (d: any) => string): Promise<never> {
  if (pretty) return write(format ? format(data) : prettyValue(data), 0);
  return write(JSON.stringify({ ok: true, data }), 0);
}

export function emitError(err: XctlError, pretty: boolean): Promise<never> {
  const exit = ERROR_CODES[err.code] ?? 1;
  if (pretty) {
    const extra = { ...(err.top ?? {}), ...(err.details ?? {}) };
    const rest = Object.keys(extra).length ? '\n' + prettyValue(extra) : '';
    return write(`error ${err.code}: ${err.message}${rest}`, exit);
  }
  const body: Record<string, unknown> = {
    ok: false,
    error: { code: err.code, message: err.message, ...(err.details ?? {}) },
    ...(err.top ?? {}),
  };
  return write(JSON.stringify(body), exit);
}

/** Generic human-readable rendering: indented key/value tree. */
export function prettyValue(v: unknown, indent = ''): string {
  if (v === null || v === undefined) return indent + String(v);
  if (typeof v !== 'object') return indent + String(v);
  if (Array.isArray(v)) {
    if (!v.length) return indent + '(none)';
    return v.map(x => (typeof x === 'object' && x ? prettyValue(x, indent + '  ').replace(/^\s+/, indent + '- ') : `${indent}- ${x}`)).join('\n');
  }
  const lines: string[] = [];
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (val === undefined) continue;
    if (val && typeof val === 'object') lines.push(`${indent}${k}:\n${prettyValue(val, indent + '  ')}`);
    else lines.push(`${indent}${k}: ${val}`);
  }
  return lines.join('\n');
}
