import { SAVINGS_REFERENCE_ROWS, savingsReferenceTotals } from '@colony/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { type ToolContext, defaultWrapHandler } from './context.js';

const DEFAULT_WINDOW_HOURS = 24;
const HOUR_MS = 60 * 60_000;

/**
 * Reports both static reference savings and live per-operation token usage
 * recorded by the metrics wrapper. Two sections by design — the reference
 * rows are illustrative estimates ("what colony saves vs the standard loop"),
 * the live rows are actual mcp_metrics receipts ("what your agents really
 * spent through colony"). Mixing them produces a misleading comparison.
 *
 * Progressive disclosure: the response is compact — counts, totals, and
 * per-op rows. No observation bodies, no event timelines.
 */
export function register(server: McpServer, ctx: ToolContext): void {
  const wrapHandler = ctx.wrapHandler ?? defaultWrapHandler;
  const { store } = ctx;

  server.tool(
    'savings_report',
    'Report colony token savings: static reference rows for common dev-loop operations and live per-operation token usage from mcp_metrics over a window. Pass since_ms or hours to scope the live window; default is 24h. Pass operation to filter live rows to one tool name.',
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
    },
    wrapHandler('savings_report', async ({ since_ms, hours, operation }) => {
      const now = Date.now();
      const windowHours = hours ?? DEFAULT_WINDOW_HOURS;
      const since = since_ms ?? now - windowHours * HOUR_MS;
      const live = store.storage.aggregateMcpMetrics({
        since,
        until: now,
        ...(operation !== undefined ? { operation } : {}),
      });
      const totals = savingsReferenceTotals();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              reference: {
                note: 'Hand-authored estimates of token cost per operation, with vs. without colony. Source: packages/core/src/savings-reference.ts.',
                rows: SAVINGS_REFERENCE_ROWS,
                totals,
              },
              live: {
                note: 'Recorded mcp_metrics receipts for the requested window. input_tokens / output_tokens come from @colony/compress#countTokens — same primitive as observation token receipts.',
                window: { since: live.since, until: live.until, hours: windowHours },
                ...(operation !== undefined ? { operation } : {}),
                totals: live.totals,
                operations: live.operations,
              },
            }),
          },
        ],
      };
    }),
  );
}
