import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { MemoryStore, listPlans } from '@colony/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type QueenOrderedPlanInput,
  orderedPlanToTaskPlanInput,
  publishOrderedPlan,
} from '../src/index.js';

const orderedPlan: QueenOrderedPlanInput = {
  slug: 'queen-discoverability-product-docs',
  title: 'Queen discoverability product docs',
  problem:
    'Agents need ordered Queen work to unlock by wave without hand-written task_plan payloads.',
  acceptance_criteria: [
    'Discoverability work is claimable first',
    'Product work unlocks after discoverability',
    'Docs unlock after product behavior is durable',
  ],
  waves: [
    {
      id: 'discoverability',
      title: 'Discoverability',
      subtasks: [
        {
          title: 'Expose ordered plan status',
          description: 'Show ordered Queen plans in the local CLI list surface.',
          file_scope: ['apps/cli/src/commands/queen.ts'],
          capability_hint: 'infra_work',
        },
        {
          title: 'Rank ordered ready work',
          description: 'Make ready work discoverable through the MCP ready queue.',
          file_scope: ['apps/mcp-server/src/tools/ready-queue.ts'],
          capability_hint: 'api_work',
        },
      ],
    },
    {
      id: 'product',
      title: 'Product',
      subtasks: [
        {
          title: 'Publish ordered plan helper',
          description: 'Convert Queen waves into durable task_plan sub-tasks.',
          file_scope: ['packages/queen/src/ordered-plan.ts'],
          capability_hint: 'api_work',
        },
      ],
    },
    {
      id: 'docs',
      title: 'Docs',
      subtasks: [
        {
          title: 'Document ordered Queen plans',
          description: 'Explain ordered waves and claim flow in Queen docs.',
          file_scope: ['docs/QUEEN.md'],
          capability_hint: 'doc_work',
        },
      ],
    },
  ],
};

const MINIMAL_SPEC = `# SPEC

## §G  goal
Test fixture spec for ordered Queen plan publication tests.

## §C  constraints
- markdown only.

## §I  interfaces
- none

## §V  invariants
id|rule|cites
-|-|-
V1|placeholder|-

## §T  tasks
id|status|task|cites
-|-|-|-
T1|todo|placeholder|V1

## §B  bugs
id|bug|cites
-|-|-
`;

let dataDir: string;
let repoRoot: string;
let store: MemoryStore;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'colony-queen-ordered-data-'));
  repoRoot = mkdtempSync(join(tmpdir(), 'colony-queen-ordered-repo-'));
  writeFileSync(join(repoRoot, 'SPEC.md'), MINIMAL_SPEC, 'utf8');
  store = new MemoryStore({ dbPath: join(dataDir, 'data.db'), settings: defaultSettings });
  store.startSession({ id: 'queen-session', ide: 'queen', cwd: repoRoot });
});

afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(repoRoot, { recursive: true, force: true });
});

describe('orderedPlanToTaskPlanInput', () => {
  it('converts discoverability, product, and docs waves into task_plan dependencies', () => {
    const input = orderedPlanToTaskPlanInput({
      plan: orderedPlan,
      repo_root: repoRoot,
      session_id: 'queen-session',
      agent: 'queen',
      auto_archive: true,
    });

    expect(input).toMatchObject({
      repo_root: repoRoot,
      slug: orderedPlan.slug,
      session_id: 'queen-session',
      agent: 'queen',
      title: orderedPlan.title,
      problem: orderedPlan.problem,
      acceptance_criteria: orderedPlan.acceptance_criteria,
      auto_archive: true,
    });
    expect(input.subtasks).toEqual([
      {
        title: 'Expose ordered plan status',
        description: 'Show ordered Queen plans in the local CLI list surface.',
        file_scope: ['apps/cli/src/commands/queen.ts'],
        depends_on: [],
        capability_hint: 'infra_work',
      },
      {
        title: 'Rank ordered ready work',
        description: 'Make ready work discoverable through the MCP ready queue.',
        file_scope: ['apps/mcp-server/src/tools/ready-queue.ts'],
        depends_on: [],
        capability_hint: 'api_work',
      },
      {
        title: 'Publish ordered plan helper',
        description: 'Convert Queen waves into durable task_plan sub-tasks.',
        file_scope: ['packages/queen/src/ordered-plan.ts'],
        depends_on: [0, 1],
        capability_hint: 'api_work',
      },
      {
        title: 'Document ordered Queen plans',
        description: 'Explain ordered waves and claim flow in Queen docs.',
        file_scope: ['docs/QUEEN.md'],
        depends_on: [2],
        capability_hint: 'doc_work',
      },
    ]);
  });
});

describe('publishOrderedPlan', () => {
  it('publishes ordered Queen waves through the durable task_plan substrate', () => {
    const result = publishOrderedPlan({
      store,
      plan: orderedPlan,
      repo_root: repoRoot,
      session_id: 'queen-session',
      agent: 'queen',
      auto_archive: true,
    });

    expect(result.plan_slug).toBe(orderedPlan.slug);
    expect(result.subtasks).toHaveLength(4);
    expect(existsSync(result.spec_change_path)).toBe(true);
    expect(readFileSync(result.spec_change_path, 'utf8')).toContain(
      'Queen discoverability product docs',
    );

    const [listed] = listPlans(store, { repo_root: repoRoot });
    expect(listed?.plan_slug).toBe(orderedPlan.slug);
    expect(listed?.next_available.map((subtask) => subtask.title)).toEqual([
      'Expose ordered plan status',
      'Rank ordered ready work',
    ]);
    expect(listed?.subtasks.map((subtask) => subtask.depends_on)).toEqual([[], [], [0, 1], [2]]);

    const configRows = store.storage.taskObservationsByKind(result.spec_task_id, 'plan-config', 5);
    expect(configRows.some((row) => row.metadata?.includes('publishOrderedPlan'))).toBe(true);
  });
});
