// Synchronous SQLITE_BUSY retry wrapper for better-sqlite3 writes.
//
// Background: the Storage constructor sets busy_timeout=5000 and
// journal_mode=WAL, which together absorb the overwhelming majority of
// contention between the worker daemon, MCP server, and CLI hooks. The
// remaining tail comes from edge cases — a long checkpoint, a migration
// that holds a write transaction, or a misbehaving hook that opens its
// own connection. In those cases SQLite still raises SQLITE_BUSY after
// the busy_timeout window expires, which the 168h gain telemetry saw
// surface once on task_claim_quota_release_expired.
//
// This helper gives callers a defensive Node-level retry on top of
// SQLite's own busy_timeout. Five attempts with backoff 5/20/80/250ms
// cap total wait at ~355ms — small enough that the caller is not
// noticeably slower, large enough that a transient checkpoint or
// short-held write transaction has time to clear.

export interface BusyRetryOptions {
  /** Maximum number of attempts (including the first). Defaults to 5. */
  maxAttempts?: number;
  /** Base delay in milliseconds; backoff is base * 4^(attempt-1) capped at 250ms. Defaults to 5. */
  baseDelayMs?: number;
  /** Maximum per-attempt delay in milliseconds. Defaults to 250. */
  maxDelayMs?: number;
}

const BUSY_CODES = new Set([
  'SQLITE_BUSY',
  'SQLITE_BUSY_RECOVERY',
  'SQLITE_BUSY_SNAPSHOT',
  'SQLITE_BUSY_TIMEOUT',
  'SQLITE_LOCKED',
  'SQLITE_LOCKED_SHAREDCACHE',
]);

function isBusyError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && BUSY_CODES.has(code);
}

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  // Atomics.wait is the canonical sync sleep in Node — it blocks the
  // event loop without burning CPU. SharedArrayBuffer is allocated once
  // per call and is cheap.
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, ms);
}

/**
 * Run `fn` and retry on SQLITE_BUSY / SQLITE_LOCKED with exponential
 * backoff. better-sqlite3 is synchronous, so this is synchronous too.
 * Re-throws non-busy errors immediately and the last busy error after
 * `maxAttempts` retries.
 */
export function withBusyRetry<T>(fn: () => T, opts: BusyRetryOptions = {}): T {
  const maxAttempts = opts.maxAttempts ?? 5;
  const baseDelayMs = opts.baseDelayMs ?? 5;
  const maxDelayMs = opts.maxDelayMs ?? 250;
  let attempt = 0;
  // The loop body always either returns or throws, so the linter is
  // happy with the `while (true)` shape.
  while (true) {
    try {
      return fn();
    } catch (err) {
      attempt += 1;
      if (!isBusyError(err) || attempt >= maxAttempts) throw err;
      const delay = Math.min(baseDelayMs * 4 ** (attempt - 1), maxDelayMs);
      sleepSync(delay);
    }
  }
}
