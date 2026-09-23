/**
 * Functions evaluated inside the x.com page. They must be self-contained (Playwright serializes them).
 *
 * XChat content is end-to-end encrypted on the wire, so it is read from the rendered app:
 *  - DOM (data-testid) for ids, text and layout (left/right = them/me).
 *  - React fiber props for exact timestamps / sender ids / sequence numbers. The app is Kotlin/JS with
 *    minified field names that change between deploys, so values are located by *shape*, never by key,
 *    except for a few unminified names (items, previewWithMetadata, latestMessagePreview, userId, num).
 *    Everything from the fiber is best-effort and cross-checked against the DOM by the caller.
 */

export interface InboxFiberItem {
  conversation_id: string | null;
  title: string | null;
  desc: string | null;
  last_id: string | null;
  last_text: string | null;
  last_sender_id: string | null;
  ts: number | null;
  unread: boolean | null;
  unread_count: number | null;
  muted: boolean | null;
  pinned: boolean | null;
}

export interface InboxDomItem {
  conversation_id: string;
  desc: string | null;
  text: string;
  href: string | null;
}

export interface InboxSnapshot {
  url: string;
  dom: InboxDomItem[];
  fiber: InboxFiberItem[] | null;
  empty: boolean;
  requestsView: boolean;
}

export function readInbox(domOnly: boolean): InboxSnapshot {
  const toStr = (v: unknown): string | null =>
    typeof v === 'bigint' ? v.toString() : typeof v === 'number' && Number.isFinite(v) ? String(v) : typeof v === 'string' && /^\d+n?$/.test(v) ? v.replace(/n$/, '') : null;
  const instant = (root: unknown): number | null => {
    const q: [unknown, number][] = [[root, 0]];
    const seen = new Set<unknown>();
    while (q.length) {
      const [o, d] = q.shift()!;
      if (!o || typeof o !== 'object' || seen.has(o) || d > 4) continue;
      seen.add(o);
      const ks = Object.keys(o as object);
      if (ks.length === 2) {
        const a = (o as any)[ks[0]];
        const b = (o as any)[ks[1]];
        const secs = Number(toStr(a));
        if (secs > 1.1e9 && secs < 4e9 && typeof b === 'number' && b >= 0 && b < 1e9) return secs * 1000 + Math.floor(b / 1e6);
      }
      for (const k of ks) q.push([(o as any)[k], d + 1]);
    }
    return null;
  };
  // Inbox rows are dm-conversation-item-<id>; message-request rows are dm-message-request-item-<id>.
  const els = [...document.querySelectorAll('[data-testid^="dm-conversation-item-"], [data-testid^="dm-message-request-item-"]')];
  const dom: InboxDomItem[] = els.map(e => {
    const tid = e.getAttribute('data-testid')!;
    return {
      conversation_id: tid.replace(/^dm-(conversation|message-request)-item-/, ''),
      desc: e.getAttribute('aria-description') ?? e.closest('[aria-description]')?.getAttribute('aria-description') ?? null,
      text: (e as HTMLElement).innerText,
      href: e.matches('a[href]') ? e.getAttribute('href') : e.querySelector('a[href]')?.getAttribute('href') ?? null,
    };
  });
  let fiber: InboxFiberItem[] | null = null;
  if (els[0] && !domOnly) {
    const fk = Object.keys(els[0]).find(k => k.startsWith('__reactFiber$'));
    let f = fk ? (els[0] as any)[fk] : null;
    for (let i = 0; i < 12 && f; i++, f = f.return) {
      const items = f.memoizedProps?.items;
      // Inbox items wrap the data in previewWithMetadata; request items are the preview-with-metadata object itself.
      const unwrap = (x: any) => x?.previewWithMetadata ?? (x?.preview && 'accessibilityDescription' in x ? x : null);
      if (Array.isArray(items) && items.some(unwrap)) {
        fiber = items
          .filter(unwrap)
          .map((x: any) => {
            const pw = unwrap(x);
            const pv = pw.preview ?? {};
            const lm = pv.latestMessagePreview ?? {};
            const md = pw.metadata?.metadata ?? {};
            const unreadRaw = pw.isUnreadByMe;
            return {
              conversation_id: pv.conversationId?.id ?? md.conversationId?.id ?? pw.conversationId?.id ?? null,
              title: typeof md.title === 'string' ? md.title : null,
              desc: typeof pw.accessibilityDescription === 'string' ? pw.accessibilityDescription : null,
              last_id: typeof lm.id === 'string' ? lm.id : null,
              last_text: typeof lm.messageText === 'string' ? lm.messageText : null,
              last_sender_id: toStr(lm.sender?.userId),
              ts: instant(pv.timestamp),
              unread: unreadRaw === undefined || unreadRaw === null ? null : !!unreadRaw || (typeof pw.unreadCount === 'number' && pw.unreadCount > 0),
              unread_count: typeof pw.unreadCount === 'number' ? pw.unreadCount : null,
              muted: typeof md.attributes?.muted === 'boolean' ? md.attributes.muted : typeof pw.isMuted === 'boolean' ? pw.isMuted : null,
              pinned: typeof md.attributes?.pinned === 'boolean' ? md.attributes.pinned : typeof pw.isPinned === 'boolean' ? pw.isPinned : null,
            };
          });
        break;
      }
    }
  }
  return {
    url: location.href,
    dom,
    fiber,
    empty: !els.length && !!document.querySelector('[data-testid="dm-message-requests-empty"], [data-testid="dm-empty-inbox"], [data-testid*="inbox-empty" i]'),
    requestsView: !!document.querySelector('[data-testid="dm-message-requests"]'),
  };
}

