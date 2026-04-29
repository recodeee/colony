import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { MemoryStore, listPlans } from '@colony/core';
import {
  type QueenOrderedPlanInput,
  colonyAdoptionFixesPlanInput,
  publishOrderedPlan,
} from '@colony/queen';
import kleur from 'kleur';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildColonyHealthPayload, formatColonyHealthOutput } from '../src/commands/health.js';

const NOW = 1_800_000_000_000;
const SINCE = NOW - 24 * 3_600_000;
const NO_CODEX_ROOT = '/var/empty/colony-queen-health-test-no-codex';

const MINIMAL_SPEC = `# SPEC

## §G  goal
Test fixture spec for queen health tests.

## §C  constraints
- markdown only.

## §I  interfaces
- none

## §V  invariants
id|rule|cites
-|-|-
V1|placeholder|-

## §T  tasks
id|status|task|cites
-|-|-|-
T1|todo|placeholder|V1

## §B  bugs
id|bug|cites
-|-|-
`;

const staleBlockedPlanInput: QueenOrderedPlanInput = {
  slug: 'stale-blocked-waves',
  title: 'Stale blocked waves',
  problem: 'Stale plan claims should become claimable again after release.',
  acceptance_criteria: [
    'A stale claimed blocker keeps later waves blocked until release.',
    'A released stale blocker becomes ready to claim.',
    'Completing the released blocker unlocks the next wave.',
  ],
  waves: [
    {
      title: 'Wave 1',
      subtasks: [
        {
          title: 'Stale claimed blocker',
          description: 'Claimed work that later gets released by rescue.',
          file_scope: ['apps/api/stale-blocker.ts'],
          capability_hint: 'api_work',
        },
      ],
    },
    {
      title: 'Wave 2',
      subtasks: [
        {
          title: 'Newly unblocked API',
          description: 'Work that unlocks after the blocker completes.',
          file_scope: ['apps/api/newly-unblocked.ts'],
          capability_hint: 'api_work',
        },
      ],
    },
    {
      title: 'Wave 3',
      subtasks: [
        {
          title: 'Final verification',
          description: 'Final wave waits for the API wave.',
          file_scope: ['apps/cli/test/queen-health.test.ts'],
          capability_hint: 'test_work',
        },
      ],
    },
  ],
};

let dataDir: string;
let repoRoot: string;
let store: MemoryStore;

beforeEach(() => {
  kleur.enabled = false;
  dataDir = mkdtempSync(join(tmpdir(), 'colony-queen-health-data-'));
  repoRoot = mkdtempSync(join(tmpdir(), 'colony-queen-health-repo-'));
  writeFileSync(join(repoRoot, 'SPEC.md'), MINIMAL_SPEC, 'utf8');
  store = new MemoryStore({ dbPath: join(dataDir, 'data.db'), settings: defaultSettings });
  store.startSession({ id: 'queen-session', ide: 'queen', cwd: repoRoot });
});

afterEach(() => {
  vi.useRealTimers();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(repoRoot, { recursive: true, force: true });
  kleur.enabled = true;
});

