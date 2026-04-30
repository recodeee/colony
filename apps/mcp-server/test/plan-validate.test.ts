import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { MemoryStore, TaskThread, type WorktreeContentionReport } from '@colony/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/server.js';

let dir: string;
let repoRoot: string;
let store: MemoryStore;
let client: Client;
let planValidationRuntime: {
  now?: () => number;
  readWorktreeContention?: (repoRoot: string) => WorktreeContentionReport;
  availableMcpTools?: string[];
  requiredMcpTools?: string[];
  quotaRiskRuntimes?: Array<{
    agent: string;
    session_id?: string;
    reason: 'quota' | 'rate-limit' | 'turn-cap' | 'unknown';
    capability_hints?: Array<'ui_work' | 'api_work' | 'test_work' | 'infra_work' | 'doc_work'>;
  }>;
  omxNotes?: Array<{ session_id: string; content: string; file_paths?: string[] }>;
  protectedFilePatterns?: string[];
  strictClaimPolicy?: boolean;
};

interface ValidateResult {
  pairwise_overlaps: Array<{ a: number; b: number; shared: string[] }>;
  live_claim_collisions: Array<{
    subtask_index: number;
    file_path: string;
    holder_session_id: string;
    holder_task_id: number;
    holder_branch: string;
    claimed_at: number;
  }>;
  module_warnings: Array<{ a: number; b: number; shared_modules: string[] }>;
  ordered_wave_errors: Array<{
    code: string;
    message: string;
    subtask_index?: number;
    dependency_index?: number;
    wave?: number;
    shared?: string[];
    related_subtask_indices?: number[];
  }>;
  summary: {
    blocking: boolean;
    finding_count: number;
    counts: { error: number; warning: number; info: number };
    findings: Array<{
      code: string;
      severity: 'error' | 'warning' | 'info';
      message: string;
      subtask_index?: number;
      file_path?: string;
      detail?: string;
    }>;
  };
  partition_clean: boolean;
}

async function callValidate(subtasks: unknown[]): Promise<ValidateResult> {
  const res = await client.callTool({
    name: 'task_plan_validate',
    arguments: { repo_root: repoRoot, subtasks },
  });
  const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}';
  return JSON.parse(text) as ValidateResult;
}

function subtask(
  title: string,
  fileScope: string[],
  dependsOn?: number[],
  capabilityHint?: string,
): Record<string, unknown> {
  return {
    title,
    description: `${title} description`,
    file_scope: fileScope,
    ...(dependsOn !== undefined ? { depends_on: dependsOn } : {}),
    ...(capabilityHint !== undefined ? { capability_hint: capabilityHint } : {}),
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'colony-plan-validate-'));
  repoRoot = join(dir, 'repo');
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
  store.startSession({ id: 'A', ide: 'claude-code', cwd: repoRoot });
  store.startSession({ id: 'B', ide: 'codex', cwd: repoRoot });
  planValidationRuntime = { readWorktreeContention: emptyWorktreeReport };
  const server = buildServer(store, defaultSettings, { planValidation: planValidationRuntime });
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

function finding(
  result: ValidateResult,
  code: string,
): ValidateResult['summary']['findings'][number] {
  const found = result.summary.findings.find((candidate) => candidate.code === code);
  if (!found) throw new Error(`missing finding ${code}`);
  return found;
}

