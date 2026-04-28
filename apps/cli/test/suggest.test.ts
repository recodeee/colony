import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { type Embedder, MemoryStore } from '@colony/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatSuggestionOutput, suggestForCli } from '../src/commands/suggest.js';

const DIM = 3;
const MODEL = 'test-embedder';
let directory: string;
let store: MemoryStore;
let clock: number;

class FakeEmbedder implements Embedder {
  readonly model = MODEL;
  readonly dim = DIM;

  embed(text: string): Promise<Float32Array> {
    return Promise.resolve(text.includes('auth middleware') ? unitVec(0) : unitVec(1));
  }
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'colony-suggest-cli-'));
  store = new MemoryStore({ dbPath: join(directory, 'data.db'), settings: defaultSettings });
  store.startSession({ id: 'seed', ide: 'test', cwd: '/r' });
  clock = 1_800_000_000_000;
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('colony suggest formatting', () => {
  it('renders the human-friendly report and JSON path returns parseable JSON', async () => {
    seedAuthMiddlewareCorpus();

    const payload = await suggestForCli(store, 'fix auth middleware', {
      limit: 10,
      resolveEmbedder: async () => new FakeEmbedder(),
    });

    const report = formatSuggestionOutput(payload, 'fix auth middleware');
    expect(report).toContain('colony suggest');
    expect(report).toContain('Similar tasks:');
    expect(report).toContain('Files likely claimed first:');
    expect(report).toContain('apps/api/auth.ts');
    expect(report).toContain('Resolution hints:');

    const json = formatSuggestionOutput(payload, 'fix auth middleware', { json: true });
    expect(JSON.parse(json)).toMatchObject({
      insufficient_data_reason: null,
      similar_tasks: expect.any(Array),
    });
  });

  it('collapses insufficient data to one paragraph', async () => {
    const payload = await suggestForCli(store, 'fix auth middleware', {
      limit: 10,
      resolveEmbedder: async () => new FakeEmbedder(),
    });

    const report = formatSuggestionOutput(payload, 'fix auth middleware');

    expect(payload.insufficient_data_reason).toBe('corpus too small');
    expect(report).toContain('No suggestion');
    expect(report).toContain('corpus too small');
    expect(report).not.toContain('\n');
  });
});

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
  });
  seedTask({
    branch: 'auth-middleware-3',
    axis: 0,
    claims: ['apps/api/auth.ts', 'packages/core/src/session.ts', 'packages/core/src/token.ts'],
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
