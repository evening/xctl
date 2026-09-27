import type { Session } from '../runner.js';
import { toXctlError } from '../errors.js';
import { dms } from './dms.js';
import { dm } from './dm.js';
import { mentions } from './mentions.js';
import { summarizeRecent, type RecentThread } from '../recent.js';

export interface RecentOptions {
  days: number;
  count: number;
  dmThreads: number;
  messages: number;
}

/** One bounded, read-only browser pass; warnings preserve partial DM-tail failures. */
export async function recent(s: Session, o: RecentOptions) {
  const inbox = await dms(s, { count: o.count });
  const publicMentions = await mentions(s, { count: o.count, source: 'both' });
  const cutoff = Date.now() - o.days * 86_400_000;
  const threads = new Map<string, RecentThread>();
  const warnings = [...(publicMentions.warnings ?? [])];
  const active = inbox.conversations.filter(c => !c.timestamp || !Number.isFinite(Date.parse(c.timestamp)) || Date.parse(c.timestamp) >= cutoff);
  for (const c of active.slice(0, o.dmThreads)) {
    try {
      const t = await dm(s, c.conversation_id, o.messages);
      threads.set(c.conversation_id, {
        messages: t.messages, has_more: t.has_more, read_only: t.read_only, read_only_reason: t.read_only_reason,
      });
    } catch (e) {
      const err = toXctlError(e);
      warnings.push(`dm tail ${c.conversation_id} unavailable (${err.code}: ${err.message})`);
    }
  }
  return summarizeRecent({
    now: new Date(), days: o.days, requested_count: o.count,
    conversations: inbox.conversations, mentions: publicMentions.mentions, threads, warnings,
  });
}
