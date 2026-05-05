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
  summary: {
    lane_count: number;
    memory_hit_count: number;
    negative_warning_count: number;
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
    attention_counts: { unread_message_count: number; blocked: boolean };
    state_tool_replacements: Record<string, string[]>;
  };
  attention: {
    unread_messages: number;
    pending_handoffs: number;
    blocking: boolean;
    hydration: string;
    hydrate_with: string;
    observation_ids: number[];
  };
  lanes: Array<{ branch: string; task: string; owner: string; locked_file_preview: string[] }>;
  local_context: {
    current_task: { id: number; title: string; branch: string } | null;
    claims: Array<{ file_path: string; by_session_id: string; yours: boolean }>;
    attention: { counts: { unread_message_count: number; blocked: boolean } };
  } | null;
  memory_hits: Array<{ id: number; snippet: string }>;
  negative_warnings: Array<{ id: number; kind: string; snippet: string }>;
}

interface InboxResult {
  summary: { unread_message_count: number; blocked: boolean };
  unread_messages: Array<{ id: number; urgency: string; preview: string }>;
}

interface ReadyResult {
  ready: Array<{
    plan_slug: string;
    subtask_index: number;
    title: string;
    file_scope: string[];
    negative_warnings: Array<{ id: number; kind: string; snippet: string }>;
  }>;
  total_available: number;
}

interface ClaimSubtaskResult {
  task_id: number;
  branch: string;
  file_scope: string[];
}

interface MessageResult {
  message_observation_id: number;
  status: string;
}

interface NoteWorkingResult {
  id: number;
  task_id: number;
}

interface TimelineEntry {
  id: number;
  kind: string;
  session_id: string;
  ts: number;
}

interface ObservationResult {
  id: number;
  kind: string;
  content: string;
}

