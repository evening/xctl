import { checkHandled, handledSet, markHandled, unmarkHandled } from '../db.js';
import { XctlError } from '../errors.js';
import { parseTweetId } from '../tweet.js';

export function normalizeId(arg: string): string {
  const s = arg.trim();
  if (!s) throw new XctlError('INVALID_ARGS', 'empty id');
  if (/^https?:\/\//.test(s) || s.includes('/status/')) {
    const t = parseTweetId(s);
    if (!t) throw new XctlError('INVALID_ARGS', `not a tweet URL: ${arg}`);
    return t;
  }
  return s;
}

export function handledCmd(ids: string[], o: { check?: boolean; unmark?: boolean; note?: string }) {
  if (o.check && o.unmark) throw new XctlError('INVALID_ARGS', '--check and --unmark are mutually exclusive');
  const results = ids.map(normalizeId).map(id => (o.check ? checkHandled(id) : o.unmark ? unmarkHandled(id) : markHandled(id, o.note)));
  return results.length === 1 ? results[0] : { results };
}

/** Add handled:true|false to objects with an id field. */
export function annotateHandled<T extends { id: string | null }>(items: T[]): (T & { handled: boolean })[] {
  const set = handledSet(items.map(i => i.id).filter((x): x is string => !!x));
  return items.map(i => ({ ...i, handled: !!i.id && set.has(i.id) }));
}
