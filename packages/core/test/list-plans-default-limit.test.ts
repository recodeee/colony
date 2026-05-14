import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/memory-store.js';
import { listPlans } from '../src/plan.js';
import { TaskThread } from '../src/task-thread.js';

let dir: string;
let store: MemoryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'colony-listplans-default-'));
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedPlanWithOneSubtask(slug: string): void {
  const root = TaskThread.open(store, {
    repo_root: '/r',
    branch: `spec/${slug}`,
    title: slug,
    session_id: 'seed-session',
  });
  // listPlans drops plans with zero sub-tasks AND drops any sub-task task that
  // lacks a `plan-subtask` observation (see readSubtask in plan.ts). Seed one
  // sub-task task plus the canonical observation, mirroring how publishPlan
  // writes plans into the store.
  const sub = TaskThread.open(store, {
    repo_root: '/r',
    branch: `spec/${slug}/sub-0`,
    title: `${slug} sub-0`,
    session_id: 'seed-session',
  });
  store.addObservation({
    session_id: 'seed-session',
    task_id: sub.task_id,
    kind: 'plan-subtask',
    content: `${slug} sub-0\n\nseed`,
    metadata: {
      parent_plan_slug: slug,
      parent_plan_title: slug,
      parent_spec_task_id: root.task_id,
      subtask_index: 0,
      title: `${slug} sub-0`,
      description: 'seed',
      file_scope: [],
      depends_on: [],
      spec_row_id: null,
      capability_hint: null,
      status: 'available',
    },
  });
}

describe('listPlans default limit', () => {
  it('caps at 10 plans when no limit is passed', () => {
    for (let i = 0; i < 12; i++) {
      seedPlanWithOneSubtask(`plan-${String(i).padStart(2, '0')}`);
    }
    const plans = listPlans(store, { repo_root: '/r' });
    expect(plans.length).toBeLessThanOrEqual(10);
  });

  it('honors an explicit limit larger than the new default', () => {
    for (let i = 0; i < 12; i++) {
      seedPlanWithOneSubtask(`plan-${String(i).padStart(2, '0')}`);
    }
    const plans = listPlans(store, { repo_root: '/r', limit: 12 });
    expect(plans.length).toBe(12);
  });
});
