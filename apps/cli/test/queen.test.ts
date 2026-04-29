import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSettings } from '@colony/config';
import { TaskThread, buildAttentionInbox, listPlans } from '@colony/core';
import { SpecRepository } from '@colony/spec';
import kleur from 'kleur';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProgram } from '../src/index.js';
import { withStore } from '../src/util/store.js';

const MINIMAL_SPEC = `# SPEC

## §G  goal
Test fixture spec for queen CLI tests.

## §C  constraints
- markdown only.

## §I  interfaces
- none

## §V  invariants
id|rule|cites
-|-|-
V1|placeholder|-

## §T  tasks
id|status|task|cites
-|-|-|-
T1|todo|placeholder|V1

## §B  bugs
id|bug|cites
-|-|-
`;

const MINUTE_MS = 60_000;
const SWEEP_NOW = Date.UTC(2026, 3, 28, 12, 0, 0);

let repoRoot: string;
let dataDir: string;
let output: string;
let originalColonyHome: string | undefined;

beforeEach(() => {
  kleur.enabled = false;
  repoRoot = mkdtempSync(join(tmpdir(), 'colony-cli-queen-repo-'));
  dataDir = mkdtempSync(join(tmpdir(), 'colony-cli-queen-data-'));
  writeFileSync(join(repoRoot, 'SPEC.md'), MINIMAL_SPEC, 'utf8');
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

describe('colony queen CLI', () => {
  it('shows queen help in a reviewable snapshot', () => {
    const program = createProgram();
    const queen = program.commands.find((command) => command.name() === 'queen');

    expect(queen?.helpInformation()).toMatchInlineSnapshot(`
      "Usage: colony queen [options] [command]

      Queen coordination helpers for published plan lanes

      Options:
        -h, --help                display help for command

      Commands:
        plan [options] [title]    Draft or publish a queen plan from the terminal
        adoption-fixes [options]  Publish current Colony adoption-fix waves into the
                                  local DB
        list [options]            List queen-published plans with sub-task rollup
        status [options] <slug>   Show one queen plan and its sub-task claim state
        sweep [options]           List queen plans needing attention: stalled,
                                  unclaimed, ready to archive
        help [command]            display help for command
      "
    `);
  });

  it('renders dry-run sub-task drafts as a table without publishing', async () => {
    await createProgram().parseAsync(
      [
        'node',
        'test',
        'queen',
        'plan',
        'test goal',
        '--problem',
        'Need a plan.',
        '--accept',
        'Plan is visible',
        '--files',
        'src/x.ts',
        '--repo-root',
        repoRoot,
        '--dry-run',
      ],
      { from: 'node' },
    );

    expect(output).toContain('queen plan draft test-goal');
    expect(output).toContain('slug | title | capability | file_scope | depends_on');
    expect(output).toContain(
      'test-goal/sub-0 | Update shared infrastructure scope | infra_work | src/x.ts | -',
    );
    expect(output).toContain(
      'test-goal/sub-1 | Verify infrastructure scope | infra_work | src/x.ts | sub-0',
    );
    expect(existsSync(join(repoRoot, 'openspec/changes/test-goal/CHANGE.md'))).toBe(false);
  });

  it('renders file-based dry-run JSON with wave order and blockers', async () => {
    const planFile = join(repoRoot, 'queen-plan.json');
    writeFileSync(
      planFile,
      JSON.stringify({
        goal_title: 'Auth parallel rollout',
        problem: 'Auth changes need safe manual launch order.',
        acceptance_criteria: ['Agents can preview launch order'],
        affected_files: [
          'packages/storage/src/auth.ts',
          'apps/api/src/auth.ts',
          'apps/web/src/AuthPanel.tsx',
          'apps/api/test/auth.test.ts',
        ],
        ordering_hint: 'wave',
        waves: [
          {
            name: 'Foundation',
            titles: ['Prepare storage scope'],
            rationale: 'Storage contract first.',
          },
          {
            name: 'Product',
            titles: ['Implement API scope', 'Implement web scope'],
            rationale: 'API and web can run together after storage.',
          },
        ],
        finalizer: 'Add targeted tests',
      }),
      'utf8',
    );

    await createProgram().parseAsync(
      ['node', 'test', 'queen', 'plan', '--file', planFile, '--dry-run', '--json'],
      { from: 'node' },
    );

    const preview = JSON.parse(output);
    expect(preview.dry_run).toBe(true);
    expect(preview.plan.slug).toBe('auth-parallel-rollout');
    expect(
      preview.waves.map((wave: { parallel_subtasks: Array<{ ref: string }> }) =>
        wave.parallel_subtasks.map((task) => task.ref),
      ),
    ).toEqual([['sub-0'], ['sub-1', 'sub-2'], ['sub-3']]);
    expect(preview.depends_on_edges).toContainEqual({
      from: 'sub-0',
      to: 'sub-1',
      reason: 'sub-0 must finish before sub-1 can start',
    });
    expect(preview.blocked_future_work.map((task: { ref: string }) => task.ref)).toEqual([
      'sub-1',
      'sub-2',
      'sub-3',
    ]);
    expect(preview.finalizer_tasks.map((task: { ref: string }) => task.ref)).toEqual(['sub-3']);
    expect(preview.rationale).toContain('Storage contract first.');
    expect(existsSync(join(repoRoot, 'openspec/changes/auth-parallel-rollout/CHANGE.md'))).toBe(
      false,
    );
  });

  it('publishes queen plans and renders human-readable sub-tasks', async () => {
    await createProgram().parseAsync(
      [
        'node',
        'test',
        'queen',
        'plan',
        'test goal',
        '--problem',
        'Need a plan.',
        '--accept',
        'API works',
        '--accept',
        'UI works',
        '--files',
        'apps/api/x.ts',
        'apps/web/y.tsx',
        '--repo-root',
        repoRoot,
      ],
      { from: 'node' },
    );

    expect(output).toContain('queen plan published test-goal');
    expect(output).toContain('sub-0 Implement API scope');
    expect(output).toContain('file-scope: apps/api/x.ts');
    expect(output).toContain('sub-1 Implement web scope');
    expect(output).toContain('file-scope: apps/web/y.tsx');
    expect(readFileSync(join(repoRoot, 'openspec/changes/test-goal/CHANGE.md'), 'utf8')).toContain(
      '## Acceptance criteria',
    );
  });

  it('publishes the current adoption-fix waves into the local DB', async () => {
    await createProgram().parseAsync(
      ['node', 'test', 'queen', 'adoption-fixes', '--repo-root', repoRoot, '--json'],
      { from: 'node' },
    );

    const payload = JSON.parse(output);
    expect(payload).toMatchObject({
      plan_slug: 'colony-adoption-fixes',
      status: 'published',
      active_plans: 1,
      ready_subtasks: 3,
      blocked_subtasks: 4,
    });
    expect(payload.claimable_current_wave.map((task: { title: string }) => task.title)).toEqual([
      'Codex/OMX claim-before-edit bridge',
      'Active task binding for auto-claim',
      'Strengthen hivemind_context to attention_inbox funnel',
    ]);
    expect(payload.claimable_current_wave[0].claim_args).toEqual({
      plan_slug: 'colony-adoption-fixes',
      subtask_index: 0,
      session_id: '<session_id>',
      agent: '<agent>',
    });

    const settings = loadSettings();
    await withStore(settings, (store) => {
      const [plan] = listPlans(store, { repo_root: repoRoot });
      expect(plan?.plan_slug).toBe('colony-adoption-fixes');
      expect(plan?.next_available).toHaveLength(3);
      expect(plan?.subtasks.filter((subtask) => subtask.blocked_by_count > 0)).toHaveLength(4);
    });
    expect(existsSync(join(repoRoot, 'openspec/changes/colony-adoption-fixes/CHANGE.md'))).toBe(
      false,
    );

    output = '';
    await createProgram().parseAsync(
      ['node', 'test', 'queen', 'adoption-fixes', '--repo-root', repoRoot, '--json'],
      { from: 'node' },
    );
    expect(JSON.parse(output)).toMatchObject({
      plan_slug: 'colony-adoption-fixes',
      status: 'already_active',
      ready_subtasks: 3,
    });
  });

  it('lists only queen-owned plans with sub-task rollup', async () => {
    await publishQueenPlan('queen goal', ['apps/api/queen.ts']);
    await publishNonQueenPlan();
    output = '';

    await createProgram().parseAsync(['node', 'test', 'queen', 'list', '--repo-root', repoRoot], {
      from: 'node',
    });

    expect(output).toContain('queen-goal  queen goal');
    expect(output).toContain('status: 2 available, 0 claimed, 0 completed, 0 blocked');
    expect(output).toContain('sub-0 [available] Implement API scope (api_work)');
    expect(output).not.toContain('codex-goal');
  });

  it('shows queen plan status with claim ownership', async () => {
    await publishQueenPlan('claimed queen goal', ['apps/api/claimed.ts']);
    await markFirstSubtaskClaimed('claimed-queen-goal');
    output = '';

    await createProgram().parseAsync(
      ['node', 'test', 'queen', 'status', 'claimed-queen-goal', '--repo-root', repoRoot],
      { from: 'node' },
    );

    expect(output).toContain('queen plan claimed-queen-goal');
    expect(output).toContain('sub-0 [claimed] Implement API scope');
    expect(output).toContain('claimed: codex (codex@claim)');
    expect(output).toContain('file-scope: apps/api/claimed.ts');
  });

  it('renders queen sweep diagnostics grouped by wave without messaging by default', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(SWEEP_NOW);
    await seedOrderedSweepPlan();
    output = '';

    await createProgram().parseAsync(['node', 'test', 'queen', 'sweep', '--repo-root', repoRoot], {
      from: 'node',
    });

    expect(output).toContain('Wave diagnostics:');
    expect(output).toContain('Wave 1 has 2 stalled subtasks');
    expect(output).toContain('Wave 2 is blocked by Wave 1');
    expect(output).toContain('Finalizer waiting on 3 subtasks');
    expect(output).toContain(
      'replacement claude-code (Codex recently hit quota on this branch; next task_accept_handoff)',
    );

    const settings = loadSettings();
    await withStore(settings, (store) => {
      const inbox = buildAttentionInbox(store, {
        session_id: 'codex@wave-a',
        agent: 'codex',
        include_stalled_lanes: false,
      });
      expect(inbox.unread_messages).toHaveLength(0);
    });
  });
});

async function publishQueenPlan(title: string, files: string[]): Promise<void> {
  await createProgram().parseAsync(
    [
      'node',
      'test',
      'queen',
      'plan',
      title,
      '--problem',
      'Need queen work.',
      '--accept',
      'Done',
      '--files',
      ...files,
      '--repo-root',
      repoRoot,
    ],
    { from: 'node' },
  );
}

async function publishNonQueenPlan(): Promise<void> {
  const settings = loadSettings();
  await withStore(settings, (store) => {
    store.startSession({ id: 'codex@plan', ide: 'codex', cwd: repoRoot });
    const repo = new SpecRepository({ repoRoot, store });
    const opened = repo.openChange({
      slug: 'codex-goal',
      session_id: 'codex@plan',
      agent: 'codex',
      proposal: '# codex goal\n',
    });
    const thread = TaskThread.open(store, {
      repo_root: repoRoot,
      branch: 'spec/codex-goal/sub-0',
      session_id: 'codex@plan',
    });
    store.addObservation({
      session_id: 'codex@plan',
      task_id: thread.task_id,
      kind: 'plan-subtask',
      content: 'codex goal\n\nNot queen.',
      metadata: {
        parent_plan_slug: 'codex-goal',
        parent_plan_title: 'codex goal',
        parent_spec_task_id: opened.task_id,
        subtask_index: 0,
        file_scope: ['apps/api/codex.ts'],
        depends_on: [],
        capability_hint: 'api_work',
        status: 'available',
      },
    });
  });
}

async function markFirstSubtaskClaimed(slug: string): Promise<void> {
  const settings = loadSettings();
  await withStore(settings, (store) => {
    const plan = listPlans(store, { repo_root: repoRoot }).find(
      (candidate) => candidate.plan_slug === slug,
    );
    const subtask = plan?.subtasks[0];
    if (!subtask) throw new Error(`missing subtask for ${slug}`);
    store.addObservation({
      session_id: 'codex@claim',
      task_id: subtask.task_id,
      kind: 'plan-subtask-claim',
      content: `codex claimed sub-task 0 of plan ${slug}`,
      metadata: {
        status: 'claimed',
        session_id: 'codex@claim',
        agent: 'codex',
      },
    });
  });
}

async function seedOrderedSweepPlan(): Promise<void> {
  const settings = loadSettings();
  await withStore(settings, (store) => {
    setSweepMinutesAgo(360);
    store.startSession({ id: 'queen@ordered', ide: 'codex', cwd: repoRoot });
    const parent = TaskThread.open(store, {
      repo_root: repoRoot,
      branch: 'spec/ordered-sweep',
      title: 'ordered sweep',
      session_id: 'queen@ordered',
    });
    parent.join('queen@ordered', 'queen');
    store.addObservation({
      session_id: 'queen@ordered',
      task_id: parent.task_id,
      kind: 'plan-config',
      content: 'plan ordered-sweep config: auto_archive=false',
      metadata: { plan_slug: 'ordered-sweep', auto_archive: false },
    });

    const subtasks = [
      {
        title: 'Wave one A',
        depends_on: [],
        wave_index: 0,
        wave_id: 'wave-1',
        wave_title: 'Foundation',
        claimed_minutes_ago: 95,
        session_id: 'codex@wave-a',
      },
      {
        title: 'Wave one B',
        depends_on: [],
        wave_index: 0,
        wave_id: 'wave-1',
        wave_title: 'Foundation',
        claimed_minutes_ago: 80,
        session_id: 'codex@wave-b',
      },
      {
        title: 'Wave two blocked',
        depends_on: [0, 1],
        wave_index: 1,
        wave_id: 'wave-2',
        wave_title: 'Product work',
      },
      {
        title: 'Finalizer',
        depends_on: [0, 1, 2],
        wave_index: 2,
        wave_id: 'finalizer',
        wave_label: 'Finalizer',
        wave_role: 'finalizer',
      },
    ];

    for (let i = 0; i < subtasks.length; i++) {
      const subtask = subtasks[i];
      if (!subtask) continue;
      setSweepMinutesAgo(300);
      const thread = TaskThread.open(store, {
        repo_root: repoRoot,
        branch: `spec/ordered-sweep/sub-${i}`,
        session_id: 'queen@ordered',
      });
      thread.join('queen@ordered', 'queen');
      store.addObservation({
        session_id: 'queen@ordered',
        task_id: thread.task_id,
        kind: 'plan-subtask',
        content: `${subtask.title}\n\nSeeded CLI sweep sub-task ${i}.`,
        metadata: {
          parent_plan_slug: 'ordered-sweep',
          parent_plan_title: 'ordered sweep',
          parent_spec_task_id: parent.task_id,
          subtask_index: i,
          file_scope: [`src/ordered-${i}.ts`],
          depends_on: subtask.depends_on,
          spec_row_id: null,
          capability_hint: 'infra_work',
          status: 'available',
          wave_index: subtask.wave_index,
          wave_id: subtask.wave_id,
          ...(subtask.wave_title !== undefined ? { wave_title: subtask.wave_title } : {}),
          ...(subtask.wave_label !== undefined ? { wave_label: subtask.wave_label } : {}),
          ...(subtask.wave_role !== undefined ? { wave_role: subtask.wave_role } : {}),
        },
      });

      if (subtask.claimed_minutes_ago !== undefined) {
        const sessionId = subtask.session_id ?? `codex@wave-${i}`;
        store.startSession({ id: sessionId, ide: 'codex', cwd: repoRoot });
        thread.join(sessionId, 'codex');
        setSweepMinutesAgo(subtask.claimed_minutes_ago);
        store.addObservation({
          session_id: sessionId,
          task_id: thread.task_id,
          kind: 'plan-subtask-claim',
          content: `codex claimed sub-task ${i} of plan ordered-sweep`,
          metadata: {
            status: 'claimed',
            session_id: sessionId,
            agent: 'codex',
            plan_slug: 'ordered-sweep',
            subtask_index: i,
          },
        });
        if (i === 0) {
          store.addObservation({
            session_id: sessionId,
            task_id: thread.task_id,
            kind: 'handoff',
            content: 'codex quota_exhausted handoff',
            metadata: {
              kind: 'handoff',
              status: 'pending',
              from_session_id: sessionId,
              from_agent: 'codex',
              to_agent: 'any',
              to_session_id: null,
              quota_exhausted: true,
              summary: 'Codex hit quota',
              blockers: ['quota_exhausted'],
              accepted_by_session_id: null,
              accepted_at: null,
              expires_at: SWEEP_NOW + MINUTE_MS,
            },
          });
        }
      }
    }
    vi.setSystemTime(SWEEP_NOW);
  });
}

function setSweepMinutesAgo(minutes: number): void {
  vi.setSystemTime(SWEEP_NOW - minutes * MINUTE_MS);
}
