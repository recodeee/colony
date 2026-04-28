import { z } from 'zod';

import type { Goal, QueenPlan } from './types.js';

export type { Goal, QueenPlan, SubtaskDraft } from './types.js';

const GoalSchema: z.ZodType<Goal> = z.object({
  title: z.string().min(1),
  problem: z.string().min(1),
  acceptance_criteria: z.array(z.string()).min(1),
  repo_root: z.string().min(1),
});

export function planGoal(goal: Goal): QueenPlan {
  const parsedGoal = GoalSchema.parse(goal);

  return {
    slug: placeholderSlug(parsedGoal.title),
    title: parsedGoal.title,
    problem: parsedGoal.problem,
    acceptance_criteria: parsedGoal.acceptance_criteria,
    subtasks: [],
  };
}

function placeholderSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

  return `queen-plan-${slug || 'placeholder'}`;
}
