import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
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
  dir = mkdtempSync(join(tmpdir(), 'colony-tasks-'));
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

  it('marks claims handoff_pending without deleting the row', () => {
    seedSessions('owner', 'successor');
    const task = storage.findOrCreateTask({
      title: 'quota relay',
      repo_root: '/r',
      branch: 'b',
      created_by: 'owner',
    });
    storage.claimFile({ task_id: task.id, file_path: 'src/x.ts', session_id: 'owner' });
    const relayId = storage.insertObservation({
      session_id: 'owner',
      kind: 'relay',
      content: 'quota relay',
      task_id: task.id,
    });
    storage.markClaimHandoffPending({
      task_id: task.id,
      file_path: 'src/x.ts',
      session_id: 'owner',
      expires_at: 1234,
      handoff_observation_id: relayId,
    });

    expect(storage.getClaim(task.id, 'src/x.ts')).toMatchObject({
      session_id: 'owner',
      state: 'handoff_pending',
      expires_at: 1234,
      handoff_observation_id: relayId,
    });

    storage.claimFile({ task_id: task.id, file_path: 'src/x.ts', session_id: 'successor' });
    expect(storage.listClaims(task.id)).toEqual([
      expect.objectContaining({
        file_path: 'src/x.ts',
        session_id: 'successor',
        state: 'active',
        expires_at: null,
        handoff_observation_id: null,
      }),
    ]);
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

  it('recentClaims filters by the (since_ts, now] window', () => {
    seedSessions('s-a');
    const task = storage.findOrCreateTask({
      title: 't',
      repo_root: '/r',
      branch: 'b',
      created_by: 's-a',
    });
    storage.claimFile({ task_id: task.id, file_path: 'fresh.ts', session_id: 's-a' });
    // Stale claim: write then overwrite claimed_at to a past timestamp.
    storage.claimFile({ task_id: task.id, file_path: 'stale.ts', session_id: 's-a' });
    (
      storage as unknown as {
        db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } };
      }
    ).db
      .prepare('UPDATE task_claims SET claimed_at = ? WHERE file_path = ?')
      .run(Date.now() - 60 * 60_000, 'stale.ts');

    const window = Date.now() - 5 * 60_000;
    const recent = storage.recentClaims(task.id, window);
    expect(recent.map((c) => c.file_path)).toEqual(['fresh.ts']);
  });

  it('linkTasks normalises ordering and is idempotent', () => {
    seedSessions('s-a');
    const taskA = storage.findOrCreateTask({
      title: 'A',
      repo_root: '/r',
      branch: 'a',
      created_by: 's-a',
    });
    const taskB = storage.findOrCreateTask({
      title: 'B',
      repo_root: '/r',
      branch: 'b',
      created_by: 's-a',
    });

    const first = storage.linkTasks({
      task_id_a: taskB.id,
      task_id_b: taskA.id,
      created_by: 's-a',
      note: 'frontend ↔ backend',
    });
    // Stored canonically with low_id < high_id regardless of caller order.
    expect(first.low_id).toBeLessThan(first.high_id);
    expect(first.low_id).toBe(Math.min(taskA.id, taskB.id));
    expect(first.high_id).toBe(Math.max(taskA.id, taskB.id));

    // Re-linking the same pair (in either order) preserves the original
    // metadata — no clobber of created_by / note.
    const second = storage.linkTasks({
      task_id_a: taskA.id,
      task_id_b: taskB.id,
      created_by: 's-other',
      note: 'overwritten?',
    });
    expect(second.created_by).toBe('s-a');
    expect(second.note).toBe('frontend ↔ backend');
  });

  it('linkedTasks returns the other side regardless of insertion order', () => {
    seedSessions('s-a');
    const a = storage.findOrCreateTask({
      title: 'A',
      repo_root: '/r',
      branch: 'a',
      created_by: 's-a',
    });
    const b = storage.findOrCreateTask({
      title: 'B',
      repo_root: '/r',
      branch: 'b',
      created_by: 's-a',
    });
    const c = storage.findOrCreateTask({
      title: 'C',
      repo_root: '/r',
      branch: 'c',
      created_by: 's-a',
    });

    storage.linkTasks({ task_id_a: a.id, task_id_b: b.id, created_by: 's-a' });
    storage.linkTasks({ task_id_a: c.id, task_id_b: a.id, created_by: 's-a', note: 'paired' });

    const fromA = storage.linkedTasks(a.id);
    expect(fromA.map((l) => l.task_id).sort()).toEqual([b.id, c.id].sort());
    const cLink = fromA.find((l) => l.task_id === c.id);
    expect(cLink?.note).toBe('paired');

    // The link is symmetric — listing from B sees A.
    expect(storage.linkedTasks(b.id).map((l) => l.task_id)).toEqual([a.id]);
  });

  it('unlinkTasks reports whether a row was removed', () => {
    seedSessions('s-a');
    const a = storage.findOrCreateTask({
      title: 'A',
      repo_root: '/r',
      branch: 'a',
      created_by: 's-a',
    });
    const b = storage.findOrCreateTask({
      title: 'B',
      repo_root: '/r',
      branch: 'b',
      created_by: 's-a',
    });
    storage.linkTasks({ task_id_a: a.id, task_id_b: b.id, created_by: 's-a' });
    expect(storage.unlinkTasks(b.id, a.id)).toBe(true);
    expect(storage.unlinkTasks(b.id, a.id)).toBe(false);
    expect(storage.linkedTasks(a.id)).toEqual([]);
  });

  it('linkTasks rejects self-links', () => {
    seedSessions('s-a');
    const a = storage.findOrCreateTask({
      title: 'A',
      repo_root: '/r',
      branch: 'a',
      created_by: 's-a',
    });
    expect(() =>
      storage.linkTasks({ task_id_a: a.id, task_id_b: a.id, created_by: 's-a' }),
    ).toThrow();
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

  it('migrates old task_claims rows without claim state columns', () => {
    seedSessions('s-a');
    const task = storage.findOrCreateTask({
      title: 't',
      repo_root: '/r',
      branch: 'b',
      created_by: 's-a',
    });
    storage.claimFile({ task_id: task.id, file_path: 'src/x.ts', session_id: 's-a' });
    storage.close();
    rewriteTaskClaimsAsOldSchema(join(dir, 'test.db'));

    storage = new Storage(join(dir, 'test.db'));

    expect(taskClaimColumns(join(dir, 'test.db'))).toEqual(
      expect.arrayContaining(['state', 'expires_at', 'handoff_observation_id']),
    );
    expect(storage.getClaim(task.id, 'src/x.ts')).toMatchObject({
      task_id: task.id,
      file_path: 'src/x.ts',
      session_id: 's-a',
      state: 'active',
      expires_at: null,
      handoff_observation_id: null,
    });
    expect(storage.recentClaims(task.id, 0)).toEqual([
      expect.objectContaining({
        file_path: 'src/x.ts',
        session_id: 's-a',
        state: 'active',
      }),
    ]);
  });
});

function rewriteTaskClaimsAsOldSchema(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      ALTER TABLE task_claims RENAME TO task_claims_new;
      CREATE TABLE task_claims (
        task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        claimed_at INTEGER NOT NULL,
        PRIMARY KEY (task_id, file_path)
      );
      INSERT INTO task_claims(task_id, file_path, session_id, claimed_at)
        SELECT task_id, file_path, session_id, claimed_at FROM task_claims_new;
      DROP TABLE task_claims_new;
      CREATE INDEX IF NOT EXISTS idx_task_claims_session ON task_claims(session_id);
    `);
  } finally {
    db.close();
  }
}

function taskClaimColumns(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.prepare('PRAGMA table_info(task_claims)').all() as Array<{ name: string }>).map(
      (col) => col.name,
    );
  } finally {
    db.close();
  }
}
