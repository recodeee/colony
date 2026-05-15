import { classifyDrift } from '@colony/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { type ToolContext, defaultWrapHandler } from './context.js';

const DAY_MS = 24 * 60 * 60_000;

/**
 * Reports per-operation tokens-per-call drift across two non-overlapping
 * windows (recent vs baseline) using only the existing mcp_metrics table.
 * No schema change.
 *
 * Progressive disclosure: the response is the classified rows plus three
 * one-line summary arrays (new_tools, gone_tools, insufficient_data) — no
 * observation bodies, no per-call samples. Callers reach for
 * savings_report for the wider per-operation view.
 *
 * Lives in its own file (rather than tools/drift.ts which already owns
 * task_drift_check) so the file-edit-drift checker and the token-drift
 * detector keep separate module surfaces.
 */
export function register(server: McpServer, ctx: ToolContext): void {
  const wrapHandler = ctx.wrapHandler ?? defaultWrapHandler;
  const { store } = ctx;

  server.tool(
    'savings_drift_report',
    'Flag tools whose median tokens-per-call has drifted up or down over a recent window vs a baseline window. Pure read path over mcp_metrics; no schema change. Pass baseline_days/recent_days to scope the windows, min_calls to set the sample-size guard, and threshold/down_threshold to tune up/down sensitivity.',
    {
      baseline_days: z
        .number()
        .positive()
        .max(180)
        .optional()
        .describe('baseline window length in days; defaults to 14'),
      recent_days: z
        .number()
        .positive()
        .max(60)
        .optional()
        .describe('recent window length in days; defaults to 3'),
      min_calls: z
        .number()
        .int()
        .min(1)
        .max(10_000)
        .optional()
        .describe('minimum sample size per window before flagging drift; defaults to 20'),
      threshold: z
        .number()
        .positive()
        .optional()
        .describe('up-drift trigger ratio (recent_median / baseline_median); defaults to 1.25'),
      down_threshold: z
        .number()
        .positive()
        .optional()
        .describe('down-drift trigger ratio; defaults to 0.75'),
      operation: z
        .string()
        .min(1)
        .optional()
        .describe('filter rows by exact operation name (e.g. "search")'),
    },
    wrapHandler(
      'savings_drift_report',
      async ({
        baseline_days,
        recent_days,
        min_calls,
        threshold,
        down_threshold,
        operation,
      }) => {
        const baselineDays = baseline_days ?? 14;
        const recentDays = recent_days ?? 3;
        const minCalls = min_calls ?? 20;
        const up = threshold ?? 1.25;
        const down = down_threshold ?? 0.75;

        const now = Date.now();
        const recentSince = now - recentDays * DAY_MS;
        // 3-day gap mirrors the CLI: keeps day-of-week noise from bleeding
        // across windows.
        const baselineUntil = recentSince - 3 * DAY_MS;
        const baselineSince = baselineUntil - baselineDays * DAY_MS;
        const recentUntil = now;

        const allRows = store.storage.mcpTokenDriftPerOperation({
          baseline_since: baselineSince,
          baseline_until: baselineUntil,
          recent_since: recentSince,
          recent_until: recentUntil,
        });
        const filtered =
          operation !== undefined
            ? allRows.filter((row) => row.operation === operation)
            : allRows;

        const report = classifyDrift(filtered, {
          threshold: up,
          down_threshold: down,
          min_calls: minCalls,
        });

        const minTs = store.storage.mcpMetricsMinTs();
        const warning =
          minTs !== null && minTs > baselineSince
            ? 'baseline window starts before first recorded metric — drift detection needs more history before signals can be trusted'
            : null;

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                window: {
                  baseline_since: baselineSince,
                  baseline_until: baselineUntil,
                  recent_since: recentSince,
                  recent_until: recentUntil,
                },
                threshold: report.threshold,
                rows: report.rows,
                new_tools: report.new_tools,
                gone_tools: report.gone_tools,
                insufficient_data: report.insufficient_data,
                ...(warning !== null ? { warning } : {}),
              }),
            },
          ],
        };
      },
    ),
  );
}
