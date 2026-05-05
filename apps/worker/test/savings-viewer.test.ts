import type { McpMetricsAggregate } from '@colony/storage';
import { describe, expect, it } from 'vitest';
import { renderSavingsPage } from '../src/viewer/sections/savings.js';

function aggregate(): McpMetricsAggregate {
  const row = {
    operation: 'search',
    calls: 2,
    ok_count: 2,
    error_count: 0,
    input_bytes: 100,
    output_bytes: 200,
    total_bytes: 300,
    input_tokens: 40,
    output_tokens: 80,
    total_tokens: 120,
    avg_input_tokens: 20,
    avg_output_tokens: 40,
    total_duration_ms: 20,
    avg_duration_ms: 10,
    last_ts: Date.now(),
  };
  return {
    since: 0,
    until: Date.now(),
    totals: row,
    operations: [row],
  };
}

describe('savings viewer', () => {
  it('renders live receipts before the compact reference model', () => {
    const page = renderSavingsPage({ live: aggregate(), windowHours: 24 });

    expect(page.indexOf('Live: mcp_metrics')).toBeLessThan(
      page.indexOf('Reference model: standard vs. colony'),
    );
    expect(page).not.toContain('search -> get_observations IDs vs re-reading PR threads');
    expect(page).toContain('Unread message triage');
  });
});
