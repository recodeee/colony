import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { MemoryStore, TaskThread, type WorktreeContentionReport } from '@colony/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';

let dataDir: string;
let repoRoot: string;
let store: MemoryStore;
let client: Client;

interface PublishResult {
  plan_slug: string;
  spec_task_id: number;
  spec_change_path: string;
  plan_workspace_path: string;
  subtasks: Array<{ subtask_index: number; branch: string; task_id: number; title: string }>;
  waves: Array<{
    wave_index: number;
    name: string;
    subtask_indexes: number[];
    subtasks: Array<{ subtask_index: number; branch: string; task_id: number; title: string }>;
  }>;
  claim_instructions: Array<{
    subtask_index: number;
    title: string;
    branch: string;
    tool: string;
    arguments: {
      plan_slug: string;
      subtask_index: number;
      session_id: string;
      agent: string;
    };
    ready_when: string;
  }>;
  plan_validation: {
    blocking: boolean;
    finding_count: number;
    counts: { error: number; warning: number; info: number };
  };
}

interface PlanRollup {
  plan_slug: string;
  title: string;
  registry_status: 'registered' | 'subtask-only';
  subtask_counts: Record<string, number>;
  next_available: Array<PlanSubtaskSummary>;
  subtasks: PlanSubtaskSummary[];
}

interface PlanSubtaskSummary {
  subtask_index: number;
  status: string;
  capability_hint: string | null;
  claimed_by_session_id: string | null;
  depends_on: number[];
  wave_index: number;
  wave_name: string;
  blocked_by: number[];
}

interface TimelineRow {
  id: number;
  kind: string;
  session_id: string;
  ts: number;
  reply_to: number | null;
  plan_slug?: string;
  subtask_index?: number;
  wave_index?: number;
  wave_name?: string;
  depends_on?: number[];
  blocked_by?: number[];
  content?: string;
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

interface SpecRowStatusResult {
  plan_slug: string;
  subtask_index: number;
  status: string;
  binding: {
    plan_slug: string;
    subtask_index: number;
    spec_row_id: string | null;
  } | null;
}

async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}';
  return JSON.parse(text) as T;
}

async function callError(
  name: string,
  args: Record<string, unknown>,
): Promise<{ code: string; error: string }> {
  const res = await client.callTool({ name, arguments: args });
  expect(res.isError).toBe(true);
  const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}';
  return JSON.parse(text) as { code: string; error: string };
}

function basicPublishArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    repo_root: repoRoot,
    slug: 'add-widget-page',
    session_id: 'A',
    agent: 'claude',
    title: 'Add widget page',
    problem: 'No widget page exists yet; users have no entry point.',
    acceptance_criteria: ['Widget page renders', 'Widget API returns rows'],
    subtasks: [
      {
        title: 'Build widget API',
        description: 'Add GET /api/widgets that returns rows.',
        file_scope: ['apps/api/src/widgets.ts'],
        capability_hint: 'api_work',
      },
      {
        title: 'Build widget page',
        description: 'Render the widget list with a card per row.',
        file_scope: ['apps/frontend/src/pages/widgets.tsx'],
        depends_on: [0],
        capability_hint: 'ui_work',
      },
    ],
    ...overrides,
  };
}

function readChangeText(slug: string): string {
  return readFileSync(join(repoRoot, 'openspec/changes', slug, 'CHANGE.md'), 'utf8');
}

const MINIMAL_SPEC = `# SPEC

## §G  goal
Test fixture spec for plan publication tests.

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
T5|todo|bound plan task|V1

## §B  bugs
id|bug|cites
-|-|-
`;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'colony-plan-data-'));
  repoRoot = mkdtempSync(join(tmpdir(), 'colony-plan-repo-'));
  writeFileSync(join(repoRoot, 'SPEC.md'), MINIMAL_SPEC, 'utf8');
  store = new MemoryStore({ dbPath: join(dataDir, 'data.db'), settings: defaultSettings });
  store.startSession({ id: 'A', ide: 'claude-code', cwd: repoRoot });
  store.startSession({ id: 'B', ide: 'codex', cwd: repoRoot });
  store.startSession({ id: 'C', ide: 'claude-code', cwd: repoRoot });
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

