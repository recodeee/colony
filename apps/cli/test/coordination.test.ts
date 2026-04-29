import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { loadSettings } from '@colony/config';
import { type MemoryStore, ProposalSystem, TaskThread } from '@colony/core';
import kleur from 'kleur';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProgram } from '../src/index.js';
import { withStore } from '../src/util/store.js';

const MINUTE_MS = 60_000;
const NOW = Date.UTC(2026, 3, 28, 12, 0, 0);

let repoRoot: string;
let storedRepoRoot: string;
let dataDir: string;
let output: string;
let originalColonyHome: string | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  kleur.enabled = false;
  repoRoot = mkdtempSync(join(tmpdir(), 'colony-cli-coordination-repo-'));
  const legacyRepoName = `legacy-${basename(repoRoot)}`;
  storedRepoRoot = join(dirname(repoRoot), legacyRepoName);
  execFileSync('git', ['init'], { cwd: repoRoot, stdio: 'ignore' });
  execFileSync(
    'git',
    ['remote', 'add', 'origin', `https://github.com/recodeee/${legacyRepoName}.git`],
    {
      cwd: repoRoot,
      stdio: 'ignore',
    },
  );
  dataDir = mkdtempSync(join(tmpdir(), 'colony-cli-coordination-data-'));
  originalColonyHome = process.env.COLONY_HOME;
  process.env.COLONY_HOME = dataDir;
  output = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
  if (originalColonyHome === undefined) delete process.env.COLONY_HOME;
  else process.env.COLONY_HOME = originalColonyHome;
  kleur.enabled = true;
  vi.useRealTimers();
});

