import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Storage } from '../src/index.js';

let dir: string;
let storage: Storage;

function seed(...ids: string[]): void {
  for (const id of ids) {
    storage.createSession({
      id,
      ide: 'claude-code',
      cwd: '/tmp',
      started_at: Date.now(),
      metadata: null,
    });
  }
}

function seedTask(created_by: string): number {
  const task = storage.findOrCreateTask({
    title: 't',
    repo_root: '/r',
    branch: 'feat/pheromone',
    created_by,
  });
  return task.id;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cavemem-pheromones-'));
  storage = new Storage(join(dir, 'test.db'));
});

afterEach(() => {
  storage.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('pheromone storage', () => {
  it('upsertPheromone + getPheromone round-trip a single row', () => {
    seed('A');
    const task_id = seedTask('A');
    storage.upsertPheromone({
      task_id,
      file_path: 'src/x.ts',
      session_id: 'A',
      strength: 1.5,
      deposited_at: 1_000,
    });
    const row = storage.getPheromone(task_id, 'src/x.ts', 'A');
    expect(row).toEqual({
      task_id,
      file_path: 'src/x.ts',
      session_id: 'A',
      strength: 1.5,
      deposited_at: 1_000,
    });
  });

  it('upsertPheromone overwrites on the (task, file, session) key', () => {
    seed('A');
    const task_id = seedTask('A');
    storage.upsertPheromone({
      task_id,
      file_path: 'src/x.ts',
      session_id: 'A',
      strength: 1.0,
      deposited_at: 1_000,
    });
    storage.upsertPheromone({
      task_id,
      file_path: 'src/x.ts',
      session_id: 'A',
      strength: 2.5,
      deposited_at: 2_000,
    });
    const row = storage.getPheromone(task_id, 'src/x.ts', 'A');
    expect(row?.strength).toBe(2.5);
    expect(row?.deposited_at).toBe(2_000);
  });

  it('listPheromonesForFile returns one row per session on the same file', () => {
    seed('A', 'B');
    const task_id = seedTask('A');
    storage.upsertPheromone({
      task_id,
      file_path: 'src/x.ts',
      session_id: 'A',
      strength: 1.0,
      deposited_at: 1_000,
    });
    storage.upsertPheromone({
      task_id,
      file_path: 'src/x.ts',
      session_id: 'B',
      strength: 3.0,
      deposited_at: 2_000,
    });
    const rows = storage.listPheromonesForFile(task_id, 'src/x.ts');
    expect(rows.map((r) => r.session_id).sort()).toEqual(['A', 'B']);
  });

  it('listPheromonesForTask returns every row for the task', () => {
    seed('A');
    const task_id = seedTask('A');
    storage.upsertPheromone({
      task_id,
      file_path: 'src/x.ts',
      session_id: 'A',
      strength: 1.0,
      deposited_at: 1_000,
    });
    storage.upsertPheromone({
      task_id,
      file_path: 'src/y.ts',
      session_id: 'A',
      strength: 2.0,
      deposited_at: 2_000,
    });
    const rows = storage.listPheromonesForTask(task_id);
    expect(rows.map((r) => r.file_path).sort()).toEqual(['src/x.ts', 'src/y.ts']);
  });

  it('pheromones cascade on session delete', () => {
    seed('A');
    const task_id = seedTask('A');
    storage.upsertPheromone({
      task_id,
      file_path: 'src/x.ts',
      session_id: 'A',
      strength: 1.0,
      deposited_at: 1_000,
    });
    // Drop the session row — FK cascade must clear the pheromone.
    (
      storage as unknown as {
        db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } };
      }
    ).db
      .prepare('DELETE FROM sessions WHERE id = ?')
      .run('A');
    expect(storage.getPheromone(task_id, 'src/x.ts', 'A')).toBeUndefined();
  });
});
