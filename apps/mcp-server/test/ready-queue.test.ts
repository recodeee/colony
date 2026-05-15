import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { MemoryStore, TaskThread } from '@colony/core';
import { colonyAdoptionFixesPlan } from '@colony/queen';
import { Client } from '@modelcontextprotocol/sdk/client';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/server.js';

let dataDir: string;
let repoRoot: string;
let store: MemoryStore;
let client: Client;

interface ReadyEntry {
  priority?: number;
  next_tool?: 'task_plan_claim_subtask';
  next_action_reason?: string;
  codex_mcp_call?: string;
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
  assigned_agent?: string;
  routing_reason?: string;
  claim_args: {
    repo_root: string;
    plan_slug: string;
    subtask_index: number;
    session_id: string;
    agent: string;
    file_scope: string[];
  };
}

interface QuotaRelayReadyEntry {
  kind: 'quota_relay_ready';
  priority?: number;
  next_tool: 'task_claim_quota_accept';
  next_action_reason: string;
  codex_mcp_call?: string;
  task_id: number;
  old_session_id: string;
  old_owner: {
    session_id: string;
    agent: string | null;
  };
  files: string[];
  file_count: number;
  active_files: string[];
  active_file_count: number;
  evidence: string;
  next: string;
  age: {
    milliseconds: number;
    minutes: number;
  };
  repo_root: string;
  branch: string;
  expires_at: number | null;
  has_active_files: boolean;
  blocks_downstream: boolean;
  quota_observation_id: number;
  quota_observation_kind: 'handoff' | 'relay';
  task_active: boolean;
  claim_args: {
    task_id: number;
    session_id: string;
    agent: string;
    handoff_observation_id: number;
  };
}

interface ClaimResult {
  task_id: number;
  branch: string;
  file_scope: string[];
}

interface SqlDatabase {
  prepare(sql: string): { run(...args: unknown[]): unknown };
}

interface StorageWithDb {
  db: SqlDatabase;
}

interface QuotaAcceptResult {
  status: 'accepted';
  task_id: number;
  handoff_observation_id: number;
  baton_kind: 'handoff' | 'relay';
  accepted_by_session_id: string;
  accepted_files: string[];
  previous_session_ids: string[];
  audit_observation_id: number;
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
  mcp_capability_map?: { summary: string[]; unknown_servers: string[] };
  ready_scope_overlap_warnings: Array<{
    code: 'ready_scope_overlap';
    severity: 'warning';
    plan_slug: string;
    wave_index: number | null;
    wave_name: string;
    file_path: string;
    protected: boolean;
    subtask_indexes: number[];
    titles: string[];
    message: string;
  }>;
  next_action: string;
  next_tool?: 'task_plan_claim_subtask' | 'task_claim_quota_accept' | 'rescue_stranded_scan';
  plan_slug?: string;
  subtask_index?: number;
  reason?: 'continue_current_task' | 'urgent_override' | 'ready_high_score';
  assigned_agent?: string;
  routing_reason?: string;
  claim_args?:
    | {
        repo_root: string;
        plan_slug: string;
        subtask_index: number;
        session_id: string;
        agent: string;
        file_scope: string[];
      }
    | QuotaRelayReadyEntry['claim_args'];
  rescue_candidate?: {
    plan_slug: string;
    task_id: number;
    subtask_index: number;
    title: string;
    file: string | null;
    owner_session_id: string | null;
    owner_agent: string | null;
    age_minutes: number;
    unlock_candidate: {
      task_id: number;
      subtask_index: number;
      title: string;
      file_scope: string[];
    } | null;
  };
  rescue_args?: { stranded_after_minutes: number };
  auto_released_stale_claims?: Array<{
    plan_slug: string;
    subtask_index: number;
    task_id: number;
    age_minutes: number;
    owner_session_id: string | null;
    owner_agent: string | null;
  }>;
  codex_mcp_call?: string;
  next_action_reason?: string;
  empty_state?: string;
  hint?: {
    kind: 'plan_claim_subtask';
    message: string;
    plan_slug: string;
    subtask_index: number;
    title: string;
    blocked_by_count: number;
    blocked_by: number[];
    next_tool: 'task_plan_claim_subtask';
    claim_args: {
      repo_root: string;
      plan_slug: string;
      subtask_index: number;
      session_id: string;
      agent: string;
      file_scope: string[];
    };
    codex_mcp_call: string;
  };
  setup_issue?: {
    code: 'SPEC_ROOT_NOT_FOUND';
    repo_root: string;
    spec_path: string;
    recovery: string;
    message: string;
  };
  claim_required?: boolean;
  auto_claimed?:
    | {
        ok: true;
        plan_slug: string;
        subtask_index: number;
        task_id: number;
        branch: string;
        file_scope: string[];
      }
    | {
        ok: false;
        plan_slug: string;
        subtask_index: number;
        code: string;
        message: string;
      };
}

const EMPTY_READY_STATE =
  'No claimable plan subtasks. Publish a Queen/task plan for multi-agent work, reinforce a proposal with task_propose/task_reinforce, or use task_list only for browsing.';

async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}';
  if (!text.trim().startsWith('{') && !text.trim().startsWith('[')) {
    throw new Error(text);
  }
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

