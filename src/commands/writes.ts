import { config } from '../config.js';
import { assertWriteAllowed, newWriteState, type WriteState } from '../compose.js';
import { createDraft, draftOut, getDraft, listDrafts, transitionDraft, type DraftKind, type DraftOptions, type DraftStatus } from '../db.js';
import { XctlError, toXctlError } from '../errors.js';
import { emitError } from '../output.js';
import { runBrowser, runLocal, type Session } from '../runner.js';
import { performAccept, performDmSend } from './dmsend.js';
import { performPost } from './post.js';
import { formatWrite, performReply } from './reply.js';

type Perform = (s: Session, target: string, text: string, opts: { dryRun: boolean; draftId?: number; accept?: boolean }, st: WriteState) => Promise<any>;

const PERFORM: Record<DraftKind, Perform> = { post: performPost, reply: performReply, dm: performDmSend, accept: performAccept };
const COMMAND: Record<DraftKind, string> = { post: 'post', reply: 'reply', dm: 'dm-send', accept: 'dm-accept' };

/** post / reply / dm send: queue a draft in approval mode, otherwise send (or dry-run) now. */
export async function sendOrQueue(kind: DraftKind, target: string, text: string, dryRun: boolean, pretty: boolean, options: DraftOptions = {}): Promise<never> {
  if (config.requireApproval && !dryRun) {
    return runLocal(() => {
      const { draft, duplicate } = createDraft(kind, target, text, options);
      throw new XctlError(
        'QUEUED',
        `${duplicate ? 'identical draft already pending' : 'saved as draft'} #${draft.id}; approval required (XCTL_REQUIRE_APPROVAL). Send with \`xctl drafts approve ${draft.id}\``,
        { duplicate },
        { draft_id: draft.id },
      );
    }, { pretty });
  }
  if (!dryRun && kind !== 'accept') {
    try {
      assertWriteAllowed();
    } catch (e) {
      return emitError(toXctlError(e), pretty);
    }
  }
  let st = newWriteState();
  return runBrowser(COMMAND[kind], { pretty, kind: 'write', format: formatWrite, canRestart: () => !st.pressed }, s => {
    st = newWriteState();
    return PERFORM[kind](s, target, text, { dryRun, ...options }, st);
  });
}

export async function approveDraft(id: number, dryRun: boolean, pretty: boolean): Promise<never> {
  const d = getDraft(id);
  if (!d) return emitError(new XctlError('NOT_FOUND', `no draft #${id}`), pretty);
  if (d.status !== 'pending' && d.status !== 'failed') {
    return emitError(new XctlError('INVALID_ARGS', `draft #${id} is ${d.status}; only pending or failed drafts can be approved`), pretty);
  }
  const options: DraftOptions = d.options ? JSON.parse(d.options) : {};
  if (!dryRun && d.kind !== 'accept') {
    try {
      assertWriteAllowed();
    } catch (e) {
      return emitError(toXctlError(e), pretty);
    }
  }
  let st = newWriteState();
  return runBrowser('drafts-approve', { pretty, kind: 'write', format: formatWrite, canRestart: () => !st.pressed }, async s => {
    st = newWriteState();
    if (dryRun) return { draft_id: id, ...(await PERFORM[d.kind](s, d.target, d.text, { dryRun: true, ...options }, st)) };
    if (!transitionDraft(id, ['pending', 'failed'], 'sending')) throw new XctlError('INVALID_ARGS', `draft #${id} changed state; re-check with \`xctl drafts list --all\``);
    try {
      const r = await PERFORM[d.kind](s, d.target, d.text, { dryRun: false, draftId: id, ...options }, st);
      transitionDraft(id, ['sending'], 'sent', { result: r });
      return { draft_id: id, ...r };
    } catch (e) {
      const err = toXctlError(e);
      // After the send button was pressed the outcome is unknown unless X explicitly rejected it: never auto-retry.
      transitionDraft(id, ['sending'], st.pressed && !st.rejected ? 'unconfirmed' : 'failed', { error: { code: err.code, message: err.message } });
      err.top = { ...err.top, draft_id: id };
      throw err;
    }
  });
}

export function rejectDraft(id: number, pretty: boolean): Promise<never> {
  return runLocal(() => {
    const d = getDraft(id);
    if (!d) throw new XctlError('NOT_FOUND', `no draft #${id}`);
    if (!transitionDraft(id, ['pending', 'failed'], 'rejected')) throw new XctlError('INVALID_ARGS', `draft #${id} is ${d.status}; only pending or failed drafts can be rejected`);
    return draftOut(getDraft(id)!);
  }, { pretty, format: (r: any) => `draft #${r.id} rejected` });
}

export function listDraftsCmd(status: DraftStatus | 'all', limit: number, pretty: boolean): Promise<never> {
  return runLocal(() => {
    const drafts = listDrafts(status, limit).map(draftOut);
    return { count: drafts.length, drafts };
  }, {
    pretty,
    format: (d: any) =>
      d.drafts.length
        ? d.drafts
            .map((r: any) => `#${r.id} [${r.status}] ${r.kind}${r.options?.accept ? ' (+accept request)' : ''}${r.target ? ` -> ${r.target}` : ''}  (${r.created_at})${r.text ? `\n    ${r.text.replace(/\n/g, '\n    ')}` : ''}`)
            .join('\n')
        : '(no drafts)',
  });
}