describe('task_plan_publish', () => {
  it('publishes a plan: writes spec change, opens one thread per sub-task, stamps metadata', async () => {
    const result = await call<PublishResult>('task_plan_publish', basicPublishArgs());
    expect(result.plan_slug).toBe('add-widget-page');
    expect(result.subtasks).toHaveLength(2);
    expect(result.subtasks[0]?.branch).toBe('spec/add-widget-page/sub-0');
    expect(result.subtasks[1]?.branch).toBe('spec/add-widget-page/sub-1');
    expect(result.spec_change_path).toContain('openspec/changes/add-widget-page/CHANGE.md');
    expect(result.plan_workspace_path).toContain('openspec/plans/add-widget-page');
    expect(result.plan_validation).toMatchObject({
      blocking: false,
      finding_count: 0,
      counts: { error: 0, warning: 0, info: 0 },
    });
    expect(existsSync(join(repoRoot, 'openspec/plans/add-widget-page/plan.md'))).toBe(true);
    expect(
      readFileSync(join(repoRoot, 'openspec/plans/add-widget-page/tasks.md'), 'utf8'),
    ).toContain('Build widget API');
  });

  it('publishes claimable plan work when the target repo has no SPEC.md', async () => {
    rmSync(join(repoRoot, 'SPEC.md'), { force: true });

    const result = await call<PublishResult>(
      'task_plan_publish',
      basicPublishArgs({ slug: 'no-spec-plan' }),
    );

    expect(result.plan_slug).toBe('no-spec-plan');
    expect(result.spec_change_path).toContain('openspec/changes/no-spec-plan/CHANGE.md');
    expect(readChangeText('no-spec-plan')).toContain('base_root_hash: missing-spec-root');

    const plans = await call<PlanRollup[]>('task_plan_list', { repo_root: repoRoot });
    const plan = plans.find((candidate) => candidate.plan_slug === 'no-spec-plan');
    expect(plan?.next_available.map((subtask) => subtask.subtask_index)).toEqual([0]);

    store.startSession({ id: 'ready-session', ide: 'codex', cwd: repoRoot });
    const ready = await call<ReadyQueueResult>('task_ready_for_agent', {
      repo_root: repoRoot,
      session_id: 'ready-session',
      agent: 'codex',
      auto_claim: false,
    });
    expect(ready.ready).toContainEqual(
      expect.objectContaining({ plan_slug: 'no-spec-plan', subtask_index: 0 }),
    );
    expect(ready.total_available).toBe(1);

    const claim = await call<ClaimResult>('task_plan_claim_subtask', {
      plan_slug: 'no-spec-plan',
      subtask_index: 0,
      session_id: 'B',
      agent: 'codex',
    });
    expect(claim.branch).toBe('spec/no-spec-plan/sub-0');
  });

  it('rejects overlapping file scopes between independent sub-tasks', async () => {
    const err = await callError(
      'task_plan_publish',
      basicPublishArgs({
        slug: 'overlap-bad',
        subtasks: [
          {
            title: 'A',
            description: 'a',
            file_scope: ['apps/foo.ts'],
          },
          {
            title: 'B',
            description: 'b',
            file_scope: ['apps/foo.ts'],
          },
        ],
      }),
    );
    expect(err.code).toBe('PLAN_WAVE_SCOPE_OVERLAP');
  });

  it('allows overlapping file scopes when sub-tasks are sequenced via depends_on', async () => {
    const result = await call<PublishResult>(
      'task_plan_publish',
      basicPublishArgs({
        slug: 'overlap-ok',
        subtasks: [
          {
            title: 'A',
            description: 'first',
            file_scope: ['apps/foo.ts'],
          },
          {
            title: 'B',
            description: 'second',
            file_scope: ['apps/foo.ts'],
            depends_on: [0],
          },
        ],
      }),
    );
    expect(result.subtasks).toHaveLength(2);
  });

  it('rejects forward / self dependencies (cycle prevention)', async () => {
    const err = await callError(
      'task_plan_publish',
      basicPublishArgs({
        slug: 'cycle-bad',
        subtasks: [
          {
            title: 'A',
            description: 'a',
            file_scope: ['apps/a.ts'],
            depends_on: [1],
          },
          {
            title: 'B',
            description: 'b',
            file_scope: ['apps/b.ts'],
          },
        ],
      }),
    );
    expect(err.code).toBe('PLAN_INVALID_WAVE_DEPENDENCY');
  });

  it('rejects finalizers that do not depend on all prior ordered work', async () => {
    const err = await callError(
      'task_plan_publish',
      basicPublishArgs({
        slug: 'finalizer-bad',
        subtasks: [
          {
            title: 'Build API',
            description: 'a',
            file_scope: ['apps/api/src/widgets.ts'],
            capability_hint: 'api_work',
          },
          {
            title: 'Build UI',
            description: 'b',
            file_scope: ['apps/frontend/src/widgets.tsx'],
            capability_hint: 'ui_work',
          },
          {
            title: 'Verify release',
            description: 'test',
            file_scope: ['apps/api/test/widgets.test.ts'],
            depends_on: [0],
            capability_hint: 'test_work',
          },
        ],
      }),
    );
    expect(err.code).toBe('PLAN_FINALIZER_NOT_LAST');
    expect(err.error).toContain('must depend on every earlier');
  });

  it('publishes valid ordered wave plans with finalizers last', async () => {
    const result = await call<PublishResult>(
      'task_plan_publish',
      basicPublishArgs({
        slug: 'ordered-waves-ok',
        subtasks: [
          {
            title: 'Prepare storage',
            description: 'storage',
            file_scope: ['packages/storage/src/widgets.ts'],
            capability_hint: 'infra_work',
          },
          {
            title: 'Build API',
            description: 'api',
            file_scope: ['apps/api/src/widgets.ts'],
            depends_on: [0],
            capability_hint: 'api_work',
          },
          {
            title: 'Build UI',
            description: 'ui',
            file_scope: ['apps/frontend/src/widgets.tsx'],
            depends_on: [0],
            capability_hint: 'ui_work',
          },
          {
            title: 'Verify release',
            description: 'verify all work',
            file_scope: ['apps/api/test/widgets.test.ts'],
            depends_on: [1, 2],
            capability_hint: 'test_work',
          },
        ],
      }),
    );

    expect(result.plan_slug).toBe('ordered-waves-ok');
    expect(result.subtasks).toHaveLength(4);
  });

  it('accepts explicit MCP wave hints and returns waves plus claim instructions', async () => {
    const result = await call<PublishResult>(
      'task_plan_publish',
      basicPublishArgs({
        slug: 'mcp-wave-plan',
        subtasks: [
          {
            title: 'Build widget page',
            description: 'Render the widget list.',
            file_scope: ['apps/frontend/src/pages/widgets.tsx'],
            capability_hint: 'ui_work',
          },
          {
            title: 'Build widget API',
            description: 'Add GET /api/widgets.',
            file_scope: ['apps/api/src/widgets.ts'],
            capability_hint: 'api_work',
          },
          {
            title: 'Verify widget flow',
            description: 'Cover the end-to-end widget flow.',
            file_scope: ['apps/api/test/widgets.test.ts'],
            capability_hint: 'test_work',
          },
        ],
        ordering_hints: {
          mode: 'wave',
          waves: [
            { name: 'Build surfaces', subtask_refs: ['kind:ui', 'kind:api'] },
            { name: 'Verification', titles: ['Verify widget flow'] },
          ],
        },
      }),
    );

    expect(result.plan_slug).toBe('mcp-wave-plan');
    expect(result.subtasks.map((subtask) => subtask.title)).toEqual([
      'Build widget page',
      'Build widget API',
      'Verify widget flow',
    ]);
    expect(
      result.waves.map((wave) => ({ name: wave.name, subtask_indexes: wave.subtask_indexes })),
    ).toEqual([
      { name: 'Build surfaces', subtask_indexes: [0, 1] },
      { name: 'Verification', subtask_indexes: [2] },
    ]);
    expect(result.claim_instructions[0]).toMatchObject({
      subtask_index: 0,
      tool: 'task_plan_claim_subtask',
      arguments: {
        plan_slug: 'mcp-wave-plan',
        subtask_index: 0,
        session_id: '<claiming-session-id>',
        agent: '<agent-name>',
      },
      ready_when: 'now',
    });
    expect(result.claim_instructions[2]).toMatchObject({
      subtask_index: 2,
      ready_when: 'dependencies_completed',
    });

    const plans = await call<PlanRollup[]>('task_plan_list', {
      repo_root: repoRoot,
      detail: 'full',
    });
    const plan = plans.find((candidate) => candidate.plan_slug === 'mcp-wave-plan');
    expect(plan?.subtasks.map((subtask) => subtask.depends_on)).toEqual([[], [], [0, 1]]);
    expect(plan?.next_available.map((subtask) => subtask.subtask_index)).toEqual([0, 1]);
  });

  it('reorders subtasks by top-level waves before publishing', async () => {
    const result = await call<PublishResult>(
      'task_plan_publish',
      basicPublishArgs({
        slug: 'mcp-wave-reorder',
        subtasks: [
          {
            title: 'Build widget API',
            description: 'Add GET /api/widgets.',
            file_scope: ['apps/api/src/widgets.ts'],
            capability_hint: 'api_work',
          },
          {
            title: 'Build widget page',
            description: 'Render the widget list.',
            file_scope: ['apps/frontend/src/pages/widgets.tsx'],
            capability_hint: 'ui_work',
          },
          {
            title: 'Verify widget flow',
            description: 'Cover the end-to-end widget flow.',
            file_scope: ['apps/api/test/widgets.test.ts'],
            capability_hint: 'test_work',
          },
        ],
        waves: [
          { name: 'UI first', subtask_indexes: [1] },
          { name: 'API second', subtask_indexes: [0] },
          { name: 'Verify', subtask_indexes: [2] },
        ],
      }),
    );

    expect(result.subtasks.map((subtask) => subtask.title)).toEqual([
      'Build widget page',
      'Build widget API',
      'Verify widget flow',
    ]);
    expect(
      result.waves.map((wave) => ({ name: wave.name, subtask_indexes: wave.subtask_indexes })),
    ).toEqual([
      { name: 'UI first', subtask_indexes: [0] },
      { name: 'API second', subtask_indexes: [1] },
      { name: 'Verify', subtask_indexes: [2] },
    ]);

    const plans = await call<PlanRollup[]>('task_plan_list', {
      repo_root: repoRoot,
      detail: 'full',
    });
    const plan = plans.find((candidate) => candidate.plan_slug === 'mcp-wave-reorder');
    expect(plan?.subtasks.map((subtask) => subtask.depends_on)).toEqual([[], [0], [1]]);
  });
});

