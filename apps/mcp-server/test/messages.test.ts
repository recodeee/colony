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

function seedTwoSessionTask(): { task_id: number; sessionA: string; sessionB: string } {
  store.startSession({ id: 'A', ide: 'claude-code', cwd: '/repo' });
  store.startSession({ id: 'B', ide: 'codex', cwd: '/repo' });
  const thread = TaskThread.open(store, {
    repo_root: '/repo',
    branch: 'feat/messages',
    session_id: 'A',
  });
  thread.join('A', 'claude');
  thread.join('B', 'codex');
  return { task_id: thread.task_id, sessionA: 'A', sessionB: 'B' };
}

function seedThreeSessionTask(): {
  task_id: number;
  sessionA: string;
  sessionB: string;
  sessionC: string;
} {
  store.startSession({ id: 'A', ide: 'claude-code', cwd: '/repo' });
  store.startSession({ id: 'B', ide: 'codex', cwd: '/repo' });
  store.startSession({ id: 'C', ide: 'claude-code', cwd: '/repo' });
  const thread = TaskThread.open(store, {
    repo_root: '/repo',
    branch: 'feat/broadcast',
    session_id: 'A',
  });
  thread.join('A', 'claude');
  thread.join('B', 'codex');
  thread.join('C', 'claude');
  return { task_id: thread.task_id, sessionA: 'A', sessionB: 'B', sessionC: 'C' };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'colony-task-messages-'));
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

