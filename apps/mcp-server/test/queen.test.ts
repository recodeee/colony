import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { MemoryStore, type WorktreeContentionReport } from '@colony/core';
import { type CapabilityHint, orderedPlanFromWaves, sweepQueenPlans } from '@colony/queen';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';

let dataDir: string;
let repoRoot: string;
let store: MemoryStore;
let client: Client;

interface QueenPlanPreview {
  slug: string;
  title: string;
  problem: string;
  acceptance_criteria: string[];
  auto_archive: true;
  mcp_capability_map: { summary: string[]; unknown_servers: string[] };
  subtasks: Array<{
    title: string;
    description: string;
    file_scope: string[];
    depends_on: number[];
    capability_hint: CapabilityHint;
  }>;
}

interface QueenPublishResult {
  plan_slug: string;
  spec_task_id: number;
  mcp_capability_map: { summary: string[]; unknown_servers: string[] };
  subtasks: Array<{ subtask_index: number; branch: string; task_id: number; title: string }>;
  waves: Array<{ wave_index: number; name: string; subtask_indexes: number[] }>;
  claim_instructions: Array<{
    subtask_index: number;
    tool: string;
    arguments: {
      plan_slug: string;
      subtask_index: number;
      session_id: string;
      agent: string;
    };
  }>;
  plan_validation: {
    blocking: boolean;
    finding_count: number;
    counts: { error: number; warning: number; info: number };
  };
}

interface PlanRollup {
  plan_slug: string;
  next_available: Array<{ subtask_index: number }>;
  subtasks: Array<{ subtask_index: number; status: string; claimed_by_session_id: string | null }>;
}

interface ReadyQueueResult {
  ready: Array<{ plan_slug: string; subtask_index: number }>;
  total_available: number;
}

interface ClaimResult {
  task_id: number;
  branch: string;
  file_scope: string[];
}

interface CompleteResult {
  status: string;
  auto_archive: { status: string; reason?: string };
}

const FORBIDDEN_COMMAND_FIELDS = [
  'assigned_agent',
  'launch_agent',
  'monitor_shell',
  'monitor_shells',
  'run_now',
  'shell_monitor',
  'shell_monitoring',
] as const;

async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}';
  return JSON.parse(text) as T;
}

async function callError(
  name: string,
  args: Record<string, unknown>,
): Promise<{ code: string; error: string; fields: string[]; validation_errors?: string[] }> {
  const res = await client.callTool({ name, arguments: args });
  expect(res.isError).toBe(true);
  const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}';
  return JSON.parse(text) as {
    code: string;
    error: string;
    fields: string[];
    validation_errors?: string[];
  };
}

function queenArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    goal_title: 'Build queen MCP surface',
    problem: 'Lead agents need one call that decomposes and publishes work.',
    acceptance_criteria: ['Tool publishes a claimable plan', 'Dry run previews without writes'],
    repo_root: repoRoot,
    affected_files: ['apps/mcp-server/src/tools/queen.ts', 'apps/mcp-server/test/queen.test.ts'],
    session_id: 'lead-session',
    ...overrides,
  };
}

