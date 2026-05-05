import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCoordinationSweep } from '../src/coordination-sweep.js';
import type { HivemindSnapshot } from '../src/hivemind.js';
import { MemoryStore } from '../src/memory-store.js';
import { TaskThread } from '../src/task-thread.js';
import type { WorktreeContentionReport } from '../src/worktree-contention.js';

const NOW = Date.UTC(2026, 3, 28, 12, 0, 0);
const MINUTE_MS = 60_000;

let dir: string;
let store: MemoryStore;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  dir = mkdtempSync(join(tmpdir(), 'colony-coordination-sweep-'));
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('buildCoordinationSweep stale claim cleanup', () => {
  it('releases expired/weak stale claims and keeps audit observations', () => {
    const filePath = 'src/expired.ts';
    seedStaleClaim('agent/expired', filePath, 'codex@expired', '/repo', 600);
    const taskId = taskIdByBranch('agent/expired');

    const result = buildCoordinationSweep(store, {
      repo_root: '/repo',
      now: NOW,
      release_safe_stale_claims: true,
      worktree_contention: emptyWorktreeContention(),
      hivemind: emptyHivemind(),
    });

    expect(result.summary).toMatchObject({
      stale_claims: 1,
      expired_or_weak_claims: 1,
      quota_pending_claims: 0,
      released_claims: 1,
      downgraded_claims: 0,
      skipped_dirty_claims: 0,
      skipped_active_claims: 0,
      skipped_downstream_blocking_claims: 0,
      stale_claim_count: 0,
      released_stale_claim_count: 1,
    });
    expect(result.safe_cleanup).toMatchObject({
      stale_claims: 1,
      expired_or_weak_claims: 1,
      released_claims: 1,
    });
    expect(result.released_stale_claims).toEqual([
      expect.objectContaining({
        task_id: taskId,
        file_path: filePath,
        session_id: 'codex@expired',
      }),
    ]);
    expect(store.storage.getClaim(taskId, filePath)).toBeUndefined();
    expectAuditRetained(taskId);
  });

  it('downgrades stale inactive non-dirty claims and keeps audit observations', () => {
    const filePath = 'src/stale.ts';
    seedStaleClaim('agent/stale', filePath, 'codex@stale', '/repo', 300);
    const taskId = taskIdByBranch('agent/stale');

    const result = buildCoordinationSweep(store, {
      repo_root: '/repo',
      now: NOW,
      release_safe_stale_claims: true,
      worktree_contention: emptyWorktreeContention(),
      hivemind: emptyHivemind(),
    });

    expect(result.summary).toMatchObject({
      stale_claims: 1,
      expired_or_weak_claims: 0,
      quota_pending_claims: 0,
      released_claims: 0,
      downgraded_claims: 1,
      skipped_dirty_claims: 0,
      skipped_active_claims: 0,
      skipped_downstream_blocking_claims: 0,
      stale_claim_count: 0,
      downgraded_stale_claim_count: 1,
    });
    expect(result.downgraded_stale_claims).toEqual([
      expect.objectContaining({
        task_id: taskId,
        file_path: filePath,
        session_id: 'codex@stale',
      }),
    ]);
    expect(store.storage.getClaim(taskId, filePath)).toBeUndefined();
    expectAuditRetained(taskId);
  });

  it('counts quota-pending stale claims in normalized cleanup reporting', () => {
    const filePath = 'src/quota.ts';
    seedStaleClaim('agent/quota', filePath, 'codex@quota', '/repo', 300);
    const taskId = taskIdByBranch('agent/quota');
    markQuotaPendingClaim(taskId, filePath, 'codex@quota');

    const result = buildCoordinationSweep(store, {
      repo_root: '/repo',
      now: NOW,
      release_safe_stale_claims: true,
      worktree_contention: emptyWorktreeContention(),
      hivemind: emptyHivemind(),
    });

    expect(result.summary).toMatchObject({
      stale_claims: 1,
      quota_pending_claims: 1,
      downgraded_claims: 1,
    });
    expect(result.safe_cleanup).toMatchObject({
      quota_pending_claims: 1,
      downgraded_claims: 1,
    });
  });

  it('skips stale claims when the owning managed worktree has the file dirty', () => {
    const filePath = 'src/dirty.ts';
    seedStaleClaim('agent/dirty', filePath, 'codex@dirty');

    const result = buildCoordinationSweep(store, {
      repo_root: '/repo',
      now: NOW,
      release_safe_stale_claims: true,
      worktree_contention: dirtyWorktreeReport('agent/dirty', filePath),
      hivemind: emptyHivemind(),
    });

    expect(result.summary).toMatchObject({
      released_stale_claim_count: 0,
      downgraded_stale_claim_count: 0,
      skipped_dirty_claims: 1,
      skipped_active_claims: 0,
      skipped_downstream_blocking_claims: 0,
      skipped_dirty_claim_count: 1,
      stale_claim_count: 1,
    });
    expect(result.skipped_dirty_claims).toEqual([
      expect.objectContaining({
        branch: 'agent/dirty',
        file_path: filePath,
        reason: 'dirty_worktree',
      }),
    ]);
    expect(result.recommended_actions).toEqual(
      expect.arrayContaining([expect.stringContaining('dirty stale claim')]),
    );
    const taskId = taskIdByBranch('agent/dirty');
    expect(store.storage.getClaim(taskId, filePath)?.session_id).toBe('codex@dirty');
    expect(store.storage.taskObservationsByKind(taskId, 'coordination-sweep')).toHaveLength(0);
  });

  it('skips stale claims when the owner session is still active', () => {
    const filePath = 'src/active.ts';
    seedStaleClaim('agent/active', filePath, 'codex@active');

    const result = buildCoordinationSweep(store, {
      repo_root: '/repo',
      now: NOW,
      release_safe_stale_claims: true,
      worktree_contention: emptyWorktreeContention(),
      hivemind: activeHivemind('codex@active'),
    });

    expect(result.summary).toMatchObject({
      released_claims: 0,
      downgraded_claims: 0,
      skipped_dirty_claims: 0,
      skipped_active_claims: 1,
      skipped_downstream_blocking_claims: 0,
      skipped_dirty_claim_count: 1,
      stale_claim_count: 1,
    });
    expect(result.skipped_dirty_claims).toEqual([
      expect.objectContaining({
        branch: 'agent/active',
        file_path: filePath,
        reason: 'active_session',
      }),
    ]);
    expect(result.recommended_actions).toEqual(
      expect.arrayContaining([expect.stringContaining('active stale claim')]),
    );
    const taskId = taskIdByBranch('agent/active');
    expect(store.storage.getClaim(taskId, filePath)?.session_id).toBe('codex@active');
    expect(store.storage.taskObservationsByKind(taskId, 'coordination-sweep')).toHaveLength(0);
  });

  it('skips stale claims that block downstream plan work', () => {
    const seeded = seedDownstreamBlockingClaim();

    const result = buildCoordinationSweep(store, {
      repo_root: '/repo',
      now: NOW,
      release_safe_stale_claims: true,
      worktree_contention: emptyWorktreeContention(),
      hivemind: emptyHivemind(),
    });

    expect(result.summary).toMatchObject({
      released_claims: 0,
      downgraded_claims: 0,
      skipped_dirty_claims: 0,
      skipped_active_claims: 0,
      skipped_downstream_blocking_claims: 1,
      skipped_dirty_claim_count: 1,
      stale_downstream_blocker_count: 1,
      stale_claim_count: 1,
    });
    expect(result.skipped_dirty_claims).toEqual([
      expect.objectContaining({
        task_id: seeded.taskId,
        file_path: seeded.filePath,
        reason: 'stale_downstream_blocker',
      }),
    ]);
    expect(result.recommended_actions).toEqual(
      expect.arrayContaining([expect.stringContaining('downstream-blocking stale claim')]),
    );
    expect(store.storage.getClaim(seeded.taskId, seeded.filePath)?.session_id).toBe(
      'codex@blocker',
    );
    expect(store.storage.taskObservationsByKind(seeded.taskId, 'coordination-sweep')).toHaveLength(
      0,
    );
  });

  it('releases expired quota-pending claims to weak_expired and marks relay expired', () => {
    const filePath = 'src/quota-expired.ts';
    seedStaleClaim('agent/quota-expired', filePath, 'codex@quota-expired', '/repo', 300);
    const taskId = taskIdByBranch('agent/quota-expired');
    const handoffId = markExpiredQuotaPendingClaim(
      taskId,
      filePath,
      'codex@quota-expired',
      NOW - 30 * MINUTE_MS,
    );

    const dryRun = buildCoordinationSweep(store, {
      repo_root: '/repo',
      now: NOW,
      worktree_contention: emptyWorktreeContention(),
      hivemind: emptyHivemind(),
    });
    expect(dryRun.summary.released_expired_quota_pending_claim_count).toBe(0);
    expect(dryRun.summary.quota_pending_claims).toBe(1);
    expect(store.storage.getClaim(taskId, filePath)?.state).toBe('handoff_pending');

    const applied = buildCoordinationSweep(store, {
      repo_root: '/repo',
      now: NOW,
      release_expired_quota_claims: true,
      worktree_contention: emptyWorktreeContention(),
      hivemind: emptyHivemind(),
    });

    expect(applied.summary).toMatchObject({
      released_expired_quota_pending_claim_count: 1,
      released_quota_pending_claims: 1,
    });
    expect(applied.safe_cleanup.released_quota_pending_claims).toBe(1);
    expect(applied.released_expired_quota_pending_claims).toEqual([
      expect.objectContaining({
        task_id: taskId,
        branch: 'agent/quota-expired',
        file_path: filePath,
        session_id: 'codex@quota-expired',
        handoff_observation_id: handoffId,
        cleanup_action: 'release_expired_quota_pending',
        reason: 'quota_pending_expired',
      }),
    ]);
    expect(store.storage.getClaim(taskId, filePath)?.state).toBe('weak_expired');
    const sweepObs = store.storage.taskObservationsByKind(taskId, 'coordination-sweep');
    expect(sweepObs).toHaveLength(1);
    const relayObs = store.storage.getObservation(handoffId);
    expect(relayObs?.metadata).toContain('"status":"expired"');
  });

  it('leaves quota-pending claims that are not yet expired alone', () => {
    const filePath = 'src/quota-future.ts';
    seedStaleClaim('agent/quota-future', filePath, 'codex@quota-future', '/repo', 300);
    const taskId = taskIdByBranch('agent/quota-future');
    markQuotaPendingClaim(taskId, filePath, 'codex@quota-future'); // expires in future

    const result = buildCoordinationSweep(store, {
      repo_root: '/repo',
      now: NOW,
      release_expired_quota_claims: true,
      worktree_contention: emptyWorktreeContention(),
      hivemind: emptyHivemind(),
    });

    expect(result.summary.released_expired_quota_pending_claim_count).toBe(0);
    expect(result.released_expired_quota_pending_claims).toEqual([]);
    expect(store.storage.getClaim(taskId, filePath)?.state).toBe('handoff_pending');
  });

  it('releases aged quota-pending claims via release_aged_quota_pending_minutes', () => {
    const filePath = 'src/quota-aged.ts';
    seedStaleClaim('agent/quota-aged', filePath, 'codex@quota-aged', '/repo', 90);
    const taskId = taskIdByBranch('agent/quota-aged');
    markQuotaPendingClaim(taskId, filePath, 'codex@quota-aged'); // not yet expired

    const dryRun = buildCoordinationSweep(store, {
      repo_root: '/repo',
      now: NOW,
      worktree_contention: emptyWorktreeContention(),
      hivemind: emptyHivemind(),
    });
    expect(dryRun.summary.released_aged_quota_pending_claim_count).toBe(0);
    expect(store.storage.getClaim(taskId, filePath)?.state).toBe('handoff_pending');

    const applied = buildCoordinationSweep(store, {
      repo_root: '/repo',
      now: NOW,
      release_aged_quota_pending_minutes: 60,
      worktree_contention: emptyWorktreeContention(),
      hivemind: emptyHivemind(),
    });

    expect(applied.summary.released_aged_quota_pending_claim_count).toBe(1);
    expect(applied.summary.released_quota_pending_claims).toBe(1);
    expect(applied.safe_cleanup.released_quota_pending_claims).toBe(1);
    expect(applied.released_expired_quota_pending_claims).toEqual([
      expect.objectContaining({
        task_id: taskId,
        file_path: filePath,
        session_id: 'codex@quota-aged',
        cleanup_action: 'release_aged_quota_pending',
        reason: 'quota_pending_aged',
      }),
    ]);
    expect(store.storage.getClaim(taskId, filePath)?.state).toBe('weak_expired');
  });

  it('skips quota-pending claims younger than release_aged_quota_pending_minutes', () => {
    const filePath = 'src/quota-young.ts';
    seedStaleClaim('agent/quota-young', filePath, 'codex@quota-young', '/repo', 30);
    const taskId = taskIdByBranch('agent/quota-young');
    markQuotaPendingClaim(taskId, filePath, 'codex@quota-young');

    const result = buildCoordinationSweep(store, {
      repo_root: '/repo',
      now: NOW,
      release_aged_quota_pending_minutes: 60,
      worktree_contention: emptyWorktreeContention(),
      hivemind: emptyHivemind(),
    });

    expect(result.summary.released_aged_quota_pending_claim_count).toBe(0);
    expect(store.storage.getClaim(taskId, filePath)?.state).toBe('handoff_pending');
  });

  it('releases same-branch duplicate claims to audit-only history', () => {
    seedStaleClaim('agent/codex/duplicate', 'src/shared.ts', 'codex@left', '/repo');
    seedStaleClaim('agent/codex/duplicate', 'src/shared.ts', 'codex@right', '/repo-alias');

    const dryRun = buildCoordinationSweep(store, {
      repo_root: '/repo',
      repo_roots: ['/repo', '/repo-alias'],
      now: NOW,
      worktree_contention: emptyWorktreeContention(),
      hivemind: emptyHivemind(),
    });

    expect(dryRun.summary).toMatchObject({
      same_branch_duplicate_claim_count: 2,
      released_same_branch_duplicate_claim_count: 0,
    });
    expect(dryRun.same_branch_duplicate_claims.map((claim) => claim.session_id).sort()).toEqual([
      'codex@left',
      'codex@right',
    ]);
    expect(dryRun.recommended_action).toContain('--release-same-branch-duplicates');

    const applied = buildCoordinationSweep(store, {
      repo_root: '/repo',
      repo_roots: ['/repo', '/repo-alias'],
      now: NOW,
      release_same_branch_duplicates: true,
      worktree_contention: emptyWorktreeContention(),
      hivemind: emptyHivemind(),
    });

    expect(applied.summary).toMatchObject({
      active_claim_count: 0,
      same_branch_duplicate_claim_count: 0,
      released_same_branch_duplicate_claim_count: 2,
    });
    expect(applied.released_same_branch_duplicate_claims).toHaveLength(2);
    expect(applied.recommended_action).toContain('released 2 same-branch duplicate claim(s)');
    for (const task of store.storage.listTasks(10)) {
      expect(store.storage.listClaims(task.id)).toHaveLength(0);
      expect(store.storage.taskObservationsByKind(task.id, 'coordination-sweep')).toHaveLength(1);
    }
  });
});

