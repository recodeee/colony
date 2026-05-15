import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { MemoryStore, TaskThread } from '@colony/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  OMX_LIFECYCLE_SCHEMA,
  parseOmxLifecycleEnvelope,
  runOmxLifecycleEnvelope,
} from '../src/lifecycle-envelope.js';

let dir: string;
let store: MemoryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'colony-omx-lifecycle-'));
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('OMX lifecycle envelope', () => {
  it('normalizes the shared envelope shape', () => {
    const parsed = parseOmxLifecycleEnvelope({
      event_id: 'evt_normalize',
      event_name: 'pre_tool_use',
      session_id: 'codex@life',
      agent: 'codex',
      cwd: '/repo/worktree',
      repo_root: '/repo',
      branch: 'agent/codex/life',
      timestamp: '2026-04-29T10:01:00.000Z',
      source: 'omx',
      tool_name: 'Edit',
      tool_input: {
        operation: 'replace',
        paths: [{ path: 'src/a.ts', role: 'target', kind: 'file' }],
      },
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.event).toMatchObject({
      schema: OMX_LIFECYCLE_SCHEMA,
      event_id: 'evt_normalize',
      event_type: 'pre_tool_use',
      session_id: 'codex@life',
      agent: 'codex',
      ide: 'codex',
      cwd: '/repo/worktree',
      repo_root: '/repo',
      branch: 'agent/codex/life',
      tool_name: 'Edit',
      source: 'omx',
    });
  });

  it('routes task_bind to active task resolution', async () => {
    const repo = fakeGitRepo('repo-bind', 'agent/codex/lifecycle-bind');
    const result = await runOmxLifecycleEnvelope(
      envelope({
        event_id: 'evt_bind',
        event_name: 'task_bind',
        session_id: 'codex@bind',
        cwd: repo,
        repo_root: repo,
        branch: 'agent/codex/lifecycle-bind',
      }),
      { store },
    );

    expect(result).toMatchObject({ ok: true, event_id: 'evt_bind', route: 'task_bind' });
    const taskId = store.storage.findActiveTaskForSession('codex@bind');
    expect(taskId).toBeDefined();
    if (taskId === undefined) throw new Error('task not bound');
    expect(store.storage.getParticipantAgent(taskId, 'codex@bind')).toBe('codex');
    expect(store.storage.taskObservationsByKind(taskId, 'omx-lifecycle')).toHaveLength(1);
  });

  it('dedupes duplicate event_id before a second pre-tool-use claim', async () => {
    const repo = fakeGitRepo('repo-pre', 'agent/codex/lifecycle-pre');
    const payload = envelope({
      event_id: 'evt_duplicate_pre',
      event_name: 'pre_tool_use',
      session_id: 'codex@pre',
      cwd: repo,
      repo_root: repo,
      branch: 'agent/codex/lifecycle-pre',
      tool_name: 'Edit',
      tool_input: {
        operation: 'replace',
        paths: [{ path: 'packages/hooks/src/lifecycle-envelope.ts', role: 'target', kind: 'file' }],
      },
    });

    const first = await runOmxLifecycleEnvelope(payload, { store });
    const second = await runOmxLifecycleEnvelope(payload, { store });

    expect(first).toMatchObject({ ok: true, route: 'pre-tool-use' });
    expect(second).toMatchObject({ ok: true, duplicate: true, route: 'duplicate' });
    const taskId = store.storage.findActiveTaskForSession('codex@pre');
    expect(taskId).toBeDefined();
    if (taskId === undefined) throw new Error('task not bound');
    expect(store.storage.taskObservationsByKind(taskId, 'claim')).toHaveLength(1);
    expect(store.storage.taskObservationsByKind(taskId, 'claim-before-edit')).toHaveLength(1);
    expect(store.storage.taskObservationsByKind(taskId, 'omx-lifecycle')).toHaveLength(1);
  });

  it('records warning metadata when lifecycle edit path extraction fails', async () => {
    const repo = fakeGitRepo('repo-path-warning', 'agent/codex/path-warning');
    const bind = await runOmxLifecycleEnvelope(
      envelope({
        event_id: 'evt_warning_bind',
        event_name: 'task_bind',
        session_id: 'codex@path-warning',
        cwd: repo,
        repo_root: repo,
        branch: 'agent/codex/path-warning',
      }),
      { store },
    );
    expect(bind.ok).toBe(true);

    const pre = await runOmxLifecycleEnvelope(
      envelope({
        event_id: 'evt_warning_pre',
        event_name: 'pre_tool_use',
        session_id: 'codex@path-warning',
        cwd: repo,
        repo_root: repo,
        branch: 'agent/codex/path-warning',
        tool_name: 'Write',
        tool_input: { content: 'export const missingPath = true;\n' },
      }),
      { store },
    );
    expect(pre).toMatchObject({
      ok: true,
      route: 'pre-tool-use',
      extracted_paths: [],
      warnings: [expect.stringContaining('No claimable file paths extracted from Write')],
    });

    const post = await runOmxLifecycleEnvelope(
      envelope({
        event_id: 'evt_warning_post',
        event_name: 'post_tool_use',
        parent_event_id: 'evt_warning_pre',
        session_id: 'codex@path-warning',
        cwd: repo,
        repo_root: repo,
        branch: 'agent/codex/path-warning',
        tool_name: 'Write',
        tool_input: { content: 'export const missingPath = true;\n' },
        tool_response: { success: true },
      }),
      { store },
    );
    expect(post).toMatchObject({
      ok: true,
      route: 'post-tool-use',
      extracted_paths: [],
      warnings: [expect.stringContaining('No claimable file paths extracted from Write')],
    });

    const taskId = store.storage.findActiveTaskForSession('codex@path-warning');
    expect(taskId).toBeDefined();
    if (taskId === undefined) throw new Error('task not bound');

    const signal = store.storage.taskObservationsByKind(taskId, 'claim-before-edit', 1)[0];
    expect(parseMetadata(signal?.metadata)).toMatchObject({
      outcome: 'path_extraction_failed',
      file_path: null,
      extracted_paths: [],
      tool: 'Write',
      code: 'PATH_EXTRACTION_FAILED',
      path_extraction_failed: true,
      path_extraction_warning: expect.stringContaining('No claimable file paths extracted'),
    });

    const postLifecycle = store.storage
      .taskObservationsByKind(taskId, 'omx-lifecycle')
      .map((row) => parseMetadata(row.metadata))
      .find((metadata) => metadata?.event_id === 'evt_warning_post');
    expect(postLifecycle).toMatchObject({
      path_extraction_failed: true,
      path_extraction_warning: expect.stringContaining('No claimable file paths extracted'),
    });

    const toolUse = store.storage
      .timeline('codex@path-warning')
      .find((row) => row.kind === 'tool_use');
    expect(parseMetadata(toolUse?.metadata)).toMatchObject({
      tool: 'Write',
      path_extraction_failed: true,
      path_extraction_warning: expect.stringContaining('No claimable file paths extracted'),
    });

    expect(store.storage.claimBeforeEditStats(0)).toMatchObject({
      edit_tool_calls: 1,
      edits_with_file_path: 0,
      pre_tool_use_signals: 1,
    });
  });

  it('records a first-class quota-exhausted handoff from stop_intent', async () => {
    const repo = fakeGitRepo('repo-quota', 'agent/codex/quota-stop');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'git-only.ts'), 'export const dirty = true;\n');
    const bind = await runOmxLifecycleEnvelope(
      envelope({
        event_id: 'evt_quota_bind',
        event_name: 'task_bind',
        session_id: 'codex@quota',
        cwd: repo,
        repo_root: repo,
        branch: 'agent/codex/quota-stop',
      }),
      { store },
    );
    expect(bind.ok).toBe(true);
    const taskId = store.storage.findActiveTaskForSession('codex@quota');
    expect(taskId).toBeDefined();
    if (taskId === undefined) throw new Error('task not bound');
    const thread = new TaskThread(store, taskId);
    thread.claimFile({ session_id: 'codex@quota', file_path: 'src/runtime.ts' });

    const result = await runOmxLifecycleEnvelope(
      envelope({
        event_id: 'evt_quota_stop',
        event_name: 'stop_intent',
        session_id: 'codex@quota',
        cwd: repo,
        repo_root: repo,
        branch: 'agent/codex/quota-stop',
        result: {
          code: 'quota_exhausted',
          message: 'Codex quota reached',
          dirty_files: ['src/runtime.ts'],
          last_command: 'pnpm test',
          last_tool: 'Bash',
          last_verification_command: 'pnpm test',
          last_verification_result: 'blocked: quota_exhausted',
        },
      }),
      { store },
    );

    expect(result).toMatchObject({ ok: true, event_id: 'evt_quota_stop', route: 'stop' });
    const handoff = store.storage.taskObservationsByKind(taskId, 'handoff', 1)[0];
    expect(handoff).toBeDefined();
    const meta = JSON.parse(handoff?.metadata ?? '{}');
    expect(meta).toMatchObject({
      kind: 'handoff',
      reason: 'quota_exhausted',
      runtime_status: 'blocked_by_runtime_limit',
      status: 'pending',
      from_session_id: 'codex@quota',
      from_agent: 'codex',
      to_agent: 'any',
      quota_context: {
        agent: 'codex',
        session_id: 'codex@quota',
        repo_root: repo,
        branch: 'agent/codex/quota-stop',
        worktree_path: repo,
        task_id: taskId,
        claimed_files: ['src/runtime.ts'],
        dirty_files: expect.arrayContaining(['src/runtime.ts', 'src/git-only.ts']),
        last_command: 'pnpm test',
        last_tool: 'Bash',
        last_verification: {
          command: 'pnpm test',
          result: 'blocked: quota_exhausted',
        },
      },
    });
    expect(meta.handoff_ttl_ms).toBeGreaterThan(0);
    expect(meta.quota_context.suggested_next_step).toContain('blocked_by_runtime_limit');
    expect(store.storage.getClaim(taskId, 'src/runtime.ts')).toMatchObject({
      session_id: 'codex@quota',
      state: 'handoff_pending',
      handoff_observation_id: handoff?.id,
    });
    expect(handoff?.content).toContain('dirty_files=src/runtime.ts');
    expect(handoff?.content).toContain('src/git-only.ts');
    expect(handoff?.content).toContain('claimed_files=src/runtime.ts');
  });

  it('keeps a bounded stalled-lane banner when lifecycle SessionStart refreshes telemetry', async () => {
    const repo = fakeGitRepo('repo-stalled-start', 'agent/codex/stalled-start');
    const sessionFile = writeActiveSession(repo, {
      sessionKey: 'codex@stalled',
      branch: 'agent/codex/stalled-start',
      taskName: 'stale stalled task',
      latestTaskPreview: 'stale stalled task',
      lastHeartbeatAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      state: 'working',
    });

    const result = await runOmxLifecycleEnvelope(
      envelope({
        event_id: 'evt_stalled_session_start',
        event_name: 'session_start',
        session_id: 'codex@stalled',
        cwd: repo,
        repo_root: repo,
        branch: 'agent/codex/stalled-start',
      }),
      { store },
    );

    expect(result).toMatchObject({
      ok: true,
      event_id: 'evt_stalled_session_start',
      route: 'session-start',
    });
    expect(result.context).toContain('Stalled lanes at SessionStart (1 of 1):');
    expect(result.context).toContain('codex/codex dead on agent/codex/stalled-start');
    expect(result.context).toContain('stale stalled task');

    const refreshedSession = JSON.parse(readFileSync(sessionFile, 'utf8')) as {
      lastHeartbeatAt?: string;
    };
    expect(refreshedSession.lastHeartbeatAt).not.toBeUndefined();
    expect(Date.parse(refreshedSession.lastHeartbeatAt ?? '')).toBeGreaterThan(
      Date.now() - 60_000,
    );
  });
});