const MINIMAL_SPEC = `# SPEC

## §G  goal
Test fixture spec for queen plan publication tests.

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

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'colony-queen-data-'));
  repoRoot = mkdtempSync(join(tmpdir(), 'colony-queen-repo-'));
  writeFileSync(join(repoRoot, 'SPEC.md'), MINIMAL_SPEC, 'utf8');
  store = new MemoryStore({ dbPath: join(dataDir, 'data.db'), settings: defaultSettings });
  store.startSession({ id: 'lead-session', ide: 'codex', cwd: repoRoot });
  const server = buildServer(store, defaultSettings, {
    planValidation: { readWorktreeContention: emptyWorktreeReport },
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
});

function emptyWorktreeReport(repoRoot: string): WorktreeContentionReport {
  return {
    generated_at: '2026-04-29T00:00:00.000Z',
    repo_root: repoRoot,
    inspected_roots: [],
    worktrees: [],
    contentions: [],
    summary: {
      worktree_count: 0,
      dirty_worktree_count: 0,
      dirty_file_count: 0,
      contention_count: 0,
    },
  };
}

afterEach(async () => {
  await client.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(repoRoot, { recursive: true, force: true });
});

describe('queen_plan_goal', () => {
  it('previews plan structure and claimable subtasks without publishing when dry_run is true', async () => {
    const result = await call<QueenPlanPreview>('queen_plan_goal', queenArgs({ dry_run: true }));

    expect(result.slug).toBe('build-queen-mcp-surface');
    expect(result.title).toBe('Build queen MCP surface');
    expect(result.problem).toBe('Lead agents need one call that decomposes and publishes work.');
    expect(result.acceptance_criteria).toEqual([
      'Tool publishes a claimable plan',
      'Dry run previews without writes',
    ]);
    expect(result.auto_archive).toBe(true);
    expect(result.mcp_capability_map.summary).toEqual(expect.any(Array));
    expect(result.mcp_capability_map.unknown_servers).toEqual(expect.any(Array));
    expect(result.subtasks).toEqual([
      {
        title: 'Update shared infrastructure scope',
        description: 'Update remaining non-UI/non-API files for Build queen MCP surface.',
        file_scope: ['apps/mcp-server/src/tools/queen.ts'],
        depends_on: [],
        capability_hint: 'infra_work',
      },
      {
        title: 'Add targeted tests',
        description: 'Add or update tests after the implementation for Build queen MCP surface.',
        file_scope: ['apps/mcp-server/test/queen.test.ts'],
        depends_on: [0],
        capability_hint: 'test_work',
      },
    ]);
    expectNoCommanderFields(result);
    expect(existsSync(join(repoRoot, 'openspec/changes', result.slug, 'CHANGE.md'))).toBe(false);
  });

  it('exposes queen_plan_goal as a publish-only MCP surface, not a commander API', async () => {
    const { tools } = await client.listTools();
    const queenTool = tools.find((tool) => tool.name === 'queen_plan_goal');
    const properties = Object.keys(queenTool?.inputSchema.properties ?? {});

    expect(queenTool?.description).toContain('claim parts in parallel');
    expect(queenTool?.description).toContain('task_plan_claim_subtask');
    expect(properties).toEqual(
      expect.arrayContaining([
        'goal_title',
        'problem',
        'acceptance_criteria',
        'repo_root',
        'affected_files',
        'ordering_hint',
        'waves',
        'finalizer',
        'session_id',
        'dry_run',
      ]),
    );
    expectNoCommanderFields(queenTool);
  });

  it('publishes a claimable queen plan through an MCP client call', async () => {
    const result = await call<QueenPublishResult>('queen_plan_goal', queenArgs());

    expect(result.plan_slug).toBe('build-queen-mcp-surface');
    expect(result.spec_task_id).toEqual(expect.any(Number));
    expect(result.mcp_capability_map.summary).toEqual(expect.any(Array));
    expect(result.subtasks).toHaveLength(2);
    expect(result.subtasks[0]?.branch).toBe('spec/build-queen-mcp-surface/sub-0');
    expect(result.waves.map((wave) => wave.subtask_indexes)).toEqual([[0], [1]]);
    expect(result.claim_instructions[0]).toMatchObject({
      subtask_index: 0,
      tool: 'task_plan_claim_subtask',
      arguments: {
        plan_slug: 'build-queen-mcp-surface',
        subtask_index: 0,
        session_id: '<claiming-session-id>',
        agent: '<agent-name>',
      },
    });
    expect(result.plan_validation).toMatchObject({
      blocking: false,
      finding_count: 0,
      counts: { error: 0, warning: 0, info: 0 },
    });

    const changeText = readFileSync(
      join(repoRoot, 'openspec/changes', result.plan_slug, 'CHANGE.md'),
      'utf8',
    );
    expect(changeText).toContain('Build queen MCP surface');

    const listed = await call<
      Array<{ plan_slug: string; next_available: unknown[]; subtasks: unknown[] }>
    >('task_plan_list', { repo_root: repoRoot });
    const publishedPlan = listed.find((plan) => plan.plan_slug === result.plan_slug);
    expect(publishedPlan?.subtasks).toHaveLength(2);
    expect(publishedPlan?.next_available).toHaveLength(1);
  });

  it('publishes claimable queen work when the target repo has no SPEC.md', async () => {
    rmSync(join(repoRoot, 'SPEC.md'), { force: true });

    const result = await call<QueenPublishResult>(
      'queen_plan_goal',
      queenArgs({ goal_title: 'Coordinate no spec repo' }),
    );

    expect(result.plan_slug).toBe('coordinate-no-spec-repo');
    expect(result.subtasks[0]?.branch).toBe('spec/coordinate-no-spec-repo/sub-0');
    expect(
      readFileSync(join(repoRoot, 'openspec/changes', result.plan_slug, 'CHANGE.md'), 'utf8'),
    ).toContain('base_root_hash: missing-spec-root');

    const listed = await call<PlanRollup[]>('task_plan_list', { repo_root: repoRoot });
    const publishedPlan = listed.find((plan) => plan.plan_slug === result.plan_slug);
    expect(publishedPlan?.next_available.map((subtask) => subtask.subtask_index)).toEqual([0]);

    store.startSession({ id: 'ready-session', ide: 'codex', cwd: repoRoot });
    const queue = await call<ReadyQueueResult>('task_ready_for_agent', {
      repo_root: repoRoot,
      session_id: 'ready-session',
      agent: 'codex',
      limit: 20,
      auto_claim: false,
    });
    expect(queue.ready).toContainEqual(
      expect.objectContaining({ plan_slug: result.plan_slug, subtask_index: 0 }),
    );
    expect(queue.total_available).toBe(1);
  });

  it('accepts wave ordering hints and publishes task-plan-compatible dependencies', async () => {
    const result = await call<QueenPublishResult>(
      'queen_plan_goal',
      queenArgs({
        affected_files: [
          'apps/api/src/queen-order.ts',
          'apps/web/src/queen/OrderPanel.tsx',
          'apps/api/test/queen-order.test.ts',
        ],
        ordering_hint: 'wave',
        waves: [
          { name: 'UI first', titles: ['Implement web scope'] },
          { name: 'API second', subtask_refs: ['kind:api'] },
        ],
        finalizer: 'Add targeted tests',
      }),
    );

    const listed = await call<
      Array<{
        plan_slug: string;
        next_available: Array<{ title: string }>;
        subtasks: Array<{ title: string; depends_on: number[] }>;
      }>
    >('task_plan_list', { repo_root: repoRoot });
    const publishedPlan = listed.find((plan) => plan.plan_slug === result.plan_slug);

    expect(publishedPlan?.subtasks.map((subtask) => subtask.title)).toEqual([
      'Implement web scope',
      'Implement API scope',
      'Add targeted tests',
    ]);
    expect(publishedPlan?.subtasks.map((subtask) => subtask.depends_on)).toEqual([[], [0], [0, 1]]);
    expect(publishedPlan?.next_available.map((subtask) => subtask.title)).toEqual([
      'Implement web scope',
    ]);
  });

  it('reports ordering validation errors instead of publishing unsafe overlap hints', async () => {
    const err = await callError(
      'queen_plan_goal',
      queenArgs({
        affected_files: ['docs/README.md'],
        ordering_hint: 'wave',
        waves: [
          {
            name: 'docs together',
            titles: ['Prepare README change', 'Update README documentation'],
          },
        ],
      }),
    );

    expect(err.code).toBe('QUEEN_INVALID_GOAL');
    expect(err.fields).toEqual(expect.arrayContaining(['waves']));
    expect(err.validation_errors?.[0]).toContain('overlapping sub-tasks');
  });

  it('returns QUEEN_INVALID_GOAL with invalid fields when queen validation fails', async () => {
    const err = await callError(
      'queen_plan_goal',
      queenArgs({ goal_title: '', acceptance_criteria: [] }),
    );

    expect(err.code).toBe('QUEEN_INVALID_GOAL');
    expect(err.fields).toEqual(expect.arrayContaining(['goal_title', 'acceptance_criteria']));
  });

  it('protects ordered wave publication, ready queue, claims, completion, and sweep', async () => {
    const plan = orderedPlanFromWaves({
      slug: 'queen-ordered-wave-loop',
      title: 'Queen ordered wave loop',
      problem: 'Agents need low-risk work first, product depth second, and docs last.',
      acceptance_criteria: ['Only the current wave is claimable', 'Manual archive is surfaced'],
      waves: [
        {
          id: 'wave-1',
          title: 'Low-risk subtasks',
          subtasks: [1, 2, 3, 4, 5].map((n) =>
            waveSubtask(n, 'Low-risk setup', 'infra_work', `packages/core/src/wave-${n}.ts`),
          ),
        },
        {
          id: 'wave-2',
          title: 'Deeper product subtasks',
          subtasks: [6, 7, 8, 9].map((n) =>
            waveSubtask(n, 'Product behavior', 'api_work', `apps/mcp-server/src/wave-${n}.ts`),
          ),
        },
        {
          id: 'wave-3',
          title: 'Docs and integration',
          subtasks: [
            waveSubtask(10, 'Docs integration', 'doc_work', 'docs/queen-ordered-waves.md'),
          ],
        },
      ],
    });

    const wave1 = [0, 1, 2, 3, 4];
    const wave2 = [5, 6, 7, 8];
    const wave3 = [9];

    const published = await call<QueenPublishResult>('task_plan_publish', {
      repo_root: repoRoot,
      slug: plan.slug,
      session_id: 'lead-session',
      agent: 'queen',
      title: plan.title,
      problem: plan.problem,
      acceptance_criteria: plan.acceptance_criteria,
      subtasks: plan.subtasks,
      auto_archive: false,
    });

    expect(published.subtasks.map((subtask) => subtask.subtask_index)).toEqual([
      ...wave1,
      ...wave2,
      ...wave3,
    ]);
    expect(plan.waves.map((wave) => wave.subtask_indexes)).toEqual([wave1, wave2, wave3]);
    await expectReadyOnly(plan.slug, wave1);

    const wave1Claims = await claimWave(plan.slug, wave1, 'wave-1');
    await expectReadyOnly(plan.slug, []);
    await completeWave(plan.slug, wave1Claims);
    await expectReadyOnly(plan.slug, wave2);

    const wave2Claims = await claimWave(plan.slug, wave2, 'wave-2');
    await expectReadyOnly(plan.slug, []);
    await completeWave(plan.slug, wave2Claims);
    await expectReadyOnly(plan.slug, wave3);

    const wave3Claims = await claimWave(plan.slug, wave3, 'wave-3');
    await expectReadyOnly(plan.slug, []);
    const [finalCompletion] = await completeWave(plan.slug, wave3Claims);
    expect(finalCompletion?.auto_archive).toMatchObject({
      status: 'skipped',
      reason: expect.stringMatching(/grace/),
    });
    await expectReadyOnly(plan.slug, []);

    const sweep = sweepQueenPlans(store, { repo_root: repoRoot });
    expect(sweep).toHaveLength(1);
    expect(sweep[0]?.items).toContainEqual(
      expect.objectContaining({
        reason: 'ready-to-archive',
        plan_slug: plan.slug,
        plan_title: plan.title,
        repo_root: repoRoot,
        spec_task_id: published.spec_task_id,
        completed_subtask_count: 10,
      }),
    );
  });
});

function waveSubtask(n: number, label: string, capability_hint: CapabilityHint, file: string) {
  return {
    title: `${label} ${n}`,
    description: `${label} subtask ${n}.`,
    file_scope: [file],
    capability_hint,
  };
}

function expectNoCommanderFields(value: unknown): void {
  const keys = new Set<string>();
  collectKeys(value, keys);
  for (const field of FORBIDDEN_COMMAND_FIELDS) {
    expect(keys.has(field)).toBe(false);
  }

  const serialized = JSON.stringify(value).toLowerCase();
  expect(serialized).not.toContain('launch_agent');
  expect(serialized).not.toContain('assigned_agent');
  expect(serialized).not.toContain('run_now');
  expect(serialized).not.toMatch(/shell[_ -]?monitor/);
}

function collectKeys(value: unknown, keys: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, nested] of Object.entries(value)) {
    keys.add(key.toLowerCase());
    collectKeys(nested, keys);
  }
}

async function expectReadyOnly(planSlug: string, indexes: number[]): Promise<void> {
  const listed = await call<PlanRollup[]>('task_plan_list', { repo_root: repoRoot });
  const plan = listed.find((candidate) => candidate.plan_slug === planSlug);
  expect(plan).toBeDefined();
  expect(sortedIndexes(plan?.next_available ?? [])).toEqual(indexes);

  const queue = await call<ReadyQueueResult>('task_ready_for_agent', {
    repo_root: repoRoot,
    session_id: 'ready-session',
    agent: 'codex',
    limit: 20,
    auto_claim: false,
  });
  const readyForPlan = queue.ready.filter((item) => item.plan_slug === planSlug);
  expect(sortedIndexes(readyForPlan)).toEqual(indexes);
  expect(queue.total_available).toBe(indexes.length);
}

async function claimWave(
  planSlug: string,
  indexes: number[],
  sessionPrefix: string,
): Promise<Array<{ index: number; session_id: string }>> {
  const claims: Array<{ index: number; session_id: string }> = [];
  for (const index of indexes) {
    const sessionId = `${sessionPrefix}-session-${index}`;
    store.startSession({ id: sessionId, ide: 'codex', cwd: repoRoot });
    const claim = await call<ClaimResult>('task_plan_claim_subtask', {
      plan_slug: planSlug,
      subtask_index: index,
      session_id: sessionId,
      agent: 'codex',
    });
    expect(claim.branch).toBe(`spec/${planSlug}/sub-${index}`);
    expect(claim.task_id).toBeGreaterThan(0);
    claims.push({ index, session_id: sessionId });
  }
  return claims;
}

async function completeWave(
  planSlug: string,
  claims: Array<{ index: number; session_id: string }>,
): Promise<CompleteResult[]> {
  const completions: CompleteResult[] = [];
  for (const claim of claims) {
    const completion = await call<CompleteResult>('task_plan_complete_subtask', {
      plan_slug: planSlug,
      subtask_index: claim.index,
      session_id: claim.session_id,
      summary: `sub-${claim.index} done`,
    });
    expect(completion.status).toBe('completed');
    completions.push(completion);
  }
  return completions;
}

function sortedIndexes(items: Array<{ subtask_index: number }>): number[] {
  return items.map((item) => item.subtask_index).sort((a, b) => a - b);
}
