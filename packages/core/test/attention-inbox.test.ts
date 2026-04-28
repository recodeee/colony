import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAttentionInbox } from '../src/attention-inbox.js';
import { MemoryStore } from '../src/memory-store.js';
import { listMessagesForAgent } from '../src/messages.js';
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
  vi.useRealTimers();
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
    expect(inbox.file_heat.some((file) => file.file_path === 'src/viewer.tsx')).toBe(true);

    expect(inbox.summary.pending_handoff_count).toBe(1);
    expect(inbox.summary.pending_wake_count).toBe(1);
    expect(inbox.summary.unread_message_count).toBe(2);
    expect(inbox.summary.hot_file_count).toBeGreaterThan(0);
    expect(inbox.summary.next_action).toMatch(/blocking task messages/i);
  });

  it('surfaces compact decaying file heat for participating tasks', () => {
    seed('claude', 'codex');
    const now = Date.parse('2026-04-28T12:00:00.000Z');
    const thread = TaskThread.open(store, {
      repo_root: '/r',
      branch: 'feat/inbox-heat',
      session_id: 'claude',
    });
    thread.join('claude', 'claude');
    thread.join('codex', 'codex');
    store.storage.insertObservation({
      session_id: 'claude',
      kind: 'tool_use',
      content: 'edit hot file',
      compressed: false,
      intensity: null,
      task_id: thread.task_id,
      ts: now - 10 * 60_000,
      metadata: { tool: 'Edit', file_path: 'src/hot.ts' },
    });
    store.storage.insertObservation({
      session_id: 'claude',
      kind: 'tool_use',
      content: 'edit stale file',
      compressed: false,
      intensity: null,
      task_id: thread.task_id,
      ts: now - 90 * 60_000,
      metadata: { tool: 'Edit', file_path: 'src/stale.ts' },
    });

    const inbox = buildAttentionInbox(store, {
      session_id: 'codex',
      agent: 'codex',
      task_ids: [thread.task_id],
      now,
      file_heat_half_life_ms: 10 * 60_000,
      file_heat_min_heat: 0.01,
    });

    expect(inbox.file_heat).toEqual([
      {
        task_id: thread.task_id,
        file_path: 'src/hot.ts',
        heat: 0.5,
        last_activity_ts: now - 10 * 60_000,
        event_count: 1,
      },
    ]);
    expect(inbox.summary.hot_file_count).toBe(1);
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

  it('classifies stale recent claims without counting them as active ownership', () => {
    seed('claude', 'codex');
    const t0 = Date.parse('2026-04-28T12:00:00.000Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0);
    const thread = TaskThread.open(store, {
      repo_root: '/r',
      branch: 'feat/inbox-stale-claims',
      session_id: 'claude',
    });
    thread.join('claude', 'claude');
    thread.join('codex', 'codex');
    thread.claimFile({ session_id: 'claude', file_path: 'src/stale.ts' });

    vi.setSystemTime(t0 + 241 * 60_000);

    const inbox = buildAttentionInbox(store, {
      session_id: 'codex',
      agent: 'codex',
      task_ids: [thread.task_id],
      recent_claim_window_ms: 300 * 60_000,
      claim_stale_ms: 240 * 60_000,
    });

    expect(inbox.summary.recent_other_claim_count).toBe(0);
    expect(inbox.summary.stale_other_claim_count).toBe(1);
    expect(inbox.summary.weak_other_claim_count).toBe(1);
    expect(inbox.recent_other_claims).toEqual([
      expect.objectContaining({
        file_path: 'src/stale.ts',
        age_class: 'stale',
        ownership_strength: 'weak',
      }),
    ]);
  });

  it('shows only live pending handoffs before expiry', () => {
    seed('claude', 'codex');
    const thread = TaskThread.open(store, {
      repo_root: '/r',
      branch: 'feat/handoff-decay',
      session_id: 'claude',
    });
    thread.join('claude', 'claude');
    thread.join('codex', 'codex');

    const live = thread.handOff({
      from_session_id: 'claude',
      from_agent: 'claude',
      to_agent: 'codex',
      summary: 'still live',
      expires_in_ms: 60_000,
    });
    const expired = thread.handOff({
      from_session_id: 'claude',
      from_agent: 'claude',
      to_agent: 'codex',
      summary: 'already stale',
      expires_in_ms: 60_000,
    });
    const accepted = thread.handOff({
      from_session_id: 'claude',
      from_agent: 'claude',
      to_agent: 'codex',
      summary: 'accepted already',
    });
    const declined = thread.handOff({
      from_session_id: 'claude',
      from_agent: 'claude',
      to_agent: 'codex',
      summary: 'declined already',
    });

    const row = store.storage.getObservation(expired);
    const meta = JSON.parse(row?.metadata ?? '{}') as { expires_at: number };
    meta.expires_at = Date.now() - 1000;
    store.storage.updateObservationMetadata(expired, JSON.stringify(meta));
    thread.acceptHandoff(accepted, 'codex');
    thread.declineHandoff(declined, 'codex', 'not my lane');

    const inbox = buildAttentionInbox(store, {
      session_id: 'codex',
      agent: 'codex',
      task_ids: [thread.task_id],
    });

    expect(inbox.pending_handoffs.map((h) => h.id)).toEqual([live]);
    expect(inbox.summary.pending_handoff_count).toBe(1);
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

  it('coalesces fyi messages while keeping blocking messages as singleton groups', () => {
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
    thread.postMessage({
      from_session_id: 'claude',
      from_agent: 'claude',
      to_agent: 'codex',
      content: 'still blocked',
      urgency: 'blocking',
    });

    const inbox = buildAttentionInbox(store, {
      session_id: 'codex',
      agent: 'codex',
      task_ids: [thread.task_id],
    });
    expect(inbox.unread_messages).toHaveLength(4);

    // Two fyi from same sender on same task should coalesce into one group.
    const fyiGroup = inbox.coalesced_messages.find((g) => g.urgency === 'fyi');
    expect(fyiGroup?.count).toBe(2);
    expect(fyiGroup?.message_ids).toHaveLength(2);

    // Blocking always stays as its own group of size 1, even from the
    // same sender on the same task.
    const blockingGroups = inbox.coalesced_messages.filter((g) => g.urgency === 'blocking');
    expect(blockingGroups).toHaveLength(2);
    expect(blockingGroups.every((g) => g.count === 1)).toBe(true);
  });

  it('hides expired unread messages from attention while audit listing surfaces expired', () => {
    seed('claude', 'codex');
    const thread = TaskThread.open(store, {
      repo_root: '/r',
      branch: 'feat/inbox-expired',
      session_id: 'claude',
    });
    thread.join('claude', 'claude');
    thread.join('codex', 'codex');
    const id = thread.postMessage({
      from_session_id: 'claude',
      from_agent: 'claude',
      to_agent: 'codex',
      content: 'short ttl',
      urgency: 'blocking',
      expires_in_ms: 60_000,
    });

    const row = store.storage.getObservation(id);
    const meta = JSON.parse(row?.metadata ?? '{}') as { expires_at: number };
    meta.expires_at = Date.now() - 1000;
    store.storage.updateObservationMetadata(id, JSON.stringify(meta));

    const inbox = buildAttentionInbox(store, {
      session_id: 'codex',
      agent: 'codex',
      task_ids: [thread.task_id],
      now: Date.now(),
    });
    expect(inbox.unread_messages).toHaveLength(0);
    expect(inbox.summary.blocked).toBe(false);

    const audit = listMessagesForAgent(store, {
      session_id: 'codex',
      agent: 'codex',
      task_ids: [thread.task_id],
      unread_only: false,
      now: Date.now(),
    });
    expect(audit.find((m) => m.id === id)?.status).toBe('expired');
  });

  it('drops read and replied messages from attention triggers', () => {
    seed('claude', 'codex');
    const thread = TaskThread.open(store, {
      repo_root: '/r',
      branch: 'feat/inbox-handled',
      session_id: 'claude',
    });
    thread.join('claude', 'claude');
    thread.join('codex', 'codex');
    const readId = thread.postMessage({
      from_session_id: 'claude',
      from_agent: 'claude',
      to_agent: 'codex',
      content: 'read this when possible',
      urgency: 'needs_reply',
    });
    const repliedId = thread.postMessage({
      from_session_id: 'claude',
      from_agent: 'claude',
      to_agent: 'codex',
      content: 'reply to this',
      urgency: 'blocking',
    });

    thread.markMessageRead(readId, 'codex');
    thread.postMessage({
      from_session_id: 'codex',
      from_agent: 'codex',
      to_agent: 'claude',
      content: 'handled',
      reply_to: repliedId,
    });

    const inbox = buildAttentionInbox(store, {
      session_id: 'codex',
      agent: 'codex',
      task_ids: [thread.task_id],
    });
    expect(inbox.unread_messages.map((m) => m.id)).not.toContain(readId);
    expect(inbox.unread_messages.map((m) => m.id)).not.toContain(repliedId);
    expect(inbox.summary.unread_message_count).toBe(0);
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

    // Disable the min-age gate for this assertion. Without it, the
    // receipt is suppressed for the first 5m so the test would race the
    // wall clock; the next test covers the gating semantics directly.
    const senderInbox = buildAttentionInbox(store, {
      session_id: 'claude',
      agent: 'claude',
      task_ids: [thread.task_id],
      read_receipt_min_age_ms: 0,
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
      read_receipt_min_age_ms: 0,
    });
    expect(after.read_receipts).toHaveLength(0);
  });

  it('suppresses fresh read receipts until the min-age window passes', () => {
    seed('claude', 'codex');
    const thread = TaskThread.open(store, {
      repo_root: '/r',
      branch: 'feat/inbox-receipt-ripening',
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

    // Default 5m gate: the receipt exists in storage but is too fresh
    // to surface — recipient might still be typing.
    const fresh = buildAttentionInbox(store, {
      session_id: 'claude',
      agent: 'claude',
      task_ids: [thread.task_id],
    });
    expect(fresh.read_receipts).toHaveLength(0);

    // Advancing the clock past the gate ripens the receipt. We pass
    // `now` rather than mock Date.now so the assertion is explicit.
    const ripe = buildAttentionInbox(store, {
      session_id: 'claude',
      agent: 'claude',
      task_ids: [thread.task_id],
      now: Date.now() + 6 * 60_000,
    });
    expect(ripe.read_receipts).toHaveLength(1);
    expect(ripe.read_receipts[0]?.read_message_id).toBe(id);

    // Custom shorter gate works too — a 1-second window surfaces the
    // receipt almost immediately, which is what tests / hot debug
    // sessions want.
    const custom = buildAttentionInbox(store, {
      session_id: 'claude',
      agent: 'claude',
      task_ids: [thread.task_id],
      read_receipt_min_age_ms: 0,
    });
    expect(custom.read_receipts).toHaveLength(1);
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