describe('task_plan_list', () => {
  it('rolls up sub-task statuses and surfaces next_available respecting depends_on', async () => {
    await call<PublishResult>('task_plan_publish', basicPublishArgs());
    const plans = await call<PlanRollup[]>('task_plan_list', {});
    expect(plans).toHaveLength(1);
    expect(plans[0]?.plan_slug).toBe('add-widget-page');
    expect(plans[0]?.registry_status).toBe('registered');
    expect(plans[0]?.subtask_counts.available).toBe(2);
    // sub-1 depends on sub-0, so only sub-0 is in next_available initially
    expect(plans[0]?.next_available.map((s) => s.subtask_index)).toEqual([0]);
  });

  it('lists subtask-only plans when the root registry task is missing', async () => {
    const thread = TaskThread.open(store, {
      repo_root: repoRoot,
      branch: 'spec/subtask-only-plan/sub-0',
      title: 'Build subtask-only API',
      session_id: 'A',
    });
    thread.join('A', 'codex');
    store.storage.insertObservation({
      session_id: 'A',
      task_id: thread.task_id,
      kind: 'plan-subtask',
      content: 'Build subtask-only API',
      compressed: false,
      intensity: null,
      ts: Date.now(),
      metadata: {
        kind: 'plan-subtask',
        parent_plan_slug: 'subtask-only-plan',
        parent_plan_title: 'Subtask-only plan',
        subtask_index: 0,
        title: 'Build subtask-only API',
        description: 'Recover plan rollup from subtask rows.',
        status: 'available',
        file_scope: ['apps/api/subtask-only.ts'],
        depends_on: [],
      },
    });

    const plans = await call<PlanRollup[]>('task_plan_list', { repo_root: repoRoot });

    expect(plans.find((plan) => plan.plan_slug === 'subtask-only-plan')).toMatchObject({
      registry_status: 'subtask-only',
      title: 'Subtask-only plan',
      subtask_counts: expect.objectContaining({ available: 1 }),
      next_available: [expect.objectContaining({ subtask_index: 0 })],
    });
  });

  it('adds compact wave metadata to plan list output', async () => {
    await call<PublishResult>('task_plan_publish', basicPublishArgs());
    const plans = await call<PlanRollup[]>('task_plan_list', { detail: 'full' });
    expect(plans[0]?.subtasks.map((s) => s.subtask_index)).toEqual([0, 1]);
    expect(plans[0]?.subtasks[0]).toMatchObject({
      subtask_index: 0,
      depends_on: [],
      wave_index: 0,
      wave_name: 'Wave 1',
      blocked_by: [],
    });
    expect(plans[0]?.subtasks[1]).toMatchObject({
      subtask_index: 1,
      depends_on: [0],
      wave_index: 1,
      wave_name: 'Wave 2',
      blocked_by: [0],
    });
    expect(plans[0]?.next_available[0]).toMatchObject({
      subtask_index: 0,
      wave_index: 0,
      blocked_by: [],
    });
  });

  it('adds compact wave metadata to task_timeline without expanding bodies', async () => {
    const published = await call<PublishResult>('task_plan_publish', basicPublishArgs());
    const sub1 = published.subtasks.find((subtask) => subtask.subtask_index === 1);
    if (!sub1) throw new Error('expected sub-task 1 to be published');

    const timeline = await call<TimelineRow[]>('task_timeline', { task_id: sub1.task_id });
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({
      kind: 'plan-subtask',
      plan_slug: 'add-widget-page',
      subtask_index: 1,
      wave_index: 1,
      wave_name: 'Wave 2',
      depends_on: [0],
      blocked_by: [0],
    });
    expect(timeline[0]).not.toHaveProperty('content');
  });

  it('filters by capability_match against next_available sub-tasks', async () => {
    await call<PublishResult>('task_plan_publish', basicPublishArgs());
    const apiPlans = await call<PlanRollup[]>('task_plan_list', { capability_match: 'api_work' });
    const uiPlans = await call<PlanRollup[]>('task_plan_list', { capability_match: 'ui_work' });
    expect(apiPlans).toHaveLength(1);
    // sub-1 (ui_work) is not in next_available because its dep is unmet
    expect(uiPlans).toHaveLength(0);
  });

  it('returns a compact rollup by default that omits description and file_scope', async () => {
    await call<PublishResult>('task_plan_publish', basicPublishArgs());

    const compactPlans = await call<
      Array<{
        plan_slug: string;
        subtask_counts: Record<string, number>;
        subtask_count: number;
        subtask_indexes: number[];
        next_available_count: number;
        next_available: Array<{
          subtask_index: number;
          title: string;
          status: string;
          capability_hint: string | null;
          wave_index: number;
        }>;
      }>
    >('task_plan_list', {});
    const fullPlans = await call<PlanRollup[]>('task_plan_list', { detail: 'full' });

    const compact = compactPlans[0];
    const full = fullPlans[0];
    expect(compact?.plan_slug).toBe('add-widget-page');
    expect(compact?.subtask_count).toBe(2);
    expect(compact?.subtask_indexes).toEqual([0, 1]);
    expect(compact?.next_available_count).toBe(1);
    expect(compact?.next_available[0]).toMatchObject({
      subtask_index: 0,
      capability_hint: 'api_work',
      status: 'available',
      wave_index: 0,
    });
    expect(compact as Record<string, unknown>).not.toHaveProperty('subtasks');
    expect((compact?.next_available[0] as Record<string, unknown>) ?? {}).not.toHaveProperty(
      'description',
    );
    expect((compact?.next_available[0] as Record<string, unknown>) ?? {}).not.toHaveProperty(
      'file_scope',
    );

    // Compact serialization must be materially smaller than the full shape;
    // the gain telemetry shows full bodies running ~12.9k tokens per call.
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(full).length / 2);
  });
});

