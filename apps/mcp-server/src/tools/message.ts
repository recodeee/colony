import { TASK_THREAD_ERROR_CODES, TaskThread, listMessagesForAgent } from '@colony/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from './context.js';
import { mcpError, mcpErrorResponse } from './shared.js';

const EXPIRES_IN_MINUTES_MAX = 60 * 24 * 7;

export function register(server: McpServer, ctx: ToolContext): void {
  const { store } = ctx;

  server.tool(
    'task_message',
    [
      'Send a message to another agent. Use for directed coordination on a task thread instead of generic task_post notes; defaults to broadcast/fyi when no recipient is specified.',
      "Minimum call: task_message(task_id, session_id, agent, content); it broadcasts to_agent='any' with urgency='fyi'. Use to_agent / to_session_id for direct coordination that doesn't transfer file claims; for 'hand off the work + files', use task_hand_off instead.",
      'Urgency controls preface prominence: fyi (coalesced into a counter), needs_reply (rendered as a summary + expected action), blocking (top-of-preface, never coalesced).',
      'Pass reply_to to chain onto an earlier message; the parent\'s immediate status flips to "replied". Reply chains are 1-deep authoritative: replies-to-replies are allowed but only the immediate parent flips, never a transitively-referenced ancestor.',
      'expires_in_minutes is an optional TTL. Past-TTL messages drop out of unread inbox queries and any later mark_read fails with MESSAGE_EXPIRED; their bodies stay in storage for audit and FTS.',
      'Replying to a still-unclaimed broadcast (to_agent=any) auto-claims it for you, hiding the broadcast from other recipients.',
    ].join(' '),
    {
      task_id: z.number().int().positive(),
      session_id: z.string().min(1).describe('your session_id (the sender)'),
      agent: z.string().min(1).describe('your agent name, e.g. claude or codex'),
      content: z.string().min(1),
      to_agent: z
        .enum(['claude', 'codex', 'any'])
        .default('any')
        .describe("Optional recipient agent class. Defaults to 'any' broadcast."),
      urgency: z
        .enum(['fyi', 'needs_reply', 'blocking'])
        .default('fyi')
        .describe("Optional message urgency. Defaults to 'fyi'."),
      to_session_id: z
        .string()
        .optional()
        .describe('Optional: target a specific live session. Prefer to_agent for durability.'),
      reply_to: z.number().int().positive().optional(),
      expires_in_minutes: z
        .number()
        .int()
        .positive()
        .max(EXPIRES_IN_MINUTES_MAX)
        .optional()
        .describe(
          'Optional message TTL in minutes (max 7 days). Past-TTL unread messages disappear from the inbox; bodies remain searchable.',
        ),
    },
    async (args) => {
      const thread = new TaskThread(store, args.task_id);
      const id = thread.postMessage({
        from_session_id: args.session_id,
        from_agent: args.agent,
        to_agent: args.to_agent ?? 'any',
        ...(args.to_session_id !== undefined ? { to_session_id: args.to_session_id } : {}),
        content: args.content,
        ...(args.reply_to !== undefined ? { reply_to: args.reply_to } : {}),
        urgency: args.urgency ?? 'fyi',
        ...(args.expires_in_minutes !== undefined
          ? { expires_in_ms: args.expires_in_minutes * 60_000 }
          : {}),
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ message_observation_id: id, status: 'unread' }),
          },
        ],
      };
    },
  );

  server.tool(
    'task_messages',
    'Read unread messages. Lists compact previews addressed to you across tasks; fetch full bodies via get_observations, then mark handled items with task_message_mark_read.',
    {
      session_id: z.string().min(1),
      agent: z.string().min(1),
      since_ts: z.number().int().nonnegative().optional(),
      task_ids: z.array(z.number().int().positive()).max(100).optional(),
      unread_only: z.boolean().optional(),
      limit: z.number().int().positive().max(200).optional(),
    },
    async (args) => {
      const messages = listMessagesForAgent(store, {
        session_id: args.session_id,
        agent: args.agent,
        ...(args.since_ts !== undefined ? { since_ts: args.since_ts } : {}),
        ...(args.task_ids !== undefined ? { task_ids: args.task_ids } : {}),
        ...(args.unread_only !== undefined ? { unread_only: args.unread_only } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      });
      return { content: [{ type: 'text', text: JSON.stringify(messages) }] };
    },
  );

  server.tool(
    'task_message_mark_read',
    'Mark message read. Emits a read receipt for the sender; idempotent for already-read or replied messages, while expired, retracted, and TTL states return explicit errors.',
    {
      message_observation_id: z.number().int().positive(),
      session_id: z.string().min(1),
    },
    async ({ message_observation_id, session_id }) => {
      const obs = store.storage.getObservation(message_observation_id);
      if (!obs?.task_id) {
        return mcpErrorResponse(
          TASK_THREAD_ERROR_CODES.OBSERVATION_NOT_ON_TASK,
          'observation is not on a task',
        );
      }
      const thread = new TaskThread(store, obs.task_id);
      try {
        const status = thread.markMessageRead(message_observation_id, session_id);
        return { content: [{ type: 'text', text: JSON.stringify({ status }) }] };
      } catch (err) {
        return mcpError(err);
      }
    },
  );

  server.tool(
    'task_message_retract',
    'Retract sent message. Recipients stop seeing it in inboxes; only the original sender can retract before it is answered, and audit storage keeps body text searchable for FTS and reply-chain history.',
    {
      message_observation_id: z.number().int().positive(),
      session_id: z.string().min(1).describe('your session_id (must match the original sender)'),
      reason: z.string().min(1).optional(),
    },
    async ({ message_observation_id, session_id, reason }) => {
      const obs = store.storage.getObservation(message_observation_id);
      if (!obs?.task_id) {
        return mcpErrorResponse(
          TASK_THREAD_ERROR_CODES.OBSERVATION_NOT_ON_TASK,
          'observation is not on a task',
        );
      }
      const thread = new TaskThread(store, obs.task_id);
      try {
        thread.retractMessage(message_observation_id, session_id, reason);
        return {
          content: [{ type: 'text', text: JSON.stringify({ status: 'retracted' }) }],
        };
      } catch (err) {
        return mcpError(err);
      }
    },
  );

  server.tool(
    'task_message_claim',
    "Claim broadcast. Takes ownership of a to_agent='any' message before replying; once claimed, the broadcast leaves other inboxes, and replying auto-claims unclaimed broadcasts.",
    {
      message_observation_id: z.number().int().positive(),
      session_id: z.string().min(1),
      agent: z.string().min(1),
    },
    async ({ message_observation_id, session_id, agent }) => {
      const obs = store.storage.getObservation(message_observation_id);
      if (!obs?.task_id) {
        return mcpErrorResponse(
          TASK_THREAD_ERROR_CODES.OBSERVATION_NOT_ON_TASK,
          'observation is not on a task',
        );
      }
      const thread = new TaskThread(store, obs.task_id);
      try {
        const meta = thread.claimBroadcastMessage(message_observation_id, session_id, agent);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                status: 'claimed',
                claimed_by_session_id: meta.claimed_by_session_id,
                claimed_by_agent: meta.claimed_by_agent,
                claimed_at: meta.claimed_at,
              }),
            },
          ],
        };
      } catch (err) {
        return mcpError(err);
      }
    },
  );
}
