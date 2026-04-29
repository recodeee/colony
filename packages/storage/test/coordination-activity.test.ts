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

function scopedSession(
  id: string,
  cwd: string | null,
  metadata: Record<string, unknown> | null = null,
): void {
  storage.createSession({ id, ide: 'codex', cwd, started_at: 1, metadata });
}

function toolUse(
  session_id: string,
  tool: string,
  ts: number,
  file_path?: string,
  metadata: Record<string, unknown> = {},
): void {
  storage.insertObservation({
    session_id,
    kind: 'tool_use',
    content: `${tool} call`,
    compressed: false,
    intensity: null,
    ts,
    metadata: file_path ? { tool, file_path, ...metadata } : { tool, ...metadata },
  });
}

function claim(
  session_id: string,
  file_path: string,
  ts: number,
  task_id?: number,
  metadata: Record<string, unknown> = {},
): void {
  storage.insertObservation({
    session_id,
    kind: 'claim',
    content: `claim ${file_path}`,
    compressed: false,
    intensity: null,
    ts,
    task_id,
    metadata: { kind: 'claim', file_path, ...metadata },
  });
}

function task(repo_root: string, branch: string, session_id: string, agent = 'codex'): number {
  const row = storage.findOrCreateTask({
    title: `${branch} lane`,
    repo_root,
    branch,
    created_by: session_id,
  });
  storage.addTaskParticipant({ task_id: row.id, session_id, agent });
  return row.id;
}

describe('tool classification', () => {
  it('classifies coordination and edit tools from the central taxonomy', () => {
    expect(classifyTool('mcp__colony__task_hand_off')).toBe('commit');
    expect(classifyTool('mcp__colony__task_note_working')).toBe('commit');
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
    session('colony-pre-tool-use-diagnostics');
    storage.insertObservation({
      session_id: 'colony-pre-tool-use-diagnostics',
      kind: 'claim-before-edit',
      content: 'session binding missing',
      compressed: false,
      intensity: null,
      ts: 5_500,
      metadata: {
        source: 'pre-tool-use',
        outcome: 'edits_missing_claim',
        session_binding_missing: true,
      },
    });

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
      claim_match_window_ms: 5 * 60_000,
      claim_match_sources: {
        exact_session: 1,
        repo_branch: 0,
        worktree: 0,
        agent_lane: 0,
      },
      auto_claimed_before_edit: 0,
      session_binding_missing: 1,
      pre_tool_use_signals: 1,
    });
  });

  it('counts same repo and branch claims before edits when Codex and OMX session ids differ', () => {
    scopedSession('mcp-claim-session', '/repo');
    scopedSession('omx-runtime-session', '/repo');
    const taskId = task('/repo', 'agent/codex/session-lane', 'mcp-claim-session');
    claim('mcp-claim-session', 'src/lane.ts', 1_000, taskId);
    toolUse('omx-runtime-session', 'Edit', 2_000, '/repo/src/lane.ts', {
      repo_root: '/repo',
      branch: 'agent/codex/session-lane',
    });

    expect(storage.claimBeforeEditStats(0)).toMatchObject({
      edit_tool_calls: 1,
      edits_with_file_path: 1,
      edits_claimed_before: 1,
      claim_match_sources: {
        exact_session: 0,
        repo_branch: 1,
        worktree: 0,
        agent_lane: 0,
      },
    });
  });

  it('counts same worktree claims before edits when branch metadata is absent', () => {
    scopedSession('mcp-worktree-claim', '/repo/worktree');
    scopedSession('mcp-runtime-worktree', '/repo/worktree');
    const taskId = task('/repo/worktree', 'agent/codex/worktree-lane', 'mcp-worktree-claim');
    claim('mcp-worktree-claim', 'src/worktree.ts', 1_000, taskId);
    toolUse('mcp-runtime-worktree', 'Edit', 2_000, '/repo/worktree/src/worktree.ts');

    expect(storage.claimBeforeEditStats(0)).toMatchObject({
      edits_claimed_before: 1,
      claim_match_sources: {
        exact_session: 0,
        repo_branch: 0,
        worktree: 1,
        agent_lane: 0,
      },
    });
  });

  it('uses agent lane fallback only when repo and branch claims are unambiguous by agent', () => {
    scopedSession('codex-claim', null);
    scopedSession('claude-claim', null);
    scopedSession('mcp-edit', null);
    const taskId = task('/repo', 'agent/shared/lane', 'codex-claim', 'codex');
    storage.addTaskParticipant({ task_id: taskId, session_id: 'claude-claim', agent: 'claude' });
    claim('codex-claim', 'src/shared.ts', 1_000, taskId);
    claim('claude-claim', 'src/shared.ts', 1_100, taskId);
    toolUse('mcp-edit', 'Edit', 2_000, 'src/shared.ts', {
      repo_root: '/repo',
      branch: 'agent/shared/lane',
      agent: 'codex',
    });

    expect(storage.claimBeforeEditStats(0)).toMatchObject({
      edits_claimed_before: 1,
      claim_match_sources: {
        exact_session: 0,
        repo_branch: 0,
        worktree: 0,
        agent_lane: 1,
      },
    });
  });
});

