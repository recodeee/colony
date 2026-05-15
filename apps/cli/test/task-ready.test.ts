import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSettings } from '@colony/config';
import { type MemoryStore, TaskThread } from '@colony/core';
import kleur from 'kleur';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProgram } from '../src/index.js';
import { withStore } from '../src/util/store.js';

let repoRoot: string;
let dataDir: string;
let output: string;
let originalColonyHome: string | undefined;

beforeEach(() => {
  kleur.enabled = false;
  repoRoot = mkdtempSync(join(tmpdir(), 'colony-task-ready-repo-'));
  dataDir = mkdtempSync(join(tmpdir(), 'colony-task-ready-data-'));
  writeFileSync(join(repoRoot, 'SPEC.md'), '# SPEC\n', 'utf8');
  originalColonyHome = process.env.COLONY_HOME;
  process.env.COLONY_HOME = dataDir;
  output = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
  if (originalColonyHome === undefined) delete process.env.COLONY_HOME;
  else process.env.COLONY_HOME = originalColonyHome;
  kleur.enabled = true;
});

describe('colony task ready', () => {
  it('prints claimable ready work with the exact MCP claim call', async () => {
    const settings = loadSettings();
    await withStore(settings, (store) => seedReadyPlan(store, 'ready-cli-plan'));

    await createProgram().parseAsync(
      [
        'node',
        'test',
        'task',
        'ready',
        '--session',
        'agent-session',
        '--agent',
        'codex',
        '--repo-root',
        repoRoot,
      ],
      { from: 'node' },
    );

    expect(output).toContain('colony task ready');
    expect(output).toContain('ready-cli-plan/sub-0');
    expect(output).toContain('next_tool: task_plan_claim_subtask');
    expect(output).toContain('mcp__colony__task_plan_claim_subtask');
    expect(output).toContain('priority=1');
  });

  it('prints CLI quota-accept command for quota relay work', async () => {
    const settings = loadSettings();
    let taskId = 0;
    let relayId = 0;
    await withStore(settings, (store) => {
      const seeded = seedQuotaRelay(store);
      taskId = seeded.taskId;
      relayId = seeded.relayId;
    });

    await createProgram().parseAsync(
      [
        'node',
        'test',
        'task',
        'ready',
        '--session',
        'agent-session',
        '--agent',
        'codex',
        '--repo-root',
        repoRoot,
      ],
      { from: 'node' },
    );

    expect(output).toContain(`quota relay task ${taskId}`);
    expect(output).toContain('next_tool: task_claim_quota_accept');
    expect(output).toContain('mcp__colony__task_claim_quota_accept');
    expect(output).toContain(
      `cmd: colony task quota-accept --task-id ${taskId} --handoff-observation-id ${relayId} --session <session_id> --agent <agent>`,
    );
  });

  it('accepts quota-pending claims from the CLI', async () => {
    const settings = loadSettings();
    let taskId = 0;
    let relayId = 0;
    await withStore(settings, (store) => {
      const seeded = seedQuotaRelay(store);
      taskId = seeded.taskId;
      relayId = seeded.relayId;
    });

    await createProgram().parseAsync(
      [
        'node',
        'test',
        'task',
        'quota-accept',
        '--task-id',
        String(taskId),
        '--handoff-observation-id',
        String(relayId),
        '--session',
        'agent-session',
        '--agent',
        'codex',
      ],
      { from: 'node' },
    );

    expect(output).toContain(`quota accepted task=${taskId} handoff=${relayId}`);
    expect(output).toContain('files=apps/cli/src/commands/task.ts');
    await withStore(settings, (store) => {
      expect(store.storage.getClaim(taskId, 'apps/cli/src/commands/task.ts')).toMatchObject({
        session_id: 'agent-session',
        state: 'active',
      });
    });
  });

  it('batch releases expired quota-pending claims with --all-safe', async () => {
    const settings = loadSettings();
    let taskId = 0;
    await withStore(settings, (store) => {
      const seeded = seedQuotaRelay(store, -1);
      taskId = seeded.taskId;
    });

    await createProgram().parseAsync(
      [
        'node',
        'test',
        'task',
        'quota-release-expired',
        '--all-safe',
        '--repo-root',
        repoRoot,
        '--json',
      ],
      { from: 'node' },
    );

    const payload = JSON.parse(output) as {
      status: string;
      mode: string;
      summary: { released_expired_quota_pending_claim_count: number };
      released_claims: Array<{ file_path: string }>;
    };
    expect(payload).toMatchObject({
      status: 'released_expired',
      mode: 'all_safe',
      summary: { released_expired_quota_pending_claim_count: 1 },
      released_claims: [{ file_path: 'apps/cli/src/commands/task.ts' }],
    });
    await withStore(settings, (store) => {
      expect(store.storage.getClaim(taskId, 'apps/cli/src/commands/task.ts')).toMatchObject({
        session_id: 'quota-session',
        state: 'weak_expired',
      });
    });
  });

  it('prints empty state with proposal and Queen recovery path', async () => {
    await createProgram().parseAsync(
      [
        'node',
        'test',
        'task',
        'ready',
        '--session',
        'agent-session',
        '--agent',
        'codex',
        '--repo-root',
        repoRoot,
      ],
      { from: 'node' },
    );

    expect(output).toContain('ready: 0/0');
    expect(output).toContain('Queen/task plan');
    expect(output).toContain('task_propose');
  });
});

