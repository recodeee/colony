import { type AttentionInboxOptions, buildAttentionInbox } from '@colony/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { type ToolContext, defaultWrapHandler } from './context.js';
import { attentionObservationIds } from './hivemind.js';

// Default size of the observation_ids list returned in compact mode.
// Matches the cap hivemind_context already uses for its embedded
// attention slot, so the two surfaces stay ergonomically consistent.
const COMPACT_OBSERVATION_ID_LIMIT = 12;

export function register(server: McpServer, ctx: ToolContext): void {
  const wrapHandler = ctx.wrapHandler ?? defaultWrapHandler;
  const { store, settings } = ctx;

  server.tool(
    'attention_inbox',
    'See what needs your attention after hivemind_context: handoffs, unread messages, blockers, stalled lanes, recent claims, stale claim cleanup signals, and decaying hot files. Defaults to a compact payload (counts + observation_ids); pass format="full" when you actually need every body inline. Also surfaces quota-pending claim relays before work selection; weak-expired quota claims stay hidden unless audit=true is set. Expired handoffs are not surfaced as pending recruitment signals. This is the main surface where task_message items show up; unread message entries (in the full payload) include reply_tool=task_message, suggested_reply_args, and mark_read_tool=task_message_mark_read hints, with next_action for blocking/needs_reply items. Review compact IDs first, then fetch full bodies with get_observations only when needed.',
    {
      session_id: z.string().min(1),
      agent: z.string().min(1),
      repo_root: z.string().min(1).optional(),
      repo_roots: z.array(z.string().min(1)).max(20).optional(),
      recent_claim_window_minutes: z.number().int().positive().max(1440).optional(),
      recent_claim_limit: z.number().int().positive().max(100).optional(),
      stalled_lane_limit: z.number().int().positive().max(100).optional(),
      file_heat_half_life_minutes: z.number().int().positive().max(1440).optional(),
      file_heat_limit: z.number().int().positive().max(100).optional(),
      file_heat_min_heat: z.number().positive().max(100).optional(),
      task_ids: z.array(z.number().int().positive()).max(100).optional(),
      format: z.enum(['compact', 'full']).optional(),
      observation_id_limit: z.number().int().positive().max(100).optional(),
      verbose: z.boolean().optional(),
      audit: z.boolean().optional(),
    },
    wrapHandler('attention_inbox', async (args) => {
      const options: AttentionInboxOptions = {
        session_id: args.session_id,
        agent: args.agent,
      };
      if (args.repo_root !== undefined) options.repo_root = args.repo_root;
      if (args.repo_roots !== undefined) options.repo_roots = args.repo_roots;
      if (args.recent_claim_window_minutes !== undefined) {
        options.recent_claim_window_ms = args.recent_claim_window_minutes * 60_000;
      }
      if (args.recent_claim_limit !== undefined) {
        options.recent_claim_limit = args.recent_claim_limit;
      }
      if (args.stalled_lane_limit !== undefined) {
        options.stalled_lane_limit = args.stalled_lane_limit;
      }
      options.claim_stale_ms = settings.claimStaleMinutes * 60_000;
      const fileHeatHalfLifeMinutes =
        args.file_heat_half_life_minutes ?? settings.fileHeatHalfLifeMinutes;
      options.file_heat_half_life_ms = fileHeatHalfLifeMinutes * 60_000;
      if (args.file_heat_limit !== undefined) options.file_heat_limit = args.file_heat_limit;
      if (args.file_heat_min_heat !== undefined) {
        options.file_heat_min_heat = args.file_heat_min_heat;
      }
      if (args.task_ids !== undefined) options.task_ids = args.task_ids;
      // `verbose` historically aliased `audit` (both surfaced weak-expired
      // quota claims). We preserve that legacy behaviour so existing agent
      // calls keep working; the new `format` flag controls payload shape
      // independently.
      if (args.verbose === true || args.audit === true) options.include_audit_claims = true;
      const inbox = buildAttentionInbox(store, options);

      const format = args.format ?? 'compact';
      if (format === 'full') {
        return { content: [{ type: 'text', text: JSON.stringify(inbox) }] };
      }

      // Compact mode: counts + observation_ids only. Mirrors the
      // hivemind_context attention slot — agents that need the full
      // inbox bodies should call get_observations(ids) for the IDs
      // they actually want, or re-call attention_inbox with format="full".
      const observationIdLimit = args.observation_id_limit ?? COMPACT_OBSERVATION_ID_LIMIT;
      const { ids, truncated } = attentionObservationIds(inbox, observationIdLimit);
      const compact = {
        format: 'compact' as const,
        generated_at: inbox.generated_at,
        session_id: inbox.session_id,
        agent: inbox.agent,
        summary: inbox.summary,
        observation_ids: ids,
        observation_ids_truncated: truncated,
        hint: 'Hydrate items with get_observations(ids); call again with format="full" only when you need every body inline.',
      };
      return { content: [{ type: 'text', text: JSON.stringify(compact) }] };
    }),
  );
}
