import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { MemoryStore, TaskThread, buildAttentionInbox } from '@colony/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sweepQueenPlans } from '../src/sweep.js';

const MINUTE_MS = 60_000;
const NOW = Date.UTC(2026, 3, 28, 12, 0, 0);
const REPO_ROOT = '/repo';

let dir: string;
let store: MemoryStore;

interface SeedSubtask {
  status: 'available' | 'claimed' | 'completed';
  created_minutes_ago?: number;
  claimed_minutes_ago?: number;
  completed_minutes_ago?: number;
  session_id?: string;
  agent?: string;
  file_scope?: string[];
  claimed_files?: string[];
  quota_handoff?: boolean;
  depends_on?: number[];
  wave?: {
    index: number;
    id?: string;
    title?: string;
    label?: string;
    role?: 'finalizer';
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  dir = mkdtempSync(join(tmpdir(), 'colony-queen-sweep-'));
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
  store.startSession({ id: 'queen-publisher', ide: 'codex', cwd: REPO_ROOT });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('sweepQueenPlans', () => {
  it('returns stalled claimed sub-tasks and completed plans ready for manual archive', () => {
    seedPlan('stalled-plan', {
      auto_archive: true,
      subtasks: [{ status: 'claimed', claimed_minutes_ago: 90, session_id: 'agent-a' }],
    });
    seedPlan('ready-plan', {
      auto_archive: false,
      subtasks: [
        { status: 'completed', completed_minutes_ago: 20 },
        { status: 'completed', completed_minutes_ago: 10 },
      ],
    });
    seedPlan('active-plan', {
      auto_archive: false,
      subtasks: [{ status: 'claimed', claimed_minutes_ago: 10, session_id: 'agent-b' }],
    });

    const result = sweepQueenPlans(store, { now: NOW });

    expect(result.map((plan) => plan.plan_slug).sort()).toEqual(['ready-plan', 'stalled-plan']);
    const stalled = result
      .find((plan) => plan.plan_slug === 'stalled-plan')
      ?.items.find((item) => item.reason === 'stalled');
    expect(stalled).toMatchObject({
      reason: 'stalled',
      subtask_index: 0,
      age_minutes: 90,
      claimed_by_session_id: 'agent-a',
    });

    const ready = result
      .find((plan) => plan.plan_slug === 'ready-plan')
      ?.items.find((item) => item.reason === 'ready-to-archive');
    expect(ready).toMatchObject({
      reason: 'ready-to-archive',
      completed_subtask_count: 2,
    });
  });

  it('returns old unclaimed sub-tasks only when dependencies are met', () => {
    seedPlan('unclaimed-plan', {
      auto_archive: false,
      subtasks: [
        { status: 'available', created_minutes_ago: 300 },
        { status: 'available', created_minutes_ago: 300, depends_on: [2] },
        { status: 'claimed', claimed_minutes_ago: 10, session_id: 'agent-c' },
      ],
    });

    const result = sweepQueenPlans(store, { now: NOW });

    const unclaimed = result.flatMap((plan) =>
      plan.items.filter((item) => item.reason === 'unclaimed'),
    );
    expect(unclaimed).toHaveLength(1);
    expect(unclaimed[0]).toMatchObject({
      reason: 'unclaimed',
      plan_slug: 'unclaimed-plan',
      subtask_index: 0,
      age_minutes: 300,
    });
  });

  it('adds wave summaries for ordered plans with stalled and blocked work', () => {
    seedPlan('ordered-plan', {
      auto_archive: false,
      subtasks: [
        {
          status: 'claimed',
          claimed_minutes_ago: 95,
          session_id: 'agent-a',
          wave: { index: 0, id: 'wave-1', title: 'Foundation' },
        },
        {
          status: 'claimed',
          claimed_minutes_ago: 80,
          session_id: 'agent-b',
          wave: { index: 0, id: 'wave-1', title: 'Foundation' },
        },
        {
          status: 'available',
          created_minutes_ago: 300,
          depends_on: [0, 1],
          wave: { index: 1, id: 'wave-2', title: 'Product work' },
        },
        {
          status: 'available',
          created_minutes_ago: 300,
          depends_on: [0, 1, 2],
          wave: { index: 2, id: 'finalizer', label: 'Finalizer', role: 'finalizer' },
        },
      ],
    });

    const result = sweepQueenPlans(store, { now: NOW });

    const plan = result.find((candidate) => candidate.plan_slug === 'ordered-plan');
    expect(plan?.items.filter((item) => item.reason === 'stalled')).toHaveLength(2);
    expect(plan?.items[0]).toMatchObject({
      reason: 'stalled',
      wave: {
        index: 1,
        id: 'wave-1',
        title: 'Foundation',
        label: 'Wave 1',
        source: 'metadata',
      },
    });
    expect(plan?.waves).toMatchObject([
      {
        index: 1,
        label: 'Wave 1',
        stalled_subtask_count: 2,
        unclaimed_subtask_count: 0,
        blocked_subtask_count: 0,
        waiting_on_subtask_count: 0,
        blocked_by: [],
      },
      {
        index: 2,
        label: 'Wave 2',
        stalled_subtask_count: 0,
        unclaimed_subtask_count: 0,
        blocked_subtask_count: 1,
        waiting_on_subtask_count: 2,
        blocked_by: [{ index: 1, label: 'Wave 1' }],
      },
      {
        index: 3,
        label: 'Finalizer',
        is_finalizer: true,
        blocked_subtask_count: 1,
        waiting_on_subtask_count: 3,
        blocked_by: [
          { index: 1, label: 'Wave 1' },
          { index: 2, label: 'Wave 2' },
        ],
      },
    ]);
  });

  it('auto-messages stalled claim owners through the attention inbox substrate', () => {
    seedPlan('message-plan', {
      auto_archive: true,
      subtasks: [
        {
          status: 'claimed',
          claimed_minutes_ago: 90,
          session_id: 'agent-a',
          agent: 'codex',
        },
      ],
    });

    const result = sweepQueenPlans(store, { now: NOW, auto_message: true });
    const stalled = result[0]?.items.find((item) => item.reason === 'stalled');
    expect(stalled).toMatchObject({ message_observation_id: expect.any(Number) });

    const inbox = buildAttentionInbox(store, {
      session_id: 'agent-a',
      agent: 'codex',
      include_stalled_lanes: false,
    });
    expect(inbox.unread_messages).toHaveLength(1);
    expect(inbox.unread_messages[0]).toMatchObject({
      id: stalled?.message_observation_id,
      urgency: 'needs_reply',
      from_agent: 'queen',
    });

    const body = store.getObservations([stalled?.message_observation_id ?? -1], {
      expand: true,
    })[0]?.content;
    expect(body).toBe('Sub-task 0 has been claimed for 90 minutes — still active?');
  });

  it('recommends Claude when Codex hit quota on a stale blocker', () => {
    seedPlan('codex-quota-plan', {
      auto_archive: true,
      subtasks: [
        {
          status: 'claimed',
          claimed_minutes_ago: 90,
          session_id: 'codex@quota',
          agent: 'codex',
          claimed_files: ['src/a.ts', 'src/b.ts'],
          quota_handoff: true,
        },
        { status: 'available', depends_on: [0] },
      ],
    });

    const stalled = sweepQueenPlans(store, { now: NOW })[0]?.items.find(
      (item) => item.reason === 'stalled',
    );

    expect(stalled).toMatchObject({
      reason: 'stalled',
      replacement_recommendation: {
        recommended_replacement_agent: 'claude-code',
        reason: 'Codex recently hit quota on this branch',
        next_tool: 'task_accept_handoff',
        claim_args: {
          handoff_observation_id: expect.any(Number),
          session_id: '<session_id>',
        },
        signals: {
          stale_blocker_age_minutes: 90,
          claimed_file_count: 2,
          task_size: 1,
          claimed_by_agent: 'codex',
          runtime_history: 'codex',
          quota_exhausted_handoff_id: expect.any(Number),
        },
      },
    });
  });

  it('recommends Codex when Claude is the stale blocker without quota evidence', () => {
    seedPlan('claude-stale-plan', {
      auto_archive: true,
      subtasks: [
        {
          status: 'claimed',
          claimed_minutes_ago: 120,
          session_id: 'claude@stale',
          agent: 'claude',
          file_scope: ['src/a.ts', 'src/b.ts'],
          claimed_files: ['src/a.ts'],
        },
        { status: 'available', depends_on: [0] },
      ],
    });

    const stalled = sweepQueenPlans(store, { now: NOW })[0]?.items.find(
      (item) => item.reason === 'stalled',
    );

    expect(stalled).toMatchObject({
      replacement_recommendation: {
        recommended_replacement_agent: 'codex',
        reason: 'Claude stale for 120m on 1 claimed file(s); task size 2 file(s)',
        next_tool: 'task_plan_claim_subtask',
        claim_args: {
          plan_slug: 'claude-stale-plan',
          subtask_index: 0,
          agent: 'codex',
          repo_root: REPO_ROOT,
          file_scope: ['src/a.ts', 'src/b.ts'],
        },
      },
    });
  });

  it('does not recommend a replacement without a stale or quota blocker', () => {
    seedPlan('active-plan', {
      auto_archive: true,
      subtasks: [{ status: 'claimed', claimed_minutes_ago: 10, session_id: 'codex@active' }],
    });

    const result = sweepQueenPlans(store, { now: NOW });

    expect(result).toEqual([]);
  });
});

function seedPlan(
  slug: string,
  opts: { auto_archive: boolean; subtasks: SeedSubtask[] },
): { specTaskId: number; subtaskTaskIds: number[] } {
  setMinutesAgo(360);
  const parent = TaskThread.open(store, {
    repo_root: REPO_ROOT,
    branch: `spec/${slug}`,
    title: `${slug} title`,
    session_id: 'queen-publisher',
  });
  parent.join('queen-publisher', 'queen');
  store.addObservation({
    session_id: 'queen-publisher',
    task_id: parent.task_id,
    kind: 'plan-config',
    content: `plan ${slug} config: auto_archive=${opts.auto_archive}`,
    metadata: { plan_slug: slug, auto_archive: opts.auto_archive },
  });

  const subtaskTaskIds: number[] = [];
  for (let i = 0; i < opts.subtasks.length; i++) {
    const subtask = opts.subtasks[i];
    if (!subtask) continue;
    setMinutesAgo(subtask.created_minutes_ago ?? 300);
    const thread = TaskThread.open(store, {
      repo_root: REPO_ROOT,
      branch: `spec/${slug}/sub-${i}`,
      session_id: 'queen-publisher',
    });
    thread.join('queen-publisher', 'queen');
    store.addObservation({
      session_id: 'queen-publisher',
      task_id: thread.task_id,
      kind: 'plan-subtask',
      content: `Sub-task ${i}\n\nSeeded sub-task ${i}.`,
      metadata: {
        parent_plan_slug: slug,
        parent_plan_title: `${slug} title`,
        parent_spec_task_id: parent.task_id,
        subtask_index: i,
        file_scope: subtask.file_scope ?? [`src/${slug}-${i}.ts`],
        depends_on: subtask.depends_on ?? [],
        spec_row_id: null,
        capability_hint: null,
        status: 'available',
        ...waveMetadata(subtask.wave),
      },
    });
    subtaskTaskIds.push(thread.task_id);

    if (subtask.status === 'claimed' || subtask.status === 'completed') {
      const sessionId = subtask.session_id ?? `${slug}-worker`;
      const agent = subtask.agent ?? 'codex';
      store.startSession({
        id: sessionId,
        ide: agent === 'claude' ? 'claude-code' : 'codex',
        cwd: REPO_ROOT,
      });
      thread.join(sessionId, agent);
      setMinutesAgo(subtask.claimed_minutes_ago ?? 120);
      store.addObservation({
        session_id: sessionId,
        task_id: thread.task_id,
        kind: 'plan-subtask-claim',
        content: `${agent} claimed sub-task ${i} of plan ${slug}`,
        metadata: {
          status: 'claimed',
          session_id: sessionId,
          agent,
          plan_slug: slug,
          subtask_index: i,
        },
      });
      for (const file of subtask.claimed_files ?? []) {
        thread.claimFile({ session_id: sessionId, file_path: file });
      }
      if (subtask.quota_handoff === true) {
        store.addObservation({
          session_id: sessionId,
          task_id: thread.task_id,
          kind: 'handoff',
          content: `${agent} quota_exhausted handoff`,
          metadata: {
            kind: 'handoff',
            status: 'pending',
            from_session_id: sessionId,
            from_agent: agent,
            to_agent: 'any',
            to_session_id: null,
            quota_exhausted: true,
            summary: `${agent} hit quota`,
            blockers: ['quota_exhausted'],
            accepted_by_session_id: null,
            accepted_at: null,
            expires_at: NOW + 60 * MINUTE_MS,
          },
        });
      }
    }

    if (subtask.status === 'completed') {
      const sessionId = subtask.session_id ?? `${slug}-worker`;
      const agent = subtask.agent ?? 'codex';
      setMinutesAgo(subtask.completed_minutes_ago ?? 10);
      store.addObservation({
        session_id: sessionId,
        task_id: thread.task_id,
        kind: 'plan-subtask-claim',
        content: `completed sub-task ${i}`,
        metadata: {
          status: 'completed',
          session_id: sessionId,
          agent,
          plan_slug: slug,
          subtask_index: i,
          completed_at: Date.now(),
        },
      });
    }
  }

  vi.setSystemTime(NOW);
  return { specTaskId: parent.task_id, subtaskTaskIds };
}

function setMinutesAgo(minutes: number): void {
  vi.setSystemTime(NOW - minutes * MINUTE_MS);
}

function waveMetadata(wave: SeedSubtask['wave']): Record<string, unknown> {
  if (!wave) return {};
  return {
    wave_index: wave.index,
    ...(wave.id !== undefined ? { wave_id: wave.id } : {}),
    ...(wave.title !== undefined ? { wave_title: wave.title } : {}),
    ...(wave.label !== undefined ? { wave_label: wave.label } : {}),
    ...(wave.role !== undefined ? { wave_role: wave.role } : {}),
  };
}
