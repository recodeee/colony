import type { MemoryStore } from '@colony/core';
import {
  type PublishPlanInput,
  type PublishPlanResult,
  type PublishPlanSubtaskInput,
  publishPlan,
} from '@colony/spec';
import {
  type QueenOrderedPlan,
  type QueenOrderedPlanInput,
  type QueenPlan,
  orderedPlanFromWaves,
} from './decompose.js';

export type TaskPlanPublishInput = Omit<PublishPlanInput, 'store'>;
export type QueenPublishablePlan = QueenPlan | QueenOrderedPlanInput;

export interface OrderedPlanToTaskPlanInput {
  plan: QueenPublishablePlan;
  repo_root: string;
  session_id: string;
  agent: string;
  auto_archive?: boolean | undefined;
}

export interface PublishOrderedPlanInput extends OrderedPlanToTaskPlanInput {
  store: MemoryStore;
  published_by?: string | undefined;
}

export function orderedPlanToTaskPlanInput(args: OrderedPlanToTaskPlanInput): TaskPlanPublishInput {
  const plan = materializePlan(args.plan);
  const subtasks = plan.subtasks.map(taskPlanSubtask);
  if (subtasks.length < 2) {
    throw new Error('ordered queen plan needs at least two sub-tasks');
  }
  if (subtasks.length > 20) {
    throw new Error('ordered queen plan cannot publish more than 20 sub-tasks');
  }

  return {
    repo_root: args.repo_root,
    slug: plan.slug,
    session_id: args.session_id,
    agent: args.agent,
    title: plan.title,
    problem: plan.problem,
    acceptance_criteria: [...plan.acceptance_criteria],
    subtasks,
    ...(args.auto_archive !== undefined ? { auto_archive: args.auto_archive } : {}),
  };
}

export function publishOrderedPlan(args: PublishOrderedPlanInput): PublishPlanResult {
  const taskPlanInput = orderedPlanToTaskPlanInput(args);
  const result = publishPlan({ store: args.store, ...taskPlanInput });
  stampQueenPublisher(args.store, taskPlanInput, result, args.published_by ?? 'queen');
  return result;
}

function materializePlan(plan: QueenPublishablePlan): QueenPlan | QueenOrderedPlan {
  return 'subtasks' in plan ? plan : orderedPlanFromWaves(plan);
}

function taskPlanSubtask(subtask: QueenPlan['subtasks'][number]): PublishPlanSubtaskInput {
  return {
    title: subtask.title,
    description: subtask.description,
    file_scope: [...subtask.file_scope],
    depends_on: [...subtask.depends_on],
    capability_hint: subtask.capability_hint,
  };
}

function stampQueenPublisher(
  store: MemoryStore,
  input: TaskPlanPublishInput,
  result: PublishPlanResult,
  publishedBy: string,
): void {
  store.addObservation({
    session_id: input.session_id,
    task_id: result.spec_task_id,
    kind: 'plan-config',
    content: `queen plan ${input.slug} config: auto_archive=${input.auto_archive ?? false}`,
    metadata: {
      plan_slug: input.slug,
      auto_archive: input.auto_archive ?? false,
      source: 'queen',
      source_tool: 'publishOrderedPlan',
      published_by: publishedBy,
    },
  });
}
