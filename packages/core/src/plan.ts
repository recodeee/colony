import type { MemoryStore } from './memory-store.js';
import { TaskThread } from './task-thread.js';

export type SubtaskStatus = 'available' | 'claimed' | 'completed' | 'blocked';

export interface SubtaskInfo {
  task_id: number;
  subtask_index: number;
  title: string;
  description: string;
  status: SubtaskStatus;
  file_scope: string[];
  depends_on: number[];
  wave_index: number;
  wave_name: string;
  blocked_by_count: number;
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
  const dependsOn = Array.isArray(meta.depends_on) ? (meta.depends_on as number[]) : [];

  return {
    task_id,
    subtask_index: typeof meta.subtask_index === 'number' ? meta.subtask_index : -1,
    title: titleLine ?? '(untitled)',
    description: rest.join('\n\n').trim(),
    status,
    file_scope: Array.isArray(meta.file_scope) ? (meta.file_scope as string[]) : [],
    depends_on: dependsOn,
    wave_index: 0,
    wave_name: 'Wave 1',
    blocked_by_count: dependsOn.length,
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

function annotateWaveMetadata(subtasks: SubtaskInfo[]): SubtaskInfo[] {
  const byIndex = new Map(subtasks.map((subtask) => [subtask.subtask_index, subtask]));
  const waveByIndex = new Map<number, number>();

  const resolveWave = (subtask: SubtaskInfo): number => {
    const cached = waveByIndex.get(subtask.subtask_index);
    if (cached !== undefined) return cached;

    const dependencyWaves = subtask.depends_on
      .map((idx) => {
        const dependency = byIndex.get(idx);
        return dependency ? resolveWave(dependency) : null;
      })
      .filter((idx): idx is number => idx !== null);
    const waveIndex = dependencyWaves.length > 0 ? Math.max(...dependencyWaves) + 1 : 0;
    waveByIndex.set(subtask.subtask_index, waveIndex);
    return waveIndex;
  };

  return subtasks.map((subtask) => {
    const waveIndex = resolveWave(subtask);
    return {
      ...subtask,
      wave_index: waveIndex,
      wave_name: `Wave ${waveIndex + 1}`,
      blocked_by_count: subtask.depends_on.length,
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
  options?: { auto_archive?: boolean },
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
  store.addObservation({
    session_id: proposal.proposed_by,
    task_id: parent.task_id,
    kind: 'proposal-promoted',
    content:
      `Proposal #${proposal.id} ${proposal.summary} crossed strength ` +
      `${ProposalSystem_PROMOTION_THRESHOLD_LABEL} and auto-promoted to a plan with ` +
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

// Avoid a circular import (proposal-system → plan → proposal-system) by
// duplicating the threshold label as a string literal here. The numeric
// value lives in ProposalSystem.PROMOTION_THRESHOLD; keep this in sync.
const ProposalSystem_PROMOTION_THRESHOLD_LABEL = '2.5';

function parseTouchesFilesArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
