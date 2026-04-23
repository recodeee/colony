#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type Settings, loadSettings, resolveDataDir } from '@cavemem/config';
import {
  type AgentCapabilities,
  DEFAULT_CAPABILITIES,
  type Embedder,
  type HivemindOptions,
  type HivemindSession,
  type HivemindSnapshot,
  MemoryStore,
  ProposalSystem,
  type SearchResult,
  TaskThread,
  loadProfile,
  readHivemind,
  saveProfile,
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

  // --- task thread tools ---
  //
  // Agents already know their session_id from SessionStart; it's passed
  // explicitly on every call so this server can stay session-agnostic and
  // serve multiple agents (e.g. a shared viewer) without ambient state.

  server.tool(
    'task_list',
    'List recent task threads. Each task groups sessions collaborating on the same (repo_root, branch).',
    { limit: z.number().int().positive().max(200).optional() },
    async ({ limit }) => {
      const tasks = store.storage.listTasks(limit ?? 50);
      return { content: [{ type: 'text', text: JSON.stringify(tasks) }] };
    },
  );

  server.tool(
    'task_timeline',
    'Recent observations on a task thread (compact: id, kind, session_id, ts, reply_to).',
    {
      task_id: z.number().int().positive(),
      limit: z.number().int().positive().max(200).optional(),
    },
    async ({ task_id, limit }) => {
      const rows = store.storage.taskTimeline(task_id, limit ?? 50);
      const compact = rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        session_id: r.session_id,
        ts: r.ts,
        reply_to: r.reply_to,
      }));
      return { content: [{ type: 'text', text: JSON.stringify(compact) }] };
    },
  );

  server.tool(
    'task_updates_since',
    "Task-thread observations after a cursor ts, excluding this session's own posts.",
    {
      task_id: z.number().int().positive(),
      session_id: z.string().min(1),
      since_ts: z.number().int().nonnegative(),
      limit: z.number().int().positive().max(200).optional(),
    },
    async ({ task_id, session_id, since_ts, limit }) => {
      const rows = store.storage
        .taskObservationsSince(task_id, since_ts, limit ?? 50)
        .filter((o) => o.session_id !== session_id);
      const compact = rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        session_id: r.session_id,
        ts: r.ts,
      }));
      return { content: [{ type: 'text', text: JSON.stringify(compact) }] };
    },
  );

  server.tool(
    'task_post',
    'Post a coordination message on a task thread. Use specific tools for claim / hand_off / accept.',
    {
      task_id: z.number().int().positive(),
      session_id: z.string().min(1),
      kind: z.enum(['question', 'answer', 'decision', 'blocker', 'note']),
      content: z.string().min(1),
      reply_to: z.number().int().positive().optional(),
    },
    async ({ task_id, session_id, kind, content, reply_to }) => {
      const thread = new TaskThread(store, task_id);
      const id = thread.post({
        session_id,
        kind,
        content,
        ...(reply_to !== undefined ? { reply_to } : {}),
      });
      return { content: [{ type: 'text', text: JSON.stringify({ id }) }] };
    },
  );

  server.tool(
    'task_claim_file',
    'Claim a file on a task thread so overlapping edits from other sessions surface a warning next turn.',
    {
      task_id: z.number().int().positive(),
      session_id: z.string().min(1),
      file_path: z.string().min(1),
      note: z.string().optional(),
    },
    async ({ task_id, session_id, file_path, note }) => {
      const thread = new TaskThread(store, task_id);
      const id = thread.claimFile({
        session_id,
        file_path,
        ...(note !== undefined ? { note } : {}),
      });
      return { content: [{ type: 'text', text: JSON.stringify({ observation_id: id }) }] };
    },
  );

  server.tool(
    'task_hand_off',
    'Hand off work to another agent on this task. Atomically releases/transfers file claims.',
    {
      task_id: z.number().int().positive(),
      session_id: z.string().min(1).describe('your session_id (the sender)'),
      agent: z.string().min(1).describe('your agent name, e.g. claude or codex'),
      to_agent: z.enum(['claude', 'codex', 'any']),
      to_session_id: z.string().optional(),
      summary: z.string().min(1),
      next_steps: z.array(z.string()).optional(),
      blockers: z.array(z.string()).optional(),
      released_files: z.array(z.string()).optional(),
      transferred_files: z.array(z.string()).optional(),
      expires_in_minutes: z.number().int().positive().max(480).optional(),
    },
    async (args) => {
      const thread = new TaskThread(store, args.task_id);
      const id = thread.handOff({
        from_session_id: args.session_id,
        from_agent: args.agent,
        to_agent: args.to_agent,
        ...(args.to_session_id !== undefined ? { to_session_id: args.to_session_id } : {}),
        summary: args.summary,
        ...(args.next_steps !== undefined ? { next_steps: args.next_steps } : {}),
        ...(args.blockers !== undefined ? { blockers: args.blockers } : {}),
        ...(args.released_files !== undefined ? { released_files: args.released_files } : {}),
        ...(args.transferred_files !== undefined
          ? { transferred_files: args.transferred_files }
          : {}),
        ...(args.expires_in_minutes !== undefined
          ? { expires_in_ms: args.expires_in_minutes * 60_000 }
          : {}),
      });
      return {
        content: [
          { type: 'text', text: JSON.stringify({ handoff_observation_id: id, status: 'pending' }) },
        ],
      };
    },
  );

  server.tool(
    'task_accept_handoff',
    'Accept a pending handoff addressed to you. Installs transferred file claims under your session.',
    {
      handoff_observation_id: z.number().int().positive(),
      session_id: z.string().min(1),
    },
    async ({ handoff_observation_id, session_id }) => {
      const obs = store.storage.getObservation(handoff_observation_id);
      if (!obs?.task_id) {
        return {
          content: [
            { type: 'text', text: JSON.stringify({ error: 'observation is not on a task' }) },
          ],
          isError: true,
        };
      }
      const thread = new TaskThread(store, obs.task_id);
      try {
        thread.acceptHandoff(handoff_observation_id, session_id);
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'accepted' }) }] };
      } catch (err) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'task_decline_handoff',
    'Decline a pending handoff. Records a reason and cancels the handoff so the sender can reissue.',
    {
      handoff_observation_id: z.number().int().positive(),
      session_id: z.string().min(1),
      reason: z.string().optional(),
    },
    async ({ handoff_observation_id, session_id, reason }) => {
      const obs = store.storage.getObservation(handoff_observation_id);
      if (!obs?.task_id) {
        return {
          content: [
            { type: 'text', text: JSON.stringify({ error: 'observation is not on a task' }) },
          ],
          isError: true,
        };
      }
      const thread = new TaskThread(store, obs.task_id);
      try {
        thread.declineHandoff(handoff_observation_id, session_id, reason);
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'cancelled' }) }] };
      } catch (err) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'task_propose',
    'Propose a potential improvement scoped to (repo_root, branch). Becomes a real task only after collective reinforcement crosses the promotion threshold.',
    {
      repo_root: z.string().min(1),
      branch: z.string().min(1),
      summary: z.string().min(1),
      rationale: z.string().min(1),
      touches_files: z.array(z.string()).default([]),
      session_id: z.string().min(1),
    },
    async ({ repo_root, branch, summary, rationale, touches_files, session_id }) => {
      const proposals = new ProposalSystem(store);
      const id = proposals.propose({
        repo_root,
        branch,
        summary,
        rationale,
        touches_files,
        session_id,
      });
      const strength = proposals.currentStrength(id);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              proposal_id: id,
              strength,
              promotion_threshold: ProposalSystem.PROMOTION_THRESHOLD,
            }),
          },
        ],
      };
    },
  );

  server.tool(
    'task_reinforce',
    "Reinforce a pending proposal. kind='explicit' for direct support; 'rediscovered' when you arrived at the same idea independently.",
    {
      proposal_id: z.number().int().positive(),
      session_id: z.string().min(1),
      kind: z.enum(['explicit', 'rediscovered']).default('explicit'),
    },
    async ({ proposal_id, session_id, kind }) => {
      const proposals = new ProposalSystem(store);
      const { strength, promoted } = proposals.reinforce({
        proposal_id,
        session_id,
        kind,
      });
      const proposal = store.storage.getProposal(proposal_id);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              proposal_id,
              strength,
              promoted,
              task_id: proposal?.task_id ?? null,
            }),
          },
        ],
      };
    },
  );

  server.tool(
    'agent_upsert_profile',
    "Set or update an agent's capability profile (ui_work, api_work, test_work, infra_work, doc_work). Weights are 0..1; missing weights keep their current value (or the 0.5 default for first-time profiles). Used by the handoff router to suggest which agent is the best fit for a broadcast ('any') handoff.",
    {
      agent: z.string().min(1),
      capabilities: z
        .object({
          ui_work: z.number().min(0).max(1).optional(),
          api_work: z.number().min(0).max(1).optional(),
          test_work: z.number().min(0).max(1).optional(),
          infra_work: z.number().min(0).max(1).optional(),
          doc_work: z.number().min(0).max(1).optional(),
        })
        .default({}),
    },
    async ({ agent, capabilities }) => {
      const definedCapabilities = Object.fromEntries(
        Object.entries(capabilities).filter(([, value]) => value !== undefined),
      ) as Partial<AgentCapabilities>;
      const profile = saveProfile(store.storage, agent, definedCapabilities);
      return { content: [{ type: 'text', text: JSON.stringify(profile) }] };
    },
  );

  server.tool(
    'agent_get_profile',
    'Read an agent capability profile. Unknown agents return the default (0.5 across all dimensions).',
    { agent: z.string().min(1) },
    async ({ agent }) => {
      const profile = loadProfile(store.storage, agent);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ...profile, defaults: DEFAULT_CAPABILITIES }),
          },
        ],
      };
    },
  );

  server.tool(
    'task_foraging_report',
    'List pending and recently promoted proposals on a (repo_root, branch). Pending proposals whose strength has evaporated below the noise floor are omitted.',
    {
      repo_root: z.string().min(1),
      branch: z.string().min(1),
    },
    async ({ repo_root, branch }) => {
      const proposals = new ProposalSystem(store);
      const report = proposals.foragingReport(repo_root, branch);
      return { content: [{ type: 'text', text: JSON.stringify(report) }] };
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
  locked_file_count: number;
  locked_file_preview: string[];
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
    .flatMap((session) => [
      session.task,
      session.task_name,
      session.routing_reason,
      ...session.locked_file_preview,
    ])
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
    locked_file_count: session.locked_file_count,
    locked_file_preview: session.locked_file_preview,
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
