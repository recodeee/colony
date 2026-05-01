import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { MemoryStore, TaskThread } from '@colony/core';
import { Client } from '@modelcontextprotocol/sdk/client';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/server.js';

let dataDir: string;
let repoRoot: string;
let store: MemoryStore;
let client: Client;

interface StartupPanel {
  session_id: string;
  repo_root: string | null;
  branch: string | null;
  active_task: { id: number; title: string; branch: string } | null;
  ready_task: {
    kind: 'plan_subtask' | 'quota_relay';
    title: string;
    plan_slug?: string;
    subtask_index?: number;
    file_scope?: string[];
  } | null;
  active_queen_plan: {
    plan_slug: string;
    subtask_index: number;
    subtask_title: string;
    status: string;
  } | null;
  inbox_count: number;
  blocking_items: Array<{
    kind: string;
    task_id?: number | null;
    summary: string;
    next_tool?: string;
    next_args?: Record<string, unknown>;
  }>;
  claimed_files: string[];
  blocker: string | null;
  next: string;
  evidence: string | null;
  warnings: Array<{ kind: string; severity: string; message: string; next_tool?: string }>;
  recommended_next_tool: string | null;
  recommended_next_args: Record<string, unknown> | null;
  copy_paste_next_mcp_calls: string[];
}

async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}';
  return JSON.parse(text) as T;
}

function startup(overrides: Record<string, unknown> = {}): Promise<StartupPanel> {
  return call<StartupPanel>('startup_panel', {
    session_id: 'agent-session',
    agent: 'codex',
    repo_root: repoRoot,
    ...overrides,
  });
}

function publishArgs(subtasks: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    repo_root: repoRoot,
    slug: 'startup-plan',
    session_id: 'queen',
    agent: 'queen',
    title: 'Startup plan',
    problem: 'Agents need one compact startup panel.',
    acceptance_criteria: ['Startup panel returns ready task and exact claim call'],
    subtasks,
  };
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'colony-startup-data-'));
  repoRoot = mkdtempSync(join(tmpdir(), 'colony-startup-repo-'));
  writeFileSync(join(repoRoot, 'SPEC.md'), '# SPEC\n', 'utf8');
  store = new MemoryStore({ dbPath: join(dataDir, 'data.db'), settings: defaultSettings });
  store.startSession({ id: 'queen', ide: 'queen', cwd: repoRoot });
  store.startSession({ id: 'agent-session', ide: 'codex', cwd: repoRoot });
  store.startSession({ id: 'other-session', ide: 'claude-code', cwd: repoRoot });
  const server = buildServer(store, defaultSettings);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
});

afterEach(async () => {
  vi.useRealTimers();
  await client.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(repoRoot, { recursive: true, force: true });
});

