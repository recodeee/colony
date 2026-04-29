import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { MemoryStore, TaskThread } from '@colony/core';
import { colonyAdoptionFixesPlan } from '@colony/queen';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/server.js';

let dataDir: string;
let repoRoot: string;
let store: MemoryStore;
let client: Client;

interface ReadyEntry {
  next_tool?: 'task_plan_claim_subtask';
  next_action_reason?: string;
  plan_slug: string;
  subtask_index: number;
  wave_index: number;
  wave_name: string;
  blocked_by_count: number;
  title: string;
  capability_hint: string | null;
  file_scope: string[];
  fit_score: number;
  reason: 'continue_current_task' | 'urgent_override' | 'ready_high_score';
  reasoning: string;
  claim_args: {
    repo_root: string;
    plan_slug: string;
    subtask_index: number;
    session_id: string;
    agent: string;
    file_scope: string[];
  };
}

interface ClaimResult {
  task_id: number;
  branch: string;
  file_scope: string[];
}

async function claimSubtask(
  planSlug: string,
  subtaskIndex: number,
  sessionId = 'agent-session',
  agent = 'codex',
): Promise<ClaimResult> {
  return call<ClaimResult>('task_plan_claim_subtask', {
    plan_slug: planSlug,
    subtask_index: subtaskIndex,
    session_id: sessionId,
    agent,
  });
}

async function claimAndComplete(planSlug: string, subtaskIndex: number): Promise<void> {
  await claimSubtask(planSlug, subtaskIndex);
  await call('task_plan_complete_subtask', {
    plan_slug: planSlug,
    subtask_index: subtaskIndex,
    session_id: 'agent-session',
    summary: `sub-${subtaskIndex} complete`,
  });
}

interface ReadyResult {
  ready: ReadyEntry[];
  total_available: number;
  mcp_capability_map: { summary: string[]; unknown_servers: string[] };
  next_action: string;
  next_tool?: 'task_plan_claim_subtask';
  plan_slug?: string;
  subtask_index?: number;
  reason?: 'continue_current_task' | 'urgent_override' | 'ready_high_score';
  claim_args?: {
    repo_root: string;
    plan_slug: string;
    subtask_index: number;
    session_id: string;
    agent: string;
    file_scope: string[];
  };
  codex_mcp_call?: string;
  next_action_reason?: string;
  empty_state?: string;
}

const EMPTY_READY_STATE =
  'No claimable plan subtasks. Publish a Queen/task plan for multi-agent work, or use task_list only for browsing.';

async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}';
  return JSON.parse(text) as T;
}

function publishArgs(
  subtasks: Array<Record<string, unknown>>,
  overrides: Partial<{
    slug: string;
    session_id: string;
    agent: string;
    title: string;
  }> = {},
): Record<string, unknown> {
  return {
    repo_root: repoRoot,
    slug: overrides.slug ?? 'ready-plan',
    session_id: overrides.session_id ?? 'planner',
    agent: overrides.agent ?? 'claude',
    title: overrides.title ?? 'Ready plan',
    problem: 'Agents need ranked work.',
    acceptance_criteria: ['Ready queue ranks available work'],
    subtasks,
  };
}

function taskIdForSubtask(planSlug: string, subtaskIndex: number): number {
  const task = store.storage
    .listTasks(2000)
    .find((entry) => entry.branch === `spec/${planSlug}/sub-${subtaskIndex}`);
  expect(task).toBeDefined();
  return task?.id ?? -1;
}

function blockSubtask(planSlug: string, subtaskIndex: number, taskId: number): void {
  store.addObservation({
    session_id: 'agent-session',
    task_id: taskId,
    kind: 'plan-subtask-claim',
    content: `sub-${subtaskIndex} blocked`,
    metadata: {
      status: 'blocked',
      session_id: 'agent-session',
      agent: 'codex',
      plan_slug: planSlug,
      subtask_index: subtaskIndex,
    },
  });
}

function releaseSubtaskClaim(
  planSlug: string,
  subtaskIndex: number,
  taskId: number,
  sessionId = 'agent-session',
  agent = 'codex',
): void {
  const claims = store.storage.listClaims(taskId).filter((claim) => claim.session_id === sessionId);
  for (const claim of claims) {
    store.storage.releaseClaim({
      task_id: taskId,
      file_path: claim.file_path,
      session_id: sessionId,
    });
  }
  store.addObservation({
    session_id: sessionId,
    task_id: taskId,
    kind: 'plan-subtask-claim',
    content: `sub-${subtaskIndex} released and requeued`,
    metadata: {
      status: 'available',
      session_id: sessionId,
      agent,
      plan_slug: planSlug,
      subtask_index: subtaskIndex,
      released_files: claims.map((claim) => claim.file_path),
    },
  });
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'colony-ready-data-'));
  repoRoot = mkdtempSync(join(tmpdir(), 'colony-ready-repo-'));
  writeFileSync(join(repoRoot, 'SPEC.md'), '# SPEC\n', 'utf8');
  store = new MemoryStore({ dbPath: join(dataDir, 'data.db'), settings: defaultSettings });
  store.startSession({ id: 'planner', ide: 'claude-code', cwd: repoRoot });
  store.startSession({ id: 'queen', ide: 'queen', cwd: repoRoot });
  store.startSession({ id: 'agent-session', ide: 'codex', cwd: repoRoot });
  store.startSession({ id: 'other-session', ide: 'claude-code', cwd: repoRoot });
  const server = buildServer(store, defaultSettings);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
});

