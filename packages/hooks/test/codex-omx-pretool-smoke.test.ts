import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { MemoryStore, TaskThread, detectRepoBranch } from '@colony/core';
import type { ClaimBeforeEditStats, ObservationRow } from '@colony/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runOmxLifecycleEnvelope } from '../src/lifecycle-envelope.js';

const BASE_TS = Date.parse('2026-04-29T10:00:00.000Z');
const BRANCH = 'agent/codex/pretool-smoke';
const FILE_PATH = 'src/bridge-target.ts';
const SESSION_ID = 'codex@fresh-pretool-smoke';
const HEALTH_WINDOW_MS = 24 * 60 * 60 * 1000;
const BRIDGE_FAILURE_HINT =
  'Codex/OMX pre-tool smoke failed: check colony install --ide codex and colony bridge lifecycle pre_tool_use wiring before file mutation.';

let dir: string;
let repoRoot: string;
let store: MemoryStore;

describe('Codex/OMX pre_tool_use smoke', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TS);
    dir = mkdtempSync(join(tmpdir(), 'colony-codex-omx-pretool-smoke-'));
    repoRoot = tempGitRepo('repo', BRANCH);
    store = new MemoryStore({ dbPath: join(dir, 'state', 'colony.db'), settings: defaultSettings });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it('proves a fresh bridge-enabled edit has pre_tool_use and claim-before-edit coverage', async () => {
    await emitLifecycle(10, {
      event_id: 'evt_smoke_session_start',
      event_name: 'session_start',
    });
    await emitLifecycle(20, {
      event_id: 'evt_smoke_task_bind',
      event_name: 'task_bind',
    });

    const taskId = store.storage.findActiveTaskForSession(SESSION_ID);
    expect(taskId).toBeDefined();
    if (taskId === undefined) throw new Error('task was not bound');
    expect(existsSync(join(repoRoot, '.git', 'config'))).toBe(true);

    vi.setSystemTime(BASE_TS + 30);
    const thread = TaskThread.open(store, {
      repo_root: repoRoot,
      branch: BRANCH,
      title: 'Codex/OMX pre_tool_use smoke',
      session_id: SESSION_ID,
    });
    thread.join(SESSION_ID, 'codex');
    const manualClaimId = thread.claimFile({
      session_id: SESSION_ID,
      file_path: FILE_PATH,
      note: 'manual smoke claim before bridge edit',
      metadata: { source: 'manual-smoke' },
    });

    const absoluteToolPath = join(repoRoot, FILE_PATH);
    expectGitRepo(repoRoot, BRANCH);
    expect(existsSync(absoluteToolPath), BRIDGE_FAILURE_HINT).toBe(true);
    expect(readFileSync(join(repoRoot, FILE_PATH), 'utf8')).toBe('export const before = 1;\n');

    await emitLifecycle(100, editEnvelope('evt_smoke_pre', 'pre_tool_use', absoluteToolPath));
    expect(readFileSync(join(repoRoot, FILE_PATH), 'utf8')).toBe('export const before = 1;\n');

    writeFileSync(join(repoRoot, FILE_PATH), 'export const after = 2;\n', 'utf8');

    await emitLifecycle(200, {
      ...editEnvelope('evt_smoke_post', 'post_tool_use', absoluteToolPath),
      parent_event_id: 'evt_smoke_pre',
      tool_response: { success: true },
    });

    const lifecycleEvents = taskLifecycleEvents(taskId);
    expect(lifecycleEvents.map((event) => event.event_type)).toEqual([
      'session_start',
      'task_bind',
      'pre_tool_use',
      'post_tool_use',
    ]);
    expect(lifecycleEvents[2]?.id).toBeLessThan(lifecycleEvents[3]?.id ?? 0);
    expect(lifecycleEvents[3]).toMatchObject({
      event_id: 'evt_smoke_post',
      parent_event_id: 'evt_smoke_pre',
    });

    const claim = store.storage.getClaim(taskId, FILE_PATH);
    expect(claim).toMatchObject({ session_id: SESSION_ID, file_path: FILE_PATH });
    expect(existsSync(join(repoRoot, claim?.file_path ?? 'missing'))).toBe(true);

    const manualClaim = store.storage.getObservation(manualClaimId);
    expect(parseMetadata(manualClaim?.metadata)).toMatchObject({
      kind: 'claim',
      source: 'manual-smoke',
      file_path: FILE_PATH,
    });

    const preToolSignal = firstTaskObservation(taskId, 'claim-before-edit');
    expect(parseMetadata(preToolSignal?.metadata)).toMatchObject({
      kind: 'claim-before-edit',
      source: 'pre-tool-use',
      outcome: 'edits_with_claim',
      file_path: FILE_PATH,
      tool: 'Edit',
    });

    const editObservation = firstSessionObservation(SESSION_ID, 'tool_use');
    expect(parseMetadata(editObservation?.metadata)).toMatchObject({
      tool: 'Edit',
      file_path: FILE_PATH,
    });
    expect(manualClaim?.ts, BRIDGE_FAILURE_HINT).toBeLessThan(editObservation?.ts ?? 0);
    expect(preToolSignal?.ts).toBeLessThanOrEqual(editObservation?.ts ?? 0);

    const shortWindowStats = store.storage.claimBeforeEditStats(BASE_TS + 50);
    assertBridgeCovered(shortWindowStats);

    const healthWindowStats = store.storage.claimBeforeEditStats(Date.now() - HEALTH_WINDOW_MS);
    assertBridgeCovered(healthWindowStats);
    expect(healthWindowStats).toMatchObject({
      edit_tool_calls: 1,
      edits_with_file_path: 1,
      edits_claimed_before: 1,
      pre_tool_use_signals: 1,
      claim_miss_reasons: {
        pre_tool_use_missing: 0,
      },
    });
  });

  it('normalizes Write, MultiEdit, apply_patch, and Patch paths into lifecycle edit telemetry', async () => {
    await emitLifecycle(10, {
      event_id: 'evt_multi_session_start',
      event_name: 'session_start',
    });
    await emitLifecycle(20, {
      event_id: 'evt_multi_task_bind',
      event_name: 'task_bind',
    });

    const taskId = store.storage.findActiveTaskForSession(SESSION_ID);
    expect(taskId).toBeDefined();
    if (taskId === undefined) throw new Error('task was not bound');

    const multiTarget = 'src/multi-target.ts';
    writeFileSync(join(repoRoot, multiTarget), 'export const beforeMulti = 1;\n', 'utf8');
    const cases = [
      {
        tool: 'Write',
        expected: 'src/write-target.ts',
        input: {
          path: join(repoRoot, 'src/write-target.ts'),
          content: 'export const writeTarget = true;\n',
        },
        mutate: () =>
          writeFileSync(
            join(repoRoot, 'src/write-target.ts'),
            'export const writeTarget = true;\n',
            'utf8',
          ),
      },
      {
        tool: 'MultiEdit',
        expected: multiTarget,
        input: {
          paths: [{ path: multiTarget, role: 'target', kind: 'file' }],
          edits: [{ old_string: 'beforeMulti', new_string: 'afterMulti' }],
        },
        mutate: () =>
          writeFileSync(join(repoRoot, multiTarget), 'export const afterMulti = 2;\n', 'utf8'),
      },
      {
        tool: 'apply_patch',
        expected: 'src/apply-patch-target.ts',
        input: {
          patch: [
            '*** Begin Patch',
            '*** Add File: src/apply-patch-target.ts',
            '+export const applyPatchTarget = true;',
            '*** End Patch',
          ].join('\n'),
        },
        mutate: () =>
          writeFileSync(
            join(repoRoot, 'src/apply-patch-target.ts'),
            'export const applyPatchTarget = true;\n',
            'utf8',
          ),
      },
      {
        tool: 'Patch',
        expected: 'src/patch-target.ts',
        input: [
          '*** Begin Patch',
          '*** Add File: src/patch-target.ts',
          '+export const patchTarget = true;',
          '*** End Patch',
        ].join('\n'),
        mutate: () =>
          writeFileSync(
            join(repoRoot, 'src/patch-target.ts'),
            'export const patchTarget = true;\n',
            'utf8',
          ),
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const eventPrefix = `evt_multi_${index}`;
      const pre = await emitLifecycleResult(100 + index * 100, {
        event_id: `${eventPrefix}_pre`,
        event_name: 'pre_tool_use',
        tool_name: testCase.tool,
        tool_input: testCase.input,
      });
      expect(pre.extracted_paths).toContain(testCase.expected);

      testCase.mutate();

      const post = await emitLifecycleResult(130 + index * 100, {
        event_id: `${eventPrefix}_post`,
        event_name: 'post_tool_use',
        parent_event_id: `${eventPrefix}_pre`,
        tool_name: testCase.tool,
        tool_input: testCase.input,
        tool_response: { success: true },
      });
      expect(post.extracted_paths).toContain(testCase.expected);
    }

    for (const testCase of cases) {
      expect(store.storage.getClaim(taskId, testCase.expected)).toMatchObject({
        session_id: SESSION_ID,
        file_path: testCase.expected,
      });
    }

    const editObservations = store
      .storage
      .timeline(SESSION_ID)
      .filter((row) => row.kind === 'tool_use')
      .map((row) => parseMetadata(row.metadata))
      .filter((metadata): metadata is Record<string, unknown> => metadata !== null);
    const expectedPaths = cases.map((testCase) => testCase.expected);
    expect(editObservations.map((metadata) => metadata.file_path).sort()).toEqual(
      expectedPaths.slice().sort(),
    );

    const preToolSignals = store
      .storage
      .taskObservationsByKind(taskId, 'claim-before-edit')
      .map((row) => parseMetadata(row.metadata))
      .filter((metadata): metadata is Record<string, unknown> => metadata !== null);
    expect(preToolSignals).toHaveLength(cases.length);
    expect(preToolSignals.map((metadata) => metadata.file_path).sort()).toEqual(
      expectedPaths.slice().sort(),
    );

    const stats = store.storage.claimBeforeEditStats(BASE_TS + 50);
    expect(stats).toMatchObject({
      edit_tool_calls: cases.length,
      edits_with_file_path: cases.length,
      edits_claimed_before: cases.length,
      pre_tool_use_signals: cases.length,
      claim_miss_reasons: {
        pre_tool_use_missing: 0,
      },
    });
  });
});

