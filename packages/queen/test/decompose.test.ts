import { describe, expect, it } from 'vitest';
import { type QueenPlan, planGoal, slugFromTitle } from '../src/decompose.js';

interface Overlap {
  a: number;
  b: number;
  shared: string[];
}

function pairwiseScopeOverlap(plan: QueenPlan): Overlap[] {
  const overlaps: Overlap[] = [];
  for (let i = 0; i < plan.subtasks.length; i++) {
    for (let j = i + 1; j < plan.subtasks.length; j++) {
      if (hasDependencyPath(plan, i, j) || hasDependencyPath(plan, j, i)) continue;
      const left = plan.subtasks[i]?.file_scope ?? [];
      const right = new Set(plan.subtasks[j]?.file_scope ?? []);
      const shared = [...new Set(left.filter((file) => right.has(file)))];
      if (shared.length > 0) overlaps.push({ a: i, b: j, shared });
    }
  }
  return overlaps;
}

function hasDependencyPath(plan: QueenPlan, from: number, to: number): boolean {
  const stack = [from];
  const seen = new Set<number>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    const deps = plan.subtasks[current]?.depends_on ?? [];
    if (deps.includes(to)) return true;
    stack.push(...deps);
  }
  return false;
}

function expectValidPlan(plan: QueenPlan): void {
  expect(plan.subtasks.length).toBeGreaterThanOrEqual(2);
  expect(plan.subtasks.length).toBeLessThanOrEqual(7);
  for (let i = 0; i < plan.subtasks.length; i++) {
    const subtask = plan.subtasks[i];
    expect(subtask?.file_scope.length).toBeGreaterThan(0);
    for (const dep of subtask?.depends_on ?? []) expect(dep).toBeLessThan(i);
  }
  expect(pairwiseScopeOverlap(plan)).toEqual([]);
}

describe('planGoal', () => {
  it('splits frontend-only work into web and dependent verification tasks', () => {
    const plan = planGoal({
      title: 'Polish project dashboard',
      affected_files: ['apps/web/src/projects/ProjectDashboard.tsx'],
    });

    expectValidPlan(plan);
    expect(plan.subtasks.map((subtask) => subtask.capability_hint)).toEqual(['ui_work', 'ui_work']);
  });

  it('splits full-stack work into storage, API, web, and tests without independent overlap', () => {
    const plan = planGoal({
      title: 'Add user profiles',
      affected_files: [
        'packages/storage/src/profile.ts',
        'apps/api/src/profile.ts',
        'apps/web/src/profile/ProfilePage.tsx',
        'apps/api/test/profile.test.ts',
      ],
    });

    expectValidPlan(plan);
    expect(plan.subtasks[0]).toMatchObject({
      capability_hint: 'infra_work',
      depends_on: [],
      file_scope: ['packages/storage/src/profile.ts'],
    });
    expect(plan.subtasks.find((subtask) => subtask.title === 'Implement API scope')).toMatchObject({
      capability_hint: 'api_work',
      depends_on: [0],
    });
    expect(plan.subtasks.find((subtask) => subtask.title === 'Implement web scope')).toMatchObject({
      capability_hint: 'ui_work',
      depends_on: [0],
    });
    expect(plan.subtasks.at(-1)).toMatchObject({
      title: 'Add targeted tests',
      capability_hint: 'test_work',
    });
  });

  it('orders storage-heavy changes before non-storage package work', () => {
    const plan = planGoal({
      title: 'Rebuild claim persistence',
      affected_files: [
        'packages/storage/src/claims.ts',
        'packages/core/src/claim-graph.ts',
        'packages/core/test/claim-graph.test.ts',
      ],
    });

    expectValidPlan(plan);
    expect(plan.subtasks[0]?.file_scope).toEqual(['packages/storage/src/claims.ts']);
    expect(plan.subtasks.slice(1).every((subtask) => subtask.depends_on.includes(0))).toBe(true);
  });

  it('keeps docs/README work as a final doc_work sub-task', () => {
    const plan = planGoal({
      title: 'Document queen planning',
      affected_files: ['docs/README.md'],
    });

    expectValidPlan(plan);
    expect(plan.subtasks.at(-1)).toMatchObject({
      title: 'Update README documentation',
      capability_hint: 'doc_work',
      file_scope: ['docs/README.md'],
      depends_on: [0],
    });
  });

  it('handles mixed storage, app, infra, tests, and README changes', () => {
    const plan = planGoal({
      title: 'Add task review workflow',
      affected_files: [
        'packages/storage/src/reviews.ts',
        'apps/api/src/reviews.ts',
        'apps/web/src/reviews/ReviewPanel.tsx',
        'packages/process/src/review-runner.ts',
        'apps/api/test/reviews.test.ts',
        'docs/README.md',
      ],
    });

    expectValidPlan(plan);
    expect(plan.subtasks).toHaveLength(6);
    expect(plan.subtasks[0]?.title).toBe('Prepare storage scope');
    expect(plan.subtasks.at(-2)?.title).toBe('Add targeted tests');
    expect(plan.subtasks.at(-1)?.title).toBe('Update README documentation');
    expect(plan.subtasks.at(-1)?.depends_on).toEqual([0, 1, 2, 3, 4]);
  });

  it('keeps API implementation before API tests', () => {
    const plan = planGoal({
      title: 'Expose session search endpoint',
      affected_files: ['apps/api/src/session-search.ts', 'apps/api/test/session-search.test.ts'],
    });

    expectValidPlan(plan);
    expect(plan.subtasks.map((subtask) => subtask.capability_hint)).toEqual([
      'api_work',
      'test_work',
    ]);
    expect(plan.subtasks[1]?.depends_on).toEqual([0]);
  });

  it('creates a bounded infra plan for shared package changes', () => {
    const plan = planGoal({
      title: 'Tune process watchdog',
      affected_files: ['packages/process/src/watchdog.ts'],
    });

    expectValidPlan(plan);
    expect(plan.subtasks).toHaveLength(2);
    expect(plan.subtasks.every((subtask) => subtask.capability_hint === 'infra_work')).toBe(true);
  });

  it('infers sensible auth scopes when affected files are omitted', () => {
    const plan = planGoal({
      title: 'Add user authentication',
      problem: 'Let users log in and keep sessions across the app.',
    });

    expectValidPlan(plan);
    expect(plan.subtasks.map((subtask) => subtask.title)).toEqual([
      'Prepare storage scope',
      'Implement API scope',
      'Implement web scope',
      'Add targeted tests',
    ]);
    expect(plan.subtasks.map((subtask) => subtask.capability_hint)).toEqual([
      'infra_work',
      'api_work',
      'ui_work',
      'test_work',
    ]);
  });
});

describe('slugFromTitle', () => {
  it('generates kebab-case slugs capped at 40 characters', () => {
    expect(slugFromTitle('Árvíztűrő User Authentication Flow With Extra Words')).toBe(
      'arvizturo-user-authentication-flow-with',
    );
  });
});
