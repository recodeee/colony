import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inferIdeFromSessionId } from '@colony/core';
import { Storage } from '@colony/storage';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Exercises the composition behind `colony backfill ide` without booting the
// CLI: seed a mix of session-id shapes the hook path has historically left
// as `ide = 'unknown'`, then run the same `Storage.backfillUnknownIde(mapper)`
// call the command wires, with the shared `@colony/core` inferrer as the
// mapper. Guards the invariant that every id the inferrer can classify gets
// healed and ids it cannot are left alone.
let dir: string;
let storage: Storage;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'colony-cli-backfill-'));
  storage = new Storage(join(dir, 'test.db'));
});

afterEach(() => {
  storage.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedUnknown(id: string): void {
  storage.createSession({
    id,
    ide: 'unknown',
    cwd: null,
    started_at: Date.now(),
    metadata: null,
  });
}

describe('backfill ide composition', () => {
  it('heals classifiable rows and leaves unknown ones alone', () => {
    seedUnknown('codex@019dbcdf');
    seedUnknown('claude@7a67fdea');
    seedUnknown('agent/claude/fix-unknown-ide-owner-infer-2026-04-24-21-21');
    seedUnknown('codex-colony-usage-limit-takeover-verify-2026-04-24-20-48');
    seedUnknown('some-random-id');

    const { scanned, updated } = storage.backfillUnknownIde((id) =>
      inferIdeFromSessionId(id),
    );

    expect(scanned).toBe(5);
    expect(updated).toBe(4);
    expect(storage.getSession('codex@019dbcdf')?.ide).toBe('codex');
    expect(storage.getSession('claude@7a67fdea')?.ide).toBe('claude-code');
    expect(
      storage.getSession('agent/claude/fix-unknown-ide-owner-infer-2026-04-24-21-21')?.ide,
    ).toBe('claude-code');
    expect(
      storage.getSession('codex-colony-usage-limit-takeover-verify-2026-04-24-20-48')?.ide,
    ).toBe('codex');
    expect(storage.getSession('some-random-id')?.ide).toBe('unknown');
  });

  it('is idempotent: a second run scans zero unknown rows', () => {
    seedUnknown('claude@abc');
    storage.backfillUnknownIde((id) => inferIdeFromSessionId(id));
    const again = storage.backfillUnknownIde((id) => inferIdeFromSessionId(id));
    expect(again).toEqual({ scanned: 0, updated: 0 });
  });
});
