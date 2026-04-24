import { buildIntegrationPlan } from '@colony/foraging';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from './context.js';

/**
 * Foraging surface exposed to MCP clients.
 *
 * Progressive disclosure: `examples_list` and `examples_query` return
 * compact shapes. Full observation bodies are fetched by
 * `get_observations(ids[])`, which already exists in search.ts. Keeps
 * the contract tight enough that a single `examples_query` call stays
 * under the MCP response-size budget even on large example sets.
 */
export function register(server: McpServer, ctx: ToolContext): void {
  const { store, resolveEmbedder } = ctx;

  server.tool(
    'examples_list',
    'List indexed example projects (food sources) for a repo root.',
    { repo_root: z.string().min(1) },
    async ({ repo_root }) => {
      const rows = store.storage.listExamples(repo_root);
      const compact = rows.map((r) => ({
        example_name: r.example_name,
        manifest_kind: r.manifest_kind,
        observation_count: r.observation_count,
        last_scanned_at: r.last_scanned_at,
      }));
      return { content: [{ type: 'text', text: JSON.stringify(compact) }] };
    },
  );

  server.tool(
    'examples_query',
    'Search indexed example patterns. Compact hits — fetch bodies via get_observations.',
    {
      query: z.string().min(1),
      example_name: z.string().optional(),
      limit: z.number().int().positive().max(20).optional(),
    },
    async ({ query, example_name, limit }) => {
      const e = (await resolveEmbedder()) ?? undefined;
      const filter: { kind: string; metadata?: Record<string, string> } = {
        kind: 'foraged-pattern',
      };
      if (example_name) filter.metadata = { example_name };
      const hits = await store.search(query, limit ?? 10, e, filter);
      return { content: [{ type: 'text', text: JSON.stringify(hits) }] };
    },
  );

  server.tool(
    'examples_integrate_plan',
    'Build an integration plan: dependency delta + files to copy + config steps.',
    {
      example_name: z.string().min(1),
      repo_root: z.string().min(1),
      target_hint: z.string().optional(),
    },
    async ({ example_name, repo_root, target_hint }) => {
      const plan = buildIntegrationPlan(store.storage, {
        example_name,
        repo_root,
        ...(target_hint !== undefined ? { target_hint } : {}),
      });
      return { content: [{ type: 'text', text: JSON.stringify(plan) }] };
    },
  );
}
