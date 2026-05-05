import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { MemoryStore, TaskThread } from '@colony/core';
import type { ObservationRow } from '@colony/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runOmxLifecycleEnvelope } from '../src/lifecycle-envelope.js';

const BASE_TS = Date.parse('2026-04-29T10:00:00.000Z');
const BRANCH = 'agent/codex/full-claim-bridge';
const FILE_PATH = 'src/example.ts';

let dir: string;
let repoRoot: string;
let store: MemoryStore;

describe('claim-before-edit full bridge path', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TS);
    dir = mkdtempSync(join(tmpdir(), 'colony-claim-before-edit-full-path-'));
    repoRoot = fakeGitRepo('repo-full-path', BRANCH);
    store = new MemoryStore({ dbPath: join(dir, 'state', 'colony.db'), settings: defaultSettings });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it('records pre_tool_use before post_tool_use and reports the edit as claimed before health', async () => {
    const sessionId = 'codex@full-path';

    await emitLifecycle(10, {
      event_id: 'evt_session_start',
      event_name: 'session_start',
      session_id: sessionId,
    });
    await emitLifecycle(20, {
      event_id: 'evt_task_bind',
      event_name: 'task_bind',
      session_id: sessionId,
    });
    const taskId = store.storage.findActiveTaskForSession(sessionId);
    expect(taskId).toBeDefined();
    if (taskId === undefined) throw new Error('task was not bound');

    await emitLifecycle(100, editEnvelope('evt_edit_pre', 'pre_tool_use', sessionId));
    writeFileSync(join(repoRoot, FILE_PATH), 'export const example = 2;\n');
    await emitLifecycle(200, {
      ...editEnvelope('evt_edit_post', 'post_tool_use', sessionId),
      parent_event_id: 'evt_edit_pre',
      tool_response: { success: true },
    });

    const lifecycleEvents = taskLifecycleEvents(taskId);
    expect(lifecycleEvents.map((row) => row.event_type)).toEqual([
      'session_start',
      'task_bind',
      'pre_tool_use',
      'post_tool_use',
    ]);
    expect(lifecycleEvents[2]?.id).toBeLessThan(lifecycleEvents[3]?.id ?? 0);
    expect(lifecycleEvents[3]).toMatchObject({
      event_id: 'evt_edit_post',
      parent_event_id: 'evt_edit_pre',
    });

    const claim = store.storage.getClaim(taskId, FILE_PATH);
    expect(claim).toMatchObject({ session_id: sessionId, file_path: FILE_PATH });

    const claimObservation = firstTaskObservation(taskId, 'claim');
    expect(parseMetadata(claimObservation?.metadata)).toMatchObject({
      source: 'pre-tool-use',
      auto_claimed_before_edit: true,
      file_path: FILE_PATH,
      tool: 'Edit',
    });

    const editObservation = firstSessionObservation(sessionId, 'tool_use');
    expect(parseMetadata(editObservation?.metadata)).toMatchObject({
      tool: 'Edit',
      file_path: FILE_PATH,
      lifecycle_event_id: 'evt_edit_post',
      parent_event_id: 'evt_edit_pre',
      lifecycle_event_type: 'post_tool_use',
    });
    expect(claimObservation?.ts).toBeLessThanOrEqual(editObservation?.ts ?? 0);

    const stats = store.storage.claimBeforeEditStats(0);
    expect(stats).toMatchObject({
      edit_tool_calls: 1,
      edits_with_file_path: 1,
      edits_claimed_before: 1,
      auto_claimed_before_edit: 1,
      pre_tool_use_signals: 1,
      claim_miss_reasons: {
        pre_tool_use_missing: 0,
      },
    });
    expect(stats.edits_claimed_before / stats.edits_with_file_path).toBeGreaterThan(0);
  });

  it('keeps a manual task_claim_file claim matched when the lifecycle edit path is in a managed worktree', async () => {
    const sessionId = 'codex@managed-worktree-manual-claim';
    const worktreePath = join(
      repoRoot,
      '.omx',
      'agent-worktrees',
      'colony__codex__manual-claim',
    );
    mkdirSync(join(worktreePath, 'src'), { recursive: true });

    await emitLifecycle(10, {
      event_id: 'evt_manual_claim_session_start',
      event_name: 'session_start',
      session_id: sessionId,
      cwd: worktreePath,
      repo_root: repoRoot,
    });
    await emitLifecycle(20, {
      event_id: 'evt_manual_claim_task_bind',
      event_name: 'task_bind',
      session_id: sessionId,
      cwd: worktreePath,
      repo_root: repoRoot,
    });
    const taskId = store.storage.findActiveTaskForSession(sessionId);
    expect(taskId).toBeDefined();
    if (taskId === undefined) throw new Error('task was not bound');

    new TaskThread(store, taskId).claimFile({
      session_id: sessionId,
      file_path: FILE_PATH,
      note: 'manual task_claim_file',
    });
    expect(store.storage.getClaim(taskId, FILE_PATH)).toMatchObject({
      session_id: sessionId,
      file_path: FILE_PATH,
    });

    const absoluteWorktreeFile = join(worktreePath, FILE_PATH);
    const tool_input = {
      operation: 'replace',
      paths: [{ path: absoluteWorktreeFile, role: 'target', kind: 'file' }],
    };
    await emitLifecycle(100, {
      event_id: 'evt_manual_claim_edit_pre',
      event_name: 'pre_tool_use',
      session_id: sessionId,
      cwd: worktreePath,
      repo_root: worktreePath,
      tool_name: 'Edit',
      tool_input,
    });
    writeFileSync(absoluteWorktreeFile, 'export const example = 4;\n');
    await emitLifecycle(200, {
      event_id: 'evt_manual_claim_edit_post',
      parent_event_id: 'evt_manual_claim_edit_pre',
      event_name: 'post_tool_use',
      session_id: sessionId,
      cwd: worktreePath,
      repo_root: worktreePath,
      tool_name: 'Edit',
      tool_input,
      tool_response: { success: true },
    });

    const telemetry = store.storage.taskObservationsByKind(taskId, 'claim-before-edit');
    expect(telemetry).toHaveLength(1);
    expect(parseMetadata(telemetry[0]?.metadata)).toMatchObject({
      outcome: 'edits_with_claim',
      file_path: FILE_PATH,
      tool: 'Edit',
    });

    expect(store.storage.claimBeforeEditStats(0)).toMatchObject({
      edit_tool_calls: 1,
      edits_with_file_path: 1,
      edits_claimed_before: 1,
      claim_miss_reasons: {
        path_mismatch: 0,
        repo_root_mismatch: 0,
        worktree_path_mismatch: 0,
      },
    });
  });

  it('synthesizes pre_tool_use before post_tool_use telemetry when post arrives first', async () => {
    const sessionId = 'codex@missing-pre';

    await emitLifecycle(10, {
      event_id: 'evt_missing_pre_session_start',
      event_name: 'session_start',
      session_id: sessionId,
    });
    await emitLifecycle(20, {
      event_id: 'evt_missing_pre_task_bind',
      event_name: 'task_bind',
      session_id: sessionId,
    });
    writeFileSync(join(repoRoot, FILE_PATH), 'export const example = 3;\n');
    await emitLifecycle(100, {
      ...editEnvelope('evt_missing_pre_post', 'post_tool_use', sessionId),
      tool_response: { success: true },
    });

    const taskId = store.storage.findActiveTaskForSession(sessionId);
    expect(taskId).toBeDefined();
    if (taskId === undefined) throw new Error('task was not bound');

    const lifecycleEvents = taskLifecycleEvents(taskId);
    expect(lifecycleEvents.map((row) => row.event_type)).toEqual([
      'session_start',
      'task_bind',
      'pre_tool_use',
      'post_tool_use',
    ]);
    expect(lifecycleEvents[2]).toMatchObject({
      event_id: 'evt_missing_pre_post:pre_tool_use',
      event_type: 'pre_tool_use',
    });
    expect(lifecycleEvents[3]).toMatchObject({
      event_id: 'evt_missing_pre_post',
      parent_event_id: 'evt_missing_pre_post:pre_tool_use',
    });

    const editObservation = firstSessionObservation(sessionId, 'tool_use');
    expect(parseMetadata(editObservation?.metadata)).toMatchObject({
      tool: 'Edit',
      file_path: FILE_PATH,
      lifecycle_event_id: 'evt_missing_pre_post',
      parent_event_id: 'evt_missing_pre_post:pre_tool_use',
      lifecycle_event_type: 'post_tool_use',
    });

    const stats = store.storage.claimBeforeEditStats(0);
    expect(stats).toMatchObject({
      edit_tool_calls: 1,
      edits_with_file_path: 1,
      edits_claimed_before: 1,
      auto_claimed_before_edit: 1,
      pre_tool_use_signals: 1,
      claim_miss_reasons: {
        pre_tool_use_missing: 0,
      },
    });
    expect(stats.edits_claimed_before).toBeGreaterThan(0);
    expect(stats.pre_tool_use_signals ?? 0).toBeGreaterThan(0);
  });

  it('records extracted paths on Bash and apply_patch pre_tool_use lifecycle payloads', async () => {
    const sessionId = 'codex@bash-patch-pre';

    await emitLifecycle(10, {
      event_id: 'evt_bash_patch_session_start',
      event_name: 'session_start',
      session_id: sessionId,
    });
    await emitLifecycle(20, {
      event_id: 'evt_bash_patch_task_bind',
      event_name: 'task_bind',
      session_id: sessionId,
    });
    const taskId = store.storage.findActiveTaskForSession(sessionId);
    expect(taskId).toBeDefined();
    if (taskId === undefined) throw new Error('task was not bound');

    const bash = await emitLifecycle(100, {
      event_id: 'evt_bash_pre',
      event_name: 'pre_tool_use',
      session_id: sessionId,
      tool_name: 'Bash',
      tool_input: {
        operation: 'command',
        command: 'perl -pi -e "s/a/b/" src/perl.ts && printf x | tee src/tee.ts > /dev/null',
      },
    });
    expect(bash.extracted_paths).toEqual(['src/perl.ts', 'src/tee.ts']);

    const applyPatch = await emitLifecycle(110, {
      event_id: 'evt_apply_patch_pre',
      event_name: 'pre_tool_use',
      session_id: sessionId,
      tool_name: 'apply_patch',
      tool_input: {
        operation: 'patch',
        command: [
          '*** Begin Patch',
          '*** Update File: src/example.ts',
          '*** Add File: src/generated.ts',
          '*** Update File: /dev/null',
          '*** End Patch',
        ].join('\n'),
      },
    });
    expect(applyPatch.extracted_paths).toEqual(['src/example.ts', 'src/generated.ts']);

    expect(store.storage.getClaim(taskId, 'src/perl.ts')?.session_id).toBe(sessionId);
    expect(store.storage.getClaim(taskId, 'src/tee.ts')?.session_id).toBe(sessionId);
    expect(store.storage.getClaim(taskId, 'src/example.ts')?.session_id).toBe(sessionId);
    expect(store.storage.getClaim(taskId, 'src/generated.ts')?.session_id).toBe(sessionId);
    expect(firstSessionObservation(sessionId, 'tool_use')).toBeUndefined();

    const lifecycleEvents = taskLifecycleEvents(taskId);
    expect(lifecycleEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_id: 'evt_bash_pre',
          event_type: 'pre_tool_use',
          extracted_paths: ['src/perl.ts', 'src/tee.ts'],
        }),
        expect.objectContaining({
          event_id: 'evt_apply_patch_pre',
          event_type: 'pre_tool_use',
          extracted_paths: ['src/example.ts', 'src/generated.ts'],
        }),
      ]),
    );
  });
});

