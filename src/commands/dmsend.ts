import { config } from '../config.js';
import { assertWriteAllowed, beforeSend, dryRunScreenshot, normText, type WriteOpts, type WriteState } from '../compose.js';
import { parseConversationId } from '../convid.js';
import { finishWrite, markHandled, recordWrite } from '../db.js';
import { XctlError } from '../errors.js';
import { log } from '../log.js';
import { ensureLoggedIn, ensureXchatReady, goto, sleep, waitForSelector } from '../page.js';
import type { Session } from '../runner.js';
import { readDmThread, type DmSnapshot } from '../xchat-page.js';
import { BLOCKED_REASON, waitStable } from './dm.js';
import { passcodeScreenVisible, unlockWithPin } from '../xchat-pin.js';

const TEXTAREA = '[data-testid="dm-composer-textarea"]';
const SEND = '[data-testid="dm-composer-send-button"]';
const ACCEPT = '[data-testid="dm-message-request-accept-button"]';
const DONE_STATUSES = new Set(['sent', 'delivered', 'read', 'seen']);

async function openConversation(s: Session, conversation: string): Promise<{ convId: string; snap: DmSnapshot }> {
  const { id: convId, path } = parseConversationId(conversation);
  const { page } = s;
  await goto(page, `https://x.com/i/chat/${path}`);
  await ensureLoggedIn(page);
  await ensureXchatReady(page);
  await waitForSelector(page, '[data-testid="dm-message-scroller"]', 'message list', 15_000).catch(e => {
    if (!page.url().includes(`/i/chat/${path}`)) throw new XctlError('NOT_FOUND', `conversation ${convId} not found (redirected to ${page.url()})`);
    throw e;
  });
  return { convId, snap: await waitStable(s) };
}

/**
 * After a button was pressed we must not start over. If the passcode screen shows up, unlock and reopen the
 * conversation so the caller can keep checking the outcome. Returns true if it had to do that.
 */
async function recoverFromPasscode(s: Session, convId: string): Promise<boolean> {
  if (!(await passcodeScreenVisible(s.page))) return false;
  log('passcode screen appeared after pressing; unlocking and reopening the conversation');
  await unlockWithPin(s.page);
  const { path } = parseConversationId(convId);
  await goto(s.page, `https://x.com/i/chat/${path}`);
  await ensureXchatReady(s.page);
  return true;
}

/** Press Accept on a pending message request and wait until the normal composer replaces the prompt. */
async function acceptRequest(s: Session, convId: string, opts: WriteOpts): Promise<void> {
  const { page } = s;
  const btn = page.locator(ACCEPT).first();
  await btn.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {
    throw new XctlError('SELECTOR_NOT_FOUND', `message request Accept button not found (${ACCEPT})`);
  });
  const writeId = recordWrite('accept', convId, opts.draftId ?? null);
  log('pressing Accept on message request');
  await btn.click({ timeout: 5_000 });
  const deadline = Date.now() + 20_000;
  let accepted = false;
  while (Date.now() < deadline) {
    await recoverFromPasscode(s, convId);
    accepted = await page
      .evaluate(() => !document.querySelector('[data-testid="dm-message-request-prompt"]') && !!document.querySelector('[data-testid="dm-composer-textarea"]'))
      .catch(() => false);
    if (accepted) break;
    await sleep(400);
  }
  if (!accepted) {
    finishWrite(writeId, 'unconfirmed');
    throw new XctlError('UNCONFIRMED', `pressed Accept but the message request prompt did not go away; check with \`xctl dm ${convId}\``, {
      accept_pressed: true,
    });
  }
  finishWrite(writeId, 'sent');
}


export async function performAccept(s: Session, conversation: string, _text: string, opts: WriteOpts, state: WriteState) {
  const { convId, snap } = await openConversation(s, conversation);
  const participants = snap.headerHandle ? [snap.headerHandle] : [];
  if (!snap.requestPending) return { accepted: true, already_accepted: true, conversation_id: convId, participants };
  if (opts.dryRun) {
    const screenshot = await dryRunScreenshot(s.page, 'dm-accept');
    return { dry_run: true, would_accept: true, conversation_id: convId, participants, screenshot };
  }
  state.pressed = true;
  await acceptRequest(s, convId, opts);
  return { accepted: true, confirmed: true, conversation_id: convId, participants };
}

