import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

interface ToolExpectation {
  name: string;
  startsWith: RegExp;
  leadingPhrases: string[];
}

interface PublishResult {
  plan_slug: string;
  subtasks: Array<{ subtask_index: number; task_id: number; branch: string; title: string }>;
}

interface HivemindContextResult {
  summary: { lane_count: number; memory_hit_count: number };
  lanes: Array<{ branch: string; task: string; owner: string }>;
  memory_hits: Array<{ id: number; snippet: string }>;
}

interface InboxResult {
  summary: { unread_message_count: number; blocked: boolean };
  unread_messages: Array<{ id: number; urgency: string }>;
}

interface ReadyResult {
  ready: Array<{
    plan_slug: string;
    subtask_index: number;
    title: string;
    file_scope: string[];
  }>;
  total_available: number;
}

interface ClaimSubtaskResult {
  task_id: number;
  branch: string;
  file_scope: string[];
}

async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}';
  return JSON.parse(text) as T;
}

function publishLoopArgs(): Record<string, unknown> {
  return {
    repo_root: repoRoot,
    slug: 'coordination-loop',
    session_id: 'planner-session',
    agent: 'claude',
    title: 'Protect coordination loop',
    problem: 'Agents need a tested path from context to claiming and posting state.',
    acceptance_criteria: ['The intended Colony coordination loop is protected by tests'],
    subtasks: [
      {
        title: 'Add coordination loop tests',
        description: 'Protect MCP descriptions and the happy coordination path.',
        file_scope: ['apps/mcp-server/test/coordination-loop.test.ts'],
        capability_hint: 'test_work',
      },
      {
        title: 'Review ToolSearch docs',
        description: 'Keep the docs fixture aligned with searchable phrases.',
        file_scope: ['apps/mcp-server/README.md'],
        depends_on: [0],
        capability_hint: 'doc_work',
      },
    ],
  };
}

