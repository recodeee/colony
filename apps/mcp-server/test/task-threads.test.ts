import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@cavemem/config';
import { MemoryStore, TaskThread } from '@cavemem/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';

let dir: string;
let store: MemoryStore;
let client: Client;

/**
 * Every cavemem tool returns `{ content: [{ type: 'text', text: JSON }] }`.
 * Centralising the unwrap keeps the individual tests readable.
 */
async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}';
  return JSON.parse(text) as T;
}

/**
 * Seeds the fixture every task-thread test needs: two participating sessions
 * and a task thread they're both joined to. We bypass the hook layer here
 * because these tests target the MCP surface + storage contract, not hook
 * integration.
 */
function seedTwoSessionTask(): { task_id: number; sessionA: string; sessionB: string } {
  store.startSession({ id: 'A', ide: 'claude-code', cwd: '/repo' });
  store.startSession({ id: 'B', ide: 'codex', cwd: '/repo' });
  const thread = TaskThread.open(store, {
    repo_root: '/repo',
    branch: 'feat/handoff',
    session_id: 'A',
  });
  thread.join('A', 'claude');
  thread.join('B', 'codex');
  return { task_id: thread.task_id, sessionA: 'A', sessionB: 'B' };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cavemem-task-threads-'));
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

describe('task threads — handoff lifecycle', () => {
  it('transfers file claims atomically when a handoff is accepted', async () => {
    const { task_id, sessionA, sessionB } = seedTwoSessionTask();

    // A claims the file it's about to hand off.
    await call('task_claim_file', {
      task_id,
      session_id: sessionA,
      file_path: 'src/viewer.tsx',
    });

    // A posts the handoff naming the file as transferred.
    const { handoff_observation_id } = await call<{ handoff_observation_id: number }>(
      'task_hand_off',
      {
        task_id,
        session_id: sessionA,
        agent: 'claude',
        to_agent: 'codex',
        summary: 'viewer is done, API is next',
        transferred_files: ['src/viewer.tsx'],
      },
    );

    // Between handoff and accept the claim must be vacant — otherwise a
    // third agent racing in the gap could grab the file.
    expect(store.storage.getClaim(task_id, 'src/viewer.tsx')).toBeUndefined();

    const accepted = await call<{ status: string }>('task_accept_handoff', {
      handoff_observation_id,
      session_id: sessionB,
    });
    expect(accepted.status).toBe('accepted');

    // Claim migrated to B.
    const claim = store.storage.getClaim(task_id, 'src/viewer.tsx');
    expect(claim?.session_id).toBe(sessionB);

    // Handoff metadata reflects acceptance. Reading the observation directly
    // because `get_observations` doesn't expose metadata mutation state.
    const handoff = store.storage.getObservation(handoff_observation_id);
    const meta = JSON.parse(handoff?.metadata ?? '{}');
    expect(meta.status).toBe('accepted');
    expect(meta.accepted_by_session_id).toBe(sessionB);
  });

  it('declining a handoff cancels it and records a reason', async () => {
    const { task_id, sessionA, sessionB } = seedTwoSessionTask();

    const { handoff_observation_id } = await call<{ handoff_observation_id: number }>(
      'task_hand_off',
      {
        task_id,
        session_id: sessionA,
        agent: 'claude',
        to_agent: 'codex',
        summary: 'take the API',
        transferred_files: ['src/api.ts'],
      },
    );

    await call('task_decline_handoff', {
      handoff_observation_id,
      session_id: sessionB,
      reason: 'I am mid-turn on another task',
    });

    // Declined handoffs MUST NOT transfer claims. Silent claim transfer to
    // a session that refused the work would be the ugliest failure mode.
    expect(store.storage.getClaim(task_id, 'src/api.ts')).toBeUndefined();

    const handoff = store.storage.getObservation(handoff_observation_id);
    const meta = JSON.parse(handoff?.metadata ?? '{}');
    expect(meta.status).toBe('cancelled');

    // Decline should be discoverable in the timeline so the sender's next
    // turn can render "B declined: <reason>" via the hook.
    const timeline = await call<Array<{ id: number; kind: string }>>('task_timeline', { task_id });
    expect(timeline.some((r) => r.kind === 'decline')).toBe(true);
  });

  it('rejects acceptance after the handoff has expired', async () => {
    const { task_id, sessionA, sessionB } = seedTwoSessionTask();

    const { handoff_observation_id } = await call<{ handoff_observation_id: number }>(
      'task_hand_off',
      {
        task_id,
        session_id: sessionA,
        agent: 'claude',
        to_agent: 'codex',
        summary: 'urgent',
        expires_in_minutes: 1,
      },
    );

    // Force expiry by editing the metadata directly. Fake timers are risky
    // here because the MCP transport uses real microtasks and can hang.
    const row = store.storage.getObservation(handoff_observation_id);
    const meta = JSON.parse(row?.metadata ?? '{}') as { expires_at: number };
    meta.expires_at = Date.now() - 1000;
    store.storage.updateObservationMetadata(handoff_observation_id, JSON.stringify(meta));

    const res = await client.callTool({
      name: 'task_accept_handoff',
      arguments: { handoff_observation_id, session_id: sessionB },
    });
    expect(res.isError).toBe(true);

    // Metadata must flip to `expired` so the sender sees the outcome on
    // their next turn — staying `pending` after a failed accept would
    // let the handoff look live forever.
    const after = store.storage.getObservation(handoff_observation_id);
    const afterMeta = JSON.parse(after?.metadata ?? '{}');
    expect(afterMeta.status).toBe('expired');
  });

  it("task_updates_since filters out the caller's own posts", async () => {
    const { task_id, sessionA, sessionB } = seedTwoSessionTask();
    const cursor = Date.now() - 1; // strictly before either post

    await call('task_post', {
      task_id,
      session_id: sessionA,
      kind: 'note',
      content: 'from A',
    });
    await call('task_post', {
      task_id,
      session_id: sessionB,
      kind: 'blocker',
      content: 'from B',
    });

    const updatesForA = await call<Array<{ session_id: string }>>('task_updates_since', {
      task_id,
      session_id: sessionA,
      since_ts: cursor,
    });
    expect(updatesForA.every((row) => row.session_id !== sessionA)).toBe(true);
    expect(updatesForA.some((row) => row.session_id === sessionB)).toBe(true);

    // Symmetry — would silently break if someone swapped the filter.
    const updatesForB = await call<Array<{ session_id: string }>>('task_updates_since', {
      task_id,
      session_id: sessionB,
      since_ts: cursor,
    });
    expect(updatesForB.every((row) => row.session_id !== sessionB)).toBe(true);
    expect(updatesForB.some((row) => row.session_id === sessionA)).toBe(true);
  });
});
