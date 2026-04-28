import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { MemoryStore, TASK_THREAD_ERROR_CODES, TaskThread } from '@colony/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';

let dir: string;
let store: MemoryStore;
let client: Client;

/**
 * Every colony tool returns `{ content: [{ type: 'text', text: JSON }] }`.
 * Centralising the unwrap keeps the individual tests readable.
 */
async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}';
  return JSON.parse(text) as T;
}

async function callError(
  name: string,
  args: Record<string, unknown>,
): Promise<{
  code: string;
  error: string;
}> {
  const res = await client.callTool({ name, arguments: args });
  expect(res.isError).toBe(true);
  const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}';
  return JSON.parse(text) as { code: string; error: string };
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
  dir = mkdtempSync(join(tmpdir(), 'colony-task-threads-'));
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

    const error = await callError('task_accept_handoff', {
      handoff_observation_id,
      session_id: sessionB,
    });
    expect(error.code).toBe(TASK_THREAD_ERROR_CODES.HANDOFF_EXPIRED);

    // Metadata must flip to `expired` so the sender sees the outcome on
    // their next turn — staying `pending` after a failed accept would
    // let the handoff look live forever.
    const after = store.storage.getObservation(handoff_observation_id);
    const afterMeta = JSON.parse(after?.metadata ?? '{}');
    expect(afterMeta.status).toBe('expired');
  });

  it('task_wake + task_ack_wake + attention_inbox round trip', async () => {
    const { task_id, sessionA, sessionB } = seedTwoSessionTask();

    const { wake_observation_id } = await call<{ wake_observation_id: number }>('task_wake', {
      task_id,
      session_id: sessionA,
      agent: 'claude',
      to_agent: 'codex',
      reason: 'please review the migration shape',
      next_step: 'look at packages/storage/src/schema.ts',
    });

    const inbox = await call<{
      pending_wakes: Array<{ id: number; reason: string }>;
      summary: { pending_wake_count: number; next_action: string };
    }>('attention_inbox', {
      session_id: sessionB,
      agent: 'codex',
      task_ids: [task_id],
    });
    expect(inbox.pending_wakes.map((w) => w.id)).toContain(wake_observation_id);
    expect(inbox.summary.pending_wake_count).toBeGreaterThan(0);

    const acked = await call<{ status: string }>('task_ack_wake', {
      wake_observation_id,
      session_id: sessionB,
    });
    expect(acked.status).toBe('acknowledged');

    const row = store.storage.getObservation(wake_observation_id);
    const meta = JSON.parse(row?.metadata ?? '{}');
    expect(meta.status).toBe('acknowledged');
    expect(meta.acknowledged_by_session_id).toBe(sessionB);

    const retry = await callError('task_ack_wake', { wake_observation_id, session_id: sessionB });
    expect(retry.code).toBe(TASK_THREAD_ERROR_CODES.ALREADY_ACKNOWLEDGED);
  });

  it('task_cancel_wake cancels a pending wake without side effects on claims', async () => {
    const { task_id, sessionA, sessionB } = seedTwoSessionTask();

    const { wake_observation_id } = await call<{ wake_observation_id: number }>('task_wake', {
      task_id,
      session_id: sessionA,
      agent: 'claude',
      to_agent: 'codex',
      reason: 'nevermind',
    });

    await call('task_cancel_wake', {
      wake_observation_id,
      session_id: sessionA,
      reason: 'resolved offline',
    });

    const row = store.storage.getObservation(wake_observation_id);
    const meta = JSON.parse(row?.metadata ?? '{}');
    expect(meta.status).toBe('cancelled');

    const error = await callError('task_ack_wake', { wake_observation_id, session_id: sessionB });
    expect(error.code).toBe(TASK_THREAD_ERROR_CODES.ALREADY_CANCELLED);
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

  // Relay lifecycle. Different from handoff: relays assume the sender is
  // gone, so claims are *dropped* at emit time and re-claimed by the
  // receiver on accept (no third agent can grab a file in the gap). The
  // sender provides only `reason` + `one_line` + `base_branch`; the rest
  // is auto-synthesized from the task thread so a Stop / SessionEnd hook
  // firing seconds before the process dies still produces a usable
  // packet. These tests exercise that contract through the MCP surface.

  it('task_relay drops sender claims at emit and task_accept_relay re-claims them on the receiver', async () => {
    const { task_id, sessionA, sessionB } = seedTwoSessionTask();

    await call('task_claim_file', {
      task_id,
      session_id: sessionA,
      file_path: 'src/auth.ts',
    });

    const { relay_observation_id } = await call<{ relay_observation_id: number; status: string }>(
      'task_relay',
      {
        task_id,
        session_id: sessionA,
        agent: 'claude',
        reason: 'quota',
        one_line: 'halfway through replacing auth middleware',
        base_branch: 'main',
      },
    );

    // Sender claims must be vacant between emit and accept — otherwise a
    // third agent racing in the gap could grab the file. This is the
    // load-bearing invariant that makes the primitive safe.
    expect(store.storage.getClaim(task_id, 'src/auth.ts')).toBeUndefined();

    // worktree_recipe.inherit_claims captures the dropped claims so the
    // receiver knows what to re-claim. Read the metadata directly because
    // the MCP surface deliberately doesn't expose it on the emit response.
    const row = store.storage.getObservation(relay_observation_id);
    const meta = JSON.parse(row?.metadata ?? '{}') as {
      worktree_recipe: { inherit_claims: string[]; fetch_files_at: string | null };
    };
    expect(meta.worktree_recipe.inherit_claims).toEqual(['src/auth.ts']);
    expect(meta.worktree_recipe.fetch_files_at).toBeNull();

    const accepted = await call<{ status: string }>('task_accept_relay', {
      relay_observation_id,
      session_id: sessionB,
    });
    expect(accepted.status).toBe('accepted');

    // Claim re-installed under B.
    expect(store.storage.getClaim(task_id, 'src/auth.ts')?.session_id).toBe(sessionB);

    // Second accept must fail — already accepted.
    const retry = await callError('task_accept_relay', {
      relay_observation_id,
      session_id: sessionB,
    });
    expect(retry.code).toBe(TASK_THREAD_ERROR_CODES.ALREADY_ACCEPTED);
  });

  it('task_decline_relay cancels a pending relay and prevents subsequent accept', async () => {
    const { task_id, sessionA, sessionB } = seedTwoSessionTask();

    const { relay_observation_id } = await call<{ relay_observation_id: number }>('task_relay', {
      task_id,
      session_id: sessionA,
      agent: 'claude',
      reason: 'manual',
      one_line: 'try someone else',
      base_branch: 'main',
    });

    await call('task_decline_relay', {
      relay_observation_id,
      session_id: sessionB,
      reason: 'mid-turn on another task',
    });

    const declined = store.storage.getObservation(relay_observation_id);
    const declinedMeta = JSON.parse(declined?.metadata ?? '{}') as { status: string };
    expect(declinedMeta.status).toBe('cancelled');

    // Decline must surface in the timeline so the sender's next turn
    // can render "B declined: <reason>" via the hook preface.
    const timeline = await call<Array<{ id: number; kind: string }>>('task_timeline', {
      task_id,
    });
    expect(timeline.some((r) => r.kind === 'decline')).toBe(true);

    const error = await callError('task_accept_relay', {
      relay_observation_id,
      session_id: sessionB,
    });
    expect(error.code).toBe(TASK_THREAD_ERROR_CODES.ALREADY_CANCELLED);
  });

  it('task_accept_relay refuses an agent the relay was not addressed to', async () => {
    const { task_id, sessionA, sessionB } = seedTwoSessionTask();
    // Add a third participant whose agent is neither sender nor target.
    store.startSession({ id: 'C', ide: 'gemini', cwd: '/repo' });
    const thread = TaskThread.open(store, {
      repo_root: '/repo',
      branch: 'feat/handoff',
      session_id: 'C',
    });
    thread.join('C', 'gemini');

    const { relay_observation_id } = await call<{ relay_observation_id: number }>('task_relay', {
      task_id,
      session_id: sessionA,
      agent: 'claude',
      reason: 'quota',
      one_line: 'codex only',
      base_branch: 'main',
      to_agent: 'codex',
    });

    const refused = await callError('task_accept_relay', {
      relay_observation_id,
      session_id: 'C',
    });
    expect(refused.code).toBe(TASK_THREAD_ERROR_CODES.NOT_TARGET_AGENT);

    // The targeted session can still accept — proves the directed relay
    // wasn't accidentally invalidated by the wrong-agent attempt.
    const accepted = await call<{ status: string }>('task_accept_relay', {
      relay_observation_id,
      session_id: sessionB,
    });
    expect(accepted.status).toBe('accepted');
  });

  it('task_accept_relay rejects expired relays and flips status to expired', async () => {
    const { task_id, sessionA, sessionB } = seedTwoSessionTask();

    const { relay_observation_id } = await call<{ relay_observation_id: number }>('task_relay', {
      task_id,
      session_id: sessionA,
      agent: 'claude',
      reason: 'turn-cap',
      one_line: 'stale by design',
      base_branch: 'main',
      expires_in_minutes: 1,
    });

    // Fake-timers would race the MCP transport, so force expiry by
    // back-dating the metadata directly — same shape as the existing
    // handoff-expiry test above.
    const before = store.storage.getObservation(relay_observation_id);
    const meta = JSON.parse(before?.metadata ?? '{}') as { expires_at: number };
    meta.expires_at = Date.now() - 1000;
    store.storage.updateObservationMetadata(relay_observation_id, JSON.stringify(meta));

    const error = await callError('task_accept_relay', {
      relay_observation_id,
      session_id: sessionB,
    });
    expect(error.code).toBe(TASK_THREAD_ERROR_CODES.RELAY_EXPIRED);

    // The acceptance attempt must persist the terminal `expired` status
    // so the relay doesn't keep advertising itself as `pending` to other
    // recipients after expiry.
    const after = store.storage.getObservation(relay_observation_id);
    const afterMeta = JSON.parse(after?.metadata ?? '{}');
    expect(afterMeta.status).toBe('expired');
  });
});
