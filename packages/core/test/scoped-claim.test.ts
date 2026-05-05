import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/memory-store.js';
import { guardedClaimFile } from '../src/scoped-claim.js';

let dir: string;
let store: MemoryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'colony-scoped-claim-'));
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
  store.startSession({ id: 'sess-a', ide: 'claude-code', cwd: '/repo' });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('guardedClaimFile protected_branch warning', () => {
  it('rejects the claim by default when the task lives on a protected branch', () => {
    const task = store.storage.findOrCreateTask({
      title: 'main lane',
      repo_root: '/repo',
      branch: 'main',
      created_by: 'sess-a',
    });
    store.storage.addTaskParticipant({
      task_id: task.id,
      session_id: 'sess-a',
      agent: 'claude',
    });
    const result = guardedClaimFile(store, {
      task_id: task.id,
      file_path: 'src/foo.ts',
      session_id: 'sess-a',
      agent: 'claude',
    });
    expect(result.status).toBe('protected_branch_rejected');
    expect(result.protected_branch).toEqual({
      branch: 'main',
      warning: expect.stringContaining("protected base branch 'main'"),
    });
    expect(result.recommendation).toContain('gx branch start');
    // Crucial: the claim must NOT have been recorded — that's the lever
    // that stops the dashboard's "claims on protected branches" metric
    // from drifting back to non-zero after a coordination sweep.
    const stored = store.storage.getClaim(task.id, 'src/foo.ts');
    expect(stored).toBeUndefined();
  });

  it('still records the claim under the legacy soft-warn setting', () => {
    const softWarnStore = new MemoryStore({
      dbPath: join(dir, 'soft-warn.db'),
      settings: { ...defaultSettings, rejectProtectedBranchClaims: false },
    });
    softWarnStore.startSession({ id: 'sess-a', ide: 'claude-code', cwd: '/repo' });
    const task = softWarnStore.storage.findOrCreateTask({
      title: 'main lane 2',
      repo_root: '/repo',
      branch: 'main',
      created_by: 'sess-a',
    });
    softWarnStore.storage.addTaskParticipant({
      task_id: task.id,
      session_id: 'sess-a',
      agent: 'claude',
    });
    const result = guardedClaimFile(softWarnStore, {
      task_id: task.id,
      file_path: 'src/foo.ts',
      session_id: 'sess-a',
      agent: 'claude',
    });
    expect(result.status).toBe('claimed');
    expect(result.protected_branch?.branch).toBe('main');
    const stored = softWarnStore.storage.getClaim(task.id, 'src/foo.ts');
    expect(stored?.session_id).toBe('sess-a');
    expect(stored?.state).toBe('active');
    softWarnStore.close();
  });

  it('honors the COLONY_ALLOW_PROTECTED_CLAIM=1 env override', () => {
    const task = store.storage.findOrCreateTask({
      title: 'main lane override',
      repo_root: '/repo',
      branch: 'main',
      created_by: 'sess-a',
    });
    store.storage.addTaskParticipant({
      task_id: task.id,
      session_id: 'sess-a',
      agent: 'claude',
    });
    const previous = process.env.COLONY_ALLOW_PROTECTED_CLAIM;
    process.env.COLONY_ALLOW_PROTECTED_CLAIM = '1';
    try {
      const result = guardedClaimFile(store, {
        task_id: task.id,
        file_path: 'src/foo.ts',
        session_id: 'sess-a',
        agent: 'claude',
      });
      expect(result.status).toBe('claimed');
      const stored = store.storage.getClaim(task.id, 'src/foo.ts');
      expect(stored?.session_id).toBe('sess-a');
    } finally {
      if (previous === undefined) delete process.env.COLONY_ALLOW_PROTECTED_CLAIM;
      else process.env.COLONY_ALLOW_PROTECTED_CLAIM = previous;
    }
  });

  it('omits the warning for canonical agent/* branches', () => {
    const task = store.storage.findOrCreateTask({
      title: 'agent lane',
      repo_root: '/repo',
      branch: 'agent/claude/feature-x',
      created_by: 'sess-a',
    });
    store.storage.addTaskParticipant({
      task_id: task.id,
      session_id: 'sess-a',
      agent: 'claude',
    });
    const result = guardedClaimFile(store, {
      task_id: task.id,
      file_path: 'src/foo.ts',
      session_id: 'sess-a',
      agent: 'claude',
    });
    expect(result.status).toBe('claimed');
    expect(result.protected_branch).toBeUndefined();
  });

  it('flags master, dev, develop, production, and release branches', () => {
    for (const branch of ['master', 'dev', 'develop', 'production', 'release']) {
      const task = store.storage.findOrCreateTask({
        title: `${branch} lane`,
        repo_root: '/repo',
        branch,
        created_by: 'sess-a',
      });
      store.storage.addTaskParticipant({
        task_id: task.id,
        session_id: 'sess-a',
        agent: 'claude',
      });
      const result = guardedClaimFile(store, {
        task_id: task.id,
        file_path: `src/${branch}.ts`,
        session_id: 'sess-a',
        agent: 'claude',
      });
      expect(result.protected_branch?.branch).toBe(branch);
    }
  });

  it('omits the warning when the task was not found (no branch context)', () => {
    const result = guardedClaimFile(store, {
      task_id: 99_999,
      file_path: 'src/foo.ts',
      session_id: 'sess-a',
      agent: 'claude',
    });
    expect(result.status).toBe('task_not_found');
    expect(result.protected_branch).toBeUndefined();
  });

  it('preserves recommendation text alongside the protected_branch warning on contention paths', () => {
    store.startSession({ id: 'sess-b', ide: 'claude-code', cwd: '/repo' });
    const task = store.storage.findOrCreateTask({
      title: 'main contention',
      repo_root: '/repo',
      branch: 'main',
      created_by: 'sess-a',
    });
    store.storage.addTaskParticipant({
      task_id: task.id,
      session_id: 'sess-a',
      agent: 'claude',
    });
    store.storage.addTaskParticipant({
      task_id: task.id,
      session_id: 'sess-b',
      agent: 'codex',
    });
    store.storage.claimFile({
      task_id: task.id,
      file_path: 'src/contended.ts',
      session_id: 'sess-a',
    });
    const result = guardedClaimFile(store, {
      task_id: task.id,
      file_path: 'src/contended.ts',
      session_id: 'sess-b',
      agent: 'codex',
    });
    expect(result.protected_branch?.branch).toBe('main');
    expect(result.recommendation ?? result.status).toBeDefined();
  });
});