describe('buildCoordinationSweep archive_completed_plans', () => {
  it('archives plans whose sub-tasks all reached completed via plan-subtask-claim observations', () => {
    seedCompletedPlan('done-plan', ['completed', 'completed']);
    const baseline = buildCoordinationSweep(store, {
      repo_root: '/repo',
      now: NOW,
      worktree_contention: emptyWorktreeContention(),
      hivemind: emptyHivemind(),
    });
    expect(baseline.archived_completed_plans).toEqual([]);
    expect(baseline.summary.archived_completed_plan_count).toBe(0);

    const result = buildCoordinationSweep(store, {
      repo_root: '/repo',
      now: NOW,
      archive_completed_plans: true,
      worktree_contention: emptyWorktreeContention(),
      hivemind: emptyHivemind(),
    });

    expect(result.summary.archived_completed_plan_count).toBe(1);
    expect(result.archived_completed_plans).toHaveLength(1);
    expect(result.archived_completed_plans[0]).toMatchObject({
      plan_slug: 'done-plan',
      subtask_count: 2,
    });
    const parent = store.storage.findTaskByBranch('/repo', 'spec/done-plan');
    expect(parent?.status).toBe('archived');
  });

  it('skips plans with at least one non-completed sub-task', () => {
    seedCompletedPlan('partial-plan', ['completed', 'claimed']);
    const result = buildCoordinationSweep(store, {
      repo_root: '/repo',
      now: NOW,
      archive_completed_plans: true,
      worktree_contention: emptyWorktreeContention(),
      hivemind: emptyHivemind(),
    });
    expect(result.archived_completed_plans).toEqual([]);
    const parent = store.storage.findTaskByBranch('/repo', 'spec/partial-plan');
    expect(parent?.status).not.toBe('archived');
  });

  it('is idempotent — already-archived plans are not re-counted', () => {
    seedCompletedPlan('idempotent-plan', ['completed']);
    const first = buildCoordinationSweep(store, {
      repo_root: '/repo',
      now: NOW,
      archive_completed_plans: true,
      worktree_contention: emptyWorktreeContention(),
      hivemind: emptyHivemind(),
    });
    expect(first.archived_completed_plans).toHaveLength(1);
    const second = buildCoordinationSweep(store, {
      repo_root: '/repo',
      now: NOW,
      archive_completed_plans: true,
      worktree_contention: emptyWorktreeContention(),
      hivemind: emptyHivemind(),
    });
    expect(second.archived_completed_plans).toEqual([]);
    expect(second.summary.archived_completed_plan_count).toBe(0);
  });
});

