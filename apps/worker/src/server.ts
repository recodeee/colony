#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expand } from '@colony/compress';
import { type Settings, defaultSettings, loadSettings, resolveDataDir } from '@colony/config';
import {
  type DiscrepancyReport,
  type HivemindOptions,
  MemoryStore,
  buildDiscrepancyReport,
  bulkRescueStrandedSessions,
  listPlans,
  readHivemind,
} from '@colony/core';
import { createEmbedder } from '@colony/embedding';
import { isMainEntry, notify, removePidFile, writePidFile } from '@colony/process';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { type CaffeinateHandle, startCaffeinate } from './caffeinate.js';
import { type EmbedLoopHandle, startEmbedLoop, stateFilePath } from './embed-loop.js';
import { type RescueLoopHandle, startRescueLoop } from './rescue-loop.js';
import {
  type StrandedSessionSummary,
  buildClaimCoverageSnapshot,
  buildFileHeatRows,
  buildViewerAdoptionHealthPayload,
  renderIndex,
  renderSavingsPage,
  renderSession,
} from './viewer.js';

const HIVEMIND_CACHE_TTL_MS = 500;
const CLAIM_COVERAGE_WINDOW_MS = 60 * 60_000;
type BuildDiscrepancyReport = (store: MemoryStore, options: { since: number }) => DiscrepancyReport;

export interface WorkerAppOptions {
  hivemindRepoRoots?: string[];
  discrepancyReportBuilder?: BuildDiscrepancyReport;
  rescueLoop?: RescueLoopHandle;
  fileHeatHalfLifeMinutes?: number;
}

