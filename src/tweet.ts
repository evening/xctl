/** Parsing of X GraphQL tweet payloads into xctl's stable output shape. */

export interface TweetOut {
  id: string;
  author: string | null;
  author_name: string | null;
  author_id: string | null;
  text: string;
  created_at: string | null;
  parent_id: string | null;
  conversation_id: string | null;
  quoted_id: string | null;
  url: string;
  media?: { type: string; url: string }[];
  by_me?: boolean;
  unavailable?: boolean;
  unavailable_reason?: string;
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };

function decode(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39);/g, m => ENTITIES[m]);
}

/** Unwrap TweetWithVisibilityResults etc. Returns {tweet} or {tombstone}. */
export function unwrapResult(result: any): { tweet?: any; tombstone?: string } {
  if (!result) return {};
  switch (result.__typename) {
    case 'Tweet':
      return { tweet: result };
    case 'TweetWithVisibilityResults':
      return { tweet: result.tweet };
    case 'TweetTombstone':
      return { tombstone: result.tombstone?.text?.text ?? 'unavailable' };
    case 'TweetUnavailable':
      return { tombstone: result.reason ?? 'unavailable' };
    default:
      return result.legacy ? { tweet: result } : {};
  }
}

export function parseTweet(t: any, viewerId?: string | null): TweetOut {
  const legacy = t.legacy ?? {};
  const user = t.core?.user_results?.result ?? {};
  const handle: string | null = user.core?.screen_name ?? user.legacy?.screen_name ?? null;
  const name: string | null = user.core?.name ?? user.legacy?.name ?? null;
  const note = t.note_tweet?.note_tweet_results?.result;
  let text: string = note?.text ?? legacy.full_text ?? '';
  const urls: any[] = (note ? note.entity_set?.urls : legacy.entities?.urls) ?? [];
  for (const u of urls) if (u.url && u.expanded_url) text = text.split(u.url).join(u.expanded_url);
  const mediaList: any[] = legacy.extended_entities?.media ?? legacy.entities?.media ?? [];
  for (const m of mediaList) if (m.url) text = text.split(m.url).join('');
  text = decode(text).trim();
  const id: string = t.rest_id ?? legacy.id_str;
  const out: TweetOut = {
    id,
    author: handle,
    author_name: name,
    author_id: user.rest_id ?? legacy.user_id_str ?? null,
    text,
    created_at: legacy.created_at ? new Date(legacy.created_at).toISOString() : null,
    parent_id: legacy.in_reply_to_status_id_str ?? null,
    conversation_id: legacy.conversation_id_str ?? null,
    quoted_id: legacy.quoted_status_id_str ?? null,
    url: `https://x.com/${handle ?? 'i'}/status/${id}`,
  };
  if (mediaList.length) {
    out.media = mediaList.map(m => ({
      type: m.type,
      url: m.type === 'photo' ? m.media_url_https : (m.video_info?.variants ?? []).filter((v: any) => v.content_type === 'video/mp4').sort((a: any, b: any) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0]?.url ?? m.media_url_https,
    }));
  }
  if (viewerId) out.by_me = out.author_id === viewerId;
  return out;
}

export function tombstoneOut(id: string, reason: string): TweetOut {
  return {
    id,
    author: null,
    author_name: null,
    author_id: null,
    text: '',
    created_at: null,
    parent_id: null,
    conversation_id: null,
    quoted_id: null,
    url: `https://x.com/i/status/${id}`,
    unavailable: true,
    unavailable_reason: reason,
  };
}

export interface TimelineTweet {
  entryId: string;
  moduleEntryId?: string;
  sortIndex?: string;
  result: any;
}

/** All top-level tweets in a timeline's instructions, in display order (includes items inside modules). */
export function timelineTweets(instructions: any[]): TimelineTweet[] {
  const out: TimelineTweet[] = [];
  const push = (entryId: string, content: any, sortIndex?: string, moduleEntryId?: string) => {
    const r = content?.itemContent?.tweet_results?.result;
    if (content?.itemContent?.itemType === 'TimelineTweet' || r) out.push({ entryId, moduleEntryId, sortIndex, result: r });
  };
  for (const ins of instructions ?? []) {
    const entries = ins.entries ?? (ins.entry ? [ins.entry] : []);
    for (const e of entries) {
      const c = e.content;
      if (!c) continue;
      if (c.itemContent) push(e.entryId, c, e.sortIndex);
      for (const it of c.items ?? []) push(it.entryId, it.item, e.sortIndex, e.entryId);
    }
    if (ins.moduleItems) for (const it of ins.moduleItems) push(it.entryId, it.item, undefined, ins.moduleEntryId);
  }
  return out;
}

/** "123", "https://x.com/u/status/123", "x.com/i/web/status/123?s=20" -> "123" */
export function parseTweetId(arg: string): string | null {
  const s = arg.trim();
  if (/^\d{1,25}$/.test(s)) return s;
  const m = s.match(/\/status(?:es)?\/(\d{1,25})/);
  return m ? m[1] : null;
}

export function cmpId(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}
