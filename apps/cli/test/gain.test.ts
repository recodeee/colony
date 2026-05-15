import { SAVINGS_REFERENCE_ROWS, savingsLiveComparison, savingsReferenceTotals } from '@colony/core';
import type {
  McpMetricsAggregateRow,
  McpMetricsDailyRow,
  McpMetricsSessionAggregateRow,
  McpMetricsSessionSummary,
} from '@colony/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildMoversReport,
  fillDailyWindow,
  formatDurationMs,
  renderImpactBar,
  writeGainReport,
  writeLiveSection,
  writeMoversSection,
  writeReferenceSection,
  writeSummaryReport,
} from '../src/commands/gain.js';

// kleur emits ANSI escapes when stdout is detected as a color-capable TTY
// (e.g. `COLORTERM=truecolor`); on a plain CI runner it stays off. Strip
// escapes from captured output so assertions like `toContain('Calls: 2')`
// hold regardless of the local color mode.
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const stripAnsi = (chunk: string | Uint8Array): string => String(chunk).replace(ANSI_RE, '');

const COST_BASIS = {
  input_usd_per_1m_tokens: 1,
  output_usd_per_1m_tokens: 2,
  configured: true,
};

const SESSION_SUMMARY: McpMetricsSessionSummary = {
  session_count: 1,
  sessions_truncated: false,
  avg_calls: 2,
  avg_input_tokens: 25,
  avg_output_tokens: 50,
  avg_total_tokens: 75,
  avg_total_cost_usd: 0.000125,
  last_ts: Date.now(),
};