function seedReadyPlan(store: MemoryStore, slug: string): void {
  store.startSession({ id: 'planner', ide: 'claude-code', cwd: repoRoot });
  store.startSession({ id: 'agent-session', ide: 'codex', cwd: repoRoot });
  const parent = TaskThread.open(store, {
    repo_root: repoRoot,
    branch: `spec/${slug}`,
    session_id: 'planner',
    title: slug,
  });
  store.addObservation({
    session_id: 'planner',
    task_id: parent.task_id,
    kind: 'plan-config',
    content: `plan ${slug}`,
    metadata: { plan_slug: slug },
  });
  const subtask = TaskThread.open(store, {
    repo_root: repoRoot,
    branch: `spec/${slug}/sub-0`,
    session_id: 'planner',
    title: 'Implement ready CLI',
  });
  store.addObservation({
    session_id: 'planner',
    task_id: subtask.task_id,
    kind: 'plan-subtask',
    content: 'Implement ready CLI\n\nExpose ready task picker.',
    metadata: {
      parent_plan_slug: slug,
      parent_plan_title: slug,
      parent_spec_task_id: parent.task_id,
      subtask_index: 0,
      title: 'Implement ready CLI',
      description: 'Expose ready task picker.',
      file_scope: ['apps/cli/src/commands/task.ts'],
      depends_on: [],
      spec_row_id: null,
      capability_hint: 'api_work',
      status: 'available',
    },
  });
}

function seedQuotaRelay(
  store: MemoryStore,
  expiresInMs = 60 * 60_000,
): { taskId: number; relayId: number } {
  store.startSession({ id: 'quota-session', ide: 'codex', cwd: repoRoot });
  store.startSession({ id: 'agent-session', ide: 'codex', cwd: repoRoot });
  const thread = TaskThread.open(store, {
    repo_root: repoRoot,
    branch: 'dev',
    session_id: 'quota-session',
    title: 'Quota stopped task',
  });
  thread.join('quota-session', 'codex');
  store.storage.claimFile({
    task_id: thread.task_id,
    file_path: 'apps/cli/src/commands/task.ts',
    session_id: 'quota-session',
  });
  const relayId = thread.relay({
    from_session_id: 'quota-session',
    from_agent: 'codex',
    reason: 'quota',
    one_line: 'finish task CLI quota relay command',
    base_branch: 'dev',
    expires_in_ms: expiresInMs,
  });
  return { taskId: thread.task_id, relayId };
}
