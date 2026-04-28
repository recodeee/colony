import { TaskThread } from '@colony/core';
import type { MemoryStore } from '@colony/core';
import { type Goal, type QueenPlan, type QueenSubtask, planGoal } from '@colony/queen';
import { SpecRepository } from '@colony/spec';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from './context.js';

type CapabilityHint = 'ui_work' | 'api_work' | 'test_work' | 'infra_work' | 'doc_work';

interface QueenToolGoal extends Goal {
  affected_files?: string[];
}

interface NormalizedSubtask {
  title: string;
  description: string;
  file_scope: string[];
  depends_on: number[];
  capability_hint: CapabilityHint | null;
}

interface NormalizedQueenPlan {
  slug: string;
  title: string;
  problem: string;
  acceptance_criteria: string[];
  auto_archive: true;
  subtasks: NormalizedSubtask[];
}

interface PublishedQueenPlan {
  plan_slug: string;
  spec_task_id: number;
  subtasks: Array<{ subtask_index: number; branch: string; task_id: number; title: string }>;
}

class QueenInvalidGoalError extends Error {
  readonly fields: string[];

  constructor(fields: string[]) {
    super(`invalid queen goal fields: ${fields.join(', ')}`);
    this.name = 'QueenInvalidGoalError';
    this.fields = fields;
  }
}

const ToolInputSchema = {
  goal_title: z.string(),
  problem: z.string(),
  acceptance_criteria: z.array(z.string()),
  repo_root: z.string(),
  affected_files: z.array(z.string()).optional(),
  session_id: z.string().min(1),
  dry_run: z.boolean().optional(),
};

type QueenToolInput = {
  goal_title: string;
  problem: string;
  acceptance_criteria: string[];
  repo_root: string;
  affected_files?: string[] | undefined;
  session_id: string;
  dry_run?: boolean | undefined;
};

export function register(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'queen_plan_goal',
    [
      'Decompose a high-level goal into colony sub-tasks and publish them as a plan.',
      'Use this when you have a multi-step goal and want other agents to claim parts in parallel.',
      'Queen plans are published with auto_archive=true, and sub-tasks can be claimed through the task_plan_claim_subtask MCP tool.',
    ].join(' '),
    ToolInputSchema,
    async (args) => {
      try {
        const plan = planGoalForTool(args);
        if (args.dry_run === true) {
          return jsonReply(plan);
        }
        return jsonReply(
          publishPlan({
            store: ctx.store,
            repo_root: args.repo_root,
            session_id: args.session_id,
            plan,
          }),
        );
      } catch (err) {
        const invalidGoal = invalidGoalResponse(err);
        if (invalidGoal) return invalidGoal;
        throw err;
      }
    },
  );
}

function planGoalForTool(args: QueenToolInput): NormalizedQueenPlan {
  validateGoalInput(args);
  const goal: QueenToolGoal = {
    title: args.goal_title,
    problem: args.problem,
    acceptance_criteria: args.acceptance_criteria,
    repo_root: args.repo_root,
    ...(args.affected_files !== undefined ? { affected_files: args.affected_files } : {}),
  };
  const plan = planGoal(goal);
  return normalizePlan(plan, args);
}

function validateGoalInput(args: QueenToolInput): void {
  const fields: string[] = [];
  if (args.goal_title.trim().length === 0) fields.push('goal_title');
  if (args.problem.trim().length === 0) fields.push('problem');
  if (args.repo_root.trim().length === 0) fields.push('repo_root');
  if (
    args.acceptance_criteria.length === 0 ||
    args.acceptance_criteria.some((criterion) => criterion.trim().length === 0)
  ) {
    fields.push('acceptance_criteria');
  }
  if (args.affected_files?.some((file) => file.trim().length === 0)) {
    fields.push('affected_files');
  }
  if (fields.length > 0) throw new QueenInvalidGoalError([...new Set(fields)]);
}

function normalizePlan(plan: QueenPlan, args: QueenToolInput): NormalizedQueenPlan {
  const normalizedSubtasks =
    plan.subtasks.length > 0
      ? plan.subtasks.map((subtask, index) => normalizeSubtask(subtask, index, plan.subtasks))
      : fallbackSubtasks(args);

  return {
    slug: plan.slug,
    title: plan.title,
    problem: plan.problem,
    acceptance_criteria: plan.acceptance_criteria,
    auto_archive: true,
    subtasks: normalizedSubtasks,
  };
}

