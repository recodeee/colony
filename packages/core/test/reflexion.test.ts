import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/memory-store.js';
import { recordReflexion } from '../src/reflexion.js';
import { TaskThread } from '../src/task-thread.js';

let dir: string;
let store: MemoryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'colony-reflexion-'));
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
  store.startSession({ id: 'codex', ide: 'codex', cwd: '/repo' });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('recordReflexion', () => {
  it('records Agent 69 metadata and deduplicates by idempotency key', () => {
    const thread = TaskThread.open(store, {
      repo_root: '/repo',
      branch: 'main',
      session_id: 'codex',
    });
    const first = recordReflexion(store, {
      session_id: 'codex',
      task_id: thread.task_id,
      kind: 'failure',
      action: 'archive blocked',
      observation_summary: 'plan archive blocked by conflict',
      reflection: 'resolve spec conflicts before archive',
      source_kind: 'plan-archive-blocked',
      source_observation_id: 123,
      idempotency_key: 'plan-archive-blocked:test',
      now: 1000,
      tags: ['plan'],
    });
    const second = recordReflexion(store, {
      session_id: 'codex',
      task_id: thread.task_id,
      kind: 'failure',
      action: 'archive blocked',
      observation_summary: 'plan archive blocked by conflict',
      reflection: 'resolve spec conflicts before archive',
      source_kind: 'plan-archive-blocked',
      source_observation_id: 123,
      idempotency_key: 'plan-archive-blocked:test',
      now: 1100,
    });

    expect(first).toBeGreaterThan(0);
    expect(second).toBe(-1);
    const [row] = store.storage.taskObservationsByKind(thread.task_id, 'reflexion', 10);
    expect(row).toBeDefined();
    expect(JSON.parse(row?.metadata ?? '{}')).toMatchObject({
      kind: 'failure',
      reward: -1,
      success: false,
      task_id: thread.task_id,
      action: 'archive blocked',
      observation_summary: 'plan archive blocked by conflict',
      reflection: 'resolve spec conflicts before archive',
      source_kind: 'plan-archive-blocked',
      source_observation_id: 123,
      idempotency_key: 'plan-archive-blocked:test',
      tags: ['plan'],
      observed_at: 1000,
    });
  });

  it('clamps generated summary fields instead of throwing', () => {
    const thread = TaskThread.open(store, {
      repo_root: '/repo',
      branch: 'main',
      session_id: 'codex',
    });
    const longSummary = `plan ${'very-long-change-slug-'.repeat(20)} archive blocked by 12 conflict(s)`;
    const id = recordReflexion(store, {
      session_id: 'codex',
      task_id: thread.task_id,
      kind: 'failure',
      action: 'archive blocked',
      observation_summary: longSummary,
      reflection: 'resolve spec conflicts before archive',
      source_kind: 'plan-archive-blocked',
      idempotency_key: 'plan-archive-blocked:long-summary',
    });

    expect(id).toBeGreaterThan(0);
    const [row] = store.storage.taskObservationsByKind(thread.task_id, 'reflexion', 10);
    const metadata = JSON.parse(row?.metadata ?? '{}');
    expect(metadata.observation_summary).toHaveLength(240);
    expect(metadata.observation_summary).toMatch(/\.\.\.$/);
  });
});
