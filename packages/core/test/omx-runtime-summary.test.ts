import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore, ingestOmxRuntimeSummary, ingestOmxRuntimeSummaryFile } from '../src/index.js';
import { TaskThread } from '../src/task-thread.js';

let dir: string | undefined;
let store: MemoryStore | undefined;

afterEach(() => {
  store?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
  store = undefined;
});

describe('OMX runtime summaries', () => {
  it('stores compact runtime recovery state on the active Colony task', () => {
    dir = mkdtempSync(join(tmpdir(), 'colony-omx-runtime-summary-'));
    store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
    const repoRoot = join(dir, 'repo');
    store.startSession({ id: 'codex@runtime', ide: 'codex', cwd: repoRoot });
    const thread = TaskThread.open(store, {
      repo_root: repoRoot,
      branch: 'agent/codex/runtime',
      session_id: 'codex@runtime',
    });
    thread.join('codex@runtime', 'codex');

    const result = ingestOmxRuntimeSummary(store, {
      session_id: 'codex@runtime',
      agent: 'codex',
      repo_root: repoRoot,
      branch: 'agent/codex/runtime',
      timestamp: '2026-04-29T12:00:00.000Z',
      quota_warning: 'Usage limit approaching in 3 minutes',
      runtime_model_error: 'model overloaded',
      last_prompt_summary: 'implement runtime bridge',
      last_failed_tool: { name: 'Bash', error: 'spawn EPERM' },
      local_working_note: 'branch=agent/codex/runtime; next=retry bridge',
      active_file_focus: ['apps/cli/src/commands/health.ts'],
    });

    expect(result).toMatchObject({
      ok: true,
      task_id: thread.task_id,
      warnings: ['quota_warning', 'runtime_model_error', 'last_failed_tool'],
    });
    const row = store.storage.getObservation(result.observation_id ?? 0);
    expect(row).toMatchObject({
      kind: 'omx-runtime-summary',
      task_id: thread.task_id,
      session_id: 'codex@runtime',
    });
    expect(row?.content).toContain('quota=Usage limit approaching');
    expect(row?.content.length).toBeLessThan(700);
    const metadata = JSON.parse(row?.metadata ?? '{}') as Record<string, unknown>;
    expect(metadata).toMatchObject({
      source: 'omx',
      quota_warning: 'Usage limit approaching in 3 minutes',
      runtime_model_error: 'model overloaded',
      active_file_focus: ['apps/cli/src/commands/health.ts'],
      warnings: ['quota_warning', 'runtime_model_error', 'last_failed_tool'],
      warning_count: 3,
    });
    expect(store.storage.omxRuntimeSummaryStats(0)).toMatchObject({
      status: 'available',
      summaries_ingested: 1,
      warning_count: 3,
    });
    expect(store.storage.omxRuntimeWarningsSince(0, 5)).toHaveLength(1);
  });

  it('ingests fixture summaries without copying huge logs', () => {
    dir = mkdtempSync(join(tmpdir(), 'colony-omx-runtime-summary-file-'));
    store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
    const path = join(dir, 'runtime-summary.jsonl');
    writeFileSync(
      path,
      `${JSON.stringify({
        session_id: 'codex@fixture',
        timestamp: 1_000,
        last_prompt_summary: 'short prompt',
        local_working_note: 'x'.repeat(2_000),
      })}\n`,
    );

    const result = ingestOmxRuntimeSummaryFile(store, path, { repoRoot: join(dir, 'repo') });
    const jsonFixture = ingestOmxRuntimeSummaryFile(
      store,
      join(import.meta.dirname, '../../../apps/cli/test/fixtures/omx-runtime-summary.json'),
    );
    const jsonlFixture = ingestOmxRuntimeSummaryFile(
      store,
      join(import.meta.dirname, '../../../apps/cli/test/fixtures/omx-runtime-summary.jsonl'),
    );

    expect(result).toMatchObject({ scanned: 1, ingested: 1, failed: 0 });
    expect(jsonFixture).toMatchObject({ scanned: 1, ingested: 1, failed: 0 });
    expect(jsonlFixture).toMatchObject({ scanned: 1, ingested: 1, failed: 0 });
    const row = store.storage.getObservation(result.observations[0] ?? 0);
    expect(row?.content.length).toBeLessThan(700);
    expect(row?.content).not.toContain('x'.repeat(500));
  });
});
