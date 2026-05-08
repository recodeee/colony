import { describe, expect, it } from 'vitest';
import {
  SAVINGS_REFERENCE_ROWS,
  savingsLiveComparison,
  savingsLiveComparisonCost,
} from '../src/savings-reference.js';

describe('savings reference receipts', () => {
  it('estimates USD saved from matched live mcp_metrics costs', () => {
    const comparison = savingsLiveComparison(
      [
        {
          operation: 'search',
          calls: 2,
          total_tokens: 300,
          last_ts: 10,
        },
      ],
      [
        {
          operation: 'Search result shape',
          frequency_per_session: 1,
          baseline_tokens: 5000,
          colony_tokens: 150,
          savings_pct: 97,
          rationale: 'compact IDs + snippets',
          mcp_operations: ['search'],
        },
      ],
    );

    const cost = savingsLiveComparisonCost(comparison, [
      {
        operation: 'search',
        total_tokens: 300,
        total_cost_usd: 0.003,
      },
    ]);

    expect(cost.kind).toBe('estimated_live_window_usd');
    expect(cost.rows[0]).toMatchObject({
      operation: 'Search result shape',
      calls: 2,
      baseline_cost_usd: 0.1,
      colony_cost_usd: 0.003,
      saved_cost_usd: 0.097,
      matched_operations: ['search'],
    });
    expect(cost.totals).toMatchObject({
      calls: 2,
      baseline_cost_usd: 0.1,
      colony_cost_usd: 0.003,
      saved_cost_usd: 0.097,
    });
  });

  it('does not attribute structured-output savings_report calls to the at-rest compression row', () => {
    // Regression: the "Storage at rest (per observation)" row used to map to
    // ['savings_report'], which produced negative live savings because
    // savings_report emits ~3.5k tokens of structured JSON per call against a
    // 1k baseline. The row stays in the static reference (compression is real
    // for prose observations) but no live MCP operation should be mapped to
    // it.
    const storageAtRestRow = SAVINGS_REFERENCE_ROWS.find(
      (r) => r.operation === 'Storage at rest (per observation)',
    );
    expect(storageAtRestRow).toBeDefined();
    expect(storageAtRestRow?.mcp_operations).toEqual([]);

    const comparison = savingsLiveComparison([
      {
        operation: 'savings_report',
        calls: 2,
        total_tokens: 5100,
        last_ts: 1,
      },
    ]);
    expect(
      comparison.rows.find((r) => r.operation === 'Storage at rest (per observation)'),
    ).toBeUndefined();
    expect(
      comparison.unmatched_operations.find((u) => u.operation === 'savings_report'),
    ).toMatchObject({ operation: 'savings_report', calls: 2, colony_tokens: 5100 });
  });
});