describe('task_plan_claim_subtask', () => {
  it('claims an available sub-task and activates file claims', async () => {
    await call<PublishResult>('task_plan_publish', basicPublishArgs());
    const claim = await call<ClaimResult>('task_plan_claim_subtask', {
      plan_slug: 'add-widget-page',
      subtask_index: 0,
      session_id: 'B',
      agent: 'codex',
    });
    expect(claim.branch).toBe('spec/add-widget-page/sub-0');
    expect(claim.file_scope).toEqual(['apps/api/src/widgets.ts']);

    // List should show sub-0 as claimed
    const plans = await call<PlanRollup[]>('task_plan_list', { detail: 'full' });
    const sub0 = plans[0]?.subtasks.find((s) => s.subtask_index === 0);
    expect(sub0?.status).toBe('claimed');
    expect(sub0?.claimed_by_session_id).toBe('B');
  });

  it('does not duplicate file claims when the same session already owns the scoped file', async () => {
    const published = await call<PublishResult>('task_plan_publish', basicPublishArgs());
    const subtaskId = published.subtasks[0]?.task_id ?? -1;
    store.storage.claimFile({
      task_id: subtaskId,
      file_path: 'apps/api/src/widgets.ts',
      session_id: 'B',
    });

    const claim = await call<ClaimResult>('task_plan_claim_subtask', {
      plan_slug: 'add-widget-page',
      subtask_index: 0,
      session_id: 'B',
      agent: 'codex',
    });

    expect(claim.branch).toBe('spec/add-widget-page/sub-0');
    expect(store.storage.listClaims(claim.task_id)).toEqual([
      expect.objectContaining({
        file_path: 'apps/api/src/widgets.ts',
        session_id: 'B',
      }),
    ]);
  });

  it('blocks plan subtask claim when its file is held by an active different owner', async () => {
    const filePath = 'apps/api/src/widgets.ts';
    const published = await call<PublishResult>('task_plan_publish', basicPublishArgs());
    const subtask = published.subtasks[0];
    if (!subtask) throw new Error('expected subtask');

    store.startSession({ id: 'active-owner', ide: 'claude-code', cwd: repoRoot });
    const ownerThread = TaskThread.open(store, {
      repo_root: repoRoot,
      branch: subtask.branch,
      session_id: 'active-owner',
    });
    ownerThread.join('active-owner', 'claude');
    ownerThread.claimFile({ session_id: 'active-owner', file_path: filePath });

    const err = await callError('task_plan_claim_subtask', {
      plan_slug: 'add-widget-page',
      subtask_index: 0,
      session_id: 'B',
      agent: 'codex',
    });

    expect(err).toMatchObject({
      code: 'CLAIM_HELD_BY_ACTIVE_OWNER',
    });
    expect(store.storage.getClaim(subtask.task_id, filePath)?.session_id).toBe('active-owner');
    expect(
      store.storage.taskObservationsByKind(subtask.task_id, 'plan-subtask-claim'),
    ).toHaveLength(0);
  });

  it('rejects claim when dependencies are not yet completed', async () => {
    await call<PublishResult>('task_plan_publish', basicPublishArgs());
    const err = await callError('task_plan_claim_subtask', {
      plan_slug: 'add-widget-page',
      subtask_index: 1,
      session_id: 'B',
      agent: 'codex',
    });
    expect(err.code).toBe('PLAN_SUBTASK_DEPS_UNMET');
  });

  it('rejects a second claim on an already-claimed sub-task (race)', async () => {
    // The load-bearing test for the lane: two agents racing on the same
    // available sub-task. The transaction-based scan-before-stamp inside the
    // tool handler must serialize them; the second one sees the first claim
    // observation and rejects.
    await call<PublishResult>('task_plan_publish', basicPublishArgs());
    const args = (sid: string, agent: string) => ({
      plan_slug: 'add-widget-page',
      subtask_index: 0,
      session_id: sid,
      agent,
    });

    // First claim wins.
    const first = await call<ClaimResult>('task_plan_claim_subtask', args('B', 'codex'));
    expect(first.task_id).toBeGreaterThan(0);

    // Second claim must fail.
    const err = await callError('task_plan_claim_subtask', args('C', 'claude'));
    expect(err.code).toBe('PLAN_SUBTASK_NOT_AVAILABLE');
  });

  it('returns next_available_subtask_index on PLAN_SUBTASK_NOT_AVAILABLE so callers skip a re-list', async () => {
    // Publish a 3-subtask plan with no inter-dependencies so two sub-tasks
    // remain available after the loser races and loses on sub-0.
    await call<PublishResult>(
      'task_plan_publish',
      basicPublishArgs({
        slug: 'claim-recovery',
        subtasks: [
          {
            title: 'Build widget API',
            description: 'Add GET /api/widgets.',
            file_scope: ['apps/api/src/widgets.ts'],
            capability_hint: 'api_work',
          },
          {
            title: 'Build widget page',
            description: 'Render the widget list.',
            file_scope: ['apps/frontend/src/pages/widgets.tsx'],
            capability_hint: 'ui_work',
          },
          {
            title: 'Cover widget flow',
            description: 'Add an integration test.',
            file_scope: ['apps/api/test/widgets.test.ts'],
            capability_hint: 'test_work',
          },
        ],
      }),
    );

    await call<ClaimResult>('task_plan_claim_subtask', {
      plan_slug: 'claim-recovery',
      subtask_index: 0,
      session_id: 'B',
      agent: 'codex',
    });

    const res = await client.callTool({
      name: 'task_plan_claim_subtask',
      arguments: {
        plan_slug: 'claim-recovery',
        subtask_index: 0,
        session_id: 'C',
        agent: 'claude',
      },
    });
    expect(res.isError).toBe(true);
    const payload = JSON.parse(
      (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}',
    ) as {
      code: string;
      plan_slug: string;
      next_available_subtask_index: number | null;
      next_available_count: number;
      next_available: Array<{ subtask_index: number; capability_hint: string | null }>;
    };
    expect(payload.code).toBe('PLAN_SUBTASK_NOT_AVAILABLE');
    expect(payload.plan_slug).toBe('claim-recovery');
    expect(payload.next_available_count).toBe(2);
    expect(payload.next_available_subtask_index).toBe(1);
    expect(payload.next_available.map((s) => s.subtask_index)).toEqual([1, 2]);
  });

  it('reports a claimed sub-task by bound spec row id', async () => {
    await call<PublishResult>(
      'task_plan_publish',
      basicPublishArgs({
        slug: 'status-for-spec-row',
        subtasks: [
          {
            title: 'Bound row task',
            description: 'Complete T5.',
            file_scope: ['apps/api/src/bound.ts'],
            spec_row_id: 'T5',
          },
          {
            title: 'Unbound row task',
            description: 'No row binding.',
            file_scope: ['apps/api/src/unbound.ts'],
          },
        ],
      }),
    );
    await call<ClaimResult>('task_plan_claim_subtask', {
      plan_slug: 'status-for-spec-row',
      subtask_index: 0,
      session_id: 'B',
      agent: 'codex',
    });

    const status = await call<SpecRowStatusResult>('task_plan_status_for_spec_row', {
      repo_root: repoRoot,
      spec_row_id: 'T5',
    });
    expect(status.plan_slug).toBe('status-for-spec-row');
    expect(status.subtask_index).toBe(0);
    expect(status.status).toBe('claimed');
    expect(status.binding?.spec_row_id).toBe('T5');
  });
});

