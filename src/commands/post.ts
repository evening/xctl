import { beforeSend, dryRunScreenshot, normText, type WriteOpts, type WriteState } from '../compose.js';
import { finishWrite } from '../db.js';
import { XctlError } from '../errors.js';
import { ensureLoggedIn, goto, viewerHandle } from '../page.js';
import type { Session } from '../runner.js';
import { collectTimeline } from '../timeline.js';
import type { TweetOut } from '../tweet.js';
import { clearIfTyped, fillComposer, loadTweet, pressSend } from './reply.js';

/** Smallest tweet id X could assign at `ms` (snowflake: ms since the Twitter epoch, shifted left 22 bits). */
function idAt(ms: number): string {
  return ((BigInt(ms) - 1288834974657n) << 22n).toString();
}

export async function performPost(s: Session, _target: string, text: string, opts: WriteOpts, state: WriteState) {
  const { page } = s;
  await goto(page, 'https://x.com/home');
  await ensureLoggedIn(page);
  const handle = s.viewer.handle ?? (await viewerHandle(page));

  const mark = { typed: false };
  try {
    const btn = await fillComposer(page, text, 'Post', mark);
    if (opts.dryRun) {
      const screenshot = await dryRunScreenshot(page, 'post');
      return { dry_run: true, text, screenshot };
    }

    // ---- real send: no retries from here on ----
    const writeId = beforeSend('post', '', opts);
    const pressedAt = Date.now();
    const newId = await pressSend(page, btn, writeId, state, 'Post');
    mark.typed = false; // composer is consumed by a successful post

    // ---- postcondition: the tweet exists, is ours, and is not a reply ----
    const ours = (t: TweetOut | null | undefined): t is TweetOut =>
      !!t && !t.unavailable && !t.parent_id && (!s.viewer.id || t.author_id === s.viewer.id);
    let confirmed: TweetOut | null = null;
    if (newId) {
      const { focal } = await loadTweet(s, newId);
      if (ours(focal)) confirmed = focal;
    } else if (handle) {
      // No CreateTweet response seen: look for it among our tweets posted since the button was pressed.
      const r = await collectTimeline(s, {
        url: `https://x.com/${handle}`,
        op: 'UserTweets',
        instructions: j => j?.data?.user?.result?.timeline?.timeline?.instructions ?? j?.data?.user?.result?.timeline_v2?.timeline?.instructions ?? [],
        keep: t => ours(t) && normText(t.text).endsWith(normText(text).slice(-40)),
        count: 1,
        since: idAt(pressedAt - 60_000),
        maxPages: 2,
      }).catch(() => null);
      confirmed = r?.tweets[0] ?? null;
    }
    if (!confirmed) {
      finishWrite(writeId, 'unconfirmed', { new_id: newId });
      throw new XctlError('UNCONFIRMED', `pressed Post but could not confirm the tweet exists${newId ? ` (X returned id ${newId})` : ''}; do NOT resend without checking your profile`, {
        send_pressed: true,
        tweet_id: newId,
      });
    }
    finishWrite(writeId, 'sent', { id: confirmed.id });
    return { sent: true, confirmed: true, id: confirmed.id, url: confirmed.url, text: confirmed.text, created_at: confirmed.created_at };
  } finally {
    await clearIfTyped(page, mark);
  }
}
