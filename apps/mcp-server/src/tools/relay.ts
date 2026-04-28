import { TASK_THREAD_ERROR_CODES, TaskThread } from '@colony/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from './context.js';
import { mcpError, mcpErrorResponse } from './shared.js';

// 12 hours hard cap. Relays should expire faster than handoffs because the
// codebase moves; the default in core is 4h.
const EXPIRES_IN_MINUTES_MAX = 60 * 12;

export function register(server: McpServer, ctx: ToolContext): void {
  const { store } = ctx;

  server.tool(
    'task_relay',
    [
      'Pass unfinished work to another agent when you are being cut off. Use for quota, rate-limit, or turn-cap exits when you cannot write a thoughtful handoff; the system auto-synthesizes recent edits, claims, decisions, and blockers.',
      'Different from task_hand_off: relays assume the sender is gone, drop sender claims rather than transferring (the receiver re-claims via worktree_recipe.inherit_claims on accept), and bundle a worktree_recipe so a receiver in a different worktree knows how to set up their tree before editing.',
      'Provide fetch_files_at when your work is committed and pushed — receivers can reproduce your tree from git. Omit it when your edits are uncommitted; the relay then flags the touched paths in untracked_files_warning so the receiver knows they may be inheriting dirty work and should coordinate via task_message before editing.',
    ].join(' '),
    {
      task_id: z.number().int().positive(),
      session_id: z.string().min(1).describe('your session_id (the sender)'),
      agent: z.string().min(1).describe('your agent name, e.g. claude or codex'),
      reason: z.enum(['quota', 'rate-limit', 'turn-cap', 'manual', 'unspecified']),
      one_line: z
        .string()
        .min(1)
        .max(240)
        .describe(
          'One sentence describing what you were doing. The system pulls everything else from the task thread.',
        ),
      base_branch: z.string().min(1).describe('Base branch the receiver should branch from.'),
      to_agent: z.enum(['claude', 'codex', 'any']).optional(),
      to_session_id: z.string().optional(),
      fetch_files_at: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Git sha you were at, if your work is committed. Omit when your edits are uncommitted; the relay will flag touched paths in untracked_files_warning.',
        ),
      expires_in_minutes: z.number().int().positive().max(EXPIRES_IN_MINUTES_MAX).optional(),
    },
    async (args) => {
      const thread = new TaskThread(store, args.task_id);
      try {
        const id = thread.relay({
          from_session_id: args.session_id,
          from_agent: args.agent,
          reason: args.reason,
          one_line: args.one_line,
          base_branch: args.base_branch,
          ...(args.to_agent !== undefined ? { to_agent: args.to_agent } : {}),
          ...(args.to_session_id !== undefined ? { to_session_id: args.to_session_id } : {}),
          ...(args.fetch_files_at !== undefined ? { fetch_files_at: args.fetch_files_at } : {}),
          ...(args.expires_in_minutes !== undefined
            ? { expires_in_ms: args.expires_in_minutes * 60_000 }
            : {}),
        });
        return {
          content: [
            { type: 'text', text: JSON.stringify({ relay_observation_id: id, status: 'pending' }) },
          ],
        };
      } catch (err) {
        return mcpError(err);
      }
    },
  );

  server.tool(
    'task_accept_relay',
    'Resume work from a pending relay in your own worktree. Re-claims inherited files under your session; consult worktree_recipe before editing.',
    {
      relay_observation_id: z.number().int().positive(),
      session_id: z.string().min(1),
    },
    async ({ relay_observation_id, session_id }) => {
      const obs = store.storage.getObservation(relay_observation_id);
      if (!obs?.task_id) {
        return mcpErrorResponse(
          TASK_THREAD_ERROR_CODES.OBSERVATION_NOT_ON_TASK,
          'observation is not on a task',
        );
      }
      const thread = new TaskThread(store, obs.task_id);
      try {
        thread.acceptRelay(relay_observation_id, session_id);
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'accepted' }) }] };
      } catch (err) {
        return mcpError(err);
      }
    },
  );

  server.tool(
    'task_decline_relay',
    'Decline a relay you cannot take so another agent can pick it up. Records the reason and cancels the pending relay.',
    {
      relay_observation_id: z.number().int().positive(),
      session_id: z.string().min(1),
      reason: z.string().optional(),
    },
    async ({ relay_observation_id, session_id, reason }) => {
      const obs = store.storage.getObservation(relay_observation_id);
      if (!obs?.task_id) {
        return mcpErrorResponse(
          TASK_THREAD_ERROR_CODES.OBSERVATION_NOT_ON_TASK,
          'observation is not on a task',
        );
      }
      const thread = new TaskThread(store, obs.task_id);
      try {
        thread.declineRelay(relay_observation_id, session_id, reason);
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'cancelled' }) }] };
      } catch (err) {
        return mcpError(err);
      }
    },
  );
}
