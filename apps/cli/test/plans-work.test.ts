import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSettings } from '@colony/config';
import { type MemoryStore, TaskThread } from '@colony/core';
import kleur from 'kleur';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ColonyHealthPayload } from '../src/commands/health.js';
import { buildPlanWorkBatch } from '../src/commands/plans.js';
import { createProgram } from '../src/index.js';
import { withStore } from '../src/util/store.js';

let repoRoot: string;
let dataDir: string;
let output: string;
let originalColonyHome: string | undefined;

beforeEach(() => {
  kleur.enabled = false;
  repoRoot = mkdtempSync(join(tmpdir(), 'colony-plans-work-repo-'));
  dataDir = mkdtempSync(join(tmpdir(), 'colony-plans-work-data-'));
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
});

describe('colony plans work', () => {
  it('gates unsafe health to a single claim/contention janitor packet', async () => {
    const settings = loadSettings();
    await withStore(settings, (store) =>
      seedPlan(store, {
        slug: 'unsafe-plan',
        tasks: [{ title: 'Implement unsafe scope', fileScope: ['src/unsafe.ts'] }],
      }),
    );

    await withStore(settings, (store) => {
      const batch = buildPlanWorkBatch(store, {
        repoRoot,
        policy: 'finish-plans',
        dryRun: true,
        maxAgents: 4,
        health: healthPayload({
          live_file_contentions: 2,
          dirty_contended_files: 1,
          top_conflicts: [{ file_path: 'src/unsafe.ts' }],
        }),
      });

      expect(batch.health_gate.status).toBe('blocked');
      expect(batch.packets).toHaveLength(1);
      expect(batch.packets[0]).toMatchObject({
        role: 'claim-contention-janitor',
        plan_slug: null,
        subtask_index: null,
        file_scope: ['src/unsafe.ts'],
      });
      expect(batch.packets[0]?.spawn_command).toContain('colony agents spawn --executor gx');
    });
  });

  it('emits a spawn packet for ready subtask without mutating observations', async () => {
    const settings = loadSettings();
    await withStore(settings, (store) =>
      seedPlan(store, {
        slug: 'ready-plan',
        tasks: [{ title: 'Verify checkout flow', fileScope: ['apps/cli/test/checkout.test.ts'] }],
      }),
    );
    const before = await observationCount(settings);

    await createProgram().parseAsync(
      [
        'node',
        'test',
        'plans',
        'work',
        '--policy',
        'finish-plans',
        '--dry-run',
        '--repo-root',
        repoRoot,
        '--json',
      ],
      { from: 'node' },
    );

    const batch = JSON.parse(output);
    expect(batch.dry_run).toBe(true);
    expect(batch.health_gate.status).toBe('clear');
    expect(batch.packets).toHaveLength(1);
    expect(batch.packets[0]).toMatchObject({
      role: 'plan-verifier',
      plan_slug: 'ready-plan',
      subtask_index: 0,
      task_title: 'Verify checkout flow',
      file_scope: ['apps/cli/test/checkout.test.ts'],
      suggested_agent: 'verifier',
    });
    expect(batch.packets[0].startup_loop.join('\n')).toContain('mcp__colony__task_ready_for_agent');
    expect(batch.packets[0].spawn_command).toContain('colony agents spawn --executor gx');
    expect(batch.packets[0].spawn_command).toContain('--plan-slug ready-plan');
    expect(await observationCount(settings)).toBe(before);
  });

  it('does not emit duplicate packet for already claimed work', async () => {
    const settings = loadSettings();
    await withStore(settings, (store) =>
      seedPlan(store, {
        slug: 'claimed-plan',
        tasks: [
          {
            title: 'Implement claimed scope',
            fileScope: ['src/claimed.ts'],
            claimStatus: 'claimed',
          },
        ],
      }),
    );

    await createProgram().parseAsync(
      [
        'node',
        'test',
        'plans',
        'work',
        '--policy',
        'finish-plans',
        '--dry-run',
        '--repo-root',
        repoRoot,
        '--json',
      ],
      { from: 'node' },
    );

    expect(JSON.parse(output).packets).toEqual([]);
  });

  it('respects max-agents limit after priority ranking', async () => {
    const settings = loadSettings();
    await withStore(settings, (store) =>
      seedPlan(store, {
        slug: 'ranked-plan',
        tasks: [
          { title: 'Implement API flow', fileScope: ['src/api.ts'] },
          { title: 'Final PR merge cleanup', fileScope: ['openspec/changes/ranked/tasks.md'] },
          { title: 'Run verification smoke', fileScope: ['test/smoke.test.ts'] },
        ],
      }),
    );

    await createProgram().parseAsync(
      [
        'node',
        'test',
        'plans',
        'work',
        '--policy',
        'finish-plans',
        '--max-agents',
        '2',
        '--dry-run',
        '--repo-root',
        repoRoot,
        '--json',
      ],
      { from: 'node' },
    );

    const batch = JSON.parse(output);
    expect(batch.packets).toHaveLength(2);
    expect(batch.packets.map((packet: { role: string }) => packet.role)).toEqual([
      'plan-finish-tail',
      'plan-verifier',
    ]);
  });
});

