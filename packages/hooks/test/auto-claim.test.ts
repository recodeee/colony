import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { MemoryStore, TaskThread } from '@colony/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { autoClaimFromToolUse, extractTouchedFiles } from '../src/handlers/post-tool-use.js';
import { buildConflictPreface } from '../src/handlers/user-prompt-submit.js';
import { runHook } from '../src/runner.js';

let dir: string;
let store: MemoryStore;
let previousCavememNoAutostart: string | undefined;

/** Set up two sessions (A, B) joined to the same task. Bypasses the hook
 *  layer because these tests target auto-claim behaviour, not hook wiring. */
function seedTwoSessionTask(): number {
  store.startSession({ id: 'A', ide: 'claude-code', cwd: '/repo' });
  store.startSession({ id: 'B', ide: 'codex', cwd: '/repo' });
  const thread = TaskThread.open(store, {
    repo_root: '/repo',
    branch: 'feat/auto-claim',
    session_id: 'A',
  });
  thread.join('A', 'claude');
  thread.join('B', 'codex');
  return thread.task_id;
}

function metadataOf(row: { metadata: string | null } | undefined): Record<string, unknown> {
  return row?.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : {};
}

beforeEach(() => {
  previousCavememNoAutostart = process.env.CAVEMEM_NO_AUTOSTART;
  process.env.CAVEMEM_NO_AUTOSTART = '1';
  dir = mkdtempSync(join(tmpdir(), 'colony-auto-claim-'));
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
  if (previousCavememNoAutostart === undefined) {
    delete process.env.CAVEMEM_NO_AUTOSTART;
  } else {
    process.env.CAVEMEM_NO_AUTOSTART = previousCavememNoAutostart;
  }
});

describe('extractTouchedFiles', () => {
  it('returns the file_path for write-family tools', () => {
    expect(extractTouchedFiles('Edit', { file_path: 'src/x.ts' })).toEqual(['src/x.ts']);
    expect(extractTouchedFiles('Write', { file_path: 'src/y.ts' })).toEqual(['src/y.ts']);
    expect(extractTouchedFiles('MultiEdit', { file_path: 'src/z.ts' })).toEqual(['src/z.ts']);
    expect(extractTouchedFiles('NotebookEdit', { file_path: 'nb.ipynb' })).toEqual(['nb.ipynb']);
  });

  it('ignores non-write tools and malformed input', () => {
    expect(extractTouchedFiles('Read', { file_path: 'src/x.ts' })).toEqual([]);
    expect(extractTouchedFiles('Bash', { command: 'rm foo' })).toEqual([]);
    expect(extractTouchedFiles('Edit', null)).toEqual([]);
    expect(extractTouchedFiles('Edit', {})).toEqual([]);
    expect(extractTouchedFiles('Edit', { file_path: '' })).toEqual([]);
  });
});

