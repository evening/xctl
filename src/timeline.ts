import { XctlError } from './errors.js';
import { captureGraphql } from './graphql.js';
import { log } from './log.js';
import { ensureLoggedIn, goto, sleep } from './page.js';
import type { Session } from './runner.js';
import { cmpId, parseTweet, timelineTweets, unwrapResult, type TweetOut } from './tweet.js';

export interface TimelineSpec {
  /** Page to load. */
  url: string;
  /** GraphQL operation that carries the timeline (e.g. "NotificationsTimeline", "SearchTimeline"). */
  op: string;
  /** Pick the right request of that operation by its variables. */
  filter?: (vars: Record<string, unknown>) => boolean;
  /** Where the instructions live in the response. */
  instructions: (json: any) => any[];
  /** Stop once this many tweets are collected. */
  count: number;
  /** Only consider tweets passing this filter (applied before `since`). */
  keep?: (t: TweetOut) => boolean;
  /** Ignore (and stop paging at) tweets with id <= since. */
  since?: string;
  maxPages?: number;
}

export interface TimelineResult {
  tweets: TweetOut[];
  /** True if the whole timeline (or everything newer than `since`) was read. */
  complete: boolean;
}

/** Load a timeline page, capture its GraphQL responses, and scroll for more until `count` tweets. Newest first. */
export async function collectTimeline(s: Session, spec: TimelineSpec): Promise<TimelineResult> {
  const { page } = s;
  const cap = captureGraphql(page, spec.op, spec.filter);
  try {
    await goto(page, spec.url);
    await ensureLoggedIn(page);
    if (!(await cap.waitFor(0, 20_000))) {
      if (cap.rateLimited.length) throw new XctlError('X_RATE_LIMITED', `X returned 429 for ${spec.op}; wait and retry`);
      throw new XctlError('TIMEOUT', `no ${spec.op} GraphQL response within 20s`);
    }
    const byId = new Map<string, TweetOut>();
    let processed = 0;
    let reachedSince = false;
    let complete = false;
    const ingest = (): number => {
      let seen = 0;
      for (; processed < cap.results.length; processed++) {
        const tweets = timelineTweets(spec.instructions(cap.results[processed].json));
        seen += tweets.length;
        for (const tt of tweets) {
          const { tweet } = unwrapResult(tt.result);
          if (!tweet) continue;
          const t = parseTweet(tweet, s.viewer.id);
          if (spec.keep && !spec.keep(t)) continue;
          if (spec.since && cmpId(t.id, spec.since) <= 0) {
            reachedSince = true;
            continue;
          }
          if (!byId.has(t.id)) byId.set(t.id, t);
        }
      }
      return seen;
    };
    if (ingest() === 0) complete = true;
    let idle = 0;
    for (let i = 0; !complete && byId.size < spec.count && !reachedSince && idle < 2 && i < (spec.maxPages ?? 15); i++) {
      const sizeBefore = byId.size;
      const before = cap.results.length;
      log(`${spec.op}: scrolling for more; have ${byId.size}`);
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      if (!(await cap.waitFor(before, 8_000))) {
        // One nudge: scroll up a bit and down again to retrigger the loader.
        await page.evaluate(() => window.scrollBy(0, -600));
        await sleep(300);
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        if (!(await cap.waitFor(before, 6_000))) break;
      }
      if (cap.rateLimited.length) break;
      // A page fetched by scrolling with no tweets at all means the end of the timeline.
      if (ingest() === 0) {
        complete = true;
        break;
      }
      idle = byId.size === sizeBefore ? idle + 1 : 0;
    }
    const tweets = [...byId.values()].sort((a, b) => cmpId(b.id, a.id));
    return { tweets, complete: complete || reachedSince };
  } finally {
    await cap.stop();
  }
}

export function searchUrl(query: string): string {
  return `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query&f=live`;
}

export function searchInstructions(json: any): any[] {
  return json?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions ?? [];
}

/** Latest-sorted search results for a raw query. */
export function collectSearch(s: Session, query: string, count: number, since?: string, maxPages = 15): Promise<TimelineResult> {
  return collectTimeline(s, {
    url: searchUrl(query),
    op: 'SearchTimeline',
    filter: v => v.rawQuery === query,
    instructions: searchInstructions,
    count,
    since,
    maxPages,
  });
}
