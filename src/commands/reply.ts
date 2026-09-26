import type { Locator, Page } from 'playwright-core';
import { beforeSend, dryRunScreenshot, normText, type WriteOpts, type WriteState } from '../compose.js';
import { finishWrite, markHandled } from '../db.js';
import { XctlError } from '../errors.js';
import { captureGraphql } from '../graphql.js';
import { log } from '../log.js';
import { ensureLoggedIn, goto, sleep, waitForSelector } from '../page.js';
import type { Session } from '../runner.js';
import { parseTweet, timelineTweets, unwrapResult, type TweetOut } from '../tweet.js';

const COMPOSER = '[data-testid="primaryColumn"] [data-testid="tweetTextarea_0"]';
const SEND_BUTTON = '[data-testid="primaryColumn"] [data-testid="tweetButtonInline"]';

/** Load a tweet page and return its parsed TweetDetail conversation. */
export async function loadTweet(s: Session, id: string): Promise<{ focal: TweetOut | null; all: TweetOut[] }> {
  const cap = captureGraphql(s.page, 'TweetDetail', v => v.focalTweetId === id);
  try {
    await goto(s.page, `https://x.com/i/status/${id}`);
    await ensureLoggedIn(s.page);
    if (!(await cap.waitFor(0, 20_000))) {
      if (cap.rateLimited.length) throw new XctlError('X_RATE_LIMITED', 'X returned 429 for TweetDetail; wait and retry');
      throw new XctlError('TIMEOUT', 'no TweetDetail GraphQL response within 20s');
    }
    const instructions = cap.results[0].json?.data?.threaded_conversation_with_injections_v2?.instructions ?? [];
    const all: TweetOut[] = [];
    for (const tt of timelineTweets(instructions)) {
      const { tweet } = unwrapResult(tt.result);
      if (tweet) all.push(parseTweet(tweet, s.viewer.id));
    }
    return { focal: all.find(t => t.id === id) ?? null, all };
  } finally {
    await cap.stop();
  }
}

async function composerText(box: Locator): Promise<string> {
  return box.evaluate(e => (e as HTMLElement).innerText);
}

async function clearComposer(page: Page, box: Locator): Promise<void> {
  await box.click({ timeout: 5_000 });
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Backspace');
  await sleep(250);
}

async function closeTypeahead(page: Page): Promise<void> {
  const open = await page.evaluate(() => !!document.querySelector('[role="listbox"][id^="typeaheadDropdown"], [data-testid="typeaheadResult"]'));
  if (open) {
    await page.keyboard.press('Escape');
    await sleep(200);
  }
}

/** The page's inline composer (tweet page: reply; home: new post). */
export function composerBox(page: Page): Locator {
  return page.locator(COMPOSER).first();
}

/**
 * Type `text` into the inline composer and check it took. Clears any leftover text first.
 * Sets `mark.typed` once text may be in the composer, so the caller can clear it on the way out.
 */
export async function fillComposer(page: Page, text: string, what: string, mark: { typed: boolean }): Promise<Locator> {
  await waitForSelector(page, COMPOSER, `${what} composer`, 15_000);
  const box = composerBox(page);
  if (normText(await composerText(box))) await clearComposer(page, box);
  await box.focus({ timeout: 5_000 });
  mark.typed = true;
  // insertText handles newlines/emoji without key events that could accept an @mention suggestion.
  await page.keyboard.insertText(text);
  await sleep(500);
  await closeTypeahead(page);
  const got = await composerText(box);
  if (normText(got) !== normText(text)) {
    throw new XctlError('INTERNAL', `${what} composer text does not match what was requested (typed: ${JSON.stringify(got.slice(0, 200))})`);
  }
  const btn = page.locator(SEND_BUTTON).first();
  await btn.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {
    throw new XctlError('SELECTOR_NOT_FOUND', `${what} button not found (${SEND_BUTTON})`);
  });
  if ((await btn.getAttribute('aria-disabled')) === 'true' || (await btn.isDisabled())) {
    throw new XctlError('INVALID_ARGS', `X disabled the ${what} button for this text (too long for the account?)`);
  }
  return btn;
}

/** Never leave text behind in the composer (a later action could post it, or X prompts on navigation). */
export async function clearIfTyped(page: Page, mark: { typed: boolean }): Promise<void> {
  if (mark.typed && !page.isClosed()) await clearComposer(page, composerBox(page)).catch(() => {});
}

