import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSettings } from '@colony/config';
import { type MemoryStore, TaskThread } from '@colony/core';
import kleur from 'kleur';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProgram } from '../src/index.js';
import { withStore } from '../src/util/store.js';

const MINUTE_MS = 60_000;
const NOW = Date.UTC(2026, 3, 28, 12, 0, 0);

let dir = '';
let repoRoot = '';
let dataDir = '';
let dirtyWorktree = '';
let output = '';
let originalColonyHome: string | undefined;
let originalCodexSessionsRoot: string | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  kleur.enabled = false;
  dir = mkdtempSync(join(tmpdir(), 'colony-health-stale-cleanup-flow-'));
  repoRoot = createRepo(dir);
  dirtyWorktree = addWorktree(repoRoot, 'dirty', 'agent/dirty');
  writeFileSync(join(dirtyWorktree, 'src', 'dirty.ts'), 'export const dirty = true;\n', 'utf8');
  writeActiveSessionFile(repoRoot, {
    branch: 'agent/active',
    sessionKey: 'codex@active',
    worktreePath: join(repoRoot, '.omx', 'agent-worktrees', 'active'),
  });
  dataDir = join(dir, 'colony-home');
  mkdirSync(dataDir, { recursive: true });
  originalColonyHome = process.env.COLONY_HOME;
  originalCodexSessionsRoot = process.env.CODEX_CLI_SESSIONS_ROOT;
  process.env.COLONY_HOME = dataDir;
  process.env.CODEX_CLI_SESSIONS_ROOT = join(dir, 'empty-codex-sessions');
  output = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (dir) rmSync(dir, { recursive: true, force: true });
  if (originalColonyHome === undefined) delete process.env.COLONY_HOME;
  else process.env.COLONY_HOME = originalColonyHome;
  if (originalCodexSessionsRoot === undefined) delete process.env.CODEX_CLI_SESSIONS_ROOT;
  else process.env.CODEX_CLI_SESSIONS_ROOT = originalCodexSessionsRoot;
  kleur.enabled = true;
  vi.useRealTimers();
});

