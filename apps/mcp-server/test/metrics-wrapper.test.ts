import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { MemoryStore } from '@colony/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMetricsWrapper } from '../src/tools/metrics-wrapper.js';

let dir: string;
let store: MemoryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'colony-metrics-wrapper-'));
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('metrics wrapper', () => {
  it('records input/output bytes + tokens and duration_ms for async handlers', async () => {
    const wrap = createMetricsWrapper(store);
    const handler = wrap('search', async (args: { query: string }) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { content: [{ type: 'text', text: `hits for ${args.query}` }] };
    });
    const result = await handler({ query: 'colony' });
    expect(result.content[0]?.text).toContain('colony');

    const agg = store.storage.aggregateMcpMetrics({ since: 0 });
    const row = agg.operations.find((r) => r.operation === 'search');
    if (!row) throw new Error('expected search row');
    expect(row.calls).toBe(1);
    expect(row.error_count).toBe(0);
    expect(row.input_bytes).toBeGreaterThan(0);
    expect(row.output_bytes).toBeGreaterThan(0);
    expect(row.input_tokens).toBeGreaterThan(0);
    expect(row.output_tokens).toBeGreaterThan(0);
    expect(row.total_duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('records ok=false when an async handler throws and re-throws the error', async () => {
    const wrap = createMetricsWrapper(store);
    const handler = wrap('failing', async () => {
      throw new Error('boom');
    });
    await expect(handler({})).rejects.toThrow('boom');
    const agg = store.storage.aggregateMcpMetrics({ since: 0 });
    const row = agg.operations.find((r) => r.operation === 'failing');
    if (!row) throw new Error('expected failing row');
    expect(row.calls).toBe(1);
    expect(row.error_count).toBe(1);
    expect(row.output_tokens).toBe(0);
  });

  it('is a passthrough when no store is configured', async () => {
    const wrap = createMetricsWrapper(null);
    const handler = wrap('inert', async () => 'ok');
    await expect(handler({})).resolves.toBe('ok');
  });

  it('does not break a tool call when the underlying recorder throws', async () => {
    const closed = new MemoryStore({
      dbPath: join(dir, 'closed.db'),
      settings: defaultSettings,
    });
    closed.close();
    const wrap = createMetricsWrapper(closed);
    const handler = wrap('search', async () => 'still-ok');
    await expect(handler({})).resolves.toBe('still-ok');
  });
});
