import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/memory-store.js';
import { TaskThread, type WakeRequestMetadata } from '../src/task-thread.js';

let dir: string;
let store: MemoryStore;

function seed(...ids: string[]): void {
  for (const id of ids) {
    store.startSession({ id, ide: 'claude-code', cwd: '/r' });
  }
}

function openThread(session_id: string): TaskThread {
  return TaskThread.open(store, {
    repo_root: '/r',
    branch: 'feat/wake',
    session_id,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'colony-wake-request-'));
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('TaskThread wake requests', () => {
  it('requestWake records a pending wake with structured metadata', () => {
    seed('claude', 'codex');
    const thread = openThread('claude');
    thread.join('claude', 'claude');
    thread.join('codex', 'codex');

    const id = thread.requestWake({
      from_session_id: 'claude',
      from_agent: 'claude',
      to_agent: 'codex',
      reason: 'PR review stuck, need your eyes',
      next_step: 'open PR #42 and leave inline comments',
    });

    const row = store.storage.getObservation(id);
    expect(row?.kind).toBe('wake_request');
    expect(row?.task_id).toBe(thread.task_id);
    const meta = JSON.parse(row?.metadata ?? '{}') as WakeRequestMetadata;
    expect(meta.kind).toBe('wake_request');
    expect(meta.status).toBe('pending');
    expect(meta.to_agent).toBe('codex');
    expect(meta.reason).toBe('PR review stuck, need your eyes');
    expect(meta.next_step).toBe('open PR #42 and leave inline comments');
    expect(meta.expires_at).toBeGreaterThan(Date.now());
  });

  it('pendingWakesFor hides the sender and expired/cancelled wakes', () => {
    seed('claude', 'codex');
    const thread = openThread('claude');
    thread.join('claude', 'claude');
    thread.join('codex', 'codex');

    const fresh = thread.requestWake({
      from_session_id: 'claude',
      from_agent: 'claude',
      to_agent: 'any',
      reason: 'fresh',
    });
    const stale = thread.requestWake({
      from_session_id: 'claude',
      from_agent: 'claude',
      to_agent: 'any',
      reason: 'stale',
    });
    // Force expiry on the stale wake.
    const row = store.storage.getObservation(stale);
    const meta = JSON.parse(row?.metadata ?? '{}') as WakeRequestMetadata;
    meta.expires_at = Date.now() - 1000;
    store.storage.updateObservationMetadata(stale, JSON.stringify(meta));

    expect(thread.pendingWakesFor('codex', 'codex').map((w) => w.id)).toEqual([fresh]);
    expect(thread.pendingWakesFor('claude', 'claude')).toHaveLength(0);
  });

  it('acknowledgeWake flips status, records ack observation, sender sees it next turn', () => {
    seed('claude', 'codex');
    const thread = openThread('claude');
    thread.join('claude', 'claude');
    thread.join('codex', 'codex');

    const wakeId = thread.requestWake({
      from_session_id: 'claude',
      from_agent: 'claude',
      to_agent: 'codex',
      reason: 'please check the migration',
    });
    thread.acknowledgeWake(wakeId, 'codex');

    const row = store.storage.getObservation(wakeId);
    const meta = JSON.parse(row?.metadata ?? '{}') as WakeRequestMetadata;
    expect(meta.status).toBe('acknowledged');
    expect(meta.acknowledged_by_session_id).toBe('codex');
    expect(meta.acknowledged_at).toBeGreaterThan(0);

    // Second ack is rejected — status is terminal.
    expect(() => thread.acknowledgeWake(wakeId, 'codex')).toThrow(/acknowledged|pending/);

    // An ack observation exists on the thread so the sender's
    // UserPromptSubmit preface can render "codex acked wake #…".
    const timeline = store.storage.taskTimeline(thread.task_id, 50);
    expect(timeline.some((o) => o.kind === 'wake_ack')).toBe(true);
  });

  it('acknowledgeWake rejects a mismatched agent when wake is addressed to specific agent', () => {
    seed('claude', 'codex', 'intruder');
    const thread = openThread('claude');
    thread.join('claude', 'claude');
    thread.join('codex', 'codex');
    thread.join('intruder', 'intruder-agent');

    const wakeId = thread.requestWake({
      from_session_id: 'claude',
      from_agent: 'claude',
      to_agent: 'codex',
      reason: 'please check the migration',
    });
    expect(() => thread.acknowledgeWake(wakeId, 'intruder')).toThrow(/codex/);
    thread.acknowledgeWake(wakeId, 'codex');
  });

  it('cancelWake flips status to cancelled and records a note', () => {
    seed('claude', 'codex');
    const thread = openThread('claude');
    thread.join('claude', 'claude');
    thread.join('codex', 'codex');

    const wakeId = thread.requestWake({
      from_session_id: 'claude',
      from_agent: 'claude',
      to_agent: 'codex',
      reason: 'nevermind, resolved',
    });
    thread.cancelWake(wakeId, 'claude', 'resolved offline');

    const row = store.storage.getObservation(wakeId);
    const meta = JSON.parse(row?.metadata ?? '{}') as WakeRequestMetadata;
    expect(meta.status).toBe('cancelled');
    expect(() => thread.acknowledgeWake(wakeId, 'codex')).toThrow(/cancelled|pending/);
  });
});
