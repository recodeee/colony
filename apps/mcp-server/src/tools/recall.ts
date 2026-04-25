import { inferIdeFromSessionId } from '@colony/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from './context.js';

/**
 * `recall_session` lets an agent pull a compact timeline of a *different*
 * session (its own past or another agent's) and records the act of recalling
 * as a `kind:'recall'` observation in the calling session. The recall row is
 * what makes cross-session memory traceable: a future search across the
 * caller's session can find "I previously consulted session X" without ever
 * pasting X's bodies into the caller.
 *
 * Progressive disclosure: the return payload carries IDs + metadata only.
 * Callers fetch bodies via `get_observations(ids[])` exactly like `timeline`.
 *
 * Safety: both `target_session_id` and `current_session_id` are validated
 * against `storage.getSession()` before any write. `MemoryStore.addObservation`
 * routes through `ensureSession`, which silently materialises a missing
 * sessions row — that would let a typo create a phantom session and write a
 * recall observation into it. The early checks make the failure loud.
 */
export function register(server: McpServer, ctx: ToolContext): void {
  const { store } = ctx;

  server.tool(
    'recall_session',
    "Pull a compact timeline of a past session and audit the recall in the current session. Returns observation IDs only — fetch bodies via get_observations. The recall is itself stored as a kind:'recall' observation with metadata.recalled_session_id, metadata.owner_ide, and metadata.observation_ids so future searches surface that this session consulted the target. Use around_id to centre the window on a specific observation; limit caps how many IDs come back.",
    {
      target_session_id: z.string().min(1).describe('the session whose timeline you want to read'),
      current_session_id: z
        .string()
        .min(1)
        .describe('your session_id (where the recall observation gets written)'),
      around_id: z.number().int().positive().optional(),
      limit: z.number().int().positive().max(100).optional(),
    },
    async ({ target_session_id, current_session_id, around_id, limit }) => {
      const target = store.storage.getSession(target_session_id);
      if (!target) return sessionNotFound('target', target_session_id);
      const current = store.storage.getSession(current_session_id);
      if (!current) return sessionNotFound('current', current_session_id);

      const cap = limit ?? 20;
      // Storage.timeline filters by session_id but uses aroundId purely as a
      // numeric anchor — a foreign-session anchor won't bleed rows from the
      // wrong session, but it WILL silently slice the target's history at a
      // position the caller did not mean. Detect that case and return an
      // empty timeline instead of a misaligned slice. The recall observation
      // still gets written so the recall attempt remains auditable.
      let rows: ReturnType<typeof store.timeline>;
      if (around_id !== undefined) {
        const anchorRow = store.storage.getObservation(around_id);
        rows =
          !anchorRow || anchorRow.session_id !== target_session_id
            ? []
            : store.timeline(target_session_id, around_id, cap);
      } else {
        rows = store.timeline(target_session_id, undefined, cap);
      }
      const ownerIde =
        target.ide && target.ide !== 'unknown'
          ? target.ide
          : (inferIdeFromSessionId(target_session_id) ?? 'unknown');
      const observation_ids = rows.map((r) => r.id);

      const recall_observation_id = store.addObservation({
        session_id: current_session_id,
        kind: 'recall',
        content: `Recalled session ${target_session_id} (owner_ide=${ownerIde}, observations=${observation_ids.length}).`,
        metadata: {
          recalled_session_id: target_session_id,
          owner_ide: ownerIde,
          observation_ids,
          ...(around_id !== undefined ? { around_id } : {}),
          limit: cap,
        },
      });

      const payload = {
        recall_observation_id,
        session: {
          id: target.id,
          ide: ownerIde,
          cwd: target.cwd,
          started_at: target.started_at,
          ended_at: target.ended_at,
        },
        observations: rows.map((r) => ({ id: r.id, kind: r.kind, ts: r.ts })),
      };
      return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
    },
  );
}

function sessionNotFound(
  label: 'target' | 'current',
  id: string,
): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          code: 'SESSION_NOT_FOUND',
          error: `${label} session ${id} does not exist`,
        }),
      },
    ],
    isError: true,
  };
}
