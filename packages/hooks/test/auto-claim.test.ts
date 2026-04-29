import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { MemoryStore, TaskThread } from '@colony/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { autoClaimFileBeforeEdit, autoClaimFileForSession } from '../src/auto-claim.js';
import { autoClaimFromToolUse, extractTouchedFiles } from '../src/handlers/post-tool-use.js';
import { claimBeforeEditFromToolUse, preToolUse } from '../src/handlers/pre-tool-use.js';
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

function metadataOf(
  row: { metadata: string | Record<string, unknown> | null } | undefined,
): Record<string, unknown> {
  if (!row?.metadata) return {};
  return typeof row.metadata === 'string'
    ? (JSON.parse(row.metadata) as Record<string, unknown>)
    : row.metadata;
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

describe('autoClaimFileForSession', () => {
  it('creates a task_claim_file-style observation when one active task matches', () => {
    const task_id = seedTwoSessionTask();

    const result = autoClaimFileForSession({
      store,
      session_id: 'A',
      repo_root: '/repo',
      branch: 'feat/auto-claim',
      file_path: 'src/viewer.tsx',
    });

    expect(result).toMatchObject({ ok: true, status: 'claimed', task_id });
    expect(store.storage.getClaim(task_id, 'src/viewer.tsx')?.session_id).toBe('A');
    const claims = store.storage.taskObservationsByKind(task_id, 'claim');
    expect(claims).toHaveLength(1);
    expect(metadataOf(claims[0])).toMatchObject({
      kind: 'claim',
      source: 'autoClaimFileForSession',
      file_path: 'src/viewer.tsx',
      resolved_by: 'autoClaimFileForSession',
    });
  });

  it('returns AMBIGUOUS_ACTIVE_TASK when multiple active tasks match', () => {
    store.startSession({ id: 'A', ide: 'codex', cwd: '/repo' });
    for (const branch of ['feat/one', 'feat/two']) {
      const thread = TaskThread.open(store, {
        repo_root: '/repo',
        branch,
        session_id: 'A',
      });
      thread.join('A', 'codex');
    }

    const result = autoClaimFileForSession(store, {
      session_id: 'A',
      repo_root: '/repo',
      file_path: 'src/viewer.tsx',
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'AMBIGUOUS_ACTIVE_TASK',
    });
    if (result.ok) throw new Error('expected ambiguous active task');
    expect(result.candidates).toHaveLength(2);
  });

  it('returns ACTIVE_TASK_NOT_FOUND when no active task matches', () => {
    store.startSession({ id: 'A', ide: 'codex', cwd: '/repo' });

    const result = autoClaimFileForSession(store, {
      session_id: 'A',
      repo_root: '/repo',
      branch: 'feat/missing',
      file_path: 'src/viewer.tsx',
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'ACTIVE_TASK_NOT_FOUND',
      candidates: [],
    });
    expect(store.storage.findActiveTaskForSession('A')).toBeUndefined();
  });

  it('returns SESSION_NOT_FOUND when the session row is missing', () => {
    const result = autoClaimFileForSession(store, {
      session_id: 'missing',
      repo_root: '/repo',
      branch: 'feat/missing',
      file_path: 'src/viewer.tsx',
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'SESSION_NOT_FOUND',
      candidates: [],
    });
  });
});

describe('autoClaimFileBeforeEdit', () => {
  it('creates a task_claim_file-style observation when one active task matches', () => {
    const task_id = seedTwoSessionTask();

    const result = autoClaimFileBeforeEdit({
      store,
      session_id: 'A',
      repo_root: '/repo',
      branch: 'feat/auto-claim',
      file_path: 'src/viewer.tsx',
    });

    expect(result).toMatchObject({ ok: true, status: 'claimed', task_id });
    expect(store.storage.getClaim(task_id, 'src/viewer.tsx')?.session_id).toBe('A');
    const claims = store.storage.taskObservationsByKind(task_id, 'claim');
    expect(claims).toHaveLength(1);
    expect(metadataOf(claims[0])).toMatchObject({
      kind: 'claim',
      source: 'autoClaimFileBeforeEdit',
      file_path: 'src/viewer.tsx',
      resolved_by: 'autoClaimFileBeforeEdit',
      auto_claimed_before_edit: true,
    });
  });

  it('returns AMBIGUOUS_ACTIVE_TASK when multiple active tasks match', () => {
    store.startSession({ id: 'A', ide: 'codex', cwd: '/repo' });
    for (const branch of ['feat/one', 'feat/two']) {
      const thread = TaskThread.open(store, {
        repo_root: '/repo',
        branch,
        session_id: 'A',
      });
      thread.join('A', 'codex');
    }

    const result = autoClaimFileBeforeEdit(store, {
      session_id: 'A',
      repo_root: '/repo',
      file_path: 'src/viewer.tsx',
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'AMBIGUOUS_ACTIVE_TASK',
    });
    if (result.ok) throw new Error('expected ambiguous active task');
    expect(result.candidates).toHaveLength(2);
  });

  it('returns ACTIVE_TASK_NOT_FOUND and does not invent a task when no active task matches', () => {
    store.startSession({ id: 'A', ide: 'codex', cwd: '/repo' });

    const result = autoClaimFileBeforeEdit(store, {
      session_id: 'A',
      repo_root: '/repo',
      branch: 'feat/missing',
      file_path: 'src/viewer.tsx',
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'ACTIVE_TASK_NOT_FOUND',
      candidates: [],
    });
    expect(store.storage.findActiveTaskForSession('A')).toBeUndefined();
  });

  it('returns SESSION_NOT_FOUND when the session row is missing', () => {
    const result = autoClaimFileBeforeEdit(store, {
      session_id: 'missing',
      repo_root: '/repo',
      branch: 'feat/missing',
      file_path: 'src/viewer.tsx',
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'SESSION_NOT_FOUND',
      candidates: [],
    });
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

describe('claimBeforeEditFromToolUse', () => {
  it('creates a claim observation before the edit hook records the write', () => {
    const task_id = seedTwoSessionTask();
    const result = claimBeforeEditFromToolUse(store, {
      session_id: 'A',
      tool_name: 'Edit',
      tool_input: { file_path: 'src/viewer.tsx' },
    });

    expect(result).toMatchObject({
      edits_with_claim: [],
      edits_missing_claim: [],
      auto_claimed_before_edit: ['src/viewer.tsx'],
      warnings: [],
    });
    expect(store.storage.getClaim(task_id, 'src/viewer.tsx')?.session_id).toBe('A');
    const claims = store.storage.taskObservationsByKind(task_id, 'claim');
    expect(claims).toHaveLength(1);
    expect(metadataOf(claims[0])).toMatchObject({
      source: 'pre-tool-use',
      file_path: 'src/viewer.tsx',
      tool: 'Edit',
      auto_claimed_before_edit: true,
      resolved_by: 'autoClaimFileBeforeEdit',
    });
    expect(store.storage.taskObservationsByKind(task_id, 'claim-before-edit')).toHaveLength(1);
  });

  it('records already-claimed edits without duplicating the claim', () => {
    const task_id = seedTwoSessionTask();
    const thread = new TaskThread(store, task_id);
    thread.claimFile({ session_id: 'A', file_path: 'src/viewer.tsx' });

    const result = claimBeforeEditFromToolUse(store, {
      session_id: 'A',
      tool_name: 'Edit',
      tool_input: { file_path: 'src/viewer.tsx' },
    });

    expect(result.edits_with_claim).toEqual(['src/viewer.tsx']);
    expect(result.auto_claimed_before_edit).toEqual([]);
    expect(store.storage.taskObservationsByKind(task_id, 'claim')).toHaveLength(1);
    const telemetry = store.storage.taskObservationsByKind(task_id, 'claim-before-edit');
    expect(telemetry).toHaveLength(1);
    expect(metadataOf(telemetry[0])).toMatchObject({
      outcome: 'edits_with_claim',
      file_path: 'src/viewer.tsx',
    });
  });

  it('records advisory conflict telemetry and still pre-claims for the editing session', () => {
    const task_id = seedTwoSessionTask();
    const thread = new TaskThread(store, task_id);
    thread.claimFile({ session_id: 'A', file_path: 'src/viewer.tsx' });

    const result = claimBeforeEditFromToolUse(store, {
      session_id: 'B',
      tool_name: 'Edit',
      tool_input: { file_path: 'src/viewer.tsx' },
    });

    expect(result.auto_claimed_before_edit).toEqual(['src/viewer.tsx']);
    expect(store.storage.getClaim(task_id, 'src/viewer.tsx')?.session_id).toBe('B');
    const conflicts = store.storage.taskObservationsByKind(task_id, 'claim-conflict');
    expect(conflicts).toHaveLength(1);
    expect(metadataOf(conflicts[0])).toMatchObject({
      source: 'pre-tool-use',
      file_path: 'src/viewer.tsx',
      other_session: 'A',
    });
  });

  it('emits ACTIVE_TASK_NOT_FOUND and does not invent a task for unbound sessions', () => {
    store.startSession({ id: 'solo', ide: 'codex', cwd: '/repo' });

    const result = claimBeforeEditFromToolUse(store, {
      session_id: 'solo',
      tool_name: 'Edit',
      tool_input: { file_path: 'src/x.ts' },
    });

    expect(result.auto_claimed_before_edit).toEqual([]);
    expect(result.edits_missing_claim).toEqual(['src/x.ts']);
    expect(result.warnings).toEqual([
      {
        code: 'ACTIVE_TASK_NOT_FOUND',
        message:
          'Missing Colony claim before edit. Call task_claim_file for src/x.ts before editing.',
        next_tool: 'task_claim_file',
        suggested_args: {
          task_id: '<task_id>',
          session_id: 'solo',
          file_path: 'src/x.ts',
          note: 'pre-edit claim',
        },
      },
    ]);
    expect(store.storage.findActiveTaskForSession('solo')).toBeUndefined();
    const telemetry = store.timeline('solo').filter((row) => row.kind === 'claim-before-edit');
    expect(telemetry).toHaveLength(1);
    expect(metadataOf(telemetry[0])).toMatchObject({
      code: 'ACTIVE_TASK_NOT_FOUND',
      outcome: 'edits_missing_claim',
      file_path: 'src/x.ts',
    });
  });

  it('emits AMBIGUOUS_ACTIVE_TASK and leaves claims unchanged when context is ambiguous', () => {
    store.startSession({ id: 'A', ide: 'codex', cwd: '/repo' });
    for (const branch of ['feat/one', 'feat/two']) {
      const thread = TaskThread.open(store, {
        repo_root: '/repo',
        branch,
        session_id: 'A',
      });
      thread.join('A', 'codex');
    }

    const result = claimBeforeEditFromToolUse(store, {
      session_id: 'A',
      tool_name: 'Edit',
      tool_input: { file_path: 'src/x.ts' },
    });

    expect(result.auto_claimed_before_edit).toEqual([]);
    expect(result.edits_missing_claim).toEqual(['src/x.ts']);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({
      code: 'AMBIGUOUS_ACTIVE_TASK',
      message:
        'Missing Colony claim before edit. Call task_claim_file for src/x.ts before editing.',
      next_tool: 'task_claim_file',
      suggested_args: {
        task_id: '<candidate.task_id>',
        session_id: 'A',
        file_path: 'src/x.ts',
        note: 'pre-edit claim',
      },
    });
    expect(result.warnings[0]?.candidates).toHaveLength(2);
    expect(result.warnings[0]?.candidates).toEqual(
      expect.arrayContaining([
        {
          task_id: expect.any(Number),
          repo_root: '/repo',
          branch: 'feat/one',
          status: 'open',
          updated_at: expect.any(Number),
        },
        {
          task_id: expect.any(Number),
          repo_root: '/repo',
          branch: 'feat/two',
          status: 'open',
          updated_at: expect.any(Number),
        },
      ]),
    );
    expect(result.warnings[0]?.candidates?.[0]).toEqual(
      expect.objectContaining({
        task_id: expect.any(Number),
        repo_root: '/repo',
        branch: expect.stringMatching(/^feat\/(one|two)$/),
        status: 'open',
        updated_at: expect.any(Number),
      }),
    );
    expect(
      store.storage.listTasks(10).flatMap((task) => store.storage.listClaims(task.id)),
    ).toEqual([]);
  });

  it('emits SESSION_NOT_FOUND when a pre-edit hook has no session row', () => {
    const result = claimBeforeEditFromToolUse(store, {
      session_id: 'missing',
      tool_name: 'Edit',
      tool_input: { file_path: 'src/x.ts' },
    });

    expect(result.auto_claimed_before_edit).toEqual([]);
    expect(result.edits_missing_claim).toEqual(['src/x.ts']);
    expect(result.warnings).toEqual([
      {
        code: 'SESSION_NOT_FOUND',
        message:
          'Missing Colony claim before edit. Call task_claim_file for src/x.ts before editing.',
        next_tool: 'task_claim_file',
        suggested_args: {
          task_id: '<task_id>',
          session_id: 'missing',
          file_path: 'src/x.ts',
          note: 'pre-edit claim',
        },
      },
    ]);
  });

  it('debounces repeated warning output for the same session, file, and code', () => {
    store.startSession({ id: 'debounce-session', ide: 'codex', cwd: '/repo' });

    const first = claimBeforeEditFromToolUse(store, {
      session_id: 'debounce-session',
      tool_name: 'Edit',
      tool_input: { file_path: 'src/x.ts' },
    });
    const second = claimBeforeEditFromToolUse(store, {
      session_id: 'debounce-session',
      tool_name: 'Edit',
      tool_input: { file_path: 'src/x.ts' },
    });

    expect(first.warnings).toHaveLength(1);
    expect(second.edits_missing_claim).toEqual(['src/x.ts']);
    expect(second.warnings).toEqual([]);
    expect(
      store.timeline('debounce-session').filter((row) => row.kind === 'claim-before-edit'),
    ).toHaveLength(2);
  });

  it('formats pre-tool-use warnings as compact JSON lines', () => {
    store.startSession({ id: 'json-session', ide: 'codex', cwd: '/repo' });

    const context = preToolUse(store, {
      session_id: 'json-session',
      tool_name: 'Edit',
      tool_input: { file_path: 'src/x.ts' },
    });

    expect(JSON.parse(context)).toMatchObject({
      code: 'ACTIVE_TASK_NOT_FOUND',
      message:
        'Missing Colony claim before edit. Call task_claim_file for src/x.ts before editing.',
      next_tool: 'task_claim_file',
      suggested_args: {
        task_id: '<task_id>',
        session_id: 'json-session',
        file_path: 'src/x.ts',
        note: 'pre-edit claim',
      },
    });
  });

  it('emits COLONY_UNAVAILABLE as an advisory warning when pre-tool-use storage fails', () => {
    const brokenStore = {
      storage: {
        getSession() {
          throw new Error('db unavailable');
        },
      },
    } as unknown as MemoryStore;

    const context = preToolUse(brokenStore, {
      session_id: 'A',
      tool_name: 'Edit',
      tool_input: { file_path: 'src/x.ts' },
    });

    expect(JSON.parse(context)).toEqual({
      code: 'COLONY_UNAVAILABLE',
      message:
        'Missing Colony claim before edit. Call task_claim_file for src/x.ts before editing.',
      next_tool: 'task_claim_file',
      suggested_args: {
        task_id: '<task_id>',
        session_id: 'A',
        file_path: 'src/x.ts',
        note: 'pre-edit claim',
      },
    });
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
  it('PreToolUse claims first so health can count the later edit as covered', async () => {
    const task_id = seedTwoSessionTask();

    const before = await runHook(
      'pre-tool-use',
      {
        session_id: 'A',
        ide: 'claude-code',
        tool_name: 'Edit',
        tool_input: { file_path: 'src/viewer.tsx' },
      },
      { store },
    );
    expect(before.ok).toBe(true);

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
    expect(store.storage.getClaim(task_id, 'src/viewer.tsx')?.session_id).toBe('A');
    expect(store.storage.taskObservationsByKind(task_id, 'auto-claim')).toHaveLength(0);
    expect(store.storage.claimBeforeEditStats(0)).toMatchObject({
      edit_tool_calls: 1,
      edits_with_file_path: 1,
      edits_claimed_before: 1,
      auto_claimed_before_edit: 1,
    });
  });

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
        cwd: '/repo/packages/hooks',
        tool_name: 'Bash',
        tool_input: { command: 'printf "exported" > src/generated.ts' },
        tool_response: { success: true },
      },
      { store },
    );
    expect(bash.ok).toBe(true);
    expect(store.storage.getClaim(task_id, 'packages/hooks/src/generated.ts')?.session_id).toBe(
      'A',
    );
    const autoClaims = store.storage.taskObservationsByKind(task_id, 'auto-claim');
    expect(autoClaims).toHaveLength(1);
    expect(metadataOf(autoClaims[0])).toMatchObject({
      source: 'post-tool-use',
      file_path: 'packages/hooks/src/generated.ts',
      tool: 'Write',
    });

    const nextTurn = await runHook(
      'user-prompt-submit',
      { session_id: 'B', ide: 'codex', prompt: 'continue' },
      { store },
    );
    expect(nextTurn.ok).toBe(true);
    expect(nextTurn.context).toContain('packages/hooks/src/generated.ts');
  });
});