interface OmxBridgeStatus {
  active_branch: string;
  current_task: string | null;
  attention_counts: HivemindContextResult['summary']['attention_counts'];
  ready_work_count: number;
  claimed_file_preview: string[];
  latest_note_id: number | null;
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
        title: 'Protect coordination loop path',
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
      {
        title: 'Add coordination loop tests',
        description: 'Protect MCP descriptions and the happy coordination path.',
        file_scope: ['apps/mcp-server/test/coordination-loop.test.ts'],
        depends_on: [0, 1],
        capability_hint: 'test_work',
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

function writeBridgeActiveSession(): { branch: string; task: string } {
  const activeSessionDir = join(repoRoot, '.omx', 'state', 'active-sessions');
  const worktreePath = join(repoRoot, '.omx', 'agent-worktrees', 'omx__codex__bridge-model');
  const now = new Date().toISOString();
  const branch = 'agent/codex/bridge-model-runtime';
  const task = 'Bridge model runtime telemetry';
  mkdirSync(activeSessionDir, { recursive: true });
  mkdirSync(worktreePath, { recursive: true });
  writeFileSync(
    join(activeSessionDir, 'omx__codex__bridge-model.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        repoRoot,
        branch,
        taskName: task,
        latestTaskPreview: 'OMX writes active-session telemetry for Colony',
        agentName: 'codex',
        cliName: 'codex',
        sessionKey: 'omx__codex__bridge-model',
        worktreePath,
        pid: process.pid,
        startedAt: now,
        lastHeartbeatAt: now,
        state: 'working',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return { branch, task: 'OMX writes active-session telemetry for Colony' };
}

function bridgePlanArgs(): Record<string, unknown> {
  return {
    repo_root: repoRoot,
    slug: 'omx-colony-bridge-e2e',
    session_id: 'planner-session',
    agent: 'claude',
    title: 'Prove OMX Colony bridge',
    problem: 'OMX runtime telemetry must feed Colony coordination and return compact status.',
    acceptance_criteria: ['OMX telemetry in, Colony coordination out'],
    subtasks: [
      {
        title: 'Prove bridge model path',
        description: 'Exercise telemetry, attention, ready work, claims, and notes.',
        file_scope: ['apps/mcp-server/test/coordination-loop.test.ts'],
        capability_hint: 'test_work',
      },
      {
        title: 'Dependent bridge follow-up',
        description: 'Stays blocked until the bridge proof task completes.',
        file_scope: ['apps/mcp-server/src/tools/hivemind.ts'],
        depends_on: [0],
        capability_hint: 'api_work',
      },
    ],
  };
}

function renderOmxBridgeStatus(input: {
  context: HivemindContextResult;
  localContext: HivemindContextResult;
  ready: ReadyResult;
  timeline: TimelineEntry[];
}): OmxBridgeStatus {
  const latestNote = input.timeline
    .filter((entry) => entry.kind === 'note')
    .sort((a, b) => b.ts - a.ts)[0];
  return {
    active_branch: input.context.lanes[0]?.branch ?? '',
    current_task:
      input.ready.ready[0]?.title ?? input.localContext.local_context?.current_task?.title ?? null,
    attention_counts: input.context.summary.attention_counts,
    ready_work_count: input.ready.total_available,
    claimed_file_preview:
      input.localContext.local_context?.claims.map((claim) => claim.file_path).slice(0, 5) ?? [],
    latest_note_id: latestNote?.id ?? null,
  };
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
        leadingPhrases: ['before editing', 'attention_inbox now', 'suggested_call'],
      },
      {
        name: 'attention_inbox',
        startsWith: /^See what needs your attention/,
        leadingPhrases: [
          'after hivemind_context',
          'handoffs',
          'unread messages',
          'blockers',
          'stalled lanes',
          'recent claims',
        ],
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
        name: 'task_note_working',
        startsWith: /^Save current working state/,
        leadingPhrases: ['current working state', 'active colony task', 'repo_root/branch'],
      },
      {
        name: 'task_post',
        startsWith: /^Post shared task notes/,
        leadingPhrases: ['question', 'decision', 'blocker'],
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

  it('returns a compact copyable attention_inbox call before work selection', async () => {
    writeActiveSession();
    const res = await client.callTool({
      name: 'hivemind_context',
      arguments: {
        repo_root: repoRoot,
        session_id: 'agent-session',
        agent: 'codex',
        query: 'coordination loop',
        limit: 5,
      },
    });
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}';
    const context = JSON.parse(text) as HivemindContextResult;

    expect(context.summary.suggested_call).toBe(
      `mcp__colony__attention_inbox({ agent: "codex", session_id: "agent-session", repo_root: ${JSON.stringify(
        repoRoot,
      )} })`,
    );
    expect(context.summary.must_check_attention).toBe(true);
    expect(context.summary.next_action).toBe(
      'Do not choose work yet. Call attention_inbox now, then task_ready_for_agent.',
    );
    expect(text.length).toBeLessThan(6000);
    expect(text).not.toContain('content');

    store.addObservation({
      session_id: 'agent-session',
      kind: 'tool_use',
      content: 'attention_inbox',
      metadata: { tool: 'mcp__colony__attention_inbox' },
    });
    const afterInbox = await call<HivemindContextResult>('hivemind_context', {
      repo_root: repoRoot,
      session_id: 'agent-session',
      agent: 'codex',
      query: 'coordination loop',
      limit: 5,
    });
    expect(afterInbox.summary.must_check_attention).toBe(false);
  });

  it('documents the same ToolSearch phrases in the MCP README table', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    const tableRows = readme
      .split('\n')
      .filter((line) => line.trim().startsWith('|'))
      .map((line) => line.toLowerCase());

    const documentedMappings: Array<[string, string]> = [
      ['after hivemind_context', 'attention_inbox'],
      ['pending, unread, blocking', 'attention_inbox'],
      ['pick next task', 'task_ready_for_agent'],
      ['active ownership', 'hivemind_context'],
      ['claim file', 'task_claim_file'],
      ['search prior memory', 'search'],
      ['save current working state', 'task_note_working'],
      ['task-scoped question', 'task_post'],
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
    const warningId = store.addObservation({
      session_id: 'planner-session',
      kind: 'failed_approach',
      content:
        'Failed approach: do not repeat manual polling for coordination loop ToolSearch docs in apps/mcp-server/README.md; use task_ready_for_agent.',
    });

    const context = await call<HivemindContextResult>('hivemind_context', {
      repo_root: repoRoot,
      session_id: 'agent-session',
      agent: 'codex',
      query: 'coordination loop',
      memory_limit: 1,
      limit: 5,
    });
    expect(context.summary.lane_count).toBe(1);
    expect(context.summary.memory_hit_count).toBeGreaterThan(0);
    expect(context.summary.negative_warning_count).toBe(1);
    expect(context.summary.next_action).toBe(
      'Do not choose work yet. Call attention_inbox now, then task_ready_for_agent.',
    );
    expect(context.summary.suggested_call).toBe(
      `mcp__colony__attention_inbox({ agent: "codex", session_id: "agent-session", repo_root: ${JSON.stringify(
        repoRoot,
      )} })`,
    );
    expect(context.summary.suggested_tools).toEqual(['attention_inbox', 'task_ready_for_agent']);
    expect(context.summary.must_check_attention).toBe(true);
    expect(context.summary.attention_hint).toContain('attention_inbox');
    expect(context.summary.ready_work_hint).toContain('task_ready_for_agent');
    expect(context.summary.ready_work_hint).toContain('task_list only for browsing/debugging');
    expect(context.summary.unread_message_count).toBe(0);
    expect(context.summary.pending_handoff_count).toBe(0);
    expect(context.summary.blocking).toBe(false);
    expect(context.summary.ready_work_count).toBe(0);
    expect(context.summary.state_tool_replacements.state_write).toEqual([
      'task_note_working',
      'task_post',
    ]);
    expect(context.attention).toMatchObject({
      unread_messages: 0,
      pending_handoffs: 0,
      blocking: false,
      hydrate_with: 'attention_inbox',
    });
    expect(context.lanes[0]?.branch).toBe('agent/other/active-loop');
    expect(context.memory_hits[0]?.snippet).toMatch(/coordination|loop/i);
    expect(context.negative_warnings[0]).toMatchObject({
      id: warningId,
      kind: 'failed_approach',
    });

    const published = await call<PublishResult>('task_plan_publish', publishLoopArgs());
    if (!Array.isArray(published.subtasks)) {
      throw new Error(`expected publish subtasks, got ${JSON.stringify(published)}`);
    }
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

    const followupContext = await call<HivemindContextResult>('hivemind_context', {
      repo_root: repoRoot,
      session_id: 'agent-session',
      agent: 'codex',
      query: 'coordination loop',
      limit: 5,
    });
    expect(followupContext.summary.ready_work_count).toBe(1);
    expect(followupContext.summary.unread_message_count).toBe(1);
    expect(followupContext.summary.pending_handoff_count).toBe(0);
    expect(followupContext.summary.blocking).toBe(true);

    const inbox = await call<InboxResult>('attention_inbox', {
      session_id: 'agent-session',
      agent: 'codex',
      repo_root: repoRoot,
      task_ids: [firstTask.task_id],
      format: 'full',
    });
    expect(inbox.summary.unread_message_count).toBe(1);
    expect(inbox.summary.blocked).toBe(true);
    expect(inbox.unread_messages[0]?.urgency).toBe('blocking');

    const ready = await call<ReadyResult>('task_ready_for_agent', {
      session_id: 'agent-session',
      agent: 'codex',
      repo_root: repoRoot,
      limit: 3,
      auto_claim: false,
    });
    expect(ready.total_available).toBe(1);
    const readyTask = ready.ready[0];
    if (!readyTask) throw new Error('expected one ready task');
    expect(readyTask).toMatchObject({
      plan_slug: 'coordination-loop',
      subtask_index: 0,
      title: 'Protect coordination loop path',
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

  it('proves the OMX telemetry to Colony coordination bridge model end to end', async () => {
    const bridgeLane = writeBridgeActiveSession();
    const hiddenMessageTail = 'FULL-BRIDGE-MESSAGE-BODY-TAIL';
    const hiddenNoteTail = 'FULL-BRIDGE-WORKING-NOTE-BODY-TAIL';

    const initialContext = await call<HivemindContextResult>('hivemind_context', {
      repo_root: repoRoot,
      session_id: 'agent-session',
      agent: 'codex',
      query: 'bridge model runtime telemetry',
      limit: 5,
    });
    expect(initialContext.lanes[0]).toMatchObject({
      branch: bridgeLane.branch,
      task: bridgeLane.task,
      owner: 'codex/codex',
    });

    const published = await call<PublishResult>('task_plan_publish', bridgePlanArgs());
    const firstTask = published.subtasks[0];
    if (!firstTask) throw new Error('expected first bridge subtask');
    new TaskThread(store, firstTask.task_id).join('agent-session', 'codex');

    const longMessage = `${'Bridge status needs your attention before claiming. '.repeat(4)}${hiddenMessageTail}`;
    const message = await call<MessageResult>('task_message', {
      task_id: firstTask.task_id,
      session_id: 'planner-session',
      agent: 'claude',
      to_agent: 'codex',
      urgency: 'blocking',
      content: longMessage,
    });
    expect(message.status).toBe('unread');

    const contextWithCoordination = await call<HivemindContextResult>('hivemind_context', {
      repo_root: repoRoot,
      session_id: 'agent-session',
      agent: 'codex',
      query: 'bridge model runtime telemetry',
      limit: 5,
    });
    expect(contextWithCoordination.summary.ready_work_count).toBe(1);
    expect(contextWithCoordination.summary.attention_counts).toMatchObject({
      unread_message_count: 1,
      blocked: true,
    });
    expect(contextWithCoordination.attention.observation_ids).toContain(
      message.message_observation_id,
    );
    expect(contextWithCoordination.attention.hydrate_with).toBe('attention_inbox');
    expect(contextWithCoordination.attention.hydration).toContain('get_observations');

    const inbox = await call<InboxResult>('attention_inbox', {
      session_id: 'agent-session',
      agent: 'codex',
      repo_root: repoRoot,
      task_ids: [firstTask.task_id],
      format: 'full',
    });
    expect(inbox.summary).toMatchObject({ unread_message_count: 1, blocked: true });
    expect(inbox.unread_messages[0]).toMatchObject({
      id: message.message_observation_id,
      urgency: 'blocking',
    });
    expect(inbox.unread_messages[0]?.preview).not.toContain(hiddenMessageTail);

    const ready = await call<ReadyResult>('task_ready_for_agent', {
      session_id: 'agent-session',
      agent: 'codex',
      repo_root: repoRoot,
      limit: 3,
      auto_claim: false,
    });
    expect(ready.total_available).toBe(1);
    expect(ready.ready[0]).toMatchObject({
      plan_slug: 'omx-colony-bridge-e2e',
      subtask_index: 0,
      title: 'Prove bridge model path',
      file_scope: ['apps/mcp-server/test/coordination-loop.test.ts'],
    });

    const claimed = await call<ClaimSubtaskResult>('task_plan_claim_subtask', {
      plan_slug: 'omx-colony-bridge-e2e',
      subtask_index: 0,
      session_id: 'agent-session',
      agent: 'codex',
    });
    expect(claimed).toMatchObject({
      task_id: firstTask.task_id,
      branch: 'spec/omx-colony-bridge-e2e/sub-0',
      file_scope: ['apps/mcp-server/test/coordination-loop.test.ts'],
    });

    await call('task_claim_file', {
      task_id: claimed.task_id,
      session_id: 'agent-session',
      file_path: 'apps/mcp-server/src/tools/hivemind.ts',
      note: 'Bridge status render needs claimed-file preview.',
    });

    const note = await call<NoteWorkingResult>('task_note_working', {
      session_id: 'agent-session',
      repo_root: repoRoot,
      branch: claimed.branch,
      content: `${'bridge working note compact status source. '.repeat(4)}${hiddenNoteTail}`,
    });
    expect(note.task_id).toBe(claimed.task_id);

    const localContext = await call<HivemindContextResult>('hivemind_context', {
      mode: 'local',
      repo_root: repoRoot,
      session_id: 'agent-session',
      agent: 'codex',
      task_id: claimed.task_id,
      files: [
        'apps/mcp-server/test/coordination-loop.test.ts',
        'apps/mcp-server/src/tools/hivemind.ts',
      ],
      limit: 5,
    });
    expect(localContext.local_context?.current_task).toMatchObject({
      id: claimed.task_id,
      branch: claimed.branch,
    });
    expect(localContext.local_context?.claims.map((claim) => claim.file_path).sort()).toEqual([
      'apps/mcp-server/src/tools/hivemind.ts',
      'apps/mcp-server/test/coordination-loop.test.ts',
    ]);

    const timeline = await call<TimelineEntry[]>('task_timeline', {
      task_id: claimed.task_id,
      limit: 20,
    });
    expect(timeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: note.id, kind: 'note', session_id: 'agent-session' }),
      ]),
    );

    const status = renderOmxBridgeStatus({
      context: contextWithCoordination,
      localContext,
      ready,
      timeline,
    });
    expect(status).toEqual({
      active_branch: bridgeLane.branch,
      current_task: 'Prove bridge model path',
      attention_counts: expect.objectContaining({ unread_message_count: 1, blocked: true }),
      ready_work_count: 1,
      claimed_file_preview: [
        'apps/mcp-server/src/tools/hivemind.ts',
        'apps/mcp-server/test/coordination-loop.test.ts',
      ],
      latest_note_id: note.id,
    });

    const compactPayload = JSON.stringify({
      initialContext,
      contextWithCoordination,
      inbox,
      ready,
      claimed,
      localContext,
      timeline,
      status,
    });
    expect(compactPayload).not.toContain(hiddenMessageTail);
    expect(compactPayload).not.toContain(hiddenNoteTail);

    const hydrated = await call<ObservationResult[]>('get_observations', {
      ids: [message.message_observation_id, note.id],
    });
    expect(hydrated.map((entry) => entry.content).join('\n')).toContain(hiddenMessageTail);
    expect(hydrated.map((entry) => entry.content).join('\n')).toContain(hiddenNoteTail);
  });
});