const SESSION_ROW: McpMetricsSessionAggregateRow = {
  session_id: '019df99a-5f9c-7d72-a08a-3974dc51f880',
  calls: 2,
  ok_count: 1,
  error_count: 1,
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

const METRIC_DETAIL = {
  success_tokens: 50,
  error_tokens: 25,
  avg_success_tokens: 50,
  avg_error_tokens: 25,
  max_input_tokens: 25,
  max_output_tokens: 50,
  max_total_tokens: 75,
  max_duration_ms: 40,
};

describe('gain command output', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints expanded live metric columns', () => {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      output += stripAnsi(chunk);
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
      ...METRIC_DETAIL,
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

    writeLiveSection([row], row, SESSION_SUMMARY, [SESSION_ROW], COST_BASIS, 24, undefined);

    expect(output).toContain('At a glance');
    expect(output).toContain('Calls: 2');
    expect(output).toContain('Errors: 1 (50%)');
    expect(output).toContain('Cost total: $0.000125');
    expect(output).toContain('Needs attention: 1x search TASK_NOT_FOUND - task 6 not found');
    expect(output).toContain('Top spend: search 75 tokens (100% of total) across 2 calls');
    expect(output).toContain('Operations');
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
    expect(output).toContain('Live sessions');
    expect(output).toContain('Sessions with receipts: 1');
    expect(output).toContain('019df99a-');
    expect(output).toContain('search');
    expect(output).toContain('75');
    expect(output).toContain('300');
  });

  it('prints operation detail metrics when filtered to one operation', () => {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      output += stripAnsi(chunk);
      return true;
    });

    const row: McpMetricsAggregateRow = {
      operation: 'task_claim_quota_release_expired',
      calls: 2,
      ok_count: 1,
      error_count: 1,
      error_reasons: [],
      ...METRIC_DETAIL,
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

    writeLiveSection(
      [row],
      row,
      SESSION_SUMMARY,
      [SESSION_ROW],
      COST_BASIS,
      168,
      'task_claim_quota_release_expired',
    );

    expect(output).toContain('Operation detail');
    expect(output).toContain('Success tokens: 50');
    expect(output).toContain('Error tokens: 25');
    expect(output).toContain('Avg success: 50');
    expect(output).toContain('Avg error: 25');
    expect(output).toContain('Max tokens: 75');
    expect(output).toContain('Max ms: 40');
  });

  it('prints the most frequent error reason in the overview', () => {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      output += stripAnsi(chunk);
      return true;
    });

    const baseRow: Omit<
      McpMetricsAggregateRow,
      'operation' | 'calls' | 'ok_count' | 'error_count' | 'error_reasons'
    > = {
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
      ...METRIC_DETAIL,
    };
    const searchRow: McpMetricsAggregateRow = {
      ...baseRow,
      operation: 'search',
      calls: 2,
      ok_count: 1,
      error_count: 1,
      error_reasons: [
        {
          error_code: 'SEARCH_FAILED',
          error_message: 'single search failure',
          count: 1,
          last_ts: Date.now() - 1000,
        },
      ],
    };
    const readyRow: McpMetricsAggregateRow = {
      ...baseRow,
      operation: 'task_ready_for_agent',
      calls: 4,
      ok_count: 1,
      error_count: 3,
      error_reasons: [
        {
          error_code: 'TASK_NOT_FOUND',
          error_message: 'task 6 not found',
          count: 3,
          last_ts: Date.now(),
        },
      ],
    };

    writeLiveSection(
      [searchRow, readyRow],
      readyRow,
      SESSION_SUMMARY,
      [SESSION_ROW],
      COST_BASIS,
      168,
      undefined,
    );

    expect(output).toContain(
      'Needs attention: 3x task_ready_for_agent TASK_NOT_FOUND - task 6 not found',
    );
  });

  it('flags a hot loop when one operation dominates token spend at high call volume', () => {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      output += stripAnsi(chunk);
      return true;
    });

    const dominantRow: McpMetricsAggregateRow = {
      operation: 'task_plan_list',
      calls: 7597,
      ok_count: 7597,
      error_count: 0,
      error_reasons: [],
      ...METRIC_DETAIL,
      input_bytes: 0,
      output_bytes: 0,
      total_bytes: 0,
      input_tokens: 92_800,
      output_tokens: 34_480_000,
      total_tokens: 34_580_000,
      input_cost_usd: 0,
      output_cost_usd: 0,
      total_cost_usd: 0,
      avg_cost_usd: 0,
      avg_input_tokens: 12,
      avg_output_tokens: 4_500,
      total_duration_ms: 7597 * 55,
      avg_duration_ms: 55,
      last_ts: Date.now(),
    };
    const totals: McpMetricsAggregateRow = {
      ...dominantRow,
      operation: '',
      total_tokens: 35_260_000,
      input_tokens: 171_500,
      output_tokens: 35_080_000,
    };

    writeLiveSection(
      [dominantRow],
      totals,
      SESSION_SUMMARY,
      [SESSION_ROW],
      { input_usd_per_1m_tokens: 0, output_usd_per_1m_tokens: 0, configured: false },
      168,
      undefined,
    );

    expect(output).toContain('Top spend: task_plan_list 34.58M tokens (98% of total)');
    expect(output).toContain('Hot loop:');
    expect(output).toContain('task_plan_list dominates token spend');
  });

  it('omits cost suffix from live sessions header when cost is not configured', () => {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      output += stripAnsi(chunk);
      return true;
    });

    const row: McpMetricsAggregateRow = {
      operation: 'search',
      calls: 1,
      ok_count: 1,
      error_count: 0,
      error_reasons: [],
      ...METRIC_DETAIL,
      input_bytes: 0,
      output_bytes: 0,
      total_bytes: 0,
      input_tokens: 25,
      output_tokens: 50,
      total_tokens: 75,
      input_cost_usd: 0,
      output_cost_usd: 0,
      total_cost_usd: 0,
      avg_cost_usd: 0,
      avg_input_tokens: 25,
      avg_output_tokens: 50,
      total_duration_ms: 40,
      avg_duration_ms: 40,
      last_ts: Date.now(),
    };

    writeLiveSection(
      [row],
      row,
      SESSION_SUMMARY,
      [SESSION_ROW],
      { input_usd_per_1m_tokens: 0, output_usd_per_1m_tokens: 0, configured: false },
      168,
      undefined,
    );

    expect(output).toContain('Sessions with receipts: 1');
    expect(output).not.toContain('tokens, -.');
  });

  it('prints live metrics before the live comparison model', () => {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      output += stripAnsi(chunk);
      return true;
    });

    const row: McpMetricsAggregateRow = {
      operation: 'search',
      calls: 1,
      ok_count: 1,
      error_count: 0,
      error_reasons: [],
      ...METRIC_DETAIL,
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
          operation: 'Search result shape',
          frequency_per_session: 5,
          baseline_tokens: 5000,
          colony_tokens: 150,
          savings_pct: 97,
          rationale: 'compact IDs + snippets vs inline full bodies',
          mcp_operations: ['search'],
        },
      ],
      {
        baseline_tokens: 40_000,
        colony_tokens: 7500,
        savings_pct: 81,
      },
      [row],
      row,
      SESSION_SUMMARY,
      [SESSION_ROW],
      COST_BASIS,
      24,
      undefined,
    );

    expect(output.indexOf('colony gain — live mcp_metrics')).toBeLessThan(
      output.indexOf('colony gain — live comparison model'),
    );
    expect(output).toContain('Search result shape');
    expect(output).toContain('Gain focus');
    expect(output).toContain('Coverage: 1 / 1 live calls (100%)');
    expect(output).toContain('Net: 4.9k saved');
    expect(output).toContain('Top saving: Search result shape 4.9k saved across 1 call');
    expect(output).toContain('Net USD: $0.008208 saved');
    expect(output).toContain('Colony spent: $0.000125');
    expect(output).toContain('Standard est: $0.008333');
    expect(output).toContain('Live matched total');
    expect(output).not.toContain('Static total / session');
  });

  it('keeps honest mode to live mcp_metrics receipts only', () => {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      output += stripAnsi(chunk);
      return true;
    });

    const row: McpMetricsAggregateRow = {
      operation: 'search',
      calls: 1,
      ok_count: 1,
      error_count: 0,
      error_reasons: [],
      ...METRIC_DETAIL,
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
          operation: 'Search result shape',
          frequency_per_session: 5,
          baseline_tokens: 5000,
          colony_tokens: 150,
          savings_pct: 97,
          rationale: 'compact IDs + snippets vs inline full bodies',
          mcp_operations: ['search'],
        },
      ],
      {
        baseline_tokens: 40_000,
        colony_tokens: 7500,
        savings_pct: 81,
      },
      [row],
      row,
      SESSION_SUMMARY,
      [SESSION_ROW],
      COST_BASIS,
      24,
      undefined,
      true,
      true,
    );

    expect(output).toContain('colony gain — live mcp_metrics');
    expect(output).toContain('Operations');
    expect(output).not.toContain('live comparison model');
    expect(output).not.toContain('Search result shape');
    expect(output).not.toContain('reference model');
    expect(output).not.toContain('USD saved');
  });

  it('keeps reference output compact without the cut explainer', () => {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      output += stripAnsi(chunk);
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
          mcp_operations: ['recall_session'],
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

  it('maps savings_report and task_list live calls into the comparison model', () => {
    const readySelection = SAVINGS_REFERENCE_ROWS.find(
      (row) => row.operation === 'Ready-work selection',
    );
    const healthDiagnosis = SAVINGS_REFERENCE_ROWS.find(
      (row) => row.operation === 'Health/adoption diagnosis',
    );

    expect(readySelection?.mcp_operations).toContain('task_list');
    expect(healthDiagnosis?.mcp_operations).toContain('savings_report');
  });
});