async function emitLifecycle(
  tsOffset: number,
  overrides: Record<string, unknown>,
): Promise<Awaited<ReturnType<typeof runOmxLifecycleEnvelope>>> {
  vi.setSystemTime(BASE_TS + tsOffset);
  const result = await runOmxLifecycleEnvelope(envelope(overrides), { store });
  expect(result.ok).toBe(true);
  return result;
}

function envelope(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    event_id: 'evt_default',
    event_name: 'session_start',
    session_id: 'codex@default',
    agent: 'codex',
    cwd: repoRoot,
    repo_root: repoRoot,
    branch: BRANCH,
    timestamp: new Date(Date.now()).toISOString(),
    source: 'omx',
    ...overrides,
  };
}

function editEnvelope(
  eventId: string,
  eventName: 'pre_tool_use' | 'post_tool_use',
  sessionId: string,
): Record<string, unknown> {
  return {
    event_id: eventId,
    event_name: eventName,
    session_id: sessionId,
    tool_name: 'Edit',
    tool_input: {
      operation: 'replace',
      paths: [{ path: FILE_PATH, role: 'target', kind: 'file' }],
    },
  };
}

function fakeGitRepo(name: string, branch: string): string {
  const repo = join(dir, name);
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`, 'utf8');
  writeFileSync(join(repo, FILE_PATH), 'export const example = 1;\n', 'utf8');
  return repo;
}

function taskLifecycleEvents(taskId: number): Array<Record<string, unknown> & { id: number }> {
  return store.storage
    .taskObservationsByKind(taskId, 'omx-lifecycle')
    .map((row) => {
      const metadata = parseMetadata(row.metadata);
      return metadata ? { ...metadata, id: row.id } : null;
    })
    .filter((metadata): metadata is Record<string, unknown> & { id: number } => metadata !== null)
    .sort((a, b) => {
      const timestampDelta = Date.parse(String(a.timestamp)) - Date.parse(String(b.timestamp));
      return timestampDelta || a.id - b.id;
    });
}

function firstTaskObservation(taskId: number, kind: string): ObservationRow | undefined {
  return store.storage.taskObservationsByKind(taskId, kind).at(-1);
}

function firstSessionObservation(sessionId: string, kind: string): ObservationRow | undefined {
  return store.storage.timeline(sessionId).find((row) => row.kind === kind);
}

function parseMetadata(value: string | null | undefined): Record<string, unknown> | null {
  if (!value) return null;
  return JSON.parse(value) as Record<string, unknown>;
}
