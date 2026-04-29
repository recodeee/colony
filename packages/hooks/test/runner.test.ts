import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BridgePolicyMode, defaultSettings } from '@colony/config';
import { MemoryStore, TaskThread } from '@colony/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHook } from '../src/index.js';

let dir: string;
let store: MemoryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'colony-hooks-'));
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
});

afterEach(() => {
  vi.restoreAllMocks();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function useBridgePolicy(policyMode: BridgePolicyMode): void {
  store.close();
  store = new MemoryStore({
    dbPath: join(dir, `${policyMode}.db`),
    settings: {
      ...defaultSettings,
      bridge: { ...defaultSettings.bridge, policyMode },
    },
  });
}

function seedClaimConflict(options: { file_path?: string; ageMinutes?: number } = {}): number {
  const filePath = options.file_path ?? 'src/viewer.tsx';
  store.startSession({ id: 'A', ide: 'claude-code', cwd: '/repo' });
  store.startSession({ id: 'B', ide: 'codex', cwd: '/repo' });
  const thread = TaskThread.open(store, {
    repo_root: '/repo',
    branch: 'feat/policy',
    session_id: 'A',
  });
  thread.join('A', 'claude');
  thread.join('B', 'codex');
  const ageMinutes = options.ageMinutes ?? 0;
  const claimedAt = Date.now() - ageMinutes * 60_000;
  const nowSpy = ageMinutes > 0 ? vi.spyOn(Date, 'now').mockReturnValue(claimedAt) : null;
  try {
    thread.claimFile({ session_id: 'A', file_path: filePath });
  } finally {
    nowSpy?.mockRestore();
  }
  return thread.task_id;
}

function seedProtectedContention(filePath = 'src/shared.ts'): {
  protectedTaskId: number;
  agentTaskId: number;
} {
  store.startSession({ id: 'A', ide: 'claude-code', cwd: '/repo' });
  store.startSession({ id: 'B', ide: 'codex', cwd: '/repo' });
  const protectedThread = TaskThread.open(store, {
    repo_root: '/repo',
    branch: 'main',
    session_id: 'A',
  });
  protectedThread.join('A', 'claude');
  protectedThread.claimFile({ session_id: 'A', file_path: filePath });

  const agentThread = TaskThread.open(store, {
    repo_root: '/repo',
    branch: 'agent/codex/protected-contention',
    session_id: 'B',
  });
  agentThread.join('B', 'codex');

  return { protectedTaskId: protectedThread.task_id, agentTaskId: agentThread.task_id };
}

function metadataOf(row: { metadata: string | Record<string, unknown> | null } | undefined) {
  if (!row?.metadata) return {};
  return typeof row.metadata === 'string'
    ? (JSON.parse(row.metadata) as Record<string, unknown>)
    : row.metadata;
}

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

  it('post-tool-use surfaces Bash git, file, and redirect operations as coordination events', async () => {
    await runHook('session-start', { session_id: 'sess-bash', ide: 'codex' }, { store });
    const r = await runHook(
      'post-tool-use',
      {
        session_id: 'sess-bash',
        ide: 'codex',
        tool_name: 'Bash',
        tool_input: { command: 'git checkout main && rm old.ts > log.txt' },
        tool_response: { success: true },
      },
      { store },
    );
    expect(r.ok).toBe(true);

    const tl = store.timeline('sess-bash');
    expect(tl.filter((obs) => obs.kind === 'git-op')).toHaveLength(1);
    expect(tl.filter((obs) => obs.kind === 'file-op')).toHaveLength(1);
    expect(tl.filter((obs) => obs.kind === 'auto-claim')).toHaveLength(2);
    expect(tl.find((obs) => obs.kind === 'git-op')?.metadata).toMatchObject({
      op: 'checkout',
      source: 'bash-parser',
    });
    expect(tl.find((obs) => obs.kind === 'file-op')?.metadata).toMatchObject({
      op: 'rm',
      file_path: 'old.ts',
      source: 'bash-parser',
    });
    expect(
      tl.find((obs) => obs.kind === 'auto-claim' && metadataOf(obs).file_path === 'log.txt')
        ?.metadata,
    ).toMatchObject({
      file_path: 'log.txt',
      source: 'post-tool-use',
      tool: 'Write',
    });
    expect(
      tl.find((obs) => obs.kind === 'auto-claim' && metadataOf(obs).file_path === 'old.ts')
        ?.metadata,
    ).toMatchObject({
      file_path: 'old.ts',
      source: 'post-tool-use',
      tool: 'Bash',
    });
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

  it('active-session previews keep task intent and show meaningful Bash commands', async () => {
    const repo = join(dir, 'repo-bash');
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/agent/claude/bash\n', 'utf8');

    await runHook(
      'user-prompt-submit',
      {
        session_id: 'claude@bash-task',
        ide: 'claude-code',
        cwd: repo,
        prompt: 'Find what every agent is doing',
      },
      { store },
    );
    await runHook(
      'post-tool-use',
      {
        session_id: 'claude@bash-task',
        ide: 'claude-code',
        cwd: repo,
        tool_name: 'Bash',
        tool_input: {
          command: 'API_TOKEN=abc123 pnpm test --filter @colony/hooks',
        },
        tool_response: 'ok',
      },
      { store },
    );

    const sessionFile = join(repo, '.omx', 'state', 'active-sessions', 'claude_bash-task.json');
    const active = JSON.parse(readFileSync(sessionFile, 'utf8')) as Record<string, unknown>;
    expect(active).toMatchObject({
      taskName: 'Find what every agent is doing',
      latestTaskPreview: 'Bash: API_TOKEN=<redacted> pnpm test --filter @colony/hooks',
      state: 'working',
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
    expect(tl).toHaveLength(2);
    const toolUse = tl.find((obs) => obs.kind === 'tool_use');
    const autoClaim = tl.find((obs) => obs.kind === 'auto-claim');
    // Edit + file_path: the handler now records the touched file path in
    // metadata so observe/debrief can correlate edits with claims without
    // re-parsing the content field.
    expect(toolUse?.metadata).toEqual({
      tool: 'Edit',
      file_path: '/tmp/x.txt',
      file_paths: ['/tmp/x.txt'],
      extracted_paths: ['/tmp/x.txt'],
    });
    expect(toolUse?.content).toContain('Edit');
    expect(autoClaim?.metadata).toMatchObject({
      source: 'post-tool-use',
      file_path: '/tmp/x.txt',
      tool: 'Edit',
    });
  });

  it('post-tool-use records repo-relative edit paths', async () => {
    const repoRoot = join(dir, 'repo');
    mkdirSync(join(repoRoot, 'src'), { recursive: true });
    store.startSession({ id: 'sess-paths', ide: 'codex', cwd: repoRoot });
    const thread = TaskThread.open(store, {
      repo_root: repoRoot,
      branch: 'agent/paths',
      session_id: 'sess-paths',
    });
    thread.join('sess-paths', 'codex');

    const r = await runHook(
      'post-tool-use',
      {
        session_id: 'sess-paths',
        cwd: repoRoot,
        tool_name: 'Edit',
        tool_input: { file_path: join(repoRoot, 'src/viewer.tsx') },
        tool_response: { success: true },
      },
      { store },
    );

    expect(r.ok).toBe(true);
    const toolUse = store.timeline('sess-paths').find((obs) => obs.kind === 'tool_use');
    const autoClaim = store.timeline('sess-paths').find((obs) => obs.kind === 'auto-claim');
    expect(toolUse?.metadata).toMatchObject({ tool: 'Edit', file_path: 'src/viewer.tsx' });
    expect(autoClaim?.metadata).toMatchObject({
      source: 'post-tool-use',
      file_path: 'src/viewer.tsx',
      tool: 'Edit',
    });
  });

  it('post-tool-use skips pseudo file paths', async () => {
    await runHook('session-start', { session_id: 'sess-null', ide: 'codex', cwd: dir }, { store });

    const r = await runHook(
      'post-tool-use',
      {
        session_id: 'sess-null',
        cwd: dir,
        tool_name: 'Write',
        tool_input: { file_path: '/dev/null' },
        tool_response: { success: true },
      },
      { store },
    );

    expect(r.ok).toBe(true);
    const timeline = store.timeline('sess-null');
    const toolUse = timeline.find((obs) => obs.kind === 'tool_use');
    expect(toolUse?.metadata).toEqual({ tool: 'Write' });
    expect(timeline.some((obs) => obs.kind === 'auto-claim')).toBe(false);
  });

  it('warn policy surfaces strong claim conflicts and continues', async () => {
    const taskId = seedClaimConflict();

    const result = await runHook(
      'pre-tool-use',
      {
        session_id: 'B',
        ide: 'codex',
        tool_name: 'Edit',
        tool_input: { file_path: 'src/viewer.tsx' },
      },
      { store },
    );

    expect(result.ok).toBe(true);
    expect(result.permissionDecision).toBe('allow');
    const warning = JSON.parse(result.context ?? '{}') as Record<string, unknown>;
    expect(warning).toMatchObject({
      code: 'LIVE_FILE_CONTENTION',
      policy_mode: 'warn',
      conflict: true,
      conflict_strength: 'strong',
      owner: 'A',
    });
    expect(store.storage.getClaim(taskId, 'src/viewer.tsx')?.session_id).toBe('B');
  });

  it('denies protected live contentions even when bridge policy is warn', async () => {
    const { protectedTaskId, agentTaskId } = seedProtectedContention();

    const result = await runHook(
      'pre-tool-use',
      {
        session_id: 'B',
        ide: 'codex',
        tool_name: 'Edit',
        tool_input: { file_path: 'src/shared.ts' },
      },
      { store },
    );

    expect(result.ok).toBe(true);
    expect(result.permissionDecision).toBe('deny');
    expect(result.permissionDecisionReason).toContain('Protected Colony strong claim');
    const warning = JSON.parse(result.context ?? '{}') as Record<string, unknown>;
    expect(warning).toMatchObject({
      code: 'LIVE_FILE_CONTENTION',
      policy_mode: 'warn',
      conflict: true,
      conflict_strength: 'strong',
      protected: true,
      owner: 'A',
      owner_branch: 'main',
    });
    expect(store.storage.getClaim(protectedTaskId, 'src/shared.ts')?.session_id).toBe('A');
    expect(store.storage.getClaim(agentTaskId, 'src/shared.ts')).toBeUndefined();
    const telemetry = store.storage.taskObservationsByKind(protectedTaskId, 'claim-before-edit');
    expect(metadataOf(telemetry[0])).toMatchObject({
      policy_mode: 'warn',
      code: 'LIVE_FILE_CONTENTION',
      conflict: true,
      conflict_strength: 'strong',
      protected: true,
      owner: 'A',
      owner_branch: 'main',
    });
  });

  it('allows protected edits after takeover assigns the protected claim to this session', async () => {
    const { protectedTaskId, agentTaskId } = seedProtectedContention();
    store.storage.takeOverLaneClaim({
      target_session_id: 'A',
      requester_session_id: 'B',
      file_path: 'src/shared.ts',
      reason: 'explicit takeover for protected contention',
      requester_agent: 'codex',
    });

    const result = await runHook(
      'pre-tool-use',
      {
        session_id: 'B',
        ide: 'codex',
        tool_name: 'Edit',
        tool_input: { file_path: 'src/shared.ts' },
      },
      { store },
    );

    expect(result.ok).toBe(true);
    expect(result.permissionDecision).toBe('allow');
    expect(result.context).toBe('');
    expect(store.storage.getClaim(protectedTaskId, 'src/shared.ts')?.session_id).toBe('B');
    expect(store.storage.getClaim(agentTaskId, 'src/shared.ts')?.session_id).toBe('B');
    const telemetry = store.storage.taskObservationsByKind(agentTaskId, 'claim-before-edit');
    expect(metadataOf(telemetry[0])).toMatchObject({
      outcome: 'auto_claimed_before_edit',
      file_path: 'src/shared.ts',
      conflict: false,
      protected: false,
      owner: null,
    });
  });

  it('block-on-conflict policy denies only strong active claim conflicts', async () => {
    useBridgePolicy('block-on-conflict');
    const taskId = seedClaimConflict();

    const result = await runHook(
      'pre-tool-use',
      {
        session_id: 'B',
        ide: 'codex',
        tool_name: 'Edit',
        tool_input: { file_path: 'src/viewer.tsx' },
      },
      { store },
    );

    expect(result.ok).toBe(true);
    expect(result.permissionDecision).toBe('deny');
    expect(result.permissionDecisionReason).toContain('Colony strong claim conflict');
    expect(store.storage.getClaim(taskId, 'src/viewer.tsx')?.session_id).toBe('A');
    const telemetry = store.storage.taskObservationsByKind(taskId, 'claim-before-edit');
    expect(metadataOf(telemetry[0])).toMatchObject({
      policy_mode: 'block-on-conflict',
      code: 'LIVE_FILE_CONTENTION',
      conflict: true,
      conflict_strength: 'strong',
      owner: 'A',
    });

    const unclaimed = await runHook(
      'pre-tool-use',
      {
        session_id: 'B',
        ide: 'codex',
        tool_name: 'Edit',
        tool_input: { file_path: 'src/new.tsx' },
      },
      { store },
    );
    expect(unclaimed.permissionDecision).toBe('allow');
    expect(store.storage.getClaim(taskId, 'src/new.tsx')?.session_id).toBe('B');
  });

  it('block-on-conflict policy allows weak and expired live contention claims', async () => {
    useBridgePolicy('block-on-conflict');
    const taskId = seedClaimConflict({
      file_path: 'src/stale.tsx',
      ageMinutes: defaultSettings.claimStaleMinutes,
    });

    const stale = await runHook(
      'pre-tool-use',
      {
        session_id: 'B',
        ide: 'codex',
        tool_name: 'Edit',
        tool_input: { file_path: 'src/stale.tsx' },
      },
      { store },
    );

    expect(stale.ok).toBe(true);
    expect(stale.permissionDecision).toBe('allow');
    const staleWarning = JSON.parse(stale.context ?? '{}') as Record<string, unknown>;
    expect(staleWarning).toMatchObject({
      code: 'LIVE_FILE_CONTENTION',
      policy_mode: 'block-on-conflict',
      conflict: true,
      conflict_strength: 'weak',
      owner: 'A',
    });
    expect(store.storage.getClaim(taskId, 'src/stale.tsx')?.session_id).toBe('B');

    const expiredAt = Date.now() - defaultSettings.claimStaleMinutes * 2 * 60_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(expiredAt);
    try {
      store.storage.claimFile({
        task_id: taskId,
        file_path: 'src/expired.tsx',
        session_id: 'A',
      });
    } finally {
      nowSpy.mockRestore();
    }

    const expired = await runHook(
      'pre-tool-use',
      {
        session_id: 'B',
        ide: 'codex',
        tool_name: 'Edit',
        tool_input: { file_path: 'src/expired.tsx' },
      },
      { store },
    );

    expect(expired.ok).toBe(true);
    expect(expired.permissionDecision).toBe('allow');
    const expiredWarning = JSON.parse(expired.context ?? '{}') as Record<string, unknown>;
    expect(expiredWarning).toMatchObject({
      code: 'LIVE_FILE_CONTENTION',
      policy_mode: 'block-on-conflict',
      conflict: true,
      conflict_strength: 'weak',
      owner: 'A',
    });
    expect(store.storage.getClaim(taskId, 'src/expired.tsx')?.session_id).toBe('B');
  });

  it('audit-only policy records telemetry without warning or block output', async () => {
    useBridgePolicy('audit-only');
    const taskId = seedClaimConflict();

    const result = await runHook(
      'pre-tool-use',
      {
        session_id: 'B',
        ide: 'codex',
        tool_name: 'Edit',
        tool_input: { file_path: 'src/viewer.tsx' },
      },
      { store },
    );

    expect(result.ok).toBe(true);
    expect(result.permissionDecision).toBe('allow');
    expect(result.context).toBe('');
    expect(result.permissionDecisionReason).toBeUndefined();
    expect(store.storage.getClaim(taskId, 'src/viewer.tsx')?.session_id).toBe('B');
    const telemetry = store.storage.taskObservationsByKind(taskId, 'claim-before-edit');
    expect(metadataOf(telemetry[0])).toMatchObject({
      policy_mode: 'audit-only',
      conflict: true,
      conflict_strength: 'strong',
      owner: 'A',
    });
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

  it('stop auto-posts blocker + broadcast handoff when usage limit is hit (deduped)', async () => {
    const repo = join(dir, 'repo-limit');
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/agent/codex/limit\n', 'utf8');

    await runHook(
      'user-prompt-submit',
      {
        session_id: 'codex@limit-hit',
        ide: 'codex',
        cwd: repo,
        prompt: 'continue migration lane',
      },
      { store },
    );

    await runHook(
      'stop',
      {
        session_id: 'codex@limit-hit',
        ide: 'codex',
        cwd: repo,
        stop_reason: 'usage limit reached',
        last_assistant_message: 'completed parser refactor; tests still pending',
      },
      { store },
    );

    const taskId = store.storage.findActiveTaskForSession('codex@limit-hit');
    expect(taskId).toBeDefined();
    if (taskId === undefined) throw new Error('task should exist for usage-limit takeover');
    const handoffs = store.storage.taskObservationsByKind(taskId, 'handoff', 10);
    const blockers = store.storage.taskObservationsByKind(taskId, 'blocker', 10);
    expect(handoffs).toHaveLength(1);
    expect(blockers).toHaveLength(1);

    const handoffMeta = JSON.parse(handoffs[0]?.metadata ?? '{}') as Record<string, unknown>;
    expect(handoffMeta).toMatchObject({
      kind: 'handoff',
      from_session_id: 'codex@limit-hit',
      from_agent: 'codex',
      to_agent: 'any',
      status: 'pending',
      summary: 'Session hit usage limit; takeover requested.',
    });
    expect((handoffMeta.next_steps as string[])[1]).toContain(
      'Last assistant update: completed parser refactor; tests still pending',
    );
    expect((handoffMeta.blockers as string[])[0]).toContain('usage limit reached');
    expect(blockers[0]?.content).toContain('USAGE LIMIT: usage limit reached');

    // Stop can fire more than once around session shutdown; ensure we don't
    // spam duplicate auto-handoffs for the same pending baton.
    await runHook(
      'stop',
      {
        session_id: 'codex@limit-hit',
        ide: 'codex',
        cwd: repo,
        stop_reason: 'usage limit reached',
      },
      { store },
    );
    expect(store.storage.taskObservationsByKind(taskId, 'handoff', 10)).toHaveLength(1);
  });

  it('stop treats RATE_LIMIT_EXCEEDED code as usage-limit trigger', async () => {
    const repo = join(dir, 'repo-limit-code');
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/agent/codex/limit-code\n', 'utf8');

    await runHook(
      'user-prompt-submit',
      {
        session_id: 'codex@limit-code',
        ide: 'codex',
        cwd: repo,
        prompt: 'continue migration lane',
      },
      { store },
    );

    await runHook(
      'stop',
      {
        session_id: 'codex@limit-code',
        ide: 'codex',
        cwd: repo,
        stop_reason: 'RATE_LIMIT_EXCEEDED',
      },
      { store },
    );

    const taskId = store.storage.findActiveTaskForSession('codex@limit-code');
    expect(taskId).toBeDefined();
    if (taskId === undefined) throw new Error('task should exist for rate-limit code takeover');

    const handoffs = store.storage.taskObservationsByKind(taskId, 'handoff', 10);
    const blockers = store.storage.taskObservationsByKind(taskId, 'blocker', 10);
    const turns = store.storage.listSummaries('codex@limit-code').filter((s) => s.scope === 'turn');

    expect(handoffs).toHaveLength(1);
    expect(blockers).toHaveLength(1);
    expect(turns).toHaveLength(0);

    const handoffMeta = JSON.parse(handoffs[0]?.metadata ?? '{}') as Record<string, unknown>;
    expect(handoffMeta).toMatchObject({
      kind: 'handoff',
      to_agent: 'any',
      status: 'pending',
      summary: 'Session hit usage limit; takeover requested.',
    });
    expect((handoffMeta.blockers as string[])[0]).toContain('RATE_LIMIT_EXCEEDED');
    expect(blockers[0]?.content).toContain('USAGE LIMIT: RATE_LIMIT_EXCEEDED');
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