describe('colony coordination CLI', () => {
  it('shows coordination help in a reviewable snapshot', () => {
    const program = createProgram();
    const coordination = program.commands.find((command) => command.name() === 'coordination');

    expect(coordination?.helpInformation()).toMatchInlineSnapshot(`
      "Usage: colony coordination [options] [command]

      Inspect biological coordination signals

      Options:
        -h, --help       display help for command

      Commands:
        sweep [options]  Report stale claims, expired messages, decayed proposals,
                         and stale trails
        help [command]   display help for command
      "
    `);
  });

  it('emits one JSON shape for stale biological coordination signals', async () => {
    await seedSweepSignals();

    await createProgram().parseAsync(
      ['node', 'test', 'coordination', 'sweep', '--repo-root', repoRoot, '--json', '--dry-run'],
      { from: 'node' },
    );

    const json = JSON.parse(output) as {
      dry_run: boolean;
      summary: Record<string, number>;
      active_claims: Array<{ file_path: string; age_minutes: number; cleanup_action: string }>;
      fresh_claims: Array<{ file_path: string; age_minutes: number; cleanup_action: string }>;
      stale_claims: Array<{
        file_path: string;
        age_minutes: number;
        current_strength: number;
        cleanup_action: string;
        weak_reason: string | null;
      }>;
      expired_weak_claims: Array<{
        file_path: string;
        cleanup_action: string;
        weak_reason: string;
        cleanup_summary: string;
      }>;
      top_stale_branches: Array<{
        branch: string;
        stale_claim_count: number;
        expired_weak_claim_count: number;
      }>;
      suggested_cleanup_action: string;
      recommended_action: string;
      expired_handoffs: Array<{ summary: string; expired_minutes: number }>;
      expired_messages: Array<{ preview: string; urgency: string }>;
      decayed_proposals: Array<{ summary: string; strength: number; noise_floor: number }>;
      stale_hot_files: Array<{ file_path: string; current_strength: number }>;
      blocked_downstream_tasks: Array<{ plan_slug: string; blocked_by_count: number }>;
      stale_downstream_blockers: Array<{
        plan_slug: string;
        file_path: string;
        owner_session_id: string;
        unlock_candidate: { subtask_index: number };
      }>;
      released_stale_downstream_blockers: Array<{ task_id: number }>;
      released_stale_claims: Array<{ file_path: string; audit_observation_id: number }>;
      downgraded_stale_claims: Array<{ file_path: string; audit_observation_id: number }>;
      skipped_dirty_claims: Array<{ file_path: string; reason: string }>;
      recommended_actions: string[];
    };

    expect(json.dry_run).toBe(true);
    expect(json.summary).toMatchObject({
      active_claim_count: 1,
      fresh_claim_count: 1,
      stale_claim_count: 4,
      expired_weak_claim_count: 1,
      expired_handoff_count: 1,
      expired_message_count: 1,
      decayed_proposal_count: 1,
      stale_hot_file_count: 1,
      blocked_downstream_task_count: 1,
      stale_downstream_blocker_count: 1,
      released_stale_blocker_claim_count: 0,
      requeued_stale_blocker_count: 0,
      released_stale_claim_count: 0,
      downgraded_stale_claim_count: 0,
      skipped_dirty_claim_count: 1,
    });
    expect(json.active_claims[0]).toMatchObject({
      file_path: 'src/fresh.ts',
      cleanup_action: 'keep_fresh',
    });
    expect(json.fresh_claims[0]).toMatchObject({
      file_path: 'src/fresh.ts',
      cleanup_action: 'keep_fresh',
    });
    expect(json.stale_claims.map((claim) => claim.file_path)).toContain('src/stale.ts');
    expect(json.stale_claims.map((claim) => claim.file_path)).toContain('src/stale-active.ts');
    expect(json.stale_claims.find((claim) => claim.file_path === 'src/stale.ts')).toMatchObject({
      cleanup_action: 'review_stale_claim',
      weak_reason: null,
    });
    expect(json.expired_weak_claims[0]).toMatchObject({
      file_path: 'src/expired.ts',
      cleanup_action: 'expire_weak_claim',
      weak_reason: 'expired_age',
    });
    expect(json.expired_weak_claims[0]?.cleanup_summary).toContain(
      'audit observations stay intact',
    );
    expect(json.top_stale_branches[0]).toMatchObject({
      branch: 'main',
      stale_claim_count: 3,
      expired_weak_claim_count: 1,
    });
    expect(json.stale_downstream_blockers[0]).toMatchObject({
      plan_slug: 'blocked-plan',
      file_path: 'src/blocked-0.ts',
      owner_session_id: 'codex@stale',
      unlock_candidate: { subtask_index: 1 },
    });
    expect(json.released_stale_downstream_blockers).toHaveLength(0);
    expect(json.released_stale_claims).toHaveLength(0);
    expect(json.downgraded_stale_claims).toHaveLength(0);
    expect(json.skipped_dirty_claims).toEqual([
      expect.objectContaining({
        file_path: 'src/blocked-0.ts',
        reason: 'stale_downstream_blocker',
      }),
    ]);
    expect(json.recommended_actions).toEqual(
      expect.arrayContaining([
        expect.stringContaining('rescue stale downstream blocker'),
      ]),
    );
    expect(json.suggested_cleanup_action).toContain('release/requeue 1 stale downstream blocker');
    expect(json.recommended_action).toBe(json.suggested_cleanup_action);
    expect(json.expired_handoffs[0]).toMatchObject({ summary: 'expired handoff' });
    expect(json.expired_messages[0]).toMatchObject({
      preview: 'expired blocking message',
      urgency: 'blocking',
    });
    expect(json.decayed_proposals[0]?.summary).toBe('old proposal');
    expect(json.decayed_proposals[0]?.strength).toBeLessThan(
      json.decayed_proposals[0]?.noise_floor ?? 0,
    );
    expect(json.stale_hot_files[0]).toMatchObject({ file_path: 'src/hot.ts' });
    expect(json.blocked_downstream_tasks[0]).toMatchObject({
      plan_slug: 'blocked-plan',
      blocked_by_count: 1,
    });
  });

  it('renders actionable human output without deleting audit history', async () => {
    await seedSweepSignals();

    await createProgram().parseAsync(
      ['node', 'test', 'coordination', 'sweep', '--repo-root', repoRoot],
      { from: 'node' },
    );

    expect(output).toContain('Coordination sweep: 10 stale biological signal(s)');
    expect(output).toContain('mode: dry-run, read-only');
    expect(output).toContain('audit: observations retained; advisory claims only');
    expect(output).toContain('active claims: 1  stale claims: 4  expired/weak claims: 1');
    expect(output).toContain(
      'recommended action: dry-run: release/requeue 1 stale downstream blocker',
    );
    expect(output).toContain('stale downstream blockers: 1');
    expect(output).toContain('Active claims:');
    expect(output).toContain('Stale claims:');
    expect(output).toContain('review owner activity, then release or hand off if inactive');
    expect(output).toContain('Expired/weak claims:');
    expect(output).toContain(
      'would release expired/weak advisory claim; audit observations stay intact',
    );
    expect(output).toContain('Top branches with stale claims:');
    expect(output).toContain('release 1 expired/weak advisory claim(s); keep audit observations');
    expect(output).toContain('Expired handoffs:');
    expect(output).toContain('send a fresh handoff if still needed');
    expect(output).toContain('Decayed proposals:');
    expect(output).toContain('reinforce or let fade');
    expect(output).toContain('Blocked downstream tasks:');
    expect(output).toContain('finish blocker or replan');
    expect(output).toContain('Stale downstream blockers:');
    expect(output).toContain('src/blocked-0.ts held by codex@stale');

    const settings = loadSettings();
    await withStore(settings, (store) => {
      const mainTaskId = taskIdByBranch(store, 'main');
      expect(store.storage.listProposals(storedRepoRoot)).toHaveLength(1);
      expect(store.storage.listClaims(mainTaskId)).toHaveLength(4);
      expect(store.storage.taskObservationsByKind(mainTaskId, 'handoff')).toHaveLength(1);
      expect(store.storage.taskObservationsByKind(mainTaskId, 'message')).toHaveLength(1);
    });
  });

  it('releases and requeues stale downstream blockers without deleting history', async () => {
    await seedSweepSignals();

    await createProgram().parseAsync(
      [
        'node',
        'test',
        'coordination',
        'sweep',
        '--repo-root',
        repoRoot,
        '--json',
        '--release-stale-blockers',
      ],
      { from: 'node' },
    );

    const applied = JSON.parse(output) as {
      dry_run: boolean;
      summary: {
        stale_downstream_blocker_count: number;
        released_stale_blocker_claim_count: number;
        requeued_stale_blocker_count: number;
      };
      released_stale_downstream_blockers: Array<{
        released_claim_count: number;
        audit_observation_id: number;
        requeue_observation_id: number;
      }>;
    };

    expect(applied.dry_run).toBe(false);
    expect(applied.summary).toMatchObject({
      stale_downstream_blocker_count: 1,
      released_stale_blocker_claim_count: 1,
      requeued_stale_blocker_count: 1,
    });
    expect(applied.released_stale_downstream_blockers[0]).toMatchObject({
      released_claim_count: 1,
    });

    output = '';
    await createProgram().parseAsync(
      ['node', 'test', 'coordination', 'sweep', '--repo-root', repoRoot, '--json'],
      { from: 'node' },
    );
    const after = JSON.parse(output) as {
      summary: {
        stale_downstream_blocker_count: number;
        released_stale_blocker_claim_count: number;
        requeued_stale_blocker_count: number;
      };
      stale_downstream_blockers: unknown[];
    };
    expect(after.summary).toMatchObject({
      stale_downstream_blocker_count: 0,
      released_stale_blocker_claim_count: 0,
      requeued_stale_blocker_count: 0,
    });
    expect(after.stale_downstream_blockers).toHaveLength(0);

    const settings = loadSettings();
    await withStore(settings, (store) => {
      const blockerTaskId = taskIdByBranch(store, 'spec/blocked-plan/sub-0');
      expect(store.storage.listClaims(blockerTaskId)).toHaveLength(0);
      expect(
        store.storage.taskObservationsByKind(blockerTaskId, 'coordination-sweep'),
      ).toHaveLength(1);
      const planRows = store.storage.taskObservationsByKind(blockerTaskId, 'plan-subtask-claim');
      expect(planRows[0]?.metadata).toContain('"status":"available"');
      expect(planRows.some((row) => row.metadata?.includes('"status":"claimed"'))).toBe(true);
    });
  });

  it('auto-releases safe stale claims in JSON mode while preserving audit history', async () => {
    await seedSweepSignals();

    await createProgram().parseAsync(
      ['node', 'test', 'coordination', 'sweep', '--repo-root', repoRoot, '--json'],
      { from: 'node' },
    );

    const json = JSON.parse(output) as {
      dry_run: boolean;
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
      recommended_actions: string[];
    };

    expect(json.dry_run).toBe(false);
    expect(json.summary).toMatchObject({
      stale_claim_count: 1,
      expired_weak_claim_count: 0,
      released_stale_claim_count: 1,
      downgraded_stale_claim_count: 2,
      skipped_dirty_claim_count: 1,
    });
    expect(json.released_stale_claims).toEqual([
      expect.objectContaining({ file_path: 'src/expired.ts', reason: 'expired_weak_claim' }),
    ]);
    expect(json.downgraded_stale_claims.map((claim) => claim.file_path).sort()).toEqual([
      'src/stale-active.ts',
      'src/stale.ts',
    ]);
    expect(json.skipped_dirty_claims).toEqual([
      expect.objectContaining({
        file_path: 'src/blocked-0.ts',
        reason: 'stale_downstream_blocker',
      }),
    ]);
    expect(json.recommended_actions).toEqual(
      expect.arrayContaining([
        expect.stringContaining('audit history retained'),
        expect.stringContaining('rescue stale downstream blocker'),
      ]),
    );

    const settings = loadSettings();
    await withStore(settings, (store) => {
      const mainTaskId = taskIdByBranch(store, 'main');
      expect(store.storage.listClaims(mainTaskId).map((claim) => claim.file_path).sort()).toEqual([
        'src/fresh.ts',
      ]);
      expect(store.storage.taskObservationsByKind(mainTaskId, 'coordination-sweep')).toHaveLength(
        3,
      );
      expect(store.storage.taskObservationsByKind(mainTaskId, 'handoff')).toHaveLength(1);
      expect(store.storage.taskObservationsByKind(mainTaskId, 'message')).toHaveLength(1);
    });
  });

});