describe('colony health safe stale cleanup flow', () => {
  it('keeps fix-plan apply non-mutating until safe stale claim release is explicitly requested', async () => {
    await seedHealthStaleCleanupFixture();

    const before = await readHealthJson();
    expect(before.readiness_summary.signal_evaporation).toMatchObject({
      status: 'bad',
      evidence: expect.stringContaining('4 stale claim(s)'),
    });
    expect(before.signal_health).toMatchObject({
      total_claims: 6,
      active_claims: 1,
      stale_claims: 4,
      expired_claims: 1,
    });
    expect(before.queen_wave_health).toMatchObject({
      stale_claims_blocking_downstream: 0,
    });
    expect(before.stale_claim_evaporation).toMatchObject({
      status: 'needs_safe_release',
      stale_claims: 4,
      expired_weak_claims: 1,
      stale_downstream_blockers: 0,
      dry_run_command: 'colony coordination sweep --json',
      safe_release_command: 'colony coordination sweep --release-safe-stale-claims --json',
      downstream_release_command: 'colony coordination sweep --release-stale-blockers --json',
    });
    expect(before.stale_claim_evaporation.next_action).toContain('run a dry coordination sweep');
    const healthText = await readHealthText();
    expect(healthText).toContain('Stale claim evaporation');
    expect(healthText).toContain(
      'safe release:        colony coordination sweep --release-safe-stale-claims --json',
    );

    const dryRun = await readFixPlanJson(['--fix-plan']);
    expect(dryRun.mode).toBe('dry-run');
    expect(dryRun).toHaveProperty('readiness_summary.signal_evaporation.status', 'bad');
    expect(dryRun.current).toMatchObject({
      stale_claims: 4,
      expired_weak_claims: 1,
      stale_downstream_blockers: 0,
    });
    expect(dryRun.safety).toMatchObject({
      mutates_claims: false,
      ran_coordination_sweep: false,
      release_safe_stale_claims: false,
    });

    const beforeApplyClaims = await claimFiles();
    const applyOnly = await readFixPlanJson(['--fix-plan', '--apply']);
    expect(applyOnly.mode).toBe('apply');
    expect(applyOnly.safety).toMatchObject({
      mutates_claims: false,
      ran_coordination_sweep: true,
      release_safe_stale_claims: false,
    });
    expect(applyOnly.coordination_sweep.summary).toMatchObject({
      stale_claim_count: 5,
      expired_weak_claim_count: 1,
      released_stale_claim_count: 0,
      downgraded_stale_claim_count: 0,
      skipped_dirty_claim_count: 3,
    });
    expect(await claimFiles()).toEqual(beforeApplyClaims);

    const released = await readFixPlanJson([
      '--fix-plan',
      '--apply',
      '--release-safe-stale-claims',
    ]);
    expect(released.mode).toBe('apply');
    expect(released.safety).toMatchObject({
      mutates_claims: true,
      ran_coordination_sweep: true,
      release_safe_stale_claims: true,
    });
    expect(released.coordination_sweep.summary).toMatchObject({
      stale_claim_count: 3,
      expired_weak_claim_count: 0,
      released_stale_claim_count: 1,
      downgraded_stale_claim_count: 1,
      skipped_dirty_claim_count: 3,
    });
    expect(released.coordination_sweep.released_stale_claims).toEqual([
      expect.objectContaining({
        file_path: 'src/expired-safe.ts',
        reason: 'expired_weak_claim',
      }),
    ]);
    expect(released.coordination_sweep.downgraded_stale_claims).toEqual([
      expect.objectContaining({
        file_path: 'src/stale-safe.ts',
        reason: 'inactive_non_dirty_stale_claim',
      }),
    ]);
    expect(released.coordination_sweep.skipped_dirty_claims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file_path: 'src/active.ts', reason: 'active_session' }),
        expect.objectContaining({ file_path: 'src/dirty.ts', reason: 'dirty_worktree' }),
        expect.objectContaining({
          file_path: 'src/blocked-0.ts',
          reason: 'stale_downstream_blocker',
        }),
      ]),
    );

    const remainingClaims = await claimFiles();
    expect(remainingClaims).toEqual([
      'src/active.ts',
      'src/blocked-0.ts',
      'src/dirty.ts',
      'src/fresh.ts',
    ]);
    expect(await coordinationSweepAuditCount('agent/safe')).toBe(2);
    expect(await coordinationSweepAuditCount('agent/dirty')).toBe(0);
    expect(await coordinationSweepAuditCount('agent/active')).toBe(0);
    expect(await coordinationSweepAuditCount('spec/safe-cleanup-plan/sub-0')).toBe(0);

    const after = await readHealthJson();
    expect(after.signal_health).toMatchObject({
      total_claims: 4,
      active_claims: 1,
      stale_claims: 3,
      expired_claims: 0,
    });
    expect(after.readiness_summary.signal_evaporation).toMatchObject({
      status: 'bad',
      evidence: expect.stringContaining('3 stale claim(s)'),
    });
    expect(after.queen_wave_health).toMatchObject({
      stale_claims_blocking_downstream: 0,
    });
  });
});

async function readHealthJson(): Promise<{
  readiness_summary: { signal_evaporation: { status: string; evidence: string } };
  signal_health: {
    total_claims: number;
    active_claims: number;
    stale_claims: number;
    expired_claims: number;
  };
  queen_wave_health: { stale_claims_blocking_downstream: number };
  stale_claim_evaporation: {
    status: string;
    stale_claims: number;
    expired_weak_claims: number;
    stale_downstream_blockers: number;
    dry_run_command: string;
    safe_release_command: string;
    downstream_release_command: string;
    next_action: string;
  };
}> {
  output = '';
  await createProgram().parseAsync(['node', 'test', 'health', '--json', '--repo-root', repoRoot], {
    from: 'node',
  });
  return JSON.parse(output);
}

