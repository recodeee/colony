import {
  SIMILARITY_FLOOR,
  type SuggestionPayload,
  buildSuggestionPayload,
  findSimilarTasks,
  insufficientSuggestionPayload,
} from '@colony/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from './context.js';

export function register(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'task_suggest_approach',
    'Find a proven approach from similar past tasks. Use before planning or implementation; returns insufficient_data_reason when history is not strong enough.',
    {
      query: z.string().min(1),
      repo_root: z.string().min(1).optional(),
      current_task_id: z.number().int().positive().optional(),
      limit: z.number().int().positive().max(50).optional(),
    },
    async ({ query, repo_root, current_task_id, limit }) => {
      const payload = await suggestApproach(ctx, {
        query,
        ...(repo_root !== undefined ? { repo_root } : {}),
        ...(current_task_id !== undefined ? { current_task_id } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
    },
  );
}

export async function suggestApproach(
  ctx: ToolContext,
  args: { query: string; repo_root?: string; current_task_id?: number; limit?: number },
): Promise<SuggestionPayload> {
  const embedder = await ctx.resolveEmbedder();
  if (!embedder) return insufficientSuggestionPayload('embedder unavailable');

  let queryEmbedding: Float32Array;
  try {
    queryEmbedding = await embedder.embed(args.query);
  } catch {
    return insufficientSuggestionPayload('query embedding failed');
  }
  if (queryEmbedding.length !== embedder.dim) {
    return insufficientSuggestionPayload('query embedding failed');
  }

  const similarTasks = findSimilarTasks(ctx.store, embedder, queryEmbedding, {
    min_similarity: SIMILARITY_FLOOR,
    ...(args.repo_root !== undefined ? { repo_root: args.repo_root } : {}),
    ...(args.current_task_id !== undefined ? { exclude_task_ids: [args.current_task_id] } : {}),
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
  });

  return buildSuggestionPayload(ctx.store, similarTasks);
}
