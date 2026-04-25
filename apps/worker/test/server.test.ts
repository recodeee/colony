import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { MemoryStore } from '@colony/core';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/server.js';

let dir: string;
let store: MemoryStore;
let app: Hono;

function seed(): { sessionId: string; a: number; b: number } {
  store.startSession({ id: 's1', ide: 'claude-code', cwd: '/tmp' });
  const a = store.addObservation({
    session_id: 's1',
    kind: 'note',
    content: 'The db config lives at /etc/caveman.conf.',
  });
  const b = store.addObservation({
    session_id: 's1',
    kind: 'note',
    content: 'Please run `pnpm test` now.',
  });
  return { sessionId: 's1', a, b };
}

function seedRuntime(repoRoot: string): void {
  const worktreePath = join(repoRoot, '.omx', 'agent-worktrees', 'agent__codex__viewer-task');
  const activeSessionDir = join(repoRoot, '.omx', 'state', 'active-sessions');
  const now = new Date().toISOString();
  mkdirSync(activeSessionDir, { recursive: true });
  mkdirSync(worktreePath, { recursive: true });
  writeFileSync(
    join(activeSessionDir, 'agent__codex__viewer-task.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        repoRoot,
        branch: 'agent/codex/viewer-task',
        taskName: 'Show Hivemind dashboard',
        latestTaskPreview: 'Render active lanes in worker viewer',
        agentName: 'codex',
        worktreePath,
        pid: process.pid,
        cliName: 'codex',
        startedAt: now,
        lastHeartbeatAt: now,
        state: 'working',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

function seedFileLocks(repoRoot: string): void {
  const lockStateDir = join(repoRoot, '.omx', 'state');
  const now = new Date().toISOString();
  mkdirSync(lockStateDir, { recursive: true });
  writeFileSync(
    join(lockStateDir, 'agent-file-locks.json'),
    `${JSON.stringify(
      {
        locks: {
          'apps/worker/src/server.ts': {
            branch: 'agent/codex/viewer-locks',
            claimed_at: now,
            allow_delete: false,
          },
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'colony-worker-'));
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
  app = buildApp(store);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('worker HTTP', () => {
  it('GET /healthz returns ok', async () => {
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('GET /api/sessions returns a session list', async () => {
    seed();
    const res = await app.request('/api/sessions');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string }>;
    expect(body.map((s) => s.id)).toContain('s1');
  });

  it('GET /api/hivemind returns active runtime lanes', async () => {
    const repoRoot = join(dir, 'repo-runtime');
    seedRuntime(repoRoot);
    const appWithRuntime = buildApp(store, undefined, { hivemindRepoRoots: [repoRoot] });

    const res = await appWithRuntime.request('/api/hivemind');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      session_count: number;
      sessions: Array<{ branch: string; task: string }>;
    };
    expect(body.session_count).toBe(1);
    expect(body.sessions[0]).toMatchObject({
      branch: 'agent/codex/viewer-task',
      task: 'Render active lanes in worker viewer',
    });
  });

  it('GET /api/hivemind reuses a short cache during browser refresh bursts', async () => {
    const repoRoot = join(dir, 'repo-runtime-cache');
    seedRuntime(repoRoot);
    const appWithRuntime = buildApp(store, undefined, { hivemindRepoRoots: [repoRoot] });

    const first = (await (await appWithRuntime.request('/api/hivemind')).json()) as {
      session_count: number;
    };
    rmSync(join(repoRoot, '.omx'), { recursive: true, force: true });
    const cached = (await (await appWithRuntime.request('/api/hivemind')).json()) as {
      session_count: number;
    };
    await new Promise((resolve) => setTimeout(resolve, 550));
    const refreshed = (await (await appWithRuntime.request('/api/hivemind')).json()) as {
      session_count: number;
    };

    expect(first.session_count).toBe(1);
    expect(cached.session_count).toBe(1);
    expect(refreshed.session_count).toBe(0);
  });

  it('GET /api/hivemind returns GX file-lock fallback lanes', async () => {
    const repoRoot = join(dir, 'repo-file-locks');
    seedFileLocks(repoRoot);
    const appWithRuntime = buildApp(store, undefined, { hivemindRepoRoots: [repoRoot] });

    const res = await appWithRuntime.request('/api/hivemind');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      session_count: number;
      sessions: Array<{ branch: string; source: string; locked_file_count: number }>;
    };
    expect(body.session_count).toBe(1);
    expect(body.sessions[0]).toMatchObject({
      branch: 'agent/codex/viewer-locks',
      source: 'file-lock',
      locked_file_count: 1,
    });
  });

  it('GET /api/sessions/:id/observations returns expanded text', async () => {
    seed();
    const res = await app.request('/api/sessions/s1/observations');
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ content: string }>;
    expect(rows.length).toBeGreaterThan(0);
    // Database abbreviation should be expanded for the viewer.
    expect(rows.some((r) => /database/.test(r.content))).toBe(true);
    // Tech tokens preserved.
    expect(rows.some((r) => r.content.includes('/etc/caveman.conf'))).toBe(true);
  });

  it('GET /api/sessions/:id/observations honours ?around for paging within a session', async () => {
    const { sessionId, a } = seed();
    const res = await app.request(`/api/sessions/${sessionId}/observations?around=${a}&limit=2`);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ id: number }>;
    expect(rows.map((r) => r.id)).toContain(a);
  });

  it('GET /api/sessions/:id/observations with ?around pointing at a foreign-session id returns [] (no silent cross-session bleed)', async () => {
    const { a } = seed();
    store.startSession({ id: 's2', ide: 'codex', cwd: '/tmp' });
    const foreign = store.addObservation({
      session_id: 's2',
      kind: 'note',
      content: 'lives in s2',
    });
    expect(foreign).not.toBe(a);

    // around=foreign-id while session=s1 must NOT spill s2's row into s1's
    // window — Storage.timeline filters by session_id, so the result is [].
    const res = await app.request(`/api/sessions/s1/observations?around=${foreign}&limit=10`);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ id: number; session_id: string }>;
    expect(rows).toEqual([]);
  });

  it('GET /api/sessions/:id/observations ignores a non-numeric ?around value', async () => {
    seed();
    const res = await app.request('/api/sessions/s1/observations?around=garbage');
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<unknown>;
    expect(rows.length).toBeGreaterThan(0);
  });

  it('GET /api/search returns matching observations', async () => {
    seed();
    const res = await app.request('/api/search?q=config');
    expect(res.status).toBe(200);
    const hits = (await res.json()) as Array<{ id: number; snippet: string }>;
    expect(hits.length).toBeGreaterThan(0);
  });

  it('GET / renders the session index HTML', async () => {
    seed();
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain('s1');
  });

  it('GET / renders the Hivemind runtime dashboard', async () => {
    const repoRoot = join(dir, 'repo-dashboard');
    seedRuntime(repoRoot);
    const appWithRuntime = buildApp(store, undefined, { hivemindRepoRoots: [repoRoot] });

    const res = await appWithRuntime.request('/');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Hivemind runtime');
    expect(body).toContain('Render active lanes in worker viewer');
    expect(body).toContain('runtime clean');
  });

  it('GET /sessions/:id renders observation HTML', async () => {
    seed();
    const res = await app.request('/sessions/s1');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('/etc/caveman.conf');
  });

  it('GET /sessions/:unknown returns 404', async () => {
    const res = await app.request('/sessions/does-not-exist');
    expect(res.status).toBe(404);
  });

  it('GET /api/colony/tasks lists tasks with pending handoff counts and participants', async () => {
    const task = store.storage.findOrCreateTask({
      title: 'viewer-task',
      repo_root: '/tmp/repo-a',
      branch: 'agent/codex/viewer-task',
      created_by: 'sess-1',
    });
    store.startSession({ id: 'sess-1', ide: 'codex', cwd: '/tmp/repo-a' });
    store.storage.addTaskParticipant({
      task_id: task.id,
      session_id: 'sess-1',
      agent: 'codex',
    });
    store.addObservation({
      session_id: 'sess-1',
      kind: 'handoff',
      content: 'pass ownership',
      task_id: task.id,
      metadata: {
        status: 'pending',
        from_agent: 'codex',
        to_agent: 'claude',
        summary: 'take over auth module',
        expires_at: Date.now() + 60_000,
      },
    });

    const res = await app.request('/api/colony/tasks');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      id: number;
      repo_root: string;
      branch: string;
      pending_handoff_count: number;
      participants: Array<{ agent: string; session_id: string }>;
    }>;
    const row = body.find((t) => t.id === task.id);
    expect(row).toBeDefined();
    expect(row?.repo_root).toBe('/tmp/repo-a');
    expect(row?.branch).toBe('agent/codex/viewer-task');
    expect(row?.pending_handoff_count).toBe(1);
    expect(row?.participants.map((p) => p.agent)).toContain('codex');
  });

  it('GET /api/colony/tasks filters by repo_root', async () => {
    store.storage.findOrCreateTask({
      title: 'task-a',
      repo_root: '/tmp/repo-a',
      branch: 'agent/a/work',
      created_by: 'sess-a',
    });
    store.storage.findOrCreateTask({
      title: 'task-b',
      repo_root: '/tmp/repo-b',
      branch: 'agent/b/work',
      created_by: 'sess-b',
    });
    const res = await app.request('/api/colony/tasks?repo_root=/tmp/repo-a');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ repo_root: string }>;
    expect(body.every((t) => t.repo_root === '/tmp/repo-a')).toBe(true);
    expect(body.length).toBeGreaterThan(0);
  });

  it('GET /api/colony/tasks/:id/attention surfaces pending handoffs and wake requests', async () => {
    const task = store.storage.findOrCreateTask({
      title: 'attention-task',
      repo_root: '/tmp/repo-attn',
      branch: 'agent/codex/attn',
      created_by: 'sess-attn',
    });
    store.startSession({ id: 'sess-attn', ide: 'codex', cwd: '/tmp/repo-attn' });
    store.storage.addTaskParticipant({
      task_id: task.id,
      session_id: 'sess-attn',
      agent: 'codex',
    });
    const handoffId = store.addObservation({
      session_id: 'sess-attn',
      kind: 'handoff',
      content: 'hand it off',
      task_id: task.id,
      metadata: {
        status: 'pending',
        from_agent: 'codex',
        to_agent: 'claude',
        summary: 'finish the migration',
        expires_at: Date.now() + 60_000,
      },
    });
    const wakeId = store.addObservation({
      session_id: 'sess-attn',
      kind: 'wake_request',
      content: 'ping',
      task_id: task.id,
      metadata: {
        kind: 'wake_request',
        status: 'pending',
        to_agent: 'claude',
        reason: 'need review',
        expires_at: Date.now() + 60_000,
      },
    });

    const res = await app.request(`/api/colony/tasks/${task.id}/attention`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      pending_handoffs: Array<{ id: number; to_agent: string | null; status: string }>;
      pending_wakes: Array<{ id: number; status: string }>;
      recent: Array<{ id: number; kind: string }>;
    };
    expect(body.pending_handoffs.find((h) => h.id === handoffId)?.to_agent).toBe('claude');
    expect(body.pending_wakes.find((w) => w.id === wakeId)?.status).toBe('pending');
    expect(body.recent.length).toBeGreaterThan(0);
    expect(body.recent.some((r) => r.kind === 'wake_request')).toBe(true);
  });
});
