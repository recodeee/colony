import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { MemoryStore } from '@colony/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runHook } from '../src/index.js';

let dir: string;
let store: MemoryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'colony-hooks-'));
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('runHook', () => {
  it('session-start creates a session and returns a (possibly empty) context', async () => {
    const r = await runHook(
      'session-start',
      { session_id: 'sess-a', ide: 'claude-code', cwd: '/tmp' },
      { store },
    );
    expect(r.ok).toBe(true);
    expect(store.storage.getSession('sess-a')?.ide).toBe('claude-code');
    expect(typeof r.context).toBe('string');
  });

  it('user-prompt-submit records a compressed observation', async () => {
    await runHook('session-start', { session_id: 'sess-b', ide: 'claude-code' }, { store });
    const r = await runHook(
      'user-prompt-submit',
      {
        session_id: 'sess-b',
        ide: 'claude-code',
        prompt: 'Please basically just update the /etc/hosts file.',
      },
      { store },
    );
    expect(r.ok).toBe(true);
    const tl = store.timeline('sess-b');
    expect(tl).toHaveLength(1);
    expect(tl[0]?.kind).toBe('user_prompt');
    expect(tl[0]?.compressed).toBe(true);
    // Path is preserved byte-for-byte even when neighbouring prose is stripped.
    expect(tl[0]?.content).toContain('/etc/hosts');
    expect(tl[0]?.content).not.toMatch(/basically/i);
  });

  it('user-prompt-submit reminds Claude Code to read files before edit tools', async () => {
    const claude = await runHook(
      'user-prompt-submit',
      {
        session_id: 'sess-claude-edit',
        ide: 'claude-code',
        prompt: 'Update packages/hooks/src/handlers/user-prompt-submit.ts',
      },
      { store },
    );
    expect(claude.ok).toBe(true);
    expect(claude.context).toContain('Read each existing target file before Edit/Update/MultiEdit');
    expect(claude.context).toContain('File must be read first');

    const codex = await runHook(
      'user-prompt-submit',
      {
        session_id: 'sess-codex-edit',
        ide: 'codex',
        prompt: 'Update packages/hooks/src/handlers/user-prompt-submit.ts',
      },
      { store },
    );
    expect(codex.ok).toBe(true);
    expect(codex.context ?? '').not.toContain('Edit/Update/MultiEdit');
  });

  it('post-tool-use records a tool_use observation with metadata', async () => {
    await runHook('session-start', { session_id: 'sess-c', ide: 'claude-code' }, { store });
    const r = await runHook(
      'post-tool-use',
      {
        session_id: 'sess-c',
        ide: 'claude-code',
        tool: 'Bash',
        tool_input: { command: 'ls' },
        tool_output: 'file.txt',
      },
      { store },
    );
    expect(r.ok).toBe(true);
    const tl = store.timeline('sess-c');
    expect(tl).toHaveLength(1);
    expect(tl[0]?.kind).toBe('tool_use');
    expect(tl[0]?.metadata).toEqual({ tool: 'Bash' });
  });

  it('stop stores a turn summary; session-end rolls up turns and closes the session', async () => {
    await runHook('session-start', { session_id: 'sess-d', ide: 'claude-code' }, { store });
    await runHook(
      'stop',
      { session_id: 'sess-d', ide: 'claude-code', turn_summary: 'fixed the auth bug' },
      { store },
    );
    await runHook(
      'stop',
      { session_id: 'sess-d', ide: 'claude-code', turn_summary: 'updated tests' },
      { store },
    );
    const turns = store.storage.listSummaries('sess-d').filter((s) => s.scope === 'turn');
    expect(turns).toHaveLength(2);

    await runHook('session-end', { session_id: 'sess-d', ide: 'claude-code' }, { store });
    const sessions = store.storage.listSummaries('sess-d').filter((s) => s.scope === 'session');
    expect(sessions).toHaveLength(1);
    expect(store.storage.getSession('sess-d')?.ended_at).not.toBeNull();
  });

  it('session-start is idempotent across resume/clear/compact', async () => {
    const a = await runHook(
      'session-start',
      { session_id: 'dup', ide: 'claude-code', source: 'startup' },
      { store },
    );
    const b = await runHook(
      'session-start',
      { session_id: 'dup', ide: 'claude-code', source: 'resume' },
      { store },
    );
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    // Resume must not inject a "Prior-session context" preface — the agent
    // already carries its own context across the resume.
    expect(b.context).toBe('');
  });

  it('returns ok=false with an error message when storage is unavailable', async () => {
    // Force a failure by closing the store before running a hook.
    const broken = new MemoryStore({
      dbPath: join(dir, 'broken.db'),
      settings: defaultSettings,
    });
    broken.close();
    const r = await runHook(
      'user-prompt-submit',
      { session_id: 'never', prompt: 'hi' },
      { store: broken },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('hooks survive when SessionStart never fired (mid-session install)', async () => {
    // No session-start for "orphan" — Claude Code installed after the session
    // was already running. Each downstream hook must materialise the session
    // row itself instead of crashing on FOREIGN KEY constraint failed.
    const a = await runHook(
      'user-prompt-submit',
      { session_id: 'orphan', prompt: 'check /etc/hosts' },
      { store },
    );
    expect(a.ok).toBe(true);
    const b = await runHook(
      'post-tool-use',
      {
        session_id: 'orphan',
        tool_name: 'Read',
        tool_input: { file_path: '/etc/hosts' },
        tool_response: { ok: true },
      },
      { store },
    );
    expect(b.ok).toBe(true);
    const c = await runHook(
      'stop',
      { session_id: 'orphan', last_assistant_message: 'all set' },
      { store },
    );
    expect(c.ok).toBe(true);
    expect(store.storage.getSession('orphan')?.ide).toBe('unknown');
    expect(store.timeline('orphan')).toHaveLength(2);
  });

  it('repo-binds downstream hooks when SessionStart never fired but cwd is known', async () => {
    const repo = join(dir, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/agent/codex/live\n', 'utf8');

    const r = await runHook(
      'user-prompt-submit',
      {
        session_id: 'codex@late',
        ide: 'codex',
        cwd: repo,
        prompt: 'fix colony cwd registration',
      },
      { store },
    );

    expect(r.ok).toBe(true);
    expect(store.storage.getSession('codex@late')).toMatchObject({
      ide: 'codex',
      cwd: repo,
    });
    expect(store.storage.listTasks(5)[0]).toMatchObject({
      repo_root: repo,
      branch: 'agent/codex/live',
    });

    const sessionFile = join(repo, '.omx', 'state', 'active-sessions', 'codex_late.json');
    expect(existsSync(sessionFile)).toBe(true);
    const active = JSON.parse(readFileSync(sessionFile, 'utf8')) as Record<string, unknown>;
    expect(active).toMatchObject({
      repoRoot: repo,
      branch: 'agent/codex/live',
      agentName: 'codex',
      cliName: 'codex',
      worktreePath: repo,
      latestTaskPreview: 'fix colony cwd registration',
      state: 'thinking',
      sessionKey: 'codex@late',
    });
  });

  it('post-tool-use accepts Claude Code field names (tool_name, tool_response)', async () => {
    await runHook(
      'session-start',
      { session_id: 'sess-cc', ide: 'claude-code', source: 'startup' },
      { store },
    );
    const r = await runHook(
      'post-tool-use',
      {
        session_id: 'sess-cc',
        tool_name: 'Edit',
        tool_input: { file_path: '/tmp/x.txt' },
        tool_response: { success: true },
      },
      { store },
    );
    expect(r.ok).toBe(true);
    const tl = store.timeline('sess-cc');
    expect(tl).toHaveLength(1);
    // Edit + file_path: the handler now records the touched file path in
    // metadata so observe/debrief can correlate edits with claims without
    // re-parsing the content field.
    expect(tl[0]?.metadata).toEqual({ tool: 'Edit', file_path: '/tmp/x.txt' });
    expect(tl[0]?.content).toContain('Edit');
  });

  it('stop accepts Claude Code last_assistant_message and skips empty turns', async () => {
    await runHook(
      'session-start',
      { session_id: 'sess-cc2', ide: 'claude-code', source: 'startup' },
      { store },
    );
    const empty = await runHook(
      'stop',
      { session_id: 'sess-cc2', stop_hook_active: false },
      { store },
    );
    expect(empty.ok).toBe(true);
    expect(store.storage.listSummaries('sess-cc2')).toHaveLength(0);

    const filled = await runHook(
      'stop',
      { session_id: 'sess-cc2', last_assistant_message: 'shipped the migration' },
      { store },
    );
    expect(filled.ok).toBe(true);
    const turns = store.storage.listSummaries('sess-cc2').filter((s) => s.scope === 'turn');
    expect(turns).toHaveLength(1);
  });

  it('hot-path hooks stay under a generous 150ms budget on a warm runtime', async () => {
    await runHook('session-start', { session_id: 'sess-perf', ide: 'claude-code' }, { store });
    // Warm up JIT / prepared-statement cache.
    for (let i = 0; i < 5; i++) {
      await runHook(
        'post-tool-use',
        {
          session_id: 'sess-perf',
          ide: 'claude-code',
          tool: 'Bash',
          tool_input: { command: 'noop' },
          tool_output: 'ok',
        },
        { store },
      );
    }
    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      await runHook(
        'post-tool-use',
        {
          session_id: 'sess-perf',
          ide: 'claude-code',
          tool: 'Bash',
          tool_input: { command: 'noop' },
          tool_output: 'ok',
        },
        { store },
      );
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)] ?? 0;
    expect(p95).toBeLessThan(150);
  });
});
