import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSettings } from '@colony/config';
import { TaskThread, listPlans } from '@colony/core';
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
});

describe('colony queen CLI', () => {
  it('shows queen help in a reviewable snapshot', () => {
    const program = createProgram();
    const queen = program.commands.find((command) => command.name() === 'queen');

    expect(queen?.helpInformation()).toMatchInlineSnapshot(`
      "Usage: colony queen [options] [command]

      Queen coordination helpers for published plan lanes

      Options:
        -h, --help               display help for command

      Commands:
        plan [options] <title>   Draft or publish a queen plan from the terminal
        list [options]           List queen-published plans with sub-task rollup
        status [options] <slug>  Show one queen plan and its sub-task claim state
        sweep [options]          List queen plans needing attention: stalled,
                                 unclaimed, ready to archive
        help [command]           display help for command
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

  it('lists only queen-owned plans with sub-task rollup', async () => {
    await publishQueenPlan('queen goal', ['apps/api/queen.ts']);
    await publishNonQueenPlan();
    output = '';

    await createProgram().parseAsync(
      ['node', 'test', 'queen', 'list', '--repo-root', repoRoot],
      { from: 'node' },
    );

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
    const plan = listPlans(store, { repo_root: repoRoot }).find((candidate) => candidate.plan_slug === slug);
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