describe('autoClaimFromToolUse', () => {
  it('claims the file for the editing session when it is joined to a task', () => {
    const task_id = seedTwoSessionTask();
    const result = autoClaimFromToolUse(store, {
      session_id: 'A',
      tool_name: 'Edit',
      tool_input: { file_path: 'src/viewer.tsx' },
    });
    expect(result.claimed).toEqual(['src/viewer.tsx']);
    expect(result.conflicts).toEqual([]);
    expect(store.storage.getClaim(task_id, 'src/viewer.tsx')?.session_id).toBe('A');
    const observations = store.storage.taskObservationsByKind(task_id, 'auto-claim');
    expect(observations).toHaveLength(1);
    expect(metadataOf(observations[0])).toMatchObject({
      source: 'post-tool-use',
      file_path: 'src/viewer.tsx',
      tool: 'Edit',
    });
  });

  it('does not emit another auto-claim when the same session edits an already-claimed file', () => {
    const task_id = seedTwoSessionTask();
    const first = autoClaimFromToolUse(store, {
      session_id: 'A',
      tool_name: 'Edit',
      tool_input: { file_path: 'src/viewer.tsx' },
    });
    const second = autoClaimFromToolUse(store, {
      session_id: 'A',
      tool_name: 'Edit',
      tool_input: { file_path: 'src/viewer.tsx' },
    });

    expect(first.claimed).toEqual(['src/viewer.tsx']);
    expect(second).toEqual({ claimed: [], conflicts: [] });
    expect(store.storage.taskObservationsByKind(task_id, 'auto-claim')).toHaveLength(1);
  });

  it('reports a conflict when another session already holds a fresh claim', () => {
    const task_id = seedTwoSessionTask();
    // A claims first.
    autoClaimFromToolUse(store, {
      session_id: 'A',
      tool_name: 'Edit',
      tool_input: { file_path: 'src/viewer.tsx' },
    });
    // B edits the same file — expect the conflict to be reported AND
    // ownership to transfer, because the edit already happened.
    const result = autoClaimFromToolUse(store, {
      session_id: 'B',
      tool_name: 'Edit',
      tool_input: { file_path: 'src/viewer.tsx' },
    });
    expect(result.claimed).toEqual(['src/viewer.tsx']);
    expect(result.conflicts).toEqual([{ file_path: 'src/viewer.tsx', other_session: 'A' }]);
    expect(store.storage.getClaim(task_id, 'src/viewer.tsx')?.session_id).toBe('B');
    const conflicts = store.storage.taskObservationsByKind(task_id, 'claim-conflict');
    expect(conflicts).toHaveLength(1);
    expect(metadataOf(conflicts[0])).toMatchObject({
      source: 'post-tool-use',
      file_path: 'src/viewer.tsx',
      tool: 'Edit',
      other_session: 'A',
    });
  });

  it('materializes a synthetic task for sessions not joined to any task', () => {
    store.startSession({ id: 'solo', ide: 'claude-code', cwd: '/repo' });
    const result = autoClaimFromToolUse(store, {
      session_id: 'solo',
      tool_name: 'Edit',
      tool_input: { file_path: 'src/x.ts' },
      ide: 'claude-code',
      cwd: '/repo',
    });
    const task_id = store.storage.findActiveTaskForSession('solo');
    expect(task_id).toBeDefined();
    expect(store.storage.getTask(task_id ?? -1)?.branch).toBe('agent/claude-code/solo');
    expect(result).toEqual({ claimed: ['src/x.ts'], conflicts: [] });
    expect(store.storage.getClaim(task_id ?? -1, 'src/x.ts')?.session_id).toBe('solo');
  });
});

describe('buildConflictPreface', () => {
  it("surfaces other sessions' recent claims, grouped by session", () => {
    seedTwoSessionTask();
    // A edits two files.
    autoClaimFromToolUse(store, {
      session_id: 'A',
      tool_name: 'Edit',
      tool_input: { file_path: 'src/viewer.tsx' },
    });
    autoClaimFromToolUse(store, {
      session_id: 'A',
      tool_name: 'Write',
      tool_input: { file_path: 'src/api.ts' },
    });

    const preface = buildConflictPreface(store, 'B');
    expect(preface).toContain('actively edited');
    // Grouped: one line per session. Ordering within the line is newest-first
    // (claimed_at DESC), but the test just asserts both paths are present.
    expect(preface).toMatch(/^ {2}A: .*src\/viewer\.tsx/m);
    expect(preface).toMatch(/^ {2}A: .*src\/api\.ts/m);
    // Own claims do not appear in your own preface.
    const ownPreface = buildConflictPreface(store, 'A');
    expect(ownPreface).toBe('');
  });
});

