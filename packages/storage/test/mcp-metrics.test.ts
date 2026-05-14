import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Storage } from '../src/index.js';

let dir: string;
let storage: Storage;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'colony-mcp-metrics-'));
  storage = new Storage(join(dir, 'test.db'));
});

afterEach(() => {
  storage.close();
  rmSync(dir, { recursive: true, force: true });
});

function record(
  storage: Storage,
  partial: Partial<{
    ts: number;
    operation: string;
    input_bytes: number;
    output_bytes: number;
    input_tokens: number;
    output_tokens: number;
    duration_ms: number;
    ok: boolean;
    error_code: string | null;
    error_message: string | null;
    session_id: string | null;
  }> = {},
): void {
  storage.recordMcpMetric({
    ts: partial.ts ?? 1_000,
    operation: partial.operation ?? 'search',
    input_bytes: partial.input_bytes ?? 100,
    output_bytes: partial.output_bytes ?? 200,
    input_tokens: partial.input_tokens ?? 25,
    output_tokens: partial.output_tokens ?? 50,
    duration_ms: partial.duration_ms ?? 5,
    ok: partial.ok ?? true,
    ...(partial.session_id !== undefined ? { session_id: partial.session_id } : {}),
    ...(partial.error_code !== undefined ? { error_code: partial.error_code } : {}),
    ...(partial.error_message !== undefined ? { error_message: partial.error_message } : {}),
  });
}

