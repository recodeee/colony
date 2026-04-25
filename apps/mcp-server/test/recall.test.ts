import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { MemoryStore } from '@colony/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';

let dir: string;
let store: MemoryStore;
let client: Client;

async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}';
  return JSON.parse(text) as T;
}

async function callError(
  name: string,
  args: Record<string, unknown>,
): Promise<{ code: string; error: string }> {
  const res = await client.callTool({ name, arguments: args });
  expect(res.isError).toBe(true);
  const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}';
  return JSON.parse(text) as { code: string; error: string };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'colony-recall-'));
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
  const server = buildServer(store, defaultSettings);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
});

afterEach(async () => {
  await client.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('recall_session', () => {
  it('returns the target timeline (compact) and writes a kind:recall observation in the caller', async () => {
    store.startSession({ id: 'past', ide: 'codex', cwd: '/repo' });
    store.startSession({ id: 'now', ide: 'claude-code', cwd: '/repo' });
    const a = store.addObservation({ session_id: 'past', kind: 'note', content: 'hit one' });
    const b = store.addObservation({ session_id: 'past', kind: 'note', content: 'hit two' });

    const resp = await call<{
      recall_observation_id: number;
      session: { id: string; ide: string };
      observations: Array<{ id: number; kind: string; ts: number }>;
    }>('recall_session', {
      target_session_id: 'past',
      current_session_id: 'now',
      limit: 10,
    });

    expect(resp.session.ide).toBe('codex');
    const ids = resp.observations.map((o) => o.id).sort((x, y) => x - y);
    expect(ids).toEqual([a, b].sort((x, y) => x - y));
    // Compact shape — never carry bodies on the recall response itself.
    for (const obs of resp.observations) {
      expect(obs).not.toHaveProperty('content');
    }

    // The recall row lives in the *caller's* session, not the target's.
    const recallRow = store.storage.getObservation(resp.recall_observation_id);
    expect(recallRow?.session_id).toBe('now');
    expect(recallRow?.kind).toBe('recall');
    const meta = JSON.parse(recallRow?.metadata ?? '{}');
    expect(meta.recalled_session_id).toBe('past');
    expect(meta.owner_ide).toBe('codex');
    expect((meta.observation_ids as number[]).sort((x, y) => x - y)).toEqual(
      [a, b].sort((x, y) => x - y),
    );
    expect(meta.limit).toBe(10);
  });

  it('rejects an unknown target_session_id with SESSION_NOT_FOUND and writes nothing', async () => {
    store.startSession({ id: 'now', ide: 'claude-code', cwd: '/repo' });
    const before = store.storage.listSessions(50).length;

    const err = await callError('recall_session', {
      target_session_id: 'never-existed',
      current_session_id: 'now',
    });
    expect(err.code).toBe('SESSION_NOT_FOUND');

    // Phantom-row guard: no new sessions row should have appeared. ensureSession
    // would silently create one if we let the call reach addObservation.
    expect(store.storage.listSessions(50).length).toBe(before);
    expect(store.storage.getSession('never-existed')).toBeUndefined();
  });

  it('rejects an unknown current_session_id with SESSION_NOT_FOUND and does not phantom-create it', async () => {
    store.startSession({ id: 'past', ide: 'codex', cwd: '/repo' });

    const err = await callError('recall_session', {
      target_session_id: 'past',
      current_session_id: 'typo-session',
    });
    expect(err.code).toBe('SESSION_NOT_FOUND');
    expect(err.error).toContain('current');
    expect(store.storage.getSession('typo-session')).toBeUndefined();
  });

  it('falls back to inferIdeFromSessionId when the target session row lists ide as unknown', async () => {
    // Backfill scenario: a row exists but the ide column was never classified.
    store.startSession({ id: 'codex-abc-123', ide: 'unknown', cwd: '/repo' });
    store.startSession({ id: 'now', ide: 'claude-code', cwd: '/repo' });

    const resp = await call<{ session: { ide: string }; recall_observation_id: number }>(
      'recall_session',
      {
        target_session_id: 'codex-abc-123',
        current_session_id: 'now',
      },
    );
    expect(resp.session.ide).toBe('codex');

    const meta = JSON.parse(
      store.storage.getObservation(resp.recall_observation_id)?.metadata ?? '{}',
    );
    expect(meta.owner_ide).toBe('codex');
  });

  it('around_id pointing at an id from a different session yields an empty timeline (no silent fall-through)', async () => {
    store.startSession({ id: 'past', ide: 'codex', cwd: '/repo' });
    store.startSession({ id: 'other', ide: 'claude-code', cwd: '/repo' });
    store.startSession({ id: 'now', ide: 'claude-code', cwd: '/repo' });
    store.addObservation({ session_id: 'past', kind: 'note', content: 'past one' });
    const otherId = store.addObservation({
      session_id: 'other',
      kind: 'note',
      content: 'other one',
    });

    const resp = await call<{
      observations: Array<{ id: number }>;
      recall_observation_id: number;
    }>('recall_session', {
      target_session_id: 'past',
      current_session_id: 'now',
      around_id: otherId,
    });

    // Storage.timeline filters by session_id, so a foreign around_id returns
    // [] rather than spilling over into the target's window.
    expect(resp.observations).toEqual([]);
    const meta = JSON.parse(
      store.storage.getObservation(resp.recall_observation_id)?.metadata ?? '{}',
    );
    expect(meta.observation_ids).toEqual([]);
    expect(meta.around_id).toBe(otherId);
  });
});
