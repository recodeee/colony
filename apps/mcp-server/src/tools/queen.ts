import { type McpCapabilityMap, discoverMcpCapabilities } from '@colony/core';
import {
  type CapabilityHint,
  type Goal,
  type QueenPlan,
  type QueenSubtask,
  planGoal,
  publishOrderedPlan,
} from '@colony/queen';
import { PublishPlanError } from '@colony/spec';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { type ToolContext, defaultWrapHandler } from './context.js';
import { withPlanPublishGuidance } from './plan-output.js';
import { mcpError, mcpErrorResponse } from './shared.js';

interface QueenToolGoal extends Goal {
  affected_files?: string[];
}

interface NormalizedSubtask {
  title: string;
  description: string;
  file_scope: string[];
  depends_on: number[];
  capability_hint: CapabilityHint;
}

interface NormalizedQueenPlan {
  slug: string;
  title: string;
  problem: string;
  acceptance_criteria: string[];
  auto_archive: boolean;
  mcp_capability_map: McpCapabilityMap;
  subtasks: NormalizedSubtask[];
}

interface PublishedQueenPlan {
  plan_slug: string;
  spec_task_id: number;
  mcp_capability_map: McpCapabilityMap;
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
  ordering_hint: z.literal('wave').optional(),
  waves: z
    .array(
      z.object({
        name: z.string().optional(),
        subtask_refs: z.array(z.string()).optional(),
        titles: z.array(z.string()).optional(),
        rationale: z.string().optional(),
      }),
    )
    .optional(),
  finalizer: z.string().optional(),
  session_id: z.string().min(1),
  dry_run: z.boolean().optional(),
};

type QueenToolInput = {
  goal_title: string;
  problem: string;
  acceptance_criteria: string[];
  repo_root: string;
  affected_files?: string[] | undefined;
  ordering_hint?: 'wave' | undefined;
  waves?:
    | Array<{
        name?: string | undefined;
        subtask_refs?: string[] | undefined;
        titles?: string[] | undefined;
        rationale?: string | undefined;
      }>
    | undefined;
  finalizer?: string | undefined;
  session_id: string;
  dry_run?: boolean | undefined;
};

export function register(server: McpServer, ctx: ToolContext): void {
  const wrapHandler = ctx.wrapHandler ?? defaultWrapHandler;
  server.tool(
    'queen_plan_goal',
    [
      'Decompose a high-level goal into colony sub-tasks and publish them as a plan.',
      'Use this when you have a multi-step goal and want other agents to claim parts in parallel.',
      'Queen plans are published with auto_archive=true, and sub-tasks can be claimed through the task_plan_claim_subtask MCP tool.',
    ].join(' '),
    ToolInputSchema,
    wrapHandler('queen_plan_goal', async (args) => {
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
        if (err instanceof PublishPlanError) {
          return mcpErrorResponse(err.code, err.message);
        }
        return mcpError(err);
      }
    }),
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
    ...(args.ordering_hint !== undefined ? { ordering_hint: args.ordering_hint } : {}),
    ...(args.waves !== undefined ? { waves: args.waves } : {}),
    ...(args.finalizer !== undefined ? { finalizer: args.finalizer } : {}),
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
    mcp_capability_map: discoverMcpCapabilities(),
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
  store: ToolContext['store'];
  repo_root: string;
  session_id: string;
  plan: NormalizedQueenPlan;
}): PublishedQueenPlan {
  const result = publishOrderedPlan({
    store: args.store,
    repo_root: args.repo_root,
    session_id: args.session_id,
    agent: 'queen',
    auto_archive: args.plan.auto_archive,
    plan: args.plan,
  });
  return {
    ...withPlanPublishGuidance(result, args.plan.subtasks),
    mcp_capability_map: args.plan.mcp_capability_map,
  };
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

function normalizeCapabilityHint(hint: string): CapabilityHint {
  if (
    hint === 'ui_work' ||
    hint === 'api_work' ||
    hint === 'test_work' ||
    hint === 'infra_work' ||
    hint === 'doc_work'
  ) {
    return hint;
  }
  return 'infra_work';
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

function invalidGoalResponse(err: unknown): ReturnType<typeof mcpErrorResponse> | null {
  const fields = invalidGoalFields(err);
  if (fields.length === 0) return null;
  const validationErrors = orderingValidationErrors(err);
  return mcpErrorResponse(
    'QUEEN_INVALID_GOAL',
    err instanceof Error ? err.message : 'invalid queen goal',
    {
      fields,
      ...(validationErrors.length > 0 ? { validation_errors: validationErrors } : {}),
    },
  );
}

function orderingValidationErrors(err: unknown): string[] {
  if (typeof err !== 'object' || err === null) return [];
  const record = err as Record<string, unknown>;
  const errors = record.validation_errors ?? record.validationErrors;
  return Array.isArray(errors)
    ? errors.filter((entry): entry is string => typeof entry === 'string')
    : [];
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
