import { buildIntegrationPlan } from '@colony/foraging';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { type ToolContext, defaultWrapHandler } from './context.js';

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
  const wrapHandler = ctx.wrapHandler ?? defaultWrapHandler;
  const { store, resolveEmbedder } = ctx;

  server.tool(
    'examples_list',
    'List example projects available for this repo. Use before examples_query to choose reference sources, manifests, and indexed example names.',
    { repo_root: z.string().min(1) },
    wrapHandler('examples_list', async ({ repo_root }) => {
      const rows = store.storage.listExamples(repo_root);
      const compact = rows.map((r) => ({
        example_name: r.example_name,
        manifest_kind: r.manifest_kind,
        observation_count: r.observation_count,
        last_scanned_at: r.last_scanned_at,
      }));
      return { content: [{ type: 'text', text: JSON.stringify(compact) }] };
    }),
  );

  server.tool(
    'examples_query',
    'Search example code patterns and reference implementations. Returns compact indexed hits; fetch full bodies with get_observations before copying files.',
    {
      query: z.string().min(1),
      example_name: z.string().optional(),
      limit: z.number().int().positive().max(20).optional(),
    },
    wrapHandler('examples_query', async ({ query, example_name, limit }) => {
      const expandedQuery = expandForagingQuery(query);
      const e = (await resolveEmbedder()) ?? undefined;
      const filter: { kind: string; metadata?: Record<string, string> } = {
        kind: 'foraged-pattern',
      };
      if (example_name) filter.metadata = { example_name };
      const hits = await store.search(expandedQuery, limit ?? 10, e, filter);
      return { content: [{ type: 'text', text: JSON.stringify(hits) }] };
    }),
  );

  server.tool(
    'examples_integrate_plan',
    'Plan how to integrate an example project into this repo. Returns dependency deltas, file copy scope, config steps, and target hints.',
    {
      example_name: z.string().min(1),
      repo_root: z.string().min(1),
      target_hint: z.string().optional(),
    },
    wrapHandler('examples_integrate_plan', async ({ example_name, repo_root, target_hint }) => {
      const plan = buildIntegrationPlan(store.storage, {
        example_name,
        repo_root,
        ...(target_hint !== undefined ? { target_hint } : {}),
      });
      return { content: [{ type: 'text', text: JSON.stringify(plan) }] };
    }),
  );
}

export function expandForagingQuery(query: string): string {
  const q = query.toLowerCase();
  const extras: string[] = [];
  if (q.includes('outcome-learning') || q.includes('concept=outcome-learning')) {
    extras.push('outcome learning verification completion');
  }
  if (q.includes('token-budget') || q.includes('concept=token-budget')) {
    extras.push('token budget compact hydrate collapse');
  }
  if (q.includes('pattern-memory') || q.includes('concept=pattern-memory')) {
    extras.push('pattern memory observation history');
  }
  if (q.includes('trigger-routing') || q.includes('concept=trigger-routing')) {
    extras.push('trigger routing classify route');
  }
  if (extras.length === 0) return query;
  return `${query} ${extras.join(' ')}`;
}
