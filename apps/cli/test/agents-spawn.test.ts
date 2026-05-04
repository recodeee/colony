import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSettings } from '@colony/config';
import { listPlans } from '@colony/core';
import { type PublishPlanSubtaskInput, publishPlan } from '@colony/spec';
import kleur from 'kleur';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type CommandResult,
  setGitGuardexCommandRunnerForTests,
} from '../src/executors/gitguardex.js';
import { createProgram } from '../src/index.js';
import { withStore } from '../src/util/store.js';

const MINIMAL_SPEC = `# SPEC

## §G  goal
Test fixture spec for agents spawn tests.

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
-|-|-
T1|todo|placeholder|V1

## §B  bugs
id|bug|cites
-+-|-
`;

let repoRoot: string;
let dataDir: string;
let gxArgsFile: string;
let output: string;
let originalColonyHome: string | undefined;

beforeEach(() => {
  kleur.enabled = false;
  repoRoot = mkdtempSync(join(tmpdir(), 'colony-cli-agents-repo-'));
  dataDir = mkdtempSync(join(tmpdir(), 'colony-cli-agents-data-'));
  gxArgsFile = join(repoRoot, 'gx-args.txt');
  writeFileSync(join(repoRoot, 'SPEC.md'), MINIMAL_SPEC, 'utf8');

  originalColonyHome = process.env.COLONY_HOME;
  process.env.COLONY_HOME = dataDir;
  process.exitCode = undefined;
  setGitGuardexCommandRunnerForTests(fakeGxRunner);

  output = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  setGitGuardexCommandRunnerForTests(null);
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
  if (originalColonyHome === undefined) delete process.env.COLONY_HOME;
  else process.env.COLONY_HOME = originalColonyHome;
  delete process.env.GX_ARGS_FILE;
  delete process.env.GX_MISSING;
  kleur.enabled = true;
  process.exitCode = undefined;
});

describe('colony agents spawn', () => {
  it('refuses the gx executor when GitGuardex is unavailable', async () => {
    process.env.GX_MISSING = '1';

    await expect(
      createProgram().parseAsync(
        ['node', 'test', 'agents', 'spawn', '--executor', 'gx', '--dry-run'],
        { from: 'node' },
      ),
    ).rejects.toThrow('GitGuardex executor unavailable: gx not found on PATH');
  });

  it('prints the exact gx agents start command in dry-run mode', async () => {
    seedPlan('demo', [
      {
        title: 'Implement storage executor',
        description: 'Wire the executor into the CLI.',
        file_scope: ['apps/cli/src/executors/gitguardex.ts'],
        capability_hint: 'infra_work',
      },
      {
        title: 'Verify executor',
        description: 'Run focused CLI tests.',
        file_scope: ['apps/cli/test/agents-spawn.test.ts'],
        depends_on: [0],
        capability_hint: 'test_work',
      },
    ]);

    await createProgram().parseAsync(
      [
        'node',
        'test',
        'agents',
        'spawn',
        '--executor',
        'gx',
        '--plan',
        'demo',
        '--subtask',
        '0',
        '--agent',
        'codex',
        '--session-id',
        'spawn-session',
        '--repo-root',
        repoRoot,
        '--dry-run',
      ],
      { from: 'node' },
    );

    expect(output).toContain('GitGuardex executor ready 7.0.42');
    expect(output).toContain('gx agents start command:');
    expect(output).toContain('gx agents start');
    expect(output).toContain('full agent prompt:');
    expect(output).toContain('colony.plan: demo');
    expect(output).toContain('colony.subtask: 0');
    expect(output).toContain('colony.task_id:');
    expect(output).toContain('colony.session_id: spawn-session');
    expect(output).toContain('Plan slug: demo');
    expect(output).toContain('Plan title: demo');
    expect(output).toContain('Plan goal: Need a claimable plan.');
    expect(output).toContain('Wave: Wave 1 (0)');
    expect(output).toContain('Subtask: 0 - Implement storage executor');
    expect(output).toContain('You are one parallel worker in this Queen plan');
    expect(output).toContain('Do not modify sibling files');
    expect(output).toContain('Coordinate through task_note_working/task_message');
    expect(output).toContain('Stop and hand off if quota or conflict');
    expect(output).toContain('Sibling files:\n- apps/cli/test/agents-spawn.test.ts');
    expect(output).toContain('Do-not-touch list:\n- apps/cli/test/agents-spawn.test.ts');
    expect(output).toContain(`--target ${repoRoot}`);
    expect(output).toContain('--claim apps/cli/src/executors/gitguardex.ts');
    expect(existsSync(gxArgsFile)).toBe(false);
  });

  it('creates a normal launch packet when no Queen plan is active', async () => {
    await createProgram().parseAsync(
      [
        'node',
        'test',
        'agents',
        'spawn',
        '--executor',
        'gx',
        '--agent',
        'codex',
        '--session-id',
        'spawn-session',
        '--repo-root',
        repoRoot,
        '--dry-run',
      ],
      { from: 'node' },
    );

    expect(output).toContain('gx agents start command:');
    expect(output).toContain('full agent prompt:');
    expect(output).toContain('colony.plan: <none>');
    expect(output).toContain('colony.subtask: <none>');
    expect(output).toContain('colony.task_id: <none>');
    expect(output).toContain('colony.session_id: spawn-session');
    expect(output).toContain('Plan: <none>');
    expect(output).toContain('Mode: normal Colony launch packet');
    expect(output).toContain('Claimed files:\n- <none>');
    expect(output).not.toContain('--claim');
    expect(existsSync(gxArgsFile)).toBe(false);
  });

  it('maps the next ready subtask file scope to gx claim args and Colony claims', async () => {
    seedPlan('ready-demo', [
      {
        title: 'Implement API scope',
        description: 'Change API files.',
        file_scope: ['packages/api/src/index.ts', 'packages/api/test/index.test.ts'],
        capability_hint: 'api_work',
      },
      {
        title: 'Blocked UI scope',
        description: 'Depends on API.',
        file_scope: ['apps/web/src/App.tsx'],
        depends_on: [0],
        capability_hint: 'ui_work',
      },
    ]);

    await createProgram().parseAsync(
      [
        'node',
        'test',
        'agents',
        'spawn',
        '--executor',
        'gx',
        '--agent',
        'claude',
        '--session-id',
        'spawn-session',
        '--repo-root',
        repoRoot,
      ],
      { from: 'node' },
    );

    expect(output).toBe('spawned\n');
    expect(JSON.parse(readFileSync(gxArgsFile, 'utf8'))).toEqual([
      'agents',
      'start',
      expect.stringContaining('Plan slug: ready-demo'),
      '--agent',
      'claude',
      '--target',
      repoRoot,
      '--claim',
      'packages/api/src/index.ts',
      '--claim',
      'packages/api/test/index.test.ts',
    ]);

    const settings = loadSettings();
    withStore(settings, (store) => {
      const [plan] = listPlans(store, { repo_root: repoRoot });
      const subtask = plan?.subtasks[0];
      expect(subtask?.status).toBe('claimed');
      expect(subtask?.claimed_by_session_id).toBe('spawn-session');
      expect(
        store.storage.listClaims(subtask?.task_id ?? -1).map((claim) => claim.file_path),
      ).toEqual(['packages/api/src/index.ts', 'packages/api/test/index.test.ts']);
    });
  });

  it('refuses duplicate spawn when the subtask is already claimed', async () => {
    seedPlan('claimed-demo', [
      {
        title: 'Implement claimed scope',
        description: 'Already owned by another session.',
        file_scope: ['src/claimed.ts'],
        capability_hint: 'infra_work',
      },
    ]);
    claimSubtask('claimed-demo', 0, 'other-session');

    await expect(
      createProgram().parseAsync(
        [
          'node',
          'test',
          'agents',
          'spawn',
          '--executor',
          'gx',
          '--plan',
          'claimed-demo',
          '--subtask',
          '0',
          '--agent',
          'codex',
          '--session-id',
          'spawn-session',
          '--repo-root',
          repoRoot,
          '--dry-run',
        ],
        { from: 'node' },
      ),
    ).rejects.toThrow('claimed-demo/sub-0 already claimed by active owner other-session');
    expect(existsSync(gxArgsFile)).toBe(false);
  });
});

