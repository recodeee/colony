import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { MemoryStore } from '@colony/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SCOUT_NO_CLAIM,
  enforceScoutNoClaim,
  filterReadyForExecutor,
} from '../../src/handlers/claims.js';

let dataDir: string;
let store: MemoryStore;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'colony-claims-handler-'));
  store = new MemoryStore({ dbPath: join(dataDir, 'data.db'), settings: defaultSettings });
});

afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('enforceScoutNoClaim', () => {
  it('rejects scout actors before they claim files', () => {
    store.storage.upsertAgentProfile({
      agent: 'scout-a',
      capabilities: '{}',
      role: 'scout',
      updated_at: 1,
    });

    expect(() => enforceScoutNoClaim(store, { agent: 'scout-a' })).toThrow(
      'scouts cannot claim files; propose instead',
    );
    expect(() => enforceScoutNoClaim(store, { agent: 'scout-a' })).toThrowError(
      expect.objectContaining({ code: SCOUT_NO_CLAIM }),
    );
  });

  it('allows executors and unknown actors to claim files', () => {
    store.storage.upsertAgentProfile({
      agent: 'exec-b',
      capabilities: '{}',
      role: 'executor',
      updated_at: 1,
    });

    expect(() => enforceScoutNoClaim(store, { agent: 'exec-b' })).not.toThrow();
    expect(() => enforceScoutNoClaim(store, { agent: 'new-agent' })).not.toThrow();
  });
});

describe('filterReadyForExecutor', () => {
  const rows = [
    { id: 1, proposal_status: null },
    { id: 2, proposal_status: 'proposed' as const },
    { id: 3, proposal_status: 'approved' as const },
    { id: 4, proposal_status: 'archived' as const },
  ];

  it('hides proposal work from scout actors', () => {
    expect(filterReadyForExecutor(rows, 'scout')).toEqual([]);
  });

  it('shows only normal and approved proposal work to executors', () => {
    expect(filterReadyForExecutor(rows, 'executor').map((row) => row.id)).toEqual([1, 3]);
  });

  it('leaves all work visible for queen actors', () => {
    expect(filterReadyForExecutor(rows, 'queen')).toEqual(rows);
  });
});