function moverFixture(
  overrides: Partial<McpMetricsAggregateRow> & { operation: string },
): McpMetricsAggregateRow {
  return {
    calls: 0,
    ok_count: 0,
    error_count: 0,
    error_reasons: [],
    success_tokens: 0,
    error_tokens: 0,
    avg_success_tokens: 0,
    avg_error_tokens: 0,
    max_input_tokens: 0,
    max_output_tokens: 0,
    max_total_tokens: 0,
    max_duration_ms: 0,
    input_bytes: 0,
    output_bytes: 0,
    total_bytes: 0,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    input_cost_usd: 0,
    output_cost_usd: 0,
    total_cost_usd: 0,
    avg_cost_usd: 0,
    avg_input_tokens: 0,
    avg_output_tokens: 0,
    total_duration_ms: 0,
    avg_duration_ms: 0,
    last_ts: null,
    ...overrides,
  };
}

describe('buildMoversReport', () => {
  it('flags a regression where recent rate is far above prior rate', () => {
    const report = buildMoversReport({
      full: [moverFixture({ operation: 'task_plan_list', calls: 7716, total_tokens: 34_930_000 })],
      recent: [
        moverFixture({ operation: 'task_plan_list', calls: 2400, total_tokens: 11_000_000 }),
      ],
      recentHours: 24,
      priorHours: 144,
      recentSince: 100_000_000,
      priorSince: 0,
    });

    expect(report.risers).toHaveLength(1);
    const row = report.risers[0];
    expect(row?.operation).toBe('task_plan_list');
    expect(row?.state).toBe('changed');
    expect(row?.recent_calls).toBe(2400);
    expect(row?.prior_calls).toBe(5316);
    expect(row?.calls_delta_pct).not.toBeNull();
    expect(row?.calls_delta_pct ?? 0).toBeGreaterThan(150);
  });

  it('classifies a new operation that only appears in the recent window', () => {
    const report = buildMoversReport({
      full: [moverFixture({ operation: 'new_op', calls: 40, total_tokens: 8000 })],
      recent: [moverFixture({ operation: 'new_op', calls: 40, total_tokens: 8000 })],
      recentHours: 12,
      priorHours: 156,
      recentSince: 100_000_000,
      priorSince: 0,
    });

    expect(report.risers).toHaveLength(1);
    expect(report.risers[0]?.state).toBe('new');
    expect(report.risers[0]?.prior_calls).toBe(0);
  });

  it('classifies a gone operation that only had prior activity', () => {
    const report = buildMoversReport({
      full: [moverFixture({ operation: 'old_op', calls: 80, total_tokens: 20_000 })],
      recent: [],
      recentHours: 24,
      priorHours: 144,
      recentSince: 100_000_000,
      priorSince: 0,
    });

    expect(report.fallers).toHaveLength(1);
    expect(report.fallers[0]?.state).toBe('gone');
    expect(report.fallers[0]?.recent_calls).toBe(0);
  });

  it('surfaces error risers separately when error count triples', () => {
    const report = buildMoversReport({
      full: [
        moverFixture({
          operation: 'task_note_working',
          calls: 28,
          error_count: 14,
        }),
      ],
      recent: [
        moverFixture({
          operation: 'task_note_working',
          calls: 12,
          error_count: 12,
        }),
      ],
      recentHours: 24,
      priorHours: 144,
      recentSince: 100_000_000,
      priorSince: 0,
    });

    expect(report.error_risers).toHaveLength(1);
    expect(report.error_risers[0]?.recent_errors).toBe(12);
    expect(report.error_risers[0]?.prior_errors).toBe(2);
  });

  it('filters out low-volume noise below the minimum call threshold', () => {
    const report = buildMoversReport({
      full: [moverFixture({ operation: 'tiny_op', calls: 4, total_tokens: 100 })],
      recent: [moverFixture({ operation: 'tiny_op', calls: 4, total_tokens: 100 })],
      recentHours: 24,
      priorHours: 144,
      recentSince: 100_000_000,
      priorSince: 0,
    });

    expect(report.risers).toHaveLength(0);
    expect(report.fallers).toHaveLength(0);
    expect(report.error_risers).toHaveLength(0);
  });
});

