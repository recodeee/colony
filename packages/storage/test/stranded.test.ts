import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Storage } from '../src/index.js';

let dir: string;
let storage: Storage;

function createSession(id: string, started_at: number, ended = false): void {
  storage.createSession({
    id,
    ide: 'codex',
    cwd: '/repo',
    started_at,
    metadata: null,
  });
  if (ended) storage.endSession(id, started_at + 1);
}

function claimFile(session_id: string, file_path = 'packages/storage/src/storage.ts'): void {
  const task = storage.findOrCreateTask({
    title: `task-${session_id}`,
    repo_root: '/repo',
    branch: `agent/codex/${session_id}`,
    created_by: session_id,
  });
  storage.claimFile({ task_id: task.id, file_path, session_id });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'colony-stranded-'));
  storage = new Storage(join(dir, 'test.db'));
});

afterEach(() => {
  storage.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('stranded session detection', () => {
  it('returns [] for an empty database', () => {
    expect(storage.findStrandedSessions()).toEqual([]);
  });

  it('returns alive sessions with claims and no observations inside the stranded window', () => {
    createSession('quiet', Date.now() - 11 * 60_000);
    claimFile('quiet');

    const rows = storage.findStrandedSessions({ stranded_after_ms: 10 * 60_000 });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      session_id: 'quiet',
      ide: 'codex',
      cwd: '/repo',
      last_tool_error: null,
    });
    expect(JSON.parse(rows[0]?.held_claims_json ?? '[]')).toEqual([
      {
        task_id: expect.any(Number),
        file_path: 'packages/storage/src/storage.ts',
        claimed_at: expect.any(Number),
      },
    ]);
  });

  it('does not return sessions with recent observations', () => {
    createSession('active', Date.now() - 20 * 60_000);
    claimFile('active');
    storage.insertObservation({
      session_id: 'active',
      kind: 'tool_use',
      content: 'still working',
      compressed: false,
      intensity: null,
      ts: Date.now(),
    });

    expect(storage.findStrandedSessions({ stranded_after_ms: 10 * 60_000 })).toEqual([]);
  });

  it('does not return sessions without claims regardless of quietness', () => {
    createSession('unclaimed', Date.now() - 20 * 60_000);

    expect(storage.findStrandedSessions({ stranded_after_ms: 10 * 60_000 })).toEqual([]);
  });

  it('does not return ended sessions regardless of state', () => {
    createSession('ended', Date.now() - 20 * 60_000, true);
    claimFile('ended');

    expect(storage.findStrandedSessions({ stranded_after_ms: 10 * 60_000 })).toEqual([]);
  });

  it('recentToolErrors returns diagnostic tool-use failures and skips normal output', () => {
    createSession('diag', Date.now() - 20 * 60_000);
    const since = 1_000;
    storage.insertObservation({
      session_id: 'diag',
      kind: 'tool_use',
      content: 'normal tool output',
      compressed: false,
      intensity: null,
      ts: since + 1,
    });
    storage.insertObservation({
      session_id: 'diag',
      kind: 'tool_use',
      content: 'git add rejected by guard',
      compressed: false,
      intensity: null,
      ts: since + 2,
    });
    storage.insertObservation({
      session_id: 'diag',
      kind: 'tool_use',
      content: 'quota exceeded',
      compressed: false,
      intensity: null,
      ts: since + 3,
    });
    storage.insertObservation({
      session_id: 'diag',
      kind: 'tool_use',
      content: 'permission denied',
      compressed: false,
      intensity: null,
      ts: since + 4,
    });

    const rows = storage.recentToolErrors('diag', since, 10);

    expect(rows.map((r) => r.content)).toEqual([
      'permission denied',
      'quota exceeded',
      'git add rejected by guard',
    ]);
  });
});