describe('runHook integration: A edits -> B sees warning', () => {
  it('PostToolUse auto-claims, and the next UserPromptSubmit warns the other session', async () => {
    const task_id = seedTwoSessionTask();

    const edit = await runHook(
      'post-tool-use',
      {
        session_id: 'A',
        ide: 'claude-code',
        tool_name: 'Edit',
        tool_input: { file_path: 'src/viewer.tsx' },
        tool_response: { success: true },
      },
      { store },
    );
    expect(edit.ok).toBe(true);
    // The claim is the ground truth the next turn depends on.
    expect(store.storage.getClaim(task_id, 'src/viewer.tsx')?.session_id).toBe('A');
    const autoClaims = store.storage.taskObservationsByKind(task_id, 'auto-claim');
    expect(autoClaims).toHaveLength(1);
    expect(metadataOf(autoClaims[0])).toMatchObject({
      source: 'post-tool-use',
      file_path: 'src/viewer.tsx',
      tool: 'Edit',
    });

    const nextTurn = await runHook(
      'user-prompt-submit',
      { session_id: 'B', ide: 'codex', prompt: 'continue' },
      { store },
    );
    expect(nextTurn.ok).toBe(true);
    expect(nextTurn.context).toContain('src/viewer.tsx');
    expect(nextTurn.context).toContain('A'); // the other session's id
  });

  it('does not duplicate auto-claim observations on repeated Edit hooks', async () => {
    const task_id = seedTwoSessionTask();

    for (let i = 0; i < 2; i++) {
      const edit = await runHook(
        'post-tool-use',
        {
          session_id: 'A',
          ide: 'claude-code',
          tool_name: 'Edit',
          tool_input: { file_path: 'src/viewer.tsx' },
          tool_response: { success: true },
        },
        { store },
      );
      expect(edit.ok).toBe(true);
    }

    expect(store.storage.taskObservationsByKind(task_id, 'auto-claim')).toHaveLength(1);
  });

  it('records claim-conflict but allows Edit when a different session holds the file', async () => {
    const task_id = seedTwoSessionTask();
    store.storage.claimFile({ task_id, file_path: 'src/viewer.tsx', session_id: 'A' });

    const edit = await runHook(
      'post-tool-use',
      {
        session_id: 'B',
        ide: 'codex',
        tool_name: 'Edit',
        tool_input: { file_path: 'src/viewer.tsx' },
        tool_response: { success: true },
      },
      { store },
    );

    expect(edit.ok).toBe(true);
    expect(store.storage.getClaim(task_id, 'src/viewer.tsx')?.session_id).toBe('B');
    const conflicts = store.storage.taskObservationsByKind(task_id, 'claim-conflict');
    expect(conflicts).toHaveLength(1);
    expect(metadataOf(conflicts[0])).toMatchObject({
      source: 'post-tool-use',
      file_path: 'src/viewer.tsx',
      tool: 'Edit',
      other_session: 'A',
    });
  });

  it('Bash redirects use the same auto-claim path as Write', async () => {
    const task_id = seedTwoSessionTask();

    const bash = await runHook(
      'post-tool-use',
      {
        session_id: 'A',
        ide: 'codex',
        cwd: '/repo',
        tool_name: 'Bash',
        tool_input: { command: 'printf "exported" > src/generated.ts' },
        tool_response: { success: true },
      },
      { store },
    );
    expect(bash.ok).toBe(true);
    expect(store.storage.getClaim(task_id, 'src/generated.ts')?.session_id).toBe('A');
    const autoClaims = store.storage.taskObservationsByKind(task_id, 'auto-claim');
    expect(autoClaims).toHaveLength(1);
    expect(metadataOf(autoClaims[0])).toMatchObject({
      source: 'post-tool-use',
      file_path: 'src/generated.ts',
      tool: 'Write',
    });

    const nextTurn = await runHook(
      'user-prompt-submit',
      { session_id: 'B', ide: 'codex', prompt: 'continue' },
      { store },
    );
    expect(nextTurn.ok).toBe(true);
    expect(nextTurn.context).toContain('src/generated.ts');
  });
});
