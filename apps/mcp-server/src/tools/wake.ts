import {
  type AttentionInboxOptions,
  ProposalSystem,
  TaskThread,
  buildAttentionInbox,
} from '@colony/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from './context.js';

export function register(server: McpServer, ctx: ToolContext): void {
  const { store } = ctx;

  server.tool(
    'task_wake',
    'Post a wake request on a task thread — a lightweight nudge surfaced to the target on their next turn. No claim transfer. Use when you need another session to attend to something but a full handoff is the wrong shape.',
    {
      task_id: z.number().int().positive(),
      session_id: z.string().min(1).describe('your session_id (the sender)'),
      agent: z.string().min(1).describe('your agent name, e.g. claude or codex'),
      to_agent: z.enum(['claude', 'codex', 'any']),
      to_session_id: z.string().optional(),
      reason: z.string().min(1),
      next_step: z.string().optional(),
      expires_in_minutes: z.number().int().positive().max(1440).optional(),
    },
    async (args) => {
      const thread = new TaskThread(store, args.task_id);
      const id = thread.requestWake({
        from_session_id: args.session_id,
        from_agent: args.agent,
        to_agent: args.to_agent,
        ...(args.to_session_id !== undefined ? { to_session_id: args.to_session_id } : {}),
        reason: args.reason,
        ...(args.next_step !== undefined ? { next_step: args.next_step } : {}),
        ...(args.expires_in_minutes !== undefined
          ? { expires_in_ms: args.expires_in_minutes * 60_000 }
          : {}),
      });
      return {
        content: [
          { type: 'text', text: JSON.stringify({ wake_observation_id: id, status: 'pending' }) },
        ],
      };
    },
  );

  server.tool(
    'task_ack_wake',
    'Acknowledge a pending wake request addressed to you. Records an ack on the task thread so the sender sees the response on their next turn.',
    {
      wake_observation_id: z.number().int().positive(),
      session_id: z.string().min(1),
    },
    async ({ wake_observation_id, session_id }) => {
      const obs = store.storage.getObservation(wake_observation_id);
      if (!obs?.task_id) {
        return {
          content: [
            { type: 'text', text: JSON.stringify({ error: 'observation is not on a task' }) },
          ],
          isError: true,
        };
      }
      const thread = new TaskThread(store, obs.task_id);
      try {
        thread.acknowledgeWake(wake_observation_id, session_id);
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'acknowledged' }) }] };
      } catch (err) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'task_cancel_wake',
    'Cancel a pending wake request. Either the sender (withdrawing) or the target (declining) may cancel.',
    {
      wake_observation_id: z.number().int().positive(),
      session_id: z.string().min(1),
      reason: z.string().optional(),
    },
    async ({ wake_observation_id, session_id, reason }) => {
      const obs = store.storage.getObservation(wake_observation_id);
      if (!obs?.task_id) {
        return {
          content: [
            { type: 'text', text: JSON.stringify({ error: 'observation is not on a task' }) },
          ],
          isError: true,
        };
      }
      const thread = new TaskThread(store, obs.task_id);
      try {
        thread.cancelWake(wake_observation_id, session_id, reason);
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'cancelled' }) }] };
      } catch (err) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
            },
          ],
          isError: true,
        };
      }
    },
  );

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
