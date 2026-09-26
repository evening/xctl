import { config } from '../config.js';
import { isOneToOne, parseConversationId } from '../convid.js';
import { XctlError } from '../errors.js';
import { log } from '../log.js';
import { ensureLoggedIn, ensureXchatReady, goto, sleep, viewerHandle, waitForSelector } from '../page.js';
import type { Session } from '../runner.js';
import { annotateHandled } from './handled.js';
import { guardPasscode } from '../xchat-pin.js';
import { combine, dayLabelClock, parseDayLabel } from '../timeparse.js';
import { dmScrollTop, readDmThread, type DmRow, type DmSnapshot } from '../xchat-page.js';

/** XChat's read-only reason when the other person has blocked us. */
export const BLOCKED_REASON = 'IsDmBlockingMe';

export interface MessageOut {
  id: string;
  sender: string | null;
  sender_id: string | null;
  from_me: boolean | null;
  text: string;
  timestamp: string | null;
  timestamp_source: 'app' | 'label' | null;
  status: string | null;
  attachments?: number;
}

/**
 * Stitch overlapping snapshots of the virtualized list into one ordered row sequence, anchored on shared
 * message ids (data-index values shift when older messages load, so they can't be used across snapshots).
 */
class RowSequence {
  rows: DmRow[] = [];
  gaps = 0;
  merge(snap: DmRow[]): void {
    if (!this.rows.length) {
      this.rows = [...snap];
      return;
    }
    const pos = new Map<string, number>();
    this.rows.forEach((r, i) => r.id && pos.set(r.id, i));
    let offset: number | null = null;
    for (let j = 0; j < snap.length; j++) {
      const id = snap[j].id;
      if (id && pos.has(id)) {
        offset = pos.get(id)! - j;
        break;
      }
    }
    if (offset === null) {
      // No overlap: while scrolling up the snapshot is older than everything we have.
      this.gaps++;
      this.rows = [...snap, ...this.rows];
      return;
    }
    const before: DmRow[] = [];
    for (let j = 0; j < snap.length; j++) {
      const t = j + offset;
      const r = snap[j];
      if (t < 0) before.push(r);
      else if (t >= this.rows.length) this.rows.push(r);
      else if (r.id && this.rows[t].id === r.id && !this.rows[t].fiber && r.fiber) this.rows[t] = r;
    }
    this.rows = [...before, ...this.rows];
  }
  get messageCount(): number {
    return this.rows.filter(r => r.kind === 'message').length;
  }
  get reachedStart(): boolean {
    return this.rows.some(r => r.kind === 'start');
  }
}

/** Wait until the rendered message list stops changing (it remounts briefly whenever CDP attaches). */
export async function waitStable(s: Session, timeoutMs = 15_000): Promise<DmSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  let stable = 0;
  let snap: DmSnapshot | null = null;
  while (Date.now() < deadline) {
    await guardPasscode(s.page);
    snap = await s.page.evaluate(readDmThread, config.domOnly);
    const msgs = snap?.rows.filter(r => r.kind !== 'info') ?? [];
    const key = msgs.map(r => r.id ?? r.kind).join('|');
    if (snap && msgs.length && key === last) {
      if (++stable >= 2) return snap;
    } else stable = 0;
    last = key;
    await sleep(350);
  }
  if (snap && snap.rows.length) return snap;
  throw new XctlError('SELECTOR_NOT_FOUND', 'no messages rendered in the conversation ([data-testid^=message-])');
}

/** DOM-derived timestamps for one contiguous snapshot: separator day + the message's (or its group's) clock label. */
function domTimestamps(rows: DmRow[]): Map<string, number> {
  const res = new Map<string, number>();
  let day: Date | null = null;
  let dayClock: string | null = null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.kind === 'info') {
      const d = parseDayLabel(r.text);
      if (d) {
        day = d;
        dayClock = dayLabelClock(r.text);
      }
      continue;
    }
    if (r.kind !== 'message' || !r.id) continue;
    let clock = r.time_label ?? null;
    for (let j = i + 1; !clock && j < rows.length && rows[j].kind === 'message'; j++) clock = rows[j].time_label ?? null;
    const t = combine(day, clock ?? dayClock);
    if (t) res.set(r.id, t.getTime());
  }
  return res;
}