afterEach(async () => {
  vi.useRealTimers();
  await client.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(repoRoot, { recursive: true, force: true });
});

describe('task_ready_for_agent', () => {
  it('returns an empty ready queue when no plans exist', async () => {
    const result = await call<ReadyResult>('task_ready_for_agent', {
      session_id: 'agent-session',
      agent: 'codex',
      repo_root: repoRoot,
    });

    expect(result.ready).toEqual([]);
    expect(result.total_available).toBe(0);
    expect(result.mcp_capability_map.summary).toEqual(expect.any(Array));
    expect(result.empty_state).toBe(EMPTY_READY_STATE);
    expect(result.next_tool).toBeUndefined();
    expect(result.next_action).toBe('Publish a Queen/task plan for multi-agent work.');
  });

  it('returns exact claim args for a ready sub-task', async () => {
    await call('task_plan_publish', {
      ...publishArgs(
        [
          {
            title: 'Build claimable API',
            description: 'Expose the claimable endpoint.',
            file_scope: ['apps/api/claimable.ts'],
            capability_hint: 'api_work',
          },
          {
            title: 'Document claimable API',
            description: 'Document the claimable endpoint.',
            file_scope: ['docs/claimable.md'],
            depends_on: [0],
            capability_hint: 'doc_work',
          },
        ],
        { slug: 'claimable-plan' },
      ),
    });

    const result = await call<ReadyResult>('task_ready_for_agent', {
      session_id: 'agent-session',
      agent: 'codex',
      repo_root: repoRoot,
    });

    expect(result.ready.map((entry) => entry.subtask_index)).toEqual([0]);
    expect(result.next_tool).toBe('task_plan_claim_subtask');
    expect(result.plan_slug).toBe('claimable-plan');
    expect(result.subtask_index).toBe(0);
    expect(result.reason).toBe('ready_high_score');
    expect(result.next_action_reason).toBe(
      'Claim claimable-plan/sub-0: it is unclaimed, dependencies are met, and it is the highest-ranked claimable ready item.',
    );
    expect(result.next_action).toContain('task_plan_claim_subtask');
    expect(result.next_action).toContain('plan_slug="claimable-plan"');
    expect(result.ready[0]).toMatchObject({
      next_tool: 'task_plan_claim_subtask',
      next_action_reason:
        'Claim claimable-plan/sub-0: it is unclaimed, dependencies are met, and it is the highest-ranked claimable ready item.',
    });
    expect(result.claim_args).toEqual({
      repo_root: repoRoot,
      plan_slug: 'claimable-plan',
      subtask_index: 0,
      session_id: 'agent-session',
      agent: 'codex',
      file_scope: ['apps/api/claimable.ts'],
    });
    expect(result.codex_mcp_call).toBe(
      `mcp__colony__task_plan_claim_subtask({ agent: "codex", session_id: "agent-session", repo_root: ${JSON.stringify(repoRoot)}, plan_slug: "claimable-plan", subtask_index: 0, file_scope: ["apps/api/claimable.ts"] })`,
    );
    expect(result.empty_state).toBeUndefined();
  });

  it('makes ready output directly claimable so agents do not stop at discovery', async () => {
    await call('task_plan_publish', {
      ...publishArgs(
        [
          {
            title: 'Claim from ready output',
            description: 'Agent should claim this directly from ready queue metadata.',
            file_scope: ['apps/api/direct-claim.ts'],
            capability_hint: 'api_work',
          },
          {
            title: 'Follow after ready claim',
            description: 'Dependent work stays blocked until the claimable item finishes.',
            file_scope: ['docs/direct-claim.md'],
            depends_on: [0],
            capability_hint: 'doc_work',
          },
        ],
        { slug: 'direct-ready-claim' },
      ),
    });

    const result = await call<ReadyResult>('task_ready_for_agent', {
      session_id: 'agent-session',
      agent: 'codex',
      repo_root: repoRoot,
    });

    expect(result.ready).toHaveLength(1);
    expect(result.ready[0]).toMatchObject({
      next_tool: 'task_plan_claim_subtask',
      next_action_reason:
        'Claim direct-ready-claim/sub-0: it is unclaimed, dependencies are met, and it is the highest-ranked claimable ready item.',
      claim_args: {
        repo_root: repoRoot,
        plan_slug: 'direct-ready-claim',
        subtask_index: 0,
        session_id: 'agent-session',
        agent: 'codex',
        file_scope: ['apps/api/direct-claim.ts'],
      },
    });

    const claimed = await call<ClaimResult>(
      result.ready[0]?.next_tool ?? 'missing_next_tool',
      result.ready[0]?.claim_args ?? {},
    );
    expect(claimed).toMatchObject({
      branch: 'spec/direct-ready-claim/sub-0',
      file_scope: ['apps/api/direct-claim.ts'],
    });
  });

  it('returns the empty state when all future sub-tasks are blocked', async () => {
    await call('task_plan_publish', {
      ...publishArgs(
        [
          {
            title: 'Blocked dependency',
            description: 'This dependency is blocked.',
            file_scope: ['apps/api/blocked-dependency.ts'],
            capability_hint: 'api_work',
          },
          {
            title: 'Future UI',
            description: 'Cannot start until the dependency completes.',
            file_scope: ['apps/web/future.tsx'],
            depends_on: [0],
            capability_hint: 'ui_work',
          },
        ],
        { slug: 'blocked-future-plan' },
      ),
    });
    const claim = await claimSubtask('blocked-future-plan', 0);
    blockSubtask('blocked-future-plan', 0, claim.task_id);

    const result = await call<ReadyResult>('task_ready_for_agent', {
      session_id: 'agent-session',
      agent: 'codex',
      repo_root: repoRoot,
    });

    expect(result.ready).toEqual([]);
    expect(result.total_available).toBe(0);
    expect(result.empty_state).toBe(EMPTY_READY_STATE);
    expect(result.next_tool).toBeUndefined();
    expect(result.codex_mcp_call).toBeUndefined();
    expect(result.next_action).toBe(
      'Complete upstream dependencies or unblock current plan waves before claiming more work.',
    );
  });

  it('makes a stale blocked wave claimable again after rescue release', async () => {
    const t0 = Date.parse('2026-04-28T12:00:00.000Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0);
    store.startSession({ id: 'stale-session', ide: 'codex', cwd: repoRoot });

    await call('task_plan_publish', {
      ...publishArgs(
        [
          {
            title: 'Stale claimed blocker',
            description: 'This stale claim blocks later waves until release.',
            file_scope: ['apps/api/stale-blocker.ts'],
            capability_hint: 'api_work',
          },
          {
            title: 'Wave two API',
            description: 'Unlocks after the stale blocker completes.',
            file_scope: ['apps/api/wave-two.ts'],
            depends_on: [0],
            capability_hint: 'api_work',
          },
          {
            title: 'Wave three finalizer',
            description: 'Unlocks after wave two completes.',
            file_scope: ['apps/mcp-server/test/stale-blocker.test.ts'],
            depends_on: [1],
            capability_hint: 'test_work',
          },
        ],
        { slug: 'stale-release-plan', session_id: 'queen', agent: 'queen' },
      ),
    });
    const staleClaim = await claimSubtask('stale-release-plan', 0, 'stale-session');

    vi.setSystemTime(t0 + 5 * 60 * 60_000);
    let result = await call<ReadyResult>('task_ready_for_agent', {
      session_id: 'agent-session',
      agent: 'codex',
      repo_root: repoRoot,
      limit: 10,
    });

    expect(result.ready).toEqual([]);
    expect(result.total_available).toBe(0);
    expect(result.next_tool).toBeUndefined();
    expect(result.next_action).toBe(
      'Complete upstream dependencies or unblock current plan waves before claiming more work.',
    );

    releaseSubtaskClaim('stale-release-plan', 0, staleClaim.task_id, 'stale-session');
    result = await call<ReadyResult>('task_ready_for_agent', {
      session_id: 'agent-session',
      agent: 'codex',
      repo_root: repoRoot,
      limit: 10,
    });

    expect(result.ready.map((entry) => entry.subtask_index)).toEqual([0]);
    expect(result.ready[0]).toMatchObject({
      plan_slug: 'stale-release-plan',
      wave_index: 0,
      wave_name: 'Wave 1',
      blocked_by_count: 0,
      claim_args: {
        plan_slug: 'stale-release-plan',
        subtask_index: 0,
        session_id: 'agent-session',
        agent: 'codex',
      },
    });
    expect(result.next_tool).toBe('task_plan_claim_subtask');
    expect(result.claim_args).toMatchObject({
      plan_slug: 'stale-release-plan',
      subtask_index: 0,
      session_id: 'agent-session',
      agent: 'codex',
    });

    await claimAndComplete('stale-release-plan', 0);
    result = await call<ReadyResult>('task_ready_for_agent', {
      session_id: 'agent-session',
      agent: 'codex',
      repo_root: repoRoot,
      limit: 10,
    });

    expect(result.ready.map((entry) => entry.subtask_index)).toEqual([1]);
    expect(result.ready[0]).toMatchObject({
      wave_index: 1,
      wave_name: 'Wave 2',
      blocked_by_count: 0,
      claim_args: {
        plan_slug: 'stale-release-plan',
        subtask_index: 1,
        session_id: 'agent-session',
        agent: 'codex',
      },
    });
  });

  it('continues an already claimed sub-task without fabricating a new claim call', async () => {
    await call('task_plan_publish', {
      ...publishArgs(
        [
          {
            title: 'Already claimed API',
            description: 'Work already claimed by this agent.',
            file_scope: ['apps/api/already-claimed.ts'],
            capability_hint: 'api_work',
          },
          {
            title: 'Future dependent docs',
            description: 'Not claimable until the already-claimed work completes.',
            file_scope: ['docs/already-claimed.md'],
            depends_on: [0],
            capability_hint: 'doc_work',
          },
        ],
        { slug: 'already-claimed-plan' },
      ),
    });
    await claimSubtask('already-claimed-plan', 0);

    const result = await call<ReadyResult>('task_ready_for_agent', {
      session_id: 'agent-session',
      agent: 'codex',
      repo_root: repoRoot,
    });

    expect(result.ready).toHaveLength(1);
    expect(result.ready[0]).toMatchObject({
      plan_slug: 'already-claimed-plan',
      subtask_index: 0,
      reason: 'continue_current_task',
    });
    expect(result.total_available).toBe(0);
    expect(result.next_action).toContain('Continue claimed sub-task');
    expect(result.next_tool).toBeUndefined();
    expect(result.claim_args).toBeUndefined();
    expect(result.codex_mcp_call).toBeUndefined();
    expect(result.empty_state).toBeUndefined();
  });

  it('walks the current adoption-fix waves through ready work and claim flow', async () => {
    await call('task_plan_publish', {
      repo_root: repoRoot,
      slug: colonyAdoptionFixesPlan.slug,
      session_id: 'queen',
      agent: 'queen',
      title: colonyAdoptionFixesPlan.title,
      problem: colonyAdoptionFixesPlan.problem,
      acceptance_criteria: colonyAdoptionFixesPlan.acceptance_criteria,
      subtasks: colonyAdoptionFixesPlan.subtasks,
      auto_archive: false,
    });

    let result = await call<ReadyResult>('task_ready_for_agent', {
      session_id: 'agent-session',
      agent: 'codex',
      repo_root: repoRoot,
      limit: 10,
    });

    expect(result.total_available).toBe(3);
    expect(result.ready.map((entry) => entry.subtask_index).sort((a, b) => a - b)).toEqual([
      0, 1, 2,
    ]);
    expect(new Set(result.ready.map((entry) => entry.wave_index))).toEqual(new Set([0]));
    expect(result.ready.map((entry) => entry.title)).toEqual(
      expect.arrayContaining([
        'Codex/OMX claim-before-edit bridge',
        'Active task binding for auto-claim',
        'Strengthen hivemind_context to attention_inbox funnel',
      ]),
    );
    for (const entry of result.ready) {
      expect(entry.claim_args).toEqual({
        repo_root: repoRoot,
        plan_slug: colonyAdoptionFixesPlan.slug,
        subtask_index: entry.subtask_index,
        session_id: 'agent-session',
        agent: 'codex',
        file_scope: entry.file_scope,
      });
      expect(entry.next_tool).toBe('task_plan_claim_subtask');
      expect(entry.next_action_reason).toContain(
        `Claim ${colonyAdoptionFixesPlan.slug}/sub-${entry.subtask_index}:`,
      );
    }
    expect(result.ready.map((entry) => entry.subtask_index)).not.toContain(3);
    expect(result.ready.map((entry) => entry.subtask_index)).not.toContain(6);
    expect(result.next_action).toContain('task_plan_claim_subtask');
    expect(result.next_action).toContain('plan_slug="colony-adoption-fixes"');
    expect(result.next_tool).toBe('task_plan_claim_subtask');
    expect(result.plan_slug).toBe(colonyAdoptionFixesPlan.slug);
    expect(result.subtask_index).toBe(result.ready[0]?.subtask_index);
    expect(result.claim_args).toEqual({
      repo_root: repoRoot,
      plan_slug: colonyAdoptionFixesPlan.slug,
      subtask_index: result.ready[0]?.subtask_index,
      session_id: 'agent-session',
      agent: 'codex',
      file_scope: result.ready[0]?.file_scope,
    });

    const claimed = await claimSubtask(
      colonyAdoptionFixesPlan.slug,
      result.ready[0]?.subtask_index ?? 0,
    );
    expect(claimed.branch).toMatch(/^spec\/colony-adoption-fixes\/sub-/);
    expect(claimed.file_scope.length).toBeGreaterThan(0);

    await call('task_plan_complete_subtask', {
      plan_slug: colonyAdoptionFixesPlan.slug,
      subtask_index: result.ready[0]?.subtask_index ?? 0,
      session_id: 'agent-session',
      summary: 'claimed ready subtask complete',
    });
    for (const subtaskIndex of [0, 1, 2].filter((index) => index !== result.subtask_index)) {
      await claimAndComplete(colonyAdoptionFixesPlan.slug, subtaskIndex);
    }

    result = await call<ReadyResult>('task_ready_for_agent', {
      session_id: 'agent-session',
      agent: 'codex',
      repo_root: repoRoot,
      limit: 10,
    });

    expect(result.ready.map((entry) => entry.subtask_index).sort((a, b) => a - b)).toEqual([
      3, 4, 5,
    ]);
    expect(new Set(result.ready.map((entry) => entry.wave_index))).toEqual(new Set([1]));
    expect(result.ready.map((entry) => entry.subtask_index)).not.toContain(6);

    await claimAndComplete(colonyAdoptionFixesPlan.slug, 3);
    await claimAndComplete(colonyAdoptionFixesPlan.slug, 4);
    await claimAndComplete(colonyAdoptionFixesPlan.slug, 5);

    result = await call<ReadyResult>('task_ready_for_agent', {
      session_id: 'agent-session',
      agent: 'codex',
      repo_root: repoRoot,
      limit: 10,
    });

    expect(result.ready.map((entry) => entry.subtask_index)).toEqual([6]);
    expect(result.ready[0]).toMatchObject({
      plan_slug: colonyAdoptionFixesPlan.slug,
      wave_index: 2,
      wave_name: 'Wave 3',
      blocked_by_count: 0,
      title: 'Finalize docs, tests, and health',
      claim_args: {
        repo_root: repoRoot,
        plan_slug: colonyAdoptionFixesPlan.slug,
        subtask_index: 6,
        session_id: 'agent-session',
        agent: 'codex',
        file_scope: [
          'docs/QUEEN.md',
          'apps/cli/src/commands/health.ts',
          'apps/cli/test/queen-health.test.ts',
          'apps/mcp-server/test/coordination-loop.test.ts',
          'packages/queen/test/decompose.test.ts',
        ],
      },
    });
  });

  it('ranks the sub-task matching the agent capability first', async () => {
    await call('agent_upsert_profile', {
      agent: 'codex',
      capabilities: { api_work: 0.9, ui_work: 0.1 },
    });
    await call('task_plan_publish', {
      ...publishArgs([
        {
          title: 'Build page',
          description: 'Render the page.',
          file_scope: ['apps/web/page.tsx'],
          capability_hint: 'ui_work',
        },
        {
          title: 'Build API',
          description: 'Expose the endpoint.',
          file_scope: ['apps/api/widgets.ts'],
          capability_hint: 'api_work',
        },
      ]),
    });

    const result = await call<ReadyResult>('task_ready_for_agent', {
      session_id: 'agent-session',
      agent: 'codex',
      repo_root: repoRoot,
    });

    expect(result.ready.map((entry) => entry.title)).toEqual(['Build API', 'Build page']);
    expect(result.ready[0]?.fit_score).toBeGreaterThan(result.ready[1]?.fit_score ?? 0);
  });

  it('boosts queen-published plan sub-tasks ahead of equal manual plan sub-tasks', async () => {
    await call('agent_upsert_profile', {
      agent: 'codex',
      capabilities: { api_work: 0.9 },
    });
    await call('task_plan_publish', {
      ...publishArgs(
        [
          {
            title: 'Manual API one',
            description: 'Manual task with same capability.',
            file_scope: ['apps/api/manual-one.ts'],
            capability_hint: 'api_work',
          },
          {
            title: 'Manual API two',
            description: 'Manual task with same capability.',
            file_scope: ['apps/api/manual-two.ts'],
            capability_hint: 'api_work',
          },
        ],
        { slug: 'manual-plan', session_id: 'planner', agent: 'claude', title: 'Manual plan' },
      ),
    });
    await call('task_plan_publish', {
      ...publishArgs(
        [
          {
            title: 'Queen API one',
            description: 'Queen task with same capability.',
            file_scope: ['apps/api/queen-one.ts'],
            capability_hint: 'api_work',
          },
          {
            title: 'Queen API two',
            description: 'Queen task with same capability.',
            file_scope: ['apps/api/queen-two.ts'],
            capability_hint: 'api_work',
          },
        ],
        { slug: 'queen-plan', session_id: 'queen', agent: 'queen', title: 'Queen plan' },
      ),
    });

    const result = await call<ReadyResult>('task_ready_for_agent', {
      session_id: 'agent-session',
      agent: 'codex',
      repo_root: repoRoot,
    });

    expect(result.ready.map((entry) => entry.plan_slug)).toEqual([
      'queen-plan',
      'queen-plan',
      'manual-plan',
      'manual-plan',
    ]);
    expect(result.ready[0]?.fit_score).toBe(1);
    expect(result.ready[0]?.reasoning).toContain('queen-published plan, +0.1 fit boost');
    expect(result.ready[2]?.fit_score).toBe(0.9);
    expect(result.ready[2]?.reasoning).not.toContain('queen-published plan');
  });

  it('clamps queen fit boost at a maximum score of 1.0', async () => {
    await call('agent_upsert_profile', {
      agent: 'codex',
      capabilities: { api_work: 1 },
    });
    await call('task_plan_publish', {
      ...publishArgs(
        [
          {
            title: 'Queen max API one',
            description: 'Already max-fit queen task.',
            file_scope: ['apps/api/queen-max-one.ts'],
            capability_hint: 'api_work',
          },
          {
            title: 'Queen max API two',
            description: 'Already max-fit queen task.',
            file_scope: ['apps/api/queen-max-two.ts'],
            capability_hint: 'api_work',
          },
        ],
        { slug: 'queen-max-plan', session_id: 'queen', agent: 'queen', title: 'Queen max plan' },
      ),
    });

    const result = await call<ReadyResult>('task_ready_for_agent', {
      session_id: 'agent-session',
      agent: 'codex',
      repo_root: repoRoot,
    });

    expect(result.ready).toHaveLength(2);
    expect(result.ready.every((entry) => entry.fit_score === 1)).toBe(true);
    expect(result.ready.every((entry) => entry.reasoning.includes('queen-published plan'))).toBe(
      true,
    );
  });

  it('ranks an unconflicted sub-task before an equal-capability scope conflict', async () => {
    await call('agent_upsert_profile', {
      agent: 'codex',
      capabilities: { api_work: 0.8 },
    });
    await call('task_plan_publish', {
      ...publishArgs([
        {
          title: 'Conflicted API',
          description: 'Touches a file currently claimed elsewhere.',
          file_scope: ['apps/api/conflicted.ts'],
          capability_hint: 'api_work',
        },
        {
          title: 'Clear API',
          description: 'Touches a clear file.',
          file_scope: ['apps/api/clear.ts'],
          capability_hint: 'api_work',
        },
      ]),
    });
    const thread = TaskThread.open(store, {
      repo_root: repoRoot,
      branch: 'agent/other/conflict',
      session_id: 'other-session',
    });
    thread.claimFile({ session_id: 'other-session', file_path: 'apps/api/conflicted.ts' });

    const result = await call<ReadyResult>('task_ready_for_agent', {
      session_id: 'agent-session',
      agent: 'codex',
      repo_root: repoRoot,
    });

    expect(result.ready.map((entry) => entry.title)).toEqual(['Clear API', 'Conflicted API']);
    expect(result.ready[0]?.reasoning).toContain('scope clear of live claims');
    expect(result.ready[1]?.reasoning).toContain('1 of 1 files in scope held by');
  });

  it('does not rank stale claims as live scope conflicts', async () => {
    const t0 = Date.parse('2026-04-28T12:00:00.000Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0);
    await call('task_plan_publish', {
      ...publishArgs([
        {
          title: 'Previously conflicted API',
          description: 'Touches a file with only a stale claim.',
          file_scope: ['apps/api/conflicted.ts'],
          capability_hint: 'api_work',
        },
        {
          title: 'Clear API',
          description: 'Touches a clear file.',
          file_scope: ['apps/api/clear.ts'],
          capability_hint: 'api_work',
        },
      ]),
      slug: 'ready-stale-claim-plan',
    });
    const thread = TaskThread.open(store, {
      repo_root: repoRoot,
      branch: 'agent/other/stale-conflict',
      session_id: 'other-session',
    });
    thread.claimFile({ session_id: 'other-session', file_path: 'apps/api/conflicted.ts' });

    vi.setSystemTime(t0 + 241 * 60_000);

    const result = await call<ReadyResult>('task_ready_for_agent', {
      session_id: 'agent-session',
      agent: 'codex',
      repo_root: repoRoot,
    });

    const previouslyConflicted = result.ready.find(
      (entry) => entry.title === 'Previously conflicted API',
    );
    expect(previouslyConflicted?.reasoning).toContain('scope clear of live claims');
  });

  it('omits sub-tasks with unmet dependencies', async () => {
    await call('task_plan_publish', {
      ...publishArgs([
        {
          title: 'Build API first',
          description: 'The dependency.',
          file_scope: ['apps/api/widgets.ts'],
          capability_hint: 'api_work',
        },
        {
          title: 'Build UI second',
          description: 'Depends on the API.',
          file_scope: ['apps/web/widgets.tsx'],
          depends_on: [0],
          capability_hint: 'ui_work',
        },
      ]),
    });

    const result = await call<ReadyResult>('task_ready_for_agent', {
      session_id: 'agent-session',
      agent: 'codex',
      repo_root: repoRoot,
    });

    expect(result.ready.map((entry) => entry.title)).toEqual(['Build API first']);
    expect(result.total_available).toBe(1);
  });

  it('walks queen waves through ready work as dependencies complete', async () => {
    await call('task_plan_publish', {
      ...publishArgs(
        [
          {
            title: 'Wave one API',
            description: 'First wave API task.',
            file_scope: ['apps/api/one.ts'],
            capability_hint: 'api_work',
          },
          {
            title: 'Wave one UI',
            description: 'First wave UI task.',
            file_scope: ['apps/web/one.tsx'],
            capability_hint: 'ui_work',
          },
          {
            title: 'Wave two API',
            description: 'Second wave API task.',
            file_scope: ['apps/api/two.ts'],
            depends_on: [0, 1],
            capability_hint: 'api_work',
          },
          {
            title: 'Wave two UI',
            description: 'Second wave UI task.',
            file_scope: ['apps/web/two.tsx'],
            depends_on: [0, 1],
            capability_hint: 'ui_work',
          },
          {
            title: 'Final verification',
            description: 'Final wave verifies previous work.',
            file_scope: ['apps/mcp-server/test/waves.test.ts'],
            depends_on: [2, 3],
            capability_hint: 'test_work',
          },
        ],
        {
          slug: 'queen-three-wave-plan',
          session_id: 'queen',
          agent: 'queen',
          title: 'Queen waves',
        },
      ),
    });

    let result = await call<ReadyResult>('task_ready_for_agent', {
      session_id: 'agent-session',
      agent: 'codex',
      repo_root: repoRoot,
      limit: 10,
    });

    expect(result.ready.map((entry) => entry.subtask_index)).toEqual([0, 1]);
    expect(result.ready.map((entry) => entry.wave_index)).toEqual([0, 0]);
    expect(result.ready.map((entry) => entry.wave_name)).toEqual(['Wave 1', 'Wave 1']);
    expect(result.ready.map((entry) => entry.blocked_by_count)).toEqual([0, 0]);

    await claimAndComplete('queen-three-wave-plan', 0);
    await claimAndComplete('queen-three-wave-plan', 1);
    result = await call<ReadyResult>('task_ready_for_agent', {
      session_id: 'agent-session',
      agent: 'codex',
      repo_root: repoRoot,
      limit: 10,
    });

    expect(result.ready.map((entry) => entry.subtask_index)).toEqual([2, 3]);
    expect(result.ready.map((entry) => entry.wave_index)).toEqual([1, 1]);
    expect(result.ready.map((entry) => entry.wave_name)).toEqual(['Wave 2', 'Wave 2']);
    expect(result.ready.map((entry) => entry.blocked_by_count)).toEqual([0, 0]);

    await claimAndComplete('queen-three-wave-plan', 2);
    await claimAndComplete('queen-three-wave-plan', 3);
    result = await call<ReadyResult>('task_ready_for_agent', {
      session_id: 'agent-session',
      agent: 'codex',
      repo_root: repoRoot,
      limit: 10,
    });

    expect(result.ready.map((entry) => entry.subtask_index)).toEqual([4]);
    expect(result.ready[0]).toMatchObject({
      plan_slug: 'queen-three-wave-plan',
      wave_index: 2,
      wave_name: 'Wave 3',
      blocked_by_count: 0,
    });
  });

  it('returns non-empty reasoning with score components for every entry', async () => {
    await call('agent_upsert_profile', {
      agent: 'codex',
      capabilities: { api_work: 0.84 },
    });
    await call('task_plan_publish', {
      ...publishArgs([
        {
          title: 'Build API',
          description: 'Expose the endpoint.',
          file_scope: ['apps/api/widgets.ts'],
          capability_hint: 'api_work',
        },
        {
          title: 'Build UI after API',
          description: 'Depends on the endpoint.',
          file_scope: ['apps/web/widgets.tsx'],
          depends_on: [0],
          capability_hint: 'ui_work',
        },
      ]),
    });

    const result = await call<ReadyResult>('task_ready_for_agent', {
      session_id: 'agent-session',
      agent: 'codex',
      repo_root: repoRoot,
    });

    expect(result.ready).toHaveLength(1);
    for (const entry of result.ready) {
      expect(entry.reasoning).not.toHaveLength(0);
      expect(entry.reasoning).toContain('strong api_work fit (0.84)');
      expect(entry.reasoning).toContain('scope clear of live claims');
      expect(entry.reasoning).toContain('recent claim density 0');
    }
  });

  it('keeps the current claimed sub-task ahead of slightly higher new work', async () => {
    await call('agent_upsert_profile', {
      agent: 'codex',
      capabilities: { api_work: 0.7, ui_work: 0.76 },
    });
    await call('task_plan_publish', {
      ...publishArgs(
        [
          {
            title: 'Continue API',
            description: 'Current claimed work.',
            file_scope: ['apps/api/current.ts'],
            capability_hint: 'api_work',
          },
          {
            title: 'New UI signal',
            description: 'Slightly higher fit, but not enough to switch.',
            file_scope: ['apps/web/new-signal.tsx'],
            capability_hint: 'ui_work',
          },
        ],
        { slug: 'stay-bias-plan' },
      ),
    });
    await claimSubtask('stay-bias-plan', 0);

    const result = await call<ReadyResult>('task_ready_for_agent', {
      session_id: 'agent-session',
      agent: 'codex',
      repo_root: repoRoot,
      limit: 10,
    });

    expect(result.total_available).toBe(1);
    expect(result.ready.map((entry) => entry.title)).toEqual(['Continue API', 'New UI signal']);
    expect(result.ready[0]).toMatchObject({
      title: 'Continue API',
      reason: 'continue_current_task',
    });
    expect(result.ready[1]?.fit_score).toBeGreaterThan(result.ready[0]?.fit_score ?? 0);
  });

  it('lets a blocking urgent message override stay-on-task bias', async () => {
    await call('agent_upsert_profile', {
      agent: 'codex',
      capabilities: { api_work: 0.7, ui_work: 0.76 },
    });
    await call('task_plan_publish', {
      ...publishArgs(
        [
          {
            title: 'Continue API',
            description: 'Current claimed work.',
            file_scope: ['apps/api/current-urgent.ts'],
            capability_hint: 'api_work',
          },
          {
            title: 'Urgent UI signal',
            description: 'Blocking message should allow switching.',
            file_scope: ['apps/web/urgent-signal.tsx'],
            capability_hint: 'ui_work',
          },
        ],
        { slug: 'urgent-bias-plan' },
      ),
    });
    await claimSubtask('urgent-bias-plan', 0);
    const urgentTask = new TaskThread(store, taskIdForSubtask('urgent-bias-plan', 1));
    urgentTask.join('agent-session', 'codex');
    urgentTask.postMessage({
      from_session_id: 'planner',
      from_agent: 'claude',
      to_agent: 'codex',
      to_session_id: 'agent-session',
      urgency: 'blocking',
      content: 'blocking handoff needs the UI lane now',
    });

    const result = await call<ReadyResult>('task_ready_for_agent', {
      session_id: 'agent-session',
      agent: 'codex',
      repo_root: repoRoot,
      limit: 10,
    });

    expect(result.ready.map((entry) => entry.title)).toEqual(['Urgent UI signal', 'Continue API']);
    expect(result.ready[0]).toMatchObject({
      title: 'Urgent UI signal',
      reason: 'urgent_override',
    });
  });

  it('removes stay-on-task bias after the current sub-task completes', async () => {
    await call('agent_upsert_profile', {
      agent: 'codex',
      capabilities: { api_work: 0.7, ui_work: 0.76 },
    });
    await call('task_plan_publish', {
      ...publishArgs(
        [
          {
            title: 'Completing API',
            description: 'Current work that finishes.',
            file_scope: ['apps/api/completing.ts'],
            capability_hint: 'api_work',
          },
          {
            title: 'Ready UI after completion',
            description: 'Ready work after current completion.',
            file_scope: ['apps/web/after-completion.tsx'],
            capability_hint: 'ui_work',
          },
        ],
        { slug: 'completed-bias-plan' },
      ),
    });
    await claimAndComplete('completed-bias-plan', 0);

    const result = await call<ReadyResult>('task_ready_for_agent', {
      session_id: 'agent-session',
      agent: 'codex',
      repo_root: repoRoot,
      limit: 10,
    });

    expect(result.ready.map((entry) => entry.title)).toEqual(['Ready UI after completion']);
    expect(result.ready[0]).toMatchObject({
      title: 'Ready UI after completion',
      reason: 'ready_high_score',
    });
  });

  it('removes stay-on-task bias after the current sub-task is blocked', async () => {
    await call('agent_upsert_profile', {
      agent: 'codex',
      capabilities: { api_work: 0.7, ui_work: 0.76 },
    });
    await call('task_plan_publish', {
      ...publishArgs(
        [
          {
            title: 'Blocked API',
            description: 'Current work that hits a blocker.',
            file_scope: ['apps/api/blocked.ts'],
            capability_hint: 'api_work',
          },
          {
            title: 'Ready UI after block',
            description: 'Ready work after blocker.',
            file_scope: ['apps/web/after-block.tsx'],
            capability_hint: 'ui_work',
          },
        ],
        { slug: 'blocked-bias-plan' },
      ),
    });
    const claim = await claimSubtask('blocked-bias-plan', 0);
    blockSubtask('blocked-bias-plan', 0, claim.task_id);

    const result = await call<ReadyResult>('task_ready_for_agent', {
      session_id: 'agent-session',
      agent: 'codex',
      repo_root: repoRoot,
      limit: 10,
    });

    expect(result.ready.map((entry) => entry.title)).toEqual(['Ready UI after block']);
    expect(result.ready[0]).toMatchObject({
      title: 'Ready UI after block',
      reason: 'ready_high_score',
    });
  });
});
