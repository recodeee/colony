import { describe, expect, it } from 'vitest';
import { savingsLiveComparison, savingsLiveComparisonCost } from '../src/savings-reference.js';

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
});