function normalizeSubtask(
  subtask: QueenSubtask,
  index: number,
  allSubtasks: QueenSubtask[],
): NormalizedSubtask {
  return {
    title: nonEmpty(subtask.title, `Sub-task ${index}`),
    description: nonEmpty(subtask.description, `Execute sub-task ${index}.`),
    file_scope: nonEmptyArray(subtask.file_scope, ['.']),
    depends_on: normalizeDependsOn(subtask.depends_on, allSubtasks),
    capability_hint: normalizeCapabilityHint(subtask.capability_hint),
  };
}

function fallbackSubtasks(args: QueenToolInput): NormalizedSubtask[] {
  const files = nonEmptyArray(args.affected_files ?? [], ['.']);
  if (files.length >= 2) {
    return files.slice(0, 20).map((file) => ({
      title: `Handle ${file}`,
      description: `Implement the goal "${args.goal_title}" for ${file}.`,
      file_scope: [file],
      depends_on: [],
      capability_hint: inferCapabilityHint(file),
    }));
  }

  return [
    {
      title: `Implement ${args.goal_title}`,
      description: args.problem,
      file_scope: files,
      depends_on: [],
      capability_hint: inferCapabilityHint(files[0] ?? '.'),
    },
    {
      title: `Verify ${args.goal_title}`,
      description: `Verify the implementation against acceptance criteria: ${args.acceptance_criteria.join('; ')}.`,
      file_scope: files,
      depends_on: [0],
      capability_hint: 'test_work',
    },
  ];
}

function publishPlan(args: {
  store: MemoryStore;
  repo_root: string;
  session_id: string;
  plan: NormalizedQueenPlan;
}): PublishedQueenPlan {
  validateDependencies(args.plan.subtasks);
  const overlap = detectScopeOverlap(args.plan.subtasks);
  if (overlap) {
    throw new Error(
      `queen plan has overlapping independent sub-tasks ${overlap.a} and ${overlap.b}: ${overlap.shared.join(', ')}`,
    );
  }

  const repo = new SpecRepository({ repoRoot: args.repo_root, store: args.store });
  const opened = repo.openChange({
    slug: args.plan.slug,
    session_id: args.session_id,
    agent: 'queen',
    proposal: renderProposal(args.plan),
  });

  args.store.addObservation({
    session_id: args.session_id,
    task_id: opened.task_id,
    kind: 'plan-config',
    content: `queen plan ${args.plan.slug} config: auto_archive=true`,
    metadata: {
      plan_slug: args.plan.slug,
      auto_archive: true,
      source: 'queen',
    },
  });

  const subtasks = args.plan.subtasks.map((subtask, index) => {
    const branch = `spec/${args.plan.slug}/sub-${index}`;
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
        parent_plan_slug: args.plan.slug,
        parent_plan_title: args.plan.title,
        parent_spec_task_id: opened.task_id,
        subtask_index: index,
        file_scope: subtask.file_scope,
        depends_on: subtask.depends_on,
        spec_row_id: null,
        capability_hint: subtask.capability_hint,
        status: 'available',
        created_by: 'queen',
      },
    });
    return {
      subtask_index: index,
      branch,
      task_id: thread.task_id,
      title: subtask.title,
    };
  });

  return {
    plan_slug: args.plan.slug,
    spec_task_id: opened.task_id,
    subtasks,
  };
}

function validateDependencies(subtasks: NormalizedSubtask[]): void {
  for (let i = 0; i < subtasks.length; i++) {
    for (const dep of subtasks[i]?.depends_on ?? []) {
      if (dep >= i) {
        throw new Error(
          `queen sub-task ${i} depends on ${dep}; dependencies must point to earlier indices`,
        );
      }
    }
  }
}

function detectScopeOverlap(
  subtasks: NormalizedSubtask[],
): { a: number; b: number; shared: string[] } | null {
  for (let i = 0; i < subtasks.length; i++) {
    for (let j = i + 1; j < subtasks.length; j++) {
      const a = subtasks[i];
      const b = subtasks[j];
      if (!a || !b) continue;
      if (isDependentChain(subtasks, i, j) || isDependentChain(subtasks, j, i)) continue;
      const shared = a.file_scope.filter((file) => b.file_scope.includes(file));
      if (shared.length > 0) return { a: i, b: j, shared };
    }
  }
  return null;
}

