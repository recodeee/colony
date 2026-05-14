import { countTokens } from '@colony/compress';
import type { MemoryStore } from '@colony/core';
import type { ToolHandlerWrapper } from './context.js';
import { detectMcpClientIdentity } from './heartbeat.js';

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
      const context = metricContextOf(handlerArgs[0]);
      let result: unknown;
      try {
        result = handler(...handlerArgs);
      } catch (err) {
        recordSafe(store, {
          ts: start,
          operation: name,
          ...context,
          input_bytes: inputBytes,
          output_bytes: 0,
          input_tokens: inputTokens,
          output_tokens: 0,
          duration_ms: Date.now() - start,
          ok: false,
          ...errorMetricOf(err),
        });
        throw err;
      }
      if (isPromiseLike(result)) {
        return result.then(
          (resolved) => {
            const responseError = responseErrorMetricOf(resolved);
            recordSafe(store, {
              ts: start,
              operation: name,
              ...context,
              input_bytes: inputBytes,
              output_bytes: byteLengthOf(resolved),
              input_tokens: inputTokens,
              output_tokens: tokenCountOf(resolved),
              duration_ms: Date.now() - start,
              ok: responseError === null,
              ...(responseError ?? {}),
            });
            return resolved;
          },
          (err: unknown) => {
            recordSafe(store, {
              ts: start,
              operation: name,
              ...context,
              input_bytes: inputBytes,
              output_bytes: 0,
              input_tokens: inputTokens,
              output_tokens: 0,
              duration_ms: Date.now() - start,
              ok: false,
              ...errorMetricOf(err),
            });
            throw err;
          },
        ) as ReturnType<typeof handler>;
      }
      const responseError = responseErrorMetricOf(result);
      recordSafe(store, {
        ts: start,
        operation: name,
        ...context,
        input_bytes: inputBytes,
        output_bytes: byteLengthOf(result),
        input_tokens: inputTokens,
        output_tokens: tokenCountOf(result),
        duration_ms: Date.now() - start,
        ok: responseError === null,
        ...(responseError ?? {}),
      });
      return result as ReturnType<typeof handler>;
    }) as typeof handler;
  };
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return Boolean(value) && typeof (value as { then?: unknown }).then === 'function';
}

function metricContextOf(value: unknown): Pick<MetricRecord, 'session_id' | 'repo_root'> {
  const record = isRecord(value) ? value : undefined;
  const sessionFromArgs = record
    ? (stringField(record.session_id) ?? stringField(record.current_session_id))
    : undefined;
  // High-volume read-only tools (task_plan_list, get_observations, search,
  // task_timeline, list_sessions, examples_list, …) carry no session_id in
  // their schema, which used to land every call in the `<unknown>` bucket of
  // the savings report — masking ~9k calls/day in 2026-05-14 telemetry. Fall
  // back to the same detectMcpClientIdentity heuristic the heartbeat wrapper
  // already uses so receipts bucket per actual MCP client connection (codex
  // sessions via CODEX_SESSION_ID env, claude via CLAUDECODE_SESSION_ID, etc.)
  // instead of collapsing into one giant anonymous row.
  const sessionId = sessionFromArgs ?? detectMcpClientIdentity(process.env, value).sessionId;
  const repoRoot = record ? stringField(record.repo_root) : undefined;
  const context: Pick<MetricRecord, 'session_id' | 'repo_root'> = {};
  if (sessionId) context.session_id = sessionId;
  if (repoRoot !== undefined) context.repo_root = repoRoot;
  return context;
}

function responseErrorMetricOf(
  value: unknown,
): Pick<MetricRecord, 'error_code' | 'error_message'> | null {
  if (!isRecord(value) || value.isError !== true) return null;
  const payload = firstTextPayload(value.content);
  if (payload) {
    try {
      const parsed = JSON.parse(payload) as unknown;
      if (isRecord(parsed)) {
        return metricErrorFields(
          boundedString(stringField(parsed.code), 120),
          boundedString(stringField(parsed.error) ?? stringField(parsed.message), 500),
        );
      }
    } catch {
      return metricErrorFields(undefined, boundedString(payload, 500));
    }
  }
  return metricErrorFields(undefined, 'MCP tool returned isError=true');
}

function errorMetricOf(err: unknown): Pick<MetricRecord, 'error_code' | 'error_message'> {
  const code = isRecord(err) ? boundedString(stringField(err.code), 120) : undefined;
  const message =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : serialize(err) || String(err);
  return metricErrorFields(
    code ?? (err instanceof Error && err.name !== 'Error' ? err.name : undefined),
    boundedString(message, 500),
  );
}

function metricErrorFields(
  code: string | undefined,
  message: string | undefined,
): Pick<MetricRecord, 'error_code' | 'error_message'> {
  const fields: Pick<MetricRecord, 'error_code' | 'error_message'> = {};
  if (code !== undefined) fields.error_code = code;
  if (message !== undefined) fields.error_message = message;
  return fields;
}

function firstTextPayload(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const item of content) {
    if (isRecord(item) && item.type === 'text') {
      const text = stringField(item.text);
      if (text) return text;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function boundedString(value: string | undefined, limit: number): string | undefined {
  if (value === undefined) return undefined;
  return value.length <= limit ? value : value.slice(0, limit);
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
  session_id?: string | null;
  repo_root?: string | null;
  input_bytes: number;
  output_bytes: number;
  input_tokens: number;
  output_tokens: number;
  duration_ms: number;
  ok: boolean;
  error_code?: string | null;
  error_message?: string | null;
}

function recordSafe(store: MemoryStore, metric: MetricRecord): void {
  try {
    store.storage.recordMcpMetric(metric);
  } catch {
    // Metrics are advisory; never break a tool call when sqlite is read-only,
    // closed, or the schema is older than this build.
  }
}