async function observationCount(settings: ReturnType<typeof loadSettings>): Promise<number> {
  return withStore(settings, (store) => store.storage.countObservations(), { readonly: true });
}

function seedPlan(
  store: MemoryStore,
  input: {
    slug: string;
    tasks: Array<{
      title: string;
      fileScope: string[];
      claimStatus?: 'claimed' | 'completed';
    }>;
  },
): void {
  const sessionId = `queen@${input.slug}`;
  store.startSession({ id: sessionId, ide: 'queen', cwd: repoRoot });
  const parent = TaskThread.open(store, {
    repo_root: repoRoot,
    branch: `spec/${input.slug}`,
    title: input.slug,
    session_id: sessionId,
  });
  store.addObservation({
    session_id: sessionId,
    task_id: parent.task_id,
    kind: 'plan-config',
    content: `plan ${input.slug} config`,
    metadata: { plan_slug: input.slug, auto_archive: false },
  });

  input.tasks.forEach((task, index) => {
    const thread = TaskThread.open(store, {
      repo_root: repoRoot,
      branch: `spec/${input.slug}/sub-${index}`,
      session_id: sessionId,
    });
    store.addObservation({
      session_id: sessionId,
      task_id: thread.task_id,
      kind: 'plan-subtask',
      content: `${task.title}\n\nSeeded plans work test subtask ${index}.`,
      metadata: {
        parent_plan_slug: input.slug,
        parent_plan_title: input.slug,
        parent_spec_task_id: parent.task_id,
        subtask_index: index,
        title: task.title,
        description: `Seeded plans work test subtask ${index}.`,
        file_scope: task.fileScope,
        depends_on: [],
        spec_row_id: null,
        capability_hint: null,
        status: 'available',
      },
    });
    if (task.claimStatus) {
      const claimSession = `codex@${input.slug}-${index}`;
      store.startSession({ id: claimSession, ide: 'codex', cwd: repoRoot });
      store.addObservation({
        session_id: claimSession,
        task_id: thread.task_id,
        kind: 'plan-subtask-claim',
        content: `${claimSession} ${task.claimStatus} subtask ${index}`,
        metadata: {
          status: task.claimStatus,
          session_id: claimSession,
          agent: 'codex',
          plan_slug: input.slug,
          subtask_index: index,
        },
      });
    }
  });
}

function healthPayload(live: {
  live_file_contentions: number;
  dirty_contended_files: number;
  top_conflicts?: Array<{ file_path: string }>;
}): ColonyHealthPayload {
  return {
    generated_at: new Date(0).toISOString(),
    live_contention_health: live,
    queen_wave_health: { replacement_recommendation: null },
  } as unknown as ColonyHealthPayload;
}
