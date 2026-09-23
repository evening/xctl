export const ERROR_CODES = {
  LOGGED_OUT: 10,
  XCHAT_LOCKED: 11,
  SELECTOR_NOT_FOUND: 12,
  TIMEOUT: 13,
  LOCKED_BUSY: 14,
  RATE_LIMITED_LOCAL: 15,
  UNCONFIRMED: 16,
  QUEUED: 17,
  NOT_FOUND: 18,
  X_RATE_LIMITED: 19,
  X_REJECTED: 21,
  REQUEST_PENDING: 22,
  NETWORK: 23,
  CDP_UNAVAILABLE: 20,
  INVALID_ARGS: 2,
  INTERNAL: 1,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

/** Codes where one retry of a read is allowed. */
export const RETRYABLE: ReadonlySet<ErrorCode> = new Set(['TIMEOUT', 'SELECTOR_NOT_FOUND', 'NETWORK']);

export class XctlError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    /** Extra fields merged into the error object. */
    public details?: Record<string, unknown>,
    /** Extra fields merged into the top-level response object (e.g. draft_id). */
    public top?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function toXctlError(e: unknown): XctlError {
  if (e instanceof XctlError) return e;
  const err = e as { name?: string; message?: string };
  const msg = err?.message ?? String(e);
  if (err?.name === 'TimeoutError') return new XctlError('TIMEOUT', firstLine(msg));
  if (/net::ERR_/.test(msg)) return new XctlError('NETWORK', firstLine(msg));
  if (/Target (page, context or browser )?(has been )?closed|Browser has been closed|browser has disconnected|ECONNREFUSED|WebSocket/i.test(msg)) {
    return new XctlError('CDP_UNAVAILABLE', firstLine(msg));
  }
  return new XctlError('INTERNAL', firstLine(msg));
}

function firstLine(s: string): string {
  return s.split('\n')[0].slice(0, 500);
}