function fakeGxRunner(command: string, args: string[]): CommandResult {
  const argv = args;
  if (command !== 'gx') return spawnResult(2, '', `unexpected command: ${command}`);
  if (argv[0] === '--version') {
    if (process.env.GX_MISSING === '1') {
      const error = Object.assign(new Error('spawnSync gx ENOENT'), { code: 'ENOENT' });
      return spawnResult(null, '', '', error);
    }
    return spawnResult(0, '7.0.42\n', '');
  }
  if (argv[0] === 'agents' && argv[1] === 'start') {
    writeFileSync(gxArgsFile, JSON.stringify(argv, null, 2), 'utf8');
    return spawnResult(0, 'spawned\n', '');
  }
  return spawnResult(2, '', `unexpected gx args: ${argv.join(' ')}`);
}

function spawnResult(
  status: number | null,
  stdout: string,
  stderr: string,
  error?: Error & { code?: string },
): CommandResult {
  return {
    stdout,
    stderr,
    status,
    ...(error !== undefined ? { error } : {}),
  };
}

function seedPlan(slug: string, subtasks: PublishPlanSubtaskInput[]): void {
  const settings = loadSettings();
  withStore(settings, (store) => {
    store.startSession({ id: 'planner-session', ide: 'queen', cwd: repoRoot });
    publishPlan({
      store,
      repo_root: repoRoot,
      slug,
      session_id: 'planner-session',
      agent: 'queen',
      title: slug,
      problem: 'Need a claimable plan.',
      acceptance_criteria: ['Agents can spawn ready work'],
      subtasks,
      auto_archive: false,
    });
  });
}

function claimSubtask(slug: string, subtaskIndex: number, sessionId: string): void {
  const settings = loadSettings();
  withStore(settings, (store) => {
    const plan = listPlans(store, { repo_root: repoRoot }).find(
      (candidate) => candidate.plan_slug === slug,
    );
    const subtask = plan?.subtasks.find((candidate) => candidate.subtask_index === subtaskIndex);
    if (!subtask) throw new Error(`missing test subtask ${slug}/sub-${subtaskIndex}`);
    store.addObservation({
      session_id: sessionId,
      task_id: subtask.task_id,
      kind: 'plan-subtask-claim',
      content: `${sessionId} claimed test subtask`,
      metadata: {
        status: 'claimed',
        session_id: sessionId,
        agent: 'codex',
        plan_slug: slug,
        subtask_index: subtaskIndex,
      },
    });
  });
}
