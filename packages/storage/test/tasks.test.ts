import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Storage } from '../src/index.js';

let dir: string;
let storage: Storage;

function seedSessions(...ids: string[]): void {
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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cavemem-tasks-'));
  storage = new Storage(join(dir, 'test.db'));
});

afterEach(() => {
  storage.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('tasks', () => {
  it('findOrCreateTask returns the same row for the same (repo_root, branch)', () => {
    seedSessions('s-a', 's-b');
    const a = storage.findOrCreateTask({
      title: 'viewer work',
      repo_root: '/repo',
      branch: 'agent/claude/viewer',
      created_by: 's-a',
    });
    const b = storage.findOrCreateTask({
      title: 'different title',
      repo_root: '/repo',
      branch: 'agent/claude/viewer',
      created_by: 's-b',
    });
    expect(b.id).toBe(a.id);
    // Title from the original create wins — we don't clobber.
    expect(b.title).toBe('viewer work');
  });

  it('participants list deduplicates a session rejoining the same task', () => {
    seedSessions('s-1');
    const task = storage.findOrCreateTask({
      title: 't',
      repo_root: '/r',
      branch: 'b',
      created_by: 's-1',
    });
    storage.addTaskParticipant({ task_id: task.id, session_id: 's-1', agent: 'claude' });
    storage.addTaskParticipant({ task_id: task.id, session_id: 's-1', agent: 'claude' });
    expect(storage.listParticipants(task.id)).toHaveLength(1);
  });

  it('claims + release with owner enforcement', () => {
    seedSessions('owner', 'stranger');
    const task = storage.findOrCreateTask({
      title: 't',
      repo_root: '/r',
      branch: 'b',
      created_by: 'owner',
    });
    storage.claimFile({ task_id: task.id, file_path: 'src/x.ts', session_id: 'owner' });
    expect(storage.getClaim(task.id, 'src/x.ts')?.session_id).toBe('owner');

    // A stranger's release is a no-op — only the current owner can release.
    storage.releaseClaim({ task_id: task.id, file_path: 'src/x.ts', session_id: 'stranger' });
    expect(storage.getClaim(task.id, 'src/x.ts')?.session_id).toBe('owner');

    storage.releaseClaim({ task_id: task.id, file_path: 'src/x.ts', session_id: 'owner' });
    expect(storage.getClaim(task.id, 'src/x.ts')).toBeUndefined();
  });

  it('observations carry task_id and surface via taskObservationsSince', () => {
    seedSessions('s-a', 's-b');
    const task = storage.findOrCreateTask({
      title: 't',
      repo_root: '/r',
      branch: 'b',
      created_by: 's-a',
    });
    const t0 = Date.now();
    const a1 = storage.insertObservation({
      session_id: 's-a',
      kind: 'note',
      content: 'before',
      compressed: false,
      intensity: null,
      task_id: task.id,
      ts: t0,
    });
    const b1 = storage.insertObservation({
      session_id: 's-b',
      kind: 'note',
      content: 'after',
      compressed: false,
      intensity: null,
      task_id: task.id,
      ts: t0 + 1000,
    });
    const rows = storage.taskObservationsSince(task.id, t0);
    expect(rows.map((r) => r.id)).toEqual([b1]);
    expect(rows.map((r) => r.id)).not.toContain(a1);
  });

  it('transaction rolls back every write on throw', () => {
    seedSessions('s-a');
    const task = storage.findOrCreateTask({
      title: 't',
      repo_root: '/r',
      branch: 'b',
      created_by: 's-a',
    });
    expect(() =>
      storage.transaction(() => {
        storage.claimFile({ task_id: task.id, file_path: 'a.ts', session_id: 's-a' });
        storage.claimFile({ task_id: task.id, file_path: 'b.ts', session_id: 's-a' });
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(storage.getClaim(task.id, 'a.ts')).toBeUndefined();
    expect(storage.getClaim(task.id, 'b.ts')).toBeUndefined();
  });

  it('findActiveTaskForSession returns the joined task', () => {
    seedSessions('s-a');
    const task = storage.findOrCreateTask({
      title: 't',
      repo_root: '/r',
      branch: 'b',
      created_by: 's-a',
    });
    expect(storage.findActiveTaskForSession('s-a')).toBeUndefined();
    storage.addTaskParticipant({ task_id: task.id, session_id: 's-a', agent: 'claude' });
    expect(storage.findActiveTaskForSession('s-a')).toBe(task.id);
  });

  it('lastObservationTsForSession returns 0 when no observations exist', () => {
    seedSessions('s-a');
    expect(storage.lastObservationTsForSession('s-a')).toBe(0);
    expect(storage.lastObservationTsForSession('s-a', 'user_prompt')).toBe(0);
  });

  it('reopening an existing database preserves the task schema', () => {
    seedSessions('s-a');
    storage.findOrCreateTask({
      title: 't',
      repo_root: '/r',
      branch: 'b',
      created_by: 's-a',
    });
    storage.close();
    // Opening the same db twice must not throw even though the column
    // migration would fail a second time if applied unconditionally.
    storage = new Storage(join(dir, 'test.db'));
    const t = storage.findTaskByBranch('/r', 'b');
    expect(t?.title).toBe('t');
  });
});