afterEach(async () => {
  vi.useRealTimers();
  await client.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('task_plan_validate', () => {
  it('reports a clean partition when scopes and modules are separate', async () => {
    const result = await callValidate([
      subtask('API', ['apps/api/src/widgets.ts']),
      subtask('UI', ['apps/frontend/src/widgets.tsx']),
    ]);

    expect(result.partition_clean).toBe(true);
    expect(result.pairwise_overlaps).toEqual([]);
    expect(result.live_claim_collisions).toEqual([]);
    expect(result.module_warnings).toEqual([]);
    expect(result.ordered_wave_errors).toEqual([]);
  });

  it('reports one pairwise overlap when independent sub-tasks share a file', async () => {
    const result = await callValidate([
      subtask('API one', ['apps/api/src/widgets.ts']),
      subtask('API two', ['apps/api/src/widgets.ts']),
    ]);

    expect(result.partition_clean).toBe(false);
    expect(result.pairwise_overlaps).toEqual([{ a: 0, b: 1, shared: ['apps/api/src/widgets.ts'] }]);
    expect(result.ordered_wave_errors).toMatchObject([
      {
        code: 'PLAN_WAVE_SCOPE_OVERLAP',
        wave: 0,
        related_subtask_indices: [0, 1],
        shared: ['apps/api/src/widgets.ts'],
      },
    ]);
  });

  it('warns when independent sub-tasks overlap on a protected central file', async () => {
    planValidationRuntime.protectedFilePatterns = ['apps/cli/src/commands/health.ts'];
    const result = await callValidate([
      subtask('Health hint one', ['apps/cli/src/commands/health.ts']),
      subtask('Health hint two', ['apps/cli/src/commands/health.ts']),
    ]);

    expect(result.partition_clean).toBe(false);
    expect(result.pairwise_overlaps).toEqual([
      { a: 0, b: 1, shared: ['apps/cli/src/commands/health.ts'] },
    ]);
    expect(finding(result, 'parallel_file_scope_overlap')).toMatchObject({
      severity: 'warning',
      message: 'parallel sub-tasks share protected file: apps/cli/src/commands/health.ts',
      subtask_index: 0,
      file_path: 'apps/cli/src/commands/health.ts',
      detail:
        'sub-tasks 0 and 1 should be serialized with depends_on or split through a shared refactor',
    });
  });

  it('reports a live-claim collision for a currently held scoped file', async () => {
    const thread = TaskThread.open(store, {
      repo_root: repoRoot,
      branch: 'agent/codex/held-file',
      session_id: 'A',
    });
    thread.join('A', 'codex');
    thread.claimFile({ session_id: 'A', file_path: 'apps/api/src/widgets.ts' });

    const result = await callValidate([
      subtask('API', ['apps/api/src/widgets.ts']),
      subtask('UI', ['apps/frontend/src/widgets.tsx']),
    ]);

    expect(result.partition_clean).toBe(false);
    expect(result.live_claim_collisions).toMatchObject([
      {
        subtask_index: 0,
        file_path: 'apps/api/src/widgets.ts',
        holder_session_id: 'A',
        holder_branch: 'agent/codex/held-file',
      },
    ]);
    expect(finding(result, 'file_already_claimed')).toMatchObject({
      severity: 'warning',
      subtask_index: 0,
      file_path: 'apps/api/src/widgets.ts',
    });
  });

  it('ignores stale claims as live-claim collisions', async () => {
    const t0 = Date.parse('2026-04-28T12:00:00.000Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0);
    const thread = TaskThread.open(store, {
      repo_root: repoRoot,
      branch: 'agent/codex/stale-held-file',
      session_id: 'A',
    });
    thread.join('A', 'codex');
    thread.claimFile({ session_id: 'A', file_path: 'apps/api/src/widgets.ts' });

    vi.setSystemTime(t0 + 241 * 60_000);

    const result = await callValidate([
      subtask('API', ['apps/api/src/widgets.ts']),
      subtask('UI', ['apps/frontend/src/widgets.tsx']),
    ]);

    expect(result.live_claim_collisions).toEqual([]);
  });

  it('warns when a stale blocker mentions a planned file', async () => {
    const t0 = Date.parse('2026-04-28T12:00:00.000Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0);
    planValidationRuntime.now = () => t0 + 90 * 60_000;
    const thread = TaskThread.open(store, {
      repo_root: repoRoot,
      branch: 'agent/codex/blocker',
      session_id: 'A',
    });
    store.addObservation({
      session_id: 'A',
      task_id: thread.task_id,
      kind: 'blocker',
      content: 'BLOCKED: apps/api/src/widgets.ts waits on owner reply',
    });

    const result = await callValidate([
      subtask('API', ['apps/api/src/widgets.ts']),
      subtask('UI', ['apps/frontend/src/widgets.tsx']),
    ]);

    expect(finding(result, 'stale_blocker_exists')).toMatchObject({
      severity: 'warning',
      file_path: 'apps/api/src/widgets.ts',
    });
  });

  it('reports quota-risk runtimes against matching capability hints as info', async () => {
    planValidationRuntime.quotaRiskRuntimes = [
      {
        agent: 'codex',
        session_id: 'quota-session',
        reason: 'quota',
        capability_hints: ['api_work'],
      },
    ];

    const result = await callValidate([
      subtask('API', ['apps/api/src/widgets.ts'], undefined, 'api_work'),
      subtask('UI', ['apps/frontend/src/widgets.tsx'], undefined, 'ui_work'),
    ]);

    expect(finding(result, 'quota_risk_runtime_assigned')).toMatchObject({
      severity: 'info',
      subtask_index: 0,
      detail: 'quota',
    });
  });

  it('warns when a dirty worktree touches a planned file', async () => {
    planValidationRuntime.readWorktreeContention = (root) => ({
      ...emptyWorktreeReport(root),
      worktrees: [
        {
          branch: 'agent/codex/dirty',
          path: '/worktrees/dirty',
          managed_root: '.omx/agent-worktrees',
          dirty_files: [{ path: 'apps/api/src/widgets.ts', status: ' M' }],
          claimed_files: [],
          active_session: null,
        },
      ],
    });

    const result = await callValidate([
      subtask('API', ['apps/api/src/widgets.ts']),
      subtask('UI', ['apps/frontend/src/widgets.tsx']),
    ]);

    expect(finding(result, 'dirty_worktree_touches_planned_file')).toMatchObject({
      severity: 'warning',
      file_path: 'apps/api/src/widgets.ts',
    });
  });

  it('reports OMX active note conflicts as info', async () => {
    planValidationRuntime.omxNotes = [
      {
        session_id: 'omx-note',
        content:
          'branch=agent/codex/other; task=other lane; blocker=none; next=apps/api/src/widgets.ts; evidence=notepad',
        file_paths: ['apps/api/src/widgets.ts'],
      },
    ];

    const result = await callValidate([
      subtask('API', ['apps/api/src/widgets.ts']),
      subtask('UI', ['apps/frontend/src/widgets.tsx']),
    ]);

    expect(finding(result, 'omx_active_note_conflicts')).toMatchObject({
      severity: 'info',
      subtask_index: 0,
      file_path: 'apps/api/src/widgets.ts',
    });
  });

  it('errors when a required MCP capability is unavailable', async () => {
    planValidationRuntime.requiredMcpTools = ['mcp__colony__task_plan_claim_subtask'];
    planValidationRuntime.availableMcpTools = ['mcp__colony__task_plan_validate'];

    const result = await callValidate([
      subtask('API', ['apps/api/src/widgets.ts']),
      subtask('UI', ['apps/frontend/src/widgets.tsx']),
    ]);

    expect(result.summary.blocking).toBe(true);
    expect(result.partition_clean).toBe(false);
    expect(finding(result, 'required_mcp_capability_unavailable')).toMatchObject({
      severity: 'error',
      detail: 'mcp__colony__task_plan_claim_subtask',
    });
  });

  it('warns when protected files are planned without strict claim policy', async () => {
    planValidationRuntime.protectedFilePatterns = ['AGENTS.md'];
    planValidationRuntime.strictClaimPolicy = false;

    const result = await callValidate([
      subtask('Policy', ['AGENTS.md']),
      subtask('Docs', ['docs/queen.md']),
    ]);

    expect(finding(result, 'protected_file_without_strict_claim_policy')).toMatchObject({
      severity: 'warning',
      subtask_index: 0,
      file_path: 'AGENTS.md',
    });
  });

  it('warns when independent sub-tasks touch different files in the same module', async () => {
    const result = await callValidate([
      subtask('Core API', ['packages/core/src/api.ts']),
      subtask('Core plan', ['packages/core/src/plan.ts']),
    ]);

    expect(result.partition_clean).toBe(true);
    expect(result.module_warnings).toEqual([{ a: 0, b: 1, shared_modules: ['packages/core/src'] }]);
  });

  it('suppresses same-module warnings for sequenced sub-tasks', async () => {
    const result = await callValidate([
      subtask('Core API', ['packages/core/src/api.ts']),
      subtask('Core plan', ['packages/core/src/plan.ts'], [0]),
    ]);

    expect(result.partition_clean).toBe(true);
    expect(result.module_warnings).toEqual([]);
  });

  it('reports ordered-wave dependency errors before publish', async () => {
    const result = await callValidate([
      subtask('API', ['apps/api/src/widgets.ts'], [1]),
      subtask('UI', ['apps/frontend/src/widgets.tsx']),
    ]);

    expect(result.partition_clean).toBe(false);
    expect(result.ordered_wave_errors).toMatchObject([
      {
        code: 'PLAN_INVALID_WAVE_DEPENDENCY',
        subtask_index: 0,
        dependency_index: 1,
      },
    ]);
    expect(result.ordered_wave_errors[0]?.message).toContain('earlier indices');
  });

  it('reports finalizers that do not depend on all earlier work', async () => {
    const result = await callValidate([
      subtask('Build API', ['apps/api/src/widgets.ts']),
      subtask('Build UI', ['apps/frontend/src/widgets.tsx']),
      subtask('Verify release', ['apps/api/test/widgets.test.ts'], [0], 'test_work'),
    ]);

    expect(result.partition_clean).toBe(false);
    expect(result.ordered_wave_errors).toMatchObject([
      {
        code: 'PLAN_FINALIZER_NOT_LAST',
        subtask_index: 2,
        related_subtask_indices: [1],
      },
    ]);
    expect(result.ordered_wave_errors[0]?.message).toContain('must depend on every earlier');
  });

  it('accepts valid ordered waves with a complete finalizer dependency set', async () => {
    const result = await callValidate([
      subtask('Prepare storage', ['packages/storage/src/widgets.ts']),
      subtask('Build API', ['apps/api/src/widgets.ts'], [0]),
      subtask('Build UI', ['apps/frontend/src/widgets.tsx'], [0]),
      subtask('Verify release', ['apps/api/test/widgets.test.ts'], [1, 2], 'test_work'),
    ]);

    expect(result.partition_clean).toBe(true);
    expect(result.ordered_wave_errors).toEqual([]);
    expect(result.pairwise_overlaps).toEqual([]);
  });
});