async function readHealthText(): Promise<string> {
  output = '';
  await createProgram().parseAsync(
    ['node', 'test', 'health', '--repo-root', repoRoot, '--verbose'],
    { from: 'node' },
  );
  return output;
}

async function readFixPlanJson(flags: string[]): Promise<{
  mode: string;
  safety: {
    mutates_claims: boolean;
    ran_coordination_sweep: boolean;
    release_safe_stale_claims: boolean;
  };
  current: {
    stale_claims: number;
    expired_weak_claims: number;
    stale_downstream_blockers: number;
  };
  readiness_summary: { signal_evaporation: { status: string } };
  coordination_sweep: {
    summary: {
      stale_claim_count: number;
      expired_weak_claim_count: number;
      released_stale_claim_count: number;
      downgraded_stale_claim_count: number;
      skipped_dirty_claim_count: number;
    };
    released_stale_claims: Array<{ file_path: string; reason: string }>;
    downgraded_stale_claims: Array<{ file_path: string; reason: string }>;
    skipped_dirty_claims: Array<{ file_path: string; reason: string }>;
  };
}> {
  output = '';
  await createProgram().parseAsync(
    ['node', 'test', 'health', '--json', '--repo-root', repoRoot, ...flags],
    { from: 'node' },
  );
  return JSON.parse(output);
}

async function seedHealthStaleCleanupFixture(): Promise<void> {
  const settings = loadSettings();
  await withStore(settings, (store) => {
    const safe = openTask(store, 'agent/safe', 'codex@safe');
    claimAt(safe, 'codex@safe', 'src/stale-safe.ts', 300);
    claimAt(safe, 'codex@safe', 'src/expired-safe.ts', 720);
    claimAt(safe, 'codex@safe', 'src/fresh.ts', 10);

    const dirty = openTask(store, 'agent/dirty', 'codex@dirty');
    claimAt(dirty, 'codex@dirty', 'src/dirty.ts', 300);

    const active = openTask(store, 'agent/active', 'codex@active');
    claimAt(active, 'codex@active', 'src/active.ts', 300);

    seedDownstreamBlocker(store);
    vi.setSystemTime(NOW);
  });
}

function openTask(store: MemoryStore, branch: string, sessionId: string): TaskThread {
  store.startSession({ id: sessionId, ide: 'codex', cwd: repoRoot });
  const thread = TaskThread.open(store, {
    repo_root: repoRoot,
    branch,
    title: branch,
    session_id: sessionId,
  });
  thread.join(sessionId, 'codex');
  return thread;
}

function claimAt(
  thread: TaskThread,
  sessionId: string,
  filePath: string,
  minutesAgo: number,
): void {
  vi.setSystemTime(NOW - minutesAgo * MINUTE_MS);
  thread.claimFile({ session_id: sessionId, file_path: filePath });
  vi.setSystemTime(NOW);
}

