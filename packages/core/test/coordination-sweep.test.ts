import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCoordinationSweep } from '../src/coordination-sweep.js';
import { MemoryStore } from '../src/memory-store.js';
import { TaskThread } from '../src/task-thread.js';
import type { WorktreeContentionReport } from '../src/worktree-contention.js';

const NOW = Date.UTC(2026, 3, 28, 12, 0, 0);
const MINUTE_MS = 60_000;

let dir: string;
let store: MemoryStore;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  dir = mkdtempSync(join(tmpdir(), 'colony-coordination-sweep-'));
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('buildCoordinationSweep stale claim cleanup', () => {
  it('skips stale claims when the owning managed worktree has the file dirty', () => {
    const filePath = 'src/dirty.ts';
    seedStaleClaim('agent/dirty', filePath, 'codex@dirty');

    const result = buildCoordinationSweep(store, {
      repo_root: '/repo',
      now: NOW,
      release_safe_stale_claims: true,
      worktree_contention: dirtyWorktreeReport('agent/dirty', filePath),
      hivemind: emptyHivemind(),
    });

    expect(result.summary).toMatchObject({
      released_stale_claim_count: 0,
      downgraded_stale_claim_count: 0,
      skipped_dirty_claim_count: 1,
      stale_claim_count: 1,
    });
    expect(result.skipped_dirty_claims).toEqual([
      expect.objectContaining({
        branch: 'agent/dirty',
        file_path: filePath,
        reason: 'dirty_worktree',
      }),
    ]);
    expect(result.recommended_actions).toEqual(
      expect.arrayContaining([expect.stringContaining('dirty stale claim')]),
    );
    const taskId = taskIdByBranch('agent/dirty');
    expect(store.storage.getClaim(taskId, filePath)?.session_id).toBe('codex@dirty');
    expect(store.storage.taskObservationsByKind(taskId, 'coordination-sweep')).toHaveLength(0);
  });
});

function seedStaleClaim(branch: string, filePath: string, sessionId: string): void {
  vi.setSystemTime(NOW - 300 * MINUTE_MS);
  store.startSession({ id: sessionId, ide: 'codex', cwd: '/repo' });
  const thread = TaskThread.open(store, {
    repo_root: '/repo',
    branch,
    title: branch,
    session_id: sessionId,
  });
  thread.join(sessionId, 'codex');
  thread.claimFile({ session_id: sessionId, file_path: filePath });
  vi.setSystemTime(NOW);
}

function taskIdByBranch(branch: string): number {
  const task = store.storage.listTasks(100).find((candidate) => candidate.branch === branch);
  if (!task) throw new Error(`missing task ${branch}`);
  return task.id;
}

function dirtyWorktreeReport(branch: string, filePath: string): WorktreeContentionReport {
  return {
    generated_at: new Date(NOW).toISOString(),
    repo_root: '/repo',
    inspected_roots: [],
    worktrees: [
      {
        branch,
        path: '/repo/.omx/agent-worktrees/dirty',
        managed_root: '.omx/agent-worktrees',
        dirty_files: [{ path: filePath, status: ' M' }],
        claimed_files: [filePath],
        active_session: null,
      },
    ],
    contentions: [],
    summary: {
      worktree_count: 1,
      dirty_worktree_count: 1,
      dirty_file_count: 1,
      contention_count: 0,
    },
  };
}

function emptyHivemind() {
  return {
    generated_at: new Date(NOW).toISOString(),
    repo_roots: ['/repo'],
    session_count: 0,
    counts: {},
    sessions: [],
  };
}