export async function dm(s: Session, arg: string, count: number) {
  const { id: convId, path } = parseConversationId(arg);
  const { page } = s;
  await goto(page, `https://x.com/i/chat/${path}`);
  await ensureLoggedIn(page);
  await ensureXchatReady(page);
  await waitForSelector(page, '[data-testid="dm-message-scroller"]', 'message list', 15_000).catch(async e => {
    if (!page.url().includes(`/i/chat/${path}`)) throw new XctlError('NOT_FOUND', `conversation ${convId} not found (redirected to ${page.url()})`);
    throw e;
  });
  s.viewer.handle = s.viewer.handle ?? (await viewerHandle(page));

  const seq = new RowSequence();
  let snap = await waitStable(s);
  seq.merge(snap.rows);
  const header = { handle: snap.headerHandle, name: snap.headerName };
  const requestPending = snap.requestPending;
  const { readOnly, readOnlyReason } = snap;
  // Programmatic scrollTop changes are undone by the app (it re-pins to the bottom), so scroll like a user:
  // keyboard PageUp on the focused message log.
  let idle = 0;
  for (let i = 0; seq.messageCount < count && !seq.reachedStart && idle < 4 && i < 80; i++) {
    const before = seq.messageCount;
    await guardPasscode(page);
    const topBefore = await page.evaluate(dmScrollTop);
    await page.focus('[data-testid="dm-message-scroller"]', { timeout: 5_000 });
    await page.keyboard.press('PageUp');
    await sleep(topBefore === 0 ? 1200 : 450);
    const top = await page.evaluate(dmScrollTop);
    snap = (await page.evaluate(readDmThread, config.domOnly)) ?? snap;
    seq.merge(snap.rows);
    idle = seq.messageCount === before && top === topBefore ? idle + 1 : 0;
    log(`dm: ${seq.messageCount} messages collected (scrollTop ${topBefore} -> ${top})`);
  }
  if (seq.gaps) log(`dm: ${seq.gaps} snapshot(s) did not overlap; order across them is by timestamp`);
  const reachedStart = seq.reachedStart;
  const domTs = domTimestamps(seq.rows);

  // Resolve sender + timestamp, cross-checking fiber data against layout.
  const oneToOne = isOneToOne(convId);
  const otherId = oneToOne ? convId.split(':').find(x => x !== s.viewer.id) ?? null : null;
  let fiberMismatches = 0;
  const items = seq.rows.filter(r => r.kind === 'message' && r.id).map((r, pos) => {
    let f = r.fiber ?? null;
    if (f?.sender_id && s.viewer.id && r.from_me !== null && r.from_me !== undefined && (f.sender_id === s.viewer.id) !== r.from_me) {
      fiberMismatches++;
      f = null;
    }
    const fromMe = r.from_me ?? (f?.sender_id && s.viewer.id ? f.sender_id === s.viewer.id : null);
    const senderId = f?.sender_id ?? (fromMe === true ? s.viewer.id : fromMe === false && oneToOne ? otherId : null);
    const sender = fromMe === true ? s.viewer.handle : f?.handle ?? (fromMe === false && oneToOne ? header.handle : null);
    const dts = domTs.get(r.id!) ?? null;
    const ts = f?.ts ?? dts;
    const m: MessageOut = {
      id: r.id!,
      sender,
      sender_id: senderId,
      from_me: fromMe,
      text: r.text,
      timestamp: ts ? new Date(ts).toISOString() : null,
      timestamp_source: f?.ts ? 'app' : dts ? 'label' : null,
      status: r.status ?? null,
    };
    if (r.attachments) m.attachments = r.attachments;
    return { m, seq: f?.seq ?? null, ts, pos };
  });
  if (fiberMismatches) log(`dm: ignored app data for ${fiberMismatches} message(s) that disagreed with layout`);

  // Rendered order is authoritative; app sequence numbers only break ties when snapshots didn't overlap.
  if (seq.gaps) {
    const allSeq = items.every(x => x.seq);
    items.sort((a, b) => {
      if (allSeq) return BigInt(a.seq!) < BigInt(b.seq!) ? -1 : BigInt(a.seq!) > BigInt(b.seq!) ? 1 : 0;
      if (a.ts && b.ts && a.ts !== b.ts) return a.ts - b.ts;
      return a.pos - b.pos;
    });
  }
  const messages = annotateHandled(items.slice(-count).map(x => x.m));
  return {
    conversation_id: convId,
    participants: oneToOne ? [header.handle].filter(Boolean) : [],
    title: header.name,
    request_pending: requestPending,
    read_only: readOnly,
    read_only_reason: readOnlyReason,
    blocked_by_them: readOnlyReason === BLOCKED_REASON,
    count: messages.length,
    has_more: !reachedStart || items.length > count,
    messages,
  };
}

export function formatDm(d: any): string {
  const head = `${d.conversation_id}  ${d.title ?? ''}${d.participants.length ? ' (@' + d.participants.join(', @') + ')' : ''}${d.request_pending ? '  [message request: not accepted]' : ''}${
    d.blocked_by_them ? '  [read-only: they blocked you]' : d.read_only ? `  [read-only${d.read_only_reason ? ': ' + d.read_only_reason : ''}]` : ''
  }`;
  const lines = d.messages.map((m: MessageOut) => {
    const who = m.from_me ? 'me' : m.sender ? '@' + m.sender : m.sender_id ?? '?';
    const ts = m.timestamp ? new Date(m.timestamp).toLocaleString() : '';
    return `[${ts}] ${who}: ${m.text}${m.attachments ? ` [+${m.attachments} attachment(s)]` : ''}`;
  });
  return [head, ...lines].join('\n');
}
