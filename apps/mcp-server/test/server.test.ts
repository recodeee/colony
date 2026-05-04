import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { MemoryStore, PheromoneSystem, TaskThread } from '@colony/core';
import { Client } from '@modelcontextprotocol/sdk/client';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/server.js';

let dir: string;
let store: MemoryStore;
let client: Client;

async function seed(): Promise<{ a: number; b: number }> {
  store.startSession({ id: 's1', ide: 'test', cwd: '/tmp' });
  const a = store.addObservation({
    session_id: 's1',
    kind: 'note',
    content: 'The db config lives at /etc/caveman.conf.',
  });
  const b = store.addObservation({
    session_id: 's1',
    kind: 'note',
    content: 'Please just run `cargo build --release` tomorrow.',
  });
  return { a, b };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'colony-mcp-'));
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
  const server = buildServer(store, defaultSettings);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterEach(async () => {
  vi.useRealTimers();
  await client.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('MCP server', () => {
  it('lists the colony tools', async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect(tools.map((t) => t.name).sort()).toEqual([
      'agent_get_profile',
      'agent_upsert_profile',
      'attention_inbox',
      'bridge_status',
      'examples_integrate_plan',
      'examples_list',
      'examples_query',
      'get_observations',
      'hivemind',
      'hivemind_context',
      'list_sessions',
      'openspec_sync_status',
      'queen_plan_goal',
      'recall_session',
      'rescue_stranded_run',
      'rescue_stranded_scan',
      'search',
      'spec_archive',
      'spec_build_context',
      'spec_build_record_failure',
      'spec_change_add_delta',
      'spec_change_open',
      'spec_read',
      'startup_panel',
      'task_accept_handoff',
      'task_accept_relay',
      'task_autopilot_tick',
      'task_claim_file',
      'task_claim_quota_accept',
      'task_claim_quota_decline',
      'task_claim_quota_release_expired',
      'task_decline_handoff',
      'task_decline_relay',
      'task_drift_check',
      'task_foraging_report',
      'task_hand_off',
      'task_link',
      'task_links',
      'task_list',
      'task_message',
      'task_message_claim',
      'task_message_mark_read',
      'task_message_retract',
      'task_messages',
      'task_note_working',
      'task_plan_claim_subtask',
      'task_plan_complete_subtask',
      'task_plan_list',
      'task_plan_publish',
      'task_plan_status_for_spec_row',
      'task_plan_validate',
      'task_post',
      'task_propose',
      'task_ready_for_agent',
      'task_reinforce',
      'task_relay',
      'task_suggest_approach',
      'task_timeline',
      'task_unlink',
      'task_updates_since',
      'timeline',
    ]);
    const taskPostDescription = byName.get('task_post')?.description ?? '';
    expect(taskPostDescription).toMatch(/^Post shared task notes/);
    expect(taskPostDescription).toContain(
      'Use task_message for directed agent-to-agent coordination',
    );
    expect(taskPostDescription).toContain('Use task_note_working');
    expect(taskPostDescription).toContain('unknown task_id');
    expect(taskPostDescription).toContain('task_propose recommendation');
    expect(taskPostDescription.length).toBeLessThanOrEqual(240);
    const taskNoteWorkingDescription = byName.get('task_note_working')?.description ?? '';
    expect(taskNoteWorkingDescription).toMatch(
      /^Save current working state to the active Colony task/,
    );
    expect(taskNoteWorkingDescription).toContain('write working note');
    expect(taskNoteWorkingDescription).toContain('save current state');
    expect(taskNoteWorkingDescription).toContain('remember progress');
    expect(taskNoteWorkingDescription).toContain('log what I am doing');
    expect(taskNoteWorkingDescription).toContain('notepad replacement');
    expect(taskNoteWorkingDescription).toContain('First write path');
    expect(taskNoteWorkingDescription).toContain('repo_root/branch');
    expect(taskNoteWorkingDescription).toContain('compact candidates');
    expect(taskNoteWorkingDescription.length).toBeLessThanOrEqual(240);
    expect(byName.get('task_note_working')?.inputSchema.required).toEqual([
      'session_id',
      'content',
    ]);
    expect(byName.get('task_note_working')?.inputSchema.properties).toHaveProperty(
      'candidate_limit',
    );
    expect(byName.get('task_note_working')?.inputSchema.properties).toHaveProperty('pointer');
    expect(byName.get('task_note_working')?.inputSchema.properties).toHaveProperty(
      'allow_omx_notepad_fallback',
    );
    expect(byName.get('openspec_sync_status')?.description).toContain(
      'Report drift between Colony task state and OpenSpec durable artifacts',
    );
    expect(byName.get('task_message')?.inputSchema.required).toEqual([
      'task_id',
      'session_id',
      'agent',
      'content',
    ]);
    expect(byName.has('task_wake')).toBe(false);
    expect(byName.has('task_ack_wake')).toBe(false);
    expect(byName.has('task_cancel_wake')).toBe(false);
    expect(byName.get('task_hand_off')?.description).toContain(
      'Fallback when task_relay is unavailable',
    );
    const taskMessageDescription = byName.get('task_message')?.description ?? '';
    expect(taskMessageDescription).toMatch(/^Send a message to another agent on a task thread\./);
    expect(taskMessageDescription).toContain('Defaults to fyi broadcast');
    expect(taskMessageDescription.length).toBeLessThanOrEqual(240);
    expect(byName.get('task_messages')?.description).toMatch(/^Read unread messages\./);
    expect(byName.get('task_messages')?.description).toContain(
      'fetch full bodies via get_observations',
    );
    expect(byName.get('task_message_mark_read')?.description).toMatch(/^Mark message read\./);
    expect(byName.get('task_message_claim')?.description).toMatch(/^Claim broadcast\./);
    expect(byName.get('task_message_retract')?.description).toMatch(/^Retract sent message\./);
    expect(byName.get('queen_plan_goal')?.description).toContain(
      'Decompose a high-level goal into colony sub-tasks and publish them as a plan. Use this when you have a multi-step goal and want other agents to claim parts in parallel.',
    );
    expect(byName.get('queen_plan_goal')?.description).toContain(
      'auto_archive=true, and sub-tasks can be claimed through the task_plan_claim_subtask MCP tool',
    );
    const attentionDescription = byName.get('attention_inbox')?.description ?? '';
    expect(attentionDescription).toMatch(
      /^See what needs your attention after hivemind_context: handoffs, unread messages, blockers, stalled lanes, recent claims, stale claim cleanup signals, and decaying hot files\./,
    );
    const leadingAttention = attentionDescription.slice(0, 180).toLowerCase();
    expect(leadingAttention).toContain('after hivemind_context');
    expect(leadingAttention).toContain('handoffs');
    expect(leadingAttention).toContain('unread messages');
    expect(leadingAttention).toContain('blockers');
    expect(leadingAttention).toContain('stalled lanes');
    expect(leadingAttention).toContain('recent claims');
    expect(attentionDescription).toContain('Expired handoffs are not surfaced as pending');
    expect(attentionDescription).toContain('stale claim cleanup signals');
    expect(attentionDescription).toContain('decaying hot files');
    expect(byName.get('attention_inbox')?.inputSchema.properties).toHaveProperty(
      'file_heat_half_life_minutes',
    );
    expect(attentionDescription).toContain('main surface where task_message items show up');
    const bridgeDescription = byName.get('bridge_status')?.description ?? '';
    expect(bridgeDescription).toMatch(/^Show compact bridge status/);
    expect(bridgeDescription).toContain('OMX HUD/status');
    expect(bridgeDescription).toContain('without observation bodies');
    const readyDescription = byName.get('task_ready_for_agent')?.description ?? '';
    expect(readyDescription).toMatch(
      /^Find the next task to claim for this agent\. Use this when deciding what to work on\./,
    );
    expect(readyDescription.toLowerCase()).toContain('next task');
    expect(readyDescription.toLowerCase()).toContain('claim');
    expect(readyDescription.toLowerCase()).toContain('work');
    expect(readyDescription.toLowerCase().indexOf('next task')).toBeLessThan(80);
    const startupDescription = byName.get('startup_panel')?.description ?? '';
    expect(startupDescription).toMatch(/^Compact startup\/resume panel\./);
    expect(startupDescription).toContain('active task');
    expect(startupDescription).toContain('ready work');
    expect(startupDescription).toContain('exact next MCP call');
    const taskListDescription = byName.get('task_list')?.description ?? '';
    expect(taskListDescription).toMatch(/^Browse task threads;/);
    expect(taskListDescription).toContain('use task_ready_for_agent when choosing work to claim');
    expect(taskListDescription).not.toMatch(/^Find task threads/);
    expect(byName.get('task_hand_off')?.description).toMatch(/^Give work to another agent/);
    expect(byName.get('hivemind_context')?.description).toContain(
      'Before editing, inspect ownership',
    );
  });

  it('keeps claim-before-edit language discoverable and soft', async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const claimDescription = byName.get('task_claim_file')?.description ?? '';
    const hivemindDescription = byName.get('hivemind_context')?.description ?? '';
    const docs = readFileSync(new URL('../../../docs/mcp.md', import.meta.url), 'utf8');

    expect(claimDescription).toContain(
      'Claim a file before editing so other agents see ownership and overlap warnings.',
    );
    expect(claimDescription).toContain('avoid conflict');
    expect(claimDescription).toContain('file ownership');
    expect(claimDescription).toContain('never block writes');
    expect(hivemindDescription).toContain(
      'Before editing, inspect ownership, then call attention_inbox now before choosing work.',
    );
    expect(docs).toContain(
      'Before editing, inspect ownership, then claim touched files on the active task.',
    );
    expect(docs).toContain('Claims are warnings, not locks. They never block writes.');
    expect(docs).toContain('"name": "hivemind_context"');
    expect(docs).toContain('"name": "task_claim_file"');
  });

  it('hivemind returns compact active-session task state', async () => {
    const repoRoot = join(dir, 'repo');
    const worktreePath = join(repoRoot, '.omx', 'agent-worktrees', 'agent__codex__live-task');
    const activeSessionDir = join(repoRoot, '.omx', 'state', 'active-sessions');
    const now = new Date().toISOString();
    mkdirSync(activeSessionDir, { recursive: true });
    mkdirSync(worktreePath, { recursive: true });
    writeFileSync(
      join(activeSessionDir, 'agent__codex__live-task.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          repoRoot,
          branch: 'agent/codex/live-task',
          taskName: 'Ship hivemind MCP tool',
          latestTaskPreview: 'Expose runtime tasks to Codex',
          agentName: 'codex',
          worktreePath,
          pid: process.pid,
          cliName: 'codex',
          taskMode: 'caveman',
          openspecTier: 'T1',
          taskRoutingReason: 'runtime lookup',
          startedAt: now,
          lastHeartbeatAt: now,
          state: 'working',
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const res = await client.callTool({
      name: 'hivemind',
      arguments: { repo_root: repoRoot, limit: 5 },
    });
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}';
    const payload = JSON.parse(text) as {
      session_count: number;
      counts: Record<string, number>;
      sessions: Array<Record<string, unknown>>;
    };

    expect(payload.session_count).toBe(1);
    expect(payload.counts.working).toBe(1);
    expect(payload.sessions[0]).toMatchObject({
      branch: 'agent/codex/live-task',
      task: 'Expose runtime tasks to Codex',
      task_name: 'Ship hivemind MCP tool',
      agent: 'codex',
      activity: 'working',
      source: 'active-session',
      pid_alive: true,
    });
    expect(payload.sessions[0]).not.toHaveProperty('content');
  });

  it('hivemind_context returns lanes plus compact memory hits', async () => {
    const repoRoot = join(dir, 'repo-context');
    const worktreePath = join(repoRoot, '.omx', 'agent-worktrees', 'agent__codex__context-task');
    const activeSessionDir = join(repoRoot, '.omx', 'state', 'active-sessions');
    const now = new Date().toISOString();
    mkdirSync(activeSessionDir, { recursive: true });
    mkdirSync(worktreePath, { recursive: true });
    writeFileSync(
      join(activeSessionDir, 'agent__codex__context-task.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          repoRoot,
          branch: 'agent/codex/context-task',
          taskName: 'Ship hivemind context',
          latestTaskPreview: 'Expose compact context for active lanes',
          agentName: 'codex',
          worktreePath,
          pid: process.pid,
          cliName: 'codex',
          startedAt: now,
          lastHeartbeatAt: now,
          state: 'working',
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    store.startSession({ id: 'ctx', ide: 'test', cwd: repoRoot });
    store.addObservation({
      session_id: 'ctx',
      kind: 'note',
      content: 'Hivemind context should fetch compact memory hits before full observations.',
    });

    const res = await client.callTool({
      name: 'hivemind_context',
      arguments: { repo_root: repoRoot, query: 'hivemind context', memory_limit: 2 },
    });
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}';
    const payload = JSON.parse(text) as {
      summary: {
        lane_count: number;
        memory_hit_count: number;
        next_action: string;
        suggested_call: string;
        suggested_tools: string[];
        must_check_attention: boolean;
        attention_hint: string;
        ready_work_hint: string;
        unread_message_count: number;
        pending_handoff_count: number;
        blocking: boolean;
        ready_work_count: number;
      };
      lanes: Array<Record<string, unknown>>;
      memory_hits: Array<Record<string, unknown>>;
    };

    expect(payload.summary.lane_count).toBe(1);
    expect(payload.summary.memory_hit_count).toBeGreaterThan(0);
    expect(payload.summary.next_action).toBe(
      'Do not choose work yet. Call attention_inbox now, then task_ready_for_agent.',
    );
    expect(payload.summary.suggested_call).toContain('mcp__colony__attention_inbox({ agent:');
    expect(payload.summary.suggested_tools).toEqual(['attention_inbox', 'task_ready_for_agent']);
    expect(payload.summary.must_check_attention).toBe(true);
    expect(payload.summary.attention_hint).toContain('attention_inbox');
    expect(payload.summary.ready_work_hint).toContain('task_ready_for_agent');
    expect(payload.summary.ready_work_hint).toContain('task_list only for browsing/debugging');
    expect(payload.summary.unread_message_count).toBe(0);
    expect(payload.summary.pending_handoff_count).toBe(0);
    expect(payload.summary.blocking).toBe(false);
    expect(payload.summary.ready_work_count).toBe(0);
    expect(payload.lanes[0]).toMatchObject({
      branch: 'agent/codex/context-task',
      owner: 'codex/codex',
      activity: 'working',
      needs_attention: false,
    });
    expect(payload.memory_hits[0]).toHaveProperty('id');
    expect(payload.memory_hits[0]).toHaveProperty('snippet');
    expect(payload.memory_hits[0]).not.toHaveProperty('content');
  });

  it('hivemind_context adds compact adoption nudges from synthetic telemetry', async () => {
    const repoRoot = join(dir, 'repo-adoption-nudges');
    store.startSession({ id: 'metrics', ide: 'test', cwd: repoRoot });
    for (let i = 0; i < 4; i += 1) {
      store.addObservation({
        session_id: 'metrics',
        kind: 'tool_use',
        content: 'task_list',
        metadata: { tool: 'mcp__colony__task_list' },
      });
    }
    store.addObservation({
      session_id: 'metrics',
      kind: 'tool_use',
      content: 'task_ready_for_agent',
      metadata: { tool: 'mcp__colony__task_ready_for_agent' },
    });
    store.addObservation({
      session_id: 'metrics',
      kind: 'tool_use',
      content: 'task_note_working',
      metadata: { tool: 'mcp__colony__task_note_working' },
    });
    for (let i = 0; i < 3; i += 1) {
      store.addObservation({
        session_id: 'metrics',
        kind: 'tool_use',
        content: 'notepad_write_working',
        metadata: { tool: 'mcp__omx_memory__notepad_write_working' },
      });
    }
    store.addObservation({
      session_id: 'metrics',
      kind: 'tool_use',
      content: 'edit without colony claim',
      metadata: { tool: 'Edit', file_path: 'src/live-tool.ts' },
    });

    const res = await client.callTool({
      name: 'hivemind_context',
      arguments: { repo_root: repoRoot, query: 'adoption nudges' },
    });
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}';
    const payload = JSON.parse(text) as {
      summary: {
        suggested_tools: string[];
        adoption_nudges: Array<{
          key: string;
          tool: string;
          current: string;
          hint: string;
        }>;
      };
    };

    expect(payload.summary.adoption_nudges).toEqual([
      expect.objectContaining({
        key: 'task_list_overuse',
        tool: 'task_ready_for_agent',
        current: 'task_list=4; task_ready_for_agent=1',
      }),
      expect.objectContaining({
        key: 'notepad_overuse',
        tool: 'task_note_working',
        current: 'colony_notes=1; omx_notepad_writes=3',
      }),
      expect.objectContaining({
        key: 'claim_before_edit_low',
        tool: 'task_claim_file',
        // Compact diagnostic now appends pre_tool_use_signals so agents can
        // distinguish missing-hook (=0) from missed-by-agent (>0) at a glance.
        current: 'claimed_before_edit=0/1; pre_tool_use_signals=0',
      }),
    ]);
    expect(payload.summary.suggested_tools).toEqual([
      'attention_inbox',
      'task_ready_for_agent',
      'task_note_working',
      'task_claim_file',
    ]);
    expect(payload.summary.adoption_nudges.map((nudge) => nudge.hint).join(' ')).toContain(
      'task_note_working',
    );
  });

  it('hivemind_context keeps huge active-session sets compact by default', async () => {
    const repoRoot = join(dir, 'repo-huge-context');
    const activeSessionDir = join(repoRoot, '.omx', 'state', 'active-sessions');
    const lockStateDir = join(repoRoot, '.omx', 'state');
    mkdirSync(activeSessionDir, { recursive: true });
    mkdirSync(lockStateDir, { recursive: true });
    const now = Date.now();
    const locks: Record<string, Record<string, unknown>> = {};

    for (let i = 0; i < 25; i += 1) {
      const branch = `agent/codex/context-${i}`;
      const worktreePath = join(repoRoot, '.omx', 'agent-worktrees', `agent__codex__context-${i}`);
      const heartbeat = new Date(now - i * 1000).toISOString();
      mkdirSync(worktreePath, { recursive: true });
      writeFileSync(
        join(activeSessionDir, `agent__codex__context-${i}.json`),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            repoRoot,
            branch,
            taskName: `Context task ${i}`,
            latestTaskPreview: `Compact local context lane ${i}`,
            agentName: 'codex',
            worktreePath,
            pid: process.pid,
            cliName: 'codex',
            startedAt: heartbeat,
            lastHeartbeatAt: heartbeat,
            state: 'working',
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
      locks[`src/file-${i}.ts`] = {
        branch,
        claimed_at: heartbeat,
        allow_delete: false,
      };
    }

    writeFileSync(
      join(lockStateDir, 'agent-file-locks.json'),
      `${JSON.stringify({ locks }, null, 2)}\n`,
      'utf8',
    );

    store.startSession({ id: 'ctx', ide: 'test', cwd: repoRoot });
    for (let i = 0; i < 6; i += 1) {
      store.addObservation({
        session_id: 'ctx',
        kind: 'note',
        content: `compact local sentinel memory hit ${i}`,
      });
    }

    const compactRes = await client.callTool({
      name: 'hivemind_context',
      arguments: { repo_root: repoRoot, query: 'compact local sentinel' },
    });
    const compactText =
      (compactRes.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}';
    const compact = JSON.parse(compactText) as {
      summary: {
        lane_count: number;
        total_lane_count: number;
        lanes_truncated: boolean;
        memory_hit_count: number;
        claim_count: number;
      };
      lanes: Array<Record<string, unknown>>;
      ownership: {
        claims: Array<Record<string, unknown>>;
        claims_truncated: boolean;
        hot_files: Array<Record<string, unknown>>;
      };
      memory_hits: Array<Record<string, unknown>>;
    };

    expect(compact.summary.total_lane_count).toBe(25);
    expect(compact.summary.lane_count).toBe(8);
    expect(compact.summary.lanes_truncated).toBe(true);
    expect(compact.summary.memory_hit_count).toBe(3);
    expect(compact.summary.claim_count).toBe(8);
    expect(compact.lanes).toHaveLength(8);
    expect(compact.memory_hits).toHaveLength(3);
    expect(compact.ownership.claims.length).toBeLessThanOrEqual(12);
    expect(compact.ownership.hot_files.length).toBeLessThanOrEqual(8);
    expect(compact.ownership.claims_truncated).toBe(false);
    expect(compact.memory_hits[0]).not.toHaveProperty('content');

    const expandedRes = await client.callTool({
      name: 'hivemind_context',
      arguments: {
        repo_root: repoRoot,
        query: 'compact local sentinel',
        limit: 15,
        memory_limit: 5,
        max_claims: 20,
        max_hot_files: 12,
      },
    });
    const expandedText =
      (expandedRes.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}';
    const expanded = JSON.parse(expandedText) as {
      summary: { lane_count: number; memory_hit_count: number };
      ownership: {
        claims: Array<Record<string, unknown>>;
        hot_files: Array<Record<string, unknown>>;
      };
      memory_hits: Array<Record<string, unknown>>;
    };

    expect(expanded.summary.lane_count).toBe(15);
    expect(expanded.summary.memory_hit_count).toBe(5);
    expect(expanded.ownership.claims).toHaveLength(15);
    expect(expanded.ownership.hot_files).toHaveLength(12);
    expect(expanded.memory_hits).toHaveLength(5);
  });

  it('hivemind_context includes local current-session attention counts without bodies', async () => {
    const repoRoot = join(dir, 'repo-context-attention');
    const otherRoot = join(dir, 'repo-context-attention-other');
    store.startSession({ id: 'claude', ide: 'claude-code', cwd: repoRoot });
    store.startSession({ id: 'codex', ide: 'codex', cwd: repoRoot });
    const thread = TaskThread.open(store, {
      repo_root: repoRoot,
      branch: 'agent/claude/attention',
      session_id: 'claude',
    });
    thread.join('claude', 'claude');
    thread.join('codex', 'codex');
    const handoffId = thread.handOff({
      from_session_id: 'claude',
      from_agent: 'claude',
      to_agent: 'codex',
      summary: 'take local context lane',
      transferred_files: ['src/local.ts'],
    });
    const messageId = thread.postMessage({
      from_session_id: 'claude',
      from_agent: 'claude',
      to_agent: 'codex',
      content: 'blocking body should require hydration',
      urgency: 'blocking',
    });

    const otherThread = TaskThread.open(store, {
      repo_root: otherRoot,
      branch: 'agent/claude/other-attention',
      session_id: 'claude',
    });
    otherThread.join('claude', 'claude');
    otherThread.join('codex', 'codex');
    otherThread.postMessage({
      from_session_id: 'claude',
      from_agent: 'claude',
      to_agent: 'codex',
      content: 'other repo blocker must stay out',
      urgency: 'blocking',
    });

    const res = await client.callTool({
      name: 'hivemind_context',
      arguments: { repo_root: repoRoot, session_id: 'codex', agent: 'codex' },
    });
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}';
    const payload = JSON.parse(text) as {
      attention: {
        unread_messages: number;
        pending_handoffs: number;
        blocking: boolean;
        counts: {
          pending_handoff_count: number;
          unread_message_count: number;
          blocked: boolean;
        };
        observation_ids: number[];
        hydration: string;
        hydrate_with: string;
      };
      summary: {
        next_action: string;
        suggested_call: string;
        must_check_attention: boolean;
        unread_message_count: number;
        pending_handoff_count: number;
        blocking: boolean;
      };
    };

    expect(payload.attention.pending_handoffs).toBe(1);
    expect(payload.attention.unread_messages).toBe(1);
    expect(payload.attention.blocking).toBe(true);
    expect(payload.attention.counts.pending_handoff_count).toBe(1);
    expect(payload.attention.counts.unread_message_count).toBe(1);
    expect(payload.attention.counts.blocked).toBe(true);
    expect(payload.attention.observation_ids).toEqual([messageId, handoffId]);
    expect(payload.attention.hydration).toContain('Hydrate with attention_inbox');
    expect(payload.attention.hydrate_with).toBe('attention_inbox');
    expect(payload.summary.next_action).toBe(
      'Do not choose work yet. Call attention_inbox now, then task_ready_for_agent.',
    );
    expect(payload.summary.suggested_call).toBe(
      `mcp__colony__attention_inbox({ agent: "codex", session_id: "codex", repo_root: ${JSON.stringify(
        repoRoot,
      )} })`,
    );
    expect(payload.summary.must_check_attention).toBe(true);
    expect(payload.summary.pending_handoff_count).toBe(1);
    expect(payload.summary.unread_message_count).toBe(1);
    expect(payload.summary.blocking).toBe(true);
    expect(text).not.toContain('blocking body should require hydration');
    expect(text).not.toContain('other repo blocker must stay out');
  });

  it('hivemind_context local mode returns nearby task, file, pheromone, memory, and attention signals', async () => {
    const repoRoot = join(dir, 'repo-local-neighborhood');
    const otherRoot = join(dir, 'repo-local-neighborhood-other');
    store.startSession({ id: 'claude', ide: 'claude-code', cwd: repoRoot });
    store.startSession({ id: 'codex', ide: 'codex', cwd: repoRoot });
    const thread = TaskThread.open(store, {
      repo_root: repoRoot,
      branch: 'agent/codex/local-neighborhood',
      session_id: 'codex',
      title: 'Repair local parser context',
    });
    thread.join('claude', 'claude');
    thread.join('codex', 'codex');
    thread.claimFile({ session_id: 'claude', file_path: 'src/local.ts' });
    thread.claimFile({ session_id: 'claude', file_path: 'src/unrelated.ts' });
    const negativeId = thread.post({
      session_id: 'claude',
      kind: 'failed_approach',
      content: 'Failed approach: src/local.ts loses metadata when the parser skips task scope.',
    });
    const messageId = thread.postMessage({
      from_session_id: 'claude',
      from_agent: 'claude',
      to_agent: 'codex',
      content: 'local blocker body should require get_observations hydration',
      urgency: 'blocking',
    });
    const sameRepoThread = TaskThread.open(store, {
      repo_root: repoRoot,
      branch: 'agent/claude/same-repo-blocker',
      session_id: 'claude',
      title: 'Same repo blocking attention',
    });
    sameRepoThread.join('claude', 'claude');
    sameRepoThread.join('codex', 'codex');
    const sameRepoBlockerId = sameRepoThread.postMessage({
      from_session_id: 'claude',
      from_agent: 'claude',
      to_agent: 'codex',
      content: 'same repo blocker body should require get_observations hydration too',
      urgency: 'blocking',
    });
    new PheromoneSystem(store.storage).deposit({
      task_id: thread.task_id,
      file_path: 'src/local.ts',
      session_id: 'claude',
    });
    store.addObservation({
      session_id: 'codex',
      kind: 'note',
      task_id: thread.task_id,
      content: 'Memory says src/local.ts owns local parser context and task scope metadata.',
    });

    const otherThread = TaskThread.open(store, {
      repo_root: otherRoot,
      branch: 'agent/claude/global-noise',
      session_id: 'claude',
      title: 'Global noise task',
    });
    otherThread.join('claude', 'claude');
    otherThread.claimFile({ session_id: 'claude', file_path: 'src/local.ts' });
    otherThread.post({
      session_id: 'claude',
      kind: 'failed_approach',
      content: 'Failed approach: other repo local.ts warning must not appear here.',
    });

    const res = await client.callTool({
      name: 'hivemind_context',
      arguments: {
        mode: 'local',
        repo_root: repoRoot,
        session_id: 'codex',
        agent: 'codex',
        task_id: thread.task_id,
        files: ['src/local.ts'],
        memory_limit: 2,
      },
    });
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}';
    const payload = JSON.parse(text) as {
      summary: {
        lane_count: number;
        next_action: string;
        suggested_tools: string[];
        suggested_call: string;
        must_check_attention: boolean;
      };
      local_context: {
        current_task: { id: number; title: string } | null;
        files: string[];
        claims: Array<{ file_path: string; by_session_id: string }>;
        pheromone_trails: Array<{
          file_path: string;
          by_session: Array<{ session_id: string; strength: number }>;
        }>;
        negative_pheromones: Array<{ id: number; kind: string; snippet: string }>;
        memory_hits: Array<Record<string, unknown>>;
        attention: {
          counts: { unread_message_count: number; blocked: boolean };
          observation_ids: number[];
          hydration: string;
          hydrate_with: string;
        };
        ready_next_action: string;
      };
    };

    expect(payload.summary.lane_count).toBeLessThanOrEqual(3);
    expect(payload.local_context.current_task).toMatchObject({
      id: thread.task_id,
      title: 'Repair local parser context',
    });
    expect(payload.local_context.files).toEqual(['src/local.ts']);
    expect(payload.local_context.claims).toEqual([
      expect.objectContaining({ file_path: 'src/local.ts', by_session_id: 'claude' }),
    ]);
    expect(payload.local_context.pheromone_trails[0]).toMatchObject({
      file_path: 'src/local.ts',
      by_session: [expect.objectContaining({ session_id: 'claude' })],
    });
    expect(payload.local_context.negative_pheromones[0]).toMatchObject({
      id: negativeId,
      kind: 'failed_approach',
    });
    expect(payload.local_context.memory_hits[0]).toHaveProperty('id');
    expect(payload.local_context.memory_hits[0]).not.toHaveProperty('content');
    expect(payload.local_context.attention.counts).toMatchObject({
      unread_message_count: 2,
      blocked: true,
    });
    expect(payload.local_context.attention.observation_ids).toEqual(
      expect.arrayContaining([messageId, sameRepoBlockerId]),
    );
    expect(payload.local_context.attention.hydration).toContain('attention_inbox');
    expect(payload.local_context.attention.hydration).toContain('get_observations');
    expect(payload.local_context.attention.hydrate_with).toBe('attention_inbox');
    expect(payload.local_context.ready_next_action).toMatch(/blocking task messages/i);
    expect(payload.summary.next_action).toBe(
      'Do not choose work yet. Call attention_inbox now, then task_ready_for_agent.',
    );
    expect(payload.summary.suggested_call).toBe(
      `mcp__colony__attention_inbox({ agent: "codex", session_id: "codex", repo_root: ${JSON.stringify(
        repoRoot,
      )} })`,
    );
    expect(payload.summary.suggested_tools).toEqual(
      expect.arrayContaining(['attention_inbox', 'task_ready_for_agent']),
    );
    expect(payload.summary.must_check_attention).toBe(true);
    expect(text).not.toContain('local blocker body should require get_observations hydration');
    expect(text).not.toContain('same repo blocker body should require get_observations hydration');
    expect(text).not.toContain('src/unrelated.ts');
    expect(text).not.toContain('other repo local.ts warning must not appear here');

    const implicitRes = await client.callTool({
      name: 'hivemind_context',
      arguments: {
        mode: 'local',
        repo_root: repoRoot,
        session_id: 'codex',
        agent: 'codex',
        files: ['src/local.ts'],
      },
    });
    const implicitText =
      (implicitRes.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}';
    const implicit = JSON.parse(implicitText) as {
      local_context: { current_task: { id: number } | null };
    };
    expect(implicit.local_context.current_task?.id).toBe(thread.task_id);
  });

  it('hivemind_context labels stale local claims as weak instead of active blockers', async () => {
    const repoRoot = join(dir, 'repo-stale-local-claim');
    const t0 = Date.parse('2026-04-28T12:00:00.000Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0);
    store.startSession({ id: 'claude', ide: 'claude-code', cwd: repoRoot });
    store.startSession({ id: 'codex', ide: 'codex', cwd: repoRoot });
    const thread = TaskThread.open(store, {
      repo_root: repoRoot,
      branch: 'agent/codex/stale-local-claim',
      session_id: 'codex',
      title: 'Repair stale local claim context',
    });
    thread.join('claude', 'claude');
    thread.join('codex', 'codex');
    thread.claimFile({ session_id: 'claude', file_path: 'src/local.ts' });

    vi.setSystemTime(t0 + 241 * 60_000);

    const res = await client.callTool({
      name: 'hivemind_context',
      arguments: {
        mode: 'local',
        repo_root: repoRoot,
        session_id: 'codex',
        agent: 'codex',
        task_id: thread.task_id,
        files: ['src/local.ts'],
      },
    });
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}';
    const payload = JSON.parse(text) as {
      local_context: {
        claims: Array<{
          file_path: string;
          age_class: string;
          ownership_strength: string;
        }>;
        ready_next_action: string;
      };
    };

    expect(payload.local_context.claims).toEqual([
      expect.objectContaining({
        file_path: 'src/local.ts',
        age_class: 'stale',
        ownership_strength: 'weak',
      }),
    ]);
    expect(payload.local_context.ready_next_action).toBe(
      'No local blockers found; claim these files before editing.',
    );
  });

  it('hivemind falls back to worktree AGENT.lock task previews', async () => {
    const repoRoot = join(dir, 'repo-lock');
    const worktreePath = join(repoRoot, '.omx', 'agent-worktrees', 'agent__codex__proxy-task');
    mkdirSync(join(worktreePath, '.git'), { recursive: true });
    writeFileSync(
      join(worktreePath, '.git', 'HEAD'),
      'ref: refs/heads/agent/codex/proxy-task\n',
      'utf8',
    );
    writeFileSync(
      join(worktreePath, 'AGENT.lock'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          source: 'recodee-live-telemetry',
          updatedAt: '2026-04-23T08:01:00.000Z',
          worktreePath,
          worktreeName: 'agent__codex__proxy-task',
          snapshotCount: 1,
          sessionCount: 1,
          snapshots: [
            {
              snapshotName: 'default',
              email: 'agent@example.com',
              sessions: [
                {
                  sessionKey: 'pid:123',
                  taskPreview: 'Map proxy runtime sessions to current tasks',
                  taskUpdatedAt: '2026-04-23T08:01:00.000Z',
                  projectName: 'recodee',
                  projectPath: worktreePath,
                },
              ],
            },
          ],
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const res = await client.callTool({
      name: 'hivemind',
      arguments: { repo_root: repoRoot, limit: 5 },
    });
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}';
    const payload = JSON.parse(text) as {
      session_count: number;
      sessions: Array<Record<string, unknown>>;
    };

    expect(payload.session_count).toBe(1);
    expect(payload.sessions[0]).toMatchObject({
      branch: 'agent/codex/proxy-task',
      task: 'Map proxy runtime sessions to current tasks',
      source: 'worktree-lock',
      project_name: 'recodee',
      snapshot_name: 'default',
    });
    expect(payload.sessions[0]).not.toHaveProperty('email');
  });

  it('hivemind falls back to GX file locks when no live session exists', async () => {
    const repoRoot = join(dir, 'repo-file-locks');
    const lockStateDir = join(repoRoot, '.omx', 'state');
    const now = new Date().toISOString();
    mkdirSync(lockStateDir, { recursive: true });
    writeFileSync(
      join(lockStateDir, 'agent-file-locks.json'),
      `${JSON.stringify(
        {
          locks: {
            'apps/mcp-server/src/server.ts': {
              branch: 'agent/codex/gx-locks',
              claimed_at: now,
              allow_delete: false,
            },
            'packages/core/src/hivemind.ts': {
              branch: 'agent/codex/gx-locks',
              claimed_at: now,
              allow_delete: false,
            },
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const res = await client.callTool({
      name: 'hivemind_context',
      arguments: { repo_root: repoRoot, limit: 5 },
    });
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}';
    const payload = JSON.parse(text) as {
      summary: { lane_count: number };
      counts: Record<string, number>;
      lanes: Array<Record<string, unknown>>;
    };

    expect(payload.summary.lane_count).toBe(1);
    expect(payload.counts.working).toBe(1);
    expect(payload.lanes[0]).toMatchObject({
      branch: 'agent/codex/gx-locks',
      task: 'GX locks: apps/mcp-server/src/server.ts, packages/core/src/hivemind.ts',
      owner: 'codex/gx',
      source: 'file-lock',
      activity: 'working',
      locked_file_count: 2,
      locked_file_preview: ['apps/mcp-server/src/server.ts', 'packages/core/src/hivemind.ts'],
    });
  });

  it('hivemind_context marks bare managed worktrees as stranded lanes', async () => {
    const repoRoot = join(dir, 'repo-stranded');
    const worktreePath = join(
      repoRoot,
      '.omx',
      'agent-worktrees',
      'recodee__codex__create-public-terms-page-2026-04-27-12-13',
    );
    mkdirSync(join(worktreePath, '.git'), { recursive: true });
    writeFileSync(
      join(worktreePath, '.git', 'HEAD'),
      'ref: refs/heads/agent/codex/create-public-terms-page-2026-04-27-12-13\n',
      'utf8',
    );

    const res = await client.callTool({
      name: 'hivemind_context',
      arguments: { repo_root: repoRoot, limit: 5 },
    });
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}';
    const payload = JSON.parse(text) as {
      summary: {
        lane_count: number;
        needs_attention_count: number;
        next_action: string;
        suggested_call: string;
        must_check_attention: boolean;
      };
      counts: Record<string, number>;
      lanes: Array<Record<string, unknown>>;
    };

    expect(payload.summary.lane_count).toBe(1);
    expect(payload.summary.needs_attention_count).toBe(1);
    expect(payload.summary.next_action).toBe(
      'Do not choose work yet. Call attention_inbox now, then task_ready_for_agent.',
    );
    expect(payload.summary.suggested_call).toContain('mcp__colony__attention_inbox');
    expect(payload.summary.must_check_attention).toBe(true);
    expect(payload.counts.stalled).toBe(1);
    expect(payload.lanes[0]).toMatchObject({
      branch: 'agent/codex/create-public-terms-page-2026-04-27-12-13',
      task: 'Stranded lane: create-public-terms-page-2026-04-27-12-13',
      owner: 'codex/codex',
      source: 'managed-worktree',
      activity: 'stalled',
      risk: 'stranded lane',
      needs_attention: true,
    });
  });

  it('search returns compact hits (id, kind, snippet, score, task_id, ts)', async () => {
    await seed();
    const res = await client.callTool({ name: 'search', arguments: { query: 'cargo' } });
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '[]';
    const hits = JSON.parse(text) as Array<{ id: number; snippet: string; score: number }>;
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(h).toHaveProperty('id');
      expect(h).toHaveProperty('snippet');
      expect(h).toHaveProperty('score');
      // No full body leaks into the compact shape.
      expect(Object.keys(h).sort()).toEqual([
        'id',
        'kind',
        'score',
        'session_id',
        'snippet',
        'task_id',
        'ts',
      ]);
    }
  });

  it('timeline returns id/kind/ts only (progressive disclosure)', async () => {
    await seed();
    const res = await client.callTool({ name: 'timeline', arguments: { session_id: 's1' } });
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '[]';
    const rows = JSON.parse(text) as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(['id', 'kind', 'ts']);
    }
  });

  it('get_observations returns expanded text by default and preserves tech tokens', async () => {
    const { a } = await seed();
    const res = await client.callTool({ name: 'get_observations', arguments: { ids: [a] } });
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '[]';
    const rows = JSON.parse(text) as Array<{ id: number; content: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content).toContain('/etc/caveman.conf');
    expect(rows[0]?.content).toMatch(/database/);
  });

  it('get_observations with expand=false returns the compressed stored form', async () => {
    const { b } = await seed();
    const res = await client.callTool({
      name: 'get_observations',
      arguments: { ids: [b], expand: false },
    });
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '[]';
    const rows = JSON.parse(text) as Array<{ content: string }>;
    // Compression drops "Please just" but keeps the command intact.
    expect(rows[0]?.content).not.toMatch(/Please just/);
    expect(rows[0]?.content).toContain('`cargo build --release`');
  });

  it('get_observations reports an error on invalid input (empty ids)', async () => {
    const res = await client.callTool({
      name: 'get_observations',
      arguments: { ids: [] },
    });
    expect(res.isError).toBe(true);
  });

  it('registers the MCP caller as an active session on connect and tool use', async () => {
    // The fixture's pre-wired server was built before we set env + cwd, so
    // build an isolated one here to drive the heartbeat path end-to-end.
    const repoRoot = mkdtempSync(join(tmpdir(), 'colony-mcp-hb-'));
    mkdirSync(join(repoRoot, '.git'), { recursive: true });
    writeFileSync(join(repoRoot, '.git', 'HEAD'), 'ref: refs/heads/hb-branch\n', 'utf8');

    const prevCwd = process.cwd();
    const prevCodexId = process.env.CODEX_SESSION_ID;
    process.chdir(repoRoot);
    process.env.CODEX_SESSION_ID = 'hb-session-1';

    const isolatedStore = new MemoryStore({
      dbPath: join(repoRoot, 'data.db'),
      settings: defaultSettings,
    });
    const isolatedServer = buildServer(isolatedStore, defaultSettings);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const isolatedClient = new Client({ name: 'hb-test', version: '0.0.0' });

    try {
      await Promise.all([
        isolatedServer.connect(serverTransport),
        isolatedClient.connect(clientTransport),
      ]);

      const sessionFile = join(repoRoot, '.omx', 'state', 'active-sessions', 'hb-session-1.json');
      const afterConnect = JSON.parse(readFileSync(sessionFile, 'utf8'));
      expect(afterConnect.sessionKey).toBe('hb-session-1');
      expect(afterConnect.branch).toBe('hb-branch');
      expect(afterConnect.cliName).toBe('codex');
      expect(afterConnect.state).toBe('working');
      const sessionRow = isolatedStore.storage.getSession('hb-session-1');
      expect(sessionRow).toMatchObject({
        id: 'hb-session-1',
        ide: 'codex',
        cwd: repoRoot,
        ended_at: null,
      });
      const sessionMetadata = JSON.parse(sessionRow?.metadata ?? '{}') as Record<string, string>;
      expect(sessionMetadata).toMatchObject({
        source: 'omx-active-session',
        cli: 'codex',
        repo_root: repoRoot,
        branch: 'hb-branch',
        worktree_path: repoRoot,
      });
      const connectHeartbeat = afterConnect.lastHeartbeatAt;

      await new Promise((r) => setTimeout(r, 5));

      await isolatedClient.callTool({ name: 'list_sessions', arguments: { limit: 1 } });

      const afterTool = JSON.parse(readFileSync(sessionFile, 'utf8'));
      expect(afterTool.lastHeartbeatAt >= connectHeartbeat).toBe(true);
      expect(afterTool.latestTaskPreview).toContain('colony.list_sessions');
    } finally {
      await isolatedClient.close();
      isolatedStore.close();
      process.chdir(prevCwd);
      if (prevCodexId === undefined) delete process.env.CODEX_SESSION_ID;
      else process.env.CODEX_SESSION_ID = prevCodexId;
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
