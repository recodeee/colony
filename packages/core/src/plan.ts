import type { MemoryStore } from './memory-store.js';

export type SubtaskStatus = 'available' | 'claimed' | 'completed' | 'blocked';

export interface SubtaskInfo {
  task_id: number;
  subtask_index: number;
  title: string;
  description: string;
  status: SubtaskStatus;
  file_scope: string[];
  depends_on: number[];
  spec_row_id: string | null;
  capability_hint: string | null;
  claimed_by_session_id: string | null;
  claimed_by_agent: string | null;
  parent_plan_slug: string;
  parent_plan_title: string | null;
  parent_spec_task_id: number | null;
}

export interface SubtaskLookup {
  task_id: number;
  branch: string;
  info: SubtaskInfo;
}

export interface PlanInfo {
  plan_slug: string;
  repo_root: string;
  spec_task_id: number;
  title: string;
  created_at: number;
  subtask_counts: Record<SubtaskStatus, number>;
  subtasks: SubtaskInfo[];
  next_available: SubtaskInfo[];
}

export interface ListPlansOptions {
  repo_root?: string;
  only_with_available_subtasks?: boolean;
  capability_match?: string;
  limit?: number;
}

const SUBTASK_BRANCH_RE = /^spec\/([a-z0-9-]+)\/sub-(\d+)$/;
const PLAN_ROOT_BRANCH_RE = /^spec\/([a-z0-9-]+)$/;