/** Press send and read the new tweet id from CreateTweet (null if no response was seen). Throws if X rejected it. */
export async function pressSend(page: Page, btn: Locator, writeId: number, state: WriteState, what: string): Promise<string | null> {
  const create = captureGraphql(page, 'CreateTweet');
  try {
    state.pressed = true;
    log(`pressing ${what}`);
    await btn.click({ timeout: 5_000 });
    if (await create.waitFor(0, 25_000)) {
      const json = create.results[0].json;
      const newId = json?.data?.create_tweet?.tweet_results?.result?.rest_id ?? null;
      if (!newId && json?.errors?.length) {
        state.rejected = true;
        finishWrite(writeId, 'failed_after_send', json.errors);
        const e = json.errors[0];
        throw new XctlError('X_REJECTED', `X rejected the ${what.toLowerCase()}: ${e.message}${e.code ? ` (code ${e.code})` : ''}`, { x_errors: json.errors });
      }
      return newId;
    }
    if (create.rateLimited.length) {
      state.rejected = true;
      finishWrite(writeId, 'failed_after_send', 'http 429');
      throw new XctlError('X_RATE_LIMITED', 'X returned 429 for CreateTweet; nothing was posted');
    }
    return null;
  } finally {
    await create.stop();
  }
}

export async function performReply(s: Session, tweetId: string, text: string, opts: WriteOpts, state: WriteState) {
  const { page } = s;
  const { focal } = await loadTweet(s, tweetId);
  if (!focal || focal.unavailable) throw new XctlError('NOT_FOUND', `tweet ${tweetId} not found or unavailable`);

  const mark = { typed: false };
  try {
    const btn = await fillComposer(page, text, 'Reply', mark);
    if (opts.dryRun) {
      const screenshot = await dryRunScreenshot(page, 'reply');
      return { dry_run: true, would_reply_to: { id: focal.id, author: focal.author, text: focal.text, url: focal.url }, text, screenshot };
    }

    // ---- real send: no retries from here on ----
    const writeId = beforeSend('reply', tweetId, opts);
    const newId = await pressSend(page, btn, writeId, state, 'Reply');
    mark.typed = false; // composer is consumed by a successful post

    // ---- postcondition: the reply exists, is ours, and replies to the target ----
    let confirmed: TweetOut | null = null;
    if (newId) {
      const { focal: mine } = await loadTweet(s, newId);
      if (mine && !mine.unavailable && mine.parent_id === tweetId && (!s.viewer.id || mine.author_id === s.viewer.id)) confirmed = mine;
    } else {
      // No CreateTweet response seen: look for our reply under the target instead.
      const { all } = await loadTweet(s, tweetId);
      confirmed = all.find(t => t.parent_id === tweetId && t.author_id === s.viewer.id && normText(t.text).endsWith(normText(text).slice(-40))) ?? null;
    }
    if (!confirmed) {
      finishWrite(writeId, 'unconfirmed', { new_id: newId });
      throw new XctlError('UNCONFIRMED', `pressed Reply but could not confirm the reply exists${newId ? ` (X returned id ${newId})` : ''}; do NOT resend without checking \`xctl thread ${tweetId}\``, {
        send_pressed: true,
        reply_id: newId,
      });
    }
    finishWrite(writeId, 'sent', { id: confirmed.id });
    markHandled(tweetId, `replied ${confirmed.id}`);
    return { sent: true, confirmed: true, id: confirmed.id, url: confirmed.url, in_reply_to: tweetId, text: confirmed.text, created_at: confirmed.created_at, marked_handled: tweetId };
  } finally {
    await clearIfTyped(page, mark);
  }
}

export function formatWrite(d: any): string {
  if (d.dry_run && d.would_accept) return `DRY RUN: would accept message request ${d.conversation_id}\nscreenshot: ${d.screenshot}`;
  if (d.dry_run) return `DRY RUN (not sent)${d.would_accept_request ? ' [would accept the message request first]' : ''}\ntext: ${d.text}\nscreenshot: ${d.screenshot}`;
  if (d.accepted && !('sent' in d)) return `${d.already_accepted ? 'already accepted' : 'accepted'}: ${d.conversation_id}`;
  return `sent${d.confirmed ? ' (confirmed)' : ''}: ${d.url ?? d.message_id ?? ''}\n${d.text}`;
}
