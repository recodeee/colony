import {
  type MemoryStore,
  type MessageTarget,
  type PlanInfo,
  type SubtaskInfo,
  TaskThread,
  areDepsMet,
  listPlans,
} from '@colony/core';

export const DEFAULT_STALLED_MINUTES = 60;
export const DEFAULT_UNCLAIMED_MINUTES = 240;

const MINUTE_MS = 60_000;
const QUEEN_SESSION_ID = 'queen-sweep';
const QUEEN_AGENT = 'queen';

export interface SweepQueenPlansOptions {
  older_than_minutes?: number;
  unclaimed_older_than_minutes?: number;
  auto_message?: boolean;
  repo_root?: string;
  limit?: number;
  now?: number;
}

export type QueenAttentionReason = 'stalled' | 'unclaimed' | 'ready-to-archive';

interface BaseAttention {
  reason: QueenAttentionReason;
  plan_slug: string;
  plan_title: string;
  repo_root: string;
}

export interface StalledSubtaskAttention extends BaseAttention {
  reason: 'stalled';
  task_id: number;
  subtask_index: number;
  subtask_title: string;
  age_minutes: number;
  claimed_at: number;
  claimed_by_session_id: string;
  claimed_by_agent: string | null;
  message_observation_id?: number;
}

export interface UnclaimedSubtaskAttention extends BaseAttention {
  reason: 'unclaimed';
  task_id: number;
  subtask_index: number;
  subtask_title: string;
  age_minutes: number;
  available_since: number;
}

export interface ReadyToArchiveAttention extends BaseAttention {
  reason: 'ready-to-archive';
  spec_task_id: number;
  completed_subtask_count: number;
}

export type QueenAttentionItem =
  | StalledSubtaskAttention
  | UnclaimedSubtaskAttention
  | ReadyToArchiveAttention;

export interface QueenPlanAttention {
  plan_slug: string;
  title: string;
  repo_root: string;
  spec_task_id: number;
  items: QueenAttentionItem[];
}

export function sweepQueenPlans(
  store: MemoryStore,
  opts: SweepQueenPlansOptions = {},
): QueenPlanAttention[] {
  const now = opts.now ?? Date.now();
  const stalledAfterMs = minutesToMs(opts.older_than_minutes ?? DEFAULT_STALLED_MINUTES);
  const unclaimedAfterMs = minutesToMs(
    opts.unclaimed_older_than_minutes ?? DEFAULT_UNCLAIMED_MINUTES,
  );
  const plans = listPlans(store, {
    ...(opts.repo_root !== undefined ? { repo_root: opts.repo_root } : {}),
    limit: opts.limit ?? 2000,
  });

  const attention: QueenPlanAttention[] = [];
  for (const plan of plans) {
    const items: QueenAttentionItem[] = [];

    for (const subtask of plan.subtasks) {
      if (subtask.status === 'claimed') {
        const claimedAt = latestStatusTs(store, subtask.task_id, 'claimed');
        if (claimedAt !== null && now - claimedAt > stalledAfterMs) {
          const claimedBy = subtask.claimed_by_session_id;
          if (claimedBy !== null) {
            const item: StalledSubtaskAttention = {
              reason: 'stalled',
              plan_slug: plan.plan_slug,
              plan_title: plan.title,
              repo_root: plan.repo_root,
              task_id: subtask.task_id,
              subtask_index: subtask.subtask_index,
              subtask_title: subtask.title,
              age_minutes: elapsedMinutes(now, claimedAt),
              claimed_at: claimedAt,
              claimed_by_session_id: claimedBy,
              claimed_by_agent: subtask.claimed_by_agent,
            };
            if (opts.auto_message === true) {
              item.message_observation_id = messageStalledClaimer(store, item);
            }
            items.push(item);
          }
        }
      }

      if (subtask.status === 'available' && areDepsMet(subtask, plan.subtasks)) {
        const availableSince = availableSinceTs(store, plan, subtask);
        if (now - availableSince > unclaimedAfterMs) {
          items.push({
            reason: 'unclaimed',
            plan_slug: plan.plan_slug,
            plan_title: plan.title,
            repo_root: plan.repo_root,
            task_id: subtask.task_id,
            subtask_index: subtask.subtask_index,
            subtask_title: subtask.title,
            age_minutes: elapsedMinutes(now, availableSince),
            available_since: availableSince,
          });
        }
      }
    }

    if (isReadyToArchive(store, plan)) {
      items.push({
        reason: 'ready-to-archive',
        plan_slug: plan.plan_slug,
        plan_title: plan.title,
        repo_root: plan.repo_root,
        spec_task_id: plan.spec_task_id,
        completed_subtask_count: plan.subtasks.length,
      });
    }

    if (items.length > 0) {
      attention.push({
        plan_slug: plan.plan_slug,
        title: plan.title,
        repo_root: plan.repo_root,
        spec_task_id: plan.spec_task_id,
        items,
      });
    }
  }

  return attention;
}

