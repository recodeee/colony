import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { MemoryStore } from '@colony/core';
import { Client } from '@modelcontextprotocol/sdk/client';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';

interface AccountClaim {
  id: number;
  plan_slug: string;
  wave_id: string;
  account_id: string;
  session_id: string | null;
  agent: string | null;
  claimed_at: number;
  state: 'active' | 'released';
  expires_at: number | null;
  released_at: number | null;
  released_by_session_id: string | null;
  note: string | null;
}

interface ClaimResult {
  claim: AccountClaim;
}

interface ReleaseResult {
  released: boolean;
  claim?: AccountClaim;
  id?: number;
}

interface ListResult {
  claims: AccountClaim[];
}

let dataDir: string;
let store: MemoryStore;
let client: Client;

async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}';
  return JSON.parse(text) as T;
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'colony-account-claims-'));
  store = new MemoryStore({ dbPath: join(dataDir, 'data.db'), settings: defaultSettings });
  const server = buildServer(store, defaultSettings);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
});

afterEach(async () => {
  await client.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('task_claim_account', () => {
  it('creates an active claim for a wave', async () => {
    const result = await call<ClaimResult>('task_claim_account', {
      plan_slug: 'plan-1',
      wave_id: 'wave-A',
      account_id: 'acct-alpha',
    });
    expect(result.claim).toMatchObject({
      plan_slug: 'plan-1',
      wave_id: 'wave-A',
      account_id: 'acct-alpha',
      state: 'active',
      released_at: null,
    });
    expect(typeof result.claim.id).toBe('number');
    expect(typeof result.claim.claimed_at).toBe('number');
  });

  it('refreshes the existing row when the same account is rebound to the same wave', async () => {
    const first = await call<ClaimResult>('task_claim_account', {
      plan_slug: 'plan-1',
      wave_id: 'wave-A',
      account_id: 'acct-alpha',
      note: 'first',
    });
    const second = await call<ClaimResult>('task_claim_account', {
      plan_slug: 'plan-1',
      wave_id: 'wave-A',
      account_id: 'acct-alpha',
      note: 'second',
    });
    expect(second.claim.id).toBe(first.claim.id);
    expect(second.claim.note).toBe('second');
    expect(second.claim.state).toBe('active');
  });

  it('releases the previous binding and inserts a new active row when the account changes', async () => {
    const first = await call<ClaimResult>('task_claim_account', {
      plan_slug: 'plan-1',
      wave_id: 'wave-A',
      account_id: 'acct-alpha',
    });
    const second = await call<ClaimResult>('task_claim_account', {
      plan_slug: 'plan-1',
      wave_id: 'wave-A',
      account_id: 'acct-beta',
    });
    expect(second.claim.id).not.toBe(first.claim.id);
    expect(second.claim.account_id).toBe('acct-beta');
    expect(second.claim.state).toBe('active');

    const all = await call<ListResult>('task_list_account_claims', { plan_slug: 'plan-1' });
    const active = all.claims.filter((c) => c.state === 'active');
    expect(active).toHaveLength(1);
    expect(active[0]?.account_id).toBe('acct-beta');
    const released = all.claims.filter((c) => c.state === 'released');
    expect(released).toHaveLength(1);
    expect(released[0]?.account_id).toBe('acct-alpha');
  });

  it('allows the same account to be active on multiple waves', async () => {
    await call<ClaimResult>('task_claim_account', {
      plan_slug: 'plan-1',
      wave_id: 'wave-A',
      account_id: 'acct-alpha',
    });
    await call<ClaimResult>('task_claim_account', {
      plan_slug: 'plan-1',
      wave_id: 'wave-B',
      account_id: 'acct-alpha',
    });
    const list = await call<ListResult>('task_list_account_claims', {
      account_id: 'acct-alpha',
      state: 'active',
    });
    expect(list.claims).toHaveLength(2);
    expect(list.claims.map((c) => c.wave_id).sort()).toEqual(['wave-A', 'wave-B']);
  });
});

describe('task_release_account_claim', () => {
  it('flips an active claim to released and stamps released_at', async () => {
    const created = await call<ClaimResult>('task_claim_account', {
      plan_slug: 'plan-1',
      wave_id: 'wave-A',
      account_id: 'acct-alpha',
    });
    const released = await call<ReleaseResult>('task_release_account_claim', {
      id: created.claim.id,
    });
    expect(released.released).toBe(true);
    expect(released.claim?.state).toBe('released');
    expect(typeof released.claim?.released_at).toBe('number');
  });

  it('returns released:false for a missing id', async () => {
    const result = await call<ReleaseResult>('task_release_account_claim', { id: 999999 });
    expect(result.released).toBe(false);
    expect(result.id).toBe(999999);
  });

  it('clears the active slot so a new claim can be made on the same wave', async () => {
    const first = await call<ClaimResult>('task_claim_account', {
      plan_slug: 'plan-1',
      wave_id: 'wave-A',
      account_id: 'acct-alpha',
    });
    await call<ReleaseResult>('task_release_account_claim', { id: first.claim.id });
    const second = await call<ClaimResult>('task_claim_account', {
      plan_slug: 'plan-1',
      wave_id: 'wave-A',
      account_id: 'acct-alpha',
    });
    expect(second.claim.id).not.toBe(first.claim.id);
    expect(second.claim.state).toBe('active');
  });
});

describe('task_list_account_claims', () => {
  it('filters by state', async () => {
    const created = await call<ClaimResult>('task_claim_account', {
      plan_slug: 'plan-1',
      wave_id: 'wave-A',
      account_id: 'acct-alpha',
    });
    await call<ClaimResult>('task_claim_account', {
      plan_slug: 'plan-1',
      wave_id: 'wave-A',
      account_id: 'acct-beta',
    });
    const activeOnly = await call<ListResult>('task_list_account_claims', {
      plan_slug: 'plan-1',
      state: 'active',
    });
    expect(activeOnly.claims).toHaveLength(1);
    expect(activeOnly.claims[0]?.account_id).toBe('acct-beta');
    const releasedOnly = await call<ListResult>('task_list_account_claims', {
      plan_slug: 'plan-1',
      state: 'released',
    });
    expect(releasedOnly.claims).toHaveLength(1);
    expect(releasedOnly.claims[0]?.id).toBe(created.claim.id);
  });

  it('returns empty list when nothing matches', async () => {
    const list = await call<ListResult>('task_list_account_claims', { plan_slug: 'unknown' });
    expect(list.claims).toEqual([]);
  });
});
