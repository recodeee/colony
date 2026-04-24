import { TaskThread } from '@colony/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from './context.js';

export function register(server: McpServer, ctx: ToolContext): void {
  const { store } = ctx;

  // Task-thread tools. Agents already know their session_id from SessionStart;
  // it's passed explicitly on every call so this server stays session-agnostic
  // and can serve multiple agents without ambient state.

  server.tool(
    'task_list',
    'List recent task threads. Each task groups sessions collaborating on the same (repo_root, branch).',
    { limit: z.number().int().positive().max(200).optional() },
    async ({ limit }) => {
      const tasks = store.storage.listTasks(limit ?? 50);
      return { content: [{ type: 'text', text: JSON.stringify(tasks) }] };
    },
  );

  server.tool(
    'task_timeline',
    'Recent observations on a task thread (compact: id, kind, session_id, ts, reply_to).',
    {
      task_id: z.number().int().positive(),
      limit: z.number().int().positive().max(200).optional(),
    },
    async ({ task_id, limit }) => {
      const rows = store.storage.taskTimeline(task_id, limit ?? 50);
      const compact = rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        session_id: r.session_id,
        ts: r.ts,
        reply_to: r.reply_to,
      }));
      return { content: [{ type: 'text', text: JSON.stringify(compact) }] };
    },
  );

  server.tool(
    'task_updates_since',
    "Task-thread observations after a cursor ts, excluding this session's own posts.",
    {
      task_id: z.number().int().positive(),
      session_id: z.string().min(1),
      since_ts: z.number().int().nonnegative(),
      limit: z.number().int().positive().max(200).optional(),
    },
    async ({ task_id, session_id, since_ts, limit }) => {
      const rows = store.storage
        .taskObservationsSince(task_id, since_ts, limit ?? 50)
        .filter((o) => o.session_id !== session_id);
      const compact = rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        session_id: r.session_id,
        ts: r.ts,
      }));
      return { content: [{ type: 'text', text: JSON.stringify(compact) }] };
    },
  );

  server.tool(
    'task_post',
    'Post a coordination message on a task thread. Use specific tools for claim / hand_off / accept.',
    {
      task_id: z.number().int().positive(),
      session_id: z.string().min(1),
      kind: z.enum(['question', 'answer', 'decision', 'blocker', 'note']),
      content: z.string().min(1),
      reply_to: z.number().int().positive().optional(),
    },
    async ({ task_id, session_id, kind, content, reply_to }) => {
      const thread = new TaskThread(store, task_id);
      const id = thread.post({
        session_id,
        kind,
        content,
        ...(reply_to !== undefined ? { reply_to } : {}),
      });
      return { content: [{ type: 'text', text: JSON.stringify({ id }) }] };
    },
  );

  server.tool(
    'task_claim_file',
    'Claim a file on a task thread so overlapping edits from other sessions surface a warning next turn.',
    {
      task_id: z.number().int().positive(),
      session_id: z.string().min(1),
      file_path: z.string().min(1),
      note: z.string().optional(),
    },
    async ({ task_id, session_id, file_path, note }) => {
      const thread = new TaskThread(store, task_id);
      const id = thread.claimFile({
        session_id,
        file_path,
        ...(note !== undefined ? { note } : {}),
      });
      return { content: [{ type: 'text', text: JSON.stringify({ observation_id: id }) }] };
    },
  );
}
