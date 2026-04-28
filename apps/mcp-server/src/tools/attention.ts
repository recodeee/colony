import { type AttentionInboxOptions, ProposalSystem, buildAttentionInbox } from '@colony/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from './context.js';

export function register(server: McpServer, ctx: ToolContext): void {
  const { store } = ctx;

  server.tool(
    'attention_inbox',
    'See what needs your attention: pending handoffs, unread messages, blockers, stalled lanes, and recent claims. This is the main surface where task_message items show up; post-hivemind_context attention check, review compact IDs first, then fetch full bodies with get_observations only when needed.',
    {
      session_id: z.string().min(1),
      agent: z.string().min(1),
      repo_root: z.string().min(1).optional(),
      repo_roots: z.array(z.string().min(1)).max(20).optional(),
      recent_claim_window_minutes: z.number().int().positive().max(1440).optional(),
      recent_claim_limit: z.number().int().positive().max(100).optional(),
      task_ids: z.array(z.number().int().positive()).max(100).optional(),
    },
    async (args) => {
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
      if (args.task_ids !== undefined) options.task_ids = args.task_ids;
      const inbox = buildAttentionInbox(store, options);
      return { content: [{ type: 'text', text: JSON.stringify(inbox) }] };
    },
  );

  server.tool(
    'task_foraging_report',
    'Find proposed work on this repo branch before picking tasks. Lists pending proposals, promoted work, strength, and expired weak signals omitted.',
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
}
