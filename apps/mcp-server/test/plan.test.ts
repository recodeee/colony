import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { MemoryStore } from '@colony/core';
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
  subtasks: Array<{ subtask_index: number; branch: string; task_id: number; title: string }>;
}

interface PlanRollup {
  plan_slug: string;
  title: string;
  subtask_counts: Record<string, number>;
  next_available: Array<{ subtask_index: number; capability_hint: string | null }>;
  subtasks: Array<{ subtask_index: number; status: string; claimed_by_session_id: string | null }>;
}

interface ClaimResult {
  task_id: number;
  branch: string;
  file_scope: string[];
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
id|task|cites
-|-|-
T1|placeholder|V1

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
  const server = buildServer(store, defaultSettings);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
});

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
    expect(err.code).toBe('PLAN_SCOPE_OVERLAP');
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
    expect(err.code).toBe('PLAN_INVALID_DEPENDENCY');
  });
});

describe('task_plan_list', () => {
  it('rolls up sub-task statuses and surfaces next_available respecting depends_on', async () => {
    await call<PublishResult>('task_plan_publish', basicPublishArgs());
    const plans = await call<PlanRollup[]>('task_plan_list', {});
    expect(plans).toHaveLength(1);
    expect(plans[0]?.plan_slug).toBe('add-widget-page');
    expect(plans[0]?.subtask_counts.available).toBe(2);
    // sub-1 depends on sub-0, so only sub-0 is in next_available initially
    expect(plans[0]?.next_available.map((s) => s.subtask_index)).toEqual([0]);
  });

  it('filters by capability_match against next_available sub-tasks', async () => {
    await call<PublishResult>('task_plan_publish', basicPublishArgs());
    const apiPlans = await call<PlanRollup[]>('task_plan_list', { capability_match: 'api_work' });
    const uiPlans = await call<PlanRollup[]>('task_plan_list', { capability_match: 'ui_work' });
    expect(apiPlans).toHaveLength(1);
    // sub-1 (ui_work) is not in next_available because its dep is unmet
    expect(uiPlans).toHaveLength(0);
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
    const plans = await call<PlanRollup[]>('task_plan_list', {});
    const sub0 = plans[0]?.subtasks.find((s) => s.subtask_index === 0);
    expect(sub0?.status).toBe('claimed');
    expect(sub0?.claimed_by_session_id).toBe('B');
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
});

describe('task_plan auto-archive', () => {
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

  it('does not archive when auto_archive is omitted (default off)', async () => {
    await call<PublishResult>(
      'task_plan_publish',
      basicPublishArgs({ slug: 'auto-archive-default-off' }),
    );
    await claimAndComplete('auto-archive-default-off', 0, 'B', 'codex');
    const last = await claimAndComplete('auto-archive-default-off', 1, 'C', 'claude');
    expect(last.auto_archive.status).toBe('skipped');
    expect(last.auto_archive.reason).toMatch(/disabled/);
    // CHANGE.md stays in openspec/changes/.
    expect(existsSync(join(repoRoot, 'openspec/changes/auto-archive-default-off/CHANGE.md'))).toBe(
      true,
    );
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

interface CompleteResult {
  status: string;
  auto_archive: { status: string; reason?: string };
  spec_row_delta: { status: string; reason?: string; spec_row_id?: string };
}

interface SpecRowBindingResult {
  task_id: number;
  plan_slug: string;
  subtask_index: number;
  status: string;
  branch: string;
}

describe('spec_row_id sub-task ↔ spec row binding', () => {
  function bindingPublishArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return basicPublishArgs({
      slug: 'spec-bound-plan',
      subtasks: [
        {
          title: 'Implement T1',
          description: 'Bound to T1.',
          file_scope: ['apps/api/src/widgets.ts'],
          spec_row_id: 'T1',
        },
        {
          title: 'Unbound follow-up',
          description: 'Has no spec row binding.',
          file_scope: ['apps/frontend/src/pages/widgets.tsx'],
          depends_on: [0],
        },
      ],
      ...overrides,
    });
  }

  it('rejects publish when spec_row_id does not resolve to a row in SPEC.md', async () => {
    const err = await callError(
      'task_plan_publish',
      basicPublishArgs({
        slug: 'bad-row',
        subtasks: [
          {
            title: 'Bind to nothing',
            description: 'spec_row_id points to a missing row.',
            file_scope: ['apps/foo.ts'],
            spec_row_id: 'T999',
          },
          {
            title: 'Other',
            description: 'second',
            file_scope: ['apps/bar.ts'],
          },
        ],
      }),
    );
    expect(err.code).toBe('PLAN_SPEC_ROW_NOT_FOUND');
  });

  it('completes a bound sub-task and writes a modify delta with done in the change doc', async () => {
    await call<PublishResult>('task_plan_publish', bindingPublishArgs());
    await call<ClaimResult>('task_plan_claim_subtask', {
      plan_slug: 'spec-bound-plan',
      subtask_index: 0,
      session_id: 'B',
      agent: 'codex',
    });
    const done = await call<CompleteResult>('task_plan_complete_subtask', {
      plan_slug: 'spec-bound-plan',
      subtask_index: 0,
      session_id: 'B',
      summary: 'T1 implemented.',
    });
    expect(done.spec_row_delta.status).toBe('appended');
    expect(done.spec_row_delta.spec_row_id).toBe('T1');

    const changeDoc = readFileSync(
      join(repoRoot, 'openspec/changes/spec-bound-plan/CHANGE.md'),
      'utf8',
    );
    // The §S delta section should now contain `modify|T1|...done...`.
    const deltaSection = changeDoc.match(/## §S[\s\S]*?(?=## §|$)/);
    expect(deltaSection).not.toBeNull();
    expect(deltaSection?.[0]).toMatch(/modify\|T1/);
    expect(deltaSection?.[0]).toMatch(/done/);
  });

  it('produces no delta when the sub-task carries no spec_row_id', async () => {
    await call<PublishResult>('task_plan_publish', bindingPublishArgs());

    // sub-0 has spec_row_id='T1'; sub-1 has none. Complete sub-0 first
    // (it's the dependency for sub-1), then sub-1.
    await call<ClaimResult>('task_plan_claim_subtask', {
      plan_slug: 'spec-bound-plan',
      subtask_index: 0,
      session_id: 'B',
      agent: 'codex',
    });
    const bound = await call<CompleteResult>('task_plan_complete_subtask', {
      plan_slug: 'spec-bound-plan',
      subtask_index: 0,
      session_id: 'B',
      summary: 'sub-0 done',
    });
    expect(bound.spec_row_delta.status).toBe('appended');

    await call<ClaimResult>('task_plan_claim_subtask', {
      plan_slug: 'spec-bound-plan',
      subtask_index: 1,
      session_id: 'C',
      agent: 'claude',
    });
    const unbound = await call<CompleteResult>('task_plan_complete_subtask', {
      plan_slug: 'spec-bound-plan',
      subtask_index: 1,
      session_id: 'C',
      summary: 'sub-1 done',
    });
    expect(unbound.spec_row_delta.status).toBe('skipped');
    expect(unbound.spec_row_delta.reason).toMatch(/no spec_row_id/);

    // Only one delta in the change doc — the bound one.
    const changeDoc = readFileSync(
      join(repoRoot, 'openspec/changes/spec-bound-plan/CHANGE.md'),
      'utf8',
    );
    const deltaSection = changeDoc.match(/## §S[\s\S]*?(?=## §|$)/)?.[0] ?? '';
    const modifyLines = deltaSection
      .split('\n')
      .filter((l) => l.startsWith('modify|') || l.startsWith('add|') || l.startsWith('remove|'));
    expect(modifyLines).toHaveLength(1);
    expect(modifyLines[0]).toMatch(/modify\|T1/);
  });

  it('task_plan_status_for_spec_row returns the binding for a claimed sub-task', async () => {
    await call<PublishResult>('task_plan_publish', bindingPublishArgs());
    await call<ClaimResult>('task_plan_claim_subtask', {
      plan_slug: 'spec-bound-plan',
      subtask_index: 0,
      session_id: 'B',
      agent: 'codex',
    });

    const binding = await call<SpecRowBindingResult | null>('task_plan_status_for_spec_row', {
      repo_root: repoRoot,
      spec_row_id: 'T1',
    });
    expect(binding).not.toBeNull();
    expect(binding?.plan_slug).toBe('spec-bound-plan');
    expect(binding?.subtask_index).toBe(0);
    expect(binding?.status).toBe('claimed');
    expect(binding?.branch).toBe('spec/spec-bound-plan/sub-0');
  });

  it('task_plan_status_for_spec_row returns null for an unbound row', async () => {
    await call<PublishResult>('task_plan_publish', bindingPublishArgs());
    const binding = await call<SpecRowBindingResult | null>('task_plan_status_for_spec_row', {
      repo_root: repoRoot,
      spec_row_id: 'V1',
    });
    expect(binding).toBeNull();
  });

  it('spec_read surfaces bound_subtasks for in-flight bindings', async () => {
    await call<PublishResult>('task_plan_publish', bindingPublishArgs());
    const specRead = await call<{
      bound_subtasks: Record<string, { plan_slug: string; subtask_index: number; status: string }>;
    }>('spec_read', { repo_root: repoRoot });
    expect(specRead.bound_subtasks.T1).toEqual({
      plan_slug: 'spec-bound-plan',
      subtask_index: 0,
      status: 'available',
    });
    expect(specRead.bound_subtasks.V1).toBeUndefined();
  });
});
