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
});
