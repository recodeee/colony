import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { MemoryStore, TaskThread } from '@colony/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openspecSyncStatus } from '../src/openspec-sync-status.js';

let dir: string;
let repoRoot: string;
let store: MemoryStore;

const SESSION_ID = 'codex-sync-test';
const NOW = 1_800_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'colony-openspec-sync-'));
  repoRoot = join(dir, 'repo');
  mkdirSync(repoRoot, { recursive: true });
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
  store.startSession({ id: SESSION_ID, ide: 'codex', cwd: repoRoot });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('OpenSpec sync status', () => {
  it('reports Colony/OpenSpec drift with exact repair actions', () => {
    writeChangeTask('sync-plan', '- [ ] Final PR merge cleanup\n');
    writePlanCheckpoint('sync-plan', '- [ ] sub-0 Build API [completed]\n');
    writeChangeTask('no-pr', '- [x] Implementation complete\n');
    writeChangeTask('stale-change', '- [ ] Decide whether to keep old task\n');

    const completed = openTask('spec/sync-plan/sub-0', 'Build API');
    addTaskObservation(completed, 'plan-subtask', 'Build API', NOW - 50, {
      parent_plan_slug: 'sync-plan',
      subtask_index: 0,
      file_scope: ['apps/api.ts'],
      openspec_change_path: join(repoRoot, 'openspec/changes/sync-plan/CHANGE.md'),
      openspec_plan_slug: 'sync-plan',
      openspec_task_id: 'T5',
      spec_row_id: 'T5',
      status: 'available',
    });
    addTaskObservation(completed, 'plan-subtask-claim', 'Done', NOW - 25, {
      status: 'completed',
      plan_slug: 'sync-plan',
      subtask_index: 0,
      pr_url: 'https://github.com/recodeee/colony/pull/123',
      merge_state: 'MERGED',
    });

    const noPr = openTask('spec/no-pr/sub-0', 'Build no PR');
    addTaskObservation(noPr, 'plan-subtask', 'Build no PR', NOW - 50, {
      parent_plan_slug: 'no-pr',
      subtask_index: 0,
      file_scope: ['apps/no-pr.ts'],
      openspec_change_path: join(repoRoot, 'openspec/changes/no-pr/CHANGE.md'),
      openspec_plan_slug: 'no-pr',
      status: 'available',
    });
    addTaskObservation(noPr, 'plan-subtask-claim', 'Done', NOW - 20, {
      status: 'completed',
      plan_slug: 'no-pr',
      subtask_index: 0,
    });

    const missingChange = openTask('agent/codex/t3-work', 'T3 work');
    addTaskObservation(missingChange, 'note', 'OpenSpec tier: T3', NOW - 10, {
      openspec_tier: 'T3',
    });

    const status = openspecSyncStatus({
      store,
      repoRoot,
      now: NOW,
      staleAfterMs: 100,
    });

    expect(status.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'missing-openspec-change',
        'unchecked-openspec-checkbox',
        'missing-pr-evidence',
        'missing-verification-evidence',
        'merged-pr-cleanup-unchecked',
        'stale-openspec-checkbox',
      ]),
    );
    expect(
      status.issues.find(
        (issue) =>
          issue.code === 'unchecked-openspec-checkbox' &&
          issue.file_path === 'openspec/plans/sync-plan/checkpoints.md',
      ),
    ).toMatchObject({
      line: 1,
      openspec_task_id: 'T5',
    });
    expect(status.issues.find((issue) => issue.code === 'missing-pr-evidence')).toMatchObject({
      task_id: noPr.task_id,
      branch: 'spec/no-pr/sub-0',
    });
    expect(
      status.issues.find((issue) => issue.code === 'merged-pr-cleanup-unchecked'),
    ).toMatchObject({
      file_path: 'openspec/changes/sync-plan/tasks.md',
      line: 1,
    });
    expect(status.issues.flatMap((issue) => issue.repair_actions).join('\n')).toContain(
      'openspec validate --specs',
    );
  });

  it('keeps compact T0/T1 work out of full OpenSpec drift requirements', () => {
    const compact = openTask('agent/codex/tiny-fix', 'Tiny copy fix');
    addTaskObservation(compact, 'note', 'OpenSpec tier: T1', NOW, { openspec_tier: 'T1' });

    const status = openspecSyncStatus({ store, repoRoot, now: NOW });

    expect(status.issues.map((issue) => issue.code)).not.toContain('missing-openspec-change');
  });
});

function writeChangeTask(slug: string, tasks: string): void {
  const dirPath = join(repoRoot, 'openspec', 'changes', slug);
  mkdirSync(dirPath, { recursive: true });
  writeFileSync(join(dirPath, 'CHANGE.md'), `# ${slug}\n`, 'utf8');
  writeFileSync(join(dirPath, 'tasks.md'), tasks, 'utf8');
}

function writePlanCheckpoint(slug: string, checkpoints: string): void {
  const dirPath = join(repoRoot, 'openspec', 'plans', slug);
  mkdirSync(dirPath, { recursive: true });
  writeFileSync(join(dirPath, 'checkpoints.md'), checkpoints, 'utf8');
}

function openTask(branch: string, title: string): { task_id: number; branch: string } {
  const thread = TaskThread.open(store, {
    repo_root: repoRoot,
    branch,
    title,
    session_id: SESSION_ID,
  });
  thread.join(SESSION_ID, 'codex');
  return { task_id: thread.task_id, branch };
}

function addTaskObservation(
  task: { task_id: number },
  kind: string,
  content: string,
  ts: number,
  metadata?: Record<string, unknown>,
): void {
  store.storage.insertObservation({
    session_id: SESSION_ID,
    task_id: task.task_id,
    kind,
    content,
    compressed: false,
    intensity: null,
    ts,
    ...(metadata !== undefined ? { metadata } : {}),
  });
}