export async function performDmSend(s: Session, conversation: string, text: string, opts: WriteOpts, state: WriteState) {
  const { page } = s;
  const opened = await openConversation(s, conversation);
  const convId = opened.convId;
  const acceptedRequest = opened.snap.requestPending;
  let before = opened.snap;
  const participants = before.headerHandle ? [before.headerHandle] : [];

  if (before.readOnly) {
    const blocked = before.readOnlyReason === BLOCKED_REASON;
    throw new XctlError(
      'READ_ONLY',
      blocked ? `${convId} is read-only: they blocked you, so it can't be replied to` : `${convId} is read-only (${before.readOnlyReason ?? 'reason unknown'}); it can't be replied to`,
      { read_only_reason: before.readOnlyReason, blocked_by_them: blocked },
    );
  }

  if (before.requestPending) {
    if (!opts.accept) {
      throw new XctlError(
        'REQUEST_PENDING',
        `${convId} is an unaccepted message request; resend with --accept to accept it and reply, or run \`xctl dm accept ${convId}\``,
      );
    }
    if (opts.dryRun) {
      const screenshot = await dryRunScreenshot(page, 'dm-send');
      return {
        dry_run: true,
        would_accept_request: true,
        conversation_id: convId,
        participants,
        text,
        screenshot,
        note: 'the composer only appears after accepting, so the text was not typed in this dry run',
      };
    }
    // Accepting is a real action: rate limits are checked before it so we never accept and then refuse to send.
    assertWriteAllowed();
    await acceptRequest(s, convId, opts);
    before = await waitStable(s);
  }

  const prevIds = new Set(before.rows.filter(r => r.kind === 'message').map(r => r.id));
  const lastIncoming = [...before.rows].reverse().find(r => r.kind === 'message' && r.from_me === false)?.id ?? null;

  const ta = page.locator(TEXTAREA).first();
  if (!(await ta.count())) {
    throw new XctlError('SELECTOR_NOT_FOUND', `no message composer (${TEXTAREA}); is this a read-only conversation?`);
  }
  let typed = false;
  try {
    typed = true;
    // A real <textarea>: fill() sets the value through React without key events (Enter would send).
    await ta.fill(text, { timeout: 5_000 });
    await sleep(300);
    const got = await ta.inputValue();
    if (got !== text) throw new XctlError('INTERNAL', `DM composer text does not match what was requested (got ${JSON.stringify(got.slice(0, 200))})`);
    const btn = page.locator(SEND).first();
    await btn.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {
      throw new XctlError('SELECTOR_NOT_FOUND', `send button not found (${SEND})`);
    });
    if (await btn.isDisabled()) throw new XctlError('INVALID_ARGS', 'XChat disabled the Send button for this text');
    if (opts.dryRun) {
      const screenshot = await dryRunScreenshot(page, 'dm-send');
      return { dry_run: true, conversation_id: convId, participants, text, screenshot };
    }

    // ---- real send: no retries from here on ----
    const writeId = beforeSend('dm', convId, opts);
    state.pressed = true;
    log('pressing Send');
    await btn.click({ timeout: 5_000 });
    typed = false;

    // ---- postcondition: a new message of ours with this text appears in the thread ----
    const want = normText(text);
    const deadline = Date.now() + 25_000;
    let found: { id: string; status: string | null; ts: number | null } | null = null;
    while (Date.now() < deadline) {
      await sleep(500);
      // Never resend: if XChat asks for the passcode now, unlock, reopen, and keep looking for the message.
      await recoverFromPasscode(s, convId);
      const snap = await page.evaluate(readDmThread, config.domOnly);
      const row = snap?.rows.find(r => r.kind === 'message' && r.id && !prevIds.has(r.id) && r.from_me !== false && normText(r.text) === want);
      if (row) {
        found = { id: row.id!, status: row.status ?? null, ts: row.fiber?.ts ?? null };
        if (found.status && DONE_STATUSES.has(found.status)) break;
        if (found.status && /fail|error/i.test(found.status)) break;
      }
    }
    if (found && found.status && /fail|error/i.test(found.status)) {
      state.rejected = true;
      finishWrite(writeId, 'failed_after_send', found);
      throw new XctlError('X_REJECTED', `XChat marked the message as ${found.status}`, { message_id: found.id });
    }
    if (!found || !found.status || !DONE_STATUSES.has(found.status)) {
      finishWrite(writeId, 'unconfirmed', found);
      throw new XctlError(
        'UNCONFIRMED',
        found
          ? `message ${found.id} appeared but its status is still "${found.status}"; check with \`xctl dm ${convId}\` before resending`
          : `pressed Send but the message did not appear in the thread; check with \`xctl dm ${convId}\` before resending`,
        { send_pressed: true, message_id: found?.id ?? null, status: found?.status ?? null },
      );
    }
    finishWrite(writeId, 'sent', found);
    if (lastIncoming) markHandled(lastIncoming, `dm reply ${found.id}`);
    return {
      sent: true,
      confirmed: true,
      conversation_id: convId,
      message_id: found.id,
      status: found.status,
      text,
      timestamp: found.ts ? new Date(found.ts).toISOString() : null,
      marked_handled: lastIncoming,
      ...(acceptedRequest ? { accepted_request: true } : {}),
    };
  } finally {
    if (typed && !page.isClosed()) await ta.fill('', { timeout: 5_000 }).catch(() => {});
  }
}
