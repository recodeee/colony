import { describe, expect, it } from 'vitest';

import { type Goal, planGoal } from '../src/index.js';

const validGoal: Goal = {
  title: 'Plan queen package',
  problem: 'Create a deterministic queen planning skeleton.',
  acceptance_criteria: ['The package validates a goal before planning.'],
  repo_root: '/tmp/colony',
};

describe('planGoal', () => {
  it('returns a deterministic empty-subtask placeholder plan', () => {
    expect(planGoal(validGoal)).toEqual({
      slug: 'queen-plan-plan-queen-package',
      title: validGoal.title,
      problem: validGoal.problem,
      acceptance_criteria: validGoal.acceptance_criteria,
      subtasks: [],
    });
  });

  it('rejects empty acceptance criteria', () => {
    expect(() =>
      planGoal({
        ...validGoal,
        acceptance_criteria: [],
      }),
    ).toThrow(/acceptance_criteria/);
  });

  it('requires repo_root', () => {
    expect(() =>
      planGoal({
        title: validGoal.title,
        problem: validGoal.problem,
        acceptance_criteria: validGoal.acceptance_criteria,
      } as Goal),
    ).toThrow(/repo_root/);
  });
});
