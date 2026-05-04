import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { MemoryStore } from '@colony/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolContext } from '../src/tools/context.js';
import * as drift from '../src/tools/drift.js';
import type { DriftCheckResult } from '../src/tools/drift.js';

const REPO = '/r';
const SESSION = 'session-drift';
const OTHER_SESSION = 'session-other';
const AGENT = 'claude-code';

let directory: string;
let store: MemoryStore;
let client: Client;
let taskId: number;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'colony-drift-mcp-'));
  store = new MemoryStore({ dbPath: join(directory, 'data.db'), settings: defaultSettings });
  store.startSession({ id: SESSION, ide: AGENT, cwd: REPO });
  store.startSession({ id: OTHER_SESSION, ide: 'codex', cwd: REPO });

  const task = store.storage.findOrCreateTask({
    title: 'drift-test-task',
    repo_root: REPO,
    branch: 'agent/drift',
    created_by: AGENT,
  });
  taskId = task.id;
  store.storage.addTaskParticipant({ task_id: taskId, session_id: SESSION, agent: AGENT });
  store.storage.addTaskParticipant({ task_id: taskId, session_id: OTHER_SESSION, agent: 'codex' });

  const server = new McpServer({ name: 'colony-test', version: '0.0.0' });
  const ctx: ToolContext = {
    store,
    settings: defaultSettings,
    resolveEmbedder: async () => null,
  };
  drift.register(server, ctx);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterEach(async () => {
  await client.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('task_drift_check', () => {
  it('returns empty result when no edits or claims exist', async () => {
    const result = await callDrift();
    expect(result.claimed_files).toEqual([]);
    expect(result.edited_files).toEqual([]);
    expect(result.edits_without_claim).toEqual([]);
    expect(result.claims_without_edits).toEqual([]);
    expect(result.drift_score).toBe(0);
    expect(result.next_tool).toBeNull();
    expect(result.next_args).toBeNull();
  });

  it('flags edits without claims as drift', async () => {
    claim(SESSION, 'src/keeper.ts');
    edit(SESSION, 'Edit', 'src/keeper.ts');
    edit(SESSION, 'Write', 'src/uncovered.ts');

    const result = await callDrift();

    expect(result.edits_without_claim).toEqual(['src/uncovered.ts']);
    expect(result.claimed_files).toContain('src/keeper.ts');
    expect(result.edited_files.sort()).toEqual(['src/keeper.ts', 'src/uncovered.ts']);
    expect(result.drift_score).toBeCloseTo(0.5, 2);
    expect(result.next_tool).toBe('task_claim_file');
    expect(result.next_args).toEqual([
      { session_id: SESSION, task_id: taskId, file_path: 'src/uncovered.ts' },
    ]);
    expect(result.recommendation).toContain('Claim 1 file');
  });

  it('flags claims with no recent edit activity', async () => {
    claim(SESSION, 'src/idle-claim.ts');
    edit(SESSION, 'Edit', 'src/active-edit.ts');

    const result = await callDrift();

    expect(result.claims_without_edits).toEqual(['src/idle-claim.ts']);
    expect(result.edits_without_claim).toEqual(['src/active-edit.ts']);
    expect(result.recommendation).toContain('Release or revisit');
  });

  it('does not count edits or claims from other sessions', async () => {
    claim(OTHER_SESSION, 'src/their-claim.ts');
    edit(OTHER_SESSION, 'Edit', 'src/their-edit.ts');
    claim(SESSION, 'src/mine.ts');
    edit(SESSION, 'Edit', 'src/mine.ts');

    const result = await callDrift();

    expect(result.claimed_files).toEqual(['src/mine.ts']);
    expect(result.edited_files).toEqual(['src/mine.ts']);
    expect(result.edits_without_claim).toEqual([]);
    expect(result.drift_score).toBe(0);
  });

  it('ignores edits older than the window', async () => {
    claim(SESSION, 'src/recent.ts');
    // Old edit before window starts.
    edit(SESSION, 'Edit', 'src/ancient.ts', Date.now() - 24 * 60 * 60_000);
    // Recent edit inside window.
    edit(SESSION, 'Edit', 'src/recent.ts');

    const result = await callDrift({ window_minutes: 30 });

    expect(result.edited_files).toEqual(['src/recent.ts']);
    expect(result.edits_without_claim).toEqual([]);
  });
});

function claim(sessionId: string, filePath: string): void {
  store.storage.claimFile({
    task_id: taskId,
    session_id: sessionId,
    file_path: filePath,
  });
}

function edit(sessionId: string, tool: string, filePath: string, ts?: number): void {
  store.storage.insertObservation({
    session_id: sessionId,
    kind: 'tool_use',
    content: `${tool} ${filePath}`,
    compressed: false,
    intensity: null,
    task_id: taskId,
    ts: ts ?? Date.now(),
    metadata: { tool, file_path: filePath },
  });
}

async function callDrift(args: { window_minutes?: number } = {}): Promise<DriftCheckResult> {
  const result = await client.callTool({
    name: 'task_drift_check',
    arguments: {
      session_id: SESSION,
      task_id: taskId,
      ...(args.window_minutes !== undefined ? { window_minutes: args.window_minutes } : {}),
    },
  });
  const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}';
  return JSON.parse(text) as DriftCheckResult;
}