export function buildApp(
  store: MemoryStore,
  loop?: EmbedLoopHandle,
  options: WorkerAppOptions = {},
): Hono {
  const app = new Hono();
  const readCachedHivemind = createHivemindReader(options);
  const reportBuilder = options.discrepancyReportBuilder ?? buildDiscrepancyReport;

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

  app.get('/api/colony/discrepancy', (c) => {
    const since = Number(c.req.query('since') ?? Date.now() - 24 * 60 * 60_000);
    const report = reportBuilder(store, { since });
    return c.json(report);
  });

  app.get('/api/colony/claim-coverage', (c) => {
    const since = parseSinceQuery(c.req.query('since'), Date.now() - CLAIM_COVERAGE_WINDOW_MS);
    return c.json(buildClaimCoverageSnapshot(store, since));
  });

  app.get('/api/colony/file-heat', (c) => {
    return c.json(
      buildFileHeatRows(
        store.storage,
        store.storage.listTasks(200).filter((task) => task.status === 'open'),
        options.fileHeatHalfLifeMinutes ?? defaultSettings.fileHeatHalfLifeMinutes,
      ),
    );
  });

  app.get('/api/colony/adoption-health', (c) => {
    const since = parseSinceQuery(c.req.query('since'), Date.now() - 24 * 60 * 60_000);
    return c.json(buildViewerAdoptionHealthPayload(store, { since }));
  });

  app.get('/api/colony/savings', (c) => {
    const { live, hours } = readSavingsPayload(
      store,
      c.req.query('hours'),
      c.req.query('since'),
      c.req.query('input_usd_per_1m'),
      c.req.query('output_usd_per_1m'),
      c.req.query('session_limit'),
    );
    return c.json({
      live,
      window: { hours, since: live.since, until: live.until },
    });
  });

  app.get('/api/colony/stranded', (c) => {
    return c.json(
      options.rescueLoop?.lastScan() ?? {
        stranded: [],
        last_scan_at: null,
        next_scan_at: null,
      },
    );
  });

  app.post('/api/colony/stranded/scan', async (c) => {
    if (!options.rescueLoop) {
      return c.json({ stranded: [], rescued: [], dry_run: true, error: 'rescue loop not running' });
    }
    const strandedAfterMinutes = c.req.query('stranded_after_minutes');
    const parsed = strandedAfterMinutes !== undefined ? Number(strandedAfterMinutes) : undefined;
    const scan = await options.rescueLoop.scan({
      dry_run: true,
      ...(parsed !== undefined && Number.isFinite(parsed) && parsed > 0
        ? { stranded_after_minutes: parsed }
        : {}),
    });
    return c.json(scan);
  });

  app.get('/api/colony/stranded/:id/rescue/preview', (c) => {
    const sessionId = c.req.param('id');
    const outcome = previewStrandedSessionRescue(store, sessionId);
    const status = outcome.stranded.length > 0 ? 200 : 404;
    return c.json(rescueResponse('preview', sessionId, outcome, c.req.path), status);
  });

  app.post('/api/colony/stranded/:id/rescue', (c) => {
    const sessionId = c.req.param('id');
    try {
      const outcome = bulkRescueStrandedSessions(store, {
        dry_run: false,
        session_id: sessionId,
      });
      const status = outcome.rescued.length > 0 ? 200 : 404;
      return c.json(rescueResponse('apply', sessionId, outcome, c.req.path), status);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json(
        {
          ok: false,
          mode: 'apply',
          session_id: sessionId,
          error: message,
          command: rescueCurlCommand(c.req.path),
        },
        500,
      );
    }
  });

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
      pending_broadcasts: recent
        .filter((r) => r.kind === 'message')
        .map((r) => {
          const meta = safeJsonObject(r.metadata);
          return {
            id: r.id,
            ts: r.ts,
            from_agent: (meta.from_agent as string | undefined) ?? null,
            from_session_id: (meta.from_session_id as string | undefined) ?? r.session_id,
            status: (meta.status as string | undefined) ?? 'unread',
            to_agent: (meta.to_agent as string | undefined) ?? null,
            preview: r.content.slice(0, 120),
            expires_at: (meta.expires_at as number | undefined) ?? null,
            claimed_by_session_id: (meta.claimed_by_session_id as string | undefined) ?? null,
          };
        })
        .filter(
          (m) =>
            m.to_agent === 'any' &&
            m.status === 'unread' &&
            m.claimed_by_session_id == null &&
            (m.expires_at == null || m.expires_at > now),
        ),
      recent: recent.slice(0, 10).map((r) => ({
        id: r.id,
        kind: r.kind,
        session_id: r.session_id,
        ts: r.ts,
      })),
    });
  });

  app.get('/api/colony/plans', (c) => {
    const repoRoot = c.req.query('repo_root');
    const onlyAvailable = c.req.query('only_with_available_subtasks') === 'true';
    const capability = c.req.query('capability_match');
    const limit = c.req.query('limit') ? Number(c.req.query('limit')) : undefined;
    return c.json(
      listPlans(store, {
        ...(repoRoot ? { repo_root: repoRoot } : {}),
        ...(onlyAvailable ? { only_with_available_subtasks: true } : {}),
        ...(capability ? { capability_match: capability } : {}),
        ...(limit !== undefined ? { limit } : {}),
      }),
    );
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

  app.get('/', (c) =>
    c.html(
      renderIndex(
        store.storage.listSessions(50),
        readCachedHivemind(),
        store,
        readStrandedSessionsForPlansPage(store),
        reportBuilder,
        options.fileHeatHalfLifeMinutes,
      ),
    ),
  );
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

  app.get('/savings', (c) => {
    const { live, hours } = readSavingsPayload(
      store,
      c.req.query('hours'),
      c.req.query('since'),
      c.req.query('input_usd_per_1m'),
      c.req.query('output_usd_per_1m'),
      c.req.query('session_limit'),
    );
    return c.html(renderSavingsPage({ live, windowHours: hours }));
  });

  return app;
}

const DEFAULT_SAVINGS_HOURS = 24;
const SAVINGS_HOUR_MS = 60 * 60_000;

function readSavingsPayload(
  store: MemoryStore,
  hoursQuery: string | undefined,
  sinceQuery: string | undefined,
  inputCostQuery: string | undefined,
  outputCostQuery: string | undefined,
  sessionLimitQuery: string | undefined,
): { live: ReturnType<MemoryStore['storage']['aggregateMcpMetrics']>; hours: number } {
  const parsedHours = hoursQuery !== undefined ? Number(hoursQuery) : Number.NaN;
  const hours =
    Number.isFinite(parsedHours) && parsedHours > 0 ? parsedHours : DEFAULT_SAVINGS_HOURS;
  const now = Date.now();
  const sinceFromQuery = parseSinceQuery(sinceQuery, now - hours * SAVINGS_HOUR_MS);
  const inputRate = parseCostRate(inputCostQuery, process.env.COLONY_MCP_INPUT_USD_PER_1M);
  const outputRate = parseCostRate(outputCostQuery, process.env.COLONY_MCP_OUTPUT_USD_PER_1M);
  const sessionLimit = parseSessionLimit(sessionLimitQuery);
  const live = store.storage.aggregateMcpMetrics({
    since: sinceFromQuery,
    until: now,
    ...(sessionLimit !== undefined ? { sessionLimit } : {}),
    cost: {
      ...(inputRate !== undefined ? { input_usd_per_1m_tokens: inputRate } : {}),
      ...(outputRate !== undefined ? { output_usd_per_1m_tokens: outputRate } : {}),
    },
  });
  return { live, hours };
}

function parseSessionLimit(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : undefined;
}

function parseSinceQuery(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric >= 0) return numeric;
  const parsedDate = Date.parse(raw);
  return Number.isFinite(parsedDate) ? parsedDate : fallback;
}

