import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAttentionInbox } from '../src/attention-inbox.js';
import { ingestOmxRuntimeSummary } from '../src/omx-runtime-summary.js';
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

function writeActiveSession(
  repoRoot: string,
  sessionId: string,
  args: { agentName: string; branch: string; now: number },
): void {
  const sessionDir = join(repoRoot, '.omx', 'state', 'active-sessions');
  mkdirSync(sessionDir, { recursive: true });
  const heartbeat = new Date(args.now).toISOString();
  writeFileSync(
    join(sessionDir, `${sessionId}.json`),
    `${JSON.stringify(
      {
        repoRoot,
        branch: args.branch,
        taskName: `${args.agentName} live contention`,
        latestTaskPreview: 'claiming shared file',
        agentName: args.agentName,
        cliName: args.agentName,
        worktreePath: join(repoRoot, '.omx', 'agent-worktrees', sessionId),
        startedAt: heartbeat,
        lastHeartbeatAt: heartbeat,
        state: 'working',
        sessionKey: sessionId,
      },
      null,
      2,
    )}\n`,
  );
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

  it('caps stalled lane rows while preserving the total count', () => {
    const repo = join(dir, 'repo-stalled-lanes');
    const sessionDir = join(repo, '.omx', 'state', 'active-sessions');
    const now = Date.parse('2026-04-29T10:00:00.000Z');
    mkdirSync(sessionDir, { recursive: true });

    for (let i = 0; i < 12; i += 1) {
      const heartbeat = new Date(now - (10 * 60_000 + i * 1000)).toISOString();
      const worktreePath = join(repo, '.omx', 'agent-worktrees', `agent__codex__stalled-${i}`);
      mkdirSync(worktreePath, { recursive: true });
      writeFileSync(
        join(sessionDir, `agent__codex__stalled-${i}.json`),
        `${JSON.stringify(
          {
            repoRoot: repo,
            branch: `agent/codex/stalled-${i}`,
            taskName: `Stalled task ${i}`,
            latestTaskPreview: `Stalled lane ${i}`,
            agentName: 'codex',
            worktreePath,
            startedAt: heartbeat,
            lastHeartbeatAt: heartbeat,
            state: 'working',
          },
          null,
          2,
        )}\n`,
      );
    }

    const inbox = buildAttentionInbox(store, {
      session_id: 'codex',
      agent: 'codex',
      repo_root: repo,
      now,
    });

    expect(inbox.summary.stalled_lane_count).toBe(12);
    expect(inbox.stalled_lanes).toHaveLength(8);
    expect(inbox.stalled_lanes_truncated).toBe(true);
    expect(inbox.summary.next_action).toMatch(/stalled lanes/i);

    const narrowed = buildAttentionInbox(store, {
      session_id: 'codex',
      agent: 'codex',
      repo_root: repo,
      stalled_lane_limit: 3,
      now,
    });

    expect(narrowed.summary.stalled_lane_count).toBe(12);
    expect(narrowed.stalled_lanes).toHaveLength(3);
    expect(narrowed.stalled_lanes_truncated).toBe(true);
  });

  it('surfaces live file contention for two live sessions claiming the same normalized file', () => {
    const now = Date.parse('2026-04-29T10:00:00.000Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    const repo = join(dir, 'repo-live-contention');
    mkdirSync(repo, { recursive: true });
    seed('claude-live', 'codex-live');
    writeActiveSession(repo, 'claude-live', {
      agentName: 'claude',
      branch: 'agent/claude/contention-owner',
      now,
    });
    writeActiveSession(repo, 'codex-live', {
      agentName: 'codex',
      branch: 'agent/codex/contention-requester',
      now,
    });

    const ownerThread = TaskThread.open(store, {
      repo_root: repo,
      branch: 'agent/claude/contention-owner',
      session_id: 'claude-live',
    });
    ownerThread.join('claude-live', 'claude');
    ownerThread.claimFile({ session_id: 'claude-live', file_path: './src/shared.ts' });

    const requesterThread = TaskThread.open(store, {
      repo_root: repo,
      branch: 'agent/codex/contention-requester',
      session_id: 'codex-live',
    });
    requesterThread.join('codex-live', 'codex');
    requesterThread.claimFile({ session_id: 'codex-live', file_path: 'src/shared.ts' });

    const inbox = buildAttentionInbox(store, {
      session_id: 'codex-live',
      agent: 'codex',
      task_ids: [requesterThread.task_id],
      repo_root: repo,
      now,
    });

    expect(inbox.summary.live_file_contention_count).toBe(1);
    expect(inbox.summary.next_action).toMatch(/LIVE_FILE_CONTENTION/);
    expect(inbox.live_file_contentions).toEqual([
      {
        code: 'LIVE_FILE_CONTENTION',
        owner_session_id: 'claude-live',
        owner_agent: 'claude',
        owner_branch: 'agent/claude/contention-owner',
        owner_task_id: ownerThread.task_id,
        file_path: 'src/shared.ts',
        last_seen: new Date(now).toISOString(),
      },
    ]);
  });

  it('surfaces paused lanes as attention items', () => {
    seed('codex@old', 'codex@new');
    const thread = TaskThread.open(store, {
      repo_root: '/r',
      branch: 'agent/codex/paused-lane',
      title: 'Paused lane task',
      session_id: 'codex@old',
    });
    thread.join('codex@old', 'codex');
    thread.join('codex@new', 'codex');
    store.storage.setLaneState({
      session_id: 'codex@old',
      state: 'paused',
      updated_by_session_id: 'human:ops',
      reason: 'waiting for takeover decision',
      updated_at: 1234,
    });

    const inbox = buildAttentionInbox(store, {
      session_id: 'codex@new',
      agent: 'codex',
      repo_root: '/r',
      task_ids: [thread.task_id],
      include_stalled_lanes: false,
    });

    expect(inbox.summary.paused_lane_count).toBe(1);
    expect(inbox.paused_lanes).toEqual([
      expect.objectContaining({
        session_id: 'codex@old',
        task_id: thread.task_id,
        repo_root: '/r',
        branch: 'agent/codex/paused-lane',
        reason: 'waiting for takeover decision',
        paused_by_session_id: 'human:ops',
      }),
    ]);
    expect(inbox.summary.next_action).toMatch(/paused lanes/i);
  });

  it('adds compact reply and mark-read suggestions to unread message items', () => {
    seed('claude', 'codex');
    const thread = TaskThread.open(store, {
      repo_root: '/r',
      branch: 'feat/inbox-message-actions',
      session_id: 'claude',
    });
    thread.join('claude', 'claude');
    thread.join('codex', 'codex');
    const needsReplyId = thread.postMessage({
      from_session_id: 'claude',
      from_agent: 'claude',
      to_agent: 'codex',
      content: 'please choose the schema',
      urgency: 'needs_reply',
    });
    const fyiId = thread.postMessage({
      from_session_id: 'claude',
      from_agent: 'claude',
      to_agent: 'codex',
      content: 'context only',
      urgency: 'fyi',
    });

    const inbox = buildAttentionInbox(store, {
      session_id: 'codex',
      agent: 'codex',
      task_ids: [thread.task_id],
    });
    const needsReply = inbox.unread_messages.find((m) => m.id === needsReplyId);
    expect(needsReply).toMatchObject({
      reply_tool: 'task_message',
      suggested_reply_args: {
        task_id: thread.task_id,
        session_id: 'codex',
        agent: 'codex',
        to_agent: 'any',
        to_session_id: 'claude',
        reply_to: needsReplyId,
        urgency: 'fyi',
        content: '...',
      },
      reply_with_tool: 'task_message',
      reply_args: {
        task_id: thread.task_id,
        session_id: 'codex',
        agent: 'codex',
        to_agent: 'any',
        to_session_id: 'claude',
        reply_to: needsReplyId,
        urgency: 'fyi',
        content: '...',
      },
      reply_with_args: {
        task_id: thread.task_id,
        session_id: 'codex',
        agent: 'codex',
        to_agent: 'any',
        to_session_id: 'claude',
        reply_to: needsReplyId,
        urgency: 'fyi',
        content: '...',
      },
      mark_read_tool: 'task_message_mark_read',
      mark_read_with_tool: 'task_message_mark_read',
      mark_read_args: {
        message_observation_id: needsReplyId,
        session_id: 'codex',
      },
      mark_read_with_args: {
        message_observation_id: needsReplyId,
        session_id: 'codex',
      },
    });
    expect(needsReply?.next_action).toMatch(/Reply with task_message/);

    const fyi = inbox.unread_messages.find((m) => m.id === fyiId);
    expect(fyi?.reply_tool).toBe('task_message');
    expect(fyi?.reply_with_tool).toBe('task_message');
    expect(fyi?.mark_read_tool).toBe('task_message_mark_read');
    expect(fyi?.mark_read_with_tool).toBe('task_message_mark_read');
    expect(fyi).not.toHaveProperty('next_action');
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

  it('routes stale recent claims into cleanup signals instead of active ownership', () => {
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
    expect(inbox.recent_other_claims).toEqual([]);
    expect(inbox.stale_claim_signals).toMatchObject({
      stale_claim_count: 1,
      top_stale_branches: [
        {
          repo_root: '/r',
          branch: 'feat/inbox-stale-claims',
          stale_claim_count: 1,
          expired_weak_claim_count: 0,
          oldest_claim_age_minutes: 241,
        },
      ],
    });
    expect(inbox.stale_claim_signals.sweep_suggestion).toContain('review 1 stale advisory claim');
    expect(inbox.stale_claim_signals.top_stale_branches[0]?.sweep_suggestion).toContain(
      'before release or handoff',
    );
  });

  it('surfaces repo-wide stale claim signals outside the recent active-claim window', () => {
    seed('claude', 'codex');
    const t0 = Date.parse('2026-04-28T12:00:00.000Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0);

    const busyThread = TaskThread.open(store, {
      repo_root: '/r',
      branch: 'agent/busy-old',
      session_id: 'claude',
    });
    busyThread.claimFile({ session_id: 'claude', file_path: 'src/old-a.ts' });
    busyThread.claimFile({ session_id: 'claude', file_path: 'src/old-b.ts' });

    const quietThread = TaskThread.open(store, {
      repo_root: '/r',
      branch: 'agent/quiet-old',
      session_id: 'claude',
    });
    quietThread.claimFile({ session_id: 'claude', file_path: 'src/old-c.ts' });

    vi.setSystemTime(t0 + 481 * 60_000);

    const inbox = buildAttentionInbox(store, {
      session_id: 'codex',
      agent: 'codex',
      repo_root: '/r',
      now: Date.now(),
      recent_claim_window_ms: 15 * 60_000,
      claim_stale_ms: 240 * 60_000,
    });

    expect(inbox.recent_other_claims).toEqual([]);
    expect(inbox.summary.recent_other_claim_count).toBe(0);
    expect(inbox.summary.stale_other_claim_count).toBe(0);
    expect(inbox.stale_claim_signals.stale_claim_count).toBe(3);
    expect(inbox.stale_claim_signals.sweep_suggestion).toContain('including 3 expired/weak claim');
    expect(inbox.stale_claim_signals.top_stale_branches).toEqual([
      expect.objectContaining({
        branch: 'agent/busy-old',
        stale_claim_count: 2,
        expired_weak_claim_count: 2,
        oldest_claim_age_minutes: 481,
      }),
      expect.objectContaining({
        branch: 'agent/quiet-old',
        stale_claim_count: 1,
        expired_weak_claim_count: 1,
        oldest_claim_age_minutes: 481,
      }),
    ]);
    expect(inbox.summary.next_action).toMatch(/stale claim cleanup signal/i);
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

  it('surfaces high-value OMX runtime warnings for task recovery', () => {
    seed('codex');
    const thread = TaskThread.open(store, {
      repo_root: '/r',
      branch: 'feat/omx-warning',
      session_id: 'codex',
    });
    thread.join('codex', 'codex');
    ingestOmxRuntimeSummary(store, {
      session_id: 'codex',
      repo_root: '/r',
      branch: 'feat/omx-warning',
      quota_warning: 'Usage limit near',
      last_failed_tool: { name: 'Edit', error: 'permission denied' },
      active_file_focus: ['src/runtime.ts'],
    });

    const inbox = buildAttentionInbox(store, {
      session_id: 'codex',
      agent: 'codex',
      task_ids: [thread.task_id],
      include_stalled_lanes: false,
    });

    expect(inbox.summary.omx_runtime_warning_count).toBe(1);
    expect(inbox.summary.next_action).toContain('OMX runtime warnings');
    expect(inbox.omx_runtime_warnings[0]).toMatchObject({
      task_id: thread.task_id,
      warnings: ['quota_warning', 'last_failed_tool'],
      active_file_focus: ['src/runtime.ts'],
    });
  });
});
