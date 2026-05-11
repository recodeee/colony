import type { AccountClaimRow, AccountClaimState } from '@colony/storage';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { type ToolContext, defaultWrapHandler } from './context.js';
import { mcpError } from './shared.js';

// Account claims: planner-side dispatch binding (which Codex account a wave is
// bound to). Keyed by (plan_slug, wave_id) so the binding exists before any
// Colony task is spawned and survives across the agents that pick the wave up.
// Lifecycle is intentionally simpler than task_claims — only `active` and
// `released` states. The storage layer enforces at-most-one active claim per
// wave via a partial unique index.

function jsonReply(payload: unknown): {
  content: Array<{ type: 'text'; text: string }>;
} {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function asPayload(row: AccountClaimRow): Record<string, unknown> {
  return {
    id: row.id,
    plan_slug: row.plan_slug,
    wave_id: row.wave_id,
    account_id: row.account_id,
    session_id: row.session_id,
    agent: row.agent,
    claimed_at: row.claimed_at,
    state: row.state,
    expires_at: row.expires_at,
    released_at: row.released_at,
    released_by_session_id: row.released_by_session_id,
    note: row.note,
  };
}

export function register(server: McpServer, ctx: ToolContext): void {
  const wrapHandler = ctx.wrapHandler ?? defaultWrapHandler;
  const { store } = ctx;

  server.tool(
    'task_claim_account',
    'Bind a Codex account to a planner wave so subsequent agents picking up that wave use the bound account. Returns the active claim row. If the wave already has an active claim with the same account_id and session_id the row is refreshed in place; otherwise the prior binding is released and a new active row is created.',
    {
      plan_slug: z.string().min(1),
      wave_id: z.string().min(1),
      account_id: z.string().min(1),
      session_id: z.string().min(1).optional(),
      agent: z.string().min(1).optional(),
      expires_at: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Epoch ms after which this binding is considered stale.'),
      note: z.string().optional(),
    },
    wrapHandler('task_claim_account', async (args) => {
      try {
        const row = store.storage.claimAccount({
          plan_slug: args.plan_slug,
          wave_id: args.wave_id,
          account_id: args.account_id,
          session_id: args.session_id ?? null,
          agent: args.agent ?? null,
          expires_at: args.expires_at ?? null,
          note: args.note ?? null,
        });
        return jsonReply({ claim: asPayload(row) });
      } catch (err) {
        return mcpError(err);
      }
    }),
  );

  server.tool(
    'task_release_account_claim',
    'Release an active account claim. Flips state to `released` and stamps released_at + released_by_session_id; the row is preserved as audit history. Returns the updated row, or { released: false } if the id was not found / already released.',
    {
      id: z.number().int().positive(),
      released_by_session_id: z.string().min(1).optional(),
    },
    wrapHandler('task_release_account_claim', async (args) => {
      try {
        const row = store.storage.releaseAccountClaim({
          id: args.id,
          released_by_session_id: args.released_by_session_id ?? null,
        });
        if (!row) return jsonReply({ released: false, id: args.id });
        return jsonReply({ released: row.state === 'released', claim: asPayload(row) });
      } catch (err) {
        return mcpError(err);
      }
    }),
  );

  server.tool(
    'task_list_account_claims',
    'List account claims, optionally filtered by plan_slug, account_id, or state. Default state filter is none — the result includes both active and released rows for audit visibility. Cap at limit (default 200).',
    {
      plan_slug: z.string().min(1).optional(),
      account_id: z.string().min(1).optional(),
      state: z.enum(['active', 'released']).optional(),
      limit: z.number().int().positive().max(500).optional(),
    },
    wrapHandler('task_list_account_claims', async (args) => {
      try {
        const opts: {
          plan_slug?: string;
          account_id?: string;
          state?: AccountClaimState;
          limit?: number;
        } = {};
        if (args.plan_slug !== undefined) opts.plan_slug = args.plan_slug;
        if (args.account_id !== undefined) opts.account_id = args.account_id;
        if (args.state !== undefined) opts.state = args.state;
        if (args.limit !== undefined) opts.limit = args.limit;
        const claims = store.storage.listAccountClaims(opts);
        return jsonReply({ claims: claims.map(asPayload) });
      } catch (err) {
        return mcpError(err);
      }
    }),
  );
}