async function emitLifecycle(
  tsOffset: number,
  overrides: Record<string, unknown>,
): Promise<void> {
  await emitLifecycleResult(tsOffset, overrides);
}

async function emitLifecycleResult(
  tsOffset: number,
  overrides: Record<string, unknown>,
): ReturnType<typeof runOmxLifecycleEnvelope> {
  vi.setSystemTime(BASE_TS + tsOffset);
  const result = await runOmxLifecycleEnvelope(envelope(overrides), { store });
  expect(result.ok).toBe(true);
  return result;
}

function envelope(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    event_id: 'evt_default',
    event_name: 'session_start',
    session_id: SESSION_ID,
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
  filePath: string,
): Record<string, unknown> {
  return {
    event_id: eventId,
    event_name: eventName,
    tool_name: 'Edit',
    tool_input: {
      operation: 'replace',
      paths: [{ path: filePath, role: 'target', kind: 'file' }],
    },
  };
}

function tempGitRepo(name: string, branch: string): string {
  const repo = join(dir, name);
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '--quiet', '-b', branch, repo], { stdio: 'ignore' });
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, FILE_PATH), 'export const before = 1;\n', 'utf8');
  return repo;
}

function expectGitRepo(repo: string, branch: string): void {
  expect(existsSync(join(repo, '.git'))).toBe(true);
  expect(detectRepoBranch(repo)).toEqual({ repo_root: repo, branch });
}

function taskLifecycleEvents(taskId: number): Array<Record<string, unknown> & { id: number }> {
  return store.storage
    .taskObservationsByKind(taskId, 'omx-lifecycle')
    .map((row) => {
      const metadata = parseMetadata(row.metadata);
      return metadata ? { ...metadata, id: row.id } : null;
    })
    .filter((metadata): metadata is Record<string, unknown> & { id: number } => metadata !== null)
    .sort((a, b) => Date.parse(String(a.timestamp)) - Date.parse(String(b.timestamp)));
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

function assertBridgeCovered(stats: ClaimBeforeEditStats): void {
  const missingPreTool = stats.claim_miss_reasons?.pre_tool_use_missing ?? 0;
  const preToolSignals = stats.pre_tool_use_signals ?? 0;
  if (missingPreTool > 0 || preToolSignals <= 0 || stats.edits_claimed_before <= 0) {
    throw new Error(
      `${BRIDGE_FAILURE_HINT} stats=${JSON.stringify({
        pre_tool_use_missing: missingPreTool,
        pre_tool_use_signals: preToolSignals,
        edits_claimed_before: stats.edits_claimed_before,
        edits_with_file_path: stats.edits_with_file_path,
      })}`,
    );
  }
}
