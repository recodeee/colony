import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { MemoryStore, TaskThread } from '@colony/core';
import type { ObservationRow } from '@colony/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runOmxLifecycleEnvelope } from '../src/lifecycle-envelope.js';

const BASE_TS = Date.parse('2026-04-29T10:00:00.000Z');
const BRANCH = 'agent/codex/pretool-smoke';
const FILE_PATH = 'src/bridge-target.ts';
const SESSION_ID = 'codex@fresh-pretool-smoke';

let dir: string;
let repoRoot: string;
let store: MemoryStore;

describe('Codex/OMX pre_tool_use smoke', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TS);
    dir = mkdtempSync(join(tmpdir(), 'colony-codex-omx-pretool-smoke-'));
    repoRoot = fakeGitRepo('repo', BRANCH);
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

    const absoluteToolPath = join(repoRoot, 'src', '..', 'src', 'bridge-target.ts');
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
    expect(preToolSignal?.ts).toBeLessThanOrEqual(editObservation?.ts ?? 0);

    const shortWindowStats = store.storage.claimBeforeEditStats(BASE_TS + 50);
    expect(shortWindowStats).toMatchObject({
      edit_tool_calls: 1,
      edits_with_file_path: 1,
      edits_claimed_before: 1,
      pre_tool_use_signals: 1,
      claim_miss_reasons: {
        pre_tool_use_missing: 0,
      },
    });
    expect(shortWindowStats.edits_claimed_before).toBeGreaterThan(0);
    expect(shortWindowStats.pre_tool_use_signals ?? 0).toBeGreaterThan(0);
  });
});

async function emitLifecycle(tsOffset: number, overrides: Record<string, unknown>): Promise<void> {
  vi.setSystemTime(BASE_TS + tsOffset);
  const result = await runOmxLifecycleEnvelope(envelope(overrides), { store });
  expect(result.ok).toBe(true);
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

function fakeGitRepo(name: string, branch: string): string {
  const repo = join(dir, name);
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`, 'utf8');
  writeFileSync(join(repo, FILE_PATH), 'export const before = 1;\n', 'utf8');
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
