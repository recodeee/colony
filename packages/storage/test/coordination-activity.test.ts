import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage, classifyTool } from '../src/index.js';

let dir: string;
let storage: Storage;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'colony-coordination-'));
  storage = new Storage(join(dir, 'test.db'));
});

afterEach(() => {
  vi.useRealTimers();
  storage.close();
  rmSync(dir, { recursive: true, force: true });
});

function session(id: string, started_at = 1): void {
  storage.createSession({ id, ide: 'codex', cwd: '/repo', started_at, metadata: null });
}

function toolUse(session_id: string, tool: string, ts: number, file_path?: string): void {
  storage.insertObservation({
    session_id,
    kind: 'tool_use',
    content: `${tool} call`,
    compressed: false,
    intensity: null,
    ts,
    metadata: file_path ? { tool, file_path } : { tool },
  });
}

function claim(session_id: string, file_path: string, ts: number): void {
  storage.insertObservation({
    session_id,
    kind: 'claim',
    content: `claim ${file_path}`,
    compressed: false,
    intensity: null,
    ts,
    metadata: { kind: 'claim', file_path },
  });
}

describe('tool classification', () => {
  it('classifies coordination and edit tools from the central taxonomy', () => {
    expect(classifyTool('mcp__colony__task_hand_off')).toBe('commit');
    expect(classifyTool('mcp__colony__hivemind_context')).toBe('read');
    expect(classifyTool('Edit')).toBe('edit');
    expect(classifyTool('made_up')).toBe('other');
  });
});

describe('coordinationActivity', () => {
  it('returns zero counts and empty maps for an empty store', () => {
    const activity = storage.coordinationActivity(0);
    expect(activity.commits).toBe(0);
    expect(activity.reads).toBe(0);
    expect(activity.commits_by_session.size).toBe(0);
    expect(activity.reads_by_session.size).toBe(0);
  });

  it('counts commits and reads across sessions with per-session breakdowns', () => {
    session('codex@a');
    session('claude@b');
    for (let i = 0; i < 2; i++) toolUse('codex@a', 'mcp__colony__task_claim_file', 2_000 + i);
    for (let i = 0; i < 3; i++) toolUse('claude@b', 'mcp__colony__task_hand_off', 2_100 + i);
    for (let i = 0; i < 4; i++) toolUse('codex@a', 'mcp__colony__hivemind_context', 2_200 + i);
    for (let i = 0; i < 6; i++) toolUse('claude@b', 'mcp__colony__task_list', 2_300 + i);
    toolUse('codex@a', 'Bash', 2_400);

    const activity = storage.coordinationActivity(1_000);
    expect(activity.commits).toBe(5);
    expect(activity.reads).toBe(10);
    expect(Object.fromEntries(activity.commits_by_session)).toEqual({
      'claude@b': 3,
      'codex@a': 2,
    });
    expect(Object.fromEntries(activity.reads_by_session)).toEqual({
      'claude@b': 6,
      'codex@a': 4,
    });
  });
});

describe('editsWithoutClaims', () => {
  it('flags edits with and without sibling claims inside the default window', () => {
    session('codex@edit');
    toolUse('codex@edit', 'Edit', 10 * 60_000, 'src/foo.ts');
    claim('codex@edit', 'src/bar.ts', 18 * 60_000);
    toolUse('codex@edit', 'Edit', 20 * 60_000, 'src/bar.ts');

    const rows = storage.editsWithoutClaims(0);
    expect(rows).toEqual([
      {
        session_id: 'codex@edit',
        file_path: 'src/bar.ts',
        edit_ts: 20 * 60_000,
        has_sibling_claim_within_window: true,
      },
      {
        session_id: 'codex@edit',
        file_path: 'src/foo.ts',
        edit_ts: 10 * 60_000,
        has_sibling_claim_within_window: false,
      },
    ]);
  });

  it('does not count a claim outside the configured sibling window', () => {
    session('codex@boundary');
    claim('codex@boundary', 'src/foo.ts', 4 * 60_000);
    toolUse('codex@boundary', 'Edit', 10 * 60_000, 'src/foo.ts');

    expect(storage.editsWithoutClaims(0, 5 * 60_000)).toEqual([
      {
        session_id: 'codex@boundary',
        file_path: 'src/foo.ts',
        edit_ts: 10 * 60_000,
        has_sibling_claim_within_window: false,
      },
    ]);
  });
});

describe('colony health read queries', () => {
  it('returns ordered tool calls and exact claim-before-edit stats', () => {
    session('codex@health');
    session('claude@health');
    toolUse('codex@health', 'mcp__colony__task_list', 1_000);
    toolUse('codex@health', 'mcp__colony__task_ready_for_agent', 2_000);
    claim('codex@health', 'src/claimed.ts', 2_500);
    toolUse('codex@health', 'Edit', 3_000, 'src/claimed.ts');
    toolUse('claude@health', 'Edit', 4_000, 'src/unclaimed.ts');
    toolUse('claude@health', 'Edit', 5_000);

    expect(storage.toolCallsSince(0).map((row) => row.tool)).toEqual([
      'mcp__colony__task_list',
      'mcp__colony__task_ready_for_agent',
      'Edit',
      'Edit',
      'Edit',
    ]);
    expect(storage.claimBeforeEditStats(0)).toEqual({
      edit_tool_calls: 3,
      edits_with_file_path: 2,
      edits_claimed_before: 1,
    });
  });
});

describe('sessionsEndedWithoutHandoff', () => {
  it('reports quiet sessions with active claims and whether they handed off', () => {
    const now = new Date('2026-04-28T12:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    session('codex@quiet', now.getTime() - 60 * 60_000);
    session('codex@handoff', now.getTime() - 60 * 60_000);
    const task = storage.findOrCreateTask({
      title: 'coordination',
      repo_root: '/repo',
      branch: 'agent/test',
      created_by: 'codex@quiet',
    });
    storage.claimFile({ task_id: task.id, file_path: 'src/foo.ts', session_id: 'codex@quiet' });
    storage.claimFile({ task_id: task.id, file_path: 'src/bar.ts', session_id: 'codex@handoff' });
    storage.insertObservation({
      session_id: 'codex@quiet',
      kind: 'note',
      content: 'last quiet event',
      compressed: false,
      intensity: null,
      ts: now.getTime() - 35 * 60_000,
    });
    storage.insertObservation({
      session_id: 'codex@handoff',
      kind: 'handoff',
      content: 'handoff before quiet',
      compressed: false,
      intensity: null,
      ts: now.getTime() - 36 * 60_000,
      metadata: { kind: 'handoff', status: 'pending' },
    });

    expect(storage.sessionsEndedWithoutHandoff(now.getTime() - 2 * 60 * 60_000)).toEqual([
      {
        session_id: 'codex@handoff',
        last_observation_ts: now.getTime() - 36 * 60_000,
        had_active_claims: true,
        had_pending_handoff: true,
      },
      {
        session_id: 'codex@quiet',
        last_observation_ts: now.getTime() - 35 * 60_000,
        had_active_claims: true,
        had_pending_handoff: false,
      },
    ]);
  });
});
