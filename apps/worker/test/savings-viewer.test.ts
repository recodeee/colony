import type { McpMetricsAggregate } from '@colony/storage';
import { describe, expect, it } from 'vitest';
import { renderSavingsPage } from '../src/viewer/sections/savings.js';

function aggregate(): McpMetricsAggregate {
  const row = {
    operation: 'search',
    calls: 2,
    ok_count: 2,
    error_count: 0,
    error_reasons: [],
    input_bytes: 100,
    output_bytes: 200,
    total_bytes: 300,
    input_tokens: 40,
    output_tokens: 80,
    total_tokens: 120,
    input_cost_usd: 0.00004,
    output_cost_usd: 0.00016,
    total_cost_usd: 0.0002,
    avg_cost_usd: 0.0001,
    avg_input_tokens: 20,
    avg_output_tokens: 40,
    total_duration_ms: 20,
    avg_duration_ms: 10,
    last_ts: Date.now(),
  };
  return {
    since: 0,
    until: Date.now(),
    cost_basis: {
      input_usd_per_1m_tokens: 1,
      output_usd_per_1m_tokens: 2,
      configured: true,
    },
    totals: row,
    operations: [row],
  };
}

describe('savings viewer', () => {
  it('renders live receipts before the compact reference model', () => {
    const page = renderSavingsPage({ live: aggregate(), windowHours: 24 });

    expect(page.indexOf('Live: mcp_metrics')).toBeLessThan(
      page.indexOf('Reference model: standard vs. colony (static)'),
    );
    expect(page).not.toContain('search -> get_observations IDs vs re-reading PR threads');
    expect(page).toContain('Unread message triage');
    expect(page).toContain('Static total / session');
    expect(page).toContain('$0.000200');
  });
});
