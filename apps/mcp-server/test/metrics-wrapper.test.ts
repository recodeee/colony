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
    const handler = wrap('failing', async (_args: Record<string, never>) => {
      throw new Error('boom');
    });
    await expect(handler({})).rejects.toThrow('boom');
    const agg = store.storage.aggregateMcpMetrics({ since: 0 });
    const row = agg.operations.find((r) => r.operation === 'failing');
    if (!row) throw new Error('expected failing row');
    expect(row.calls).toBe(1);
    expect(row.error_count).toBe(1);
    expect(row.output_tokens).toBe(0);
    expect(row.error_reasons[0]).toMatchObject({
      error_message: 'boom',
      count: 1,
    });
  });

  it('records ok=false and structured reason when a handler returns isError', async () => {
    const wrap = createMetricsWrapper(store);
    const handler = wrap('structured-error', async (_args: Record<string, never>) => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ code: 'TASK_NOT_FOUND', error: 'task 6 not found' }),
        },
      ],
      isError: true,
    }));
    const result = await handler({});
    expect(result.isError).toBe(true);
    const agg = store.storage.aggregateMcpMetrics({ since: 0 });
    const row = agg.operations.find((r) => r.operation === 'structured-error');
    if (!row) throw new Error('expected structured-error row');
    expect(row.calls).toBe(1);
    expect(row.error_count).toBe(1);
    expect(row.output_tokens).toBeGreaterThan(0);
    expect(row.error_reasons[0]).toMatchObject({
      error_code: 'TASK_NOT_FOUND',
      error_message: 'task 6 not found',
      count: 1,
    });
  });

  it('is a passthrough when no store is configured', async () => {
    const wrap = createMetricsWrapper(null);
    const handler = wrap('inert', async (_args: Record<string, never>) => 'ok');
    await expect(handler({})).resolves.toBe('ok');
  });

  it('does not break a tool call when the underlying recorder throws', async () => {
    const closed = new MemoryStore({
      dbPath: join(dir, 'closed.db'),
      settings: defaultSettings,
    });
    closed.close();
    const wrap = createMetricsWrapper(closed);
    const handler = wrap('search', async (_args: Record<string, never>) => 'still-ok');
    await expect(handler({})).resolves.toBe('still-ok');
  });

  it('attributes the explicit args.session_id when the tool carries one', async () => {
    const wrap = createMetricsWrapper(store);
    const handler = wrap(
      'task_ready_for_agent',
      async (_args: { session_id: string; agent: string }) => 'ok',
    );
    await handler({ session_id: 'explicit-session-1', agent: 'codex' });

    const agg = store.storage.aggregateMcpMetrics({ since: 0 });
    const sessions = agg.sessions.map((row) => row.session_id);
    expect(sessions).toContain('explicit-session-1');
    expect(sessions).not.toContain('<unknown>');
  });

  it('falls back to the MCP client identity when the tool schema has no session_id', async () => {
    // CODEX_SESSION_ID is the highest-confidence signal in
    // detectMcpClientIdentity. Setting it on process.env simulates a real
    // codex MCP client invoking a session-less tool like task_plan_list.
    const previous = process.env.CODEX_SESSION_ID;
    process.env.CODEX_SESSION_ID = 'codex-fallback-session';
    try {
      const wrap = createMetricsWrapper(store);
      const handler = wrap('task_plan_list', async (_args: { repo_root?: string }) => 'ok');
      // No session_id in args — old behaviour bucketed this as <unknown>.
      await handler({ repo_root: '/tmp/repo' });

      const agg = store.storage.aggregateMcpMetrics({ since: 0 });
      const sessions = agg.sessions.map((row) => row.session_id);
      expect(sessions).toContain('codex-fallback-session');
      expect(sessions).not.toContain('<unknown>');
    } finally {
      if (previous === undefined) delete process.env.CODEX_SESSION_ID;
      else process.env.CODEX_SESSION_ID = previous;
    }
  });

  it('falls back to a stable mcp-<ppid> bucket when no env signal is available', async () => {
    // Clear every env signal detectMcpClientIdentity reads so it can only
    // produce the parent-pid fallback. Two calls with no signal should land
    // in the SAME bucket (not <unknown>), which is what makes the savings
    // report attributable across a session even when nothing else is set.
    const restore: Record<string, string | undefined> = {
      CODEX_SESSION_ID: process.env.CODEX_SESSION_ID,
      CLAUDECODE_SESSION_ID: process.env.CLAUDECODE_SESSION_ID,
      CLAUDE_SESSION_ID: process.env.CLAUDE_SESSION_ID,
      COLONY_CLIENT_SESSION_ID: process.env.COLONY_CLIENT_SESSION_ID,
    };
    for (const k of Object.keys(restore)) delete process.env[k];
    try {
      const wrap = createMetricsWrapper(store);
      const handler = wrap('task_plan_list', async (_args: { repo_root?: string }) => 'ok');
      await handler({ repo_root: '/tmp/repo' });
      await handler({ repo_root: '/tmp/repo' });

      const agg = store.storage.aggregateMcpMetrics({ since: 0 });
      const fallback = agg.sessions.find((row) => row.session_id === `mcp-${process.ppid}`);
      expect(fallback?.calls).toBe(2);
      expect(agg.sessions.map((row) => row.session_id)).not.toContain('<unknown>');
    } finally {
      for (const [k, v] of Object.entries(restore)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
