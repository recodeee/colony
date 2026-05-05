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
  });
}

describe('mcp_metrics storage', () => {
  it('aggregates per-operation totals, averages, and error count', () => {
    record(storage, { operation: 'search', input_tokens: 10, output_tokens: 100, duration_ms: 4 });
    record(storage, { operation: 'search', input_tokens: 20, output_tokens: 200, duration_ms: 6 });
    record(storage, { operation: 'search', ok: false });
    record(storage, { operation: 'timeline', input_tokens: 5, output_tokens: 50 });

    const agg = storage.aggregateMcpMetrics({ since: 0 });
    const search = agg.operations.find((row) => row.operation === 'search');
    if (!search) throw new Error('expected search row');
    expect(search.calls).toBe(3);
    expect(search.error_count).toBe(1);
    expect(search.input_tokens).toBe(10 + 20 + 25);
    expect(search.output_tokens).toBe(100 + 200 + 50);
    expect(search.total_tokens).toBe(search.input_tokens + search.output_tokens);
    expect(search.avg_output_tokens).toBe(Math.round((100 + 200 + 50) / 3));
    expect(search.avg_duration_ms).toBe(Math.round((4 + 6 + 5) / 3));
    expect(agg.totals.calls).toBe(4);
    expect(agg.operations).toHaveLength(2);
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
    expect(empty.operations).toEqual([]);
  });
});