function seedCompletedPlan(
  slug: string,
  subStatuses: Array<'available' | 'claimed' | 'completed'>,
): void {
  store.startSession({ id: 'planner', ide: 'claude-code', cwd: '/repo' });
  store.storage.findOrCreateTask({
    title: `parent-${slug}`,
    repo_root: '/repo',
    branch: `spec/${slug}`,
    created_by: 'planner',
  });
  subStatuses.forEach((status, idx) => {
    const sub = store.storage.findOrCreateTask({
      title: `${slug}-sub-${idx}`,
      repo_root: '/repo',
      branch: `spec/${slug}/sub-${idx}`,
      created_by: 'planner',
    });
    store.storage.insertObservation({
      session_id: 'planner',
      kind: 'plan-subtask-claim',
      content: `${slug} sub-${idx} ${status}`,
      compressed: false,
      intensity: null,
      ts: NOW + idx,
      task_id: sub.id,
      reply_to: null,
      metadata: { kind: 'plan-subtask-claim', status },
    });
  });
}

function seedStaleClaim(
  branch: string,
  filePath: string,
  sessionId: string,
  repoRoot = '/repo',
  ageMinutes = 300,
): void {
  vi.setSystemTime(NOW - ageMinutes * MINUTE_MS);
  store.startSession({ id: sessionId, ide: 'codex', cwd: repoRoot });
  const thread = TaskThread.open(store, {
    repo_root: repoRoot,
    branch,
    title: branch,
    session_id: sessionId,
  });
  thread.join(sessionId, 'codex');
  thread.claimFile({ session_id: sessionId, file_path: filePath });
  vi.setSystemTime(NOW);
}

