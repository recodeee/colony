import { TASK_THREAD_ERROR_CODES, TaskThread } from '@colony/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from './context.js';
import { mcpError, mcpErrorResponse } from './shared.js';

const RELAY_FALLBACK_RULE = [
  'Fallback when task_relay is unavailable in your client tool surface: use task_post first to record reason, one_line, base_branch, fetch_files_at if known, touched files, and any missing source branch/worktree.',
  'Then call task_hand_off with a compact summary and concrete next_steps so another agent can resume from base_branch instead of assuming the named source lane exists.',
  'Use released_files when you cannot transfer ownership; use transferred_files only when the receiver should inherit those claims on accept.',
].join(' ');

export function register(server: McpServer, ctx: ToolContext): void {
  const { store } = ctx;

  server.tool(
    'task_hand_off',
    [
      'Give work to another agent and transfer or release file claims. Use when you need to pass ownership, unblock yourself, or route work to a better owner.',
      RELAY_FALLBACK_RULE,
    ].join(' '),
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
    'Take over work from a pending handoff addressed to you. Installs transferred file claims under your session.',
    {
      handoff_observation_id: z.number().int().positive(),
      session_id: z.string().min(1),
    },
    async ({ handoff_observation_id, session_id }) => {
      const obs = store.storage.getObservation(handoff_observation_id);
      if (!obs?.task_id) {
        return mcpErrorResponse(
          TASK_THREAD_ERROR_CODES.OBSERVATION_NOT_ON_TASK,
          'observation is not on a task',
        );
      }
      const thread = new TaskThread(store, obs.task_id);
      try {
        thread.acceptHandoff(handoff_observation_id, session_id);
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'accepted' }) }] };
      } catch (err) {
        return mcpError(err);
      }
    },
  );

  server.tool(
    'task_decline_handoff',
    'Decline a handoff you cannot take. Records a reason and cancels the pending transfer so the sender can reissue.',
    {
      handoff_observation_id: z.number().int().positive(),
      session_id: z.string().min(1),
      reason: z.string().optional(),
    },
    async ({ handoff_observation_id, session_id, reason }) => {
      const obs = store.storage.getObservation(handoff_observation_id);
      if (!obs?.task_id) {
        return mcpErrorResponse(
          TASK_THREAD_ERROR_CODES.OBSERVATION_NOT_ON_TASK,
          'observation is not on a task',
        );
      }
      const thread = new TaskThread(store, obs.task_id);
      try {
        thread.declineHandoff(handoff_observation_id, session_id, reason);
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'cancelled' }) }] };
      } catch (err) {
        return mcpError(err);
      }
    },
  );
}
