import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import {
  type AttentionInbox,
  type InboxHandoff,
  type InboxLane,
  type InboxQuotaPendingClaim,
  MemoryStore,
} from '@colony/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as autopilot from '../src/tools/autopilot.js';
import type { AutopilotTickResult } from '../src/tools/autopilot.js';
import type { ToolContext } from '../src/tools/context.js';

const REPO = '/r';
const SESSION = 'session-pilot';
const AGENT = 'claude-code';

let directory: string;
let store: MemoryStore;
let client: Client;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'colony-autopilot-mcp-'));
  store = new MemoryStore({ dbPath: join(directory, 'data.db'), settings: defaultSettings });
  store.startSession({ id: SESSION, ide: AGENT, cwd: REPO });

  const server = new McpServer({ name: 'colony-test', version: '0.0.0' });
  const ctx: ToolContext = {
    store,
    settings: defaultSettings,
    resolveEmbedder: async () => null,
  };
  autopilot.register(server, ctx);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterEach(async () => {
  await client.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('task_autopilot_tick (integration)', () => {
  it('returns no_op with sleep hint when nothing is actionable', async () => {
    const tick = await callTick();
    expect(tick.decision).toBe('no_op');
    expect(tick.next_tool).toBeNull();
    expect(tick.next_args).toBeNull();
    expect(tick.suggested_wake_seconds).toBeGreaterThanOrEqual(300);
    expect(tick.signals.pending_handoff_count).toBe(0);
    expect(tick.signals.ready_subtask_count).toBe(0);
  });
});

describe('decideNextAction (unit)', () => {
  it('routes a pending handoff into accept_handoff with the observation_id', () => {
    const handoff: InboxHandoff = {
      id: 9001,
      task_id: 7,
      from_agent: 'codex',
      from_session_id: 'sender',
      to_agent: AGENT,
      to_session_id: SESSION,
      summary: 'pick up branch agent/lane-1',
      expires_at: Date.now() + 60 * 60_000,
      ts: Date.now(),
    };
    const result = autopilot.decideNextAction(
      makeInbox({ pending_handoffs: [handoff] }),
      makeReady(),
      { session_id: SESSION, agent: AGENT },
    );

    expect(result.decision).toBe('accept_handoff');
    expect(result.next_tool).toBe('task_accept_handoff');
    expect(result.next_args).toEqual({
      session_id: SESSION,
      agent: AGENT,
      observation_id: 9001,
    });
    expect(result.signals.pending_handoff_count).toBe(1);
    expect(result.suggested_wake_seconds).toBeLessThan(300);
  });

  it('routes a quota-pending claim into accept_quota_relay using suggested_actions args', () => {
    const claim = makeQuotaPendingClaim(42, 555);
    const result = autopilot.decideNextAction(
      makeInbox({ quota_pending_claims: [claim] }),
      makeReady(),
      { session_id: SESSION, agent: AGENT },
    );

    expect(result.decision).toBe('accept_quota_relay');
    expect(result.next_tool).toBe('task_claim_quota_accept');
    expect(result.next_args).toMatchObject({
      session_id: SESSION,
      agent: AGENT,
      task_id: 42,
      handoff_observation_id: 555,
    });
  });

  it('classifies "Session start" / "No active swarm" lanes as dead heartbeats', () => {
    const stalled: InboxLane[] = [
      makeLane({ task: 'Session start: mcp-connect', activity: 'dead' }),
      makeLane({ task: 'No active swarm', activity: 'dead' }),
      makeLane({ task: 'fix the auth flow', activity: 'stalled' }),
    ];
    const result = autopilot.decideNextAction(
      makeInbox({ stalled_lanes: stalled }),
      makeReady(),
      { session_id: SESSION, agent: AGENT },
    );

    expect(result.signals.stalled_lane_count).toBe(3);
    expect(result.signals.dead_heartbeat_lane_count).toBe(2);
    expect(result.signals.actionable_stalled_lane_count).toBe(1);
    expect(result.decision).toBe('no_op');
  });

  it('handoff outranks quota relay outranks ready subtask', () => {
    const handoff: InboxHandoff = {
      id: 1,
      task_id: 1,
      from_agent: 'codex',
      from_session_id: 'x',
      to_agent: AGENT,
      to_session_id: SESSION,
      summary: 'take over',
      expires_at: Date.now() + 60_000,
      ts: Date.now(),
    };
    const result = autopilot.decideNextAction(
      makeInbox({
        pending_handoffs: [handoff],
        quota_pending_claims: [makeQuotaPendingClaim(2, 200)],
      }),
      {
        ready: [],
        total_available: 0,
        ready_scope_overlap_warnings: [],
        next_action: 'Claim x',
        claim_required: true,
        next_tool: 'task_plan_claim_subtask',
        claim_args: {
          repo_root: REPO,
          plan_slug: 'x',
          subtask_index: 0,
          session_id: SESSION,
          agent: AGENT,
          file_scope: ['src/foo.ts'],
        },
      },
      { session_id: SESSION, agent: AGENT },
    );

    expect(result.decision).toBe('accept_handoff');
  });
});

function makeInbox(overrides: Partial<AttentionInbox> = {}): AttentionInbox {
  return {
    generated_at: Date.now(),
    session_id: SESSION,
    agent: AGENT,
    summary: {
      pending_handoff_count: overrides.pending_handoffs?.length ?? 0,
      quota_pending_claim_count: overrides.quota_pending_claims?.length ?? 0,
      expired_quota_handoff_count: 0,
      pending_wake_count: 0,
      unread_message_count: overrides.unread_messages?.length ?? 0,
      paused_lane_count: 0,
      stalled_lane_count: overrides.stalled_lanes?.length ?? 0,
      fresh_other_claim_count: 0,
      stale_other_claim_count: 0,
      expired_other_claim_count: 0,
      weak_other_claim_count: 0,
      recent_other_claim_count: 0,
      live_file_contention_count: 0,
      hot_file_count: 0,
      omx_runtime_warning_count: 0,
      blocked: false,
      next_action: 'Idle.',
    },
    pending_handoffs: [],
    quota_pending_claims: [],
    expired_quota_handoffs: [],
    pending_wakes: [],
    unread_messages: [],
    coalesced_messages: [],
    read_receipts: [],
    paused_lanes: [],
    stalled_lanes: [],
    stalled_lanes_truncated: false,
    stale_claim_signals: { stale_claim_count: 0, top_stale_branches: [], sweep_suggestion: '' },
    recent_other_claims: [],
    live_file_contentions: [],
    file_heat: [],
    omx_runtime_warnings: [],
    ...overrides,
  };
}

function makeReady(): {
  ready: never[];
  total_available: number;
  ready_scope_overlap_warnings: never[];
  next_action: string;
} {
  return {
    ready: [],
    total_available: 0,
    ready_scope_overlap_warnings: [],
    next_action: 'Idle.',
  };
}

function makeLane(overrides: Partial<InboxLane>): InboxLane {
  return {
    repo_root: REPO,
    branch: 'main',
    task: 'something',
    owner: 'agent/unknown',
    activity: 'stalled',
    activity_summary: 'inactive',
    worktree_path: REPO,
    updated_at: '2026-05-04T18:00:00.000Z',
    ...overrides,
  };
}

function makeQuotaPendingClaim(taskId: number, observationId: number): InboxQuotaPendingClaim {
  const accept = {
    tool: 'task_claim_quota_accept' as const,
    args: {
      task_id: taskId,
      session_id: 'old-session',
      agent: 'codex',
      handoff_observation_id: observationId,
    },
    codex_mcp_call: '',
  };
  return {
    kind: 'quota_pending_claim',
    task_id: taskId,
    quota_observation_id: observationId,
    quota_observation_kind: 'handoff',
    claim_state: 'handoff_pending',
    old_owner: { session_id: 'old-session', agent: 'codex' },
    files: ['src/x.ts'],
    age: { milliseconds: 60_000, minutes: 1 },
    expires_at: null,
    expired: false,
    evidence: [],
    next: '',
    suggested_actions: {
      accept,
      decline: {
        tool: 'task_claim_quota_decline',
        args: {
          task_id: taskId,
          session_id: 'old-session',
          handoff_observation_id: observationId,
          reason: '',
        },
        codex_mcp_call: '',
      },
      release_expired: {
        tool: 'task_claim_quota_release_expired',
        args: {
          task_id: taskId,
          session_id: 'old-session',
          handoff_observation_id: observationId,
        },
        codex_mcp_call: '',
      },
    },
  };
}

async function callTick(): Promise<AutopilotTickResult> {
  const result = await client.callTool({
    name: 'task_autopilot_tick',
    arguments: { session_id: SESSION, agent: AGENT, repo_root: REPO },
  });
  const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}';
  return JSON.parse(text) as AutopilotTickResult;
}
