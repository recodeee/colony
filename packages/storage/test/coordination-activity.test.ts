import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

function session(
  id: string,
  started_at = 1,
  options: { cwd?: string | null; metadata?: Record<string, unknown> | null } = {},
): void {
  storage.createSession({
    id,
    ide: 'codex',
    cwd: options.cwd === undefined ? '/repo' : options.cwd,
    started_at,
    metadata: options.metadata === undefined ? null : JSON.stringify(options.metadata),
  });
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
  options: { task_id?: number; metadata?: Record<string, unknown> } = {},
): void {
  storage.insertObservation({
    session_id,
    kind: 'claim',
    content: `claim ${file_path}`,
    compressed: false,
    intensity: null,
    ts,
    task_id: options.task_id,
    metadata: { kind: 'claim', file_path, ...options.metadata },
  });
}

function preToolUseSignal(
  session_id: string,
  file_path: string,
  ts: number,
  metadata: Record<string, unknown> = {},
): void {
  storage.insertObservation({
    session_id,
    kind: 'claim-before-edit',
    content: `edits_missing_claim: ${file_path}`,
    compressed: false,
    intensity: null,
    ts,
    metadata: {
      kind: 'claim-before-edit',
      source: 'pre-tool-use',
      outcome: 'edits_missing_claim',
      file_path,
      ...metadata,
    },
  });
}