function markQuotaPendingClaim(taskId: number, filePath: string, sessionId: string): void {
  const handoffObservationId = store.addObservation({
    session_id: sessionId,
    task_id: taskId,
    kind: 'relay',
    content: 'quota relay pending claim',
    metadata: { kind: 'relay', reason: 'quota' },
  });
  store.storage.markClaimHandoffPending({
    task_id: taskId,
    file_path: filePath,
    session_id: sessionId,
    expires_at: NOW + 60 * MINUTE_MS,
    handoff_observation_id: handoffObservationId,
  });
}

function markExpiredQuotaPendingClaim(
  taskId: number,
  filePath: string,
  sessionId: string,
  expiresAt: number,
): number {
  const handoffObservationId = store.addObservation({
    session_id: sessionId,
    task_id: taskId,
    kind: 'relay',
    content: 'quota relay pending claim',
    metadata: { kind: 'relay', reason: 'quota', status: 'pending', expires_at: expiresAt },
  });
  store.storage.markClaimHandoffPending({
    task_id: taskId,
    file_path: filePath,
    session_id: sessionId,
    expires_at: expiresAt,
    handoff_observation_id: handoffObservationId,
  });
  return handoffObservationId;
}

function seedDownstreamBlockingClaim(): { taskId: number; filePath: string } {
  const sessionId = 'codex@blocker';
  const slug = 'blocking-sweep';
  const filePath = 'src/blocker.ts';
  vi.setSystemTime(NOW - 300 * MINUTE_MS);
  store.startSession({ id: sessionId, ide: 'codex', cwd: '/repo' });
  const parent = TaskThread.open(store, {
    repo_root: '/repo',
    branch: `spec/${slug}`,
    session_id: sessionId,
    title: 'Blocking sweep',
  });
  store.addObservation({
    session_id: sessionId,
    task_id: parent.task_id,
    kind: 'plan-config',
    content: `plan ${slug}`,
    metadata: { plan_slug: slug, auto_archive: false },
  });

  const blocker = TaskThread.open(store, {
    repo_root: '/repo',
    branch: `spec/${slug}/sub-0`,
    session_id: sessionId,
    title: 'Blocker',
  });
  store.addObservation({
    session_id: sessionId,
    task_id: blocker.task_id,
    kind: 'plan-subtask',
    content: 'Blocker\n\nBlocker work.',
    metadata: {
      parent_plan_slug: slug,
      parent_plan_title: 'Blocking sweep',
      parent_spec_task_id: parent.task_id,
      subtask_index: 0,
      title: 'Blocker',
      description: 'Blocker work.',
      file_scope: [filePath],
      depends_on: [],
      spec_row_id: null,
      capability_hint: 'api_work',
      status: 'available',
    },
  });
  blocker.join(sessionId, 'codex');
  blocker.claimFile({ session_id: sessionId, file_path: filePath });
  store.addObservation({
    session_id: sessionId,
    task_id: blocker.task_id,
    kind: 'plan-subtask-claim',
    content: 'claimed sub-task 0',
    metadata: {
      kind: 'plan-subtask-claim',
      subtask_index: 0,
      status: 'claimed',
      session_id: sessionId,
      agent: 'codex',
    },
  });

  const downstream = TaskThread.open(store, {
    repo_root: '/repo',
    branch: `spec/${slug}/sub-1`,
    session_id: sessionId,
    title: 'Downstream',
  });
  store.addObservation({
    session_id: sessionId,
    task_id: downstream.task_id,
    kind: 'plan-subtask',
    content: 'Downstream\n\nDownstream work.',
    metadata: {
      parent_plan_slug: slug,
      parent_plan_title: 'Blocking sweep',
      parent_spec_task_id: parent.task_id,
      subtask_index: 1,
      title: 'Downstream',
      description: 'Downstream work.',
      file_scope: ['src/downstream.ts'],
      depends_on: [0],
      spec_row_id: null,
      capability_hint: 'api_work',
      status: 'available',
    },
  });
  vi.setSystemTime(NOW);
  return { taskId: blocker.task_id, filePath };
}