describe('writeMoversSection', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders Movers header with recent and prior labels plus a riser row', () => {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      output += stripAnsi(chunk);
      return true;
    });

    writeMoversSection({
      recent_hours: 24,
      prior_hours: 144,
      recent_since: 100_000_000,
      prior_since: 0,
      total_recent_calls: 2400,
      total_prior_calls: 5316,
      risers: [
        {
          operation: 'task_plan_list',
          recent_calls: 2400,
          prior_calls: 5316,
          recent_tokens: 11_000_000,
          prior_tokens: 23_930_000,
          recent_errors: 0,
          prior_errors: 0,
          recent_rate: 100,
          prior_rate: 36.9,
          calls_delta_pct: 170,
          tokens_delta_pct: 180,
          errors_delta_abs: 0,
          state: 'changed',
        },
      ],
      fallers: [],
      error_risers: [],
      skipped_reason: null,
    });

    expect(output).toContain('Movers');
    expect(output).toContain('(last 1d vs prior 6d)');
    expect(output).toContain('task_plan_list');
    expect(output).toContain('+170%');
    expect(output).toContain('+180%');
  });

  it('emits nothing when the report has no risers, fallers, or error risers', () => {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      output += stripAnsi(chunk);
      return true;
    });

    writeMoversSection({
      recent_hours: 24,
      prior_hours: 144,
      recent_since: 100_000_000,
      prior_since: 0,
      total_recent_calls: 10,
      total_prior_calls: 100,
      risers: [],
      fallers: [],
      error_risers: [],
      skipped_reason: null,
    });

    expect(output).toBe('');
  });
});

