import type { ObservationRow, TaskRow } from '@colony/storage';
import type { MemoryStore } from './memory-store.js';
import { TaskThread } from './task-thread.js';

export type SubtaskStatus = 'available' | 'claimed' | 'completed' | 'blocked';

export interface SubtaskInfo {
  task_id: number;
  subtask_index: number;
  title: string;
  description: string;
  status: SubtaskStatus;
  claimed_at: number | null;
  file_scope: string[];
  depends_on: number[];
  wave_index: number;
  wave_name: string;
  blocked_by_count: number;
  blocked_by: number[];
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
  registry_status: 'registered' | 'subtask-only' | 'unpublished';
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

  const lifecycle = readSubtaskLifecycle(rows, meta);

  const [titleLine, ...rest] = initial.content.split('\n\n');
  const metaTitle = typeof meta.title === 'string' ? meta.title : null;
  const metaDescription = typeof meta.description === 'string' ? meta.description : null;
  const dependsOn = Array.isArray(meta.depends_on) ? (meta.depends_on as number[]) : [];

  return {
    task_id,
    subtask_index: typeof meta.subtask_index === 'number' ? meta.subtask_index : -1,
    title: metaTitle ?? titleLine ?? '(untitled)',
    description: metaDescription ?? rest.join('\n\n').trim(),
    status: lifecycle.status,
    claimed_at: lifecycle.claimed_at,
    file_scope: Array.isArray(meta.file_scope) ? (meta.file_scope as string[]) : [],
    depends_on: dependsOn,
    wave_index: 0,
    wave_name: 'Wave 1',
    blocked_by_count: lifecycle.status === 'completed' ? 0 : dependsOn.length,
    blocked_by: lifecycle.status === 'completed' ? [] : dependsOn,
    spec_row_id: typeof meta.spec_row_id === 'string' ? (meta.spec_row_id as string) : null,
    capability_hint:
      typeof meta.capability_hint === 'string' ? (meta.capability_hint as string) : null,
    claimed_by_session_id:
      lifecycle.status === 'claimed' && typeof lifecycle.metadata.session_id === 'string'
        ? (lifecycle.metadata.session_id as string)
        : null,
    claimed_by_agent:
      lifecycle.status === 'claimed' && typeof lifecycle.metadata.agent === 'string'
        ? (lifecycle.metadata.agent as string)
        : null,
    parent_plan_slug: plan_slug,
    parent_plan_title:
      typeof meta.parent_plan_title === 'string' ? (meta.parent_plan_title as string) : null,
    parent_spec_task_id:
      typeof meta.parent_spec_task_id === 'number' ? (meta.parent_spec_task_id as number) : null,
  };
}

function readSubtaskLifecycle(
  rows: ObservationRow[],
  initialMeta: Record<string, unknown>,
): { status: SubtaskStatus; claimed_at: number | null; metadata: Record<string, unknown> } {
  const initialStatus = isSubtaskStatus(initialMeta.status) ? initialMeta.status : 'available';
  const claimRows = rows
    .filter((r) => r.kind === 'plan-subtask-claim')
    .map((row) => ({ row, metadata: parseMeta(row.metadata) }))
    .filter((entry) => isSubtaskStatus(entry.metadata.status))
    .sort((a, b) => b.row.ts - a.row.ts || b.row.id - a.row.id);

  // Completion is terminal. `available` is still allowed as a later sweep
  // marker so stale claimed work can be re-queued without deleting history.
  const completed = claimRows.find((entry) => entry.metadata.status === 'completed');
  const resolved = completed ?? claimRows[0];
  const status = (resolved?.metadata.status as SubtaskStatus | undefined) ?? initialStatus;
  return {
    status,
    claimed_at: status === 'claimed' ? (resolved?.row.ts ?? null) : null,
    metadata: resolved?.metadata ?? {},
  };
}

