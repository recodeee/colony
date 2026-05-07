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
    success_tokens: 120,
    error_tokens: 0,
    avg_success_tokens: 60,
    avg_error_tokens: 0,
    max_input_tokens: 20,
    max_output_tokens: 40,
    max_total_tokens: 60,
    max_duration_ms: 10,
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
    session_summary: {
      session_count: 1,
      sessions_truncated: false,
      avg_calls: 2,
      avg_input_tokens: 40,
      avg_output_tokens: 80,
      avg_total_tokens: 120,
      avg_total_cost_usd: 0.0002,
      last_ts: row.last_ts,
    },
    sessions: [
      {
        session_id: '019df99a-5f9c-7d72-a08a-3974dc51f880',
        calls: 2,
        ok_count: 2,
        error_count: 0,
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
        last_ts: row.last_ts,
      },
    ],
  };
}

describe('savings viewer', () => {
  it('renders live receipts before the live comparison model', () => {
    const page = renderSavingsPage({ live: aggregate(), windowHours: 24 });

    expect(page.indexOf('Live: mcp_metrics')).toBeLessThan(
      page.indexOf('Live comparison: standard vs. colony'),
    );
    expect(page).not.toContain('search -> get_observations IDs vs re-reading PR threads');
    expect(page).toContain('Live sessions');
    expect(page).toContain('avg/session 2 calls');
    expect(page).toContain('019df99a-');
    expect(page).toContain('Receipt value');
    expect(page).toContain('$0.0165 saved');
    expect(page).toContain('Colony spent $0.000200');
    expect(page).toContain('Standard estimate $0.0167');
    expect(page).toContain('Search result shape');
    expect(page).toContain('Live matched total');
    expect(page).not.toContain('Static total / session');
    expect(page).toContain('$0.000200');
  });
});