function writeActiveSession(): void {
  const activeSessionDir = join(repoRoot, '.omx', 'state', 'active-sessions');
  const worktreePath = join(repoRoot, '.omx', 'agent-worktrees', 'other__agent__loop');
  const now = new Date().toISOString();
  mkdirSync(activeSessionDir, { recursive: true });
  mkdirSync(worktreePath, { recursive: true });
  writeFileSync(
    join(activeSessionDir, 'other__agent__loop.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        repoRoot,
        branch: 'agent/other/active-loop',
        taskName: 'Hold active ownership fixture',
        latestTaskPreview: 'Keep ownership visible before edits',
        agentName: 'claude',
        worktreePath,
        pid: process.pid,
        cliName: 'claude-code',
        startedAt: now,
        lastHeartbeatAt: now,
        state: 'working',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'colony-loop-data-'));
  repoRoot = mkdtempSync(join(tmpdir(), 'colony-loop-repo-'));
  writeFileSync(join(repoRoot, 'SPEC.md'), '# SPEC\n', 'utf8');
  store = new MemoryStore({ dbPath: join(dataDir, 'data.db'), settings: defaultSettings });
  store.startSession({ id: 'planner-session', ide: 'claude-code', cwd: repoRoot });
  store.startSession({ id: 'agent-session', ide: 'codex', cwd: repoRoot });
  store.startSession({ id: 'other-session', ide: 'claude-code', cwd: repoRoot });
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

describe('coordination loop discovery', () => {
  it('keeps ToolSearch intent phrases at the front of coordination tool descriptions', async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool.description ?? '']));
    const expectations: ToolExpectation[] = [
      {
        name: 'hivemind_context',
        startsWith: /^Before editing/,
        leadingPhrases: ['before editing', 'active ownership', 'relevant memory'],
      },
      {
        name: 'attention_inbox',
        startsWith: /^See what needs your attention/,
        leadingPhrases: ['pending handoffs', 'unread messages', 'block'],
      },
      {
        name: 'task_ready_for_agent',
        startsWith: /^Find the next task to claim/,
        leadingPhrases: ['next task', 'claim', 'work'],
      },
      {
        name: 'task_claim_file',
        startsWith: /^Claim a file before editing/,
        leadingPhrases: ['before editing', 'ownership'],
      },
      {
        name: 'search',
        startsWith: /^Search prior memory/,
        leadingPhrases: ['prior memory', 'decisions', 'errors', 'notes'],
      },
      {
        name: 'task_post',
        startsWith: /^Write a working note/,
        leadingPhrases: ['working note', 'save current state', 'blockers'],
      },
    ];

    for (const expectation of expectations) {
      const description = byName.get(expectation.name) ?? '';
      expect(description).toMatch(expectation.startsWith);
      const leading = description.slice(0, 220).toLowerCase();
      for (const phrase of expectation.leadingPhrases) {
        expect(leading).toContain(phrase);
      }
    }
  });

  it('documents the same ToolSearch phrases in the MCP README table', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    const tableRows = readme
      .split('\n')
      .filter((line) => line.trim().startsWith('|'))
      .map((line) => line.toLowerCase());

    const documentedMappings: Array<[string, string]> = [
      ['pending, unread, blocking', 'attention_inbox'],
      ['pick next task', 'task_ready_for_agent'],
      ['active ownership', 'hivemind_context'],
      ['claim file', 'task_claim_file'],
      ['search prior memory', 'search'],
      ['write working note', 'task_post'],
    ];

    for (const [phrase, tool] of documentedMappings) {
      expect(tableRows.some((row) => row.includes(phrase) && row.includes(`\`${tool}\``))).toBe(
        true,
      );
    }
  });

  it('exercises the intended context-to-claim-to-note coordination loop', async () => {
    writeActiveSession();
    store.addObservation({
      session_id: 'planner-session',
      kind: 'decision',
      content: 'Prior memory says coordination loop agents should read context before claiming.',
    });

    const context = await call<HivemindContextResult>('hivemind_context', {
      repo_root: repoRoot,
      query: 'coordination loop prior memory',
      memory_limit: 1,
      limit: 5,
    });
    expect(context.summary.lane_count).toBe(1);
    expect(context.summary.memory_hit_count).toBeGreaterThan(0);
    expect(context.lanes[0]?.branch).toBe('agent/other/active-loop');
    expect(context.memory_hits[0]?.snippet).toMatch(/coordination|loop/i);

    const published = await call<PublishResult>('task_plan_publish', publishLoopArgs());
    const firstTask = published.subtasks[0];
    if (!firstTask) throw new Error('expected first published subtask');
    expect(firstTask?.branch).toBe('spec/coordination-loop/sub-0');
    new TaskThread(store, firstTask.task_id).join('agent-session', 'codex');

    await call('task_message', {
      task_id: firstTask.task_id,
      session_id: 'planner-session',
      agent: 'claude',
      to_agent: 'codex',
      urgency: 'blocking',
      content: 'Claim the test subtask before editing.',
    });

    const inbox = await call<InboxResult>('attention_inbox', {
      session_id: 'agent-session',
      agent: 'codex',
      repo_root: repoRoot,
      task_ids: [firstTask.task_id],
    });
    expect(inbox.summary.unread_message_count).toBe(1);
    expect(inbox.summary.blocked).toBe(true);
    expect(inbox.unread_messages[0]?.urgency).toBe('blocking');

    const ready = await call<ReadyResult>('task_ready_for_agent', {
      session_id: 'agent-session',
      agent: 'codex',
      repo_root: repoRoot,
      limit: 3,
    });
    expect(ready.total_available).toBe(1);
    const readyTask = ready.ready[0];
    if (!readyTask) throw new Error('expected one ready task');
    expect(readyTask).toMatchObject({
      plan_slug: 'coordination-loop',
      subtask_index: 0,
      title: 'Add coordination loop tests',
    });

    const claimed = await call<ClaimSubtaskResult>('task_plan_claim_subtask', {
      plan_slug: 'coordination-loop',
      subtask_index: readyTask.subtask_index,
      session_id: 'agent-session',
      agent: 'codex',
    });
    expect(claimed).toMatchObject({
      task_id: firstTask.task_id,
      branch: 'spec/coordination-loop/sub-0',
      file_scope: ['apps/mcp-server/test/coordination-loop.test.ts'],
    });
    expect(
      store.storage.getClaim(claimed.task_id, 'apps/mcp-server/test/coordination-loop.test.ts')
        ?.session_id,
    ).toBe('agent-session');

    const fileClaim = await call<{ observation_id: number }>('task_claim_file', {
      task_id: claimed.task_id,
      session_id: 'agent-session',
      file_path: 'apps/mcp-server/src/tools/task.ts',
      note: 'Protect task_post working-note description.',
    });
    expect(fileClaim.observation_id).toEqual(expect.any(Number));
    expect(store.storage.getClaim(claimed.task_id, 'apps/mcp-server/src/tools/task.ts')).toEqual(
      expect.objectContaining({ session_id: 'agent-session' }),
    );

    const note = await call<{ id: number }>('task_post', {
      task_id: claimed.task_id,
      session_id: 'agent-session',
      kind: 'note',
      content: 'State saved: context checked, inbox read, subtask claimed, file claimed.',
    });
    expect(note.id).toEqual(expect.any(Number));

    const timeline = await call<Array<{ kind: string; session_id: string }>>('task_timeline', {
      task_id: claimed.task_id,
      limit: 20,
    });
    expect(timeline.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining(['plan-subtask-claim', 'claim', 'note']),
    );
    expect(
      timeline.some((entry) => entry.kind === 'note' && entry.session_id === 'agent-session'),
    ).toBe(true);
  });
});
