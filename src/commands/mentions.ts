import { kvGet, kvSet, repliedViaXctl } from '../db.js';
import { XctlError, toXctlError } from '../errors.js';
import { log } from '../log.js';
import { ensureLoggedIn, goto, viewerHandle } from '../page.js';
import type { Session } from '../runner.js';
import { collectSearch, collectTimeline } from '../timeline.js';
import { cmpId, type TweetOut } from '../tweet.js';
import { annotateHandled } from './handled.js';

export type MentionSource = 'notifications' | 'search' | 'both';

export interface MentionsOpts {
  count: number;
  since?: string;
  source: MentionSource;
}

export interface MentionOut extends TweetOut {
  /** Where it was found. The notifications tab can filter mentions out; search can miss some too. */
  sources: ('notifications' | 'search')[];
  /** true: you replied (my_reply_id); false: no reply found; null: couldn't tell (older than the replies scanned). */
  replied_by_me: boolean | null;
  my_reply_id: string | null;
}

async function resolveHandle(s: Session): Promise<string> {
  if (s.viewer.handle) return s.viewer.handle;
  const key = s.viewer.id ? `handle:${s.viewer.id}` : null;
  let h = key ? kvGet(key) : null;
  if (!h) h = await viewerHandle(s.page);
  if (!h) {
    await goto(s.page, 'https://x.com/explore');
    await ensureLoggedIn(s.page);
    h = await viewerHandle(s.page);
  }
  if (!h) throw new XctlError('SELECTOR_NOT_FOUND', 'could not determine the logged-in handle ([data-testid^=UserAvatar-Container-] in the side nav)');
  if (key) kvSet(key, h);
  s.viewer.handle = h;
  return h;
}

export async function mentions(s: Session, o: MentionsOpts) {
  const warnings: string[] = [];
  const merged = new Map<string, MentionOut>();
  const add = (tweets: TweetOut[], source: 'notifications' | 'search') => {
    for (const t of tweets) {
      if (t.by_me) continue;
      const cur = merged.get(t.id);
      if (cur) {
        if (!cur.sources.includes(source)) cur.sources.push(source);
      } else merged.set(t.id, { ...t, sources: [source], replied_by_me: null, my_reply_id: null });
    }
  };
  const counts = { notifications: null as number | null, search: null as number | null };

  let notifFailed = false;
  if (o.source !== 'search') {
    try {
      const r = await collectTimeline(s, {
        url: 'https://x.com/notifications/mentions',
        op: 'NotificationsTimeline',
        filter: v => v.timeline_type === 'Mentions',
        instructions: j => j?.data?.viewer_v2?.user_results?.result?.notification_timeline?.timeline?.instructions ?? [],
        count: o.count,
        since: o.since,
      });
      counts.notifications = r.tweets.length;
      add(r.tweets, 'notifications');
    } catch (e) {
      if (o.source === 'notifications') throw e;
      notifFailed = true;
      const err = toXctlError(e);
      warnings.push(`notifications source failed (${err.code}: ${err.message})`);
    }
  }
  const handle = await resolveHandle(s);
  if (o.source !== 'notifications') {
    try {
      const r = await collectSearch(s, `@${handle} -from:${handle}`, o.count, o.since);
      counts.search = r.tweets.length;
      add(r.tweets, 'search');
    } catch (e) {
      if (o.source === 'search' || notifFailed) throw e;
      const err = toXctlError(e);
      warnings.push(`search source failed (${err.code}: ${err.message})`);
    }
  }

  const list = [...merged.values()].sort((a, b) => cmpId(b.id, a.id)).slice(0, o.count);

  // replied_by_me: your replies newer than the oldest mention, read from your profile's Replies tab
  // (one page, no thread visits; search leaves out many accounts' replies), plus replies xctl sent itself.
  if (list.length) {
    const viaXctl = repliedViaXctl(list.map(m => m.id));
    const oldest = list[list.length - 1];
    let parents: Map<string, string> | null = null;
    let windowStart: string | null = null;
    let complete = false;
    try {
      const r = await collectTimeline(s, {
        url: `https://x.com/${handle}/with_replies`,
        op: 'UserRepliesTimeline',
        instructions: j => j?.data?.user?.result?.timeline?.timeline?.instructions ?? j?.data?.user?.result?.timeline_v2?.timeline?.instructions ?? [],
        // The tab also shows other people's tweets as conversation context; only yours count.
        keep: t => !!s.viewer.id && t.author_id === s.viewer.id,
        count: 200,
        since: oldest.id,
        maxPages: 10,
      });
      parents = new Map();
      for (const t of r.tweets) if (t.parent_id && !parents.has(t.parent_id)) parents.set(t.parent_id, t.id);
      complete = r.complete;
      windowStart = r.tweets.length ? r.tweets[r.tweets.length - 1].id : null;
      log(`replies scan: ${r.tweets.length} replies, complete=${complete}`);
    } catch (e) {
      const err = toXctlError(e);
      warnings.push(`could not scan your replies (${err.code}: ${err.message}); replied_by_me is null unless xctl sent the reply`);
    }
    for (const m of list) {
      const mine = parents?.get(m.id) ?? viaXctl.get(m.id) ?? null;
      if (mine) {
        m.replied_by_me = true;
        m.my_reply_id = mine;
      } else if (parents && (complete || (windowStart && cmpId(m.id, windowStart) >= 0))) {
        m.replied_by_me = false;
      }
    }
  }

  return {
    account: s.viewer.id,
    handle,
    count: list.length,
    sources: counts,
    ...(warnings.length ? { warnings } : {}),
    mentions: annotateHandled(list),
  };
}

export function formatTweetLine(t: TweetOut): string {
  if (t.unavailable) return `[${t.id}] (unavailable: ${t.unavailable_reason})`;
  const reply = t.parent_id ? ` ↳${t.parent_id}` : '';
  const m = t as Partial<MentionOut>;
  const flags = m.replied_by_me === true ? ' [replied]' : m.replied_by_me === null ? ' [replied?]' : '';
  return `[${t.id}] @${t.author} ${t.created_at ?? ''}${reply}${flags}\n    ${t.text.replace(/\n/g, '\n    ')}`;
}

export function formatMentions(d: any): string {
  const warn = d.warnings?.length ? d.warnings.map((w: string) => `warning: ${w}`).join('\n') + '\n' : '';
  return warn + (d.mentions.length ? d.mentions.map(formatTweetLine).join('\n') : '(no mentions)');
}
