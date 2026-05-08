import { buildIntegrationPlan, expandForagingConceptQuery } from '@colony/foraging';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { parseMeta } from './_meta.js';
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
    'Search example code patterns and reference implementations. Returns compact indexed hits; fetch full bodies with get_observations before porting concepts.',
    {
      query: z.string().min(1),
      repo_root: z.string().optional(),
      example_name: z.string().optional(),
      limit: z.number().int().positive().max(20).optional(),
    },
    wrapHandler('examples_query', async ({ query, repo_root, example_name, limit }) => {
      const expandedQuery = expandForagingQuery(query);
      const e = (await resolveEmbedder()) ?? undefined;
      const filter: { kind: string; metadata?: Record<string, string> } = {
        kind: 'foraged-pattern',
      };
      const metadata: Record<string, string> = {};
      if (repo_root) metadata.repo_root = repo_root;
      if (example_name) metadata.example_name = example_name;
      if (Object.keys(metadata).length > 0) filter.metadata = metadata;
      const hits = await store.search(expandedQuery, limit ?? 10, e, filter);
      return { content: [{ type: 'text', text: JSON.stringify(enrichForagingHits(store, hits)) }] };
    }),
  );

  server.tool(
    'examples_integrate_plan',
    'Plan how to integrate an example project into this repo. Returns concept port candidates, package considerations, config steps, and target hints.',
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
  return expandForagingConceptQuery(query);
}

function enrichForagingHits(
  store: ToolContext['store'],
  hits: Array<{ id: number; score: number; snippet: string }>,
): Array<{
  id: number;
  score: number;
  snippet: string;
  example_name?: string;
  file_path?: string;
  entry_kind?: string;
  concept_tags?: string[];
}> {
  const rows = store.storage.getObservations(hits.map((h) => h.id));
  const metadataById = new Map<number, Record<string, unknown>>();
  for (const row of rows) {
    if (!row.metadata) continue;
    try {
      metadataById.set(row.id, JSON.parse(row.metadata) as Record<string, unknown>);
    } catch (err) {
      process.stderr.write(
        `[colony] enrichForagingHits: observation ${row.id} metadata parse failed: ${(err as Error)?.message ?? err}\n`,
      );
    }
  }
  return hits.map((h) => {
    const md = metadataById.get(h.id);
    const conceptTags = Array.isArray(md?.concept_tags)
      ? md.concept_tags.filter((tag): tag is string => typeof tag === 'string')
      : undefined;
    return {
      id: h.id,
      score: h.score,
      snippet: h.snippet,
      ...(typeof md?.example_name === 'string' ? { example_name: md.example_name } : {}),
      ...(typeof md?.file_path === 'string' ? { file_path: md.file_path } : {}),
      ...(typeof md?.entry_kind === 'string' ? { entry_kind: md.entry_kind } : {}),
      ...(conceptTags ? { concept_tags: conceptTags } : {}),
    };
  });
}