function isDependentChain(subtasks: NormalizedSubtask[], from: number, to: number): boolean {
  const visited = new Set<number>();
  const stack = [from];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === undefined || visited.has(cur)) continue;
    visited.add(cur);
    const deps = subtasks[cur]?.depends_on ?? [];
    if (deps.includes(to)) return true;
    stack.push(...deps);
  }
  return false;
}

function renderProposal(plan: NormalizedQueenPlan): string {
  const criteria = plan.acceptance_criteria.map((criterion) => `- ${criterion}`).join('\n');
  const subtasks = plan.subtasks
    .map((subtask, index) => {
      const deps =
        subtask.depends_on.length > 0 ? ` (depends on: ${subtask.depends_on.join(', ')})` : '';
      return `### Sub-task ${index}: ${subtask.title}${deps}\n\n${subtask.description}\n\nFile scope: ${subtask.file_scope.join(', ')}`;
    })
    .join('\n\n');
  return `# ${plan.title}\n\n## Problem\n\n${plan.problem}\n\n## Acceptance criteria\n\n${criteria}\n\n## Sub-tasks\n\n${subtasks}\n`;
}

function normalizeDependsOn(dependsOn: Array<number | string>, subtasks: QueenSubtask[]): number[] {
  const titles = subtasks.map((subtask) => subtask.title.toLowerCase());
  return dependsOn
    .map((dep) => {
      if (typeof dep === 'number') return Number.isInteger(dep) && dep >= 0 ? dep : null;
      const numeric = Number(dep);
      if (Number.isInteger(numeric) && numeric >= 0) return numeric;
      const byTitle = titles.indexOf(dep.toLowerCase());
      return byTitle >= 0 ? byTitle : null;
    })
    .filter((dep): dep is number => dep !== null);
}

function normalizeCapabilityHint(hint: string): CapabilityHint | null {
  if (
    hint === 'ui_work' ||
    hint === 'api_work' ||
    hint === 'test_work' ||
    hint === 'infra_work' ||
    hint === 'doc_work'
  ) {
    return hint;
  }
  return null;
}

function inferCapabilityHint(file: string): CapabilityHint {
  if (/\.(md|mdx|txt)$/i.test(file) || file.includes('/docs/')) return 'doc_work';
  if (/(\.test\.|\.spec\.|\/test\/|\/tests\/)/i.test(file)) return 'test_work';
  if (/(\.tsx?|\.jsx?|\/api\/|\/server\/)/i.test(file)) return 'api_work';
  if (/(\.css|\.scss|\.tsx|\/ui\/|\/pages\/|\/components\/)/i.test(file)) return 'ui_work';
  return 'infra_work';
}

function nonEmpty(value: string, fallback: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function nonEmptyArray(values: string[], fallback: string[]): string[] {
  const filtered = values.map((value) => value.trim()).filter((value) => value.length > 0);
  return filtered.length > 0 ? filtered : fallback;
}

function invalidGoalResponse(err: unknown): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} | null {
  const fields = invalidGoalFields(err);
  if (fields.length === 0) return null;
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          code: 'QUEEN_INVALID_GOAL',
          error: err instanceof Error ? err.message : 'invalid queen goal',
          fields,
        }),
      },
    ],
    isError: true,
  };
}

function invalidGoalFields(err: unknown): string[] {
  if (err instanceof QueenInvalidGoalError) return err.fields;
  if (err instanceof z.ZodError) {
    return [...new Set(err.issues.map((issue) => goalFieldName(String(issue.path[0] ?? 'goal'))))];
  }
  if (typeof err === 'object' && err !== null) {
    const record = err as Record<string, unknown>;
    const fields = record.fields ?? record.invalid_fields ?? record.invalidFields;
    if (Array.isArray(fields)) {
      return fields
        .filter((field): field is string => typeof field === 'string')
        .map(goalFieldName);
    }
  }
  return [];
}

function goalFieldName(field: string): string {
  if (field === 'title') return 'goal_title';
  return field;
}

function jsonReply(payload: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}
