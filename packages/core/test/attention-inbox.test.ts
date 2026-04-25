import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAttentionInbox } from '../src/attention-inbox.js';
import { MemoryStore } from '../src/memory-store.js';
import { TaskThread } from '../src/task-thread.js';

let dir: string;
let store: MemoryStore;

function seed(...ids: string[]): void {
  for (const id of ids) {
    store.startSession({ id, ide: 'claude-code', cwd: '/r' });
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'colony-attention-'));
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('buildAttentionInbox', () => {
  it('aggregates unread messages, pending handoffs, wakes, and recent other-session claims for a participating agent', () => {
    seed('claude', 'codex');
    const thread = TaskThread.open(store, {
      repo_root: '/r',
      branch: 'feat/inbox',
      session_id: 'claude',
    });
    thread.join('claude', 'claude');
    thread.join('codex', 'codex');

    // Claude posts a handoff and a wake request addressed to codex.
    const handoffId = thread.handOff({
      from_session_id: 'claude',
      from_agent: 'claude',
      to_agent: 'codex',
      summary: 'please take the API module',
      transferred_files: ['src/api.ts'],
    });
    const wakeId = thread.requestWake({
      from_session_id: 'claude',
      from_agent: 'claude',
      to_agent: 'codex',
      reason: 'PR review needed',
      next_step: 'look at PR #42',
    });
    const messageId = thread.postMessage({
      from_session_id: 'claude',
      from_agent: 'claude',
      to_agent: 'codex',
      content: 'schema direction is blocking the next slice',
      urgency: 'blocking',
    });
    thread.postMessage({
      from_session_id: 'claude',
      from_agent: 'claude',
      to_agent: 'codex',
      content: 'FYI: docs landed',
      urgency: 'fyi',
    });

    // Claude also claims an unrelated file recently — codex's inbox should
    // surface it as a "recent other-session claim" near their lane.
    thread.claimFile({ session_id: 'claude', file_path: 'src/viewer.tsx' });

    const inbox = buildAttentionInbox(store, {
      session_id: 'codex',
      agent: 'codex',
      task_ids: [thread.task_id],
    });

    expect(inbox.pending_handoffs.map((h) => h.id)).toEqual([handoffId]);
    expect(inbox.pending_wakes.map((w) => w.id)).toEqual([wakeId]);
    expect(inbox.unread_messages.map((m) => m.id)).toContain(messageId);
    expect(inbox.unread_messages.map((m) => m.urgency)).toEqual(
      expect.arrayContaining(['fyi', 'blocking']),
    );
    expect(inbox.pending_wakes[0]?.reason).toBe('PR review needed');
    expect(inbox.pending_wakes[0]?.next_step).toBe('look at PR #42');

    expect(inbox.recent_other_claims.some((c) => c.file_path === 'src/viewer.tsx')).toBe(true);
    expect(inbox.recent_other_claims.every((c) => c.by_session_id !== 'codex')).toBe(true);

    expect(inbox.summary.pending_handoff_count).toBe(1);
    expect(inbox.summary.pending_wake_count).toBe(1);
    expect(inbox.summary.unread_message_count).toBe(2);
    expect(inbox.summary.next_action).toMatch(/blocking task messages/i);
  });

  it("omits the requesting session's own claims and own handoffs", () => {
    seed('claude', 'codex');
    const thread = TaskThread.open(store, {
      repo_root: '/r',
      branch: 'feat/inbox-self',
      session_id: 'claude',
    });
    thread.join('claude', 'claude');
    thread.join('codex', 'codex');

    thread.claimFile({ session_id: 'codex', file_path: 'src/own.ts' });
    thread.handOff({
      from_session_id: 'codex',
      from_agent: 'codex',
      to_agent: 'claude',
      summary: 'sent from codex, so codex must not see it',
    });

    const inbox = buildAttentionInbox(store, {
      session_id: 'codex',
      agent: 'codex',
      task_ids: [thread.task_id],
    });

    expect(inbox.pending_handoffs).toHaveLength(0);
    expect(inbox.recent_other_claims.find((c) => c.file_path === 'src/own.ts')).toBeUndefined();
    expect(inbox.unread_messages).toHaveLength(0);
  });

  it('blocking unread messages set summary.blocked and the message-first next_action', () => {
    seed('claude', 'codex');
    const thread = TaskThread.open(store, {
      repo_root: '/r',
      branch: 'feat/inbox-blocked',
      session_id: 'claude',
    });
    thread.join('claude', 'claude');
    thread.join('codex', 'codex');
    thread.postMessage({
      from_session_id: 'claude',
      from_agent: 'claude',
      to_agent: 'codex',
      content: 'schema choice blocking next slice',
      urgency: 'blocking',
    });

    const inbox = buildAttentionInbox(store, {
      session_id: 'codex',
      agent: 'codex',
      task_ids: [thread.task_id],
    });
    expect(inbox.summary.blocked).toBe(true);
    expect(inbox.summary.next_action).toMatch(/blocking task messages/i);

    // No blocking → blocked=false even with other unread messages.
    const thread2 = TaskThread.open(store, {
      repo_root: '/r',
      branch: 'feat/inbox-not-blocked',
      session_id: 'claude',
    });
    thread2.join('claude', 'claude');
    thread2.join('codex', 'codex');
    thread2.postMessage({
      from_session_id: 'claude',
      from_agent: 'claude',
      to_agent: 'codex',
      content: 'fyi only',
      urgency: 'fyi',
    });
    const inbox2 = buildAttentionInbox(store, {
      session_id: 'codex',
      agent: 'codex',
      task_ids: [thread2.task_id],
    });
    expect(inbox2.summary.blocked).toBe(false);
  });

  it('coalesces non-blocking messages by (task, sender, urgency); blocking groups stay size 1', () => {
    seed('claude', 'codex');
    const thread = TaskThread.open(store, {
      repo_root: '/r',
      branch: 'feat/coalesce',
      session_id: 'claude',
    });
    thread.join('claude', 'claude');
    thread.join('codex', 'codex');
    thread.postMessage({
      from_session_id: 'claude',
      from_agent: 'claude',
      to_agent: 'codex',
      content: 'fyi 1',
      urgency: 'fyi',
    });
    thread.postMessage({
      from_session_id: 'claude',
      from_agent: 'claude',
      to_agent: 'codex',
      content: 'fyi 2',
      urgency: 'fyi',
    });
    thread.postMessage({
      from_session_id: 'claude',
      from_agent: 'claude',
      to_agent: 'codex',
      content: 'urgent',
      urgency: 'blocking',
    });

    const inbox = buildAttentionInbox(store, {
      session_id: 'codex',
      agent: 'codex',
      task_ids: [thread.task_id],
    });
    expect(inbox.unread_messages).toHaveLength(3);

    // Two fyi from same sender on same task should coalesce into one group.
    const fyiGroup = inbox.coalesced_messages.find((g) => g.urgency === 'fyi');
    expect(fyiGroup?.count).toBe(2);
    expect(fyiGroup?.message_ids).toHaveLength(2);

    // Blocking always stays as its own group of size 1.
    const blockingGroups = inbox.coalesced_messages.filter((g) => g.urgency === 'blocking');
    expect(blockingGroups).toHaveLength(1);
    expect(blockingGroups[0]?.count).toBe(1);
  });

  it('surfaces read receipts for needs_reply messages that have been read but not replied', () => {
    seed('claude', 'codex');
    const thread = TaskThread.open(store, {
      repo_root: '/r',
      branch: 'feat/inbox-receipts',
      session_id: 'claude',
    });
    thread.join('claude', 'claude');
    thread.join('codex', 'codex');
    const id = thread.postMessage({
      from_session_id: 'claude',
      from_agent: 'claude',
      to_agent: 'codex',
      content: 'please review',
      urgency: 'needs_reply',
    });
    thread.markMessageRead(id, 'codex');

    const senderInbox = buildAttentionInbox(store, {
      session_id: 'claude',
      agent: 'claude',
      task_ids: [thread.task_id],
    });
    expect(senderInbox.read_receipts).toHaveLength(1);
    expect(senderInbox.read_receipts[0]?.read_message_id).toBe(id);
    expect(senderInbox.read_receipts[0]?.urgency).toBe('needs_reply');
    expect(senderInbox.summary.next_action).toMatch(/recipients have read/i);

    // A reply removes the receipt — the reply is a stronger signal.
    thread.postMessage({
      from_session_id: 'codex',
      from_agent: 'codex',
      to_agent: 'claude',
      content: 'looking',
      reply_to: id,
    });
    const after = buildAttentionInbox(store, {
      session_id: 'claude',
      agent: 'claude',
      task_ids: [thread.task_id],
    });
    expect(after.read_receipts).toHaveLength(0);
  });

  it('returns the quiet-inbox next_action hint when nothing is pending', () => {
    seed('codex');
    const thread = TaskThread.open(store, {
      repo_root: '/r',
      branch: 'feat/inbox-quiet',
      session_id: 'codex',
    });
    thread.join('codex', 'codex');

    const inbox = buildAttentionInbox(store, {
      session_id: 'codex',
      agent: 'codex',
      task_ids: [thread.task_id],
      // Disable hivemind scan side channel by pointing at a fresh repo root
      // that has no .omx state.
      repo_root: dir,
    });

    expect(inbox.pending_handoffs).toHaveLength(0);
    expect(inbox.pending_wakes).toHaveLength(0);
    expect(inbox.unread_messages).toHaveLength(0);
    expect(inbox.summary.next_action).toMatch(/quiet/i);
  });
});