describe('tool classification', () => {
  it('classifies coordination and edit tools from the central taxonomy', () => {
    expect(classifyTool('mcp__colony__task_hand_off')).toBe('commit');
    expect(classifyTool('mcp__colony__task_note_working')).toBe('commit');
    expect(classifyTool('mcp__colony__hivemind_context')).toBe('read');
    expect(classifyTool('Edit')).toBe('edit');
    expect(classifyTool('apply_patch')).toBe('edit');
    expect(classifyTool('ApplyPatch')).toBe('edit');
    expect(classifyTool('Patch')).toBe('edit');
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
    claim('codex@health', 'src/patched.ts', 3_500);
    toolUse('codex@health', 'apply_patch', 3_600, 'src/patched.ts');
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
      'apply_patch',
      'Edit',
      'Edit',
    ]);
    const stats = storage.claimBeforeEditStats(0);
    expect(stats).toMatchObject({
      edit_tool_calls: 4,
      edits_with_file_path: 3,
      edits_claimed_before: 2,
      claim_match_window_ms: 5 * 60_000,
      claim_match_sources: {
        exact_session: 2,
        repo_branch: 0,
        worktree: 0,
        agent_lane: 0,
      },
      claim_miss_reasons: {
        no_claim_for_file: 0,
        claim_after_edit: 0,
        session_id_mismatch: 0,
        repo_root_mismatch: 0,
        branch_mismatch: 0,
        path_mismatch: 1,
        worktree_path_mismatch: 0,
        pseudo_path_skipped: 0,
        pre_tool_use_missing: 0,
      },
      nearest_claim_examples: [
        expect.objectContaining({
          reason: 'path_mismatch',
          edit_file_path: 'src/unclaimed.ts',
        }),
      ],
      auto_claimed_before_edit: 0,
      session_binding_missing: 1,
      pre_tool_use_signals: 1,
    });
  });

  it('matches same-lane claims before edits when session ids change', () => {
    const repoRoot = '/repo';
    const branch = 'agent/codex/lane';
    const worktree = '/repo/.omx/agent-worktrees/lane';
    session('codex@lane', 1_000, { cwd: worktree, metadata: { repo_root: repoRoot, branch } });
    session('mcp-lane', 1_000, { cwd: worktree, metadata: { repo_root: repoRoot, branch } });
    session('omx-lane', 1_000, { cwd: worktree });
    const task = storage.findOrCreateTask({
      title: 'lane',
      repo_root: repoRoot,
      branch,
      created_by: 'codex@lane',
    });
    storage.addTaskParticipant({ task_id: task.id, session_id: 'codex@lane', agent: 'codex' });
    storage.addTaskParticipant({ task_id: task.id, session_id: 'mcp-lane', agent: 'codex' });

    claim('codex@lane', 'src/exact.ts', 2_000, { task_id: task.id });
    toolUse('codex@lane', 'Edit', 3_000, 'src/exact.ts');

    claim('mcp-lane', 'src/repo.ts', 4_000, { task_id: task.id });
    toolUse('codex@lane', 'Edit', 5_000, '/repo/src/repo.ts', { repo_root: repoRoot, branch });

    claim('omx-lane', '/repo/src/worktree.ts', 6_000, {
      metadata: { cwd: worktree },
    });
    toolUse('codex@lane', 'Edit', 7_000, 'src/worktree.ts', { cwd: worktree });

    claim('mcp-lane', 'src/stale.ts', 8_000, { task_id: task.id });
    toolUse('codex@lane', 'Edit', 15 * 60_000, 'src/stale.ts', { repo_root: repoRoot, branch });

    const stats = storage.claimBeforeEditStats(0);
    expect(stats).toMatchObject({
      edit_tool_calls: 4,
      edits_with_file_path: 4,
      edits_claimed_before: 3,
      claim_match_window_ms: 5 * 60_000,
      claim_match_sources: {
        exact_session: 1,
        repo_branch: 1,
        worktree: 1,
        agent_lane: 0,
      },
      claim_miss_reasons: {
        no_claim_for_file: 0,
        claim_after_edit: 0,
        session_id_mismatch: 0,
        repo_root_mismatch: 0,
        branch_mismatch: 0,
        path_mismatch: 0,
        worktree_path_mismatch: 0,
        pseudo_path_skipped: 0,
        pre_tool_use_missing: 1,
      },
      nearest_claim_examples: [
        expect.objectContaining({
          reason: 'pre_tool_use_missing',
          edit_file_path: 'src/stale.ts',
        }),
      ],
      auto_claimed_before_edit: 0,
      session_binding_missing: 0,
      pre_tool_use_signals: 0,
    });
    expect(stats.claim_miss_reasons).toMatchObject({ pre_tool_use_missing: 1 });
    expect(stats.nearest_claim_examples?.[0]).toMatchObject({
      reason: 'pre_tool_use_missing',
      edit_file_path: 'src/stale.ts',
      nearest_claim_id: expect.any(Number),
    });
  });

  it('classifies each claim-before-edit miss reason with nearest claim context', () => {
    for (const id of [
      'no-claim',
      'claim-after',
      'repo-mismatch',
      'branch-mismatch',
      'path-mismatch',
      'worktree-mismatch',
      'pseudo',
    ]) {
      session(id);
    }
    session('session-claim', 1, { cwd: null });
    session('session-edit', 1, { cwd: null });
    session('pre-missing', 1, { cwd: '/repo/worktrees/pre-missing' });

    toolUse('no-claim', 'Edit', 10_000, 'src/no-claim.ts', {
      repo_root: '/repo',
      branch: 'main',
      worktree_path: '/repo/worktrees/main',
    });
    preToolUseSignal('no-claim', 'src/no-claim.ts', 9_900, {
      repo_root: '/repo',
      branch: 'main',
      worktree_path: '/repo/worktrees/main',
    });

    toolUse('claim-after', 'Edit', 20_000, 'src/after.ts', {
      repo_root: '/repo',
      branch: 'main',
    });
    claim('claim-after', 'src/after.ts', 21_000, {
      metadata: { repo_root: '/repo', branch: 'main' },
    });

    claim('session-claim', 'src/session.ts', 29_000);
    toolUse('session-edit', 'Edit', 30_000, 'src/session.ts');

    claim('repo-mismatch', 'src/repo.ts', 39_000, {
      metadata: { repo_root: '/other-repo', branch: 'main' },
    });
    toolUse('repo-mismatch', 'Edit', 40_000, 'src/repo.ts', {
      repo_root: '/repo',
      branch: 'main',
    });

    claim('branch-mismatch', 'src/branch.ts', 49_000, {
      metadata: { repo_root: '/repo', branch: 'old-branch' },
    });
    toolUse('branch-mismatch', 'Edit', 50_000, 'src/branch.ts', {
      repo_root: '/repo',
      branch: 'new-branch',
    });

    claim('path-mismatch', 'src/other.ts', 59_000, {
      metadata: { repo_root: '/repo', branch: 'main' },
    });
    toolUse('path-mismatch', 'Edit', 60_000, 'src/path.ts', {
      repo_root: '/repo',
      branch: 'main',
    });

    claim('worktree-mismatch', 'src/worktree.ts', 69_000, {
      metadata: { worktree_path: '/repo/worktrees/a' },
    });
    toolUse('worktree-mismatch', 'Edit', 70_000, 'src/worktree.ts', {
      worktree_path: '/repo/worktrees/b',
    });

    toolUse('pseudo', 'Edit', 80_000, '/dev/null');
    toolUse('pre-missing', 'Edit', 90_000, 'src/pre-missing.ts');

    const stats = storage.claimBeforeEditStats(0);

    expect(stats).toMatchObject({
      edit_tool_calls: 9,
      edits_with_file_path: 9,
      edits_claimed_before: 0,
      claim_miss_reasons: {
        no_claim_for_file: 1,
        claim_after_edit: 1,
        session_id_mismatch: 1,
        repo_root_mismatch: 1,
        branch_mismatch: 1,
        path_mismatch: 1,
        worktree_path_mismatch: 1,
        pseudo_path_skipped: 1,
        pre_tool_use_missing: 1,
      },
    });
    expect(stats.nearest_claim_examples?.map((entry) => entry.reason)).toEqual([
      'pseudo_path_skipped',
      'no_claim_for_file',
      'claim_after_edit',
      'session_id_mismatch',
      'repo_root_mismatch',
      'branch_mismatch',
      'path_mismatch',
      'worktree_path_mismatch',
      'pre_tool_use_missing',
    ]);
    expect(stats.nearest_claim_examples).toContainEqual(
      expect.objectContaining({
        reason: 'session_id_mismatch',
        edit_file_path: 'src/session.ts',
        claim_file_path: 'src/session.ts',
        relation: expect.objectContaining({
          same_file_path: true,
          same_session_id: false,
          claim_before_edit: true,
        }),
      }),
    );
  });

  it('matches worktree-prefixed edits to canonical claims for the same logical file', () => {
    const repoRoot = '/repo';
    const worktree = '/repo/.omx/agent-worktrees/lane-a';
    session('codex@worktree', 1_000, {
      cwd: worktree,
      metadata: { repo_root: repoRoot, branch: 'agent/lane-a' },
    });

    claim('codex@worktree', 'apps/api/foo.ts', 2_000, {
      metadata: { repo_root: repoRoot, branch: 'agent/lane-a' },
    });
    toolUse(
      'codex@worktree',
      'Edit',
      3_000,
      '.omx/agent-worktrees/lane-a/apps/api/foo.ts',
      { repo_root: repoRoot, branch: 'agent/lane-a' },
    );

    claim('codex@worktree', '.omc/agent-worktrees/lane-b/apps/api/bar.ts', 4_000, {
      metadata: { repo_root: repoRoot, branch: 'agent/lane-a' },
    });
    toolUse('codex@worktree', 'Edit', 5_000, 'apps/api/bar.ts', {
      repo_root: repoRoot,
      branch: 'agent/lane-a',
    });

    const stats = storage.claimBeforeEditStats(0);
    expect(stats).toMatchObject({
      edit_tool_calls: 2,
      edits_with_file_path: 2,
      edits_claimed_before: 2,
      claim_miss_reasons: {
        no_claim_for_file: 0,
        path_mismatch: 0,
        worktree_path_mismatch: 0,
      },
    });
  });

  it('reports the in-window same-lane claim that triggered path_mismatch', () => {
    const repoRoot = '/repo';
    session('codex@trigger', 1_000, { metadata: { repo_root: repoRoot, branch: 'agent/lane' } });

    // Old same-file claim, far outside the 5-minute window. The previous
    // implementation would surface this as the nearest_claim_example because
    // it ranked highest by file-match priority, which contradicts the
    // path_mismatch label.
    const oldSameFileClaimTs = 10_000;
    claim('codex@trigger', 'apps/api/foo.ts', oldSameFileClaimTs, {
      metadata: { repo_root: repoRoot, branch: 'agent/lane' },
    });

    // Recent same-lane claim for a DIFFERENT file. This is what triggers
    // path_mismatch.
    const editTs = oldSameFileClaimTs + 600_000; // 10 minutes later
    const triggerClaimTs = editTs - 30_000; // 30 seconds before edit
    claim('codex@trigger', 'apps/api/bar.ts', triggerClaimTs, {
      metadata: { repo_root: repoRoot, branch: 'agent/lane' },
    });
    toolUse('codex@trigger', 'Edit', editTs, 'apps/api/foo.ts', {
      repo_root: repoRoot,
      branch: 'agent/lane',
    });

    const stats = storage.claimBeforeEditStats(0);
    expect(stats.claim_miss_reasons).toMatchObject({ path_mismatch: 1 });
    const example = stats.nearest_claim_examples?.find((entry) => entry.reason === 'path_mismatch');
    expect(example).toBeDefined();
    expect(example).toMatchObject({
      claim_file_path: 'apps/api/bar.ts',
      claim_ts: triggerClaimTs,
      relation: expect.objectContaining({
        same_file_path: false,
        claim_before_edit: true,
      }),
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

describe('archiveQueenPlan', () => {
  it('marks the parent task and every sub-task row archived', () => {
    const repo = '/repo';
    const slug = 'orphan-queen-plan';
    const parent = storage.findOrCreateTask({
      title: 'orphan',
      repo_root: repo,
      branch: `spec/${slug}`,
      created_by: 'queen',
    });
    const subIds: number[] = [];
    for (let i = 0; i < 3; i++) {
      const sub = storage.findOrCreateTask({
        title: `sub ${i}`,
        repo_root: repo,
        branch: `spec/${slug}/sub-${i}`,
        created_by: 'queen',
      });
      subIds.push(sub.id);
    }

    const result = storage.archiveQueenPlan({ repo_root: repo, plan_slug: slug });

    expect(result).toEqual({ parent_task_id: parent.id, archived_rows: 4 });
    expect(storage.getTask(parent.id)?.status).toBe('archived');
    for (const subId of subIds) {
      expect(storage.getTask(subId)?.status).toBe('archived');
    }
  });

  it('is idempotent and reports zero archived rows on re-run', () => {
    const repo = '/repo';
    const slug = 'twice-archived';
    storage.findOrCreateTask({
      title: 'parent',
      repo_root: repo,
      branch: `spec/${slug}`,
      created_by: 'queen',
    });
    storage.findOrCreateTask({
      title: 'sub',
      repo_root: repo,
      branch: `spec/${slug}/sub-0`,
      created_by: 'queen',
    });

    const first = storage.archiveQueenPlan({ repo_root: repo, plan_slug: slug });
    expect(first.archived_rows).toBe(2);

    const second = storage.archiveQueenPlan({ repo_root: repo, plan_slug: slug });
    expect(second.archived_rows).toBe(0);
    expect(second.parent_task_id).toBe(first.parent_task_id);
  });

  it('returns parent_task_id null when the plan does not exist', () => {
    expect(
      storage.archiveQueenPlan({ repo_root: '/repo', plan_slug: 'never-published' }),
    ).toEqual({ parent_task_id: null, archived_rows: 0 });
  });

  it('does not touch tasks belonging to other plans or other repos', () => {
    const slug = 'isolated';
    const target = storage.findOrCreateTask({
      title: 'target',
      repo_root: '/repo',
      branch: `spec/${slug}`,
      created_by: 'queen',
    });
    const sibling = storage.findOrCreateTask({
      title: 'sibling',
      repo_root: '/repo',
      branch: 'spec/another-plan',
      created_by: 'queen',
    });
    const otherRepo = storage.findOrCreateTask({
      title: 'other repo same slug',
      repo_root: '/other-repo',
      branch: `spec/${slug}`,
      created_by: 'queen',
    });

    storage.archiveQueenPlan({ repo_root: '/repo', plan_slug: slug });

    expect(storage.getTask(target.id)?.status).toBe('archived');
    expect(storage.getTask(sibling.id)?.status).toBe('open');
    expect(storage.getTask(otherRepo.id)?.status).toBe('open');
  });
});
