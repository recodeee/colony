import { describe, expect, it } from 'vitest';

import { type Goal, planGoal } from '../src/index.js';

const validGoal: Goal = {
  title: 'Plan queen package',
  problem: 'Create a deterministic queen planning skeleton.',
  acceptance_criteria: ['The package validates a goal before planning.'],
  repo_root: '/tmp/colony',
  affected_files: ['packages/core/src/plan.ts', 'packages/core/test/plan.test.ts'],
};

describe('planGoal', () => {
  it('returns a deterministic claimable plan', () => {
    expect(planGoal(validGoal)).toMatchObject({
      slug: 'plan-queen-package',
      title: validGoal.title,
      problem: validGoal.problem,
      acceptance_criteria: validGoal.acceptance_criteria,
      subtasks: [
        {
          title: 'Update shared infrastructure scope',
          file_scope: ['packages/core/src/plan.ts'],
          depends_on: [],
          capability_hint: 'infra_work',
        },
        {
          title: 'Add targeted tests',
          file_scope: ['packages/core/test/plan.test.ts'],
          depends_on: [0],
          capability_hint: 'test_work',
        },
      ],
    });
  });

  it('fills default acceptance criteria when none are supplied', () => {
    const plan = planGoal({
      ...validGoal,
      acceptance_criteria: [],
    });

    expect(plan.acceptance_criteria).toEqual([`Complete ${validGoal.title}`]);
  });

  it('can infer scopes without repo_root', () => {
    const plan = planGoal({
      title: 'Plan queen package',
      problem: 'Create a deterministic queen planning skeleton.',
      acceptance_criteria: ['The package validates a goal before planning.'],
    });

    expect(plan.subtasks.length).toBeGreaterThanOrEqual(2);
  });
});
