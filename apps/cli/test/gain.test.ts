import type { McpMetricsAggregateRow } from '@colony/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeLiveSection } from '../src/commands/gain.js';

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
      input_bytes: 100,
      output_bytes: 200,
      total_bytes: 300,
      input_tokens: 25,
      output_tokens: 50,
      total_tokens: 75,
      avg_input_tokens: 13,
      avg_output_tokens: 25,
      total_duration_ms: 40,
      avg_duration_ms: 20,
      last_ts: Date.now(),
    };

    writeLiveSection([row], row, 24, undefined);

    expect(output).toContain('OK');
    expect(output).toContain('Tok total');
    expect(output).toContain('Bytes');
    expect(output).toContain('Avg in');
    expect(output).toContain('Avg out');
    expect(output).toContain('Last');
    expect(output).toContain('search');
    expect(output).toContain('75');
    expect(output).toContain('300');
  });
});
