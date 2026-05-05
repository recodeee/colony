import { SAVINGS_REFERENCE_ROWS, savingsReferenceTotals } from '@colony/core';
import type { McpMetricsAggregateRow } from '@colony/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeGainReport, writeLiveSection, writeReferenceSection } from '../src/commands/gain.js';

const COST_BASIS = {
  input_usd_per_1m_tokens: 1,
  output_usd_per_1m_tokens: 2,
  configured: true,
};

describe('gain command output', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints expanded live metric columns', () => {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    });

    const row: McpMetricsAggregateRow = {
      operation: 'search',
      calls: 2,
      ok_count: 1,
      error_count: 1,
      error_reasons: [
        {
          error_code: 'TASK_NOT_FOUND',
          error_message: 'task 6 not found',
          count: 1,
          last_ts: Date.now(),
        },
      ],
      input_bytes: 100,
      output_bytes: 200,
      total_bytes: 300,
      input_tokens: 25,
      output_tokens: 50,
      total_tokens: 75,
      input_cost_usd: 0.000025,
      output_cost_usd: 0.0001,
      total_cost_usd: 0.000125,
      avg_cost_usd: 0.000063,
      avg_input_tokens: 13,
      avg_output_tokens: 25,
      total_duration_ms: 40,
      avg_duration_ms: 20,
      last_ts: Date.now(),
    };

    writeLiveSection([row], row, COST_BASIS, 24, undefined);

    expect(output).toContain('OK');
    expect(output).toContain('Tok total');
    expect(output).toContain('Cost');
    expect(output).toContain('$0.000125');
    expect(output).toContain('Bytes');
    expect(output).toContain('Avg in');
    expect(output).toContain('Avg out');
    expect(output).toContain('Last');
    expect(output).toContain('Top error reasons');
    expect(output).toContain('TASK_NOT_FOUND');
    expect(output).toContain('task 6 not found');
    expect(output).toContain('search');
    expect(output).toContain('75');
    expect(output).toContain('300');
  });

  it('prints live metrics before the reference model', () => {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    });

    const row: McpMetricsAggregateRow = {
      operation: 'search',
      calls: 1,
      ok_count: 1,
      error_count: 0,
      error_reasons: [],
      input_bytes: 100,
      output_bytes: 200,
      total_bytes: 300,
      input_tokens: 25,
      output_tokens: 50,
      total_tokens: 75,
      input_cost_usd: 0.000025,
      output_cost_usd: 0.0001,
      total_cost_usd: 0.000125,
      avg_cost_usd: 0.000125,
      avg_input_tokens: 25,
      avg_output_tokens: 50,
      total_duration_ms: 40,
      avg_duration_ms: 40,
      last_ts: Date.now(),
    };

    writeGainReport(
      [
        {
          operation: 'Recall prior decision',
          frequency_per_session: 5,
          baseline_tokens: 8000,
          colony_tokens: 1500,
          savings_pct: 81,
          rationale: 'search -> get_observations IDs vs re-reading PR threads + scrollback',
        },
      ],
      {
        baseline_tokens: 40_000,
        colony_tokens: 7500,
        savings_pct: 81,
      },
      [row],
      row,
      COST_BASIS,
      24,
      undefined,
    );

    expect(output.indexOf('colony gain — live mcp_metrics')).toBeLessThan(
      output.indexOf('colony gain — reference model (static)'),
    );
  });

  it('keeps reference output compact without the cut explainer', () => {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    });

    writeReferenceSection(
      [
        {
          operation: 'Recall prior decision',
          frequency_per_session: 5,
          baseline_tokens: 8000,
          colony_tokens: 1500,
          savings_pct: 81,
          rationale: 'search -> get_observations IDs vs re-reading PR threads + scrollback',
        },
      ],
      {
        baseline_tokens: 40_000,
        colony_tokens: 7500,
        savings_pct: 81,
      },
    );

    expect(output).toContain('colony gain — reference model (static)');
    expect(output).toContain('Static total / session');
    expect(output).not.toContain('What gets cut');
    expect(output).not.toContain('Colony:  search -> get_observations IDs');
    expect(output).not.toContain('Cuts:    re-reading PR threads + scrollback');
  });

  it('includes the expanded reference operation catalog', () => {
    const operations = SAVINGS_REFERENCE_ROWS.map((row) => row.operation);
    expect(operations).toEqual(
      expect.arrayContaining([
        'Unread message triage',
        'Claim-before-edit check',
        'Plan subtask claim',
        'Spec context recall',
        'Health/adoption diagnosis',
        'Examples pattern lookup',
      ]),
    );
    expect(SAVINGS_REFERENCE_ROWS.length).toBeGreaterThan(12);
    expect(savingsReferenceTotals().baseline_tokens).toBeGreaterThan(572_000);
  });
});
