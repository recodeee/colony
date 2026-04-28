import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { MemoryStore, TaskThread } from '@colony/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';

let dataDir: string;
let repoRoot: string;
let store: MemoryStore;
let client: Client;

interface BridgeStatusResult {
  schema: 'colony.omx_hud_status.v1';
  generated_at: string;
  runtime_source: 'omx' | 'colony';
  branch: string | null;
  task: string | null;
  blocker: string | null;
  next: string;
  evidence: {
    task_id: number | null;
    latest_working_note_id: number | null;
    attention_observation_ids: number[];
    attention_observation_ids_truncated: boolean;
    hydrate_with: 'get_observations';
  };
  attention: {
    unread_count: number;
    blocking_count: number;
    blocking: boolean;
    pending_handoff_count: number;
    pending_wake_count: number;
    stalled_lane_count: number;
  };
  ready_work_count: number;
  ready_work_preview: Array<{
    title: string;
    plan_slug: string;
    subtask_index: number;
    reason: string;
    fit_score: number;
    capability_hint: string | null;
    file_count: number;
    file_scope_preview: string[];
  }>;
  claimed_files: Array<{
    task_id: number;
    file_path: string;
    by_session_id: string;
    claimed_at: number;
    yours: boolean;
  }>;
  latest_working_note: {
    id: number;
    task_id: number;
    session_id: string;
    ts: number;
    content: string;
  } | null;
}

async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}';
  return JSON.parse(text) as T;
}

