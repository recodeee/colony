import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/memory-store.js';
import { TaskThread } from '../src/task-thread.js';

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
    expect(() => thread.acceptHandoff(handoffId, 'codex')).toThrow(
      /not a handoff|accepted|pending/,
    );
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
    expect(() => thread.acceptHandoff(handoffId, 'codex')).toThrow(/cancelled|pending/);
  });
});