describe('task_plan_complete_subtask', () => {
  it('marks claimed sub-task complete and unblocks downstream sub-tasks', async () => {
    await call<PublishResult>('task_plan_publish', basicPublishArgs());
    await call<ClaimResult>('task_plan_claim_subtask', {
      plan_slug: 'add-widget-page',
      subtask_index: 0,
      session_id: 'B',
      agent: 'codex',
    });
    const done = await call<{ status: string }>('task_plan_complete_subtask', {
      plan_slug: 'add-widget-page',
      subtask_index: 0,
      session_id: 'B',
      summary: 'Widget API landed: GET /api/widgets serving rows.',
    });
    expect(done.status).toBe('completed');

    // sub-1 should now be unblocked.
    const plans = await call<PlanRollup[]>('task_plan_list', {});
    expect(plans[0]?.next_available.map((s) => s.subtask_index)).toEqual([1]);
    expect(plans[0]?.subtask_counts.completed).toBe(1);
    expect(
      readFileSync(join(repoRoot, 'openspec/plans/add-widget-page/checkpoints.md'), 'utf8'),
    ).toContain(
      '- [x] sub-0 Build widget API [completed] - Widget API landed: GET /api/widgets serving rows.',
    );
  });

  it('rejects completion when called by a non-owning session', async () => {
    await call<PublishResult>('task_plan_publish', basicPublishArgs());
    await call<ClaimResult>('task_plan_claim_subtask', {
      plan_slug: 'add-widget-page',
      subtask_index: 0,
      session_id: 'B',
      agent: 'codex',
    });
    const err = await callError('task_plan_complete_subtask', {
      plan_slug: 'add-widget-page',
      subtask_index: 0,
      session_id: 'C',
      summary: 'sneaky completion',
    });
    expect(err.code).toBe('PLAN_SUBTASK_NOT_YOURS');
  });

  it('rejects completion on an unclaimed sub-task', async () => {
    await call<PublishResult>('task_plan_publish', basicPublishArgs());
    const err = await callError('task_plan_complete_subtask', {
      plan_slug: 'add-widget-page',
      subtask_index: 0,
      session_id: 'B',
      summary: 'nothing claimed',
    });
    expect(err.code).toBe('PLAN_SUBTASK_NOT_CLAIMED');
  });

  it('appends a spec modify delta when completing a bound sub-task', async () => {
    await call<PublishResult>(
      'task_plan_publish',
      basicPublishArgs({
        slug: 'spec-row-binding',
        subtasks: [
          {
            title: 'Bound row task',
            description: 'Complete T5.',
            file_scope: ['apps/api/src/bound.ts'],
            spec_row_id: 'T5',
          },
          {
            title: 'Other task',
            description: 'No row binding.',
            file_scope: ['apps/api/src/other.ts'],
          },
        ],
      }),
    );
    await call<ClaimResult>('task_plan_claim_subtask', {
      plan_slug: 'spec-row-binding',
      subtask_index: 0,
      session_id: 'B',
      agent: 'codex',
    });
    await call<{ status: string }>('task_plan_complete_subtask', {
      plan_slug: 'spec-row-binding',
      subtask_index: 0,
      session_id: 'B',
      summary: 'T5 implementation landed.',
    });

    const changeText = readChangeText('spec-row-binding');
    expect(changeText).toMatch(/^modify\|T5\|T5 done bound plan task V1$/m);
  });

  it('only appends a spec delta for bound completed sub-tasks', async () => {
    await call<PublishResult>(
      'task_plan_publish',
      basicPublishArgs({
        slug: 'mixed-spec-row-binding',
        subtasks: [
          {
            title: 'Bound row task',
            description: 'Complete T5.',
            file_scope: ['apps/api/src/bound.ts'],
            spec_row_id: 'T5',
          },
          {
            title: 'Unbound row task',
            description: 'No row binding.',
            file_scope: ['apps/api/src/unbound.ts'],
          },
        ],
      }),
    );
    await call<ClaimResult>('task_plan_claim_subtask', {
      plan_slug: 'mixed-spec-row-binding',
      subtask_index: 0,
      session_id: 'B',
      agent: 'codex',
    });
    await call<{ status: string }>('task_plan_complete_subtask', {
      plan_slug: 'mixed-spec-row-binding',
      subtask_index: 0,
      session_id: 'B',
      summary: 'T5 done.',
    });
    await call<ClaimResult>('task_plan_claim_subtask', {
      plan_slug: 'mixed-spec-row-binding',
      subtask_index: 1,
      session_id: 'C',
      agent: 'claude',
    });
    await call<{ status: string }>('task_plan_complete_subtask', {
      plan_slug: 'mixed-spec-row-binding',
      subtask_index: 1,
      session_id: 'C',
      summary: 'Unbound work done.',
    });

    const deltaLines = readChangeText('mixed-spec-row-binding')
      .split('\n')
      .filter((line) => line.startsWith('modify|'));
    expect(deltaLines).toEqual(['modify|T5|T5 done bound plan task V1']);
  });
});

