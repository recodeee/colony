import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Storage } from '../src/index.js';

let dir: string;
let storage: Storage;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'colony-agent-profiles-'));
  storage = new Storage(join(dir, 'test.db'));
});

afterEach(() => {
  storage.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('agent profiles storage', () => {
  it('upsert + get round-trips agent, capabilities JSON, and updated_at', () => {
    storage.upsertAgentProfile({
      agent: 'claude',
      capabilities: JSON.stringify({ ui_work: 0.9, api_work: 0.3 }),
      updated_at: 1_000,
    });
    const row = storage.getAgentProfile('claude');
    expect(row).toEqual({
      agent: 'claude',
      capabilities: JSON.stringify({ ui_work: 0.9, api_work: 0.3 }),
      role: 'executor',
      open_proposal_count: 0,
      updated_at: 1_000,
    });
  });

  it('upsert + get round-trips scout role and open proposal count', () => {
    storage.upsertAgentProfile({
      agent: 'scout-a',
      capabilities: '{}',
      role: 'scout',
      open_proposal_count: 2,
      updated_at: 1_000,
    });
    expect(storage.getAgentProfile('scout-a')).toEqual({
      agent: 'scout-a',
      capabilities: '{}',
      role: 'scout',
      open_proposal_count: 2,
      updated_at: 1_000,
    });
  });

  it('upsertAgentProfile is last-writer-wins on the agent key', () => {
    storage.upsertAgentProfile({
      agent: 'codex',
      capabilities: JSON.stringify({ api_work: 0.5 }),
      role: 'scout',
      open_proposal_count: 1,
      updated_at: 1_000,
    });
    storage.upsertAgentProfile({
      agent: 'codex',
      capabilities: JSON.stringify({ api_work: 0.9, infra_work: 0.8 }),
      updated_at: 2_000,
    });
    const row = storage.getAgentProfile('codex');
    if (!row) throw new Error('expected codex profile');
    expect(JSON.parse(row.capabilities)).toEqual({ api_work: 0.9, infra_work: 0.8 });
    expect(row.role).toBe('scout');
    expect(row.open_proposal_count).toBe(1);
    expect(row?.updated_at).toBe(2_000);
  });

  it('listAgentProfiles returns every profile ordered by agent name', () => {
    storage.upsertAgentProfile({
      agent: 'codex',
      capabilities: '{}',
      updated_at: 1,
    });
    storage.upsertAgentProfile({
      agent: 'claude',
      capabilities: '{}',
      updated_at: 2,
    });
    storage.upsertAgentProfile({
      agent: 'anther',
      capabilities: '{}',
      updated_at: 3,
    });
    expect(storage.listAgentProfiles().map((r) => r.agent)).toEqual(['anther', 'claude', 'codex']);
  });

  it('getAgentProfile returns undefined for unknown agents', () => {
    expect(storage.getAgentProfile('nobody')).toBeUndefined();
  });
});