describe('queen wave health', () => {
  it('reports active adoption-fix plans, ready Wave 1 work, and blocked future waves', () => {
    publishOrderedPlan({
      store,
      plan: colonyAdoptionFixesPlanInput,
      repo_root: repoRoot,
      session_id: 'queen-session',
      agent: 'queen',
      auto_archive: false,
    });

    const payload = buildColonyHealthPayload(store.storage as never, {
      since: SINCE,
      window_hours: 24,
      now: NOW,
      codex_sessions_root: NO_CODEX_ROOT,
    });

    expect(payload.queen_wave_health).toMatchObject({
      active_plans: 1,
      current_wave: 'Wave 1',
      ready_subtasks: 3,
      blocked_subtasks: 4,
    });
    expect(payload.ready_to_claim_vs_claimed).toMatchObject({
      plan_subtasks: 7,
      ready_to_claim: 3,
      claimed: 0,
    });
    expect(payload.readiness_summary.queen_plan_readiness).toMatchObject({
      status: 'good',
      evidence: expect.stringContaining('1 active plan(s); 3 ready, 0 claimed'),
    });
    expect(payload.queen_wave_health.plans[0]).toMatchObject({
      plan_slug: 'colony-adoption-fixes',
      current_wave: 'Wave 1',
      ready_subtasks: 3,
      blocked_subtasks: 4,
    });

    const [plan] = listPlans(store, { repo_root: repoRoot });
    expect(plan?.next_available.map((subtask) => subtask.subtask_index)).toEqual([0, 1, 2]);
    expect(new Set(plan?.next_available.map((subtask) => subtask.wave_index))).toEqual(
      new Set([0]),
    );
    expect(
      plan?.subtasks
        .filter((subtask) => subtask.blocked_by_count > 0)
        .map((subtask) => subtask.subtask_index),
    ).toEqual([3, 4, 5, 6]);

    const text = formatColonyHealthOutput(payload);
    expect(text).toContain('Queen wave plans');
    expect(text).toContain('active plans:                       1');
    expect(text).toContain('ready subtasks:                     3');
    expect(text).toContain('blocked subtasks:                   4');
  });

  it('reports stale-blocked waves as ready after release and unblocked after completion', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW - 5 * 3_600_000);
    publishOrderedPlan({
      store,
      plan: staleBlockedPlanInput,
      repo_root: repoRoot,
      session_id: 'queen-session',
      agent: 'queen',
      auto_archive: false,
    });
    const blockerTaskId = taskIdForSubtask(staleBlockedPlanInput.slug, 0);
    claimPlanSubtask(staleBlockedPlanInput.slug, 0, blockerTaskId, 'stale-session');

    vi.setSystemTime(NOW);
    let payload = buildColonyHealthPayload(store.storage as never, {
      since: SINCE,
      window_hours: 24,
      now: NOW,
      claim_stale_minutes: 60,
      codex_sessions_root: NO_CODEX_ROOT,
    });

    expect(payload.queen_wave_health).toMatchObject({
      active_plans: 1,
      current_wave: 'Wave 1',
      ready_subtasks: 0,
      claimed_subtasks: 1,
      blocked_subtasks: 2,
      stale_claims_blocking_downstream: 1,
    });

    releasePlanSubtask(staleBlockedPlanInput.slug, 0, blockerTaskId, 'stale-session');
    payload = buildColonyHealthPayload(store.storage as never, {
      since: SINCE,
      window_hours: 24,
      now: NOW,
      claim_stale_minutes: 60,
      codex_sessions_root: NO_CODEX_ROOT,
    });

    expect(payload.queen_wave_health).toMatchObject({
      active_plans: 1,
      current_wave: 'Wave 1',
      ready_subtasks: 1,
      claimed_subtasks: 0,
      blocked_subtasks: 2,
      stale_claims_blocking_downstream: 0,
    });
    expect(
      listPlans(store, { repo_root: repoRoot })[0]?.next_available.map((s) => s.subtask_index),
    ).toEqual([0]);

    completePlanSubtask(staleBlockedPlanInput.slug, 0, blockerTaskId, 'stale-session');
    payload = buildColonyHealthPayload(store.storage as never, {
      since: SINCE,
      window_hours: 24,
      now: NOW,
      claim_stale_minutes: 60,
      codex_sessions_root: NO_CODEX_ROOT,
    });

    expect(payload.queen_wave_health).toMatchObject({
      active_plans: 1,
      current_wave: 'Wave 2',
      ready_subtasks: 1,
      claimed_subtasks: 0,
      blocked_subtasks: 1,
      stale_claims_blocking_downstream: 0,
    });
    expect(
      listPlans(store, { repo_root: repoRoot })[0]?.next_available.map((s) => s.subtask_index),
    ).toEqual([1]);
  });
});

function taskIdForSubtask(planSlug: string, subtaskIndex: number): number {
  const task = store.storage
    .listTasks(2000)
    .find((entry) => entry.branch === `spec/${planSlug}/sub-${subtaskIndex}`);
  expect(task).toBeDefined();
  return task?.id ?? -1;
}

function claimPlanSubtask(
  planSlug: string,
  subtaskIndex: number,
  taskId: number,
  sessionId: string,
): void {
  store.startSession({ id: sessionId, ide: 'codex', cwd: repoRoot });
  store.addObservation({
    session_id: sessionId,
    task_id: taskId,
    kind: 'plan-subtask-claim',
    content: `claimed sub-${subtaskIndex}`,
    metadata: {
      status: 'claimed',
      session_id: sessionId,
      agent: 'codex',
      plan_slug: planSlug,
      subtask_index: subtaskIndex,
    },
  });
  for (const file of fileScopeForSubtask(taskId)) {
    store.storage.claimFile({ task_id: taskId, file_path: file, session_id: sessionId });
  }
}

function releasePlanSubtask(
  planSlug: string,
  subtaskIndex: number,
  taskId: number,
  sessionId: string,
): void {
  const claims = store.storage.listClaims(taskId).filter((claim) => claim.session_id === sessionId);
  for (const claim of claims) {
    store.storage.releaseClaim({
      task_id: taskId,
      file_path: claim.file_path,
      session_id: sessionId,
    });
  }
  store.addObservation({
    session_id: sessionId,
    task_id: taskId,
    kind: 'plan-subtask-claim',
    content: `released and requeued sub-${subtaskIndex}`,
    metadata: {
      status: 'available',
      session_id: sessionId,
      agent: 'codex',
      plan_slug: planSlug,
      subtask_index: subtaskIndex,
      released_files: claims.map((claim) => claim.file_path),
    },
  });
}

function completePlanSubtask(
  planSlug: string,
  subtaskIndex: number,
  taskId: number,
  sessionId: string,
): void {
  store.addObservation({
    session_id: sessionId,
    task_id: taskId,
    kind: 'plan-subtask-claim',
    content: `completed sub-${subtaskIndex}`,
    metadata: {
      status: 'completed',
      session_id: sessionId,
      agent: 'codex',
      plan_slug: planSlug,
      subtask_index: subtaskIndex,
    },
  });
}

function fileScopeForSubtask(taskId: number): string[] {
  const initial = store.storage.taskObservationsByKind(taskId, 'plan-subtask', 500)[0];
  if (!initial?.metadata) return [];
  const meta = JSON.parse(initial.metadata) as { file_scope?: unknown };
  return Array.isArray(meta.file_scope)
    ? meta.file_scope.filter((entry): entry is string => typeof entry === 'string')
    : [];
}
