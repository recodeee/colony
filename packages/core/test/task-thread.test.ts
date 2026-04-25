import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/memory-store.js';
import { TASK_THREAD_ERROR_CODES, TaskThread, TaskThreadError } from '../src/task-thread.js';

let dir: string;
let store: MemoryStore;

function seed(...ids: string[]): void {
  for (const id of ids) {
    store.startSession({ id, ide: 'claude-code', cwd: '/r' });
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'colony-task-thread-'));
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('TaskThread', () => {
  it('open is idempotent and different sessions converge on the same task', () => {
    seed('claude', 'codex');
    const a = TaskThread.open(store, {
      repo_root: '/r',
      branch: 'feat/handoff',
      session_id: 'claude',
    });
    const b = TaskThread.open(store, {
      repo_root: '/r',
      branch: 'feat/handoff',
      session_id: 'codex',
    });
    expect(b.task_id).toBe(a.task_id);
  });

  it('join + participants tracks both sides', () => {
    seed('claude', 'codex');
    const thread = TaskThread.open(store, {
      repo_root: '/r',
      branch: 'x',
      session_id: 'claude',
    });
    thread.join('claude', 'claude');
    thread.join('codex', 'codex');
    const parts = thread.participants();
    expect(parts.map((p) => p.agent).sort()).toEqual(['claude', 'codex']);
  });

  it('post records a coordination observation with task_id + kind metadata', () => {
    seed('claude');
    const thread = TaskThread.open(store, {
      repo_root: '/r',
      branch: 'x',
      session_id: 'claude',
    });
    thread.join('claude', 'claude');
    const id = thread.post({ session_id: 'claude', kind: 'question', content: 'where is auth?' });
    const [row] = store.getObservations([id], { expand: false });
    expect(row?.task_id).toBe(thread.task_id);
    expect(row?.kind).toBe('question');
    expect(row?.metadata).toMatchObject({ kind: 'question' });
  });

  it('handoff releases + transfers claims atomically on accept', () => {
    seed('claude', 'codex');
    const thread = TaskThread.open(store, {
      repo_root: '/r',
      branch: 'feat/handoff',
      session_id: 'claude',
    });
    thread.join('claude', 'claude');
    thread.join('codex', 'codex');
    thread.claimFile({ session_id: 'claude', file_path: 'src/api/tasks.ts' });
    thread.claimFile({ session_id: 'claude', file_path: 'src/viewer.tsx' });

    const handoffId = thread.handOff({
      from_session_id: 'claude',
      from_agent: 'claude',
      to_agent: 'codex',
      summary: 'viewer done, please wire API',
      next_steps: ['wire POST /api/tasks/:id/accept'],
      blockers: ['TTL assumes server clock'],
      released_files: ['src/viewer.tsx'],
      transferred_files: ['src/api/tasks.ts'],
    });

    // Sender's released/transferred claims are already dropped pre-accept.
    // This is the "prevent a third agent from grabbing in the gap" invariant.
    expect(store.storage.getClaim(thread.task_id, 'src/viewer.tsx')).toBeUndefined();
    expect(store.storage.getClaim(thread.task_id, 'src/api/tasks.ts')).toBeUndefined();

    thread.acceptHandoff(handoffId, 'codex');
    // Transferred file is now claimed by the receiver.
    expect(store.storage.getClaim(thread.task_id, 'src/api/tasks.ts')?.session_id).toBe('codex');
    // Released file stays released.
    expect(store.storage.getClaim(thread.task_id, 'src/viewer.tsx')).toBeUndefined();

    // Second accept must fail — status is no longer pending.
    try {
      thread.acceptHandoff(handoffId, 'codex');
      throw new Error('expected second accept to fail');
    } catch (err) {
      expect(err).toBeInstanceOf(TaskThreadError);
      expect((err as TaskThreadError).code).toBe(TASK_THREAD_ERROR_CODES.ALREADY_ACCEPTED);
    }
  });

  it('handoff addressed to a specific agent refuses a mismatched agent', () => {
    seed('claude', 'codex', 'intruder');
    const thread = TaskThread.open(store, {
      repo_root: '/r',
      branch: 'x',
      session_id: 'claude',
    });
    thread.join('claude', 'claude');
    thread.join('codex', 'codex');
    thread.join('intruder', 'intruder-agent');
    const handoffId = thread.handOff({
      from_session_id: 'claude',
      from_agent: 'claude',
      to_agent: 'codex',
      summary: 'please take over',
      transferred_files: ['x.ts'],
    });
    expect(() => thread.acceptHandoff(handoffId, 'intruder')).toThrow(/codex/);
    thread.acceptHandoff(handoffId, 'codex');
    expect(store.storage.getClaim(thread.task_id, 'x.ts')?.session_id).toBe('codex');
  });

  it('handoff acceptance reports non-participants with a stable code', () => {
    seed('claude', 'outsider');
    const thread = TaskThread.open(store, {
      repo_root: '/r',
      branch: 'x',
      session_id: 'claude',
    });
    thread.join('claude', 'claude');
    const handoffId = thread.handOff({
      from_session_id: 'claude',
      from_agent: 'claude',
      to_agent: 'any',
      summary: 'please take over',
    });

    try {
      thread.acceptHandoff(handoffId, 'outsider');
      throw new Error('expected outsider accept to fail');
    } catch (err) {
      expect(err).toBeInstanceOf(TaskThreadError);
      expect((err as TaskThreadError).code).toBe(TASK_THREAD_ERROR_CODES.NOT_PARTICIPANT);
    }
  });

  it("pendingHandoffsFor hides the sender's own handoff and expired ones", () => {
    seed('claude', 'codex');
    const thread = TaskThread.open(store, {
      repo_root: '/r',
      branch: 'x',
      session_id: 'claude',
    });
    thread.join('claude', 'claude');
    thread.join('codex', 'codex');
    const fresh = thread.handOff({
      from_session_id: 'claude',
      from_agent: 'claude',
      to_agent: 'any',
      summary: 'fresh',
    });
    const expired = thread.handOff({
      from_session_id: 'claude',
      from_agent: 'claude',
      to_agent: 'any',
      summary: 'stale',
      expires_in_ms: 1,
    });
    // Force expiry.
    const row = store.storage.getObservation(expired);
    const meta = JSON.parse(row?.metadata ?? '{}') as { expires_at: number };
    meta.expires_at = Date.now() - 1000;
    store.storage.updateObservationMetadata(expired, JSON.stringify(meta));

    const codexView = thread.pendingHandoffsFor('codex', 'codex');
    expect(codexView.map((h) => h.id)).toEqual([fresh]);
    // The sender never sees their own pending handoff.
    expect(thread.pendingHandoffsFor('claude', 'claude')).toHaveLength(0);
  });

  it('postMessage(expires_in_ms) hides the message from inbox after TTL passes', () => {
    seed('claude', 'codex');
    const thread = TaskThread.open(store, {
      repo_root: '/r',
      branch: 'feat/ttl',
      session_id: 'claude',
    });
    thread.join('claude', 'claude');
    thread.join('codex', 'codex');
    const id = thread.postMessage({
      from_session_id: 'claude',
      from_agent: 'claude',
      to_agent: 'codex',
      content: 'short-lived note',
      urgency: 'fyi',
      expires_in_ms: 1,
    });

    // Pre-expire the message by rewriting expires_at into the past.
    const row = store.storage.getObservation(id);
    const meta = JSON.parse(row?.metadata ?? '{}') as { expires_at: number };
    meta.expires_at = Date.now() - 1000;
    store.storage.updateObservationMetadata(id, JSON.stringify(meta));

    expect(thread.pendingMessagesFor('codex', 'codex')).toHaveLength(0);

    // markMessageRead on a past-TTL message must throw MESSAGE_EXPIRED and
    // flip the on-disk status to 'expired'.
    try {
      thread.markMessageRead(id, 'codex');
      throw new Error('expected MESSAGE_EXPIRED');
    } catch (err) {
      expect(err).toBeInstanceOf(TaskThreadError);
      expect((err as TaskThreadError).code).toBe(TASK_THREAD_ERROR_CODES.MESSAGE_EXPIRED);
    }
    const post = JSON.parse(store.storage.getObservation(id)?.metadata ?? '{}') as {
      status: string;
    };
    expect(post.status).toBe('expired');
  });

  it('retractMessage hides the message from recipients but keeps the body searchable', () => {
    seed('claude', 'codex');
    const thread = TaskThread.open(store, {
      repo_root: '/r',
      branch: 'feat/retract',
      session_id: 'claude',
    });
    thread.join('claude', 'claude');
    thread.join('codex', 'codex');
    const id = thread.postMessage({
      from_session_id: 'claude',
      from_agent: 'claude',
      to_agent: 'codex',
      content: 'oops, ignore me',
      urgency: 'needs_reply',
    });
    expect(thread.pendingMessagesFor('codex', 'codex').map((m) => m.id)).toEqual([id]);

    thread.retractMessage(id, 'claude', 'duplicate');

    // Inbox no longer surfaces it.
    expect(thread.pendingMessagesFor('codex', 'codex')).toHaveLength(0);

    // Body remains, status='retracted', reason captured.
    const row = store.storage.getObservation(id);
    const meta = JSON.parse(row?.metadata ?? '{}') as {
      status: string;
      retract_reason: string;
      retracted_at: number;
    };
    expect(meta.status).toBe('retracted');
    expect(meta.retract_reason).toBe('duplicate');
    expect(typeof meta.retracted_at).toBe('number');
  });

  it('retractMessage refuses non-senders and replied messages', () => {
    seed('claude', 'codex');
    const thread = TaskThread.open(store, {
      repo_root: '/r',
      branch: 'feat/retract-guard',
      session_id: 'claude',
    });
    thread.join('claude', 'claude');
    thread.join('codex', 'codex');
    const id = thread.postMessage({
      from_session_id: 'claude',
      from_agent: 'claude',
      to_agent: 'codex',
      content: 'hello',
    });

    expect(() => thread.retractMessage(id, 'codex')).toThrow(/sender/i);

    // Reply turns the message replied; later retraction must fail.
    thread.postMessage({
      from_session_id: 'codex',
      from_agent: 'codex',
      to_agent: 'claude',
      content: 'ack',
      reply_to: id,
    });
    try {
      thread.retractMessage(id, 'claude');
      throw new Error('expected ALREADY_REPLIED');
    } catch (err) {
      expect(err).toBeInstanceOf(TaskThreadError);
      expect((err as TaskThreadError).code).toBe(TASK_THREAD_ERROR_CODES.ALREADY_REPLIED);
    }
  });

  it('markMessageRead writes a sibling message_read observation visible to the original sender', () => {
    seed('claude', 'codex');
    const thread = TaskThread.open(store, {
      repo_root: '/r',
      branch: 'feat/receipt',
      session_id: 'claude',
    });
    thread.join('claude', 'claude');
    thread.join('codex', 'codex');
    const id = thread.postMessage({
      from_session_id: 'claude',
      from_agent: 'claude',
      to_agent: 'codex',
      content: 'review when free',
      urgency: 'needs_reply',
    });
    thread.markMessageRead(id, 'codex');

    const reads = store.storage.taskObservationsByKind(thread.task_id, 'message_read');
    expect(reads).toHaveLength(1);
    const meta = JSON.parse(reads[0]?.metadata ?? '{}') as {
      kind: string;
      original_sender_session_id: string;
      read_message_id: number;
    };
    expect(meta.kind).toBe('message_read');
    expect(meta.original_sender_session_id).toBe('claude');
    expect(meta.read_message_id).toBe(id);
  });

  it('claimBroadcastMessage hides the broadcast from non-claimer inboxes', () => {
    seed('claude', 'codex', 'C');
    const thread = TaskThread.open(store, {
      repo_root: '/r',
      branch: 'feat/claim',
      session_id: 'claude',
    });
    thread.join('claude', 'claude');
    thread.join('codex', 'codex');
    thread.join('C', 'claude');
    const id = thread.postMessage({
      from_session_id: 'claude',
      from_agent: 'claude',
      to_agent: 'any',
      content: 'anyone want this?',
    });
    expect(thread.pendingMessagesFor('codex', 'codex').map((m) => m.id)).toEqual([id]);
    expect(thread.pendingMessagesFor('C', 'claude').map((m) => m.id)).toEqual([id]);

    thread.claimBroadcastMessage(id, 'codex', 'codex');

    expect(thread.pendingMessagesFor('codex', 'codex').map((m) => m.id)).toEqual([id]);
    expect(thread.pendingMessagesFor('C', 'claude')).toHaveLength(0);

    // Second claim from a different session is rejected.
    try {
      thread.claimBroadcastMessage(id, 'C', 'claude');
      throw new Error('expected ALREADY_CLAIMED');
    } catch (err) {
      expect(err).toBeInstanceOf(TaskThreadError);
      expect((err as TaskThreadError).code).toBe(TASK_THREAD_ERROR_CODES.ALREADY_CLAIMED);
    }

    // Idempotent for the existing claimer.
    expect(() => thread.claimBroadcastMessage(id, 'codex', 'codex')).not.toThrow();
  });

  it('claimBroadcastMessage rejects directed messages with NOT_BROADCAST', () => {
    seed('claude', 'codex');
    const thread = TaskThread.open(store, {
      repo_root: '/r',
      branch: 'feat/claim-direct',
      session_id: 'claude',
    });
    thread.join('claude', 'claude');
    thread.join('codex', 'codex');
    const id = thread.postMessage({
      from_session_id: 'claude',
      from_agent: 'claude',
      to_agent: 'codex',
      content: 'directed',
    });
    try {
      thread.claimBroadcastMessage(id, 'codex', 'codex');
      throw new Error('expected NOT_BROADCAST');
    } catch (err) {
      expect(err).toBeInstanceOf(TaskThreadError);
      expect((err as TaskThreadError).code).toBe(TASK_THREAD_ERROR_CODES.NOT_BROADCAST);
    }
  });

  it('replying to an unclaimed broadcast auto-claims it for the replier', () => {
    seed('claude', 'codex', 'C');
    const thread = TaskThread.open(store, {
      repo_root: '/r',
      branch: 'feat/auto-claim',
      session_id: 'claude',
    });
    thread.join('claude', 'claude');
    thread.join('codex', 'codex');
    thread.join('C', 'claude');
    const id = thread.postMessage({
      from_session_id: 'claude',
      from_agent: 'claude',
      to_agent: 'any',
      content: 'who can pair?',
    });
    thread.postMessage({
      from_session_id: 'codex',
      from_agent: 'codex',
      to_agent: 'claude',
      content: "I'll take it",
      reply_to: id,
    });
    const meta = JSON.parse(store.storage.getObservation(id)?.metadata ?? '{}') as {
      status: string;
      claimed_by_session_id: string | null;
      claimed_by_agent: string | null;
    };
    expect(meta.status).toBe('replied');
    expect(meta.claimed_by_session_id).toBe('codex');
    expect(meta.claimed_by_agent).toBe('codex');
    // Other agents no longer see the broadcast — the reply itself is a
    // separate message and may still be in C's inbox, but the broadcast id
    // must be gone (status flipped, claim recorded).
    expect(thread.pendingMessagesFor('C', 'claude').find((m) => m.id === id)).toBeUndefined();
  });

  it('legacy message rows (no expires_at/claimed_by_* fields) still surface in pendingMessagesFor', () => {
    seed('claude', 'codex');
    const thread = TaskThread.open(store, {
      repo_root: '/r',
      branch: 'feat/legacy',
      session_id: 'claude',
    });
    thread.join('claude', 'claude');
    thread.join('codex', 'codex');
    // Mint a row directly with the *pre-overhaul* metadata shape — keys
    // expires_at/claimed_by_*/retracted_at/retract_reason absent. The
    // parseMessage helper must default these to null so the visibility
    // predicates don't read them as ALREADY_CLAIMED or hidden-broadcast.
    const id = store.addObservation({
      session_id: 'claude',
      kind: 'message',
      content: 'pre-overhaul broadcast',
      task_id: thread.task_id,
      metadata: {
        kind: 'message',
        from_session_id: 'claude',
        from_agent: 'claude',
        to_agent: 'any',
        to_session_id: null,
        urgency: 'fyi',
        status: 'unread',
        read_by_session_id: null,
        read_at: null,
        replied_by_observation_id: null,
        replied_at: null,
      },
    });
    const codexView = thread.pendingMessagesFor('codex', 'codex');
    expect(codexView.map((m) => m.id)).toEqual([id]);
    // Legacy directed message also passes the claim filter (claimed_by_*
    // defaults to null, so isVisibleToBroadcastClaimant short-circuits).
    expect(() => thread.claimBroadcastMessage(id, 'codex', 'codex')).not.toThrow();
  });

  it('declineHandoff cancels the handoff and records a note', () => {
    seed('claude', 'codex');
    const thread = TaskThread.open(store, {
      repo_root: '/r',
      branch: 'x',
      session_id: 'claude',
    });
    thread.join('claude', 'claude');
    thread.join('codex', 'codex');
    const handoffId = thread.handOff({
      from_session_id: 'claude',
      from_agent: 'claude',
      to_agent: 'codex',
      summary: 'please take this',
    });
    thread.declineHandoff(handoffId, 'codex', 'wrong agent for this');
    const row = store.storage.getObservation(handoffId);
    const meta = JSON.parse(row?.metadata ?? '{}') as { status: string };
    expect(meta.status).toBe('cancelled');
    // Accept after decline must fail.
    try {
      thread.acceptHandoff(handoffId, 'codex');
      throw new Error('expected accept after decline to fail');
    } catch (err) {
      expect(err).toBeInstanceOf(TaskThreadError);
      expect((err as TaskThreadError).code).toBe(TASK_THREAD_ERROR_CODES.ALREADY_CANCELLED);
    }
  });
});