function seedDownstreamBlocker(store: MemoryStore): void {
  vi.setSystemTime(NOW - 300 * MINUTE_MS);
  const sessionId = 'codex@blocker';
  store.startSession({ id: sessionId, ide: 'codex', cwd: repoRoot });
  const parent = TaskThread.open(store, {
    repo_root: repoRoot,
    branch: 'spec/safe-cleanup-plan',
    title: 'safe cleanup plan',
    session_id: sessionId,
  });
  store.addObservation({
    session_id: sessionId,
    task_id: parent.task_id,
    kind: 'plan-config',
    content: 'plan safe-cleanup-plan config: auto_archive=false',
    metadata: { plan_slug: 'safe-cleanup-plan', auto_archive: false },
  });

  for (let index = 0; index < 2; index += 1) {
    const thread = TaskThread.open(store, {
      repo_root: repoRoot,
      branch: `spec/safe-cleanup-plan/sub-${index}`,
      title: `safe cleanup subtask ${index}`,
      session_id: sessionId,
    });
    store.addObservation({
      session_id: sessionId,
      task_id: thread.task_id,
      kind: 'plan-subtask',
      content: `Subtask ${index}\n\nSeeded safe cleanup plan subtask ${index}.`,
      metadata: {
        parent_plan_slug: 'safe-cleanup-plan',
        parent_plan_title: 'safe cleanup plan',
        parent_spec_task_id: parent.task_id,
        subtask_index: index,
        file_scope: [`src/blocked-${index}.ts`],
        depends_on: index === 0 ? [] : [0],
        spec_row_id: null,
        capability_hint: 'test_work',
        status: 'available',
      },
    });
    if (index === 0) {
      thread.join(sessionId, 'codex');
      thread.claimFile({ session_id: sessionId, file_path: 'src/blocked-0.ts' });
      store.addObservation({
        session_id: sessionId,
        task_id: thread.task_id,
        kind: 'plan-subtask-claim',
        content: 'claimed safe cleanup plan subtask 0',
        metadata: {
          kind: 'plan-subtask-claim',
          subtask_index: 0,
          status: 'claimed',
          session_id: sessionId,
          agent: 'codex',
        },
      });
    }
  }
  vi.setSystemTime(NOW);
}

async function claimFiles(): Promise<string[]> {
  const settings = loadSettings();
  return withStore(settings, (store) =>
    store.storage
      .listTasks(2_000)
      .filter((task) => task.repo_root === repoRoot)
      .flatMap((task) => store.storage.listClaims(task.id))
      .map((claim) => claim.file_path)
      .sort(),
  );
}

async function coordinationSweepAuditCount(branch: string): Promise<number> {
  const settings = loadSettings();
  return withStore(settings, (store) => {
    const task = store.storage
      .listTasks(2_000)
      .find((candidate) => candidate.repo_root === repoRoot && candidate.branch === branch);
    if (!task) throw new Error(`missing task for ${branch}`);
    return store.storage.taskObservationsByKind(task.id, 'coordination-sweep').length;
  });
}

function createRepo(rootDir: string): string {
  const root = join(rootDir, 'repo');
  mkdirSync(join(root, 'src'), { recursive: true });
  git(['init'], root);
  git(['config', 'user.email', 'agent@example.test'], root);
  git(['config', 'user.name', 'Agent'], root);
  writeFileSync(join(root, 'src', 'dirty.ts'), 'export const dirty = false;\n', 'utf8');
  git(['add', 'src/dirty.ts'], root);
  git(['commit', '-m', 'seed'], root);
  git(['branch', '-M', 'main'], root);
  return root;
}

function addWorktree(repoRoot: string, name: string, branch: string): string {
  const worktreeRoot = join(repoRoot, '.omx', 'agent-worktrees');
  mkdirSync(worktreeRoot, { recursive: true });
  const worktreePath = join(worktreeRoot, name);
  git(['worktree', 'add', '-b', branch, worktreePath, 'main'], repoRoot);
  return worktreePath;
}

function writeActiveSessionFile(
  root: string,
  session: { branch: string; sessionKey: string; worktreePath: string },
): void {
  const activeDir = join(root, '.omx', 'state', 'active-sessions');
  mkdirSync(activeDir, { recursive: true });
  writeFileSync(
    join(activeDir, `${session.sessionKey}.json`),
    `${JSON.stringify(
      {
        repoRoot: root,
        branch: session.branch,
        worktreePath: session.worktreePath,
        taskName: 'active stale cleanup safety fixture',
        latestTaskPreview: 'active stale cleanup safety fixture',
        state: 'working',
        agent: 'codex',
        cli: 'codex',
        sessionKey: session.sessionKey,
        startedAt: new Date(NOW - 5 * MINUTE_MS).toISOString(),
        lastHeartbeatAt: new Date(NOW).toISOString(),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}