function parseCostRate(raw: string | undefined, fallback: string | undefined): number | undefined {
  const value = raw ?? fallback;
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

type RescueMode = 'preview' | 'apply';
type RescueOutcome = ReturnType<typeof bulkRescueStrandedSessions>;

function previewStrandedSessionRescue(store: MemoryStore, sessionId: string): RescueOutcome {
  return bulkRescueStrandedSessions(store, {
    dry_run: true,
    session_id: sessionId,
  });
}

function rescueResponse(
  mode: RescueMode,
  sessionId: string,
  outcome: RescueOutcome,
  requestPath: string,
): {
  ok: boolean;
  mode: RescueMode;
  session_id: string;
  command: string;
  scanned: number;
  rescued: RescueOutcome['rescued'];
  skipped: RescueOutcome['skipped'];
  released_claim_count: number;
  audit_observation_ids: number[];
  message: string;
} {
  const rescueRows = mode === 'preview' ? outcome.stranded : outcome.rescued;
  const ok = rescueRows.length > 0;
  const skippedReason = outcome.skipped.find((row) => row.session_id === sessionId)?.reason;
  return {
    ok,
    mode,
    session_id: sessionId,
    command: rescueCurlCommand(requestPath.replace(/\/preview$/, '')),
    scanned: outcome.scanned,
    rescued: rescueRows,
    skipped: outcome.skipped,
    released_claim_count: outcome.released_claim_count,
    audit_observation_ids: outcome.audit_observation_ids,
    message: ok
      ? mode === 'preview'
        ? 'Preview ready. Confirm to release the stranded claims and mark the session rescued.'
        : 'Rescue applied. Claims released and session marked rescued.'
      : `No rescue applied: ${skippedReason ?? 'session is not currently rescueable'}.`,
  };
}

function rescueCurlCommand(path: string): string {
  return `curl -X POST http://127.0.0.1:${loadSettings().workerPort}${path}`;
}

type StrandedStorageReader = {
  findStrandedSessions?: () => StrandedStorageRow[];
  getTask: MemoryStore['storage']['getTask'];
};

interface StrandedStorageRow {
  session_id: string;
  ide?: string;
  agent_name?: string;
  cwd?: string | null;
  branch?: string;
  repo_root?: string;
  last_observation_ts?: number;
  last_activity_ts?: number;
  held_claims_json?: string;
  held_claims?: HeldClaimSummary[];
  last_tool_error?: string | null;
}

interface HeldClaimSummary {
  task_id?: number;
  file_path: string;
  claimed_at?: number;
}

function readStrandedSessionsForPlansPage(store: MemoryStore): StrandedSessionSummary[] {
  const storage = store.storage as unknown as StrandedStorageReader;
  if (typeof storage.findStrandedSessions !== 'function') return [];
  return storage.findStrandedSessions().map((row) => {
    const heldClaims: HeldClaimSummary[] = Array.isArray(row.held_claims)
      ? row.held_claims.filter(isHeldClaimSummary)
      : parseHeldClaims(row.held_claims_json);
    const firstTask = heldClaims
      .map((claim) =>
        typeof claim.task_id === 'number' && Number.isFinite(claim.task_id)
          ? storage.getTask(claim.task_id)
          : undefined,
      )
      .find((task) => task !== undefined);
    return {
      session_id: row.session_id,
      agent_name: row.agent_name ?? row.ide ?? 'unknown',
      branch: row.branch ?? firstTask?.branch ?? 'unknown branch',
      repo_root: row.repo_root ?? firstTask?.repo_root ?? row.cwd ?? 'unknown repo',
      last_activity_ts: row.last_activity_ts ?? row.last_observation_ts ?? Date.now(),
      held_claims: heldClaims.map((claim) => ({ file_path: claim.file_path })),
      last_tool_error: row.last_tool_error ?? null,
    };
  });
}

function parseHeldClaims(raw: string | undefined): HeldClaimSummary[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isHeldClaimSummary) : [];
  } catch {
    return [];
  }
}

function isHeldClaimSummary(value: unknown): value is HeldClaimSummary {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as HeldClaimSummary).file_path === 'string'
  );
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
  let caffeinate: CaffeinateHandle | undefined;
  const handles: { rescueLoop?: RescueLoopHandle } = {};
  const servers: Array<ReturnType<typeof serve>> = [];

  const shutdown = async () => {
    removePidFile(pidFilePath(settings));
    caffeinate?.stop();
    if (handles.rescueLoop) await handles.rescueLoop.stop();
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
    notify(
      {
        level: 'warn',
        title: 'colony: embedder unavailable',
        body: `Semantic search disabled — BM25 still works. (${embedderError})`,
      },
      {
        provider: settings.notify.provider,
        minLevel: settings.notify.minLevel,
        log: (line) => process.stderr.write(`${line}\n`),
      },
    );
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
    // Only hold the idle-sleep assertion while there's actual background work
    // to protect. If the embedder failed to load we skip caffeinate entirely
    // — the worker is then effectively just a viewer + state file writer and
    // doesn't need to keep the laptop awake.
    caffeinate = startCaffeinate((line) => process.stderr.write(`${line}\n`));
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

  handles.rescueLoop = startRescueLoop({
    store,
    settings,
    log: (line) => process.stderr.write(`${line}\n`),
  });

  const app = buildApp(store, loop, {
    rescueLoop: handles.rescueLoop,
    fileHeatHalfLifeMinutes: settings.fileHeatHalfLifeMinutes,
  });
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
