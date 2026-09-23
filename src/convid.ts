import { XctlError } from './errors.js';

/** Accept "a:b", "a-b", or an x.com/i/chat/... URL. Returns canonical id ("a:b") and the URL path segment ("a-b"). */
export function parseConversationId(arg: string): { id: string; path: string } {
  let s = arg.trim();
  const m = s.match(/\/i\/chat\/([^/?#]+)/);
  if (m) s = decodeURIComponent(m[1]);
  if (!s || s === 'requests' || /[\s/?#]/.test(s)) throw new XctlError('INVALID_ARGS', `not a conversation id: ${arg}`);
  const one = s.match(/^(\d+)[:-](\d+)$/);
  if (one) return { id: `${one[1]}:${one[2]}`, path: `${one[1]}-${one[2]}` };
  return { id: s, path: s.replace(/:/g, '-') };
}

export function isOneToOne(id: string): boolean {
  return /^\d+:\d+$/.test(id);
}
