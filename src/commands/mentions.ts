import { XctlError } from '../errors.js';
import { captureGraphql } from '../graphql.js';
import { log } from '../log.js';
import { ensureLoggedIn, goto, sleep } from '../page.js';
import type { Session } from '../runner.js';
import { annotateHandled } from './handled.js';
import { cmpId, parseTweet, timelineTweets, unwrapResult, type TweetOut } from '../tweet.js';

export interface MentionsOpts {
  count: number;
  since?: string;
}

function mentionsInstructions(json: any): any[] {
  return json?.data?.viewer_v2?.user_results?.result?.notification_timeline?.timeline?.instructions ?? [];
}

export async function mentions(s: Session, o: MentionsOpts) {
  const { page } = s;
  const cap = captureGraphql(page, 'NotificationsTimeline', v => v.timeline_type === 'Mentions');
  try {
    await goto(page, 'https://x.com/notifications/mentions');
    await ensureLoggedIn(page);
    if (!(await cap.waitFor(0, 20_000))) {
      if (cap.rateLimited.length) throw new XctlError('X_RATE_LIMITED', 'X returned 429 for NotificationsTimeline; wait and retry');
      throw new XctlError('TIMEOUT', 'no NotificationsTimeline (Mentions) GraphQL response within 20s');
    }
    const byId = new Map<string, TweetOut>();
    let processed = 0;
    let reachedSince = false;
    let idle = 0;
    const ingest = (): number => {
      let seenTweets = 0;
      for (; processed < cap.results.length; processed++) {
        const r = cap.results[processed];
        const tweets = timelineTweets(mentionsInstructions(r.json));
        seenTweets += tweets.length;
        for (const tt of tweets) {
          const { tweet } = unwrapResult(tt.result);
          if (!tweet) continue;
          const t = parseTweet(tweet, s.viewer.id);
          if (o.since && cmpId(t.id, o.since) <= 0) {
            reachedSince = true;
            continue;
          }
          if (!byId.has(t.id)) byId.set(t.id, t);
        }
      }
      return seenTweets;
    };
    ingest();
    for (let page_ = 0; byId.size < o.count && !reachedSince && idle < 2 && page_ < 15; page_++) {
      const sizeBefore = byId.size;
      const before = cap.results.length;
      log('scrolling for more mentions; have', byId.size);
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      if (!(await cap.waitFor(before, 8_000))) {
        // one nudge: scroll up a bit and down again to retrigger the loader
        await page.evaluate(() => window.scrollBy(0, -600));
        await sleep(300);
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        if (!(await cap.waitFor(before, 6_000))) break;
      }
      if (cap.rateLimited.length) break;
      // A page fetched by scrolling with no tweets at all means the end of the timeline.
      if (ingest() === 0) break;
      idle = byId.size === sizeBefore ? idle + 1 : 0;
    }
    const list = [...byId.values()].sort((a, b) => cmpId(b.id, a.id)).slice(0, o.count);
    return { account: s.viewer.id, count: list.length, mentions: annotateHandled(list) };
  } finally {
    await cap.stop();
  }
}

export function formatTweetLine(t: TweetOut): string {
  if (t.unavailable) return `[${t.id}] (unavailable: ${t.unavailable_reason})`;
  const reply = t.parent_id ? ` ↳${t.parent_id}` : '';
  return `[${t.id}] @${t.author} ${t.created_at ?? ''}${reply}\n    ${t.text.replace(/\n/g, '\n    ')}`;
}

export function formatMentions(d: any): string {
  return d.mentions.length ? d.mentions.map(formatTweetLine).join('\n') : '(no mentions)';
}
