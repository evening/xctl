import type { ConversationOut } from './commands/dms.js';
import type { MentionOut } from './commands/mentions.js';
import type { MessageOut } from './commands/dm.js';

export interface RecentThread {
  messages: (MessageOut & { handled?: boolean })[];
  has_more: boolean;
  read_only: boolean;
  read_only_reason: string | null;
}

export interface RecentInput {
  now: Date;
  days: number;
  requested_count: number;
  conversations: ConversationOut[];
  mentions: MentionOut[];
  threads: Map<string, RecentThread>;
  warnings: string[];
}

function timestamp(s: string | null): number | null {
  if (!s) return null;
  const n = Date.parse(s);
  return Number.isFinite(n) ? n : null;
}

export function summarizeRecent(input: RecentInput) {
  const cutoff = input.now.getTime() - input.days * 86_400_000;
  const within = (s: string | null) => { const t = timestamp(s); return t === null || t >= cutoff; };
  const dms = input.conversations.filter(c => within(c.timestamp)).map(c => {
    const thread = input.threads.get(c.conversation_id);
    const latest_message_id = thread?.messages.at(-1)?.id ?? null;
    return {
      ...c,
      ...(thread ? { tail: {
        latest_message_id,
        matches_inbox: !!latest_message_id && !!c.last_message.id ? latest_message_id === c.last_message.id : null,
        has_more: thread.has_more, read_only: thread.read_only, read_only_reason: thread.read_only_reason,
        messages: thread.messages.filter(m => within(m.timestamp)),
      } } : {}),
    };
  }).sort((a, b) => (timestamp(b.timestamp) ?? -Infinity) - (timestamp(a.timestamp) ?? -Infinity));
  const grouped = new Map<string, MentionOut[]>();
  for (const m of input.mentions.filter(m => within(m.created_at))) {
    const id = m.conversation_id ?? m.id;
    grouped.set(id, [...(grouped.get(id) ?? []), m]);
  }
  const public_threads = [...grouped].map(([conversation_id, mentions]) => ({
    conversation_id,
    latest_at: mentions.map(m => m.created_at).filter(Boolean).sort().at(-1) ?? null,
    mentions: mentions.sort((a, b) => (timestamp(b.created_at) ?? -Infinity) - (timestamp(a.created_at) ?? -Infinity)),
  })).sort((a, b) => (timestamp(b.latest_at) ?? -Infinity) - (timestamp(a.latest_at) ?? -Infinity));
  const review_candidates = [
    ...dms.filter(c => c.last_message.from_me === false && !c.last_message.handled && c.last_message.id).map(c => ({
      kind: 'dm' as const, id: c.last_message.id!, conversation_id: c.conversation_id,
      status: 'candidate_only' as const, reason: c.tail?.matches_inbox === false
        ? 'inbox/thread mismatch; reread before deciding'
        : c.tail?.read_only ? 'read-only conversation; do not send'
          : 'latest inbox message is incoming and not marked handled',
    })),
    ...public_threads.flatMap(t => t.mentions.filter(m => m.replied_by_me !== true && !(m as MentionOut & { handled?: boolean }).handled).map(m => ({
      kind: 'mention' as const, id: m.id, conversation_id: t.conversation_id,
      status: 'candidate_only' as const, reason: m.replied_by_me === null ? 'reply status unknown' : 'no reply found; may be an intentional skip',
    }))),
  ];
  return {
    snapshot_at: input.now.toISOString(), cutoff_at: new Date(cutoff).toISOString(),
    coverage: {
      dm_rows_scanned: input.conversations.length, mention_rows_scanned: input.mentions.length,
      dm_list_limit_reached: input.conversations.length >= input.requested_count,
      mention_list_limit_reached: input.mentions.length >= input.requested_count,
      dm_threads_read: input.threads.size, warnings: input.warnings,
      unknown_timestamps: dms.filter(c => timestamp(c.timestamp) === null).length + public_threads.flatMap(t => t.mentions).filter(m => timestamp(m.created_at) === null).length,
    },
    dms, public_threads, review_candidates,
  };
}