function isSubtaskStatus(value: unknown): value is SubtaskStatus {
  return (
    value === 'available' || value === 'claimed' || value === 'completed' || value === 'blocked'
  );
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
  // Default trimmed from 50 → 10 after `colony gain` showed task_plan_list was
  // 95%+ of MCP token spend even with compact-default. Explicit callers can
  // still ask for up to 50 via the MCP schema's .max(50) ceiling
  // (apps/mcp-server/src/tools/plan.ts).
  const limit = opts.limit ?? 10;
  // listTasks default is 50; the plan registry may grow past that, so reach
  // for a generous bound. A schema-level branch-prefix index is the proper
  // long-term fix once the lane proves out.
  const allTasks = store.storage.listTasks(2000);
  const scopedTasks = allTasks.filter((t) => !opts.repo_root || t.repo_root === opts.repo_root);
  const planRoots = scopedTasks.filter((t) => PLAN_ROOT_BRANCH_RE.test(t.branch));
  const planRootsByKey = new Map<string, TaskRow>();
  for (const root of planRoots) {
    const slug = root.branch.match(PLAN_ROOT_BRANCH_RE)?.[1];
    if (slug) planRootsByKey.set(planKey(root.repo_root, slug), root);
  }

  const subtaskTasksByKey = new Map<string, TaskRow[]>();
  for (const task of scopedTasks) {
    const match = task.branch.match(SUBTASK_BRANCH_RE);
    const slug = match?.[1];
    if (!slug) continue;
    const key = planKey(task.repo_root, slug);
    const bucket = subtaskTasksByKey.get(key) ?? [];
    bucket.push(task);
    subtaskTasksByKey.set(key, bucket);
  }

  const plans = [...new Set([...planRootsByKey.keys(), ...subtaskTasksByKey.keys()])]
    .map((key): PlanInfo | null => {
      const [repoRoot, slug] = splitPlanKey(key);
      if (!slug) return null;
      const root = planRootsByKey.get(key) ?? null;

      const subtaskTasks = subtaskTasksByKey.get(key) ?? [];

      const subtasks = annotateWaveMetadata(
        subtaskTasks
          .map((t) => readSubtask(store, t.id, slug))
          .filter((s): s is SubtaskInfo => s !== null)
          .sort((a, b) => a.subtask_index - b.subtask_index),
      );

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
        repo_root: root?.repo_root ?? repoRoot,
        spec_task_id: root?.id ?? subtaskTasks[0]?.id ?? 0,
        registry_status: root ? 'registered' : 'subtask-only',
        title: subtasks[0]?.parent_plan_title ?? slug,
        created_at: root?.created_at ?? Math.min(...subtaskTasks.map((task) => task.created_at)),
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

function planKey(repoRoot: string, slug: string): string {
  return `${repoRoot}\0${slug}`;
}

function splitPlanKey(key: string): [string, string] {
  const [repoRoot, slug] = key.split('\0');
  return [repoRoot ?? '', slug ?? ''];
}

function annotateWaveMetadata(subtasks: SubtaskInfo[]): SubtaskInfo[] {
  const byIndex = new Map(subtasks.map((subtask) => [subtask.subtask_index, subtask]));
  const waveByIndex = new Map<number, number>();

  const resolveWave = (subtask: SubtaskInfo, visiting = new Set<number>()): number => {
    const cached = waveByIndex.get(subtask.subtask_index);
    if (cached !== undefined) return cached;
    if (visiting.has(subtask.subtask_index)) return 0;
    visiting.add(subtask.subtask_index);

    const wave =
      subtask.depends_on.length === 0
        ? 0
        : Math.max(
            ...subtask.depends_on.map((depIndex) => {
              const dep = byIndex.get(depIndex);
              return dep ? resolveWave(dep, visiting) + 1 : 1;
            }),
          );

    visiting.delete(subtask.subtask_index);
    waveByIndex.set(subtask.subtask_index, wave);
    return wave;
  };

  return subtasks.map((subtask) => {
    const waveIndex = resolveWave(subtask);
    const blockedBy =
      subtask.status === 'completed'
        ? []
        : subtask.depends_on.filter((depIndex) => byIndex.get(depIndex)?.status !== 'completed');
    return {
      ...subtask,
      wave_index: waveIndex,
      wave_name: `Wave ${waveIndex + 1}`,
      blocked_by_count: blockedBy.length,
      blocked_by: blockedBy,
    };
  });
}

/**
 * Auto-published plan synthesized from a foraging proposal that crossed
 * the promotion threshold. Two intentional differences from
 * `task_plan_publish`:
 *
 *   1. No `openspec/changes/<slug>/CHANGE.md` is written. The plan exists
 *      entirely in the observation timeline; humans can scaffold OpenSpec
 *      docs later if the auto-promoted plan proves out. This avoids
 *      filesystem side effects on a code path the foraging system fires
 *      autonomously.
 *
 *   2. `auto_archive` defaults to `false` so a human reviews the first
 *      wave of auto-published plans before silent state transitions
 *      occur on the final sub-task completion.
 *
 * Idempotency is the caller's job: `ProposalSystem.maybePromote` flips
 * `proposal.status` from `'pending'` to `'active'` BEFORE invoking this
 * function, so any subsequent reinforcement-driven promotion attempt for
 * the same proposal short-circuits at the status guard and never reaches
 * synthesis a second time.
 *
 * Empty `touches_files` returns early with `skipped_reason:
 * 'no_touches_files'`. The proposal's promoted TaskThread (a sibling on
 * `<branch>/proposal-<id>`) is unaffected — the lite plan is a bonus,
 * not a replacement.
 */
export interface SynthesizedPlan {
  plan_slug: string;
  parent_task_id: number | null;
  subtask_count: number;
  skipped_reason?: 'no_touches_files';
}

export interface ProposalForSynthesis {
  id: number;
  repo_root: string;
  summary: string;
  rationale: string;
  /** JSON-serialized string array, matching `proposals.touches_files`. */
  touches_files: string;
  proposed_by: string;
}

/**
 * Maximum sub-tasks per auto-promoted plan. Mirrors `task_plan_publish`'s
 * upper bound — keeps the lite path inside the same envelope as explicit
 * publishes so downstream UIs and the listPlans rollup don't need a
 * separate cap.
 */
const MAX_AUTO_SUBTASKS = 20;

export function synthesizePlanFromProposal(
  store: MemoryStore,
  proposal: ProposalForSynthesis,
  options?: { auto_archive?: boolean; promotion_threshold_label?: string },
): SynthesizedPlan {
  const planSlug = `proposal-${proposal.id}`;
  const parsedFiles = parseTouchesFilesArray(proposal.touches_files);

  if (parsedFiles.length === 0) {
    return {
      plan_slug: planSlug,
      parent_task_id: null,
      subtask_count: 0,
      skipped_reason: 'no_touches_files',
    };
  }

  // listPlans matches /^spec\/[a-z0-9-]+$/ on the parent — no further
  // path segments — so the synthesized root must live on `spec/<slug>`.
  const parentBranch = `spec/${planSlug}`;
  const parent = TaskThread.open(store, {
    repo_root: proposal.repo_root,
    branch: parentBranch,
    session_id: proposal.proposed_by,
    title: proposal.summary,
  });

  const autoArchive = options?.auto_archive ?? false;
  store.addObservation({
    session_id: proposal.proposed_by,
    task_id: parent.task_id,
    kind: 'plan-config',
    content: `auto-promoted plan ${planSlug} (auto_archive=${autoArchive})`,
    metadata: {
      plan_slug: planSlug,
      auto_archive: autoArchive,
      source: 'auto-promoted',
      promoted_from_proposal_id: proposal.id,
    },
  });

  // Naive partition: one sub-task per touched file, capped at
  // MAX_AUTO_SUBTASKS. Smarter partitioning (group by module, infer
  // capability_hint from path heuristics) is v2 work — this v1 keeps
  // the bridge mechanical so lifecycle behavior is the only variable.
  const groups = parsedFiles.slice(0, MAX_AUTO_SUBTASKS).map((file) => ({
    title: `Address ${file}`,
    description: `Auto-derived from proposal #${proposal.id}: ${proposal.summary}`,
    file_scope: [file],
  }));

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    if (!group) continue;
    const subBranch = `spec/${planSlug}/sub-${i}`;
    const sub = TaskThread.open(store, {
      repo_root: proposal.repo_root,
      branch: subBranch,
      session_id: proposal.proposed_by,
    });
    store.addObservation({
      session_id: proposal.proposed_by,
      task_id: sub.task_id,
      kind: 'plan-subtask',
      content: `${group.title}\n\n${group.description}`,
      metadata: {
        parent_plan_slug: planSlug,
        parent_plan_title: proposal.summary,
        parent_spec_task_id: parent.task_id,
        subtask_index: i,
        title: group.title,
        description: group.description,
        file_scope: group.file_scope,
        depends_on: [],
        spec_row_id: null,
        capability_hint: null,
        status: 'available',
      },
    });
  }

  // Co-stamp a `proposal-promoted` event observation on the parent so
  // the events feed (Plans page side panel) gets a distinct line:
  // "Proposal #847 colony-foraging-cleanup crossed strength 2.5 and
  //  auto-promoted to a plan with N sub-tasks."
  const thresholdLabel = options?.promotion_threshold_label ?? DEFAULT_PROMOTION_THRESHOLD_LABEL;
  store.addObservation({
    session_id: proposal.proposed_by,
    task_id: parent.task_id,
    kind: 'proposal-promoted',
    content:
      `Proposal #${proposal.id} ${proposal.summary} crossed strength ` +
      `${thresholdLabel} and auto-promoted to a plan with ` +
      `${groups.length} sub-task${groups.length === 1 ? '' : 's'}.`,
    metadata: {
      plan_slug: planSlug,
      source: 'auto-promoted',
      promoted_from_proposal_id: proposal.id,
      subtask_count: groups.length,
      proposal_summary: proposal.summary,
    },
  });

  return {
    plan_slug: planSlug,
    parent_task_id: parent.task_id,
    subtask_count: groups.length,
  };
}

const DEFAULT_PROMOTION_THRESHOLD_LABEL = '2.5';

function parseTouchesFilesArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