async function seedSweepSignals(): Promise<void> {
  const settings = loadSettings();
  await withStore(settings, (store) => {
    setMinutesAgo(300);
    store.startSession({ id: 'codex@stale', ide: 'codex', cwd: repoRoot });
    store.startSession({ id: 'claude@target', ide: 'claude-code', cwd: repoRoot });
    const thread = TaskThread.open(store, {
      repo_root: storedRepoRoot,
      branch: 'main',
      title: 'main task',
      session_id: 'codex@stale',
    });
    thread.join('codex@stale', 'codex');
    thread.join('claude@target', 'claude');
    thread.claimFile({ session_id: 'codex@stale', file_path: 'src/stale.ts' });
    thread.claimFile({ session_id: 'codex@stale', file_path: 'src/stale-active.ts' });
    store.storage.upsertPheromone({
      task_id: thread.task_id,
      file_path: 'src/hot.ts',
      session_id: 'codex@stale',
      strength: 2,
      deposited_at: Date.now(),
    });

    setMinutesAgo(10);
    thread.claimFile({ session_id: 'codex@stale', file_path: 'src/fresh.ts' });

    setMinutesAgo(5);
    store.storage.upsertPheromone({
      task_id: thread.task_id,
      file_path: 'src/stale-active.ts',
      session_id: 'codex@stale',
      strength: 1,
      deposited_at: Date.now(),
    });

    setMinutesAgo(720);
    thread.claimFile({ session_id: 'codex@stale', file_path: 'src/expired.ts' });

    setMinutesAgo(30);
    thread.handOff({
      from_session_id: 'codex@stale',
      from_agent: 'codex',
      to_agent: 'claude',
      to_session_id: 'claude@target',
      summary: 'expired handoff',
      expires_in_ms: 5 * MINUTE_MS,
    });
    thread.postMessage({
      from_session_id: 'codex@stale',
      from_agent: 'codex',
      to_agent: 'claude',
      to_session_id: 'claude@target',
      urgency: 'blocking',
      content: 'expired blocking message',
      expires_in_ms: 5 * MINUTE_MS,
    });

    setMinutesAgo(720);
    const proposals = new ProposalSystem(store);
    proposals.propose({
      repo_root: storedRepoRoot,
      branch: 'main',
      summary: 'old proposal',
      rationale: 'Old weak candidate.',
      touches_files: ['src/proposal.ts'],
      session_id: 'codex@stale',
    });

    seedBlockedPlan(store);
    vi.setSystemTime(NOW);
  });
}