describe('task threads — direct messages', () => {
  it('round-trip: A sends → B sees in inbox → B marks read → B replies → parent flips to replied', async () => {
    const { task_id, sessionA, sessionB } = seedTwoSessionTask();

    const { message_observation_id, status } = await call<{
      message_observation_id: number;
      status: string;
    }>('task_message', {
      task_id,
      session_id: sessionA,
      agent: 'claude',
      to_agent: 'codex',
      content: 'can you re-run the typecheck on your branch?',
      urgency: 'needs_reply',
    });
    expect(status).toBe('unread');

    // B's inbox surfaces the message with the right urgency.
    const bInbox = await call<
      Array<{ id: number; urgency: string; status: string; from_agent: string }>
    >('task_messages', {
      session_id: sessionB,
      agent: 'codex',
      unread_only: true,
    });
    const entry = bInbox.find((m) => m.id === message_observation_id);
    expect(entry?.urgency).toBe('needs_reply');
    expect(entry?.status).toBe('unread');
    expect(entry?.from_agent).toBe('claude');

    // Marking read is idempotent — two calls converge on 'read'.
    const { status: afterRead } = await call<{ status: string }>('task_message_mark_read', {
      message_observation_id,
      session_id: sessionB,
    });
    expect(afterRead).toBe('read');
    const { status: afterReRead } = await call<{ status: string }>('task_message_mark_read', {
      message_observation_id,
      session_id: sessionB,
    });
    expect(afterReRead).toBe('read');

    // B replies. Parent must flip to 'replied' atomically on the send, not
    // on a later fetch — if it didn't, a third agent could see both the
    // original still-live and the reply at the same time.
    const { message_observation_id: replyId } = await call<{ message_observation_id: number }>(
      'task_message',
      {
        task_id,
        session_id: sessionB,
        agent: 'codex',
        to_agent: 'claude',
        content: 'yep, clean.',
        reply_to: message_observation_id,
      },
    );

    const parentRow = store.storage.getObservation(message_observation_id);
    const parentMeta = JSON.parse(parentRow?.metadata ?? '{}');
    expect(parentMeta.status).toBe('replied');
    expect(parentMeta.replied_by_observation_id).toBe(replyId);
    expect(typeof parentMeta.replied_at).toBe('number');

    // Inbox sanity: B's own reply must not bounce back into B's inbox, and
    // A's inbox should surface the reply — addressed by to_agent='claude'.
    const bInboxAfter = await call<Array<{ id: number }>>('task_messages', {
      session_id: sessionB,
      agent: 'codex',
    });
    expect(bInboxAfter.find((m) => m.id === replyId)).toBeUndefined();

    const aInbox = await call<Array<{ id: number; from_agent: string }>>('task_messages', {
      session_id: sessionA,
      agent: 'claude',
    });
    expect(aInbox.find((m) => m.id === replyId)?.from_agent).toBe('codex');
  });

  it('broadcast (to_agent=any) reaches every non-sender participant', async () => {
    const { task_id, sessionA, sessionB, sessionC } = seedThreeSessionTask();

    const { message_observation_id } = await call<{ message_observation_id: number }>(
      'task_message',
      {
        task_id,
        session_id: sessionA,
        agent: 'claude',
        to_agent: 'any',
        content: 'anyone free to take the migration review?',
        urgency: 'fyi',
      },
    );

    for (const [session_id, agent] of [
      [sessionB, 'codex'],
      [sessionC, 'claude'],
    ] as const) {
      const inbox = await call<Array<{ id: number; to_agent: string }>>('task_messages', {
        session_id,
        agent,
        task_ids: [task_id],
      });
      const found = inbox.find((m) => m.id === message_observation_id);
      expect(found?.to_agent).toBe('any');
    }

    // Sender never sees their own broadcast.
    const senderInbox = await call<Array<{ id: number }>>('task_messages', {
      session_id: sessionA,
      agent: 'claude',
      task_ids: [task_id],
    });
    expect(senderInbox.find((m) => m.id === message_observation_id)).toBeUndefined();
  });

  it('task_message defaults four-arg calls to fyi broadcasts', async () => {
    const { task_id, sessionA, sessionB, sessionC } = seedThreeSessionTask();

    const { message_observation_id, status } = await call<{
      message_observation_id: number;
      status: string;
    }>('task_message', {
      task_id,
      session_id: sessionA,
      agent: 'claude',
      content: 'default broadcast shape',
    });
    expect(status).toBe('unread');

    const meta = JSON.parse(store.storage.getObservation(message_observation_id)?.metadata ?? '{}');
    expect(meta.to_agent).toBe('any');
    expect(meta.urgency).toBe('fyi');

    for (const [session_id, agent] of [
      [sessionB, 'codex'],
      [sessionC, 'claude'],
    ] as const) {
      const inbox = await call<Array<{ id: number; to_agent: string; urgency: string }>>(
        'task_messages',
        {
          session_id,
          agent,
          task_ids: [task_id],
        },
      );
      const found = inbox.find((m) => m.id === message_observation_id);
      expect(found?.to_agent).toBe('any');
      expect(found?.urgency).toBe('fyi');
    }
  });

  it('to_session_id routes only to the target session, not every matching-agent participant', async () => {
    const { task_id, sessionA, sessionB, sessionC } = seedThreeSessionTask();
    store.startSession({ id: 'D', ide: 'claude-code', cwd: '/repo' });
    new TaskThread(store, task_id).join('D', 'claude');

    const { message_observation_id } = await call<{ message_observation_id: number }>(
      'task_message',
      {
        task_id,
        session_id: sessionA,
        agent: 'claude',
        // to_agent=claude is the default agent class for both A and C, but
        // to_session_id narrows delivery to C only.
        to_agent: 'claude',
        to_session_id: sessionC,
        content: 'C, can you pair on this?',
      },
    );

    const cInbox = await call<Array<{ id: number }>>('task_messages', {
      session_id: sessionC,
      agent: 'claude',
    });
    expect(cInbox.find((m) => m.id === message_observation_id)).toBeDefined();

    const bInbox = await call<Array<{ id: number }>>('task_messages', {
      session_id: sessionB,
      agent: 'codex',
    });
    expect(bInbox.find((m) => m.id === message_observation_id)).toBeUndefined();

    const dInbox = await call<Array<{ id: number }>>('task_messages', {
      session_id: 'D',
      agent: 'claude',
    });
    expect(dInbox.find((m) => m.id === message_observation_id)).toBeUndefined();
    expect(new TaskThread(store, task_id).pendingMessagesFor('D', 'claude')).toHaveLength(0);
  });

  it('task_ids cannot expose messages from tasks the caller has not joined', async () => {
    const { sessionA, sessionB } = seedTwoSessionTask();
    store.startSession({ id: 'C', ide: 'codex', cwd: '/repo' });
    const privateThread = TaskThread.open(store, {
      repo_root: '/repo',
      branch: 'feat/private',
      session_id: sessionA,
    });
    privateThread.join(sessionA, 'claude');
    privateThread.join('C', 'codex');

    const { message_observation_id } = await call<{ message_observation_id: number }>(
      'task_message',
      {
        task_id: privateThread.task_id,
        session_id: sessionA,
        agent: 'claude',
        to_agent: 'codex',
        content: 'private codex-only task details',
      },
    );

    const outsiderInbox = await call<Array<{ id: number }>>('task_messages', {
      session_id: sessionB,
      agent: 'codex',
      task_ids: [privateThread.task_id],
    });
    expect(outsiderInbox.find((m) => m.id === message_observation_id)).toBeUndefined();

    const participantInbox = await call<Array<{ id: number }>>('task_messages', {
      session_id: 'C',
      agent: 'codex',
      task_ids: [privateThread.task_id],
    });
    expect(participantInbox.find((m) => m.id === message_observation_id)).toBeDefined();
  });

  it('since_ts cursor filters out older messages', async () => {
    const { task_id, sessionA, sessionB } = seedTwoSessionTask();

    const { message_observation_id: firstId } = await call<{ message_observation_id: number }>(
      'task_message',
      {
        task_id,
        session_id: sessionA,
        agent: 'claude',
        to_agent: 'codex',
        content: 'first',
      },
    );

    // Wait one ms to guarantee monotonic ts even on fast clocks.
    const cursor = Date.now() + 1;
    await new Promise((r) => setTimeout(r, 2));

    const { message_observation_id: secondId } = await call<{ message_observation_id: number }>(
      'task_message',
      {
        task_id,
        session_id: sessionA,
        agent: 'claude',
        to_agent: 'codex',
        content: 'second',
      },
    );

    const scoped = await call<Array<{ id: number }>>('task_messages', {
      session_id: sessionB,
      agent: 'codex',
      since_ts: cursor,
    });
    expect(scoped.find((m) => m.id === secondId)).toBeDefined();
    expect(scoped.find((m) => m.id === firstId)).toBeUndefined();
  });

  it('reply_to pointing at a foreign-task message does not flip that message to replied', async () => {
    // Task 1: A sends to B.
    const { task_id: task1, sessionA, sessionB } = seedTwoSessionTask();
    const { message_observation_id: foreignId } = await call<{ message_observation_id: number }>(
      'task_message',
      {
        task_id: task1,
        session_id: sessionA,
        agent: 'claude',
        to_agent: 'codex',
        content: 'on task 1',
      },
    );

    // Task 2 in the same DB: A starts a new task and posts a reply_to that
    // points at the task-1 message. The guard must refuse to mutate the
    // foreign parent — otherwise a caller could flip any message to
    // 'replied' just by knowing its id.
    const task2 = TaskThread.open(store, {
      repo_root: '/repo',
      branch: 'feat/other',
      session_id: sessionA,
    });
    task2.join(sessionA, 'claude');
    task2.join(sessionB, 'codex');

    await call('task_message', {
      task_id: task2.task_id,
      session_id: sessionA,
      agent: 'claude',
      to_agent: 'codex',
      content: 'reply attempt',
      reply_to: foreignId,
    });

    const foreignRow = store.storage.getObservation(foreignId);
    const foreignMeta = JSON.parse(foreignRow?.metadata ?? '{}');
    expect(foreignMeta.status).toBe('unread');
    expect(foreignMeta.replied_by_observation_id).toBeNull();
  });

  it('mark_read on a non-message observation returns NOT_MESSAGE', async () => {
    const { task_id, sessionA, sessionB } = seedTwoSessionTask();

    // Post a regular note — same storage path, different kind.
    const { id: noteId } = await call<{ id: number }>('task_post', {
      task_id,
      session_id: sessionA,
      kind: 'note',
      content: 'just a note',
    });

    const err = await callError('task_message_mark_read', {
      message_observation_id: noteId,
      session_id: sessionB,
    });
    expect(err.code).toBe(TASK_THREAD_ERROR_CODES.NOT_MESSAGE);
  });

  it('mark_read rejects non-participants and non-recipients without clearing unread status', async () => {
    const { task_id, sessionA, sessionB, sessionC } = seedThreeSessionTask();

    const { message_observation_id } = await call<{ message_observation_id: number }>(
      'task_message',
      {
        task_id,
        session_id: sessionA,
        agent: 'claude',
        to_agent: 'claude',
        to_session_id: sessionC,
        content: 'targeted to session C only',
      },
    );

    const wrongParticipant = await callError('task_message_mark_read', {
      message_observation_id,
      session_id: sessionB,
    });
    expect(wrongParticipant.code).toBe(TASK_THREAD_ERROR_CODES.NOT_TARGET_SESSION);

    store.startSession({ id: 'outsider', ide: 'codex', cwd: '/repo' });
    const outsider = await callError('task_message_mark_read', {
      message_observation_id,
      session_id: 'outsider',
    });
    expect(outsider.code).toBe(TASK_THREAD_ERROR_CODES.NOT_PARTICIPANT);

    const meta = JSON.parse(store.storage.getObservation(message_observation_id)?.metadata ?? '{}');
    expect(meta.status).toBe('unread');
    expect(meta.read_by_session_id).toBeNull();

    const target = await call<{ status: string }>('task_message_mark_read', {
      message_observation_id,
      session_id: sessionC,
    });
    expect(target.status).toBe('read');
  });

  it('expires_in_minutes hides past-TTL messages from unread_only and blocks mark_read', async () => {
    const { task_id, sessionA, sessionB } = seedTwoSessionTask();
    const { message_observation_id } = await call<{ message_observation_id: number }>(
      'task_message',
      {
        task_id,
        session_id: sessionA,
        agent: 'claude',
        to_agent: 'codex',
        content: 'short-lived',
        urgency: 'fyi',
        expires_in_minutes: 1,
      },
    );

    // Push expires_at into the past to simulate elapsed TTL.
    const row = store.storage.getObservation(message_observation_id);
    const meta = JSON.parse(row?.metadata ?? '{}') as { expires_at: number };
    meta.expires_at = Date.now() - 1000;
    store.storage.updateObservationMetadata(message_observation_id, JSON.stringify(meta));

    const inbox = await call<Array<{ id: number; status: string }>>('task_messages', {
      session_id: sessionB,
      agent: 'codex',
      unread_only: true,
    });
    expect(inbox.find((m) => m.id === message_observation_id)).toBeUndefined();

    const audit = await call<Array<{ id: number; status: string }>>('task_messages', {
      session_id: sessionB,
      agent: 'codex',
      task_ids: [task_id],
      unread_only: false,
    });
    expect(audit.find((m) => m.id === message_observation_id)?.status).toBe('expired');

    const err = await callError('task_message_mark_read', {
      message_observation_id,
      session_id: sessionB,
    });
    expect(err.code).toBe(TASK_THREAD_ERROR_CODES.MESSAGE_EXPIRED);

    const retry = await callError('task_message_mark_read', {
      message_observation_id,
      session_id: sessionB,
    });
    expect(retry.code).toBe(TASK_THREAD_ERROR_CODES.MESSAGE_EXPIRED);

    const afterMeta = JSON.parse(
      store.storage.getObservation(message_observation_id)?.metadata ?? '{}',
    );
    expect(afterMeta.status).toBe('expired');
  });

  it('task_message_retract hides body from recipients but FTS still indexes it', async () => {
    const { task_id, sessionA, sessionB } = seedTwoSessionTask();
    const { message_observation_id } = await call<{ message_observation_id: number }>(
      'task_message',
      {
        task_id,
        session_id: sessionA,
        agent: 'claude',
        to_agent: 'codex',
        content: 'unique-needle-token-for-fts',
      },
    );

    const before = await call<Array<{ id: number }>>('task_messages', {
      session_id: sessionB,
      agent: 'codex',
    });
    expect(before.find((m) => m.id === message_observation_id)).toBeDefined();

    const { status } = await call<{ status: string }>('task_message_retract', {
      message_observation_id,
      session_id: sessionA,
      reason: 'duplicate',
    });
    expect(status).toBe('retracted');

    const after = await call<Array<{ id: number }>>('task_messages', {
      session_id: sessionB,
      agent: 'codex',
    });
    expect(after.find((m) => m.id === message_observation_id)).toBeUndefined();

    // Body still findable via FTS.
    const hits = store.storage.searchFts('"unique-needle-token-for-fts"');
    expect(hits.find((h) => h.id === message_observation_id)).toBeDefined();
  });

  it('task_message_retract refuses non-senders with NOT_SENDER', async () => {
    const { task_id, sessionA, sessionB } = seedTwoSessionTask();
    const { message_observation_id } = await call<{ message_observation_id: number }>(
      'task_message',
      {
        task_id,
        session_id: sessionA,
        agent: 'claude',
        to_agent: 'codex',
        content: 'mine to retract',
      },
    );
    const err = await callError('task_message_retract', {
      message_observation_id,
      session_id: sessionB,
    });
    expect(err.code).toBe(TASK_THREAD_ERROR_CODES.NOT_SENDER);
  });

  it('task_message_claim hides broadcast from non-claimers and rejects directed messages', async () => {
    const { task_id, sessionA, sessionB, sessionC } = seedThreeSessionTask();
    const { message_observation_id } = await call<{ message_observation_id: number }>(
      'task_message',
      {
        task_id,
        session_id: sessionA,
        agent: 'claude',
        to_agent: 'any',
        content: 'broadcast for claim',
      },
    );

    // Pre-claim: B and C both see it.
    expect(
      (
        await call<Array<{ id: number; is_claimable_broadcast: boolean }>>('task_messages', {
          session_id: sessionB,
          agent: 'codex',
          task_ids: [task_id],
        })
      ).find((m) => m.id === message_observation_id)?.is_claimable_broadcast,
    ).toBe(true);

    const claim = await call<{ status: string; claimed_by_session_id: string }>(
      'task_message_claim',
      {
        message_observation_id,
        session_id: sessionB,
        agent: 'codex',
      },
    );
    expect(claim.status).toBe('claimed');
    expect(claim.claimed_by_session_id).toBe(sessionB);

    // C no longer sees the broadcast in their inbox.
    const cInbox = await call<Array<{ id: number }>>('task_messages', {
      session_id: sessionC,
      agent: 'claude',
      task_ids: [task_id],
    });
    expect(cInbox.find((m) => m.id === message_observation_id)).toBeUndefined();

    // Second claimer rejected with ALREADY_CLAIMED.
    const dupe = await callError('task_message_claim', {
      message_observation_id,
      session_id: sessionC,
      agent: 'claude',
    });
    expect(dupe.code).toBe(TASK_THREAD_ERROR_CODES.ALREADY_CLAIMED);

    // Directed message can't be claimed.
    const { message_observation_id: directedId } = await call<{ message_observation_id: number }>(
      'task_message',
      {
        task_id,
        session_id: sessionA,
        agent: 'claude',
        to_agent: 'codex',
        content: 'directed',
      },
    );
    const notBroadcast = await callError('task_message_claim', {
      message_observation_id: directedId,
      session_id: sessionB,
      agent: 'codex',
    });
    expect(notBroadcast.code).toBe(TASK_THREAD_ERROR_CODES.NOT_BROADCAST);
  });
});
