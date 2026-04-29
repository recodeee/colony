import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

  it('records a first-class quota-exhausted handoff from stop_intent', async () => {
    const repo = fakeGitRepo('repo-quota', 'agent/codex/quota-stop');
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
        dirty_files: ['src/runtime.ts'],
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
  mkdirSync(join(repo, '.git'), { recursive: true });
  writeFileSync(join(repo, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`, 'utf8');
  return repo;
}
