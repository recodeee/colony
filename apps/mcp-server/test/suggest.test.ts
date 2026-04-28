import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { type Embedder, MemoryStore, type SuggestionPayload } from '@colony/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolContext } from '../src/tools/context.js';
import * as suggest from '../src/tools/suggest.js';

const DIM = 3;
const MODEL = 'test-embedder';
let directory: string;
let store: MemoryStore;
let client: Client;
let embedder: Embedder | null;
let clock: number;

class FakeEmbedder implements Embedder {
  readonly model = MODEL;
  readonly dim = DIM;

  embed(text: string): Promise<Float32Array> {
    return Promise.resolve(text.includes('auth middleware') ? unitVec(0) : unitVec(1));
  }
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'colony-suggest-mcp-'));
  store = new MemoryStore({ dbPath: join(directory, 'data.db'), settings: defaultSettings });
  store.startSession({ id: 'seed', ide: 'test', cwd: '/r' });
  embedder = new FakeEmbedder();
  clock = 1_800_000_000_000;

  const server = new McpServer({ name: 'colony-test', version: '0.0.0' });
  const ctx: ToolContext = {
    store,
    settings: defaultSettings,
    resolveEmbedder: async () => embedder,
  };
  suggest.register(server, ctx);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterEach(async () => {
  await client.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('task_suggest_approach', () => {
  it('returns corpus too small for an empty corpus', async () => {
    const payload = await callSuggest({ query: 'fix auth middleware' });
    expect(payload.insufficient_data_reason).toBe('corpus too small');
    expect(payload.similar_tasks).toEqual([]);
  });

  it('returns only the 3 auth middleware tasks from a 10 task corpus', async () => {
    seedAuthMiddlewareCorpus();

    const payload = await callSuggest({ query: 'fix auth middleware' });

    expect(payload.insufficient_data_reason).toBeNull();
    expect(payload.similar_tasks.map((task) => task.branch).sort()).toEqual([
      'auth-middleware-1',
      'auth-middleware-2',
      'auth-middleware-3',
    ]);
  });

  it('ranks first claimed files by manual corpus frequency', async () => {
    seedAuthMiddlewareCorpus();

    const payload = await callSuggest({ query: 'fix auth middleware' });

    expect(payload.first_files_likely_claimed.map((file) => file.file_path)).toEqual([
      'apps/api/auth.ts',
      'apps/api/middleware.ts',
      'packages/core/src/session.ts',
      'apps/web/login.ts',
      'packages/core/src/token.ts',
    ]);
    expect(payload.first_files_likely_claimed.map((file) => file.appears_in_count)).toEqual([
      3, 2, 2, 1, 1,
    ]);
  });

  it('returns embedder unavailable without throwing', async () => {
    embedder = null;

    const payload = await callSuggest({ query: 'fix auth middleware' });

    expect(payload.insufficient_data_reason).toBe('embedder unavailable');
    expect(payload.similar_tasks).toEqual([]);
  });
});

async function callSuggest(args: Record<string, unknown>): Promise<SuggestionPayload> {
  const result = await client.callTool({ name: 'task_suggest_approach', arguments: args });
  const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}';
  return JSON.parse(text) as SuggestionPayload;
}

function seedAuthMiddlewareCorpus(): void {
  seedTask({
    branch: 'auth-middleware-1',
    axis: 0,
    claims: ['apps/api/auth.ts', 'apps/api/middleware.ts', 'packages/core/src/session.ts'],
    completed: true,
  });
  seedTask({
    branch: 'auth-middleware-2',
    axis: 0,
    claims: ['apps/api/auth.ts', 'apps/api/middleware.ts', 'apps/web/login.ts'],
    completed: true,
    pattern: 'plan-archive-blocked',
  });
  seedTask({
    branch: 'auth-middleware-3',
    axis: 0,
    claims: ['apps/api/auth.ts', 'packages/core/src/session.ts', 'packages/core/src/token.ts'],
    pattern: 'expired-handoff',
  });

  for (let i = 0; i < 7; i++) {
    seedTask({
      branch: `background-${i}`,
      axis: 1,
      claims: [`docs/background-${i}.md`],
    });
  }
}

function seedTask(args: {
  branch: string;
  axis: number;
  claims: string[];
  completed?: boolean;
  pattern?: 'expired-handoff' | 'plan-archive-blocked';
}): number {
  const task = store.storage.findOrCreateTask({
    title: args.branch,
    repo_root: '/r',
    branch: args.branch,
    created_by: 'seed',
  });

  for (const filePath of args.claims) {
    insertObservation(task.id, 'claim', `claim ${filePath}`, {
      kind: 'claim',
      file_path: filePath,
    });
  }
  for (let i = 0; i < 5; i++) {
    insertObservation(task.id, 'note', `${args.branch} observation ${i}`, undefined, args.axis);
  }
  if (args.pattern === 'plan-archive-blocked') {
    insertObservation(
      task.id,
      'plan-archive-blocked',
      'archive blocked by conflict in auth middleware plan',
    );
  }
  if (args.pattern === 'expired-handoff') {
    insertObservation(task.id, 'expired-handoff', 'handoff expired during auth middleware repair');
  }
  if (args.completed) {
    insertObservation(task.id, 'plan-auto-archive', 'plan archived after auth middleware fix');
  }

  return task.id;
}

function insertObservation(
  taskId: number,
  kind: string,
  content: string,
  metadata?: Record<string, unknown>,
  axis?: number,
): number {
  const id = store.storage.insertObservation({
    session_id: 'seed',
    kind,
    content,
    compressed: false,
    intensity: null,
    task_id: taskId,
    ts: clock++,
    ...(metadata !== undefined ? { metadata } : {}),
  });
  if (axis !== undefined) {
    store.storage.putEmbedding(id, MODEL, unitVec(axis));
  }
  return id;
}

function unitVec(axis: number): Float32Array {
  const vec = new Float32Array(DIM);
  vec[axis] = 1;
  return vec;
}
