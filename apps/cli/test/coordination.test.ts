import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSettings } from '@colony/config';
import { type MemoryStore, ProposalSystem, TaskThread } from '@colony/core';
import kleur from 'kleur';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProgram } from '../src/index.js';
import { withStore } from '../src/util/store.js';

const MINUTE_MS = 60_000;
const NOW = Date.UTC(2026, 3, 28, 12, 0, 0);

let repoRoot: string;
let dataDir: string;
let output: string;
let originalColonyHome: string | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  kleur.enabled = false;
  repoRoot = mkdtempSync(join(tmpdir(), 'colony-cli-coordination-repo-'));
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
      stale_claims: Array<{ file_path: string; age_minutes: number }>;
      expired_handoffs: Array<{ summary: string; expired_minutes: number }>;
      expired_messages: Array<{ preview: string; urgency: string }>;
      decayed_proposals: Array<{ summary: string; strength: number; noise_floor: number }>;
      stale_hot_files: Array<{ file_path: string; current_strength: number }>;
      blocked_downstream_tasks: Array<{ plan_slug: string; blocked_by_count: number }>;
    };

    expect(json.dry_run).toBe(true);
    expect(json.summary).toMatchObject({
      stale_claim_count: 1,
      expired_handoff_count: 1,
      expired_message_count: 1,
      decayed_proposal_count: 1,
      stale_hot_file_count: 1,
      blocked_downstream_task_count: 1,
    });
    expect(json.stale_claims[0]).toMatchObject({ file_path: 'src/stale.ts' });
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

    expect(output).toContain('Coordination sweep: 6 stale biological signal(s)');
    expect(output).toContain('mode: read-only');
    expect(output).toContain('Stale claims:');
    expect(output).toContain('confirm, release, or hand off');
    expect(output).toContain('Expired handoffs:');
    expect(output).toContain('send a fresh handoff if still needed');
    expect(output).toContain('Decayed proposals:');
    expect(output).toContain('reinforce or let fade');
    expect(output).toContain('Blocked downstream tasks:');
    expect(output).toContain('finish blocker or replan');

    const settings = loadSettings();
    await withStore(settings, (store) => {
      const mainTaskId = taskIdByBranch(store, 'main');
      expect(store.storage.listProposals(repoRoot)).toHaveLength(1);
      expect(store.storage.listClaims(mainTaskId)).toHaveLength(1);
      expect(store.storage.taskObservationsByKind(mainTaskId, 'handoff')).toHaveLength(1);
      expect(store.storage.taskObservationsByKind(mainTaskId, 'message')).toHaveLength(1);
    });
  });
});

async function seedSweepSignals(): Promise<void> {
  const settings = loadSettings();
  await withStore(settings, (store) => {
    setMinutesAgo(180);
    store.startSession({ id: 'codex@stale', ide: 'codex', cwd: repoRoot });
    store.startSession({ id: 'claude@target', ide: 'claude-code', cwd: repoRoot });
    const thread = TaskThread.open(store, {
      repo_root: repoRoot,
      branch: 'main',
      title: 'main task',
      session_id: 'codex@stale',
    });
    thread.join('codex@stale', 'codex');
    thread.join('claude@target', 'claude');
    thread.claimFile({ session_id: 'codex@stale', file_path: 'src/stale.ts' });
    store.storage.upsertPheromone({
      task_id: thread.task_id,
      file_path: 'src/hot.ts',
      session_id: 'codex@stale',
      strength: 2,
      deposited_at: Date.now(),
    });

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
      repo_root: repoRoot,
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
  setMinutesAgo(120);
  const parent = TaskThread.open(store, {
    repo_root: repoRoot,
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
      repo_root: repoRoot,
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
  }
}

function taskIdByBranch(store: MemoryStore, branch: string): number {
  const task = store.storage
    .listTasks(2_000)
    .find((candidate) => candidate.repo_root === repoRoot && candidate.branch === branch);
  if (!task) throw new Error(`missing task for ${branch}`);
  return task.id;
}

function setMinutesAgo(minutes: number): void {
  vi.setSystemTime(NOW - minutes * MINUTE_MS);
}
