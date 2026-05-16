import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Storage, withBusyRetry } from '../src/index.js';

let dir: string;
let storage: Storage;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'colony-storage-busy-retry-'));
  storage = new Storage(join(dir, 'storage.db'));
});

afterEach(() => {
  storage.close?.();
  rmSync(dir, { recursive: true, force: true });
});

describe('Storage WAL mode', () => {
  it('enables WAL journal mode on writable connections', () => {
    const mode = (storage as unknown as { db: { pragma: (sql: string) => unknown[] } }).db
      .pragma('journal_mode')
      .map((r: unknown) => (r as { journal_mode: string }).journal_mode);
    expect(mode[0]?.toLowerCase()).toBe('wal');
  });

  it('keeps busy_timeout set to 15000', () => {
    const timeout = (storage as unknown as { db: { pragma: (sql: string) => unknown[] } }).db
      .pragma('busy_timeout')
      .map((r: unknown) => (r as { timeout: number }).timeout);
    expect(timeout[0]).toBe(15000);
  });
});

describe('withBusyRetry', () => {
  const makeBusyError = (code = 'SQLITE_BUSY'): Error & { code: string } => {
    const err = new Error('database is locked') as Error & { code: string };
    err.code = code;
    return err;
  };

  it('returns the value when fn succeeds on first try', () => {
    let calls = 0;
    const result = withBusyRetry(() => {
      calls += 1;
      return 42;
    });
    expect(result).toBe(42);
    expect(calls).toBe(1);
  });

  it('retries on SQLITE_BUSY and returns when fn eventually succeeds', () => {
    let calls = 0;
    const result = withBusyRetry(
      () => {
        calls += 1;
        if (calls < 3) throw makeBusyError();
        return 'ok';
      },
      { baseDelayMs: 1, maxDelayMs: 4 },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('retries on SQLITE_LOCKED variants', () => {
    let calls = 0;
    const result = withBusyRetry(
      () => {
        calls += 1;
        if (calls === 1) throw makeBusyError('SQLITE_LOCKED');
        if (calls === 2) throw makeBusyError('SQLITE_BUSY_SNAPSHOT');
        return 'ok';
      },
      { baseDelayMs: 1, maxDelayMs: 4 },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('throws the last busy error after maxAttempts retries', () => {
    let calls = 0;
    expect(() =>
      withBusyRetry(
        () => {
          calls += 1;
          throw makeBusyError();
        },
        { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 4 },
      ),
    ).toThrow('database is locked');
    expect(calls).toBe(3);
  });

  it('re-throws non-busy errors immediately without retrying', () => {
    let calls = 0;
    expect(() =>
      withBusyRetry(
        () => {
          calls += 1;
          throw new Error('schema mismatch');
        },
        { maxAttempts: 5, baseDelayMs: 1 },
      ),
    ).toThrow('schema mismatch');
    expect(calls).toBe(1);
  });

  it('respects baseDelayMs and maxDelayMs so the total wait stays bounded', () => {
    const start = Date.now();
    let calls = 0;
    expect(() =>
      withBusyRetry(
        () => {
          calls += 1;
          throw makeBusyError();
        },
        { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 4 },
      ),
    ).toThrow();
    const elapsed = Date.now() - start;
    expect(calls).toBe(5);
    // Backoff is 1, 4, 4, 4 across 4 sleeps = 13ms; allow 100ms slack
    // for scheduling jitter on busy CI hosts.
    expect(elapsed).toBeLessThan(150);
  });
});