function envelope(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    event_id: 'evt_default',
    event_name: 'session_start',
    session_id: 'codex@default',
    agent: 'codex',
    cwd: '/repo',
    repo_root: '/repo',
    branch: 'main',
    timestamp: '2026-04-29T10:01:00.000Z',
    source: 'omx',
    ...overrides,
  };
}

function fakeGitRepo(name: string, branch: string): string {
  const repo = join(dir, name);
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '--quiet', '-b', branch, repo], { stdio: 'ignore' });
  return repo;
}

function writeActiveSession(
  repo: string,
  record: {
    sessionKey: string;
    branch: string;
    taskName: string;
    latestTaskPreview: string;
    lastHeartbeatAt: string;
    state: string;
  },
): string {
  const sessionFile = join(
    repo,
    '.omx',
    'state',
    'active-sessions',
    `${record.sessionKey.replace(/[^a-zA-Z0-9._-]+/g, '_')}.json`,
  );
  mkdirSync(join(repo, '.omx', 'state', 'active-sessions'), { recursive: true });
  writeFileSync(
    sessionFile,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        repoRoot: repo,
        branch: record.branch,
        taskName: record.taskName,
        latestTaskPreview: record.latestTaskPreview,
        agentName: 'codex',
        cliName: 'codex',
        worktreePath: repo,
        taskRoutingReason: 'test stale hook contract',
        startedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
        lastHeartbeatAt: record.lastHeartbeatAt,
        state: record.state,
        sessionKey: record.sessionKey,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return sessionFile;
}

function parseMetadata(value: string | null | undefined): Record<string, unknown> | null {
  if (!value) return null;
  return JSON.parse(value) as Record<string, unknown>;
}
