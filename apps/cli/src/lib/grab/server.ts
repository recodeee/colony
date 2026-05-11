import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { type MemoryStore, TaskThread } from '@colony/core';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { DedupCache } from './dedup.js';
import { realSpawn } from './spawner.js';
import type {
  GrabAppendSuccess,
  GrabError,
  GrabServeConfig,
  GrabSpawnSuccess,
  GrabSubmitBody,
  SpawnPrimitives,
} from './types.js';

export interface GrabServerHandle {
  url: string;
  port: number;
  fingerprint: string;
  stop(): Promise<void>;
}

export const tokenFingerprint = (token: string): string =>
  createHash('sha256').update(token).digest('hex').slice(0, 12);

const safeEq = (a: string, b: string): boolean => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
};

const slugify = (input: string): string => {
  const base = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (base || 'grab').slice(0, 48);
};

const buildPromptBody = (body: GrabSubmitBody): string => {
  const lines: string[] = [];
  if (body.extra_prompt?.trim()) {
    lines.push(body.extra_prompt.trim(), '');
  }
  lines.push('```');
  lines.push(body.payload.content.trim());
  lines.push('```');
  if (body.viewport_url) {
    lines.push('', `viewport: ${body.viewport_url}`);
  }
  return lines.join('\n');
};

const buildIntakeMd = (body: GrabSubmitBody, branch: string, taskId: number): string =>
  [
    '# react-grab intake',
    '',
    `task_id: ${taskId}`,
    `branch: ${branch}`,
    `viewport: ${body.viewport_url ?? '(unknown)'}`,
    '',
    '## Goal',
    '',
    body.extra_prompt?.trim() || '(none — see source context below)',
    '',
    '## Source context (from react-grab)',
    '',
    '```',
    body.payload.content,
    '```',
    '',
  ].join('\n');

interface LogLine {
  event: string;
  fingerprint?: string;
  [key: string]: unknown;
}

const log = (line: LogLine, sink: (s: string) => void = (s) => process.stdout.write(s)): void => {
  // Token must never appear in any log; callers pass fingerprint instead.
  sink(`${JSON.stringify({ ts: new Date().toISOString(), ...line })}\n`);
};

const grabSession = (fingerprint: string): string => `react-grab-${fingerprint}`;

/**
 * Build the Hono app for the grab daemon. Pure function — no IO at build
 * time. Accepts injectable spawn primitives so tests can stub them.
 */
