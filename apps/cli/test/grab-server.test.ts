import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { MemoryStore } from '@colony/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildGrabApp } from '../src/lib/grab/server.js';
import type { GrabServeConfig, GrabSubmitBody, SpawnPrimitives } from '../src/lib/grab/types.js';

const TOKEN = 'test-token-deadbeefdeadbeefdeadbeefdeadbeef';
const REPO = '/tmp/grab-test-repo';
const ALLOWED_ORIGIN = 'http://localhost:5173';

let dir: string;
let store: MemoryStore;
let spawnLog: { type: string; args: unknown }[];
let spawnFail: { worktree?: boolean; tmux?: boolean };

const mockSpawn: SpawnPrimitives = {
  async startWorktree(args) {
    spawnLog.push({ type: 'startWorktree', args });
    if (spawnFail.worktree) throw new Error('worktree boom');
    return {
      branch: `agent/codex/${args.slug}`,
      worktree: `/tmp/wt/${args.slug}`,
    };
  },
  async writeIntake(worktree, content) {
    spawnLog.push({ type: 'writeIntake', args: { worktree, contentLength: content.length } });
  },
  async startTmux(args) {
    spawnLog.push({ type: 'startTmux', args });
    if (spawnFail.tmux) throw new Error('tmux boom');
  },
};

const baseConfig = (): GrabServeConfig => ({
  repoRoot: REPO,
  port: 0,
  token: TOKEN,
  originAllowlist: [ALLOWED_ORIGIN],
  dedupWindowMs: 60_000,
  colonyHome: dir,
  tier: 'T1',
  spawn: mockSpawn,
});

const validBody = (overrides: Partial<GrabSubmitBody> = {}): GrabSubmitBody => ({
  source: 'react-grab',
  payload: {
    version: '1.0.0',
    content:
      '<a class="ml-auto" href="#">Forgot your password?</a>\n\n// components/login-form.tsx:46\n  46| <a>',
    entries: [
      {
        tagName: 'a',
        componentName: 'LoginForm',
        content: '<a>...</a>',
        commentText: 'components/login-form.tsx:46',
      },
    ],
    timestamp: Date.now(),
  },
  extra_prompt: 'make the link bigger',
  viewport_url: 'http://localhost:5173/login',
  ...overrides,
});

