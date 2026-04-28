import { type AttentionInboxOptions, ProposalSystem, buildAttentionInbox } from '@colony/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from './context.js';

export function register(server: McpServer, ctx: ToolContext): void {
  const { store } = ctx;

  server.tool(
    'attention_inbox',
    'Compact list of what needs your attention: pending handoffs, pending wakes, stalled lanes, recent other-session file claims. Fetch bodies via get_observations.',
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
}
