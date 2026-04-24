import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { MemoryStore, PheromoneSystem, TaskThread } from '@colony/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { depositPheromoneFromToolUse } from '../src/handlers/post-tool-use.js';
import { buildPheromoneConflictPreface } from '../src/handlers/user-prompt-submit.js';
import { runHook } from '../src/runner.js';

let dir: string;
let store: MemoryStore;

function seedTwoSessionTask(): number {
  store.startSession({ id: 'A', ide: 'claude-code', cwd: '/repo' });
  store.startSession({ id: 'B', ide: 'codex', cwd: '/repo' });
  const thread = TaskThread.open(store, {
    repo_root: '/repo',
    branch: 'feat/pheromone',
    session_id: 'A',
  });
  thread.join('A', 'claude');
  thread.join('B', 'codex');
  return thread.task_id;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'colony-pheromone-hooks-'));
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('depositPheromoneFromToolUse', () => {
  it('deposits on every file a write-family tool touched', () => {
    const task_id = seedTwoSessionTask();
    const result = depositPheromoneFromToolUse(store, {
      session_id: 'A',
      tool_name: 'Edit',
      tool_input: { file_path: 'src/x.ts' },
    });
    expect(result.deposited).toEqual(['src/x.ts']);
    const row = store.storage.getPheromone(task_id, 'src/x.ts', 'A');
    expect(row?.strength).toBe(PheromoneSystem.depositAmount);
  });

  it('is a no-op for non-write tools', () => {
    seedTwoSessionTask();
    const result = depositPheromoneFromToolUse(store, {
      session_id: 'A',
      tool_name: 'Read',
      tool_input: { file_path: 'src/x.ts' },
    });
    expect(result.deposited).toEqual([]);
  });

  it('is a no-op for sessions not joined to any task', () => {
    store.startSession({ id: 'solo', ide: 'claude-code', cwd: '/repo' });
    const result = depositPheromoneFromToolUse(store, {
      session_id: 'solo',
      tool_name: 'Edit',
      tool_input: { file_path: 'src/x.ts' },
    });
    expect(result.deposited).toEqual([]);
  });
});

describe('buildPheromoneConflictPreface', () => {
  it('surfaces files where the other session has a strong trail and I also have history', () => {
    seedTwoSessionTask();
    // B edits shared.ts twice (strength ~2.0). A edits shared.ts once.
    depositPheromoneFromToolUse(store, {
      session_id: 'B',
      tool_name: 'Edit',
      tool_input: { file_path: 'shared.ts' },
    });
    depositPheromoneFromToolUse(store, {
      session_id: 'B',
      tool_name: 'Edit',
      tool_input: { file_path: 'shared.ts' },
    });
    depositPheromoneFromToolUse(store, {
      session_id: 'A',
      tool_name: 'Edit',
      tool_input: { file_path: 'shared.ts' },
    });

    const preface = buildPheromoneConflictPreface(store, 'A');
    expect(preface).toContain('shared.ts');
    expect(preface).toContain('B');
    expect(preface).toContain('pheromone');
  });

  it('does not warn about files I have never touched', () => {
    seedTwoSessionTask();
    // B edits solo.ts; A never touches it.
    depositPheromoneFromToolUse(store, {
      session_id: 'B',
      tool_name: 'Edit',
      tool_input: { file_path: 'solo.ts' },
    });
    depositPheromoneFromToolUse(store, {
      session_id: 'B',
      tool_name: 'Edit',
      tool_input: { file_path: 'solo.ts' },
    });
    const preface = buildPheromoneConflictPreface(store, 'A');
    expect(preface).toBe('');
  });

  it('returns empty when the other session has only a weak trail', () => {
    seedTwoSessionTask();
    // One-deposit trail from B is exactly at the 1.0 threshold — overlap
    // must fire. But an artificially weaker trail must not.
    const taskId = store.storage.findActiveTaskForSession('A');
    if (taskId === undefined) throw new Error('expected active task');
    store.storage.upsertPheromone({
      task_id: taskId,
      file_path: 'weak.ts',
      session_id: 'B',
      strength: 0.3,
      deposited_at: Date.now(),
    });
    store.storage.upsertPheromone({
      task_id: taskId,
      file_path: 'weak.ts',
      session_id: 'A',
      strength: 0.3,
      deposited_at: Date.now(),
    });
    const preface = buildPheromoneConflictPreface(store, 'A');
    expect(preface).toBe('');
  });
});

describe('runHook integration: pheromone preface via full hook pipeline', () => {
  it('PostToolUse deposits, next UserPromptSubmit surfaces overlap', async () => {
    seedTwoSessionTask();

    // A edits first.
    await runHook(
      'post-tool-use',
      {
        session_id: 'A',
        ide: 'claude-code',
        tool_name: 'Edit',
        tool_input: { file_path: 'shared.ts' },
        tool_response: { success: true },
      },
      { store },
    );
    // B edits twice (stronger trail).
    await runHook(
      'post-tool-use',
      {
        session_id: 'B',
        ide: 'codex',
        tool_name: 'Edit',
        tool_input: { file_path: 'shared.ts' },
        tool_response: { success: true },
      },
      { store },
    );
    await runHook(
      'post-tool-use',
      {
        session_id: 'B',
        ide: 'codex',
        tool_name: 'Edit',
        tool_input: { file_path: 'shared.ts' },
        tool_response: { success: true },
      },
      { store },
    );

    const nextTurn = await runHook(
      'user-prompt-submit',
      { session_id: 'A', ide: 'claude-code', prompt: 'continue' },
      { store },
    );
    expect(nextTurn.ok).toBe(true);
    expect(nextTurn.context).toContain('pheromone');
    expect(nextTurn.context).toContain('shared.ts');
    expect(nextTurn.context).toContain('B');
  });
});
