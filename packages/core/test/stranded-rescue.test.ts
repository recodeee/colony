import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../src/memory-store.js';
import { listPlans } from '../src/plan.js';
import { bulkRescueStrandedSessions, rescueStrandedSessions } from '../src/stranded-rescue.js';
import { TaskThread } from '../src/task-thread.js';

const hivemind = vi.hoisted(() => ({
  sessions: [] as Array<{
    source: 'active-session';
    activity: 'working' | 'thinking' | 'idle' | 'stalled';
    session_key: string;
    file_path: string;
    worktree_path: string;
  }>,
}));

vi.mock('../src/hivemind.js', () => ({
  readHivemind: () => ({
    generated_at: new Date(0).toISOString(),
    repo_roots: ['/repo'],
    session_count: hivemind.sessions.length,
    counts: {},
    sessions: hivemind.sessions,
  }),
}));

type StrandedCandidate = {
  session_id: string;
  repo_root: string;
  worktree_path: string;
  last_observation_ts?: number;
  last_tool_error?: string;
};

type ToolError = {
  tool?: string;
  message?: string;
  ts?: number;
};

type StrandedStorage = typeof MemoryStore.prototype.storage & {
  findStrandedSessions: ReturnType<
    typeof vi.fn<[{ stranded_after_ms: number }], StrandedCandidate[]>
  >;
  recentToolErrors: ReturnType<typeof vi.fn<[{ session_id: string; limit?: number }], ToolError[]>>;
};

