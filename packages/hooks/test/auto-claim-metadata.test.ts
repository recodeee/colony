import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { MemoryStore, TaskThread } from '@colony/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { autoClaimFileBeforeEdit } from '../src/auto-claim.js';
import { claimBeforeEditFromToolUse } from '../src/handlers/pre-tool-use.js';

let dir: string;
let store: MemoryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'colony-auto-claim-metadata-'));
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('auto-claim active task metadata fallback', () => {
  it('resolves a Codex OMX session from stored active-session metadata', () => {
    const repoRoot = join(dir, 'repo');
    const worktreePath = join(dir, 'worktrees', 'codex-omx');
    const branch = 'agent/codex/omx';
    store.startSession({ id: 'owner', ide: 'claude-code', cwd: repoRoot });
    store.startSession({
      id: 'codex@019dd6c0',
      ide: 'codex',
      cwd: null,
      metadata: {
        source: 'omx-active-session',
        repo_root: repoRoot,
        branch,
        worktree_path: worktreePath,
        agent: 'codex',
      },
    });
    const thread = TaskThread.open(store, {
      repo_root: repoRoot,
      branch,
      session_id: 'owner',
    });
    thread.join('owner', 'claude');

    const result = autoClaimFileBeforeEdit(store, {
      session_id: 'codex@019dd6c0',
      file_path: 'src/viewer.tsx',
    });

    expect(result).toMatchObject({
      ok: true,
      status: 'claimed',
      resolution: 'bound',
      matched_by: 'branch_repo_root',
      task_id: thread.task_id,
    });
    expect(store.storage.getClaim(thread.task_id, 'src/viewer.tsx')?.session_id).toBe(
      'codex@019dd6c0',
    );
    expect(store.storage.getParticipantAgent(thread.task_id, 'codex@019dd6c0')).toBe('codex');
  });

  it('resolves PreToolUse active-task scope from OMX metadata when cwd cannot detect git', () => {
    const repoRoot = join(dir, 'repo');
    const worktreePath = join(dir, 'worktrees', 'codex-bridge');
    const branch = 'agent/codex/bridge';
    store.startSession({ id: 'owner', ide: 'claude-code', cwd: repoRoot });
    store.startSession({ id: 'codex@019dd85d', ide: 'codex', cwd: null });
    const thread = TaskThread.open(store, {
      repo_root: repoRoot,
      branch,
      session_id: 'owner',
    });
    thread.join('owner', 'claude');

    const result = claimBeforeEditFromToolUse(store, {
      session_id: 'codex@019dd85d',
      ide: 'codex',
      metadata: {
        repoRoot,
        branch,
        worktreePath,
        agentName: 'codex',
      },
      tool_name: 'Edit',
      tool_input: { file_path: 'src/bridge.ts' },
    });

    expect(result).toMatchObject({
      edits_missing_claim: [],
      warnings: [],
      auto_claimed_before_edit: ['src/bridge.ts'],
    });
    expect(store.storage.getClaim(thread.task_id, 'src/bridge.ts')?.session_id).toBe(
      'codex@019dd85d',
    );
  });

  it('resolves by worktree path when metadata has no branch', () => {
    const worktreePath = join(dir, 'worktrees', 'codex-path-only');
    store.startSession({ id: 'owner', ide: 'claude-code', cwd: worktreePath });
    store.startSession({
      id: 'codex@path-only',
      ide: 'codex',
      cwd: null,
      metadata: {
        worktreePath,
        agentName: 'codex',
      },
    });
    const thread = TaskThread.open(store, {
      repo_root: worktreePath,
      branch: 'agent/codex/path-only',
      session_id: 'owner',
    });
    thread.join('owner', 'claude');

    const result = autoClaimFileBeforeEdit(store, {
      session_id: 'codex@path-only',
      file_path: 'src/path.ts',
    });

    expect(result).toMatchObject({
      ok: true,
      status: 'claimed',
      resolution: 'bound',
      matched_by: 'worktree',
      task_id: thread.task_id,
    });
    expect(store.storage.getClaim(thread.task_id, 'src/path.ts')?.session_id).toBe(
      'codex@path-only',
    );
  });

  it('does not guess by worktree path when multiple active tasks match', () => {
    const worktreePath = join(dir, 'worktrees', 'codex-ambiguous');
    store.startSession({
      id: 'codex@ambiguous',
      ide: 'codex',
      cwd: null,
      metadata: {
        worktree_path: worktreePath,
        agent: 'codex',
      },
    });
    for (const branch of ['agent/codex/one', 'agent/codex/two']) {
      const owner = `${branch}-owner`;
      store.startSession({ id: owner, ide: 'claude-code', cwd: worktreePath });
      const thread = TaskThread.open(store, {
        repo_root: worktreePath,
        branch,
        session_id: owner,
      });
      thread.join(owner, 'claude');
    }

    const result = autoClaimFileBeforeEdit(store, {
      session_id: 'codex@ambiguous',
      file_path: 'src/x.ts',
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'AMBIGUOUS_ACTIVE_TASK',
      resolution: 'ambiguous',
    });
    if (result.ok) throw new Error('expected ambiguous active task');
    expect(result.candidates).toHaveLength(2);
    expect(
      store.storage.listTasks(10).flatMap((task) => store.storage.listClaims(task.id)),
    ).toEqual([]);
  });
});
