import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyClaimAge } from '../src/claim-age.js';
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
  vi.useRealTimers();
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

  it('computes expiry for legacy handoffs missing expires_at', () => {
    seed('claude', 'codex');
    const thread = TaskThread.open(store, {
      repo_root: '/r',
      branch: 'legacy-handoff',
      session_id: 'claude',
    });
    thread.join('claude', 'claude');
    thread.join('codex', 'codex');

    const oldTs = Date.now() - 3 * 60 * 60_000;
    const legacyId = store.storage.insertObservation({
      session_id: 'claude',
      kind: 'handoff',
      content: 'legacy handoff without expires_at',
      compressed: false,
      intensity: null,
      ts: oldTs,
      task_id: thread.task_id,
      reply_to: null,
      metadata: {
        kind: 'handoff',
        from_session_id: 'claude',
        from_agent: 'claude',
        to_agent: 'codex',
        to_session_id: null,
        summary: 'old row',
        next_steps: [],
        blockers: [],
        released_files: [],
        transferred_files: [],
        status: 'pending',
        accepted_by_session_id: null,
        accepted_at: null,
      },
    });

    expect(thread.pendingHandoffsFor('codex', 'codex')).toHaveLength(0);

    try {
      thread.acceptHandoff(legacyId, 'codex');
      throw new Error('expected HANDOFF_EXPIRED');
    } catch (err) {
      expect(err).toBeInstanceOf(TaskThreadError);
      expect((err as TaskThreadError).code).toBe(TASK_THREAD_ERROR_CODES.HANDOFF_EXPIRED);
    }

    const after = store.storage.getObservation(legacyId);
    const meta = JSON.parse(after?.metadata ?? '{}') as { expires_at: number; status: string };
    expect(meta.status).toBe('expired');
    expect(meta.expires_at).toBe(oldTs + 2 * 60 * 60_000);
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

  it('relay weakens sender claims at emit and re-claims them on accept', () => {
    seed('claude', 'codex');
    const thread = TaskThread.open(store, {
      repo_root: '/r',
      branch: 'feat/relay',
      session_id: 'claude',
    });
    thread.join('claude', 'claude');
    thread.join('codex', 'codex');
    thread.claimFile({ session_id: 'claude', file_path: 'src/api/tasks.ts' });
    thread.claimFile({ session_id: 'claude', file_path: 'src/viewer.tsx' });

    const relayId = thread.relay({
      from_session_id: 'claude',
      from_agent: 'claude',
      reason: 'quota',
      one_line: 'halfway through replacing auth middleware',
      base_branch: 'main',
    });

    expect(store.storage.getClaim(thread.task_id, 'src/api/tasks.ts')).toMatchObject({
      session_id: 'claude',
      state: 'handoff_pending',
      handoff_observation_id: relayId,
    });
    expect(store.storage.getClaim(thread.task_id, 'src/viewer.tsx')).toMatchObject({
      session_id: 'claude',
      state: 'handoff_pending',
      handoff_observation_id: relayId,
    });

    // Snapshot of metadata: inherit_claims captured both files at emit; the
    // receiver re-claims them through that recipe.
    const row = store.storage.getObservation(relayId);
    const meta = JSON.parse(row?.metadata ?? '{}') as {
      worktree_recipe: { inherit_claims: string[]; fetch_files_at: string | null };
      expires_at: number;
    };
    expect(meta.worktree_recipe.inherit_claims.sort()).toEqual([
      'src/api/tasks.ts',
      'src/viewer.tsx',
    ]);
    expect(meta.worktree_recipe.fetch_files_at).toBeNull();
    expect(store.storage.getClaim(thread.task_id, 'src/api/tasks.ts')?.expires_at).toBe(
      meta.expires_at,
    );
    expect(store.storage.taskObservationsByKind(thread.task_id, 'claim-weakened')).toHaveLength(2);

    thread.acceptRelay(relayId, 'codex');
    expect(store.storage.getClaim(thread.task_id, 'src/api/tasks.ts')).toMatchObject({
      session_id: 'codex',
      state: 'active',
      expires_at: null,
      handoff_observation_id: null,
    });
    expect(store.storage.getClaim(thread.task_id, 'src/viewer.tsx')).toMatchObject({
      session_id: 'codex',
      state: 'active',
      expires_at: null,
      handoff_observation_id: null,
    });

    // Second accept must fail — already accepted.
    try {
      thread.acceptRelay(relayId, 'codex');
      throw new Error('expected second accept to fail');
    } catch (err) {
      expect(err).toBeInstanceOf(TaskThreadError);
      expect((err as TaskThreadError).code).toBe(TASK_THREAD_ERROR_CODES.ALREADY_ACCEPTED);
    }
  });

  it('relay does not inherit stale or expired sender claims as active ownership', () => {
    const t0 = Date.parse('2026-04-28T12:00:00.000Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0);
    seed('claude', 'codex');
    const thread = TaskThread.open(store, {
      repo_root: '/r',
      branch: 'feat/relay-stale-claims',
      session_id: 'claude',
    });
    thread.join('claude', 'claude');
    thread.join('codex', 'codex');
    thread.claimFile({ session_id: 'claude', file_path: 'src/expired.ts' });

    vi.setSystemTime(t0 + 240 * 60_000);
    thread.claimFile({ session_id: 'claude', file_path: 'src/stale.ts' });

    vi.setSystemTime(t0 + 481 * 60_000);
    thread.claimFile({ session_id: 'claude', file_path: 'src/fresh.ts' });

    const relayId = thread.relay({
      from_session_id: 'claude',
      from_agent: 'claude',
      reason: 'quota',
      one_line: 'continue only the current file',
      base_branch: 'main',
    });

    const row = store.storage.getObservation(relayId);
    const meta = JSON.parse(row?.metadata ?? '{}') as {
      resumable_state: { active_claims: Array<{ file_path: string; held_by: string }> };
      worktree_recipe: { inherit_claims: string[] };
    };
    expect(meta.resumable_state.active_claims).toEqual([
      { file_path: 'src/fresh.ts', held_by: 'claude' },
    ]);
    expect(meta.worktree_recipe.inherit_claims).toEqual(['src/fresh.ts']);

    expect(store.storage.getClaim(thread.task_id, 'src/fresh.ts')).toMatchObject({
      session_id: 'claude',
      state: 'handoff_pending',
      handoff_observation_id: relayId,
    });
    expect(store.storage.getClaim(thread.task_id, 'src/stale.ts')?.session_id).toBe('claude');
    expect(store.storage.getClaim(thread.task_id, 'src/expired.ts')?.session_id).toBe('claude');

    thread.acceptRelay(relayId, 'codex');
    expect(store.storage.getClaim(thread.task_id, 'src/fresh.ts')?.session_id).toBe('codex');
    expect(store.storage.getClaim(thread.task_id, 'src/stale.ts')?.session_id).toBe('claude');
    expect(store.storage.getClaim(thread.task_id, 'src/expired.ts')?.session_id).toBe('claude');
  });

  it('relay TTL expiry downgrades quota-pending claims without deleting history', () => {
    const t0 = Date.parse('2026-04-29T12:00:00.000Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0);
    seed('claude', 'codex');
    const thread = TaskThread.open(store, {
      repo_root: '/r',
      branch: 'feat/relay-ttl',
      session_id: 'claude',
    });
    thread.join('claude', 'claude');
    thread.join('codex', 'codex');
    thread.claimFile({ session_id: 'claude', file_path: 'src/quota.ts' });

    const relayId = thread.relay({
      from_session_id: 'claude',
      from_agent: 'claude',
      reason: 'quota',
      one_line: 'quota cut while editing quota file',
      base_branch: 'main',
      expires_in_ms: 5 * 60_000,
    });

    const pending = store.storage.getClaim(thread.task_id, 'src/quota.ts');
    expect(pending).toMatchObject({
      state: 'handoff_pending',
      handoff_observation_id: relayId,
    });
    if (!pending) throw new Error('expected pending quota claim');
    expect(classifyClaimAge(pending, { now: t0 + 4 * 60_000 }).age_class).toBe('stale');
    expect(classifyClaimAge(pending, { now: t0 + 6 * 60_000 })).toMatchObject({
      age_class: 'expired/weak',
      ownership_strength: 'weak',
      state: 'handoff_pending',
    });

    expect(store.storage.taskObservationsByKind(thread.task_id, 'claim')).toHaveLength(1);
    expect(store.storage.taskObservationsByKind(thread.task_id, 'claim-weakened')).toHaveLength(1);
    expect(store.storage.getClaim(thread.task_id, 'src/quota.ts')?.session_id).toBe('claude');
  });

  it('relay flags untracked files when fetch_files_at is omitted', () => {
    seed('claude', 'codex');
    const thread = TaskThread.open(store, {
      repo_root: '/r',
      branch: 'feat/relay',
      session_id: 'claude',
    });
    thread.join('claude', 'claude');
    thread.join('codex', 'codex');
    // Seed PostToolUse-shaped tool_use observations so synthesis picks them
    // up and treats their paths as "edited but maybe uncommitted".
    store.addObservation({
      session_id: 'claude',
      kind: 'tool_use',
      content: 'Edit input=…',
      task_id: thread.task_id,
      metadata: { tool: 'Edit', file_path: 'src/auth.ts' },
    });
    store.addObservation({
      session_id: 'claude',
      kind: 'tool_use',
      content: 'Write input=…',
      task_id: thread.task_id,
      metadata: { tool: 'Write', file_path: 'src/auth.test.ts' },
    });

    const relayId = thread.relay({
      from_session_id: 'claude',
      from_agent: 'claude',
      reason: 'turn-cap',
      one_line: 'splitting auth into modules',
      base_branch: 'main',
    });
    const row = store.storage.getObservation(relayId);
    const meta = JSON.parse(row?.metadata ?? '{}') as {
      worktree_recipe: { untracked_files_warning: string[]; fetch_files_at: string | null };
      resumable_state: { last_files_edited: Array<{ file_path: string }> };
    };
    expect(meta.worktree_recipe.fetch_files_at).toBeNull();
    expect(meta.worktree_recipe.untracked_files_warning.sort()).toEqual([
      'src/auth.test.ts',
      'src/auth.ts',
    ]);
    expect(meta.resumable_state.last_files_edited.map((e) => e.file_path).sort()).toEqual([
      'src/auth.test.ts',
      'src/auth.ts',
    ]);

    // With a sha provided, the warning is empty — receiver can reproduce
    // the tree from git.
    const relayId2 = thread.relay({
      from_session_id: 'claude',
      from_agent: 'claude',
      reason: 'turn-cap',
      one_line: 'committed split',
      base_branch: 'main',
      fetch_files_at: 'deadbeef',
    });
    const row2 = store.storage.getObservation(relayId2);
    const meta2 = JSON.parse(row2?.metadata ?? '{}') as {
      worktree_recipe: { untracked_files_warning: string[]; fetch_files_at: string | null };
    };
    expect(meta2.worktree_recipe.fetch_files_at).toBe('deadbeef');
    expect(meta2.worktree_recipe.untracked_files_warning).toEqual([]);
  });

  it('pendingRelaysFor hides the sender, expired and addressed-elsewhere relays', () => {
    seed('claude', 'codex', 'gemini');
    const thread = TaskThread.open(store, {
      repo_root: '/r',
      branch: 'feat/relay',
      session_id: 'claude',
    });
    thread.join('claude', 'claude');
    thread.join('codex', 'codex');
    thread.join('gemini', 'gemini');

    // 1. Broadcast — visible to everyone but the sender.
    const broadcastId = thread.relay({
      from_session_id: 'claude',
      from_agent: 'claude',
      reason: 'quota',
      one_line: 'broadcast',
      base_branch: 'main',
    });
    // 2. Directed to codex — invisible to gemini.
    thread.relay({
      from_session_id: 'claude',
      from_agent: 'claude',
      reason: 'quota',
      one_line: 'codex only',
      base_branch: 'main',
      to_agent: 'codex',
    });
    // 3. Already-expired relay — invisible to anyone.
    const expiredId = thread.relay({
      from_session_id: 'claude',
      from_agent: 'claude',
      reason: 'manual',
      one_line: 'stale',
      base_branch: 'main',
      expires_in_ms: 1,
    });
    // Force expiry past the TTL.
    const expiredRow = store.storage.getObservation(expiredId);
    const expiredMeta = JSON.parse(expiredRow?.metadata ?? '{}') as Record<string, unknown>;
    expiredMeta.expires_at = 1;
    store.storage.updateObservationMetadata(expiredId, JSON.stringify(expiredMeta));

    expect(thread.pendingRelaysFor('claude', 'claude')).toEqual([]); // sender hidden
    const codexInbox = thread.pendingRelaysFor('codex', 'codex').map((r) => r.id);
    expect(codexInbox).toContain(broadcastId);
    expect(codexInbox).toHaveLength(2);
    const geminiInbox = thread.pendingRelaysFor('gemini', 'gemini').map((r) => r.id);
    expect(geminiInbox).toEqual([broadcastId]); // directed-to-codex hidden
  });

  it('acceptRelay refuses agents the relay was not addressed to', () => {
    seed('claude', 'codex', 'gemini');
    const thread = TaskThread.open(store, {
      repo_root: '/r',
      branch: 'feat/relay',
      session_id: 'claude',
    });
    thread.join('claude', 'claude');
    thread.join('codex', 'codex');
    thread.join('gemini', 'gemini');
    const relayId = thread.relay({
      from_session_id: 'claude',
      from_agent: 'claude',
      reason: 'quota',
      one_line: 'codex only',
      base_branch: 'main',
      to_agent: 'codex',
    });
    try {
      thread.acceptRelay(relayId, 'gemini');
      throw new Error('expected accept to be refused');
    } catch (err) {
      expect(err).toBeInstanceOf(TaskThreadError);
      expect((err as TaskThreadError).code).toBe(TASK_THREAD_ERROR_CODES.NOT_TARGET_AGENT);
    }
  });

  it('acceptRelay returns RELAY_EXPIRED past the TTL', () => {
    seed('claude', 'codex');
    const thread = TaskThread.open(store, {
      repo_root: '/r',
      branch: 'feat/relay',
      session_id: 'claude',
    });
    thread.join('claude', 'claude');
    thread.join('codex', 'codex');
    const relayId = thread.relay({
      from_session_id: 'claude',
      from_agent: 'claude',
      reason: 'quota',
      one_line: 'time bomb',
      base_branch: 'main',
    });
    // Force expiry into the past.
    const row = store.storage.getObservation(relayId);
    const meta = JSON.parse(row?.metadata ?? '{}') as Record<string, unknown>;
    meta.expires_at = Date.now() - 1000;
    store.storage.updateObservationMetadata(relayId, JSON.stringify(meta));
    try {
      thread.acceptRelay(relayId, 'codex');
      throw new Error('expected expiry');
    } catch (err) {
      expect(err).toBeInstanceOf(TaskThreadError);
      expect((err as TaskThreadError).code).toBe(TASK_THREAD_ERROR_CODES.RELAY_EXPIRED);
    }
  });

  it('declineRelay cancels and prevents subsequent accept', () => {
    seed('claude', 'codex');
    const thread = TaskThread.open(store, {
      repo_root: '/r',
      branch: 'feat/relay',
      session_id: 'claude',
    });
    thread.join('claude', 'claude');
    thread.join('codex', 'codex');
    const relayId = thread.relay({
      from_session_id: 'claude',
      from_agent: 'claude',
      reason: 'manual',
      one_line: 'try someone else',
      base_branch: 'main',
    });
    thread.declineRelay(relayId, 'codex', 'busy on other task');
    const row = store.storage.getObservation(relayId);
    const meta = JSON.parse(row?.metadata ?? '{}') as { status: string };
    expect(meta.status).toBe('cancelled');
    try {
      thread.acceptRelay(relayId, 'codex');
      throw new Error('expected accept after decline to fail');
    } catch (err) {
      expect(err).toBeInstanceOf(TaskThreadError);
      expect((err as TaskThreadError).code).toBe(TASK_THREAD_ERROR_CODES.ALREADY_CANCELLED);
    }
  });

  it('last_handoff_summary picks the most recent baton-pass regardless of kind', () => {
    seed('claude', 'codex');
    const thread = TaskThread.open(store, {
      repo_root: '/r',
      branch: 'feat/relay',
      session_id: 'claude',
    });
    thread.join('claude', 'claude');
    thread.join('codex', 'codex');
    // Earlier handoff carries `summary`.
    thread.handOff({
      from_session_id: 'claude',
      from_agent: 'claude',
      to_agent: 'codex',
      summary: 'older summary',
    });
    // Later relay carries `one_line` — heterogeneous metadata. The newest
    // baton wins, and the field branches on kind so we don't crash trying
    // to read `summary` off a relay row.
    const relayId = thread.relay({
      from_session_id: 'codex',
      from_agent: 'codex',
      reason: 'manual',
      one_line: 'newer relay one_line',
      base_branch: 'main',
    });
    // A subsequent relay is what carries the synthesised summary back.
    const synthRelayId = thread.relay({
      from_session_id: 'claude',
      from_agent: 'claude',
      reason: 'manual',
      one_line: 'snapshot probe',
      base_branch: 'main',
    });
    expect(synthRelayId).toBeGreaterThan(relayId);
    const row = store.storage.getObservation(synthRelayId);
    const meta = JSON.parse(row?.metadata ?? '{}') as {
      resumable_state: { last_handoff_summary: string | null };
    };
    expect(meta.resumable_state.last_handoff_summary).toBe('newer relay one_line');
  });
});
