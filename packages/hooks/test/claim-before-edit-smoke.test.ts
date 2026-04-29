import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { MemoryStore, TaskThread } from '@colony/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHook } from '../src/index.js';

const BASE_TS = Date.parse('2026-04-29T10:00:00.000Z');
const BRANCH = 'agent/codex/claim-smoke';
const FILE_PATH = 'src/example.ts';

let dir: string;
let repoRoot: string;
let store: MemoryStore;

type ClaimBeforeEditStats = ReturnType<MemoryStore['storage']['claimBeforeEditStats']>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(BASE_TS);
  dir = mkdtempSync(join(tmpdir(), 'colony-claim-before-edit-smoke-'));
  repoRoot = join(dir, 'repo');
  mkdirSync(join(repoRoot, '.git'), { recursive: true });
  mkdirSync(join(repoRoot, 'src'), { recursive: true });
  writeFileSync(join(repoRoot, FILE_PATH), 'export const example = 1;\n');
  writeFileSync(join(repoRoot, 'src/other.ts'), 'export const other = 1;\n');
  store = new MemoryStore({ dbPath: join(dir, 'state', 'colony.db'), settings: defaultSettings });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('claim-before-edit smoke', () => {
  it('correlates task_claim_file before a later Codex/OMX Edit PostToolUse event', async () => {
    const sessionId = 'codex@claim-smoke';
    const thread = startCodexOmxTask(sessionId);

    emitTaskClaimFile(thread, sessionId, FILE_PATH, BASE_TS + 100);
    await emitEditPostToolUse(sessionId, FILE_PATH, BASE_TS + 200);

    const stats = store.storage.claimBeforeEditStats(0);
    expect(stats).toMatchObject({
      edit_tool_calls: 1,
      edits_with_file_path: 1,
      edits_claimed_before: 1,
      claim_match_sources: {
        exact_session: 1,
        repo_branch: 0,
        worktree: 0,
        agent_lane: 0,
      },
    });
    expect(claimBeforeEditRate(stats)).toBeGreaterThan(0);
  });

  it('does not count a claim emitted after the edit', async () => {
    const sessionId = 'codex@late-claim';
    const thread = startCodexOmxTask(sessionId);

    await emitEditPostToolUse(sessionId, FILE_PATH, BASE_TS + 100);
    emitTaskClaimFile(thread, sessionId, FILE_PATH, BASE_TS + 200);

    expect(store.storage.claimBeforeEditStats(0)).toMatchObject({
      edit_tool_calls: 1,
      edits_with_file_path: 1,
      edits_claimed_before: 0,
      claim_match_sources: emptyMatchSources(),
    });
  });

  it('does not correlate a prior claim for a different path', async () => {
    const sessionId = 'codex@path-mismatch';
    const thread = startCodexOmxTask(sessionId);

    emitTaskClaimFile(thread, sessionId, FILE_PATH, BASE_TS + 100);
    await emitEditPostToolUse(sessionId, 'src/other.ts', BASE_TS + 200);

    expect(store.storage.claimBeforeEditStats(0)).toMatchObject({
      edit_tool_calls: 1,
      edits_with_file_path: 1,
      edits_claimed_before: 0,
      claim_match_sources: emptyMatchSources(),
    });
  });

  it('falls back from session mismatch to same repo and branch', async () => {
    const claimingSession = 'codex@claim-owner';
    const editingSession = 'codex@edit-owner';
    const thread = startCodexOmxTask(claimingSession);
    startCodexOmxSession(editingSession);
    thread.join(editingSession, 'codex');

    emitTaskClaimFile(thread, claimingSession, FILE_PATH, BASE_TS + 100);
    await emitEditPostToolUse(editingSession, FILE_PATH, BASE_TS + 200);

    expect(store.storage.claimBeforeEditStats(0)).toMatchObject({
      edit_tool_calls: 1,
      edits_with_file_path: 1,
      edits_claimed_before: 1,
      claim_match_sources: {
        exact_session: 0,
        repo_branch: 1,
        worktree: 0,
        agent_lane: 0,
      },
    });
  });

  it('skips /dev/null as a claim-eligible edit path', async () => {
    const sessionId = 'codex@dev-null';
    const thread = startCodexOmxTask(sessionId);

    emitTaskClaimFile(thread, sessionId, FILE_PATH, BASE_TS + 100);
    await emitEditPostToolUse(sessionId, '/dev/null', BASE_TS + 200);

    expect(store.storage.claimBeforeEditStats(0)).toMatchObject({
      edit_tool_calls: 1,
      edits_with_file_path: 0,
      edits_claimed_before: 0,
      claim_match_sources: emptyMatchSources(),
    });
  });
});

function startCodexOmxTask(sessionId: string): TaskThread {
  startCodexOmxSession(sessionId);
  const thread = TaskThread.open(store, {
    repo_root: repoRoot,
    branch: BRANCH,
    title: 'claim-before-edit smoke',
    session_id: sessionId,
  });
  thread.join(sessionId, 'codex');
  return thread;
}

function startCodexOmxSession(sessionId: string): void {
  store.startSession({
    id: sessionId,
    ide: 'codex',
    cwd: repoRoot,
    startedAt: BASE_TS,
    metadata: {
      agent: 'codex',
      repo_root: repoRoot,
      branch: BRANCH,
      worktree_path: repoRoot,
    },
  });
}

function emitTaskClaimFile(
  thread: TaskThread,
  sessionId: string,
  filePath: string,
  ts: number,
): void {
  vi.setSystemTime(ts);
  thread.claimFile({
    session_id: sessionId,
    file_path: filePath,
    note: 'task_claim_file smoke',
  });
}

async function emitEditPostToolUse(sessionId: string, filePath: string, ts: number): Promise<void> {
  vi.setSystemTime(ts);
  const result = await runHook(
    'post-tool-use',
    {
      session_id: sessionId,
      ide: 'codex',
      cwd: repoRoot,
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: filePath },
      tool_response: { success: true },
    },
    { store },
  );
  expect(result.ok).toBe(true);
}

function claimBeforeEditRate(stats: ClaimBeforeEditStats): number {
  return stats.edits_with_file_path > 0
    ? stats.edits_claimed_before / stats.edits_with_file_path
    : 0;
}

function emptyMatchSources(): NonNullable<ClaimBeforeEditStats['claim_match_sources']> {
  return {
    exact_session: 0,
    repo_branch: 0,
    worktree: 0,
    agent_lane: 0,
  };
}