let dir: string;
let store: MemoryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'colony-stranded-rescue-'));
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
  hivemind.sessions = [];
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('rescueStrandedSessions', () => {
  it('reports an empty outcome when there are no stranded sessions', () => {
    configureStorage([]);

    expect(rescueStrandedSessions(store)).toEqual({
      scanned: 0,
      rescued: [],
      skipped: [],
    });
  });

  it('emits one relay, drops claims, and records rescue-relay audit metadata', () => {
    const { thread, session_id } = seedTask('feat/rescue', ['src/a.ts', 'src/b.ts']);
    store.addObservation({
      session_id,
      kind: 'note',
      task_id: thread.task_id,
      content: 'Replacing rescue storage adapter before quota cut.',
    });
    configureStorage([candidate(session_id)]);
    markAlive(session_id);

    const outcome = rescueStrandedSessions(store);

    expect(outcome.scanned).toBe(1);
    expect(outcome.rescued).toMatchObject([
      {
        session_id,
        task_id: thread.task_id,
        inherited_claims: ['src/a.ts', 'src/b.ts'],
        rescue_reason: 'silent-stranded',
      },
    ]);
    const rows = store.storage.taskTimeline(thread.task_id, 10);
    const relay = rows.find((row) => row.kind === 'relay');
    expect(relay?.id).toBe(outcome.rescued[0]?.relay_observation_id);
    expect(store.storage.getClaim(thread.task_id, 'src/a.ts')).toMatchObject({
      state: 'handoff_pending',
      handoff_observation_id: relay?.id,
    });
    expect(store.storage.getClaim(thread.task_id, 'src/b.ts')).toMatchObject({
      state: 'handoff_pending',
      handoff_observation_id: relay?.id,
    });
    const rescue = rows.find((row) => row.kind === 'rescue-relay');
    expect(JSON.parse(rescue?.metadata ?? '{}')).toMatchObject({
      stranded_session_id: session_id,
      claim_count: 2,
      rescue_reason: 'silent-stranded',
      relay_observation_id: relay?.id,
    });
    expect(rows.some((row) => row.kind === 'observer-note' && row.ts <= (rescue?.ts ?? 0))).toBe(
      true,
    );
  });

  it('emits one relay per task when a stranded session holds claims on multiple tasks', () => {
    const first = seedTask('feat/one', ['src/one.ts']);
    const second = seedTask('feat/two', ['src/two.ts']);
    configureStorage([candidate(first.session_id)]);
    markAlive(first.session_id);

    const outcome = rescueStrandedSessions(store);

    expect(outcome.rescued.map((entry) => entry.task_id).sort()).toEqual(
      [first.thread.task_id, second.thread.task_id].sort(),
    );
    expect(store.storage.getClaim(first.thread.task_id, 'src/one.ts')).toMatchObject({
      state: 'handoff_pending',
    });
    expect(store.storage.getClaim(second.thread.task_id, 'src/two.ts')).toMatchObject({
      state: 'handoff_pending',
    });
  });

  it('uses quota relay reason when the latest tool error matches quota', () => {
    const { session_id } = seedTask('feat/quota', ['src/quota.ts']);
    configureStorage([candidate(session_id)], [{ tool: 'Bash', message: 'quota exceeded', ts: 2 }]);
    markAlive(session_id);

    const outcome = rescueStrandedSessions(store);
    const relay = store.storage.getObservation(outcome.rescued[0]?.relay_observation_id ?? -1);
    const relayMeta = JSON.parse(relay?.metadata ?? '{}') as { reason?: string };

    expect(relayMeta.reason).toBe('quota');
    expect(outcome.rescued[0]?.rescue_reason).toBe('quota-rejection');
  });

  it('dry_run plans rescue without emitting relays or dropping claims', () => {
    const { thread, session_id } = seedTask('feat/dry-run', ['src/dry.ts']);
    configureStorage([candidate(session_id)]);
    markAlive(session_id);

    const outcome = rescueStrandedSessions(store, { dry_run: true });

    expect(outcome.rescued).toMatchObject([
      {
        session_id,
        task_id: thread.task_id,
        relay_observation_id: -1,
        inherited_claims: ['src/dry.ts'],
      },
    ]);
    expect(store.storage.getClaim(thread.task_id, 'src/dry.ts')?.session_id).toBe(session_id);
    expect(store.storage.taskTimeline(thread.task_id, 10).some((row) => row.kind === 'relay')).toBe(
      false,
    );
    expect(
      store.storage.taskTimeline(thread.task_id, 10).some((row) => row.kind === 'rescue-relay'),
    ).toBe(false);
  });

  it('bulk dry-run lists old stranded sessions without writing audit or dropping claims', () => {
    const { thread, session_id } = seedTask('feat/bulk-dry-run', [
      'src/bulk-a.ts',
      'src/bulk-b.ts',
    ]);
    configureStorage([candidate(session_id)]);

    const outcome = bulkRescueStrandedSessions(store, { dry_run: true });

    expect(outcome).toMatchObject({
      dry_run: true,
      scanned: 1,
      released_claim_count: 0,
      rescued: [],
      stranded: [
        {
          session_id,
          agent: 'codex',
          repo_root: '/repo',
          branch: 'feat/bulk-dry-run',
          held_claim_count: 2,
          suggested_action: 'would release 2 claim(s), mark session rescued, keep audit history',
        },
      ],
    });
    expect(store.storage.getClaim(thread.task_id, 'src/bulk-a.ts')?.session_id).toBe(session_id);
    expect(store.storage.getSession(session_id)?.ended_at).toBeNull();
    expect(store.storage.taskObservationsByKind(thread.task_id, 'rescue-stranded')).toHaveLength(0);
  });

  it('bulk apply releases claims, marks the session rescued, and keeps audit history', () => {
    const { thread, session_id } = seedTask('feat/bulk-apply', ['src/bulk.ts']);
    const noteId = store.addObservation({
      session_id,
      kind: 'note',
      task_id: thread.task_id,
      content: 'Historical note stays searchable after bulk rescue.',
    });
    configureStorage([candidate(session_id)]);

    const outcome = bulkRescueStrandedSessions(store, { dry_run: false });

    expect(outcome.rescued).toMatchObject([
      {
        session_id,
        agent: 'codex',
        repo_root: '/repo',
        branch: 'feat/bulk-apply',
        held_claim_count: 1,
      },
    ]);
    expect(outcome.released_claim_count).toBe(1);
    expect(outcome.audit_observation_ids).toHaveLength(1);
    expect(store.storage.getClaim(thread.task_id, 'src/bulk.ts')).toBeUndefined();
    expect(store.storage.getSession(session_id)?.ended_at).toEqual(expect.any(Number));
    expect(store.storage.getObservation(noteId)?.kind).toBe('note');
    const audit = store.storage.getObservation(outcome.audit_observation_ids[0] ?? -1);
    expect(audit?.kind).toBe('rescue-stranded');
    expect(JSON.parse(audit?.metadata ?? '{}')).toMatchObject({
      kind: 'rescue-stranded',
      action: 'bulk-release-claims',
      stranded_session_id: session_id,
      held_claim_count: 1,
      task_ids: [thread.task_id],
    });
    expect(store.storage.taskObservationsByKind(thread.task_id, 'relay')).toHaveLength(0);
  });

  it('bulk apply re-queues claimed plan subtasks after releasing a stranded owner', () => {
    const session_id = seedSession();
    const plan = seedOrderedPlan(session_id, { claimed: [0] });
    configureStorage([candidate(session_id)]);

    const before = listPlans(store, { repo_root: '/repo' }).find(
      (candidatePlan) => candidatePlan.plan_slug === 'ordered-rescue',
    );
    expect(before?.subtasks[0]?.status).toBe('claimed');
    expect(before?.next_available).toEqual([]);

    const outcome = bulkRescueStrandedSessions(store, { dry_run: false });

    expect(outcome.rescued[0]?.audit_observation_id).toEqual(expect.any(Number));
    const audit = store.storage.getObservation(outcome.rescued[0]?.audit_observation_id ?? -1);
    expect(JSON.parse(audit?.metadata ?? '{}')).toMatchObject({
      requeued_plan_subtasks: [
        {
          plan_slug: 'ordered-rescue',
          subtask_index: 0,
          task_id: plan.task_ids[0],
        },
      ],
    });
    const after = listPlans(store, { repo_root: '/repo' }).find(
      (candidatePlan) => candidatePlan.plan_slug === 'ordered-rescue',
    );
    expect(after?.subtasks[0]?.status).toBe('available');
    expect(after?.next_available.map((subtask) => subtask.subtask_index)).toEqual([0]);
  });

  it('stale wave 1 claim outranks a stale leaf claim', () => {
    const session_id = seedSession();
    const plan = seedOrderedPlan(session_id, { claimed: [0, 4] });
    configureStorage([candidate(session_id)]);
    markAlive(session_id);

    const outcome = rescueStrandedSessions(store, { dry_run: true });

    expect(outcome.rescued).toHaveLength(2);
    expect(outcome.rescued[0]).toMatchObject({
      task_id: plan.task_ids[0],
      plan_slug: 'ordered-rescue',
      wave_index: 0,
      blocked_downstream_count: 4,
      blocking_urgency: 'blocks_downstream',
      suggested_action:
        'message stalled owner or reassign this sub-task before later waves can continue',
    });
    expect(outcome.rescued[1]).toMatchObject({
      task_id: plan.task_ids[4],
      plan_slug: 'ordered-rescue',
      blocked_downstream_count: 0,
      blocking_urgency: 'local_claim',
    });
    expect(store.storage.getClaim(plan.task_ids[0] ?? -1, 'src/foundation.ts')?.session_id).toBe(
      session_id,
    );

    const observer = store.storage
      .taskObservationsByKind(plan.task_ids[0] ?? -1, 'observer-note', 10)
      .at(0);
    expect(observer?.content).toContain('blocks 4 downstream sub-task(s)');
    expect(JSON.parse(observer?.metadata ?? '{}')).toMatchObject({
      plan_slug: 'ordered-rescue',
      wave_index: 0,
      blocked_downstream_count: 4,
    });
  });

  it('does not count completed downstream subtasks as blocked', () => {
    const session_id = seedSession();
    const plan = seedOrderedPlan(session_id, { claimed: [0], completed: [3, 4] });
    configureStorage([candidate(session_id)]);
    markAlive(session_id);

    const outcome = rescueStrandedSessions(store, { dry_run: true });

    expect(outcome.rescued[0]).toMatchObject({
      task_id: plan.task_ids[0],
      blocked_downstream_count: 2,
    });
  });

  it('skips stranded candidates that are no longer alive in readHivemind', () => {
    const { thread, session_id } = seedTask('feat/dead', ['src/dead.ts']);
    configureStorage([candidate(session_id)]);

    const outcome = rescueStrandedSessions(store);

    expect(outcome.rescued).toEqual([]);
    expect(outcome.skipped).toEqual([{ session_id, reason: 'session not alive' }]);
    expect(store.storage.getClaim(thread.task_id, 'src/dead.ts')?.session_id).toBe(session_id);
  });
});