export interface DmRow {
  kind: 'message' | 'start' | 'info';
  idx: number;
  id?: string;
  text: string;
  from_me?: boolean | null;
  status?: string | null;
  time_label?: string | null;
  attachments?: number;
  fiber?: { sender_id: string | null; ts: number | null; seq: string | null; handle: string | null } | null;
}

export interface DmSnapshot {
  url: string;
  rows: DmRow[];
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  headerHandle: string | null;
  headerName: string | null;
  /** Unaccepted message request: the composer is replaced by Accept/Delete. */
  requestPending: boolean;
}

export function readDmThread(domOnly: boolean): DmSnapshot | null {
  const scroller = document.querySelector('[data-testid="dm-message-scroller"]') as HTMLElement | null;
  if (!scroller) return null;
  const toStr = (v: unknown): string | null =>
    typeof v === 'bigint' ? v.toString() : typeof v === 'number' && Number.isFinite(v) ? String(v) : typeof v === 'string' && /^\d+n?$/.test(v) ? v.replace(/n$/, '') : null;
  const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
  const extract = (root: any) => {
    let sender: string | null = null;
    let ts: number | null = null;
    let seq: string | null = null;
    const q: [any, number][] = [[root, 0]];
    const seen = new Set<any>();
    let budget = 5000;
    while (q.length && budget-- > 0 && (!sender || !ts || !seq)) {
      const [o, d] = q.shift()!;
      if (!o || typeof o !== 'object' || seen.has(o) || d > 5 || o instanceof Node || o.$$typeof) continue;
      seen.add(o);
      let ks: string[];
      try {
        ks = Object.keys(o);
      } catch {
        continue;
      }
      if (!sender && 'userId' in o) {
        const s = toStr(o.userId);
        if (s) sender = s;
      }
      if (!seq && 'num' in o) {
        const s = toStr(o.num);
        if (s && s.length >= 15) seq = s;
      }
      if (!ts && ks.length === 2) {
        const secs = Number(toStr(o[ks[0]]));
        const nanos = o[ks[1]];
        if (secs > 1.1e9 && secs < Date.now() / 1000 + 86400 && typeof nanos === 'number' && nanos >= 0 && nanos < 1e9) ts = secs * 1000 + Math.floor(nanos / 1e6);
      }
      for (const k of ks) {
        const v = o[k];
        if (v && typeof v === 'object') q.push([v, d + 1]);
      }
    }
    // Sender handle: an object whose values contain {userId: <sender>} immediately followed by a handle-shaped string.
    let handle: string | null = null;
    if (sender) {
      const q2: [any, number][] = [[root, 0]];
      const seen2 = new Set<any>();
      let budget2 = 5000;
      while (q2.length && budget2-- > 0 && !handle) {
        const [o, d] = q2.shift()!;
        if (!o || typeof o !== 'object' || seen2.has(o) || d > 7 || o instanceof Node || o.$$typeof) continue;
        seen2.add(o);
        let vals: any[];
        try {
          vals = Object.values(o);
        } catch {
          continue;
        }
        for (let i = 0; i < vals.length - 1; i++) {
          const v = vals[i];
          if (v && typeof v === 'object' && 'userId' in v && toStr(v.userId) === sender && typeof vals[i + 1] === 'string' && HANDLE.test(vals[i + 1])) {
            handle = vals[i + 1];
            break;
          }
        }
        for (const v of vals) if (v && typeof v === 'object') q2.push([v, d + 1]);
      }
    }
    return { sender_id: sender, ts, seq, handle };
  };
  const fiberFor = (el: Element, uuid: string) => {
    const fk = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
    let f = fk ? (el as any)[fk] : null;
    for (let i = 0; i < 8 && f; i++, f = f.return) {
      const p = f.memoizedProps;
      if (!p || typeof p !== 'object') continue;
      for (const k of Object.keys(p)) {
        const v = p[k];
        if (!v || typeof v !== 'object' || v.$$typeof || v instanceof Node || Array.isArray(v)) continue;
        let has = false;
        try {
          for (const kk of Object.keys(v))
            if (v[kk] === uuid) {
              has = true;
              break;
            }
        } catch {}
        if (has) {
          try {
            return extract(v);
          } catch {
            return null;
          }
        }
      }
    }
    return null;
  };
  const TIME = /^\d{1,2}:\d{2}(\s?[AP]M)?$/i;
  const rows: DmRow[] = [];
  const rowEls = [...scroller.querySelectorAll('[data-index]')].filter(r => !r.parentElement?.closest('[data-index]'));
  for (const r of rowEls) {
    const idx = Number(r.getAttribute('data-index'));
    const m = r.querySelector('[data-testid^="message-"][data-send-status]') ?? [...r.querySelectorAll('[data-testid^="message-"]')].find(e => /^message-[0-9a-f]{8}-[0-9a-f-]{27}$/.test(e.getAttribute('data-testid')!));
    if (m) {
      const id = m.getAttribute('data-testid')!.slice('message-'.length);
      const tEl = r.querySelector(`[data-testid="message-text-${CSS.escape(id)}"]`) as HTMLElement | null;
      const span = tEl?.querySelector('span[dir="auto"]') as HTMLElement | null;
      const text = span ? span.innerText : tEl ? tEl.innerText : '';
      let time_label: string | null = null;
      for (const s of r.querySelectorAll('span')) {
        if (span && span.contains(s)) continue;
        const t = (s.textContent || '').trim();
        if (TIME.test(t)) {
          time_label = t;
          break;
        }
      }
      const jc = getComputedStyle(m).justifyContent;
      const article = r.querySelector('[role="article"]');
      const media = article ? [...article.querySelectorAll('img, video')].filter(x => x.getAttribute('alt') !== 'user avatar' && !(span && span.contains(x))).length : 0;
      rows.push({
        kind: 'message',
        idx,
        id,
        text,
        from_me: jc === 'flex-end' ? true : jc === 'flex-start' ? false : null,
        status: m.getAttribute('data-send-status'),
        time_label,
        attachments: media,
        fiber: domOnly ? null : fiberFor(m, id),
      });
    } else {
      rows.push({ kind: r.querySelector('[data-testid="dm-conversation-header-item"]') ? 'start' : 'info', idx, text: (r as HTMLElement).innerText.trim() });
    }
  }
  rows.sort((a, b) => a.idx - b.idx);
  const headerLink = document.querySelector('[data-testid="dm-conversation-header"] a[href]')?.getAttribute('href') ?? '';
  const hm = headerLink.match(/^(?:https:\/\/x\.com)?\/([A-Za-z0-9_]{1,15})\/?$/);
  return {
    url: location.href,
    rows,
    scrollTop: scroller.scrollTop,
    scrollHeight: scroller.scrollHeight,
    clientHeight: scroller.clientHeight,
    headerHandle: hm ? hm[1] : null,
    headerName: (document.querySelector('[data-testid="dm-conversation-username"]') as HTMLElement | null)?.innerText.trim() ?? null,
    requestPending: !!document.querySelector('[data-testid="dm-message-request-prompt"], [data-testid="dm-message-request-accept-button"]'),
  };
}

export function dmScrollTop(): number {
  const s = document.querySelector('[data-testid="dm-message-scroller"]') as HTMLElement | null;
  return s ? Math.round(s.scrollTop) : -1;
}
