import { TaskThread } from '@colony/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from './context.js';

export function register(server: McpServer, ctx: ToolContext): void {
  const { store } = ctx;

  server.tool(
    'task_hand_off',
    'Hand off work to another agent on this task. Atomically releases/transfers file claims.',
    {
      task_id: z.number().int().positive(),
      session_id: z.string().min(1).describe('your session_id (the sender)'),
      agent: z.string().min(1).describe('your agent name, e.g. claude or codex'),
      to_agent: z.enum(['claude', 'codex', 'any']),
      to_session_id: z.string().optional(),
      summary: z.string().min(1),
      next_steps: z.array(z.string()).optional(),
      blockers: z.array(z.string()).optional(),
      released_files: z.array(z.string()).optional(),
      transferred_files: z.array(z.string()).optional(),
      expires_in_minutes: z.number().int().positive().max(480).optional(),
    },
    async (args) => {
      const thread = new TaskThread(store, args.task_id);
      const id = thread.handOff({
        from_session_id: args.session_id,
        from_agent: args.agent,
        to_agent: args.to_agent,
        ...(args.to_session_id !== undefined ? { to_session_id: args.to_session_id } : {}),
        summary: args.summary,
        ...(args.next_steps !== undefined ? { next_steps: args.next_steps } : {}),
        ...(args.blockers !== undefined ? { blockers: args.blockers } : {}),
        ...(args.released_files !== undefined ? { released_files: args.released_files } : {}),
        ...(args.transferred_files !== undefined
          ? { transferred_files: args.transferred_files }
          : {}),
        ...(args.expires_in_minutes !== undefined
          ? { expires_in_ms: args.expires_in_minutes * 60_000 }
          : {}),
      });
      return {
        content: [
          { type: 'text', text: JSON.stringify({ handoff_observation_id: id, status: 'pending' }) },
        ],
      };
    },
  );

  server.tool(
    'task_accept_handoff',
    'Accept a pending handoff addressed to you. Installs transferred file claims under your session.',
    {
      handoff_observation_id: z.number().int().positive(),
      session_id: z.string().min(1),
    },
    async ({ handoff_observation_id, session_id }) => {
      const obs = store.storage.getObservation(handoff_observation_id);
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
        thread.acceptHandoff(handoff_observation_id, session_id);
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'accepted' }) }] };
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
    'task_decline_handoff',
    'Decline a pending handoff. Records a reason and cancels the handoff so the sender can reissue.',
    {
      handoff_observation_id: z.number().int().positive(),
      session_id: z.string().min(1),
      reason: z.string().optional(),
    },
    async ({ handoff_observation_id, session_id, reason }) => {
      const obs = store.storage.getObservation(handoff_observation_id);
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
        thread.declineHandoff(handoff_observation_id, session_id, reason);
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
}
