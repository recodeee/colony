import { type MemoryStore, TaskThread } from '@colony/core';
import {
  type PlanValidationErrorCode,
  hasDependencyPath,
  validateOrderedPlan,
} from './plan-validation.js';
import {
  type PlanCapabilityHint,
  type PlanWorkspaceTaskInput,
  createPlanWorkspace,
} from './plan-workspace.js';
import { SpecRepository } from './repository.js';

export interface PublishPlanSubtaskInput {
  title: string;
  description: string;
  file_scope: string[];
  depends_on?: number[] | undefined;
  spec_row_id?: string | undefined;
  capability_hint?: PlanCapabilityHint | undefined;
}

export interface PublishPlanInput {
  store: MemoryStore;
  repo_root: string;
  slug: string;
  session_id: string;
  agent: string;
  title: string;
  problem: string;
  acceptance_criteria: string[];
  subtasks: PublishPlanSubtaskInput[];
  auto_archive?: boolean | undefined;
}

export interface PublishPlanResult {
  plan_slug: string;
  spec_task_id: number;
  spec_change_path: string;
  plan_workspace_path: string;
  subtasks: Array<{ subtask_index: number; branch: string; task_id: number; title: string }>;
}

export type PublishPlanErrorCode =
  | PlanValidationErrorCode
  | 'PLAN_INVALID_DEPENDENCY'
  | 'PLAN_SCOPE_OVERLAP';

export class PublishPlanError extends Error {
  readonly code: PublishPlanErrorCode;

  constructor(code: PublishPlanErrorCode, message: string) {
    super(message);
    this.name = 'PublishPlanError';
    this.code = code;
  }
}

export function publishPlan(args: PublishPlanInput): PublishPlanResult {
  const orderedPlanErrors = validateOrderedPlan(args.subtasks);
  const firstOrderedPlanError = orderedPlanErrors[0];
  if (firstOrderedPlanError !== undefined) {
    throw new PublishPlanError(firstOrderedPlanError.code, firstOrderedPlanError.message);
  }

  const overlap = detectScopeOverlap(args.subtasks);
  if (overlap) {
    throw new PublishPlanError(
      'PLAN_SCOPE_OVERLAP',
      `sub-tasks ${overlap.a} and ${overlap.b} share files [${overlap.shared.join(', ')}] without a depends_on edge between them`,
    );
  }

  const repo = new SpecRepository({ repoRoot: args.repo_root, store: args.store });
  const proposal = renderProposal(args);
  const opened = repo.openChange({
    slug: args.slug,
    session_id: args.session_id,
    agent: args.agent,
    proposal,
  });

  args.store.addObservation({
    session_id: args.session_id,
    task_id: opened.task_id,
    kind: 'plan-config',
    content: `plan ${args.slug} config: auto_archive=${args.auto_archive ?? false}`,
    metadata: {
      plan_slug: args.slug,
      openspec_change_path: opened.path,
      openspec_plan_slug: args.slug,
      openspec_task_id: null,
      auto_archive: args.auto_archive ?? false,
    },
  });

  const subtaskThreads = args.subtasks.map((subtask, index) => {
    const branch = `spec/${args.slug}/sub-${index}`;
    const thread = TaskThread.open(args.store, {
      repo_root: args.repo_root,
      branch,
      session_id: args.session_id,
    });
    args.store.addObservation({
      session_id: args.session_id,
      task_id: thread.task_id,
      kind: 'plan-subtask',
      content: `${subtask.title}\n\n${subtask.description}`,
      metadata: {
        parent_plan_slug: args.slug,
        parent_plan_title: args.title,
        parent_spec_task_id: opened.task_id,
        subtask_index: index,
        title: subtask.title,
        description: subtask.description,
        file_scope: subtask.file_scope,
        depends_on: subtask.depends_on ?? [],
        spec_row_id: subtask.spec_row_id ?? null,
        openspec_change_path: opened.path,
        openspec_plan_slug: args.slug,
        openspec_task_id: subtask.spec_row_id ?? null,
        capability_hint: subtask.capability_hint ?? null,
        status: 'available',
      },
    });
    return {
      subtask_index: index,
      branch,
      task_id: thread.task_id,
      title: subtask.title,
    };
  });

  const workspace = createPlanWorkspace({
    repoRoot: args.repo_root,
    slug: args.slug,
    title: args.title,
    problem: args.problem,
    acceptanceCriteria: args.acceptance_criteria,
    tasks: args.subtasks.map(planWorkspaceTaskFromPublishInput),
    force: true,
    published: {
      spec_task_id: opened.task_id,
      spec_change_path: opened.path,
      auto_archive: args.auto_archive ?? false,
    },
  });

  return {
    plan_slug: args.slug,
    spec_task_id: opened.task_id,
    spec_change_path: opened.path,
    plan_workspace_path: workspace.dir,
    subtasks: subtaskThreads,
  };
}

function planWorkspaceTaskFromPublishInput(task: PublishPlanSubtaskInput): PlanWorkspaceTaskInput {
  return {
    title: task.title,
    description: task.description,
    file_scope: task.file_scope,
    depends_on: task.depends_on ?? [],
    spec_row_id: task.spec_row_id ?? null,
    capability_hint: task.capability_hint ?? null,
  };
}

function detectScopeOverlap(
  subtasks: PublishPlanSubtaskInput[],
): { a: number; b: number; shared: string[] } | null {
  for (let i = 0; i < subtasks.length; i++) {
    for (let j = i + 1; j < subtasks.length; j++) {
      const a = subtasks[i];
      const b = subtasks[j];
      if (!a || !b) continue;
      if (hasDependencyPath(subtasks, i, j) || hasDependencyPath(subtasks, j, i)) continue;
      const shared = a.file_scope.filter((f) => b.file_scope.includes(f));
      if (shared.length > 0) return { a: i, b: j, shared };
    }
  }
  return null;
}

function renderProposal(args: {
  title: string;
  problem: string;
  acceptance_criteria: string[];
  subtasks: PublishPlanSubtaskInput[];
}): string {
  const subtaskBlocks = args.subtasks
    .map((s, i) => {
      const deps = s.depends_on?.length ? ` (depends on: ${s.depends_on.join(', ')})` : '';
      return `### Sub-task ${i}: ${s.title}${deps}\n\n${s.description}\n\nFile scope: ${s.file_scope.join(', ')}`;
    })
    .join('\n\n');
  const criteria = args.acceptance_criteria.map((c) => `- ${c}`).join('\n');
  return `# ${args.title}\n\n## Problem\n\n${args.problem}\n\n## Acceptance criteria\n\n${criteria}\n\n## Sub-tasks\n\n${subtaskBlocks}\n`;
}
