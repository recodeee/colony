#!/usr/bin/env node
import { join } from 'node:path';
import { type Settings, loadSettings, resolveDataDir } from '@colony/config';
import { type Embedder, MemoryStore } from '@colony/core';
import { createEmbedder } from '@colony/embedding';
import { isMainEntry } from '@colony/process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as attention from './tools/attention.js';
import type { ToolContext } from './tools/context.js';
import * as foraging from './tools/foraging.js';
import * as handoff from './tools/handoff.js';
import { installActiveSessionHeartbeat } from './tools/heartbeat.js';
import * as hivemind from './tools/hivemind.js';
import * as message from './tools/message.js';
import * as planValidate from './tools/plan-validate.js';
import * as plan from './tools/plan.js';
import * as profile from './tools/profile.js';
import * as proposal from './tools/proposal.js';
import * as queen from './tools/queen.js';
import * as readyQueue from './tools/ready-queue.js';
import * as recall from './tools/recall.js';
import * as relay from './tools/relay.js';
import * as rescue from './tools/rescue.js';
import * as search from './tools/search.js';
import * as spec from './tools/spec.js';
import * as suggest from './tools/suggest.js';
import * as task from './tools/task.js';

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
    name: 'colony',
    version: '0.1.0',
  });

  // Make this MCP client visible to hivemind even when the IDE never ran
  // colony's lifecycle hooks (codex, custom MCP clients, background tools).
  // The stdio MCP server is spawned per client session, so env + cwd
  // identify the caller; upsertActiveSession merges with whatever a hook
  // writer may have produced and preserves richer task previews.
  installActiveSessionHeartbeat(server);

  // tri-state: undefined = not yet attempted; null = unavailable (provider=none or load failed)
  let embedder: Embedder | null | undefined = undefined;
  const resolveEmbedder = async (): Promise<Embedder | null> => {
    if (embedder !== undefined) return embedder;
    try {
      embedder = await createEmbedder(settings, { log: () => {} });
    } catch (err) {
      process.stderr.write(
        `[colony mcp] embedder unavailable: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      embedder = null;
    }
    return embedder;
  };

  const ctx: ToolContext = { store, settings, resolveEmbedder };

  // Registration order is load-bearing: `installActiveSessionHeartbeat` wraps
  // every subsequent `server.tool(...)` so tool-invocation telemetry uses the
  // original tool names. The order below mirrors the order the tools appeared
  // in the pre-split monolithic server.ts so existing MCP inspector fixtures
  // and snapshot tests stay stable.
  search.register(server, ctx);
  hivemind.register(server, ctx);
  task.register(server, ctx);
  handoff.register(server, ctx);
  proposal.register(server, ctx);
  profile.register(server, ctx);
  attention.register(server, ctx);
  message.register(server, ctx);
  relay.register(server, ctx);
  plan.register(server, ctx);
  queen.register(server, ctx);
  planValidate.register(server, ctx);
  readyQueue.register(server, ctx);
  recall.register(server, ctx);
  suggest.register(server, ctx);
  rescue.register(server, ctx);

  // Spec-driven dev lane (@colony/spec). Adds spec_read, spec_change_open,
  // spec_change_add_delta, spec_build_context, spec_build_record_failure,
  // spec_archive. Registered last so the heartbeat wrapper has seen every
  // core tool first.
  spec.register(server, ctx);

  // Foraging lane (@colony/foraging). Adds examples_list, examples_query,
  // examples_integrate_plan. Registered after spec so the heartbeat has
  // wrapped the earlier tools before we bind these three.
  foraging.register(server, ctx);

  return server;
}

export async function main(): Promise<void> {
  const settings = loadSettings();
  const dbPath = join(resolveDataDir(settings.dataDir), 'data.db');
  const store = new MemoryStore({ dbPath, settings });

  const server = buildServer(store, settings);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (isMainEntry(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`[colony mcp] fatal: ${String(err)}\n`);
    process.exit(1);
  });
}
