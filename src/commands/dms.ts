import { config } from '../config.js';
import { XctlError } from '../errors.js';
import { log } from '../log.js';
import { ensureLoggedIn, ensureXchatReady, goto, sleep } from '../page.js';
import type { Session } from '../runner.js';
import { parseRelative } from '../timeparse.js';
import { readInbox, type InboxSnapshot } from '../xchat-page.js';
import { handledSet } from '../db.js';
import { guardPasscode } from '../xchat-pin.js';

export interface DmsOpts {
  count: number;
  /** undefined = inbox + requests, true = requests only, false = inbox only */
  requests?: boolean;
}

export interface ConversationOut {
  conversation_id: string;
  participants: string[];
  participant_ids: string[];
  title: string | null;
  last_message: { id: string | null; preview: string; from_me: boolean | null; sender_id: string | null; handled?: boolean };
  timestamp: string | null;
  timestamp_approx: boolean;
  time_label: string | null;
  unread: boolean | null;
  unread_count: number | null;
  is_request: boolean;
  request_bucket?: 'primary' | 'other';
  muted?: boolean | null;
  pinned?: boolean | null;
}

/** "name, @handle, preview, 53m" -> parts. Preview may itself contain ", ". */
function parseDesc(desc: string | null) {
  if (!desc) return { handles: [] as string[], preview: '', time: null as string | null };
  const parts = desc.split(', ');
  const time = parts.length > 1 ? parts[parts.length - 1] : null;
  const handleIdx: number[] = [];
  parts.forEach((p, i) => {
    if (/^@[A-Za-z0-9_]{1,15}$/.test(p) && i < parts.length - 1) handleIdx.push(i);
  });
  const handles = handleIdx.map(i => parts[i].slice(1));
  const start = handleIdx.length ? handleIdx[handleIdx.length - 1] + 1 : 1;
  const preview = parts.slice(start, parts.length - 1).join(', ');
  return { handles, preview, time };
}

function toConversations(snap: InboxSnapshot, viewerId: string | null, isRequest: boolean, bucket?: 'primary' | 'other'): ConversationOut[] {
  const now = new Date();
  const domById = new Map(snap.dom.map(d => [d.conversation_id, d]));
  const source = snap.fiber?.length ? snap.fiber : snap.dom.map(d => ({ conversation_id: d.conversation_id, desc: d.desc }) as any);
  const out: ConversationOut[] = [];
  for (const f of source) {
    const id: string | null = f.conversation_id;
    if (!id) continue;
    const dom = domById.get(id);
    let desc = parseDesc(f.desc ?? dom?.desc ?? null);
    if (!f.desc && !dom?.desc && dom) {
      // Request rows have no aria-description: innerText is "name\ntime\npreview\n... Followers".
      const lines = dom.text.split('\n').map(l => l.trim()).filter(Boolean);
      desc = { handles: [], preview: lines[2] ?? '', time: lines[1] ?? null };
    }
    const ids = id.split(':').filter(x => /^\d+$/.test(x) && x !== viewerId);
    const domFromMe = dom ? /(^|\n)You:/.test(dom.text) : null;
    const fromMe = f.last_sender_id && viewerId ? f.last_sender_id === viewerId : domFromMe;
    const rel = desc.time ? parseRelative(desc.time, now) : null;
    const c: ConversationOut = {
      conversation_id: id,
      participants: desc.handles,
      participant_ids: ids,
      title: f.title ?? null,
      last_message: {
        id: f.last_id ?? null,
        preview: f.last_text ?? desc.preview,
        from_me: fromMe ?? null,
        sender_id: f.last_sender_id ?? null,
      },
      timestamp: f.ts ? new Date(f.ts).toISOString() : rel ? rel.toISOString() : null,
      timestamp_approx: !f.ts,
      time_label: desc.time,
      unread: f.unread ?? null,
      unread_count: f.unread_count ?? null,
      is_request: isRequest,
    };
    if (isRequest && bucket) c.request_bucket = bucket;
    if (f.muted !== undefined) c.muted = f.muted;
    if (f.pinned !== undefined) c.pinned = f.pinned;
    out.push(c);
  }
  return out;
}

async function waitInbox(s: Session, requestsView: boolean): Promise<InboxSnapshot> {
  const deadline = Date.now() + 10_000;
  let snap: InboxSnapshot | null = null;
  let stableFor = 0;
  let lastKey = '';
  while (Date.now() < deadline) {
    await guardPasscode(s.page);
    snap = await s.page.evaluate(readInbox, config.domOnly);
    if (requestsView && !snap.requestsView) {
      await sleep(250);
      continue;
    }
    if (snap.empty) return snap;
    const key = snap.dom.map(d => d.conversation_id).join('|') + '#' + (snap.fiber?.length ?? -1);
    if (snap.dom.length && key === lastKey) {
      if (++stableFor >= 2) return snap;
    } else stableFor = 0;
    lastKey = key;
    await sleep(300);
  }
  if (snap && (snap.dom.length || snap.empty)) return snap;
  // Panel rendered but no items and no known empty-state testid: treat as empty only if XChat is otherwise up.
  if (snap && !snap.dom.length) return snap;
  throw new XctlError('SELECTOR_NOT_FOUND', 'conversation list did not render ([data-testid^=dm-conversation-item-])');
}

async function readView(s: Session, url: string, requestsView: boolean): Promise<InboxSnapshot> {
  await goto(s.page, url);
  await ensureLoggedIn(s.page);
  await ensureXchatReady(s.page);
  return waitInbox(s, requestsView);
}

export async function dms(s: Session, o: DmsOpts) {
  const out: ConversationOut[] = [];
  let source: 'fiber' | 'dom' = 'fiber';
  if (o.requests !== true) {
    const snap = await readView(s, 'https://x.com/i/chat', false);
    if (!snap.fiber && snap.dom.length) source = 'dom';
    out.push(...toConversations(snap, s.viewer.id, false));
  }
  if (o.requests !== false) {
    const snap = await readView(s, 'https://x.com/i/chat/requests', true);
    if (!snap.fiber && snap.dom.length) source = 'dom';
    out.push(...toConversations(snap, s.viewer.id, true, 'primary'));
    // Low-quality "Other" requests have their own route.
    log('reading "Other" message requests');
    const snap2 = await readView(s, 'https://x.com/i/chat/requests/other', true);
    if (!snap2.fiber && snap2.dom.length) source = 'dom';
    const seen = new Set(out.map(c => c.conversation_id));
    out.push(...toConversations(snap2, s.viewer.id, true, 'other').filter(c => !seen.has(c.conversation_id)));
  }
  const list = out.slice(0, o.count);
  const done = handledSet(list.map(c => c.last_message.id).filter((x): x is string => !!x));
  for (const c of list) c.last_message.handled = !!c.last_message.id && done.has(c.last_message.id);
  return { count: list.length, source, conversations: list };
}

export function formatDms(d: any): string {
  if (!d.conversations.length) return '(no conversations)';
  return d.conversations
    .map((c: ConversationOut) => {
      const who = c.participants.length ? c.participants.map(h => '@' + h).join(', ') : c.title ?? c.participant_ids.join(',');
      const flags = [c.unread ? 'UNREAD' : '', c.is_request ? 'REQUEST' : ''].filter(Boolean).join(' ');
      return `${c.conversation_id}  ${who}  ${c.timestamp ?? c.time_label ?? ''} ${flags}\n    ${c.last_message.from_me ? 'You: ' : ''}${c.last_message.preview}`;
    })
    .join('\n');
}