function expectAuditRetained(taskId: number): void {
  expect(store.storage.taskObservationsByKind(taskId, 'claim')).toHaveLength(1);
  const audit = store.storage.taskObservationsByKind(taskId, 'coordination-sweep');
  expect(audit).toHaveLength(1);
  expect(audit[0]?.content).toContain('audit history retained');
}

function taskIdByBranch(branch: string): number {
  const task = store.storage.listTasks(100).find((candidate) => candidate.branch === branch);
  if (!task) throw new Error(`missing task ${branch}`);
  return task.id;
}

function dirtyWorktreeReport(branch: string, filePath: string): WorktreeContentionReport {
  return {
    generated_at: new Date(NOW).toISOString(),
    repo_root: '/repo',
    inspected_roots: [],
    worktrees: [
      {
        branch,
        path: '/repo/.omx/agent-worktrees/dirty',
        managed_root: '.omx/agent-worktrees',
        dirty_files: [{ path: filePath, status: ' M' }],
        claimed_files: [filePath],
        active_session: null,
      },
    ],
    contentions: [],
    summary: {
      worktree_count: 1,
      dirty_worktree_count: 1,
      dirty_file_count: 1,
      contention_count: 0,
    },
  };
}

function emptyWorktreeContention(): WorktreeContentionReport {
  return {
    generated_at: new Date(NOW).toISOString(),
    repo_root: '/repo',
    inspected_roots: [],
    worktrees: [],
    contentions: [],
    summary: {
      worktree_count: 0,
      dirty_worktree_count: 0,
      dirty_file_count: 0,
      contention_count: 0,
    },
  };
}

function emptyHivemind() {
  return {
    generated_at: new Date(NOW).toISOString(),
    repo_roots: ['/repo'],
    session_count: 0,
    counts: {},
    sessions: [],
  };
}

function activeHivemind(sessionId: string): HivemindSnapshot {
  return {
    generated_at: new Date(NOW).toISOString(),
    repo_roots: ['/repo'],
    session_count: 1,
    counts: { working: 1 },
    sessions: [
      {
        activity: 'working',
        session_key: sessionId,
      } as HivemindSnapshot['sessions'][number],
    ],
  };
}