function setTaskProposalStatus(taskId: number, status: 'proposed' | 'approved'): void {
  const db = (store.storage as unknown as StorageWithDb).db;
  db.prepare('UPDATE tasks SET proposal_status = ? WHERE id = ?').run(status, taskId);
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

function recordQuotaHandoff(taskId: number, agent = 'codex'): void {
  store.addObservation({
    session_id: 'agent-session',
    task_id: taskId,
    kind: 'handoff',
    content: 'quota_exhausted handoff',
    metadata: {
      kind: 'handoff',
      from_session_id: 'agent-session',
      from_agent: agent,
      to_agent: 'any',
      to_session_id: null,
      summary: 'Session hit usage limit; takeover requested.',
      next_steps: ['Continue from ready queue.'],
      blockers: ['quota_exhausted'],
      released_files: [],
      transferred_files: [],
      status: 'pending',
      accepted_by_session_id: null,
      accepted_at: null,
      expires_at: Date.now() + 60_000,
    },
  });
}

async function stopSubtaskWithQuotaHandoff(args: {
  plan_slug: string;
  subtask_index: number;
  session_id?: string;
  agent?: string;
  expires_in_ms?: number;
}): Promise<{ claim: ClaimResult; handoffId: number }> {
  const sessionId = args.session_id ?? 'quota-session';
  const agent = args.agent ?? 'codex';
  store.startSession({ id: sessionId, ide: agent, cwd: repoRoot });
  const claim = await claimSubtask(args.plan_slug, args.subtask_index, sessionId, agent);
  const handoffId = new TaskThread(store, claim.task_id).handOff({
    from_session_id: sessionId,
    from_agent: agent,
    to_agent: 'any',
    summary: 'Session hit usage limit; takeover requested.',
    next_steps: ['Continue the quota-stopped subtask.'],
    blockers: ['quota_exhausted'],
    reason: 'quota_exhausted',
    expires_in_ms: args.expires_in_ms ?? 60 * 60_000,
  });
  return { claim, handoffId };
}

function openQuotaRelayTask(args: {
  session_id?: string;
  agent?: string;
  branch?: string;
  file_path?: string;
  expires_in_ms?: number;
}): { taskId: number; relayId: number; filePath: string; branch: string } {
  const sessionId = args.session_id ?? 'quota-session';
  const agent = args.agent ?? 'codex';
  const branch = args.branch ?? 'agent/codex/quota-relay';
  const filePath = args.file_path ?? 'apps/api/quota-relay.ts';
  store.startSession({ id: sessionId, ide: agent, cwd: repoRoot });
  const thread = TaskThread.open(store, {
    repo_root: repoRoot,
    branch,
    session_id: sessionId,
    title: 'Quota relay task',
  });
  thread.join(sessionId, agent);
  thread.claimFile({ session_id: sessionId, file_path: filePath });
  const relayId = thread.relay({
    from_session_id: sessionId,
    from_agent: agent,
    reason: 'quota',
    one_line: 'quota stopped this task',
    base_branch: 'main',
    expires_in_ms: args.expires_in_ms ?? 60_000,
  });
  return { taskId: thread.task_id, relayId, filePath, branch };
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

function seedReadyPlanDirectly(args: {
  slug: string;
  subtasks: Array<{ title: string; file_scope: string[]; depends_on: number[] }>;
}): void {
  const parent = TaskThread.open(store, {
    repo_root: repoRoot,
    branch: `spec/${args.slug}`,
    session_id: 'planner',
    title: args.slug,
  });
  store.addObservation({
    session_id: 'planner',
    task_id: parent.task_id,
    kind: 'plan-config',
    content: `legacy plan ${args.slug}`,
    metadata: { plan_slug: args.slug, source: 'test-fixture' },
  });

  args.subtasks.forEach((subtask, index) => {
    const thread = TaskThread.open(store, {
      repo_root: repoRoot,
      branch: `spec/${args.slug}/sub-${index}`,
      session_id: 'planner',
    });
    store.addObservation({
      session_id: 'planner',
      task_id: thread.task_id,
      kind: 'plan-subtask',
      content: `${subtask.title}\n\n${subtask.title} description`,
      metadata: {
        parent_plan_slug: args.slug,
        parent_plan_title: args.slug,
        parent_spec_task_id: parent.task_id,
        subtask_index: index,
        title: subtask.title,
        description: `${subtask.title} description`,
        file_scope: subtask.file_scope,
        depends_on: subtask.depends_on,
        spec_row_id: null,
        capability_hint: 'infra_work',
        status: 'available',
      },
    });
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
    expect(result).not.toHaveProperty('mcp_capability_map');
    expect(JSON.stringify(result).length).toBeLessThan(500);
    expect(result.empty_state).toBe(EMPTY_READY_STATE);
    expect(result.next_tool).toBeUndefined();
    expect(result.next_action).toBe(
      'Publish a Queen/task plan or promote a proposal into claimable work.',
    );
  });

  it('points agents at SPEC setup when no plan work exists and SPEC.md is missing', async () => {
    rmSync(join(repoRoot, 'SPEC.md'), { force: true });

    const result = await call<ReadyResult>('task_ready_for_agent', {
      session_id: 'agent-session',
      agent: 'codex',
      repo_root: repoRoot,
    });

    expect(result.ready).toEqual([]);
    expect(result.total_available).toBe(0);
    expect(result.empty_state).toContain('SPEC.md not found at');
    expect(result.next_action).toBe(result.empty_state);
    expect(result.setup_issue).toMatchObject({
      code: 'SPEC_ROOT_NOT_FOUND',
      repo_root: repoRoot,
      spec_path: join(repoRoot, 'SPEC.md'),
    });
    expect(result.setup_issue?.recovery).toContain('colony spec init');
  });

  it('returns the MCP capability map only when explicitly requested', async () => {
    const result = await call<ReadyResult>('task_ready_for_agent', {
      session_id: 'agent-session',
      agent: 'codex',
      repo_root: repoRoot,
      include_capability_map: true,
    });

    expect(result.ready).toEqual([]);
    expect(result.total_available).toBe(0);
    expect(result.mcp_capability_map?.summary).toEqual(expect.any(Array));
    expect(result.mcp_capability_map?.unknown_servers).toEqual(expect.any(Array));
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
      auto_claim: false,
    });

    expect(result.ready.map((entry) => entry.subtask_index)).toEqual([0]);
    expect(result.next_tool).toBe('task_plan_claim_subtask');
    expect(result.rescue_candidate).toBeUndefined();
    expect(result.plan_slug).toBe('claimable-plan');
    expect(result.subtask_index).toBe(0);
    expect(result.reason).toBe('ready_high_score');
    expect(result.next_action_reason).toBe(
      'Claim claimable-plan/sub-0: it is unclaimed, dependencies are met, and it is the highest-ranked claimable ready item.',
    );
    expect(result.next_action).toContain('task_plan_claim_subtask');
    expect(result.next_action).toContain('plan_slug="claimable-plan"');
    expect(result.ready[0]).toMatchObject({
      priority: 1,
      next_tool: 'task_plan_claim_subtask',
      next_action_reason:
        'Claim claimable-plan/sub-0: it is unclaimed, dependencies are met, and it is the highest-ranked claimable ready item.',
      codex_mcp_call: `mcp__colony__task_plan_claim_subtask({ agent: "codex", session_id: "agent-session", repo_root: ${JSON.stringify(repoRoot)}, plan_slug: "claimable-plan", subtask_index: 0, file_scope: ["apps/api/claimable.ts"] })`,
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
    expect(result.claim_required).toBe(true);
    expect(result.empty_state).toBeUndefined();
  });

  it('hides proposed task rows from executors until approval', async () => {
    await call('task_plan_publish', {
      ...publishArgs(
        [
          {
            title: 'Proposal gated work',
            description: 'Executor needs approval first.',
            file_scope: ['apps/api/proposed.ts'],
            capability_hint: 'api_work',
          },
          {
            title: 'Downstream proposal gated docs',
            description: 'Blocked behind proposal gated work.',
            file_scope: ['docs/proposed.md'],
            depends_on: [0],
            capability_hint: 'doc_work',
          },
        ],
        { slug: 'proposal-gated-plan' },
      ),
    });
    const taskId = taskIdForSubtask('proposal-gated-plan', 0);
    setTaskProposalStatus(taskId, 'proposed');

    const hidden = await call<ReadyResult>('task_ready_for_agent', {
      session_id: 'agent-session',
      agent: 'codex',
      repo_root: repoRoot,
      auto_claim: false,
    });

    expect(hidden.ready).toEqual([]);
    expect(hidden.total_available).toBe(0);

    setTaskProposalStatus(taskId, 'approved');
    const visible = await call<ReadyResult>('task_ready_for_agent', {
      session_id: 'agent-session',
      agent: 'codex',
      repo_root: repoRoot,
      auto_claim: false,
    });

    expect(visible.ready.map((entry) => entry.subtask_index)).toEqual([0]);
  });

  it('omits claim_required when there is no claimable sub-task', async () => {
    const result = await call<ReadyResult>('task_ready_for_agent', {
      session_id: 'agent-session',
      agent: 'codex',
      repo_root: repoRoot,
    });
    expect(result.ready).toHaveLength(0);
    expect(result.claim_required).toBeUndefined();
    expect(result.empty_state).toBeDefined();
  });

  it('claims the unambiguous ready sub-task when auto_claim=true', async () => {
    await call('task_plan_publish', {
      ...publishArgs(
        [
          {
            title: 'Auto-claim me',
            description: 'Server should claim this in the same call.',
            file_scope: ['apps/api/auto-claim.ts'],
            capability_hint: 'api_work',
          },
          {
            title: 'Document auto-claim flow',
            description: 'Document the auto-claim flow.',
            file_scope: ['docs/auto-claim.md'],
            depends_on: [0],
            capability_hint: 'doc_work',
          },
        ],
        { slug: 'auto-claim-plan' },
      ),
    });

    const result = await call<ReadyResult>('task_ready_for_agent', {
      session_id: 'agent-session',
      agent: 'codex',
      repo_root: repoRoot,
      auto_claim: true,
    });

    expect(result.auto_claimed).toMatchObject({
      ok: true,
      plan_slug: 'auto-claim-plan',
      subtask_index: 0,
      branch: 'spec/auto-claim-plan/sub-0',
      file_scope: ['apps/api/auto-claim.ts'],
    });
    expect(result.next_action).toContain('Auto-claimed auto-claim-plan/sub-0');

    const followup = await call<ReadyResult>('task_ready_for_agent', {
      session_id: 'agent-session',
      agent: 'codex',
      repo_root: repoRoot,
    });
    expect(followup.ready[0]).toMatchObject({
      plan_slug: 'auto-claim-plan',
      subtask_index: 0,
      reason: 'continue_current_task',
    });
  });

  it('skips auto_claim when multiple ready sub-tasks are available', async () => {
    await call('task_plan_publish', {
      ...publishArgs(
        [
          {
            title: 'First ambiguous task',
            description: 'One of two available subtasks.',
            file_scope: ['apps/api/ambiguous-a.ts'],
            capability_hint: 'api_work',
          },
          {
            title: 'Second ambiguous task',
            description: 'Another available subtask.',
            file_scope: ['apps/api/ambiguous-b.ts'],
            capability_hint: 'api_work',
          },
        ],
        { slug: 'ambiguous-auto-claim-plan' },
      ),
    });

    const result = await call<ReadyResult>('task_ready_for_agent', {
      session_id: 'agent-session',
      agent: 'codex',
      repo_root: repoRoot,
      auto_claim: true,
    });

    expect(result.ready.map((entry) => entry.subtask_index)).toEqual([0, 1]);
    expect(result.claim_args).toMatchObject({
      plan_slug: 'ambiguous-auto-claim-plan',
      subtask_index: 0,
      session_id: 'agent-session',
      agent: 'codex',
    });
    expect(result.auto_claimed).toMatchObject({
      ok: false,
      plan_slug: 'ambiguous-auto-claim-plan',
      subtask_index: 0,
      code: 'AUTO_CLAIM_AMBIGUOUS',
    });
    expect(store.storage.listClaims(taskIdForSubtask('ambiguous-auto-claim-plan', 0))).toEqual([]);
    expect(store.storage.listClaims(taskIdForSubtask('ambiguous-auto-claim-plan', 1))).toEqual([]);
  });

  it('skips auto_claim when no claimable sub-task is ready', async () => {
    const result = await call<ReadyResult>('task_ready_for_agent', {
      session_id: 'agent-session',
      agent: 'codex',
      repo_root: repoRoot,
      auto_claim: true,
    });
    expect(result.auto_claimed).toBeUndefined();
    expect(result.empty_state).toBeDefined();
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
      auto_claim: false,
    });

    expect(result.ready).toHaveLength(1);
    expect(result.ready[0]).toMatchObject({
      priority: 1,
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
      codex_mcp_call: `mcp__colony__task_plan_claim_subtask({ agent: "codex", session_id: "agent-session", repo_root: ${JSON.stringify(repoRoot)}, plan_slug: "direct-ready-claim", subtask_index: 0, file_scope: ["apps/api/direct-claim.ts"] })`,
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

  it('does not return ready entries whose advertised sub-task index has no branch row', async () => {
    const parent = TaskThread.open(store, {
      repo_root: repoRoot,
      branch: 'spec/stale-ready-pointer',
      session_id: 'planner',
      title: 'Stale ready pointer',
    });
    const subtask = TaskThread.open(store, {
      repo_root: repoRoot,
      branch: 'spec/stale-ready-pointer/sub-0',
      session_id: 'planner',
      title: 'Stale subtask branch',
    });
    store.addObservation({
      session_id: 'planner',
      task_id: subtask.task_id,
      kind: 'plan-subtask',
      content: 'Stale advertised index\n\nThe metadata points at sub-7, but only sub-0 exists.',
      metadata: {
        parent_plan_slug: 'stale-ready-pointer',
        parent_plan_title: 'Stale ready pointer',
        parent_spec_task_id: parent.task_id,
        subtask_index: 7,
        title: 'Stale advertised index',
        description: 'The metadata points at sub-7, but only sub-0 exists.',
        file_scope: ['apps/api/stale-ready.ts'],
        depends_on: [],
        spec_row_id: null,
        capability_hint: 'api_work',
        status: 'available',
      },
    });

    const result = await call<ReadyResult>('task_ready_for_agent', {
      session_id: 'agent-session',
      agent: 'codex',
      repo_root: repoRoot,
      auto_claim: false,
    });

    expect(result.ready).toEqual([]);
    expect(result.total_available).toBe(0);
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
    expect(result.rescue_candidate).toBeUndefined();
    expect(result.codex_mcp_call).toBeUndefined();
    expect(result.next_action).toBe(
      'Complete upstream dependencies or unblock current plan waves before claiming more work.',
    );
  });

  it('adds a plan-claim hint when unclaimed plan work exists behind blockers', async () => {
    await call('task_plan_publish', {
      ...publishArgs(
        [
          {
            title: 'Blocked API dependency',
            description: 'This dependency cannot progress yet.',
            file_scope: ['apps/api/blocked-hint-dependency.ts'],
            capability_hint: 'api_work',
          },
          {
            title: 'Hidden follow-up API',
            description: 'This is unclaimed plan work, but it is not ready yet.',
            file_scope: ['apps/api/blocked-hint-followup.ts'],
            depends_on: [0],
            capability_hint: 'api_work',
          },
        ],
        { slug: 'blocked-hint-plan' },
      ),
    });
    const claim = await claimSubtask('blocked-hint-plan', 0);
    blockSubtask('blocked-hint-plan', 0, claim.task_id);

    const result = await call<ReadyResult>('task_ready_for_agent', {
      session_id: 'agent-session',
      agent: 'codex',
      repo_root: repoRoot,
      auto_claim: false,
    });

    expect(result.ready).toEqual([]);
    expect(result.empty_state).toBe(EMPTY_READY_STATE);
    expect(result.hint).toMatchObject({
      kind: 'plan_claim_subtask',
      plan_slug: 'blocked-hint-plan',
      subtask_index: 1,
      title: 'Hidden follow-up API',
      blocked_by_count: 1,
      blocked_by: [0],
      next_tool: 'task_plan_claim_subtask',
      claim_args: {
        repo_root: repoRoot,
        plan_slug: 'blocked-hint-plan',
        subtask_index: 1,
        session_id: 'agent-session',
        agent: 'codex',
        file_scope: ['apps/api/blocked-hint-followup.ts'],
      },
    });
    expect(result.hint?.codex_mcp_call).toBe(
      `mcp__colony__task_plan_claim_subtask({ agent: "codex", session_id: "agent-session", repo_root: ${JSON.stringify(repoRoot)}, plan_slug: "blocked-hint-plan", subtask_index: 1, file_scope: ["apps/api/blocked-hint-followup.ts"] })`,
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
    // Opt out of server-side auto-release so we can still cover the legacy
    // rescue_candidate surface; the auto-release happy path lives in the
    // sibling test "auto-releases stale plan-subtask claims …" below.
    let result = await call<ReadyResult>('task_ready_for_agent', {
      session_id: 'agent-session',
      agent: 'codex',
      repo_root: repoRoot,
      limit: 10,
      auto_release_stale_claims: false,
    });

    expect(result.ready).toEqual([]);
    expect(result.total_available).toBe(0);
    expect(result.next_tool).toBe('rescue_stranded_scan');
    expect(result.empty_state).toBeUndefined();
    expect(result.next_action).toContain('Rescue stale blocker stale-release-plan/sub-0');
    expect(result.rescue_args).toEqual({ stranded_after_minutes: 60 });
    expect(result.rescue_candidate).toMatchObject({
      plan_slug: 'stale-release-plan',
      task_id: staleClaim.task_id,
      subtask_index: 0,
      title: 'Stale claimed blocker',
      file: 'apps/api/stale-blocker.ts',
      owner_session_id: 'stale-session',
      owner_agent: 'codex',
      age_minutes: 300,
      unlock_candidate: {
        task_id: taskIdForSubtask('stale-release-plan', 1),
        subtask_index: 1,
        title: 'Wave two API',
        file_scope: ['apps/api/wave-two.ts'],
      },
    });
    expect(result.next_action).toBe(
      'Rescue stale blocker stale-release-plan/sub-0; it blocks sub-1.',
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
        repo_root: repoRoot,
        plan_slug: 'stale-release-plan',
        subtask_index: 0,
        session_id: 'agent-session',
        agent: 'codex',
        file_scope: ['apps/api/stale-blocker.ts'],
      },
    });
    expect(result.next_tool).toBe('task_plan_claim_subtask');
    expect(result.claim_args).toEqual({
      repo_root: repoRoot,
      plan_slug: 'stale-release-plan',
      subtask_index: 0,
      session_id: 'agent-session',
      agent: 'codex',
      file_scope: ['apps/api/stale-blocker.ts'],
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
        repo_root: repoRoot,
        plan_slug: 'stale-release-plan',
        subtask_index: 1,
        session_id: 'agent-session',
        agent: 'codex',
        file_scope: ['apps/api/wave-two.ts'],
      },
    });
  });

  it('auto-releases stale plan-subtask claims so a fresh agent can claim on the same tick', async () => {
    const t0 = Date.parse('2026-04-28T12:00:00.000Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0);
    store.startSession({ id: 'stale-session', ide: 'codex', cwd: repoRoot });

    await call('task_plan_publish', {
      ...publishArgs(
        [
          {
            title: 'Stale claimed blocker',
            description: 'This stale claim used to deadlock the wave forever.',
            file_scope: ['apps/api/auto-release-blocker.ts'],
            capability_hint: 'api_work',
          },
          {
            title: 'Wave two API',
            description: 'Unlocks after the stale blocker completes.',
            file_scope: ['apps/api/auto-release-wave-two.ts'],
            depends_on: [0],
            capability_hint: 'api_work',
          },
        ],
        { slug: 'auto-release-plan', session_id: 'queen', agent: 'queen' },
      ),
    });
    const staleClaim = await claimSubtask('auto-release-plan', 0, 'stale-session');

    // Advance well past STALE_PLAN_SUBTASK_CLAIM_MS (1h). The original
    // stale-session never makes progress — no further observations, no
    // completion — so the queue must release it on a downstream agent's
    // poll instead of stalling on a rescue_candidate suggestion.
    vi.setSystemTime(t0 + 5 * 60 * 60_000);
    const result = await call<ReadyResult>('task_ready_for_agent', {
      session_id: 'fresh-agent-session',
      agent: 'codex',
      repo_root: repoRoot,
      limit: 10,
    });

    // The stale sub-task should now look claimable in the same response.
    expect(result.ready.map((entry) => entry.subtask_index)).toEqual([0]);
    expect(result.next_tool).toBe('task_plan_claim_subtask');
    expect(result.rescue_candidate).toBeUndefined();
    expect(result.claim_args).toEqual({
      repo_root: repoRoot,
      plan_slug: 'auto-release-plan',
      subtask_index: 0,
      session_id: 'fresh-agent-session',
      agent: 'codex',
      file_scope: ['apps/api/auto-release-blocker.ts'],
    });

    // The result reports which claims were auto-released so callers /
    // telemetry can audit the action.
    expect(result.auto_released_stale_claims).toHaveLength(1);
    expect(result.auto_released_stale_claims?.[0]).toMatchObject({
      plan_slug: 'auto-release-plan',
      subtask_index: 0,
      task_id: staleClaim.task_id,
      owner_session_id: 'stale-session',
      owner_agent: 'codex',
    });
    expect(result.auto_released_stale_claims?.[0]?.age_minutes).toBeGreaterThanOrEqual(60);
  });

  it('leaves stale claims alone when auto_release_stale_claims is false', async () => {
    const t0 = Date.parse('2026-04-28T12:00:00.000Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0);
    store.startSession({ id: 'stale-session', ide: 'codex', cwd: repoRoot });

    await call('task_plan_publish', {
      ...publishArgs(
        [
          {
            title: 'Stale claimed blocker',
            description: 'Telemetry observer must see the stale state untouched.',
            file_scope: ['apps/api/no-release-blocker.ts'],
            capability_hint: 'api_work',
          },
          {
            title: 'Downstream blocked work',
            description: 'Surfaces only after the blocker completes; never claimed here.',
            file_scope: ['apps/api/no-release-downstream.ts'],
            depends_on: [0],
            capability_hint: 'api_work',
          },
        ],
        { slug: 'no-auto-release-plan', session_id: 'queen', agent: 'queen' },
      ),
    });
    await claimSubtask('no-auto-release-plan', 0, 'stale-session');

    vi.setSystemTime(t0 + 5 * 60 * 60_000);
    const result = await call<ReadyResult>('task_ready_for_agent', {
      session_id: 'observer-session',
      agent: 'codex',
      repo_root: repoRoot,
      limit: 10,
      auto_release_stale_claims: false,
    });

    expect(result.ready).toEqual([]);
    expect(result.auto_released_stale_claims).toBeUndefined();
  });

  it('surfaces quota-pending claims as replacement work with exact accept args', async () => {
    const t0 = Date.parse('2026-05-01T10:00:00.000Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0);

    await call('task_plan_publish', {
      ...publishArgs(
        [
          {
            title: 'Quota stopped API',
            description: 'This claimed task stopped on quota.',
            file_scope: ['apps/api/quota-stopped.ts'],
            capability_hint: 'api_work',
          },
          {
            title: 'Downstream API',
            description: 'Blocked until the quota-stopped work is claimed.',
            file_scope: ['apps/api/downstream.ts'],
            depends_on: [0],
            capability_hint: 'api_work',
          },
        ],
        { slug: 'quota-ready-plan', session_id: 'queen', agent: 'queen' },
      ),
    });
    const { claim, handoffId } = await stopSubtaskWithQuotaHandoff({
      plan_slug: 'quota-ready-plan',
      subtask_index: 0,
      expires_in_ms: 60 * 60_000,
    });

    vi.setSystemTime(t0 + 5 * 60_000);
    const result = await call<ReadyResult>('task_ready_for_agent', {
      session_id: 'agent-session',
      agent: 'codex',
      repo_root: repoRoot,
      limit: 10,
      auto_claim: false,
    });

    const quota = result.ready[0] as unknown as QuotaRelayReadyEntry;
    expect(result.total_available).toBe(1);
    expect(result.next_tool).toBe('task_claim_quota_accept');
    expect(result.next_action).toContain('task_claim_quota_accept');
    expect(quota).toMatchObject({
      kind: 'quota_relay_ready',
      priority: 1,
      next_tool: 'task_claim_quota_accept',
      task_id: claim.task_id,
      old_session_id: 'quota-session',
      old_owner: { session_id: 'quota-session', agent: 'codex' },
      files: ['apps/api/quota-stopped.ts'],
      file_count: 1,
      active_files: ['apps/api/quota-stopped.ts'],
      active_file_count: 1,
      evidence: `observation ${handoffId} handoff: HANDOFF from codex -> any`,
      next: 'Continue the quota-stopped subtask.',
      age: { minutes: 5 },
      repo_root: repoRoot,
      branch: 'spec/quota-ready-plan/sub-0',
      expires_at: t0 + 60 * 60_000,
      has_active_files: true,
      blocks_downstream: true,
      quota_observation_id: handoffId,
      quota_observation_kind: 'handoff',
      task_active: true,
      codex_mcp_call: `mcp__colony__task_claim_quota_accept({ session_id: "agent-session", agent: "codex", task_id: ${claim.task_id}, handoff_observation_id: ${handoffId} })`,
      claim_args: {
        task_id: claim.task_id,
        session_id: 'agent-session',
        agent: 'codex',
        handoff_observation_id: handoffId,
      },
    });
    expect(result.claim_args).toEqual(quota.claim_args);
    expect(result.codex_mcp_call).toContain('mcp__colony__task_claim_quota_accept');

    const accepted = await call<QuotaAcceptResult>(quota.next_tool, quota.claim_args);
    expect(accepted).toMatchObject({
      status: 'accepted',
      task_id: claim.task_id,
      handoff_observation_id: handoffId,
      baton_kind: 'handoff',
      accepted_by_session_id: 'agent-session',
      accepted_files: ['apps/api/quota-stopped.ts'],
      previous_session_ids: ['quota-session'],
    });
    expect(accepted.audit_observation_id).toEqual(expect.any(Number));
    expect(store.storage.listClaims(claim.task_id)).toEqual([
      expect.objectContaining({
        file_path: 'apps/api/quota-stopped.ts',
        session_id: 'agent-session',
        state: 'active',
      }),
    ]);
  });

  it('ranks downstream-blocking quota relays above ordinary ready work', async () => {
    await call('task_plan_publish', {
      ...publishArgs(
        [
          {
            title: 'Quota blocker',
            description: 'This quota-stopped work blocks the next wave.',
            file_scope: ['apps/api/quota-blocker.ts'],
            capability_hint: 'api_work',
          },
          {
            title: 'Blocked next wave',
            description: 'Cannot proceed until the quota blocker is claimed.',
            file_scope: ['apps/api/blocked-next-wave.ts'],
            depends_on: [0],
            capability_hint: 'api_work',
          },
        ],
        { slug: 'quota-ranked-plan', session_id: 'queen', agent: 'queen' },
      ),
    });
    await stopSubtaskWithQuotaHandoff({
      plan_slug: 'quota-ranked-plan',
      subtask_index: 0,
    });
    await call('task_plan_publish', {
      ...publishArgs(
        [
          {
            title: 'Ordinary ready API',
            description: 'Available but not replacing quota-stopped work.',
            file_scope: ['apps/api/ordinary-ready.ts'],
            capability_hint: 'api_work',
          },
          {
            title: 'Ordinary follow-up docs',
            description: 'Keeps the test plan shape valid.',
            file_scope: ['docs/ordinary-ready.md'],
            depends_on: [0],
            capability_hint: 'doc_work',
          },
        ],
        { slug: 'ordinary-ready-plan' },
      ),
    });

    const result = await call<ReadyResult>('task_ready_for_agent', {
      session_id: 'agent-session',
      agent: 'codex',
      repo_root: repoRoot,
      limit: 10,
      auto_claim: false,
    });

    expect(result.total_available).toBe(2);
    expect((result.ready[0] as unknown as QuotaRelayReadyEntry).kind).toBe('quota_relay_ready');
    expect((result.ready[0] as unknown as QuotaRelayReadyEntry).blocks_downstream).toBe(true);
    expect(result.ready[1]).toMatchObject({
      plan_slug: 'ordinary-ready-plan',
      subtask_index: 0,
      title: 'Ordinary ready API',
    });
    expect(result.next_tool).toBe('task_claim_quota_accept');
  });

  it('skips expired nonblocking quota relays so ordinary ready work can proceed', async () => {
    const t0 = Date.parse('2026-05-01T11:00:00.000Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0);
    const { taskId, relayId, filePath } = openQuotaRelayTask({
      expires_in_ms: 60_000,
    });

    vi.setSystemTime(t0 + 2 * 60_000);
    await call('task_plan_publish', {
      ...publishArgs(
        [
          {
            title: 'Ordinary after expired relay',
            description: 'Ready work should not be masked by expired nonblocking quota files.',
            file_scope: ['apps/api/ordinary-after-expired-relay.ts'],
            capability_hint: 'api_work',
          },
          {
            title: 'Ordinary expired relay docs',
            description: 'Dependent docs task keeps the test plan shape valid.',
            file_scope: ['docs/ordinary-after-expired-relay.md'],
            depends_on: [0],
            capability_hint: 'doc_work',
          },
        ],
        { slug: 'ordinary-after-expired-relay-plan' },
      ),
    });

    const result = await call<ReadyResult>('task_ready_for_agent', {
      session_id: 'agent-session',
      agent: 'codex',
      repo_root: repoRoot,
      limit: 10,
      auto_claim: false,
    });

    expect(result.total_available).toBe(1);
    expect(result.next_tool).toBe('task_plan_claim_subtask');
    expect(
      result.ready.some(
        (entry) => (entry as unknown as { kind?: string }).kind === 'quota_relay_ready',
      ),
    ).toBe(false);
    expect(result.ready[0]).toMatchObject({
      plan_slug: 'ordinary-after-expired-relay-plan',
      subtask_index: 0,
    });

    new TaskThread(store, taskId).join('agent-session', 'codex');
    const released = await call<{
      status: string;
      released_claims: Array<{ file_path: string; state: string }>;
    }>('task_claim_quota_release_expired', {
      task_id: taskId,
      session_id: 'agent-session',
      handoff_observation_id: relayId,
    });
    expect(released).toMatchObject({
      status: 'released_expired',
      released_claims: [{ file_path: filePath, state: 'weak_expired' }],
    });

    const afterRelease = await call<ReadyResult>('task_ready_for_agent', {
      session_id: 'agent-session',
      agent: 'codex',
      repo_root: repoRoot,
      limit: 10,
      auto_claim: false,
    });
    expect(afterRelease.total_available).toBe(1);
    expect(
      afterRelease.ready.some(
        (entry) => (entry as unknown as { kind?: string }).kind === 'quota_relay_ready',
      ),
    ).toBe(false);
  });

  it('keeps quota relay ready payloads compact for many files and long handoffs', async () => {
    const sessionId = 'quota-session';
    store.startSession({ id: sessionId, ide: 'codex', cwd: repoRoot });
    const thread = TaskThread.open(store, {
      repo_root: repoRoot,
      branch: 'agent/codex/large-quota-relay',
      session_id: sessionId,
      title: 'Large quota relay task',
    });
    thread.join(sessionId, 'codex');
    for (const filePath of [
      'apps/api/alpha.ts',
      'apps/api/beta.ts',
      'apps/api/gamma.ts',
      'apps/api/delta.ts',
      'apps/api/epsilon.ts',
    ]) {
      thread.claimFile({ session_id: sessionId, file_path: filePath });
    }
    const relayId = thread.relay({
      from_session_id: sessionId,
      from_agent: 'codex',
      reason: 'quota',
      one_line: 'x'.repeat(500),
      base_branch: 'main',
    });

    const result = await call<ReadyResult>('task_ready_for_agent', {
      session_id: 'agent-session',
      agent: 'codex',
      repo_root: repoRoot,
      limit: 1,
    });

    const quota = result.ready[0] as unknown as QuotaRelayReadyEntry;
    expect(quota).toMatchObject({
      kind: 'quota_relay_ready',
      task_id: thread.task_id,
      files: ['apps/api/alpha.ts', 'apps/api/beta.ts', 'apps/api/delta.ts'],
      file_count: 5,
      active_files: ['apps/api/alpha.ts', 'apps/api/beta.ts', 'apps/api/delta.ts'],
      active_file_count: 5,
      quota_observation_id: relayId,
    });
    expect(quota.next).toHaveLength(240);
    expect(quota.next.endsWith('...')).toBe(true);
    expect(JSON.stringify(result).length).toBeLessThan(2500);
  });

  it('surfaces released weak-expired quota relays when they block downstream plans', async () => {
    const t0 = Date.parse('2026-05-01T12:00:00.000Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0);

    await call('task_plan_publish', {
      ...publishArgs(
        [
          {
            title: 'Expired quota blocker',
            description: 'This expired quota claim blocks later waves.',
            file_scope: ['apps/api/expired-quota-blocker.ts'],
            capability_hint: 'api_work',
          },
          {
            title: 'Expired quota follow-up',
            description: 'Blocked until the expired quota blocker is claimed.',
            file_scope: ['apps/api/expired-quota-follow-up.ts'],
            depends_on: [0],
            capability_hint: 'api_work',
          },
        ],
        { slug: 'expired-quota-blocked-plan', session_id: 'queen', agent: 'queen' },
      ),
    });
    const { claim, handoffId } = await stopSubtaskWithQuotaHandoff({
      plan_slug: 'expired-quota-blocked-plan',
      subtask_index: 0,
      expires_in_ms: 60_000,
    });
    new TaskThread(store, claim.task_id).join('agent-session', 'codex');

    vi.setSystemTime(t0 + 2 * 60_000);
    await call('task_claim_quota_release_expired', {
      task_id: claim.task_id,
      session_id: 'agent-session',
    });
    expect(
      store.storage.getClaim(claim.task_id, 'apps/api/expired-quota-blocker.ts'),
    ).toMatchObject({
      session_id: 'quota-session',
      state: 'weak_expired',
      handoff_observation_id: handoffId,
    });

    await call('task_plan_publish', {
      ...publishArgs(
        [
          {
            title: 'Ordinary available API',
            description: 'Ready but lower priority than expired replacement work.',
            file_scope: ['apps/api/ordinary-after-expired.ts'],
            capability_hint: 'api_work',
          },
          {
            title: 'Ordinary available docs',
            description: 'Dependent docs task keeps the test plan shape valid.',
            file_scope: ['docs/ordinary-after-expired.md'],
            depends_on: [0],
            capability_hint: 'doc_work',
          },
        ],
        { slug: 'ordinary-after-expired-plan' },
      ),
    });

    const result = await call<ReadyResult>('task_ready_for_agent', {
      session_id: 'agent-session',
      agent: 'codex',
      repo_root: repoRoot,
      limit: 10,
    });

    const quota = result.ready[0] as unknown as QuotaRelayReadyEntry;
    expect(result.total_available).toBe(2);
    expect(result.next_tool).toBe('task_claim_quota_accept');
    expect(quota).toMatchObject({
      kind: 'quota_relay_ready',
      priority: 1,
      task_id: claim.task_id,
      old_session_id: 'quota-session',
      files: ['apps/api/expired-quota-blocker.ts'],
      file_count: 1,
      active_files: [],
      active_file_count: 0,
      evidence: `observation ${handoffId} handoff: HANDOFF from codex -> any`,
      next: 'Continue the quota-stopped subtask.',
      has_active_files: false,
      blocks_downstream: true,
      quota_observation_id: handoffId,
      quota_observation_kind: 'handoff',
      claim_args: {
        task_id: claim.task_id,
        session_id: 'agent-session',
        agent: 'codex',
        handoff_observation_id: handoffId,
      },
    });
    expect(result.ready[1]).toMatchObject({
      plan_slug: 'ordinary-after-expired-plan',
      subtask_index: 0,
    });

    const accepted = await call<QuotaAcceptResult>(quota.next_tool, quota.claim_args);
    expect(accepted).toMatchObject({
      status: 'accepted',
      accepted_files: ['apps/api/expired-quota-blocker.ts'],
      previous_session_ids: ['quota-session'],
    });
    expect(
      store.storage.getClaim(claim.task_id, 'apps/api/expired-quota-blocker.ts'),
    ).toMatchObject({
      session_id: 'agent-session',
      state: 'active',
      handoff_observation_id: null,
    });
  });

  it('accepts quota claims through the task tool result shape', async () => {
    const { taskId, relayId, filePath } = openQuotaRelayTask({});
    new TaskThread(store, taskId).join('agent-session', 'codex');

    const accepted = await call<
      QuotaAcceptResult & {
        accepted_files: string[];
        handoff_observation_id: number;
      }
    >('task_claim_quota_accept', {
      task_id: taskId,
      session_id: 'agent-session',
      file_path: filePath,
    });

    expect(accepted).toMatchObject({
      status: 'accepted',
      task_id: taskId,
      handoff_observation_id: relayId,
      accepted_files: [filePath],
    });
    expect(store.storage.getClaim(taskId, filePath)).toMatchObject({
      session_id: 'agent-session',
      state: 'active',
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
      auto_claim: false,
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
      auto_claim: false,
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

  it('warns when existing ready subtasks overlap on a protected central file', async () => {
    seedReadyPlanDirectly({
      slug: 'legacy-health-overlap',
      subtasks: [
        {
          title: 'Add health warning one',
          file_scope: ['apps/cli/src/commands/health.ts'],
          depends_on: [],
        },
        {
          title: 'Add health warning two',
          file_scope: ['apps/cli/src/commands/health.ts'],
          depends_on: [],
        },
        {
          title: 'Add unrelated API helper',
          file_scope: ['apps/mcp-server/src/tools/unrelated.ts'],
          depends_on: [],
        },
      ],
    });

    const result = await call<ReadyResult>('task_ready_for_agent', {
      session_id: 'agent-session',
      agent: 'codex',
      repo_root: repoRoot,
      limit: 10,
    });

    expect(result.ready.map((entry) => entry.subtask_index).sort((a, b) => a - b)).toEqual([
      0, 1, 2,
    ]);
    expect(result.ready_scope_overlap_warnings).toEqual([
      {
        code: 'ready_scope_overlap',
        severity: 'warning',
        plan_slug: 'legacy-health-overlap',
        wave_index: 0,
        wave_name: 'Wave 1',
        file_path: 'apps/cli/src/commands/health.ts',
        protected: true,
        subtask_indexes: [0, 1],
        titles: ['Add health warning one', 'Add health warning two'],
        message:
          'legacy-health-overlap has 2 ready subtasks touching protected apps/cli/src/commands/health.ts; serialize with depends_on before parallel claims.',
      },
    ]);
  });

  it('routes large ready work away from Codex after recent Codex quota history', async () => {
    await call('agent_upsert_profile', {
      agent: 'claude-code',
      capabilities: { api_work: 0.8 },
    });
    await call('task_plan_publish', {
      ...publishArgs(
        [
          {
            title: 'Large API migration',
            description: 'Touch several tool files after quota handoff.',
            file_scope: [
              'apps/mcp-server/src/tools/one.ts',
              'apps/mcp-server/src/tools/two.ts',
              'apps/mcp-server/src/tools/three.ts',
              'apps/mcp-server/src/tools/four.ts',
              'apps/mcp-server/src/tools/five.ts',
              'apps/mcp-server/src/tools/six.ts',
            ],
            capability_hint: 'api_work',
          },
          {
            title: 'Large API docs',
            description: 'Dependent docs stay blocked while routing the large task.',
            file_scope: ['docs/large-api.md'],
            depends_on: [0],
            capability_hint: 'doc_work',
          },
        ],
        { slug: 'quota-large-plan' },
      ),
    });
    const largeTaskId = taskIdForSubtask('quota-large-plan', 0);
    new TaskThread(store, largeTaskId).join('other-session', 'claude-code');
    recordQuotaHandoff(largeTaskId, 'codex');

    const result = await call<ReadyResult>('task_ready_for_agent', {
      session_id: 'agent-session',
      agent: 'codex',
      repo_root: repoRoot,
    });

    expect(result.ready[0]).toMatchObject({
      assigned_agent: 'claude-code',
      routing_reason: 'Codex recently hit quota on this branch; task spans 6 files',
    });
    expect(result.assigned_agent).toBe('claude-code');
    expect(result.routing_reason).toBe(
      'Codex recently hit quota on this branch; task spans 6 files',
    );
    expect(result.next_tool).toBeUndefined();
    expect(result.next_action).toContain('Route quota-large-plan/sub-0 to claude-code');
  });

  it('keeps tiny isolated ready work eligible for Codex after recent Codex quota history', async () => {
    await call('task_plan_publish', {
      ...publishArgs(
        [
          {
            title: 'Tiny API follow-up',
            description: 'Small isolated task remains safe for Codex.',
            file_scope: ['apps/mcp-server/src/tools/tiny.ts'],
            capability_hint: 'api_work',
          },
          {
            title: 'Tiny API docs',
            description: 'Dependent docs stay blocked while routing the tiny task.',
            file_scope: ['docs/tiny-api.md'],
            depends_on: [0],
            capability_hint: 'doc_work',
          },
        ],
        { slug: 'quota-tiny-plan' },
      ),
    });
    recordQuotaHandoff(taskIdForSubtask('quota-tiny-plan', 0), 'codex');

    const result = await call<ReadyResult>('task_ready_for_agent', {
      session_id: 'agent-session',
      agent: 'codex',
      repo_root: repoRoot,
    });

    expect(['codex', 'any']).toContain(result.assigned_agent);
    expect(result.ready[0]?.assigned_agent).toBe('codex');
    expect(result.next_tool).toBe('task_plan_claim_subtask');
    expect(result.routing_reason).toContain('tiny and isolated');
  });

  it('preserves existing routing behavior when there is no quota history', async () => {
    await call('task_plan_publish', {
      ...publishArgs(
        [
          {
            title: 'Normal API task',
            description: 'No runtime routing signal exists.',
            file_scope: [
              'apps/mcp-server/src/tools/normal-one.ts',
              'apps/mcp-server/src/tools/normal-two.ts',
              'apps/mcp-server/src/tools/normal-three.ts',
              'apps/mcp-server/src/tools/normal-four.ts',
            ],
            capability_hint: 'api_work',
          },
          {
            title: 'Normal API docs',
            description: 'Dependent docs stay blocked while preserving routing.',
            file_scope: ['docs/normal-api.md'],
            depends_on: [0],
            capability_hint: 'doc_work',
          },
        ],
        { slug: 'no-quota-plan' },
      ),
    });

    const result = await call<ReadyResult>('task_ready_for_agent', {
      session_id: 'agent-session',
      agent: 'codex',
      repo_root: repoRoot,
    });

    expect(result.assigned_agent).toBe('codex');
    expect(result.next_tool).toBe('task_plan_claim_subtask');
    expect(result.claim_args?.agent).toBe('codex');
    expect(result.ready[0]?.assigned_agent).toBe('codex');
  });

  it('routes away from a runtime missing the required capability when another runtime is known capable', async () => {
    await call('agent_upsert_profile', {
      agent: 'codex',
      capabilities: { api_work: 0 },
    });
    await call('agent_upsert_profile', {
      agent: 'claude-code',
      capabilities: { api_work: 0.9 },
    });
    await call('task_plan_publish', {
      ...publishArgs(
        [
          {
            title: 'MCP API tool work',
            description: 'Requires API/MCP tool capability.',
            file_scope: ['apps/mcp-server/src/tools/capability.ts'],
            capability_hint: 'api_work',
          },
          {
            title: 'MCP API docs',
            description: 'Dependent docs stay blocked while routing by capability.',
            file_scope: ['docs/capability.md'],
            depends_on: [0],
            capability_hint: 'doc_work',
          },
        ],
        { slug: 'missing-capability-plan' },
      ),
    });

    const result = await call<ReadyResult>('task_ready_for_agent', {
      session_id: 'agent-session',
      agent: 'codex',
      repo_root: repoRoot,
    });

    expect(result.assigned_agent).toBe('claude-code');
    expect(result.routing_reason).toBe(
      'Codex lacks known api_work capability; task requires api_work.',
    );
    expect(result.next_tool).toBeUndefined();
    expect(result.ready[0]?.assigned_agent).toBe('claude-code');
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