function seedBlockedPlan(store: MemoryStore): void {
  setMinutesAgo(300);
  const parent = TaskThread.open(store, {
    repo_root: storedRepoRoot,
    branch: 'spec/blocked-plan',
    title: 'blocked plan',
    session_id: 'codex@stale',
  });
  store.addObservation({
    session_id: 'codex@stale',
    task_id: parent.task_id,
    kind: 'plan-config',
    content: 'plan blocked-plan config: auto_archive=false',
    metadata: { plan_slug: 'blocked-plan', auto_archive: false },
  });

  for (let i = 0; i < 2; i++) {
    const thread = TaskThread.open(store, {
      repo_root: storedRepoRoot,
      branch: `spec/blocked-plan/sub-${i}`,
      session_id: 'codex@stale',
    });
    store.addObservation({
      session_id: 'codex@stale',
      task_id: thread.task_id,
      kind: 'plan-subtask',
      content: `Subtask ${i}\n\nSeeded blocked plan subtask ${i}.`,
      metadata: {
        parent_plan_slug: 'blocked-plan',
        parent_plan_title: 'blocked plan',
        parent_spec_task_id: parent.task_id,
        subtask_index: i,
        file_scope: [`src/blocked-${i}.ts`],
        depends_on: i === 0 ? [] : [0],
        spec_row_id: null,
        capability_hint: 'api_work',
        status: 'available',
      },
    });
    if (i === 0) {
      thread.join('codex@stale', 'codex');
      thread.claimFile({ session_id: 'codex@stale', file_path: 'src/blocked-0.ts' });
      store.addObservation({
        session_id: 'codex@stale',
        task_id: thread.task_id,
        kind: 'plan-subtask-claim',
        content: 'claimed blocked plan subtask 0',
        metadata: {
          kind: 'plan-subtask-claim',
          subtask_index: 0,
          status: 'claimed',
          session_id: 'codex@stale',
          agent: 'codex',
        },
      });
    }
  }
}

function taskIdByBranch(store: MemoryStore, branch: string): number {
  const task = store.storage
    .listTasks(2_000)
    .find((candidate) => candidate.repo_root === storedRepoRoot && candidate.branch === branch);
  if (!task) throw new Error(`missing task for ${branch}`);
  return task.id;
}

function setMinutesAgo(minutes: number): void {
  vi.setSystemTime(NOW - minutes * MINUTE_MS);
}