describe('rtk-style summary helpers', () => {
  it('renderImpactBar scales proportionally to max, full bar for the max row', () => {
    expect(renderImpactBar(100, 100, 10)).toBe('██████████');
    expect(renderImpactBar(50, 100, 10)).toBe('█████░░░░░');
    expect(renderImpactBar(0, 100, 10)).toBe('░░░░░░░░░░');
    expect(renderImpactBar(100, 0, 10)).toBe('░░░░░░░░░░');
    expect(renderImpactBar(200, 100, 10)).toBe('██████████');
    expect(renderImpactBar(-10, 100, 10)).toBe('░░░░░░░░░░');
  });

  it('formatDurationMs picks ms / fractional seconds / mm:ss / h:mm', () => {
    expect(formatDurationMs(0)).toBe('0ms');
    expect(formatDurationMs(120)).toBe('120ms');
    expect(formatDurationMs(999)).toBe('999ms');
    expect(formatDurationMs(3_400)).toBe('3.4s');
    expect(formatDurationMs(12_000)).toBe('12s');
    expect(formatDurationMs(125_000)).toBe('2m05s');
    expect(formatDurationMs(3_725_000)).toBe('1h02m');
  });

  it('fillDailyWindow pads missing days with zeros, oldest first', () => {
    const reference = new Date(Date.UTC(2026, 4, 15)); // 2026-05-15
    const rows: McpMetricsDailyRow[] = [
      {
        day: '2026-05-14',
        calls: 5,
        input_tokens: 10,
        output_tokens: 90,
        total_tokens: 100,
        total_duration_ms: 1_200,
      },
      {
        day: '2026-05-12',
        calls: 2,
        input_tokens: 5,
        output_tokens: 45,
        total_tokens: 50,
        total_duration_ms: 400,
      },
    ];

    const window = fillDailyWindow(rows, 5, reference);
    expect(window.map((r) => r.day)).toEqual([
      '2026-05-11',
      '2026-05-12',
      '2026-05-13',
      '2026-05-14',
      '2026-05-15',
    ]);
    expect(window[0]?.calls).toBe(0);
    expect(window[1]?.calls).toBe(2);
    expect(window[2]?.calls).toBe(0);
    expect(window[3]?.calls).toBe(5);
    expect(window[3]?.total_tokens).toBe(100);
    expect(window[4]?.calls).toBe(0);
  });

  it('writeSummaryReport prints headline + by-op + graph + breakdown', () => {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      output += stripAnsi(chunk);
      return true;
    });

    const baseRow: Omit<McpMetricsAggregateRow, 'operation' | 'calls' | 'last_ts'> = {
      ok_count: 0,
      error_count: 0,
      error_reasons: [],
      success_tokens: 0,
      error_tokens: 0,
      avg_success_tokens: 0,
      avg_error_tokens: 0,
      max_input_tokens: 0,
      max_output_tokens: 0,
      max_total_tokens: 0,
      max_duration_ms: 0,
      input_bytes: 0,
      output_bytes: 0,
      total_bytes: 0,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      input_cost_usd: 0,
      output_cost_usd: 0,
      total_cost_usd: 0,
      avg_cost_usd: 0,
      avg_input_tokens: 0,
      avg_output_tokens: 0,
      total_duration_ms: 0,
      avg_duration_ms: 0,
    };
    const recentTs = Date.now() - 5 * 60_000;
    const operations: McpMetricsAggregateRow[] = [
      {
        ...baseRow,
        operation: 'search',
        calls: 4,
        ok_count: 4,
        input_tokens: 80,
        output_tokens: 400,
        total_tokens: 480,
        avg_input_tokens: 20,
        avg_output_tokens: 100,
        total_duration_ms: 800,
        avg_duration_ms: 200,
        last_ts: recentTs,
      },
      {
        ...baseRow,
        operation: 'task_post',
        calls: 2,
        ok_count: 2,
        input_tokens: 60,
        output_tokens: 60,
        total_tokens: 120,
        avg_input_tokens: 30,
        avg_output_tokens: 30,
        total_duration_ms: 400,
        avg_duration_ms: 200,
        last_ts: recentTs,
      },
    ];
    const totals: McpMetricsAggregateRow = {
      ...baseRow,
      operation: '__total__',
      calls: 6,
      ok_count: 6,
      input_tokens: 140,
      output_tokens: 460,
      total_tokens: 600,
      total_duration_ms: 1_200,
      avg_duration_ms: 200,
      last_ts: recentTs,
    };
    const daily: McpMetricsDailyRow[] = [
      {
        day: '2026-05-14',
        calls: 6,
        input_tokens: 140,
        output_tokens: 460,
        total_tokens: 600,
        total_duration_ms: 1_200,
      },
    ];
    const comparison = savingsLiveComparison(operations, SAVINGS_REFERENCE_ROWS);

    writeSummaryReport({
      operations,
      totals,
      daily,
      comparison,
      windowHours: 24,
      operationFilter: undefined,
      days: 3,
      topOps: 10,
      showGraph: true,
      showBreakdown: true,
      showHeadline: true,
    });

    expect(output).toContain('Colony Token Savings (last 1d)');
    expect(output).toContain('Total calls:');
    expect(output).toContain('6');
    expect(output).toContain('Input tokens:');
    expect(output).toContain('Output tokens:');
    expect(output).toContain('Total exec time:');
    expect(output).toContain('Efficiency meter:');
    expect(output).toContain('By Operation');
    expect(output).toContain('search');
    expect(output).toContain('Daily Activity (last 3 days)');
    expect(output).toContain('Daily Breakdown');
    expect(output).toContain('TOTAL');
  });

  it('writeSummaryReport graph-only mode skips headline and breakdown', () => {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      output += stripAnsi(chunk);
      return true;
    });

    const totals: McpMetricsAggregateRow = {
      operation: '__total__',
      calls: 0,
      ok_count: 0,
      error_count: 0,
      error_reasons: [],
      success_tokens: 0,
      error_tokens: 0,
      avg_success_tokens: 0,
      avg_error_tokens: 0,
      max_input_tokens: 0,
      max_output_tokens: 0,
      max_total_tokens: 0,
      max_duration_ms: 0,
      input_bytes: 0,
      output_bytes: 0,
      total_bytes: 0,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      input_cost_usd: 0,
      output_cost_usd: 0,
      total_cost_usd: 0,
      avg_cost_usd: 0,
      avg_input_tokens: 0,
      avg_output_tokens: 0,
      total_duration_ms: 0,
      avg_duration_ms: 0,
      last_ts: null,
    };

    writeSummaryReport({
      operations: [],
      totals,
      daily: [],
      comparison: savingsLiveComparison([], SAVINGS_REFERENCE_ROWS),
      windowHours: 168,
      operationFilter: undefined,
      days: 2,
      topOps: 10,
      showGraph: true,
      showBreakdown: false,
      showHeadline: false,
    });

    expect(output).not.toContain('Colony Token Savings');
    expect(output).toContain('Daily Activity (last 2 days)');
    expect(output).not.toContain('Daily Breakdown');
  });

  it('writeSummaryReport empty-window message when no calls', () => {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      output += stripAnsi(chunk);
      return true;
    });

    const totals: McpMetricsAggregateRow = {
      operation: '__total__',
      calls: 0,
      ok_count: 0,
      error_count: 0,
      error_reasons: [],
      success_tokens: 0,
      error_tokens: 0,
      avg_success_tokens: 0,
      avg_error_tokens: 0,
      max_input_tokens: 0,
      max_output_tokens: 0,
      max_total_tokens: 0,
      max_duration_ms: 0,
      input_bytes: 0,
      output_bytes: 0,
      total_bytes: 0,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      input_cost_usd: 0,
      output_cost_usd: 0,
      total_cost_usd: 0,
      avg_cost_usd: 0,
      avg_input_tokens: 0,
      avg_output_tokens: 0,
      total_duration_ms: 0,
      avg_duration_ms: 0,
      last_ts: null,
    };

    writeSummaryReport({
      operations: [],
      totals,
      daily: [],
      comparison: savingsLiveComparison([], SAVINGS_REFERENCE_ROWS),
      windowHours: 24,
      operationFilter: undefined,
      days: 7,
      topOps: 10,
      showGraph: true,
      showBreakdown: true,
      showHeadline: true,
    });

    expect(output).toContain('No mcp_metrics receipts in window');
  });
});
