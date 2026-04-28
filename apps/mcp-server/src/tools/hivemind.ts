import { type SearchResult, readHivemind } from '@colony/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from './context.js';
import { buildContextQuery, buildHivemindContext, toHivemindOptions } from './shared.js';

export function register(server: McpServer, ctx: ToolContext): void {
  const { store, resolveEmbedder } = ctx;

  server.tool(
    'hivemind',
    'See what other agents are doing right now. Summarizes active sessions, branches, task ownership, and stale lanes from runtime state.',
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
    'Use this BEFORE editing to see active lanes, file ownership, and memory hints. Returns compact situational awareness before fetching full observations.',
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
}
