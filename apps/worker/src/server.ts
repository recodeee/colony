#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expand } from '@colony/compress';
import { type Settings, loadSettings, resolveDataDir } from '@colony/config';
import { type HivemindOptions, MemoryStore, readHivemind } from '@colony/core';
import { createEmbedder } from '@colony/embedding';
import { isMainEntry, removePidFile, writePidFile } from '@colony/process';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { type EmbedLoopHandle, startEmbedLoop, stateFilePath } from './embed-loop.js';
import { renderIndex, renderSession } from './viewer.js';

const HIVEMIND_CACHE_TTL_MS = 500;

export interface WorkerAppOptions {
  hivemindRepoRoots?: string[];
}

export function buildApp(
  store: MemoryStore,
  loop?: EmbedLoopHandle,
  options: WorkerAppOptions = {},
): Hono {
  const app = new Hono();
  const readCachedHivemind = createHivemindReader(options);

  app.use('*', async (_c, next) => {
    loop?.touch();
    await next();
  });

  app.get('/healthz', (c) => c.json({ ok: true }));

  app.get('/api/state', (c) => {
    if (!loop) return c.json({ running: false });
    return c.json({ running: true, ...loop.state() });
  });

  app.get('/api/sessions', (c) => {
    const limit = Number(c.req.query('limit') ?? 50);
    return c.json(store.storage.listSessions(limit));
  });

  app.get('/api/hivemind', (c) => c.json(readCachedHivemind()));

  app.get('/api/colony/tasks', (c) => {
    const repoRoot = c.req.query('repo_root');
    const limit = Number(c.req.query('limit') ?? 50);
    const all = store.storage.listTasks(limit);
    const tasks = repoRoot ? all.filter((t) => t.repo_root === repoRoot) : all;
    return c.json(
      tasks.map((t) => {
        const pending = store.storage.pendingHandoffs(t.id);
        const participants = store.storage.listParticipants(t.id);
        return {
          id: t.id,
          repo_root: t.repo_root,
          branch: t.branch,
          created_at: t.created_at,
          updated_at: t.updated_at,
          status: t.status,
          participants: participants.map((p) => ({
            agent: p.agent,
            session_id: p.session_id,
            joined_at: p.joined_at,
          })),
          pending_handoff_count: pending.length,
        };
      }),
    );
  });

  app.get('/api/colony/tasks/:id/attention', (c) => {
    const taskId = Number(c.req.param('id'));
    if (!Number.isFinite(taskId) || taskId <= 0) {
      return c.json({ pending_handoffs: [], pending_wakes: [], recent: [] });
    }
    const pending = store.storage.pendingHandoffs(taskId);
    const recent = store.storage.taskTimeline(taskId, 20);
    const now = Date.now();
    return c.json({
      pending_handoffs: pending.map((h) => {
        const meta = safeJsonObject(h.metadata);
        return {
          id: h.id,
          from_agent: (meta.from_agent as string | undefined) ?? null,
          to_agent: (meta.to_agent as string | undefined) ?? null,
          summary: (meta.summary as string | undefined) ?? '',
          status: (meta.status as string | undefined) ?? 'pending',
          expires_at: (meta.expires_at as number | undefined) ?? null,
          ts: h.ts,
        };
      }),
      pending_wakes: recent
        .filter((r) => r.kind === 'wake_request')
        .map((r) => {
          const meta = safeJsonObject(r.metadata);
          return {
            id: r.id,
            ts: r.ts,
            status: (meta.status as string | undefined) ?? 'pending',
            reason: (meta.reason as string | undefined) ?? '',
            to_agent: (meta.to_agent as string | undefined) ?? null,
            expires_at: (meta.expires_at as number | undefined) ?? null,
          };
        })
        .filter((w) => w.status === 'pending' && (w.expires_at == null || w.expires_at > now)),
      recent: recent.slice(0, 10).map((r) => ({
        id: r.id,
        kind: r.kind,
        session_id: r.session_id,
        ts: r.ts,
      })),
    });
  });

  app.get('/api/sessions/:id/observations', (c) => {
    const id = c.req.param('id');
    const limit = Number(c.req.query('limit') ?? 200);
    const aroundRaw = c.req.query('around');
    const around = aroundRaw !== undefined ? Number(aroundRaw) : undefined;
    const aroundId =
      around !== undefined && Number.isFinite(around) && around > 0 ? around : undefined;
    // Storage.timeline filters by session_id but uses aroundId as a raw numeric
    // anchor — passing an id from a different session won't bleed foreign rows
    // in, but it WILL silently slice this session's history at the wrong
    // position. Reject the foreign anchor up front instead so the response
    // either centres on a real anchor or returns [].
    if (aroundId !== undefined) {
      const anchor = store.storage.getObservation(aroundId);
      if (!anchor || anchor.session_id !== id) return c.json([]);
    }
    const rows = store.timeline(id, aroundId, limit);
    return c.json(rows.map((r) => ({ ...r, content: expand(r.content) })));
  });

  app.get('/api/search', async (c) => {
    const q = c.req.query('q') ?? '';
    const limit = Number(c.req.query('limit') ?? 10);
    return c.json(await store.search(q, limit));
  });

  app.get('/', (c) => c.html(renderIndex(store.storage.listSessions(50), readCachedHivemind())));
  app.get('/sessions/:id', (c) => {
    const id = c.req.param('id');
    const session = store.storage.getSession(id);
    if (!session) return c.notFound();
    const obs = store.timeline(id, undefined, 500);
    return c.html(
      renderSession(
        session,
        obs.map((r) => ({ ...r, content: expand(r.content) })),
      ),
    );
  });

  return app;
}

function safeJsonObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function createHivemindReader(options: WorkerAppOptions): () => ReturnType<typeof readHivemind> {
  let cached: ReturnType<typeof readHivemind> | null = null;
  let cachedAt = 0;
  return () => {
    const now = Date.now();
    if (cached && now - cachedAt < HIVEMIND_CACHE_TTL_MS) return cached;
    cached = readWorkerHivemind(options);
    cachedAt = now;
    return cached;
  };
}

function readWorkerHivemind(options: WorkerAppOptions): ReturnType<typeof readHivemind> {
  const input: HivemindOptions = { limit: 20 };
  if (options.hivemindRepoRoots?.length) {
    input.repoRoots = options.hivemindRepoRoots;
  }
  return readHivemind(input);
}

function pidFilePath(settings: Settings): string {
  return join(resolveDataDir(settings.dataDir), 'worker.pid');
}

export async function start(): Promise<void> {
  const settings = loadSettings();
  const dbPath = join(resolveDataDir(settings.dataDir), 'data.db');
  const store = new MemoryStore({ dbPath, settings });

  writePidFile(pidFilePath(settings));

  let loop: EmbedLoopHandle | undefined;
  const servers: Array<ReturnType<typeof serve>> = [];

  const shutdown = async () => {
    removePidFile(pidFilePath(settings));
    if (loop) await loop.stop();
    for (const s of servers) s.close();
    store.close();
  };

  process.on('SIGTERM', () => {
    shutdown().finally(() => process.exit(0));
  });
  process.on('SIGINT', () => {
    shutdown().finally(() => process.exit(0));
  });

  // Build embedder if provider != 'none'. Model load runs in the worker
  // process only — hooks never wait for it.
  let embedder = null;
  let embedderError: string | null = null;
  try {
    embedder = await createEmbedder(settings, {
      log: (line) => process.stderr.write(`${line}\n`),
    });
  } catch (err) {
    embedderError = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[colony worker] embedder unavailable: ${embedderError}\n`);
  }

  if (embedder) {
    loop = startEmbedLoop({
      store,
      embedder,
      settings,
      onIdleExit: () => {
        shutdown().finally(() => process.exit(0));
      },
    });
  } else {
    // Still write a minimal state file so `colony status` has something to show.
    writeFileSync(
      stateFilePath(settings),
      `${JSON.stringify(
        {
          provider: settings.embedding.provider,
          model: settings.embedding.model,
          dim: 0,
          embedded: 0,
          total: store.storage.countObservations(),
          lastBatchAt: null,
          lastBatchMs: null,
          lastError: embedderError,
          lastHttpAt: Date.now(),
          startedAt: Date.now(),
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }

  const app = buildApp(store, loop);
  servers.push(serve({ fetch: app.fetch, port: settings.workerPort, hostname: '127.0.0.1' }));
  process.stderr.write(
    `[colony worker] listening on http://127.0.0.1:${settings.workerPort} (pid ${process.pid})\n`,
  );
}

if (isMainEntry(import.meta.url)) {
  start().catch((err) => {
    process.stderr.write(`[colony worker] fatal: ${String(err)}\n`);
    process.exit(1);
  });
}
