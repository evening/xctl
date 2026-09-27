import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeRecent } from '../src/recent.js';
import type { ConversationOut } from '../src/commands/dms.js';
import type { MentionOut } from '../src/commands/mentions.js';

const now = new Date('2026-09-27T12:00:00.000Z');
const dm = (id: string, timestamp: string | null, from_me: boolean | null, handled = false) => ({
  conversation_id: id, participants: ['friend'], participant_ids: ['1'], title: null,
  last_message: { id: `message-${id}`, preview: `preview-${id}`, from_me, sender_id: '1', handled },
  timestamp, timestamp_approx: false, time_label: null, unread: false, unread_count: 0, is_request: false,
}) as ConversationOut;
const mention = (id: string, created_at: string | null, replied_by_me: boolean | null, handled = false) => ({
  id, author: 'friend', author_name: 'friend', author_id: '1', text: `post-${id}`,
  created_at, parent_id: null, conversation_id: 'root-1', quoted_id: null,
  url: `https://x.com/friend/status/${id}`, sources: ['search'], replied_by_me,
  my_reply_id: null, handled,
}) as MentionOut;

test('flags a dm preview/thread mismatch and keeps unknown timestamps visible', () => {
  const result = summarizeRecent({
    now, days: 3, requested_count: 20,
    conversations: [dm('stale', null, false)],
    mentions: [mention('102', null, null)],
    threads: new Map([['stale', {
      messages: [{ id: 'older-message', sender: 'friend', sender_id: '1', from_me: false, text: 'older', timestamp: null, timestamp_source: null, status: 'sent' }],
      has_more: true, read_only: false, read_only_reason: null,
    }]]), warnings: [],
  });
  assert.equal(result.dms[0].tail?.matches_inbox, false);
  assert.equal(result.dms[0].tail?.latest_message_id, 'older-message');
  assert.match(result.review_candidates[0].reason, /mismatch/);
  assert.equal(result.coverage.unknown_timestamps, 2);
  assert.deepEqual(result.public_threads[0].mentions.map(m => m.id), ['102']);
});

test('keeps only recent activity, grouping mentions without treating every incoming item as a task', () => {
  const result = summarizeRecent({
    now, days: 3, requested_count: 50,
    conversations: [dm('fresh', '2026-09-26T10:00:00Z', false), dm('old', '2026-09-20T10:00:00Z', false)],
    mentions: [mention('100', '2026-09-26T12:00:00Z', false), mention('101', '2026-09-26T13:00:00Z', true), mention('99', '2026-09-20T10:00:00Z', false)],
    threads: new Map(), warnings: [],
  });
  assert.deepEqual(result.dms.map(x => x.conversation_id), ['fresh']);
  assert.deepEqual(result.public_threads.map(x => x.conversation_id), ['root-1']);
  assert.deepEqual(result.public_threads[0].mentions.map(x => x.id), ['101', '100']);
  assert.deepEqual(result.review_candidates.map(x => [x.kind, x.id]), [['dm', 'message-fresh'], ['mention', '100']]);
  assert.equal(result.review_candidates[0].status, 'candidate_only');
  assert.equal(result.cutoff_at, '2026-09-24T12:00:00.000Z');
});
