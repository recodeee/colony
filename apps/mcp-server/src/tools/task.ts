import { TaskThread } from '@colony/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from './context.js';

const RELAY_FALLBACK_POST_RULE = [
  'Fallback when task_relay is unavailable in your client tool surface: post a note or blocker containing reason, one_line, base_branch, fetch_files_at if known, touched files, and whether the named source branch/worktree is missing.',
  'After that, use task_hand_off when another agent must resume the work.',
].join(' ');

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
    [
      'Post a coordination message on a task thread. Use specific tools for claim / hand_off / accept.',
      RELAY_FALLBACK_POST_RULE,
    ].join(' '),
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

  // --- task links ---
  // Cross-task edges. Linking two tasks lets each side see the other's
  // timeline + decisions in their own preface, without copy-paste. The
  // storage layer stores one row per unordered pair; the MCP surface is
  // symmetric so callers don't need to think about ordering.

  server.tool(
    'task_link',
    'Link two tasks bidirectionally so each side sees the other in attention prefaces. Idempotent.',
    {
      task_id: z.number().int().positive(),
      other_task_id: z.number().int().positive(),
      session_id: z.string().min(1),
      note: z.string().max(280).optional(),
    },
    async ({ task_id, other_task_id, session_id, note }) => {
      if (task_id === other_task_id) {
        return {
          content: [
            { type: 'text', text: JSON.stringify({ error: 'cannot link a task to itself' }) },
          ],
          isError: true,
        };
      }
      const thread = new TaskThread(store, task_id);
      const link = thread.link(other_task_id, session_id, note);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              low_id: link.low_id,
              high_id: link.high_id,
              created_at: link.created_at,
              created_by: link.created_by,
              note: link.note,
            }),
          },
        ],
      };
    },
  );

  server.tool(
    'task_unlink',
    'Drop the bidirectional link between two tasks. Returns { removed: boolean }.',
    {
      task_id: z.number().int().positive(),
      other_task_id: z.number().int().positive(),
    },
    async ({ task_id, other_task_id }) => {
      const thread = new TaskThread(store, task_id);
      const removed = thread.unlink(other_task_id);
      return { content: [{ type: 'text', text: JSON.stringify({ removed }) }] };
    },
  );

  server.tool(
    'task_links',
    'List tasks linked to a task. Returns the other side of each edge with link metadata.',
    { task_id: z.number().int().positive() },
    async ({ task_id }) => {
      const thread = new TaskThread(store, task_id);
      const links = thread.linkedTasks();
      return { content: [{ type: 'text', text: JSON.stringify(links) }] };
    },
  );
}