describe('task_plan auto-archive', () => {
  function backdateAllSubtaskCompletions(slug: string, ageMs: number): void {
    const cutoff = Date.now() - ageMs;
    const branchPrefix = `spec/${slug}/sub-`;
    for (const task of store.storage.listTasks(2000)) {
      if (!task.branch.startsWith(branchPrefix)) continue;
      const obs = store.storage.taskObservationsByKind(task.id, 'plan-subtask-claim', 100);
      for (const row of obs) {
        if (!row.metadata) continue;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(row.metadata) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (parsed.status !== 'completed') continue;
        parsed.completed_at = cutoff;
        store.storage.updateObservationMetadata(row.id, JSON.stringify(parsed));
      }
    }
  }

  async function claimAndComplete(slug: string, index: number, sessionId: string, agent: string) {
    await call<ClaimResult>('task_plan_claim_subtask', {
      plan_slug: slug,
      subtask_index: index,
      session_id: sessionId,
      agent,
    });
    return call<{ status: string; auto_archive: { status: string; reason?: string } }>(
      'task_plan_complete_subtask',
      {
        plan_slug: slug,
        subtask_index: index,
        session_id: sessionId,
        summary: `sub-${index} done`,
      },
    );
  }

  it('archives the change when the last sub-task completes and auto_archive is true', async () => {
    await call<PublishResult>(
      'task_plan_publish',
      basicPublishArgs({ slug: 'auto-archive-on', auto_archive: true }),
    );

    // First completion → still has outstanding work, no archive yet.
    const first = await claimAndComplete('auto-archive-on', 0, 'B', 'codex');
    expect(first.status).toBe('completed');
    expect(first.auto_archive.status).toBe('skipped');
    expect(first.auto_archive.reason).toMatch(/outstanding/);
    expect(existsSync(join(repoRoot, 'openspec/changes/auto-archive-on/CHANGE.md'))).toBe(true);

    // Last completion → archive runs.
    const second = await claimAndComplete('auto-archive-on', 1, 'C', 'claude');
    expect(second.status).toBe('completed');
    expect(second.auto_archive.status).toBe('archived');
    // Change moved to openspec/archive/<date>-<slug>/CHANGE.md
    expect(existsSync(join(repoRoot, 'openspec/changes/auto-archive-on/CHANGE.md'))).toBe(false);
  });

  it('records a reflexion sibling when auto archive is blocked by merge conflicts', async () => {
    const slug = 'auto-archive-conflict-reflexion';
    const published = await call<PublishResult>(
      'task_plan_publish',
      basicPublishArgs({ slug, auto_archive: true }),
    );
    writeFileSync(
      join(repoRoot, 'openspec/changes', slug, 'CHANGE.md'),
      readChangeText(slug).replace('op|target|row\n-|-|-', 'op|target|row\n-|-|-\nremove|V1|-'),
      'utf8',
    );

    await claimAndComplete(slug, 0, 'B', 'codex');
    const last = await claimAndComplete(slug, 1, 'C', 'claude');
    expect(last.status).toBe('completed');
    expect(last.auto_archive.status).toBe('blocked');

    const blocked = store.storage.taskObservationsByKind(
      published.spec_task_id,
      'plan-archive-blocked',
      10,
    );
    const reflexions = store.storage.taskObservationsByKind(
      published.spec_task_id,
      'reflexion',
      10,
    );
    expect(blocked).toHaveLength(1);
    expect(reflexions).toHaveLength(1);
    expect(JSON.parse(reflexions[0]?.metadata ?? '{}')).toMatchObject({
      kind: 'failure',
      reward: -1,
      source_kind: 'plan-archive-blocked',
      source_observation_id: blocked[0]?.id,
      idempotency_key: `plan-archive-blocked:${slug}:V1:delta_removes_cited_row`,
    });
  });

  it('defers the archive within the grace window when auto_archive is omitted', async () => {
    await call<PublishResult>(
      'task_plan_publish',
      basicPublishArgs({ slug: 'auto-archive-default-off' }),
    );
    await claimAndComplete('auto-archive-default-off', 0, 'B', 'codex');
    const last = await claimAndComplete('auto-archive-default-off', 1, 'C', 'claude');
    expect(last.auto_archive.status).toBe('skipped');
    expect(last.auto_archive.reason).toMatch(/grace/);
    // CHANGE.md stays in openspec/changes/ during the grace window.
    expect(existsSync(join(repoRoot, 'openspec/changes/auto-archive-default-off/CHANGE.md'))).toBe(
      true,
    );
  });

  it('archives via task_plan_list sweep after the grace window elapses', async () => {
    await call<PublishResult>(
      'task_plan_publish',
      basicPublishArgs({ slug: 'auto-archive-grace-elapsed' }),
    );
    await claimAndComplete('auto-archive-grace-elapsed', 0, 'B', 'codex');
    const last = await claimAndComplete('auto-archive-grace-elapsed', 1, 'C', 'claude');
    expect(last.auto_archive.status).toBe('skipped');

    // Backdate every subtask completion observation past the 60s grace
    // window so the next list call treats the plan as archive-eligible.
    backdateAllSubtaskCompletions('auto-archive-grace-elapsed', 120_000);

    await call<unknown>('task_plan_list', { repo_root: repoRoot });

    expect(
      existsSync(join(repoRoot, 'openspec/changes/auto-archive-grace-elapsed/CHANGE.md')),
    ).toBe(false);
    const parentTask = store.storage
      .listTasks(2000)
      .find((t) => t.branch === 'spec/auto-archive-grace-elapsed');
    expect(parentTask).toBeDefined();
    if (parentTask) {
      expect(store.storage.taskObservationsByKind(parentTask.id, 'plan-archived', 10)).toHaveLength(
        1,
      );
    }
  });

  it('delta written then archive throws', async () => {
    const slug = 'delta-archive-throws';
    const published = await call<PublishResult>(
      'task_plan_publish',
      basicPublishArgs({
        slug,
        auto_archive: true,
        subtasks: [
          {
            title: 'Other task',
            description: 'No row binding.',
            file_scope: ['apps/api/src/other.ts'],
          },
          {
            title: 'Bound row task',
            description: 'Complete T5.',
            file_scope: ['apps/api/src/bound.ts'],
            spec_row_id: 'T5',
          },
        ],
      }),
    );

    await claimAndComplete(slug, 0, 'B', 'codex');
    const archiveDir = join(repoRoot, 'openspec/changes/archive');
    mkdirSync(archiveDir, { recursive: true });
    writeFileSync(
      join(archiveDir, `${new Date().toISOString().slice(0, 10)}-${slug}`),
      'block',
      'utf8',
    );

    const last = await claimAndComplete(slug, 1, 'C', 'claude');
    expect(last.status).toBe('completed');
    expect(last.auto_archive.status).toBe('error');

    const changeText = readChangeText(slug);
    const deltaLines = changeText.split('\n').filter((line) => line.startsWith('modify|T5|'));
    expect(deltaLines).toEqual(['modify|T5|T5 done bound plan task V1']);

    const archiveErrors = store.storage.taskObservationsByKind(
      published.spec_task_id,
      'plan-archive-error',
      10,
    );
    expect(archiveErrors).toHaveLength(1);
    expect(archiveErrors[0]?.content).toContain('auto-archive failed');
  });

  it('reconciles a plan whose change dir was already moved to archive on disk', async () => {
    const slug = 'orphan-archive-recon';
    await call<PublishResult>('task_plan_publish', basicPublishArgs({ slug }));
    await claimAndComplete(slug, 0, 'B', 'codex');
    await claimAndComplete(slug, 1, 'C', 'claude');

    // Simulate the lane being closed manually: move the change dir into
    // archive without the colony plan-archived observation. This mirrors
    // an operator running `mv openspec/changes/<slug> openspec/changes/archive/<date>-<slug>`.
    backdateAllSubtaskCompletions(slug, 120_000);
    const sourceDir = join(repoRoot, 'openspec/changes', slug);
    const archiveRoot = join(repoRoot, 'openspec/changes/archive');
    mkdirSync(archiveRoot, { recursive: true });
    const datedSlug = `${new Date().toISOString().slice(0, 10)}-${slug}`;
    const targetDir = join(archiveRoot, datedSlug);
    renameSync(sourceDir, targetDir);
    expect(existsSync(sourceDir)).toBe(false);
    expect(existsSync(targetDir)).toBe(true);

    await call<unknown>('task_plan_list', { repo_root: repoRoot });

    const parentTask = store.storage.listTasks(2000).find((t) => t.branch === `spec/${slug}`);
    expect(parentTask).toBeDefined();
    if (parentTask) {
      const archived = store.storage.taskObservationsByKind(parentTask.id, 'plan-archived', 10);
      expect(archived).toHaveLength(1);
      expect(archived[0]?.content).toContain('reconciled');
    }
  });

  it('records a plan-archive-error observation when archive throws', async () => {
    // Force a failure path: publish, complete sub-0, then delete the
    // CHANGE.md file before the last completion. readChange will throw.
    await call<PublishResult>(
      'task_plan_publish',
      basicPublishArgs({ slug: 'auto-archive-broken', auto_archive: true }),
    );
    await claimAndComplete('auto-archive-broken', 0, 'B', 'codex');
    rmSync(join(repoRoot, 'openspec/changes/auto-archive-broken/CHANGE.md'), {
      force: true,
    });
    const last = await claimAndComplete('auto-archive-broken', 1, 'C', 'claude');
    // Completion still succeeds — the failure is recorded as an observation,
    // not propagated as a tool error.
    expect(last.status).toBe('completed');
    expect(last.auto_archive.status).toBe('error');
  });
});
