import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { type ToolContext, defaultWrapHandler } from './context.js';

export function register(server: McpServer, ctx: ToolContext): void {
  const wrapHandler = ctx.wrapHandler ?? defaultWrapHandler;
  const { store, resolveEmbedder } = ctx;

  server.tool(
    'search',
    'Search prior memory for decisions, errors, notes, files, and implementation context. Query by feature name, package name, file path, task slug, or exact error message before implementation. Returns compact hits, observation IDs, and relevance snippets only; fetch full bodies with get_observations.',
    { query: z.string().min(1), limit: z.number().int().positive().max(50).optional() },
    wrapHandler('search', async ({ query, limit }) => {
      const e = (await resolveEmbedder()) ?? undefined;
      const hits = await store.search(query, limit, e);
      return {
        content: [{ type: 'text', text: JSON.stringify(hits) }],
      };
    }),
  );

  server.tool(
    'semantic_search',
    'Pure-vector semantic search over observation embeddings. Skips BM25 entirely — use this for concept-level queries, cross-language recall, or novel phrasings whose keywords are absent from the stored content (where the hybrid `search` tool returns no useful hits). Requires an embedding provider to be configured. Returns the same compact shape as `search`; fetch full bodies with `get_observations`.',
    { query: z.string().min(1), limit: z.number().int().positive().max(50).optional() },
    wrapHandler('semantic_search', async ({ query, limit }) => {
      const e = await resolveEmbedder();
      if (!e) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error:
                  'semantic_search requires an embedding provider; set settings.embedding.provider to local, ollama, openai, or codex-gpu',
                hits: [],
              }),
            },
          ],
        };
      }
      const hits = await store.semanticSearch(query, limit, e);
      return {
        content: [{ type: 'text', text: JSON.stringify(hits) }],
      };
    }),
  );

  server.tool(
    'timeline',
    'See a session timeline around an observation or recent turn. Returns chronological IDs, kinds, and timestamps for neighboring context before fetching bodies.',
    {
      session_id: z.string().min(1),
      around_id: z.number().int().positive().optional(),
      limit: z.number().int().positive().max(200).optional(),
    },
    wrapHandler('timeline', async ({ session_id, around_id, limit }) => {
      const rows = store.timeline(session_id, around_id, limit);
      const compact = rows.map((r) => ({ id: r.id, kind: r.kind, ts: r.ts }));
      return { content: [{ type: 'text', text: JSON.stringify(compact) }] };
    }),
  );

  server.tool(
    'get_observations',
    'Read full observation bodies by ID after compact search results. Use after search, timeline, inbox, task tools, or recall return observation IDs.',
    {
      ids: z.array(z.number().int().positive()).min(1).max(50),
      expand: z.boolean().optional(),
    },
    wrapHandler('get_observations', async ({ ids, expand: expandOpt }) => {
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
    }),
  );

  server.tool(
    'list_sessions',
    'Find recent sessions to inspect, recall, or debug history. Lists sessions in reverse chronological order with IDE, cwd, start, and end metadata.',
    { limit: z.number().int().positive().max(200).optional() },
    wrapHandler('list_sessions', async ({ limit }) => {
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
    }),
  );
}
