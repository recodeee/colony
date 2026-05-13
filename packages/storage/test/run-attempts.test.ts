import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RunAttemptError,
  Storage,
  createRunAttempt,
  finishRunAttempt,
  getRunAttempt,
  listRunAttemptsByTask,
  recordRunAttemptEvent,
  updateRunAttemptStatus,
} from '../src/index.js';

let dir: string;
let storage: Storage;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'colony-run-attempts-'));
  storage = new Storage(join(dir, 'test.db'));
  storage.createSession({
    id: 's-launcher',
    ide: 'claude-code',
    cwd: '/tmp',
    started_at: Date.now(),
    metadata: null,
  });
});

afterEach(() => {
  storage.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedTask(branch = 'agent/claude/x'): number {
  const task = storage.findOrCreateTask({
    title: 'run-attempt test',
    repo_root: '/repo',
    branch,
    created_by: 's-launcher',
  });
  return task.id;
}

const db = () => (storage as unknown as { db: import('better-sqlite3').Database }).db;

describe('run-attempts storage', () => {
  it('createRunAttempt assigns sequential attempt_number per (task_id, agent_id)', () => {
    const taskId = seedTask();
    const first = createRunAttempt(db(), {
      task_id: taskId,
      agent_id: 'codex',
      workspace_path: '/wt/a',
    });
    expect(first.attempt_number).toBe(1);
    expect(first.status).toBe('PreparingWorkspace');
    expect(first.input_tokens_total).toBe(0);
    expect(first.finished_at).toBeNull();

    // Same agent on a different workspace = attempt 2 (numbering is per-agent
    // not per-workspace).
    const second = createRunAttempt(db(), {
      task_id: taskId,
      agent_id: 'codex',
      workspace_path: '/wt/b',
    });
    expect(second.attempt_number).toBe(2);

    // Different agent restarts numbering.
    const claudeFirst = createRunAttempt(db(), {
      task_id: taskId,
      agent_id: 'claude',
      workspace_path: '/wt/c',
    });
    expect(claudeFirst.attempt_number).toBe(1);
  });

  it('createRunAttempt is idempotent within the 60s open window', () => {
    const taskId = seedTask();
    const a = createRunAttempt(db(), {
      task_id: taskId,
      agent_id: 'codex',
      workspace_path: '/wt/a',
    });
    const b = createRunAttempt(db(), {
      task_id: taskId,
      agent_id: 'codex',
      workspace_path: '/wt/a',
    });
    expect(b.id).toBe(a.id);
    expect(b.attempt_number).toBe(a.attempt_number);
  });

  it('updateRunAttemptStatus walks active states; rejects illegal moves', () => {
    const taskId = seedTask();
    const att = createRunAttempt(db(), {
      task_id: taskId,
      agent_id: 'codex',
      workspace_path: '/wt/a',
    });
    const stages = [
      'BuildingPrompt',
      'LaunchingAgentProcess',
      'InitializingSession',
      'StreamingTurn',
      'Finishing',
    ] as const;
    let current = att;
    for (const next of stages) {
      current = updateRunAttemptStatus(db(), current.id, next);
      expect(current.status).toBe(next);
    }
    expect(() => updateRunAttemptStatus(db(), att.id, 'NotAState' as never)).toThrow(
      RunAttemptError,
    );
  });

  it('recordRunAttemptEvent accumulates token counters and turn count', () => {
    const taskId = seedTask();
    const att = createRunAttempt(db(), {
      task_id: taskId,
      agent_id: 'codex',
      workspace_path: '/wt/a',
    });
    recordRunAttemptEvent(db(), att.id, {
      input_tokens_delta: 100,
      output_tokens_delta: 50,
      turn_count_delta: 1,
      last_event: 'tokens',
      last_event_message: 'first turn',
      occurred_at: 1_000,
    });
    recordRunAttemptEvent(db(), att.id, {
      input_tokens_delta: 200,
      output_tokens_delta: 80,
      turn_count_delta: 1,
      last_event: 'tokens',
      occurred_at: 2_000,
    });
    const r = getRunAttempt(db(), att.id);
    expect(r?.input_tokens_total).toBe(300);
    expect(r?.output_tokens_total).toBe(130);
    expect(r?.turn_count).toBe(2);
    expect(r?.last_event_at).toBe(2_000);
    expect(r?.last_event).toBe('tokens');
  });

  it('recordRunAttemptEvent can flip status_changed only without touching counters', () => {
    const taskId = seedTask();
    const att = createRunAttempt(db(), {
      task_id: taskId,
      agent_id: 'codex',
      workspace_path: '/wt/a',
    });
    recordRunAttemptEvent(db(), att.id, {
      status: 'StreamingTurn',
      last_event: 'status_changed',
    });
    const r = getRunAttempt(db(), att.id);
    expect(r?.status).toBe('StreamingTurn');
    expect(r?.input_tokens_total).toBe(0);
    expect(r?.output_tokens_total).toBe(0);
    expect(r?.turn_count).toBe(0);
  });

  it('recordRunAttemptEvent rejects on terminal attempts', () => {
    const taskId = seedTask();
    const att = createRunAttempt(db(), {
      task_id: taskId,
      agent_id: 'codex',
      workspace_path: '/wt/a',
    });
    finishRunAttempt(db(), att.id, { status: 'Succeeded' });
    expect(() =>
      recordRunAttemptEvent(db(), att.id, { input_tokens_delta: 10, last_event: 'tokens' }),
    ).toThrowError(/terminal attempt/i);
  });

  it('finishRunAttempt records terminal status + proof + double-finish rejected', () => {
    const taskId = seedTask();
    const att = createRunAttempt(db(), {
      task_id: taskId,
      agent_id: 'codex',
      workspace_path: '/wt/a',
    });
    const proof = [
      { kind: 'pr_url', value: 'https://github.com/r/r/pull/9' },
      { kind: 'merge_state', value: 'MERGED' },
    ];
    const finished = finishRunAttempt(db(), att.id, {
      status: 'Succeeded',
      finished_at: 5_000,
      proof,
    });
    expect(finished.status).toBe('Succeeded');
    expect(finished.finished_at).toBe(5_000);
    expect(finished.proof_json).toBe(JSON.stringify(proof));

    expect(() =>
      finishRunAttempt(db(), att.id, { status: 'Failed', error: 'late' }),
    ).toThrowError(/already in terminal/i);
  });

  it('finishRunAttempt requires terminal status', () => {
    const taskId = seedTask();
    const att = createRunAttempt(db(), {
      task_id: taskId,
      agent_id: 'codex',
      workspace_path: '/wt/a',
    });
    expect(() =>
      finishRunAttempt(db(), att.id, { status: 'StreamingTurn' as never }),
    ).toThrow(RunAttemptError);
  });

  it('parent_attempt_id chains retries', () => {
    const taskId = seedTask();
    const a = createRunAttempt(db(), {
      task_id: taskId,
      agent_id: 'codex',
      workspace_path: '/wt/a',
    });
    finishRunAttempt(db(), a.id, { status: 'Failed', error: 'crash' });
    const retry = createRunAttempt(db(), {
      task_id: taskId,
      agent_id: 'codex',
      workspace_path: '/wt/b',
      parent_attempt_id: a.id,
    });
    expect(retry.parent_attempt_id).toBe(a.id);
    expect(retry.attempt_number).toBe(2);
  });

  it('listRunAttemptsByTask returns rows ordered newest-first, capped by limit', () => {
    const taskId = seedTask();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const att = createRunAttempt(db(), {
        task_id: taskId,
        agent_id: `codex-${i}`,
        workspace_path: `/wt/${i}`,
        started_at: 1_000 + i,
      });
      ids.push(att.id);
    }
    const all = listRunAttemptsByTask(db(), taskId);
    expect(all.map((r) => r.id)).toEqual([ids[2], ids[1], ids[0]]);

    const top = listRunAttemptsByTask(db(), taskId, 2);
    expect(top).toHaveLength(2);
    expect(top[0]?.id).toBe(ids[2]);
  });

  it('event message is truncated to 8KB', () => {
    const taskId = seedTask();
    const att = createRunAttempt(db(), {
      task_id: taskId,
      agent_id: 'codex',
      workspace_path: '/wt/a',
    });
    const longMessage = 'x'.repeat(10_000);
    recordRunAttemptEvent(db(), att.id, {
      last_event: 'tool_call',
      last_event_message: longMessage,
    });
    const r = getRunAttempt(db(), att.id);
    expect(r?.last_event_message?.length).toBe(8192);
  });
});