function writeActiveSession(branch: string): void {
  const activeSessionDir = join(repoRoot, '.omx', 'state', 'active-sessions');
  const lockStateDir = join(repoRoot, '.omx', 'state');
  const worktreePath = join(repoRoot, '.omx', 'agent-worktrees', 'codex__bridge_hud');
  const now = new Date().toISOString();
  mkdirSync(activeSessionDir, { recursive: true });
  mkdirSync(worktreePath, { recursive: true });
  writeFileSync(
    join(activeSessionDir, 'codex__bridge_hud.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        repoRoot,
        branch,
        taskName: 'Ship bridge status',
        latestTaskPreview: 'Expose compact HUD coordination status',
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
  writeFileSync(
    join(lockStateDir, 'agent-file-locks.json'),
    `${JSON.stringify(
      {
        locks: {
          'apps/mcp-server/src/tools/bridge.ts': {
            branch,
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
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'colony-bridge-data-'));
  repoRoot = mkdtempSync(join(tmpdir(), 'colony-bridge-repo-'));
  writeFileSync(join(repoRoot, 'SPEC.md'), '# SPEC\n', 'utf8');
  store = new MemoryStore({ dbPath: join(dataDir, 'data.db'), settings: defaultSettings });
  store.startSession({ id: 'planner-session', ide: 'claude-code', cwd: repoRoot });
  store.startSession({ id: 'agent-session', ide: 'codex', cwd: repoRoot });
  const server = buildServer(store, defaultSettings);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
});

afterEach(async () => {
  await client.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(repoRoot, { recursive: true, force: true });
});

describe('bridge_status', () => {
  it('returns compact HUD status from hivemind, attention, ready work, and claims', async () => {
    const branch = 'agent/codex/bridge-hud';
    writeActiveSession(branch);

    const currentThread = TaskThread.open(store, {
      repo_root: repoRoot,
      branch,
      session_id: 'agent-session',
      title: 'Bridge HUD implementation',
    });
    currentThread.join('agent-session', 'codex');
    currentThread.claimFile({
      session_id: 'agent-session',
      file_path: 'apps/mcp-server/src/tools/bridge.ts',
    });
    const latestNoteId = currentThread.post({
      session_id: 'agent-session',
      kind: 'note',
      content:
        'branch=agent/codex/bridge-hud; task=bridge status; blocker=none; next=run tests; evidence=bridge_status',
    });

    const helperThread = TaskThread.open(store, {
      repo_root: repoRoot,
      branch: 'agent/claude/bridge-help',
      session_id: 'planner-session',
      title: 'Bridge help',
    });
    helperThread.join('planner-session', 'claude');
    helperThread.join('agent-session', 'codex');
    helperThread.postMessage({
      from_session_id: 'planner-session',
      from_agent: 'claude',
      to_agent: 'codex',
      urgency: 'blocking',
      content: 'bridge blocking body should not appear in HUD',
    });
    helperThread.handOff({
      from_session_id: 'planner-session',
      from_agent: 'claude',
      to_agent: 'codex',
      summary: 'handoff summary should not appear in HUD',
      transferred_files: ['apps/mcp-server/src/tools/bridge.ts'],
    });

    await call('task_plan_publish', {
      repo_root: repoRoot,
      slug: 'bridge-ready-plan',
      session_id: 'planner-session',
      agent: 'claude',
      title: 'Bridge ready plan',
      problem: 'OMX needs one compact status call.',
      acceptance_criteria: ['Bridge status exposes compact coordination state'],
      subtasks: [
        {
          title: 'Implement bridge status tool',
          description: 'Expose compact coordination status for HUD consumers.',
          file_scope: ['apps/mcp-server/src/tools/bridge.ts', 'apps/mcp-server/test/bridge.ts'],
          capability_hint: 'api_work',
        },
        {
          title: 'Document bridge status tool',
          description: 'Document compact HUD status output.',
          file_scope: ['docs/mcp.md'],
          depends_on: [0],
          capability_hint: 'doc_work',
        },
      ],
    });

    const res = await client.callTool({
      name: 'bridge_status',
      arguments: {
        session_id: 'agent-session',
        agent: 'codex',
        repo_root: repoRoot,
        branch,
        query: 'bridge status HUD',
      },
    });
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}';
    const payload = JSON.parse(text) as BridgeStatusResult;

    expect(payload.schema).toBe('colony.omx_hud_status.v1');
    expect(payload.runtime_source).toBe('omx');
    expect(payload.branch).toBe(branch);
    expect(payload.task).toBe('Bridge HUD implementation');
    expect(payload.blocker).toBe('blocking attention');
    expect(payload.attention).toMatchObject({
      unread_count: 1,
      blocking_count: 1,
      blocking: true,
      pending_handoff_count: 1,
      pending_wake_count: 0,
      stalled_lane_count: 0,
    });
    expect(payload.evidence).toMatchObject({
      task_id: currentThread.task_id,
      latest_working_note_id: latestNoteId,
      attention_observation_ids_truncated: false,
      hydrate_with: 'get_observations',
    });
    expect(payload.evidence.attention_observation_ids.length).toBeGreaterThan(0);
    expect(payload.ready_work_count).toBe(1);
    expect(payload.ready_work_preview).toHaveLength(1);
    expect(payload.ready_work_preview[0]).toMatchObject({
      title: 'Implement bridge status tool',
      plan_slug: 'bridge-ready-plan',
      subtask_index: 0,
      file_count: 2,
    });
    expect(payload.ready_work_preview[0]?.file_scope_preview).toEqual([
      'apps/mcp-server/src/tools/bridge.ts',
      'apps/mcp-server/test/bridge.ts',
    ]);
    expect(payload.claimed_files).toHaveLength(1);
    expect(payload.claimed_files[0]).toMatchObject({
      task_id: currentThread.task_id,
      file_path: 'apps/mcp-server/src/tools/bridge.ts',
      by_session_id: 'agent-session',
      yours: true,
    });
    expect(typeof payload.claimed_files[0]?.claimed_at).toBe('number');
    expect(payload.latest_working_note).toMatchObject({
      id: latestNoteId,
      task_id: currentThread.task_id,
      session_id: 'agent-session',
      content:
        'branch=agent/codex/bridge-hud; task=bridge status; blocker=none; next=run tests; evidence=bridge_status',
    });
    expect(typeof payload.latest_working_note?.ts).toBe('number');
    expect(payload.next).toBe(
      'Answer blocking task messages first; another agent is explicitly blocked on you.',
    );
    expect(payload).not.toHaveProperty('hivemind');
    expect(payload).not.toHaveProperty('next_action');
    expect(payload).not.toHaveProperty('ready_work');
    expect(payload).not.toHaveProperty('claims');
    expect(text).not.toContain('bridge blocking body should not appear in HUD');
    expect(text).not.toContain('handoff summary should not appear in HUD');
    expect(text).not.toContain('negative_warnings');
  });
});
