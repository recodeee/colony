#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type Settings, loadSettings, resolveDataDir } from '@cavemem/config';
import {
  type Embedder,
  type HivemindOptions,
  type HivemindSession,
  type HivemindSnapshot,
  MemoryStore,
  type SearchResult,
  readHivemind,
} from '@cavemem/core';
import { createEmbedder } from '@cavemem/embedding';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

/**
 * MCP stdio server exposing progressive-disclosure tools:
 * - search: compact hits with BM25 + optional semantic re-rank
 * - timeline: chronological IDs around a point
 * - get_observations: full bodies by ID
 * - list_sessions: recent sessions for navigation
 * - hivemind: compact proxy-runtime active task map
 * - hivemind_context: active task map plus compact relevant memory hits
 *
 * Embedder is loaded lazily on first search — keeps MCP handshake fast.
 */
export function buildServer(store: MemoryStore, settings: Settings): McpServer {
  const server = new McpServer({
    name: 'cavemem',
    version: '0.1.0',
  });

  // tri-state: undefined = not yet attempted; null = unavailable (provider=none or load failed)
  let embedder: Embedder | null | undefined = undefined;
  const resolveEmbedder = async (): Promise<Embedder | null> => {
    if (embedder !== undefined) return embedder;
    try {
      embedder = await createEmbedder(settings, { log: () => {} });
    } catch (err) {
      process.stderr.write(
        `[cavemem mcp] embedder unavailable: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      embedder = null;
    }
    return embedder;
  };

  server.tool(
    'search',
    'Search memory. Returns compact hits — fetch full bodies via get_observations.',
    { query: z.string().min(1), limit: z.number().int().positive().max(50).optional() },
    async ({ query, limit }) => {
      const e = (await resolveEmbedder()) ?? undefined;
      const hits = await store.search(query, limit, e);
      return {
        content: [{ type: 'text', text: JSON.stringify(hits) }],
      };
    },
  );

  server.tool(
    'timeline',
    'Chronological observation IDs for a session. Use to locate context around a point.',
    {
      session_id: z.string().min(1),
      around_id: z.number().int().positive().optional(),
      limit: z.number().int().positive().max(200).optional(),
    },
    async ({ session_id, around_id, limit }) => {
      const rows = store.timeline(session_id, around_id, limit);
      const compact = rows.map((r) => ({ id: r.id, kind: r.kind, ts: r.ts }));
      return { content: [{ type: 'text', text: JSON.stringify(compact) }] };
    },
  );

  server.tool(
    'get_observations',
    'Fetch full observation bodies by ID. Returns expanded text by default.',
    {
      ids: z.array(z.number().int().positive()).min(1).max(50),
      expand: z.boolean().optional(),
    },
    async ({ ids, expand: expandOpt }) => {
      const rows = store.getObservations(ids, { expand: expandOpt ?? true });
      const payload = rows.map((r) => ({
        id: r.id,
        session_id: r.session_id,
        kind: r.kind,
        ts: r.ts,
        content: r.content,
        metadata: r.metadata,
      }));
      return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
    },
  );

  server.tool(
    'list_sessions',
    'List recent sessions in reverse chronological order. Use to navigate before calling timeline.',
    { limit: z.number().int().positive().max(200).optional() },
    async ({ limit }) => {
      const sessions = store.storage.listSessions(limit ?? 20);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              sessions.map((s) => ({
                id: s.id,
                ide: s.ide,
                cwd: s.cwd,
                started_at: s.started_at,
                ended_at: s.ended_at,
              })),
            ),
          },
        ],
      };
    },
  );

  server.tool(
    'hivemind',
    'Summarize active agent sessions and task ownership from proxy-runtime state files.',
    {
      repo_root: z.string().min(1).optional(),
      repo_roots: z.array(z.string().min(1)).max(20).optional(),
      include_stale: z.boolean().optional(),
      limit: z.number().int().positive().max(100).optional(),
    },
    async ({ repo_root, repo_roots, include_stale, limit }) => {
      const options: Parameters<typeof readHivemind>[0] = {};
      if (repo_root !== undefined) options.repoRoot = repo_root;
      if (repo_roots !== undefined) options.repoRoots = repo_roots;
      if (include_stale !== undefined) options.includeStale = include_stale;
      if (limit !== undefined) options.limit = limit;
      const snapshot = readHivemind(options);
      return { content: [{ type: 'text', text: JSON.stringify(snapshot) }] };
    },
  );

  server.tool(
    'hivemind_context',
    'Return active task ownership plus compact relevant memory hits. Use before fetching full observations.',
    {
      repo_root: z.string().min(1).optional(),
      repo_roots: z.array(z.string().min(1)).max(20).optional(),
      include_stale: z.boolean().optional(),
      limit: z.number().int().positive().max(100).optional(),
      query: z.string().min(1).optional(),
      memory_limit: z.number().int().positive().max(10).optional(),
    },
    async ({ repo_root, repo_roots, include_stale, limit, query, memory_limit }) => {
      const snapshot = readHivemind(
        toHivemindOptions({ repo_root, repo_roots, include_stale, limit }),
      );
      const memoryLimit = memory_limit ?? 3;
      const contextQuery = buildContextQuery(query, snapshot.sessions);
      let memoryHits: SearchResult[] = [];

      if (contextQuery) {
        const e = (await resolveEmbedder()) ?? undefined;
        memoryHits = await store.search(contextQuery, memoryLimit, e);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(buildHivemindContext(snapshot, memoryHits, contextQuery)),
          },
        ],
      };
    },
  );

  return server;
}

interface HivemindToolOptions {
  repo_root: string | undefined;
  repo_roots: string[] | undefined;
  include_stale: boolean | undefined;
  limit: number | undefined;
}

interface HivemindContextLane {
  repo_root: string;
  branch: string;
  task: string;
  owner: string;
  activity: HivemindSession['activity'];
  activity_summary: string;
  needs_attention: boolean;
  risk: string;
  source: HivemindSession['source'];
  worktree_path: string;
  updated_at: string;
  elapsed_seconds: number;
}

interface HivemindContext {
  generated_at: string;
  repo_roots: string[];
  summary: {
    lane_count: number;
    memory_hit_count: number;
    needs_attention_count: number;
    next_action: string;
  };
  counts: HivemindSnapshot['counts'];
  query: string;
  lanes: HivemindContextLane[];
  memory_hits: SearchResult[];
}

function toHivemindOptions(input: HivemindToolOptions): HivemindOptions {
  const options: HivemindOptions = {};
  if (input.repo_root !== undefined) options.repoRoot = input.repo_root;
  if (input.repo_roots !== undefined) options.repoRoots = input.repo_roots;
  if (input.include_stale !== undefined) options.includeStale = input.include_stale;
  if (input.limit !== undefined) options.limit = input.limit;
  return options;
}

function buildContextQuery(query: string | undefined, sessions: HivemindSession[]): string {
  if (query?.trim()) return query.trim();
  const taskText = sessions
    .flatMap((session) => [session.task, session.task_name, session.routing_reason])
    .map((entry) => entry.trim())
    .filter(Boolean);
  return [...new Set(taskText)].join(' ').slice(0, 800);
}

function buildHivemindContext(
  snapshot: HivemindSnapshot,
  memoryHits: SearchResult[],
  query: string,
): HivemindContext {
  const lanes = snapshot.sessions.map(toContextLane);
  const needsAttentionCount = lanes.filter((lane) => lane.needs_attention).length;

  return {
    generated_at: snapshot.generated_at,
    repo_roots: snapshot.repo_roots,
    summary: {
      lane_count: lanes.length,
      memory_hit_count: memoryHits.length,
      needs_attention_count: needsAttentionCount,
      next_action: nextAction(lanes, memoryHits),
    },
    counts: snapshot.counts,
    query,
    lanes,
    memory_hits: memoryHits,
  };
}

function toContextLane(session: HivemindSession): HivemindContextLane {
  const risk = laneRisk(session);
  return {
    repo_root: session.repo_root,
    branch: session.branch,
    task: session.task,
    owner: `${session.agent}/${session.cli}`,
    activity: session.activity,
    activity_summary: session.activity_summary,
    needs_attention: risk !== 'none',
    risk,
    source: session.source,
    worktree_path: session.worktree_path,
    updated_at: session.updated_at,
    elapsed_seconds: session.elapsed_seconds,
  };
}

function laneRisk(session: HivemindSession): string {
  if (session.activity === 'dead') return 'dead session';
  if (session.activity === 'stalled') return 'stale telemetry';
  if (session.activity === 'unknown') return 'unknown runtime state';
  return 'none';
}

function nextAction(lanes: HivemindContextLane[], memoryHits: SearchResult[]): string {
  if (lanes.some((lane) => lane.needs_attention)) {
    return 'Inspect lanes with needs_attention before taking over or editing nearby files.';
  }
  if (lanes.length > 0 && memoryHits.length > 0) {
    return 'Use lane ownership first, then fetch only the specific memory IDs needed.';
  }
  if (lanes.length > 0) {
    return 'Use lane ownership before editing; no matching memory hit was needed.';
  }
  if (memoryHits.length > 0) {
    return 'No live lanes found; fetch only the memory IDs needed.';
  }
  return 'No live lanes or matching memory found.';
}

async function main(): Promise<void> {
  const settings = loadSettings();
  const dbPath = join(resolveDataDir(settings.dataDir), 'data.db');
  const store = new MemoryStore({ dbPath, settings });

  const server = buildServer(store, settings);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (isMainEntry()) {
  main().catch((err) => {
    process.stderr.write(`[cavemem mcp] fatal: ${String(err)}\n`);
    process.exit(1);
  });
}

function isMainEntry(): boolean {
  const argv = process.argv[1];
  if (!argv) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv)).href;
  } catch {
    return import.meta.url === pathToFileURL(argv).href;
  }
}