function parseMeta(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function readSubtask(store: MemoryStore, task_id: number, plan_slug: string): SubtaskInfo | null {
  const rows = store.storage.taskTimeline(task_id, 500);
  const initial = rows.find((r) => r.kind === 'plan-subtask');
  if (!initial) return null;
  const meta = parseMeta(initial.metadata);

  // Lifecycle resolution. taskTimeline orders by `ts DESC`, but two
  // observations stamped within the same millisecond have undefined
  // tie-breaker order in SQLite, so the latest-by-ts row can flicker
  // between `claimed` and `completed` for a sub-task that was just
  // finished. Resolve with terminal-state-wins precedence so a
  // `completed` row is authoritative once it exists; the attribution
  // metadata (session_id, agent) is read from the same row that
  // decided the status.
  const claimRows = rows.filter((r) => r.kind === 'plan-subtask-claim');
  let claimMeta: Record<string, unknown> = {};
  let resolvedStatus: SubtaskStatus | undefined;
  for (const precedence of ['completed', 'blocked', 'claimed'] as const) {
    const match = claimRows.find((r) => parseMeta(r.metadata).status === precedence);
    if (match) {
      claimMeta = parseMeta(match.metadata);
      resolvedStatus = precedence;
      break;
    }
  }

  const status = resolvedStatus ?? (meta.status as SubtaskStatus | undefined) ?? 'available';

  const [titleLine, ...rest] = initial.content.split('\n\n');
  return {
    task_id,
    subtask_index: typeof meta.subtask_index === 'number' ? meta.subtask_index : -1,
    title: titleLine ?? '(untitled)',
    description: rest.join('\n\n').trim(),
    status,
    file_scope: Array.isArray(meta.file_scope) ? (meta.file_scope as string[]) : [],
    depends_on: Array.isArray(meta.depends_on) ? (meta.depends_on as number[]) : [],
    spec_row_id: typeof meta.spec_row_id === 'string' ? (meta.spec_row_id as string) : null,
    capability_hint:
      typeof meta.capability_hint === 'string' ? (meta.capability_hint as string) : null,
    claimed_by_session_id:
      typeof claimMeta.session_id === 'string' ? (claimMeta.session_id as string) : null,
    claimed_by_agent: typeof claimMeta.agent === 'string' ? (claimMeta.agent as string) : null,
    parent_plan_slug: plan_slug,
    parent_plan_title:
      typeof meta.parent_plan_title === 'string' ? (meta.parent_plan_title as string) : null,
    parent_spec_task_id:
      typeof meta.parent_spec_task_id === 'number' ? (meta.parent_spec_task_id as number) : null,
  };
}

export function readSubtaskByBranch(store: MemoryStore, branch: string): SubtaskLookup | null {
  const m = branch.match(SUBTASK_BRANCH_RE);
  if (!m) return null;
  const slug = m[1];
  if (!slug) return null;
  const tasks = store.storage.listTasks(2000);
  const t = tasks.find((x) => x.branch === branch);
  if (!t) return null;
  const info = readSubtask(store, t.id, slug);
  if (!info) return null;
  return { task_id: t.id, branch, info };
}

export function findSubtaskBySpecRow(
  store: MemoryStore,
  repo_root: string,
  spec_row_id: string,
): SubtaskLookup | null {
  const tasks = store.storage.listTasks(2000);
  for (const task of tasks) {
    if (task.repo_root !== repo_root) continue;
    const m = task.branch.match(SUBTASK_BRANCH_RE);
    const slug = m?.[1];
    if (!slug) continue;
    const info = readSubtask(store, task.id, slug);
    if (info?.spec_row_id === spec_row_id) {
      return { task_id: task.id, branch: task.branch, info };
    }
  }
  return null;
}

export function areDepsMet(subtask: SubtaskInfo, all: SubtaskInfo[]): boolean {
  return subtask.depends_on.every((idx) => {
    const dep = all.find((s) => s.subtask_index === idx);
    return dep?.status === 'completed';
  });
}

export function listPlans(store: MemoryStore, opts: ListPlansOptions = {}): PlanInfo[] {
  const limit = opts.limit ?? 50;
  // listTasks default is 50; the plan registry may grow past that, so reach
  // for a generous bound. A schema-level branch-prefix index is the proper
  // long-term fix once the lane proves out.
  const allTasks = store.storage.listTasks(2000);
  const planRoots = allTasks
    .filter((t) => PLAN_ROOT_BRANCH_RE.test(t.branch))
    .filter((t) => !opts.repo_root || t.repo_root === opts.repo_root);

  const plans = planRoots
    .map((root): PlanInfo | null => {
      const slugMatch = root.branch.match(PLAN_ROOT_BRANCH_RE);
      if (!slugMatch) return null;
      const slug = slugMatch[1];
      if (!slug) return null;

      const subtaskTasks = allTasks.filter((t) => {
        const m = t.branch.match(SUBTASK_BRANCH_RE);
        return Boolean(m && m[1] === slug);
      });

      const subtasks = subtaskTasks
        .map((t) => readSubtask(store, t.id, slug))
        .filter((s): s is SubtaskInfo => s !== null)
        .sort((a, b) => a.subtask_index - b.subtask_index);

      // No sub-tasks found means this is a plain spec change, not a published
      // plan. Keep the two lanes separate.
      if (subtasks.length === 0) return null;

      const counts: Record<SubtaskStatus, number> = {
        available: 0,
        claimed: 0,
        completed: 0,
        blocked: 0,
      };
      for (const s of subtasks) counts[s.status]++;

      const nextAvailable = subtasks.filter(
        (s) => s.status === 'available' && areDepsMet(s, subtasks),
      );

      return {
        plan_slug: slug,
        repo_root: root.repo_root,
        spec_task_id: root.id,
        title: subtasks[0]?.parent_plan_title ?? slug,
        created_at: root.created_at,
        subtask_counts: counts,
        subtasks,
        next_available: nextAvailable,
      };
    })
    .filter((p): p is PlanInfo => p !== null);

  return plans
    .filter((p) => !opts.only_with_available_subtasks || p.next_available.length > 0)
    .filter(
      (p) =>
        !opts.capability_match ||
        p.next_available.some((s) => s.capability_hint === opts.capability_match),
    )
    .slice(0, limit);
}
