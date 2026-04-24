import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Storage } from '../src/index.js';

let dir: string;
let storage: Storage;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'colony-examples-'));
  storage = new Storage(join(dir, 'test.db'));
});

afterEach(() => {
  storage.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Storage — examples (foraging food sources)', () => {
  it('upsert inserts a new row and returns its id', () => {
    const id = storage.upsertExample({
      repo_root: '/repo/a',
      example_name: 'stripe-webhook',
      content_hash: 'hash-1',
      manifest_kind: 'npm',
      observation_count: 5,
      last_scanned_at: 1_000,
    });
    expect(id).toBeGreaterThan(0);

    const row = storage.getExample('/repo/a', 'stripe-webhook');
    expect(row).toMatchObject({
      id,
      repo_root: '/repo/a',
      example_name: 'stripe-webhook',
      content_hash: 'hash-1',
      manifest_kind: 'npm',
      observation_count: 5,
      last_scanned_at: 1_000,
    });
  });

  it('upsert replaces content_hash, manifest_kind, observation_count, last_scanned_at on conflict', () => {
    const firstId = storage.upsertExample({
      repo_root: '/repo/a',
      example_name: 'stripe-webhook',
      content_hash: 'hash-1',
      manifest_kind: 'npm',
      observation_count: 5,
      last_scanned_at: 1_000,
    });
    const secondId = storage.upsertExample({
      repo_root: '/repo/a',
      example_name: 'stripe-webhook',
      content_hash: 'hash-2',
      manifest_kind: 'npm',
      observation_count: 7,
      last_scanned_at: 2_000,
    });

    // Same natural key → same row id, not a new one.
    expect(secondId).toBe(firstId);

    const row = storage.getExample('/repo/a', 'stripe-webhook');
    expect(row).toMatchObject({
      id: firstId,
      content_hash: 'hash-2',
      observation_count: 7,
      last_scanned_at: 2_000,
    });
  });

  it('listExamples returns rows for the repo, newest-scan-first', () => {
    storage.upsertExample({
      repo_root: '/repo/a',
      example_name: 'older',
      content_hash: 'h-a',
      manifest_kind: 'npm',
      last_scanned_at: 1_000,
    });
    storage.upsertExample({
      repo_root: '/repo/a',
      example_name: 'newer',
      content_hash: 'h-b',
      manifest_kind: 'cargo',
      last_scanned_at: 2_000,
    });
    storage.upsertExample({
      repo_root: '/repo/b',
      example_name: 'other-repo',
      content_hash: 'h-c',
      manifest_kind: 'go',
      last_scanned_at: 3_000,
    });

    const rows = storage.listExamples('/repo/a');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.example_name)).toEqual(['newer', 'older']);
  });

  it('deleteExample removes the row without affecting others', () => {
    storage.upsertExample({
      repo_root: '/repo/a',
      example_name: 'keep',
      content_hash: 'h-k',
      manifest_kind: 'npm',
      last_scanned_at: 1_000,
    });
    storage.upsertExample({
      repo_root: '/repo/a',
      example_name: 'drop',
      content_hash: 'h-d',
      manifest_kind: 'npm',
      last_scanned_at: 1_000,
    });

    storage.deleteExample('/repo/a', 'drop');
    expect(storage.getExample('/repo/a', 'drop')).toBeUndefined();
    expect(storage.getExample('/repo/a', 'keep')).toBeDefined();
  });

  it('accepts null manifest_kind and defaults observation_count to 0', () => {
    storage.upsertExample({
      repo_root: '/repo/a',
      example_name: 'unknown-kind',
      content_hash: 'h',
      manifest_kind: null,
      last_scanned_at: 1_000,
    });

    const row = storage.getExample('/repo/a', 'unknown-kind');
    expect(row?.manifest_kind).toBeNull();
    expect(row?.observation_count).toBe(0);
  });
});
