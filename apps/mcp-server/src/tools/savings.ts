import { SAVINGS_REFERENCE_ROWS, savingsReferenceTotals } from '@colony/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { type ToolContext, defaultWrapHandler } from './context.js';

const DEFAULT_WINDOW_HOURS = 24;
const HOUR_MS = 60 * 60_000;

/**
 * Reports live per-operation token usage recorded by the metrics wrapper plus
 * reference savings rows for common coordination loops. Two sections by design:
 * live rows are actual mcp_metrics receipts, while reference rows remain an
 * illustrative comparison model.
 *
 * Progressive disclosure: the response is compact — counts, totals, and
 * per-op rows. No observation bodies, no event timelines.
 */
export function register(server: McpServer, ctx: ToolContext): void {
  const wrapHandler = ctx.wrapHandler ?? defaultWrapHandler;
  const { store } = ctx;

  server.tool(
    'savings_report',
    'Report colony token savings: live per-operation mcp_metrics usage/cost plus reference rows for common dev-loop operations. Pass since_ms or hours to scope the live window; default is 24h. Pass operation to filter live rows to one tool name. Pass input/output USD-per-1M rates or set COLONY_MCP_* env vars to estimate monetary cost.',
    {
      since_ms: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('absolute epoch-ms cutoff; takes precedence over hours'),
      hours: z
        .number()
        .positive()
        .max(24 * 30)
        .optional()
        .describe('relative window in hours; defaults to 24'),
      operation: z
        .string()
        .min(1)
        .optional()
        .describe('filter live rows by exact operation name (e.g. "search")'),
      session_limit: z
        .number()
        .int()
        .min(0)
        .max(100)
        .optional()
        .describe('number of live sessions to return; default 12, 0 returns all sessions'),
      input_usd_per_1m: z
        .number()
        .nonnegative()
        .optional()
        .describe(
          'USD price per 1M input tokens; falls back to COLONY_MCP_INPUT_USD_PER_1M when omitted',
        ),
      output_usd_per_1m: z
        .number()
        .nonnegative()
        .optional()
        .describe(
          'USD price per 1M output tokens; falls back to COLONY_MCP_OUTPUT_USD_PER_1M when omitted',
        ),
    },
    wrapHandler(
      'savings_report',
      async ({
        since_ms,
        hours,
        operation,
        session_limit,
        input_usd_per_1m,
        output_usd_per_1m,
      }) => {
        const now = Date.now();
        const windowHours = hours ?? DEFAULT_WINDOW_HOURS;
        const since = since_ms ?? now - windowHours * HOUR_MS;
        const inputRate = parseCostRate(input_usd_per_1m, process.env.COLONY_MCP_INPUT_USD_PER_1M);
        const outputRate = parseCostRate(
          output_usd_per_1m,
          process.env.COLONY_MCP_OUTPUT_USD_PER_1M,
        );
        const live = store.storage.aggregateMcpMetrics({
          since,
          until: now,
          ...(operation !== undefined ? { operation } : {}),
          ...(session_limit !== undefined ? { sessionLimit: session_limit } : {}),
          cost: {
            ...(inputRate !== undefined ? { input_usd_per_1m_tokens: inputRate } : {}),
            ...(outputRate !== undefined ? { output_usd_per_1m_tokens: outputRate } : {}),
          },
        });
        const totals = savingsReferenceTotals();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                live: {
                  note: 'Recorded mcp_metrics receipts for the requested window. input_tokens / output_tokens come from @colony/compress#countTokens; error_reasons are populated for new thrown/isError calls.',
                  window: { since: live.since, until: live.until, hours: windowHours },
                  ...(operation !== undefined ? { operation } : {}),
                  cost_basis: live.cost_basis,
                  totals: live.totals,
                  operations: live.operations,
                  session_summary: live.session_summary,
                  sessions: live.sessions,
                },
                reference: {
                  kind: 'static_per_session_model',
                  note: 'Static estimated per-session token cost for common coordination loops, with vs. without colony. This total is not derived from the live mcp_metrics window. Source: packages/core/src/savings-reference.ts.',
                  rows: SAVINGS_REFERENCE_ROWS,
                  totals,
                },
              }),
            },
          ],
        };
      },
    ),
  );
}

function parseCostRate(
  value: number | undefined,
  fallback: string | undefined,
): number | undefined {
  if (value !== undefined) return Number.isFinite(value) && value >= 0 ? value : undefined;
  if (fallback === undefined || fallback.trim() === '') return undefined;
  const parsed = Number(fallback);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}
