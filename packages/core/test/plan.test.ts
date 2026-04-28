import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/memory-store.js';
import { findSubtaskBySpecRow } from '../src/plan.js';
import { TaskThread } from '../src/task-thread.js';

let dir: string;
let store: MemoryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'colony-plan-core-'));
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
  store.startSession({ id: 'A', ide: 'claude-code', cwd: '/repo' });
  store.startSession({ id: 'B', ide: 'codex', cwd: '/repo' });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('findSubtaskBySpecRow', () => {
  it('returns the bound sub-task with its current claim status', () => {
    const thread = TaskThread.open(store, {
      repo_root: '/repo',
      branch: 'spec/binding/sub-0',
      session_id: 'A',
    });
    store.addObservation({
      session_id: 'A',
      task_id: thread.task_id,
      kind: 'plan-subtask',
      content: 'Bound row task\n\nComplete T5.',
      metadata: {
        parent_plan_slug: 'binding',
        parent_plan_title: 'Binding plan',
        parent_spec_task_id: 42,
        subtask_index: 0,
        file_scope: ['apps/api/src/bound.ts'],
        depends_on: [],
        spec_row_id: 'T5',
        capability_hint: null,
        status: 'available',
      },
    });
    store.addObservation({
      session_id: 'B',
      task_id: thread.task_id,
      kind: 'plan-subtask-claim',
      content: 'codex claimed sub-task 0 of plan binding',
      metadata: {
        status: 'claimed',
        session_id: 'B',
        agent: 'codex',
        plan_slug: 'binding',
        subtask_index: 0,
      },
    });

    const found = findSubtaskBySpecRow(store, '/repo', 'T5');
    expect(found?.branch).toBe('spec/binding/sub-0');
    expect(found?.info.parent_plan_slug).toBe('binding');
    expect(found?.info.subtask_index).toBe(0);
    expect(found?.info.status).toBe('claimed');
    expect(found?.info.spec_row_id).toBe('T5');
  });
});
