import { XctlError } from '../errors.js';
import { captureGraphql } from '../graphql.js';
import { ensureLoggedIn, goto } from '../page.js';
import type { Session } from '../runner.js';
import { parseTweet, timelineTweets, tombstoneOut, unwrapResult, type TweetOut } from '../tweet.js';
import { formatTweetLine } from './mentions.js';
import { annotateHandled } from './handled.js';

function idFromEntry(entryId: string): string | null {
  const m = entryId.match(/^(?:tweet|conversationthread-\d+-tweet)-(\d+)$/) ?? entryId.match(/-(\d+)$/);
  return m ? m[1] : null;
}

export async function thread(s: Session, id: string) {
  const { page } = s;
  const cap = captureGraphql(page, 'TweetDetail', v => v.focalTweetId === id);
  try {
    await goto(page, `https://x.com/i/status/${id}`);
    await ensureLoggedIn(page);
    if (!(await cap.waitFor(0, 20_000))) {
      if (cap.rateLimited.length) throw new XctlError('X_RATE_LIMITED', 'X returned 429 for TweetDetail; wait and retry');
      const missing = await page.evaluate(() => /this page doesn.t exist|post (was|has been) deleted/i.test(document.body.innerText)).catch(() => false);
      if (missing) throw new XctlError('NOT_FOUND', `tweet ${id} does not exist or was deleted`);
      throw new XctlError('TIMEOUT', 'no TweetDetail GraphQL response within 20s');
    }
    const json = cap.results[0].json;
    const instructions = json?.data?.threaded_conversation_with_injections_v2?.instructions;
    if (!instructions) {
      const msg = json?.errors?.[0]?.message ?? 'no conversation in TweetDetail response';
      throw new XctlError('NOT_FOUND', `tweet ${id}: ${msg}`);
    }
    // Ordered list of conversation tweets (excluding "discover more" recommendations).
    const ordered: { id: string; out: TweetOut; module?: string }[] = [];
    for (const tt of timelineTweets(instructions)) {
      if (/^tweetdetailrelatedtweets/.test(tt.moduleEntryId ?? tt.entryId)) continue;
      const { tweet, tombstone } = unwrapResult(tt.result);
      if (tweet) {
        const out = parseTweet(tweet, s.viewer.id);
        ordered.push({ id: out.id, out, module: tt.moduleEntryId });
      } else {
        const tid = idFromEntry(tt.entryId);
        if (tid) ordered.push({ id: tid, out: tombstoneOut(tid, tombstone ?? 'unavailable'), module: tt.moduleEntryId });
      }
    }
    const focalIdx = ordered.findIndex(x => x.id === id);
    if (focalIdx < 0) throw new XctlError('NOT_FOUND', `tweet ${id} not present in its TweetDetail response (deleted, protected or withheld)`);
    const focal = ordered[focalIdx].out;
    if (focal.unavailable) throw new XctlError('NOT_FOUND', `tweet ${id} is unavailable: ${focal.unavailable_reason}`);
    const byId = new Map(ordered.map(x => [x.id, x.out]));
    const posOf = new Map(ordered.map((x, i) => [x.id, i]));

    // Walk parent links; across a tombstone (no parent info) fall back to display order.
    const ancestors: TweetOut[] = [];
    let complete = true;
    let cur: TweetOut = focal;
    const seen = new Set([focal.id]);
    while (true) {
      let nextId: string | null = cur.parent_id;
      if (!nextId && cur.unavailable) {
        const p = posOf.get(cur.id);
        nextId = p !== undefined && p > 0 && !ordered[p - 1].module ? ordered[p - 1].id : null;
        if (!nextId) break;
      }
      if (!nextId) break;
      if (seen.has(nextId)) break;
      const next = byId.get(nextId);
      if (!next) {
        complete = false;
        ancestors.unshift(tombstoneOut(nextId, 'not included in response'));
        break;
      }
      seen.add(nextId);
      ancestors.unshift(next);
      cur = next;
    }
    const replies = ordered.filter(x => x.id !== id && x.out.parent_id === id).map(x => x.out);
    return { tweet: annotateHandled([focal])[0], ancestors: annotateHandled(ancestors), replies: annotateHandled(replies), complete };
  } finally {
    await cap.stop();
  }
}

export function formatThread(d: any): string {
  const parts: string[] = [];
  for (const a of d.ancestors) parts.push(formatTweetLine(a));
  parts.push('>>> ' + formatTweetLine(d.tweet));
  if (d.replies.length) parts.push(`replies (${d.replies.length}):`, ...d.replies.map((r: TweetOut) => '  ' + formatTweetLine(r)));
  return parts.join('\n');
}