describe('fileHeat', () => {
  it('halves heat after one half-life with fixed timestamps', () => {
    const now = Date.parse('2026-04-28T12:00:00.000Z');
    session('codex@heat', now - 60_000);
    const task = storage.findOrCreateTask({
      title: 'heat',
      repo_root: '/repo',
      branch: 'agent/heat',
      created_by: 'codex@heat',
    });
    storage.insertObservation({
      session_id: 'codex@heat',
      kind: 'tool_use',
      content: 'edit src/hot.ts',
      compressed: false,
      intensity: null,
      ts: now - 10 * 60_000,
      task_id: task.id,
      metadata: { tool: 'Edit', file_path: 'src/hot.ts' },
    });

    const rows = storage.fileHeat({
      task_ids: [task.id],
      now,
      half_life_minutes: 10,
      min_heat: 0.001,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      task_id: task.id,
      file_path: 'src/hot.ts',
      last_activity_ts: now - 10 * 60_000,
      event_count: 1,
    });
    expect(rows[0]?.heat).toBeCloseTo(0.5, 6);
  });

  it('uses claims and task metadata arrays without keeping old files permanently hot', () => {
    const now = Date.parse('2026-04-28T12:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    session('codex@heat', now - 60_000);
    const task = storage.findOrCreateTask({
      title: 'heat',
      repo_root: '/repo',
      branch: 'agent/heat',
      created_by: 'codex@heat',
    });

    storage.claimFile({ task_id: task.id, file_path: 'src/claimed.ts', session_id: 'codex@heat' });
    storage.insertObservation({
      session_id: 'codex@heat',
      kind: 'handoff',
      content: 'handoff scope',
      compressed: false,
      intensity: null,
      ts: now - 10 * 60_000,
      task_id: task.id,
      metadata: { transferred_files: ['src/handoff.ts'] },
    });
    for (let i = 0; i < 20; i++) {
      storage.insertObservation({
        session_id: 'codex@heat',
        kind: 'file-op',
        content: 'old edit src/old.ts',
        compressed: false,
        intensity: null,
        ts: now - 9 * 10 * 60_000 - i,
        task_id: task.id,
        metadata: { file_paths: ['src/old.ts'] },
      });
    }

    const rows = storage.fileHeat({ task_ids: [task.id], now, half_life_minutes: 10 });
    const byPath = new Map(rows.map((row) => [row.file_path, row]));

    expect(rows.map((row) => row.file_path)).toEqual(['src/claimed.ts', 'src/handoff.ts']);
    expect(byPath.get('src/claimed.ts')?.heat).toBeCloseTo(1, 6);
    expect(byPath.get('src/handoff.ts')?.heat).toBeCloseTo(0.25, 6);
    expect(byPath.has('src/old.ts')).toBe(false);
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
