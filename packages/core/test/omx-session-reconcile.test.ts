import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore, reconcileOmxActiveSessions } from '../src/index.js';

let dir: string | undefined;
let store: MemoryStore | undefined;

afterEach(() => {
  store?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  store = undefined;
  dir = undefined;
});

describe('reconcileOmxActiveSessions', () => {
  it('materializes active OMX sessions with stable identity into Colony sessions', () => {
    dir = mkdtempSync(join(tmpdir(), 'colony-omx-reconcile-'));
    const repoRoot = join(dir, 'repo');
    const worktreePath = join(repoRoot, '.omx', 'agent-worktrees', 'colony__codex__stable');
    const activeSessionsDir = join(repoRoot, '.omx', 'state', 'active-sessions');
    mkdirSync(worktreePath, { recursive: true });
    mkdirSync(activeSessionsDir, { recursive: true });
    store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });

    const now = Date.parse('2026-04-28T21:00:00.000Z');
    const startedAt = '2026-04-28T20:59:00.000Z';
    const lastHeartbeatAt = '2026-04-28T20:59:59.000Z';
    writeActiveSession(activeSessionsDir, 'codex_stable.json', {
      repoRoot,
      branch: 'agent/codex/stable',
      taskName: 'Stable task',
      latestTaskPreview: 'Tool: colony.task_post',
      agentName: 'codex',
      cliName: 'codex',
      worktreePath,
      startedAt,
      lastHeartbeatAt,
      state: 'working',
      sessionKey: 'codex@stable-session',
    });

    const result = reconcileOmxActiveSessions(store, { repoRoot, now });

    expect(result).toMatchObject({ scanned: 1, ensured: 1, skipped: 0 });
    const row = store.storage.getSession('codex@stable-session');
    expect(row).toMatchObject({
      id: 'codex@stable-session',
      ide: 'codex',
      cwd: worktreePath,
      started_at: Date.parse(startedAt),
      ended_at: null,
    });
    const metadata = JSON.parse(row?.metadata ?? '{}') as Record<string, string>;
    expect(metadata).toMatchObject({
      source: 'omx-active-session',
      inferred_agent: 'codex',
      confidence: 1,
      identity_source: 'active-session:explicit-ide',
      cli: 'codex',
      agent: 'codex',
      repo_root: repoRoot,
      branch: 'agent/codex/stable',
      worktree_path: worktreePath,
      latest_task_preview: 'Tool: colony.task_post',
      last_heartbeat_at: lastHeartbeatAt,
    });
  });

  it('attributes codex active sessions even when persisted as mcp-* with unknown names', () => {
    dir = mkdtempSync(join(tmpdir(), 'colony-omx-reconcile-'));
    const repoRoot = join(dir, 'repo');
    const worktreePath = join(repoRoot, '.omx', 'agent-worktrees', 'colony__codex__identity');
    const activeSessionsDir = join(repoRoot, '.omx', 'state', 'active-sessions');
    mkdirSync(worktreePath, { recursive: true });
    mkdirSync(activeSessionsDir, { recursive: true });
    store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });

    writeActiveSession(activeSessionsDir, 'mcp_1654237.json', {
      repoRoot,
      branch: 'agent/codex/identity',
      taskName: 'Identity task',
      latestTaskPreview: 'Tool: colony.hivemind_context',
      agentName: 'unknown',
      cliName: 'unknown',
      worktreePath,
      startedAt: '2026-04-28T20:59:00.000Z',
      lastHeartbeatAt: '2026-04-28T20:59:59.000Z',
      state: 'working',
      sessionKey: 'mcp-1654237',
    });

    const result = reconcileOmxActiveSessions(store, {
      repoRoot,
      now: Date.parse('2026-04-28T21:00:00.000Z'),
    });

    expect(result).toMatchObject({ scanned: 1, ensured: 1, skipped: 0 });
    const row = store.storage.getSession('mcp-1654237');
    expect(row).toMatchObject({ ide: 'codex', cwd: worktreePath });
    const metadata = JSON.parse(row?.metadata ?? '{}') as Record<string, unknown>;
    expect(metadata).toMatchObject({
      source: 'omx-active-session',
      inferred_agent: 'codex',
      confidence: 1,
      identity_source: 'active-session:explicit-ide',
      branch: 'agent/codex/identity',
    });
  });

  it('skips active-session fixtures without a stable session identity', () => {
    dir = mkdtempSync(join(tmpdir(), 'colony-omx-reconcile-'));
    const repoRoot = join(dir, 'repo');
    const activeSessionsDir = join(repoRoot, '.omx', 'state', 'active-sessions');
    mkdirSync(activeSessionsDir, { recursive: true });
    store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });

    const now = Date.parse('2026-04-28T21:00:00.000Z');
    const base = {
      repoRoot,
      branch: 'agent/codex/identity',
      taskName: 'Identity task',
      agentName: 'codex',
      cliName: 'codex',
      worktreePath: repoRoot,
      startedAt: '2026-04-28T20:59:00.000Z',
      lastHeartbeatAt: '2026-04-28T20:59:59.000Z',
      state: 'working',
    };
    writeActiveSession(activeSessionsDir, 'missing-key.json', base);
    writeActiveSession(activeSessionsDir, 'unknown-key.json', {
      ...base,
      sessionKey: 'unknown-session',
    });
    writeActiveSession(activeSessionsDir, 'stale-key.json', {
      ...base,
      lastHeartbeatAt: '2026-04-28T20:00:00.000Z',
      sessionKey: 'codex@stale-session',
    });

    const result = reconcileOmxActiveSessions(store, { repoRoot, now });

    expect(result).toMatchObject({ scanned: 2, ensured: 0, skipped: 2 });
    expect(store.storage.listSessions()).toEqual([]);
  });
});

function writeActiveSession(dir: string, fileName: string, payload: Record<string, unknown>): void {
  writeFileSync(join(dir, fileName), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}
