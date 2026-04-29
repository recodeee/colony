import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { type AttentionInbox, MemoryStore, TaskThread, applyAttentionBudget } from '@colony/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type SuggestionPrefaceDeps,
  buildAttentionBudgetSection,
  sessionStart,
} from '../src/handlers/session-start.js';

const NOW = new Date('2026-04-28T10:00:00Z').getTime();

let dir: string;
let repo: string;
let store: MemoryStore;

const noSuggestions: SuggestionPrefaceDeps = {
  resolveEmbedder: async () => null,
  loadCore: async () => null,
};

function fakeGitCheckout(path: string, branch: string): void {
  mkdirSync(join(path, '.git'), { recursive: true });
  writeFileSync(join(path, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`);
}

function createThread(): TaskThread {
  store.startSession({ id: 'A', ide: 'claude-code', cwd: repo });
  store.startSession({ id: 'B', ide: 'codex', cwd: repo });
  const thread = TaskThread.open(store, {
    repo_root: repo,
    branch: 'agent/codex/attention-budget',
    session_id: 'A',
  });
  thread.join('A', 'claude');
  thread.join('B', 'codex');
  return thread;
}

function baseInbox(overrides: Partial<AttentionInbox> = {}): AttentionInbox {
  return {
    generated_at: NOW,
    session_id: 'B',
    agent: 'codex',
    summary: {
      pending_handoff_count: 0,
      expired_quota_handoff_count: 0,
      pending_wake_count: 0,
      unread_message_count: 0,
      paused_lane_count: 0,
      stalled_lane_count: 0,
      fresh_other_claim_count: 0,
      stale_other_claim_count: 0,
      expired_other_claim_count: 0,
      weak_other_claim_count: 0,
      recent_other_claim_count: 0,
      live_file_contention_count: 0,
      hot_file_count: 0,
      blocked: false,
      next_action: 'quiet',
    },
    pending_handoffs: [],
    expired_quota_handoffs: [],
    pending_wakes: [],
    unread_messages: [],
    coalesced_messages: [],
    read_receipts: [],
    paused_lanes: [],
    stalled_lanes: [],
    stalled_lanes_truncated: false,
    stale_claim_signals: {
      stale_claim_count: 0,
      top_stale_branches: [],
      sweep_suggestion: 'no sweep needed; no stale advisory claims found',
    },
    recent_other_claims: [],
    live_file_contentions: [],
    file_heat: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  dir = mkdtempSync(join(tmpdir(), 'colony-attention-budget-'));
  repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  fakeGitCheckout(repo, 'agent/codex/attention-budget');
  store = new MemoryStore({
    dbPath: join(dir, 'data.db'),
    settings: {
      ...defaultSettings,
      foraging: { ...defaultSettings.foraging, enabled: false },
    },
  });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('SessionStart attention budget preface', () => {
  it('omits the Attention section when the inbox is empty', async () => {
    const preface = await sessionStart(
      store,
      { session_id: 'B', ide: 'codex', cwd: repo },
      noSuggestions,
    );

    expect(preface).not.toContain('Attention (0 of 0)');
    expect(preface).not.toContain('Attention (');
  });

  it('shows the top 3 needs_reply items and collapses the rest', () => {
    const thread = createThread();
    for (let i = 0; i < 5; i += 1) {
      thread.postMessage({
        from_session_id: 'A',
        from_agent: 'claude',
        to_agent: 'codex',
        content: `needs ${i}`,
        urgency: 'needs_reply',
        expires_in_ms: (50 - i * 10) * 60_000,
      });
    }

    const section = buildAttentionBudgetSection(store, {
      session_id: 'B',
      ide: 'codex',
      cwd: repo,
    });

    expect(section).toContain('Attention (3 of 5):');
    expect(section).toMatch(
      /needs_reply: claude: needs 4[\s\S]*needs_reply: claude: needs 3[\s\S]*needs_reply: claude: needs 2/,
    );
    expect(section).not.toContain('needs 1');
    expect(section).not.toContain('needs 0');
    expect(section).toContain(
      'Plus 2 needs_reply items collapsed. Run attention_inbox to see all.',
    );
  });

  it('uses the budgeted section for full SessionStart attention rendering', async () => {
    const thread = createThread();
    thread.postMessage({
      from_session_id: 'A',
      from_agent: 'claude',
      to_agent: 'codex',
      content: 'blocking schema call',
      urgency: 'blocking',
      expires_in_ms: 60 * 60_000,
    });
    for (let i = 0; i < 4; i += 1) {
      thread.postMessage({
        from_session_id: 'A',
        from_agent: 'claude',
        to_agent: 'codex',
        content: `reply ${i}`,
        urgency: 'needs_reply',
        expires_in_ms: (40 - i * 10) * 60_000,
      });
    }

    const preface = await sessionStart(
      store,
      { session_id: 'B', ide: 'codex', cwd: repo },
      noSuggestions,
    );

    expect(preface).toContain('Attention (3 of 5):');
    expect(preface).toContain('→ blocking: claude: blocking schema call');
    expect(preface).toContain(
      'Plus 2 needs_reply items collapsed. Run attention_inbox to see all.',
    );
    expect(preface).not.toContain('BLOCKING MESSAGE');
    expect(preface).not.toContain('MESSAGE NEEDS REPLY');
    expect(preface).not.toContain('FYI MESSAGES');
  });

  it('keeps blocking prominent before fyi and collapses fyi-only items', () => {
    const thread = createThread();
    for (let i = 0; i < 4; i += 1) {
      thread.postMessage({
        from_session_id: 'A',
        from_agent: 'claude',
        to_agent: 'codex',
        content: `fyi ${i}`,
        urgency: 'fyi',
        expires_in_ms: (i + 1) * 60_000,
      });
    }
    thread.postMessage({
      from_session_id: 'A',
      from_agent: 'claude',
      to_agent: 'codex',
      content: 'blocking late expiry',
      urgency: 'blocking',
      expires_in_ms: 60 * 60_000,
    });

    const section = buildAttentionBudgetSection(store, {
      session_id: 'B',
      ide: 'codex',
      cwd: repo,
    });

    expect(section).toContain('Attention (1 of 5):');
    expect(section).toMatch(/→ blocking: claude: blocking late expiry/);
    expect(section).not.toContain('fyi 0');
    expect(section).not.toContain('fyi 3');
    expect(section).toContain('Plus 4 fyi items collapsed. Run attention_inbox to see all.');
  });

  it('keeps every blocking message prominent even past the normal cap', () => {
    const thread = createThread();
    for (let i = 0; i < 4; i += 1) {
      thread.postMessage({
        from_session_id: 'A',
        from_agent: 'claude',
        to_agent: 'codex',
        content: `blocking ${i}`,
        urgency: 'blocking',
        expires_in_ms: (i + 1) * 60_000,
      });
    }
    thread.postMessage({
      from_session_id: 'A',
      from_agent: 'claude',
      to_agent: 'codex',
      content: 'needs reply',
      urgency: 'needs_reply',
      expires_in_ms: 60 * 60_000,
    });

    const section = buildAttentionBudgetSection(store, {
      session_id: 'B',
      ide: 'codex',
      cwd: repo,
    });

    expect(section).toContain('Attention (4 of 5):');
    expect(section).toMatch(
      /blocking: claude: blocking 0[\s\S]*blocking: claude: blocking 1[\s\S]*blocking: claude: blocking 2[\s\S]*blocking: claude: blocking 3/,
    );
    expect(section).toContain('Plus 1 needs_reply item collapsed. Run attention_inbox to see all.');
  });

  it('sorts same-urgency items by expires_at ascending', () => {
    const inbox = baseInbox({
      pending_handoffs: [
        {
          id: 1,
          task_id: 1,
          from_agent: 'claude',
          from_session_id: 'A',
          to_agent: 'codex',
          to_session_id: null,
          summary: 'third',
          expires_at: NOW + 30 * 60_000,
          ts: NOW,
        },
        {
          id: 2,
          task_id: 1,
          from_agent: 'claude',
          from_session_id: 'A',
          to_agent: 'codex',
          to_session_id: null,
          summary: 'first',
          expires_at: NOW + 10 * 60_000,
          ts: NOW,
        },
        {
          id: 3,
          task_id: 1,
          from_agent: 'claude',
          from_session_id: 'A',
          to_agent: 'codex',
          to_session_id: null,
          summary: 'second',
          expires_at: NOW + 20 * 60_000,
          ts: NOW,
        },
      ],
    });

    const budget = applyAttentionBudget(inbox);

    expect(budget.prominent.map((item) => item.summary)).toEqual([
      'claude needs your accept on handoff #2: first',
      'claude needs your accept on handoff #3: second',
      'claude needs your accept on handoff #1: third',
    ]);
  });

  it('is pure for the same inbox and options', () => {
    const inbox = baseInbox({
      unread_messages: [
        {
          id: 1,
          task_id: 1,
          ts: NOW - 10_000,
          from_session_id: 'A',
          from_agent: 'claude',
          to_agent: 'codex',
          to_session_id: null,
          urgency: 'needs_reply',
          status: 'unread',
          reply_to: null,
          preview: 'reply please',
          expires_at: null,
          is_claimable_broadcast: false,
          claimed_by_session_id: null,
          claimed_by_agent: null,
          reply_tool: 'task_message',
          suggested_reply_args: {
            task_id: 1,
            session_id: 'B',
            agent: 'codex',
            to_agent: 'any',
            to_session_id: 'A',
            reply_to: 1,
            urgency: 'fyi',
            content: '...',
          },
          reply_args: {
            task_id: 1,
            session_id: 'B',
            agent: 'codex',
            to_agent: 'any',
            to_session_id: 'A',
            reply_to: 1,
            urgency: 'fyi',
            content: '...',
          },
          reply_with_tool: 'task_message',
          reply_with_args: {
            task_id: 1,
            session_id: 'B',
            agent: 'codex',
            to_agent: 'any',
            to_session_id: 'A',
            reply_to: 1,
            urgency: 'fyi',
            content: '...',
          },
          mark_read_tool: 'task_message_mark_read',
          mark_read_args: {
            message_observation_id: 1,
            session_id: 'B',
          },
          mark_read_with_tool: 'task_message_mark_read',
          mark_read_with_args: {
            message_observation_id: 1,
            session_id: 'B',
          },
        },
      ],
    });

    expect(applyAttentionBudget(inbox)).toEqual(applyAttentionBudget(inbox));
  });
});