function messageStalledClaimer(store: MemoryStore, item: StalledSubtaskAttention): number {
  const thread = new TaskThread(store, item.task_id);
  store.startSession({ id: QUEEN_SESSION_ID, ide: QUEEN_AGENT, cwd: null });
  thread.join(QUEEN_SESSION_ID, QUEEN_AGENT);
  return thread.postMessage({
    from_session_id: QUEEN_SESSION_ID,
    from_agent: QUEEN_AGENT,
    to_agent: messageTarget(item.claimed_by_agent),
    to_session_id: item.claimed_by_session_id,
    urgency: 'needs_reply',
    content: `Sub-task ${item.subtask_index} has been claimed for ${item.age_minutes} minutes — still active?`,
  });
}

function isReadyToArchive(store: MemoryStore, plan: PlanInfo): boolean {
  if (plan.subtasks.length === 0) return false;
  if (!plan.subtasks.every((subtask) => subtask.status === 'completed')) return false;
  if (planAutoArchiveEnabled(store, plan.spec_task_id)) return false;
  return !planAlreadyArchived(store, plan.spec_task_id);
}

function planAutoArchiveEnabled(store: MemoryStore, specTaskId: number): boolean {
  const configRows = store.storage.taskObservationsByKind(specTaskId, 'plan-config', 100);
  const latest = configRows[0];
  if (!latest?.metadata) return false;
  const meta = parseMeta(latest.metadata);
  return meta.auto_archive === true;
}

function planAlreadyArchived(store: MemoryStore, specTaskId: number): boolean {
  return (
    store.storage.taskObservationsByKind(specTaskId, 'plan-archived', 1).length > 0 ||
    store.storage.taskObservationsByKind(specTaskId, 'plan-auto-archive', 1).length > 0
  );
}

function availableSinceTs(store: MemoryStore, plan: PlanInfo, subtask: SubtaskInfo): number {
  const initial = initialSubtaskTs(store, subtask.task_id);
  const dependencyCompletionTimes = subtask.depends_on
    .map((index) => plan.subtasks.find((candidate) => candidate.subtask_index === index))
    .filter((candidate): candidate is SubtaskInfo => candidate !== undefined)
    .map((dependency) => latestStatusTs(store, dependency.task_id, 'completed'))
    .filter((ts): ts is number => ts !== null);
  return Math.max(initial, ...dependencyCompletionTimes);
}

function initialSubtaskTs(store: MemoryStore, taskId: number): number {
  const rows = store.storage.taskObservationsByKind(taskId, 'plan-subtask', 500);
  const initial = rows.length > 0 ? Math.min(...rows.map((row) => row.ts)) : null;
  if (initial !== null) return initial;
  return store.storage.getTask(taskId)?.created_at ?? 0;
}

function latestStatusTs(
  store: MemoryStore,
  taskId: number,
  status: 'claimed' | 'completed',
): number | null {
  const rows = store.storage.taskObservationsByKind(taskId, 'plan-subtask-claim', 500);
  for (const row of rows) {
    const meta = parseMeta(row.metadata);
    if (meta.status === status) return row.ts;
  }
  return null;
}

function elapsedMinutes(now: number, since: number): number {
  return Math.max(0, Math.floor((now - since) / MINUTE_MS));
}

function minutesToMs(minutes: number): number {
  return Math.max(0, minutes) * MINUTE_MS;
}

function messageTarget(agent: string | null): MessageTarget {
  if (agent === 'claude' || agent === 'codex') return agent;
  return 'any';
}

function parseMeta(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