describe('mcp_metrics storage', () => {
  it('aggregates per-operation totals, averages, and error count', () => {
    record(storage, { operation: 'search', input_tokens: 10, output_tokens: 100, duration_ms: 4 });
    record(storage, { operation: 'search', input_tokens: 20, output_tokens: 200, duration_ms: 6 });
    record(storage, {
      operation: 'search',
      ok: false,
      error_code: 'TASK_NOT_FOUND',
      error_message: 'task 6 not found',
    });
    record(storage, { operation: 'timeline', input_tokens: 5, output_tokens: 50 });

    const agg = storage.aggregateMcpMetrics({
      since: 0,
      cost: { input_usd_per_1m_tokens: 1, output_usd_per_1m_tokens: 2 },
    });
    const search = agg.operations.find((row) => row.operation === 'search');
    if (!search) throw new Error('expected search row');
    expect(search.calls).toBe(3);
    expect(search.error_count).toBe(1);
    expect(search.error_reasons).toEqual([
      {
        error_code: 'TASK_NOT_FOUND',
        error_message: 'task 6 not found',
        count: 1,
        last_ts: 1_000,
      },
    ]);
    expect(search.success_tokens).toBe(110 + 220);
    expect(search.error_tokens).toBe(25 + 50);
    expect(search.avg_success_tokens).toBe(Math.round((110 + 220) / 2));
    expect(search.avg_error_tokens).toBe(25 + 50);
    expect(search.max_input_tokens).toBe(25);
    expect(search.max_output_tokens).toBe(200);
    expect(search.max_total_tokens).toBe(220);
    expect(search.max_duration_ms).toBe(6);
    expect(search.input_tokens).toBe(10 + 20 + 25);
    expect(search.output_tokens).toBe(100 + 200 + 50);
    expect(search.total_tokens).toBe(search.input_tokens + search.output_tokens);
    expect(search.input_cost_usd).toBeCloseTo(55 / 1_000_000, 12);
    expect(search.output_cost_usd).toBeCloseTo((350 / 1_000_000) * 2, 12);
    expect(search.total_cost_usd).toBeCloseTo(0.000755, 12);
    expect(search.avg_cost_usd).toBeCloseTo(0.000755 / 3, 12);
    expect(search.avg_output_tokens).toBe(Math.round((100 + 200 + 50) / 3));
    expect(search.avg_duration_ms).toBe(Math.round((4 + 6 + 5) / 3));
    expect(agg.cost_basis).toEqual({
      input_usd_per_1m_tokens: 1,
      output_usd_per_1m_tokens: 2,
      configured: true,
    });
    expect(agg.totals.calls).toBe(4);
    expect(agg.totals.total_cost_usd).toBeCloseTo(0.00086, 12);
    expect(agg.totals.error_reasons[0]).toMatchObject({
      error_code: 'TASK_NOT_FOUND',
      count: 1,
    });
    expect(agg.session_summary.session_count).toBe(1);
    expect(agg.session_summary.avg_total_tokens).toBe(agg.totals.total_tokens);
    expect(agg.sessions[0]).toMatchObject({
      session_id: '<unknown>',
      calls: 4,
      total_tokens: agg.totals.total_tokens,
    });
    expect(agg.operations).toHaveLength(2);
  });

  it('aggregates live receipts by session with a truncation flag', () => {
    record(storage, {
      session_id: 's1',
      operation: 'search',
      input_tokens: 10,
      output_tokens: 100,
    });
    record(storage, {
      session_id: 's1',
      operation: 'timeline',
      input_tokens: 20,
      output_tokens: 200,
    });
    record(storage, {
      session_id: 's2',
      operation: 'search',
      input_tokens: 5,
      output_tokens: 50,
    });

    const agg = storage.aggregateMcpMetrics({
      since: 0,
      sessionLimit: 1,
      cost: { input_usd_per_1m_tokens: 1, output_usd_per_1m_tokens: 2 },
    });

    expect(agg.session_summary.session_count).toBe(2);
    expect(agg.session_summary.sessions_truncated).toBe(true);
    expect(agg.session_summary.avg_calls).toBe(2);
    expect(agg.session_summary.avg_total_tokens).toBe(Math.round((110 + 220 + 55) / 2));
    expect(agg.sessions).toHaveLength(1);
    expect(agg.sessions[0]).toMatchObject({
      session_id: 's1',
      calls: 2,
      input_tokens: 30,
      output_tokens: 300,
      total_tokens: 330,
    });
    expect(agg.sessions[0]?.total_cost_usd).toBeCloseTo(0.00063, 12);
  });

  it('respects the since/until window', () => {
    record(storage, { ts: 100, operation: 'a' });
    record(storage, { ts: 500, operation: 'a' });
    record(storage, { ts: 900, operation: 'a' });

    const window = storage.aggregateMcpMetrics({ since: 200, until: 800 });
    const a = window.operations[0];
    if (!a) throw new Error('expected row');
    expect(a.calls).toBe(1);
    expect(window.totals.calls).toBe(1);
  });

  it('filters by operation name when requested', () => {
    record(storage, { operation: 'search' });
    record(storage, { operation: 'timeline' });
    const only = storage.aggregateMcpMetrics({ since: 0, operation: 'timeline' });
    expect(only.operations).toHaveLength(1);
    expect(only.operations[0]?.operation).toBe('timeline');
    expect(only.totals.calls).toBe(1);
  });

  it('returns zeroed totals on empty window without throwing', () => {
    const empty = storage.aggregateMcpMetrics({ since: 0 });
    expect(empty.totals.calls).toBe(0);
    expect(empty.totals.total_tokens).toBe(0);
    expect(empty.totals.success_tokens).toBe(0);
    expect(empty.totals.error_tokens).toBe(0);
    expect(empty.totals.max_total_tokens).toBe(0);
    expect(empty.totals.max_duration_ms).toBe(0);
    expect(empty.totals.total_cost_usd).toBe(0);
    expect(empty.totals.error_reasons).toEqual([]);
    expect(empty.cost_basis.configured).toBe(false);
    expect(empty.operations).toEqual([]);
  });

  it('groups error_reasons by code so per-error-row counts sum to error_count', () => {
    for (let i = 0; i < 25; i += 1) {
      record(storage, {
        ts: 1_000 + i,
        operation: 'task_plan_claim_subtask',
        ok: false,
        error_code: 'PLAN_SUBTASK_NOT_AVAILABLE',
        error_message: `sub-task is claimed by codex-session-${i}`,
      });
    }
    record(storage, {
      ts: 1_100,
      operation: 'task_plan_claim_subtask',
      ok: false,
      error_code: 'PLAN_SUBTASK_NOT_FOUND',
      error_message: 'no sub-task at spec/x/sub-0',
    });
    record(storage, {
      ts: 1_200,
      operation: 'task_plan_claim_subtask',
      ok: false,
      error_code: 'PLAN_SUBTASK_NOT_FOUND',
      error_message: 'no sub-task at spec/y/sub-1',
    });

    const agg = storage.aggregateMcpMetrics({ since: 0 });
    const claim = agg.operations.find((row) => row.operation === 'task_plan_claim_subtask');
    if (!claim) throw new Error('expected task_plan_claim_subtask row');
    expect(claim.error_count).toBe(27);
    const sum = claim.error_reasons.reduce((acc, r) => acc + r.count, 0);
    expect(sum).toBe(27);
    const codes = claim.error_reasons.map((r) => r.error_code).sort();
    expect(codes).toEqual(['PLAN_SUBTASK_NOT_AVAILABLE', 'PLAN_SUBTASK_NOT_FOUND']);
    const notAvailable = claim.error_reasons.find(
      (r) => r.error_code === 'PLAN_SUBTASK_NOT_AVAILABLE',
    );
    expect(notAvailable?.count).toBe(25);
    expect(notAvailable?.error_message).toContain('sub-task is claimed by codex-session-');
  });

  it('countMcpMetricsSince counts rows in the window', () => {
    record(storage, { ts: 100, operation: 'search' });
    record(storage, { ts: 500, operation: 'search' });
    record(storage, { ts: 1_500, operation: 'timeline' });
    record(storage, { ts: 2_000, operation: 'task_post' });

    expect(storage.countMcpMetricsSince(0, 3_000)).toBe(4);
    expect(storage.countMcpMetricsSince(1_000, 3_000)).toBe(2);
    expect(storage.countMcpMetricsSince(0, 400)).toBe(1);
    expect(storage.countMcpMetricsSince(5_000, 6_000)).toBe(0);
  });
});
