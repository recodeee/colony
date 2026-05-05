import { countTokens } from '@colony/compress';
import type { MemoryStore } from '@colony/core';
import type { ToolHandlerWrapper } from './context.js';

const TEXT_DECODER = new TextEncoder();

/**
 * Records per-call token receipts into `mcp_metrics` for every wrapped tool.
 * Composed before the heartbeat wrapper so async results (Promises) are
 * captured by `.then()` regardless of whether the inner handler is sync or
 * async. Errors in the recording path are swallowed — instrumentation must
 * never break a tool call.
 */
export function createMetricsWrapper(store: MemoryStore | null | undefined): ToolHandlerWrapper {
  if (!store) return (_name, handler) => handler;
  return (name, handler) => {
    return ((...handlerArgs) => {
      const start = Date.now();
      const inputBytes = byteLengthOf(handlerArgs[0]);
      const inputTokens = tokenCountOf(handlerArgs[0]);
      let result: unknown;
      try {
        result = handler(...handlerArgs);
      } catch (err) {
        recordSafe(store, {
          ts: start,
          operation: name,
          input_bytes: inputBytes,
          output_bytes: 0,
          input_tokens: inputTokens,
          output_tokens: 0,
          duration_ms: Date.now() - start,
          ok: false,
        });
        throw err;
      }
      if (isPromiseLike(result)) {
        return result.then(
          (resolved) => {
            recordSafe(store, {
              ts: start,
              operation: name,
              input_bytes: inputBytes,
              output_bytes: byteLengthOf(resolved),
              input_tokens: inputTokens,
              output_tokens: tokenCountOf(resolved),
              duration_ms: Date.now() - start,
              ok: true,
            });
            return resolved;
          },
          (err: unknown) => {
            recordSafe(store, {
              ts: start,
              operation: name,
              input_bytes: inputBytes,
              output_bytes: 0,
              input_tokens: inputTokens,
              output_tokens: 0,
              duration_ms: Date.now() - start,
              ok: false,
            });
            throw err;
          },
        ) as ReturnType<typeof handler>;
      }
      recordSafe(store, {
        ts: start,
        operation: name,
        input_bytes: inputBytes,
        output_bytes: byteLengthOf(result),
        input_tokens: inputTokens,
        output_tokens: tokenCountOf(result),
        duration_ms: Date.now() - start,
        ok: true,
      });
      return result as ReturnType<typeof handler>;
    }) as typeof handler;
  };
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return Boolean(value) && typeof (value as { then?: unknown }).then === 'function';
}

function serialize(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function byteLengthOf(value: unknown): number {
  const text = serialize(value);
  return text === '' ? 0 : TEXT_DECODER.encode(text).byteLength;
}

function tokenCountOf(value: unknown): number {
  const text = serialize(value);
  if (text === '') return 0;
  try {
    return countTokens(text);
  } catch {
    return 0;
  }
}

interface MetricRecord {
  ts: number;
  operation: string;
  input_bytes: number;
  output_bytes: number;
  input_tokens: number;
  output_tokens: number;
  duration_ms: number;
  ok: boolean;
}

function recordSafe(store: MemoryStore, metric: MetricRecord): void {
  try {
    store.storage.recordMcpMetric(metric);
  } catch {
    // Metrics are advisory; never break a tool call when sqlite is read-only,
    // closed, or the schema is older than this build.
  }
}