export const buildGrabApp = (
  config: GrabServeConfig,
  store: MemoryStore,
  spawnPrim: SpawnPrimitives,
  options: { now?: () => number; logSink?: (s: string) => void } = {},
): Hono => {
  const dedup = new DedupCache(config.dedupWindowMs);
  const fingerprint = tokenFingerprint(config.token);
  const app = new Hono();
  const now = options.now ?? (() => Date.now());
  const sink = options.logSink;

  // CORS for the allowlisted origins only. Browsers will block any fetch
  // whose response is missing Access-Control-Allow-Origin for a different
  // origin; this keeps the surface tight.
  app.use('*', async (c, next) => {
    const origin = c.req.header('origin');
    if (origin && config.originAllowlist.includes(origin)) {
      c.res.headers.set('Access-Control-Allow-Origin', origin);
      c.res.headers.set('Vary', 'Origin');
      c.res.headers.set('Access-Control-Allow-Headers', 'authorization, content-type');
      c.res.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
      c.res.headers.set('Access-Control-Max-Age', '600');
    }
    if (c.req.method === 'OPTIONS') {
      if (!origin || !config.originAllowlist.includes(origin)) {
        return c.body(null, 403);
      }
      return c.body(null, 204);
    }
    await next();
  });

  app.get('/health', (c) => c.json({ ok: true, fingerprint }));

  app.post('/grab', async (c) => {
    const ct = (c.req.header('content-type') ?? '').toLowerCase();
    if (!ct.startsWith('application/json')) {
      return c.json<GrabError>({ code: 'unsupported_media_type' }, 415);
    }
    const origin = c.req.header('origin');
    if (!origin || !config.originAllowlist.includes(origin)) {
      log({ event: 'grab.reject.origin', fingerprint, origin }, sink);
      return c.json<GrabError>({ code: 'origin_not_allowed' }, 403);
    }
    const authz = c.req.header('authorization') ?? '';
    if (!safeEq(authz, `Bearer ${config.token}`)) {
      log({ event: 'grab.reject.auth', fingerprint }, sink);
      return c.json<GrabError>({ code: 'unauthorized' }, 401);
    }

    let body: GrabSubmitBody | null = null;
    try {
      body = (await c.req.json()) as GrabSubmitBody;
    } catch {
      return c.json<GrabError>({ code: 'invalid_body' }, 400);
    }
    if (
      !body ||
      body.source !== 'react-grab' ||
      typeof body.payload?.content !== 'string' ||
      body.payload.content.trim().length === 0
    ) {
      return c.json<GrabError>({ code: 'invalid_body' }, 400);
    }

    const firstEntry = body.payload.entries?.[0];
    const componentName = firstEntry?.componentName ?? 'component';
    // Extract a file-path hint from the snippet's `// <path>:<line>` marker
    // produced by react-grab; it is part of the dedup key.
    const filePathHint =
      firstEntry?.commentText ?? body.payload.content.match(/^\/\/\s*([^\s]+:\d+)/m)?.[1] ?? '';

    const hash = dedup.hash([
      config.repoRoot,
      filePathHint,
      body.payload.content,
      body.extra_prompt,
    ]);
    const existing = dedup.lookup(hash, now());
    if (existing !== null) {
      try {
        new TaskThread(store, existing).post({
          session_id: grabSession(fingerprint),
          kind: 'note',
          content: buildPromptBody(body),
          metadata: { source: 'react-grab', dedup: true, hash },
        });
      } catch (err) {
        return c.json<GrabError>(
          { code: 'task_post_failed', message: (err as Error).message },
          500,
        );
      }
      log({ event: 'grab.append', fingerprint, task_id: existing }, sink);
      return c.json<GrabAppendSuccess>({ task_id: existing, action: 'appended' }, 200);
    }

    const slug = `grab-${slugify(componentName)}-${now().toString(36)}`;

    let branch: string;
    let worktree: string;
    try {
      ({ branch, worktree } = await spawnPrim.startWorktree({
        repoRoot: config.repoRoot,
        slug,
        tier: config.tier,
      }));
    } catch (err) {
      return c.json<GrabError>({ code: 'worktree_failed', message: (err as Error).message }, 500);
    }

    let taskId: number;
    try {
      const task = store.storage.findOrCreateTask({
        title: `react-grab: ${componentName}`,
        repo_root: config.repoRoot,
        branch,
        created_by: 'react-grab',
      });
      taskId = task.id;
      new TaskThread(store, taskId).post({
        session_id: grabSession(fingerprint),
        kind: 'note',
        content: buildPromptBody(body),
        metadata: {
          source: 'react-grab',
          viewport_url: body.viewport_url,
          hash,
          worktree,
        },
      });
    } catch (err) {
      return c.json<GrabError>(
        { code: 'task_create_failed', message: (err as Error).message },
        500,
      );
    }

    const tmuxSession = `rg-${taskId}`;
    try {
      await spawnPrim.writeIntake(worktree, buildIntakeMd(body, branch, taskId));
      await spawnPrim.startTmux({ session: tmuxSession, cwd: worktree });
    } catch (err) {
      // The task and worktree exist on disk even if tmux failed; surface so
      // the user can attach manually.
      return c.json<GrabError>({ code: 'spawn_failed', message: (err as Error).message }, 500);
    }

    dedup.record(hash, taskId, now());
    log({ event: 'grab.spawned', fingerprint, task_id: taskId, branch, tmux: tmuxSession }, sink);

    return c.json<GrabSpawnSuccess>(
      { task_id: taskId, branch, worktree, tmux_session: tmuxSession, action: 'spawned' },
      200,
    );
  });

  // Anything else 404s; we intentionally do not expose enumeration endpoints.
  app.all('*', (c) => c.json<GrabError>({ code: 'not_found' }, 404));

  return app;
};

/**
 * Start the grab daemon, write the state file, and return a handle.
 * Binds 127.0.0.1 only. The token is fingerprinted in logs but the raw token
 * is written to the state file (mode 0600) so the dev script can read it.
 */
export const startGrabServer = async (
  config: GrabServeConfig,
  store: MemoryStore,
): Promise<GrabServerHandle> => {
  const spawnPrim = config.spawn ?? realSpawn;
  const app = buildGrabApp(config, store, spawnPrim);
  const fingerprint = tokenFingerprint(config.token);

  const server = serve({ fetch: app.fetch, port: config.port, hostname: '127.0.0.1' });
  const actualPort = await new Promise<number>((resolve, reject) => {
    server.once('listening', () => {
      const addr = server.address() as AddressInfo | string | null;
      if (addr && typeof addr === 'object') resolve(addr.port);
      else reject(new Error('grab server bound to unknown address'));
    });
    server.once('error', reject);
  });

  const stateDir = join(config.colonyHome, 'grab');
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    join(stateDir, `${fingerprint}.json`),
    JSON.stringify(
      {
        port: actualPort,
        repoRoot: config.repoRoot,
        originAllowlist: config.originAllowlist,
        tokenFingerprint: fingerprint,
        token: config.token,
        started: Date.now(),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );

  log({ event: 'grab.serve.started', fingerprint, port: actualPort, repo: config.repoRoot });

  return {
    url: `http://127.0.0.1:${actualPort}`,
    port: actualPort,
    fingerprint,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
};