function seedTask(branch: string, files: string[]): { thread: TaskThread; session_id: string } {
  const session_id = 'codex-stranded-session';
  store.startSession({ id: session_id, ide: 'codex', cwd: '/repo' });
  const thread = TaskThread.open(store, {
    repo_root: '/repo',
    branch,
    session_id,
  });
  thread.join(session_id, 'codex');
  for (const file_path of files) {
    thread.claimFile({ session_id, file_path });
  }
  return { thread, session_id };
}

function seedSession(session_id = 'codex-stranded-session'): string {
  store.startSession({ id: session_id, ide: 'codex', cwd: '/repo' });
  return session_id;
}

function seedOrderedPlan(
  session_id: string,
  options: { claimed?: number[]; completed?: number[] } = {},
): { task_ids: number[] } {
  const slug = 'ordered-rescue';
  const parent = TaskThread.open(store, {
    repo_root: '/repo',
    branch: `spec/${slug}`,
    session_id,
  });
  store.addObservation({
    session_id,
    task_id: parent.task_id,
    kind: 'plan-config',
    content: `plan ${slug}`,
    metadata: { plan_slug: slug, auto_archive: false },
  });

  const subtasks = [
    { title: 'Foundation', file: 'src/foundation.ts', depends_on: [] },
    { title: 'Dashboard', file: 'src/dashboard.ts', depends_on: [0] },
    { title: 'Tooling', file: 'src/tooling.ts', depends_on: [0] },
    { title: 'Dashboard docs', file: 'docs/dashboard.md', depends_on: [1] },
    { title: 'Tooling docs', file: 'docs/tooling.md', depends_on: [2] },
  ];

  const claimed = new Set(options.claimed ?? [0]);
  const completed = new Set(options.completed ?? []);
  const taskIds: number[] = [];
  subtasks.forEach((subtask, index) => {
    const thread = TaskThread.open(store, {
      repo_root: '/repo',
      branch: `spec/${slug}/sub-${index}`,
      session_id,
    });
    taskIds[index] = thread.task_id;
    store.addObservation({
      session_id,
      task_id: thread.task_id,
      kind: 'plan-subtask',
      content: `${subtask.title}\n\n${subtask.title} work.`,
      metadata: {
        parent_plan_slug: slug,
        parent_plan_title: 'Ordered rescue',
        parent_spec_task_id: parent.task_id,
        subtask_index: index,
        file_scope: [subtask.file],
        depends_on: subtask.depends_on,
        spec_row_id: null,
        capability_hint: index === 0 ? 'api_work' : 'doc_work',
        status: 'available',
      },
    });
    if (claimed.has(index)) {
      thread.join(session_id, 'codex');
      thread.claimFile({ session_id, file_path: subtask.file });
      store.addObservation({
        session_id,
        task_id: thread.task_id,
        kind: 'plan-subtask-claim',
        content: `claimed sub-task ${index}`,
        metadata: {
          kind: 'plan-subtask-claim',
          subtask_index: index,
          status: 'claimed',
          session_id,
          agent: 'codex',
        },
      });
    }
    if (completed.has(index)) {
      store.addObservation({
        session_id,
        task_id: thread.task_id,
        kind: 'plan-subtask-claim',
        content: `completed sub-task ${index}`,
        metadata: {
          kind: 'plan-subtask-claim',
          subtask_index: index,
          status: 'completed',
          session_id,
          agent: 'codex',
        },
      });
    }
  });

  return { task_ids: taskIds };
}

function configureStorage(candidates: StrandedCandidate[], errors: ToolError[] = []): void {
  const storage = store.storage as StrandedStorage;
  storage.findStrandedSessions = vi.fn(() => candidates);
  storage.recentToolErrors = vi.fn(() => errors);
}

function candidate(session_id: string): StrandedCandidate {
  return {
    session_id,
    repo_root: '/repo',
    worktree_path: `/repo/.omx/agent-worktrees/${session_id}`,
    last_observation_ts: 123,
  };
}

function markAlive(session_id: string): void {
  hivemind.sessions = [
    {
      source: 'active-session',
      activity: 'working',
      session_key: session_id,
      file_path: `/repo/.omx/state/active-sessions/${session_id}.json`,
      worktree_path: `/repo/.omx/agent-worktrees/${session_id}`,
    },
  ];
}