const post = async (
  app: ReturnType<typeof buildGrabApp>,
  init: RequestInit = {},
  url = 'http://127.0.0.1/grab',
): Promise<Response> => app.fetch(new Request(url, { method: 'POST', ...init }));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'grab-test-'));
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
  spawnLog = [];
  spawnFail = {};
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('grab daemon — request gating', () => {
  it('rejects POST without Content-Type: application/json with 415', async () => {
    const app = buildGrabApp(baseConfig(), store, mockSpawn);
    const res = await post(app, {
      headers: { origin: ALLOWED_ORIGIN, authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(validBody()),
    });
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ code: 'unsupported_media_type' });
    expect(spawnLog).toHaveLength(0);
  });

  it('rejects POST without Origin header with 403', async () => {
    const app = buildGrabApp(baseConfig(), store, mockSpawn);
    const res = await post(app, {
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(validBody()),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'origin_not_allowed' });
    expect(spawnLog).toHaveLength(0);
  });

  it('rejects POST with non-allowlisted Origin with 403', async () => {
    const app = buildGrabApp(baseConfig(), store, mockSpawn);
    const res = await post(app, {
      headers: {
        'content-type': 'application/json',
        origin: 'https://evil.example.com',
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify(validBody()),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'origin_not_allowed' });
    expect(spawnLog).toHaveLength(0);
  });

  it('rejects POST without Authorization with 401', async () => {
    const app = buildGrabApp(baseConfig(), store, mockSpawn);
    const res = await post(app, {
      headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN },
      body: JSON.stringify(validBody()),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: 'unauthorized' });
    expect(spawnLog).toHaveLength(0);
  });

  it('rejects POST with wrong token with 401', async () => {
    const app = buildGrabApp(baseConfig(), store, mockSpawn);
    const res = await post(app, {
      headers: {
        'content-type': 'application/json',
        origin: ALLOWED_ORIGIN,
        authorization: 'Bearer wrong-token',
      },
      body: JSON.stringify(validBody()),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: 'unauthorized' });
    expect(spawnLog).toHaveLength(0);
  });

  it('rejects empty payload.content with 400', async () => {
    const app = buildGrabApp(baseConfig(), store, mockSpawn);
    const res = await post(app, {
      headers: {
        'content-type': 'application/json',
        origin: ALLOWED_ORIGIN,
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify(validBody({ payload: { content: '   ' } })),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'invalid_body' });
    expect(spawnLog).toHaveLength(0);
  });

  it('rejects body with wrong source with 400', async () => {
    const app = buildGrabApp(baseConfig(), store, mockSpawn);
    const res = await post(app, {
      headers: {
        'content-type': 'application/json',
        origin: ALLOWED_ORIGIN,
        authorization: `Bearer ${TOKEN}`,
      },
      // Reuse the valid body shape but pretend it came from somewhere else.
      body: JSON.stringify({ ...validBody(), source: 'malicious' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'invalid_body' });
    expect(spawnLog).toHaveLength(0);
  });

  it('CORS preflight from allowed origin returns 204', async () => {
    const app = buildGrabApp(baseConfig(), store, mockSpawn);
    const res = await app.fetch(
      new Request('http://127.0.0.1/grab', {
        method: 'OPTIONS',
        headers: {
          origin: ALLOWED_ORIGIN,
          'access-control-request-method': 'POST',
        },
      }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
  });

  it('CORS preflight from disallowed origin returns 403', async () => {
    const app = buildGrabApp(baseConfig(), store, mockSpawn);
    const res = await app.fetch(
      new Request('http://127.0.0.1/grab', {
        method: 'OPTIONS',
        headers: { origin: 'https://evil.example.com' },
      }),
    );
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('grab daemon — successful submit', () => {
  it('spawns worktree + task + tmux and returns task_id', async () => {
    const app = buildGrabApp(baseConfig(), store, mockSpawn);
    const res = await post(app, {
      headers: {
        'content-type': 'application/json',
        origin: ALLOWED_ORIGIN,
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify(validBody()),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      task_id: number;
      branch: string;
      worktree: string;
      tmux_session: string;
      action: string;
    };
    expect(json.action).toBe('spawned');
    expect(json.task_id).toBeGreaterThan(0);
    expect(json.branch).toMatch(/^agent\/codex\/grab-loginform-/);
    expect(json.tmux_session).toBe(`rg-${json.task_id}`);

    const types = spawnLog.map((s) => s.type);
    expect(types).toEqual(['startWorktree', 'writeIntake', 'startTmux']);
  });

  it('deduplicates a repeated submit into an append on the same task', async () => {
    const app = buildGrabApp(baseConfig(), store, mockSpawn);
    const body = JSON.stringify(validBody());
    const headers = {
      'content-type': 'application/json',
      origin: ALLOWED_ORIGIN,
      authorization: `Bearer ${TOKEN}`,
    };
    const first = await post(app, { headers, body });
    const firstJson = (await first.json()) as { task_id: number; action: string };
    expect(firstJson.action).toBe('spawned');

    spawnLog.length = 0;

    const second = await post(app, { headers, body });
    const secondJson = (await second.json()) as { task_id: number; action: string };
    expect(secondJson.action).toBe('appended');
    expect(secondJson.task_id).toBe(firstJson.task_id);
    expect(spawnLog).toHaveLength(0); // dedup path does not spawn
  });
});

describe('grab daemon — failure isolation', () => {
  it('worktree failure does not create a task or run tmux', async () => {
    spawnFail.worktree = true;
    const app = buildGrabApp(baseConfig(), store, mockSpawn);
    const res = await post(app, {
      headers: {
        'content-type': 'application/json',
        origin: ALLOWED_ORIGIN,
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify(validBody()),
    });
    expect(res.status).toBe(500);
    expect((await res.json()) as { code: string }).toMatchObject({ code: 'worktree_failed' });
    expect(spawnLog.map((s) => s.type)).toEqual(['startWorktree']);
    // No tmux, no intake.
    expect(store.storage.listTasks(10)).toHaveLength(0);
  });
});
