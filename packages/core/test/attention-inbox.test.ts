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