describe('startup_panel', () => {
  it('returns compact no-active-task state with the ready queue as next step', async () => {
    const panel = await startup();

    expect(panel).toMatchObject({
      session_id: 'agent-session',
      repo_root: repoRoot,
      branch: null,
      active_task: null,
      ready_task: null,
      inbox_count: 0,
      claimed_files: [],
      blocker: null,
      evidence: null,
      recommended_next_tool: 'task_ready_for_agent',
    });
    expect(panel.copy_paste_next_mcp_calls[0]).toContain('mcp__colony__task_ready_for_agent');
  });

  it('summarizes an active task with blocker, next step, evidence, and claims', async () => {
    const thread = TaskThread.open(store, {
      repo_root: repoRoot,
      branch: 'agent/codex/startup-blocker',
      session_id: 'agent-session',
      title: 'Startup blocked lane',
    });
    thread.join('agent-session', 'codex');
    thread.claimFile({ session_id: 'agent-session', file_path: 'apps/api/startup.ts' });
    thread.post({
      session_id: 'agent-session',
      kind: 'note',
      content:
        'branch=agent/codex/startup-blocker; task=Startup blocked lane; blocker=waiting on schema owner; next=ask owner for contract; evidence=task_message #42',
    });

    const panel = await startup({ branch: 'agent/codex/startup-blocker' });

    expect(panel.active_task).toMatchObject({
      id: thread.task_id,
      title: 'Startup blocked lane',
      branch: 'agent/codex/startup-blocker',
    });
    expect(panel.claimed_files).toEqual(['apps/api/startup.ts']);
    expect(panel.blocker).toBe('waiting on schema owner');
    expect(panel.next).toBe('ask owner for contract');
    expect(panel.evidence).toBe('task_message #42');
    expect(panel.recommended_next_tool).toBeNull();
  });

  it('surfaces a ready Queen subtask with exact claim args', async () => {
    await call('task_plan_publish', {
      ...publishArgs([
        {
          title: 'Build startup panel',
          description: 'Compose startup context.',
          file_scope: ['apps/mcp-server/src/tools/startup-panel.ts'],
          capability_hint: 'api_work',
        },
        {
          title: 'Document startup panel',
          description: 'Record the startup panel behavior.',
          file_scope: ['docs/startup-panel.md'],
          depends_on: [0],
          capability_hint: 'doc_work',
        },
      ]),
    });

    const panel = await startup();

    expect(panel.ready_task).toMatchObject({
      kind: 'plan_subtask',
      title: 'Build startup panel',
      plan_slug: 'startup-plan',
      subtask_index: 0,
      file_scope: ['apps/mcp-server/src/tools/startup-panel.ts'],
    });
    expect(panel.recommended_next_tool).toBe('task_plan_claim_subtask');
    expect(panel.recommended_next_args).toMatchObject({
      repo_root: repoRoot,
      plan_slug: 'startup-plan',
      subtask_index: 0,
      session_id: 'agent-session',
      agent: 'codex',
    });
    expect(panel.copy_paste_next_mcp_calls[0]).toContain('mcp__colony__task_plan_claim_subtask');
  });

  it('prioritizes directed inbox messages before ready work', async () => {
    const thread = TaskThread.open(store, {
      repo_root: repoRoot,
      branch: 'agent/codex/message-lane',
      session_id: 'other-session',
      title: 'Message lane',
    });
    thread.join('other-session', 'claude');
    thread.join('agent-session', 'codex');
    thread.postMessage({
      from_session_id: 'other-session',
      from_agent: 'claude',
      to_agent: 'codex',
      to_session_id: 'agent-session',
      urgency: 'blocking',
      content: 'Need startup shape confirmed before I claim tests.',
    });

    const panel = await startup();

    expect(panel.inbox_count).toBe(1);
    expect(panel.blocking_items).toEqual([
      expect.objectContaining({
        kind: 'message',
        task_id: thread.task_id,
        summary: expect.stringContaining('Need startup shape confirmed'),
        next_tool: 'task_message',
      }),
    ]);
    expect(panel.warnings).toContainEqual(
      expect.objectContaining({ kind: 'attention', severity: 'blocking' }),
    );
    expect(panel.recommended_next_tool).toBe('task_message');
    expect(panel.copy_paste_next_mcp_calls[0]).toContain('mcp__colony__task_message');
  });

  it('shows stale claim warnings in the startup panel', async () => {
    const t0 = Date.parse('2026-04-28T12:00:00.000Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0);
    const thread = TaskThread.open(store, {
      repo_root: repoRoot,
      branch: 'agent/claude/stale-claim',
      session_id: 'other-session',
      title: 'Stale claim lane',
    });
    thread.claimFile({ session_id: 'other-session', file_path: 'src/stale.ts' });
    vi.setSystemTime(t0 + 481 * 60_000);

    const panel = await startup();

    expect(panel.warnings).toContainEqual(
      expect.objectContaining({
        kind: 'stale',
        severity: 'warning',
        next_tool: 'rescue_stranded_scan',
      }),
    );
    expect(panel.warnings.find((warning) => warning.kind === 'stale')?.message).toContain(
      'stale advisory claim',
    );
  });

  it('shows quota-stopped work as the startup recommendation', async () => {
    const thread = TaskThread.open(store, {
      repo_root: repoRoot,
      branch: 'agent/codex/quota-relay',
      session_id: 'other-session',
      title: 'Quota relay lane',
    });
    thread.join('other-session', 'codex');
    thread.claimFile({ session_id: 'other-session', file_path: 'src/quota.ts' });
    thread.relay({
      from_session_id: 'other-session',
      from_agent: 'codex',
      reason: 'quota',
      one_line: 'quota stopped this task',
      base_branch: 'main',
      expires_in_ms: 60_000,
    });

    const panel = await startup();

    expect(panel.ready_task).toMatchObject({
      kind: 'quota_relay',
      task_id: thread.task_id,
      file_scope: ['src/quota.ts'],
      next_tool: 'task_claim_quota_accept',
    });
    expect(panel.warnings).toContainEqual(
      expect.objectContaining({ kind: 'quota', severity: 'warning' }),
    );
    expect(panel.recommended_next_tool).toBe('task_claim_quota_accept');
  });
});
