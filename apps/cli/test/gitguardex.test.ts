import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { MemoryStore, listPlans } from '@colony/core';
import { publishOrderedPlan, type QueenOrderedPlanInput } from '@colony/queen';
import kleur from 'kleur';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProgram } from '../src/index.js';
import { spawnGitGuardexAgent, type GitGuardexExecFileSync } from '../src/lib/gitguardex.js';

const MINIMAL_SPEC = `# SPEC

## §G  goal
Test fixture spec for GitGuardex executor tests.

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
let binDir: string;
let logPath: string;
let output: string;
let originalColonyHome: string | undefined;
let originalPath: string | undefined;
let originalGxStatus: string | undefined;
let originalGxFailVersion: string | undefined;

beforeEach(() => {
  kleur.enabled = false;
  repoRoot = mkdtempSync(join(tmpdir(), 'colony-cli-gx-repo-'));
  dataDir = mkdtempSync(join(tmpdir(), 'colony-cli-gx-data-'));
  binDir = mkdtempSync(join(tmpdir(), 'colony-cli-gx-bin-'));
  logPath = join(binDir, 'gx.log');
  writeFileSync(join(repoRoot, 'SPEC.md'), MINIMAL_SPEC, 'utf8');
  writeFakeGx(join(binDir, 'gx'));
  originalColonyHome = process.env.COLONY_HOME;
  originalPath = process.env.PATH;
  originalGxStatus = process.env.GX_FAKE_AGENTS_STATUS;
  originalGxFailVersion = process.env.GX_FAKE_FAIL_VERSION;
  process.env.COLONY_HOME = dataDir;
  process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`;
  process.env.GX_FAKE_LOG = logPath;
  process.env.GX_FAKE_AGENTS_STATUS = JSON.stringify({
    schemaVersion: 1,
    repoRoot,
    sessions: [],
  });
  delete process.env.GX_FAKE_FAIL_VERSION;
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
  rmSync(binDir, { recursive: true, force: true });
  if (originalColonyHome === undefined) delete process.env.COLONY_HOME;
  else process.env.COLONY_HOME = originalColonyHome;
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalGxStatus === undefined) delete process.env.GX_FAKE_AGENTS_STATUS;
  else process.env.GX_FAKE_AGENTS_STATUS = originalGxStatus;
  if (originalGxFailVersion === undefined) delete process.env.GX_FAKE_FAIL_VERSION;
  else process.env.GX_FAKE_FAIL_VERSION = originalGxFailVersion;
  delete process.env.GX_FAKE_LOG;
  kleur.enabled = true;
});

describe('GitGuardex executor CLI', () => {
  it('prints a gx agents start command in dry-run mode', async () => {
    await seedPlan(singleFilePlan);

    await createProgram().parseAsync(
      [
        'node',
        'test',
        'agents',
        'spawn',
        '--executor',
        'gx',
        '--plan',
        'gx-bridge-plan',
        '--subtask',
        '0',
        '--agent',
        'codex',
        '--repo-root',
        repoRoot,
        '--dry-run',
      ],
      { from: 'node' },
    );

    expect(output).toContain('gitguardex spawn dry-run gx-bridge-plan/sub-0');
    expect(output).toContain('gx agents start');
    expect(output).toContain('Colony plan gx-bridge-plan/sub-0: Implement API bridge');
    expect(output).toContain('--claim apps/api/bridge.ts');
    expect(output).toContain('--dry-run');
    expect(readGxLog()).not.toContain('["agents","start"');
  });

  it('refuses spawn when gx is unavailable', async () => {
    await seedPlan(singleFilePlan);
    process.env.GX_FAKE_FAIL_VERSION = '1';

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
          'gx-bridge-plan',
          '--subtask',
          '0',
          '--repo-root',
          repoRoot,
        ],
        { from: 'node' },
      ),
    ).rejects.toThrow(/GitGuardex unavailable/);
  });

  it('maps ready subtask file scope to repeated gx --claim flags', async () => {
    await seedPlan(multiFilePlan);

    await createProgram().parseAsync(
      [
        'node',
        'test',
        'agents',
        'spawn',
        '--executor',
        'gx',
        '--plan',
        'gx-multifile-plan',
        '--subtask',
        '0',
        '--repo-root',
        repoRoot,
        '--dry-run',
      ],
      { from: 'node' },
    );

    expect(output).toContain('--claim apps/cli/src/commands/agents.ts');
    expect(output).toContain('--claim apps/cli/src/lib/gitguardex.ts');
  });

  it('calls gx cockpit with repo target and colony session name', async () => {
    await createProgram().parseAsync(['node', 'test', 'cockpit', '--repo-root', repoRoot], {
      from: 'node',
    });

    expect(output).toContain('gitguardex cockpit');
    const calls = readGxCalls();
    expect(calls).toContainEqual([
      'cockpit',
      '--target',
      repoRoot,
      '--session',
      expect.stringMatching(/^colony-colony-cli-gx-repo-[a-z0-9]+$/),
    ]);
    expect(calls.some((call) => call[0] === 'agents' && call[1] === 'start')).toBe(false);
  });

  it('refuses duplicate spawn for an already claimed Colony subtask', async () => {
    await seedPlan(singleFilePlan);
    await markSubtaskClaimed('gx-bridge-plan', 0);

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
          'gx-bridge-plan',
          '--subtask',
          '0',
          '--repo-root',
          repoRoot,
          '--dry-run',
        ],
        { from: 'node' },
      ),
    ).rejects.toThrow(/is claimed/);
  });

  it('records Colony claims after successful gx spawn', async () => {
    await seedPlan(singleFilePlan);
    await withTestStore((store) => {
      const result = spawnGitGuardexAgent({
        store,
        repoRoot,
        agent: 'codex',
        base: 'main',
        dryRun: false,
        planSlug: 'gx-bridge-plan',
        subtaskIndex: 0,
        execFileSync: fakeExecFileSync,
      });
      expect(result.colony_session_id).toBe('gx:fake-session');
      expect(result.colony_claimed).toBe(true);

      const [plan] = listPlans(store, { repo_root: repoRoot });
      const subtask = plan?.subtasks[0];
      expect(subtask?.status).toBe('claimed');
      expect(subtask?.claimed_by_session_id).toBe('gx:fake-session');
      const claims = store.storage.listClaims(subtask?.task_id ?? -1);
      expect(claims.map((claim) => claim.file_path)).toContain('apps/api/bridge.ts');
    });
  });

  it('shows GitGuardex lanes in colony status', async () => {
    process.env.GX_FAKE_AGENTS_STATUS = JSON.stringify({
      schemaVersion: 1,
      repoRoot,
      sessions: [
        {
          id: 'session-1',
          agent: 'codex',
          task: 'Colony plan gx-bridge-plan/sub-0: Implement API bridge',
          branch: 'agent/codex/gx-bridge',
          base: 'main',
          status: 'active',
          worktreePath: join(repoRoot, '.omx/agent-worktrees/gx-bridge'),
          worktreeExists: true,
          lockCount: 1,
          locks: ['apps/api/bridge.ts'],
        },
      ],
    });

    await createProgram().parseAsync(['node', 'test', 'status', '--repo-root', repoRoot], {
      from: 'node',
    });

    expect(output).toContain('GitGuardex lanes');
    expect(output).toContain('agent/codex/gx-bridge');
    expect(output).toContain('claimed: apps/api/bridge.ts');
  });
});

const fakeExecFileSync: GitGuardexExecFileSync = (file, args) => {
  expect(file).toBe('gx');
  if (args[0] === '--version') return '7.0.test\n';
  if (args[0] === 'status' && args[1] === '--json') {
    return JSON.stringify({ repo: { target: repoRoot, guardexEnabled: true } });
  }
  if (args[0] === 'agents' && args[1] === 'status') {
    return JSON.stringify({ schemaVersion: 1, repoRoot, sessions: [] });
  }
  if (args[0] === 'agents' && args[1] === 'start') {
    return [
      '[agent-branch-start] Created branch: agent/codex/fake-branch',
      '[agent-branch-start] Worktree: /tmp/fake-worktree',
      '[gitguardex] Agent session id: fake-session',
      '',
    ].join('\n');
  }
  throw new Error(`unexpected gx args ${JSON.stringify(args)}`);
};

const singleFilePlan: QueenOrderedPlanInput = {
  slug: 'gx-bridge-plan',
  title: 'GX bridge plan',
  problem: 'Colony needs GitGuardex launch lanes.',
  acceptance_criteria: ['dry-run prints gx command'],
  waves: [
    {
      title: 'Wave 1',
      subtasks: [
        {
          title: 'Implement API bridge',
          description: 'Wire Colony spawn to GitGuardex.',
          file_scope: ['apps/api/bridge.ts'],
          capability_hint: 'api_work',
        },
      ],
    },
    {
      title: 'Wave 2',
      subtasks: [
        {
          title: 'Verify API bridge',
          description: 'Check the GitGuardex bridge behavior.',
          file_scope: ['apps/api/bridge.test.ts'],
          capability_hint: 'test_work',
        },
      ],
    },
  ],
};

const multiFilePlan: QueenOrderedPlanInput = {
  slug: 'gx-multifile-plan',
  title: 'GX multifile plan',
  problem: 'Colony needs repeated gx claim flags.',
  acceptance_criteria: ['all files are claimed'],
  waves: [
    {
      title: 'Wave 1',
      subtasks: [
        {
          title: 'Implement CLI bridge',
          description: 'Touch command and executor files.',
          file_scope: ['apps/cli/src/commands/agents.ts', 'apps/cli/src/lib/gitguardex.ts'],
          capability_hint: 'api_work',
        },
      ],
    },
    {
      title: 'Wave 2',
      subtasks: [
        {
          title: 'Verify CLI bridge',
          description: 'Check repeated claim mapping.',
          file_scope: ['apps/cli/test/gitguardex.test.ts'],
          capability_hint: 'test_work',
        },
      ],
    },
  ],
};

async function seedPlan(plan: QueenOrderedPlanInput): Promise<void> {
  await withTestStore((store) => {
    store.startSession({ id: 'queen-session', ide: 'queen', cwd: repoRoot });
    publishOrderedPlan({
      store,
      plan,
      repo_root: repoRoot,
      session_id: 'queen-session',
      agent: 'queen',
      auto_archive: false,
    });
  });
}

async function markSubtaskClaimed(planSlug: string, subtaskIndex: number): Promise<void> {
  await withTestStore((store) => {
    const plan = listPlans(store, { repo_root: repoRoot }).find(
      (candidate) => candidate.plan_slug === planSlug,
    );
    const subtask = plan?.subtasks.find((candidate) => candidate.subtask_index === subtaskIndex);
    if (!subtask) throw new Error(`missing subtask ${planSlug}/sub-${subtaskIndex}`);
    store.addObservation({
      session_id: 'codex@claimed',
      task_id: subtask.task_id,
      kind: 'plan-subtask-claim',
      content: 'already claimed',
      metadata: {
        status: 'claimed',
        session_id: 'codex@claimed',
        agent: 'codex',
        plan_slug: planSlug,
        subtask_index: subtaskIndex,
      },
    });
  });
}

async function withTestStore<T>(run: (store: MemoryStore) => T | Promise<T>): Promise<T> {
  const store = new MemoryStore({
    dbPath: join(dataDir, 'data.db'),
    settings: defaultSettings,
  });
  try {
    return await run(store);
  } finally {
    store.close();
  }
}

function writeFakeGx(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(
    path,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.GX_FAKE_LOG) fs.appendFileSync(process.env.GX_FAKE_LOG, JSON.stringify(args) + '\\n');
if (args[0] === '--version') {
  if (process.env.GX_FAKE_FAIL_VERSION === '1') {
    process.stderr.write('gx missing\\n');
    process.exit(127);
  }
  process.stdout.write('7.0.test\\n');
  process.exit(0);
}
if (args[0] === 'status' && args[1] === '--json') {
  process.stdout.write(JSON.stringify({ repo: { target: process.cwd(), guardexEnabled: true } }));
  process.exit(0);
}
if (args[0] === 'agents' && args[1] === 'status') {
  process.stdout.write(process.env.GX_FAKE_AGENTS_STATUS || '{"schemaVersion":1,"sessions":[]}');
  process.exit(0);
}
if (args[0] === 'agents' && args[1] === 'start') {
  process.stdout.write('[agent-branch-start] Created branch: agent/codex/fake-branch\\n');
  process.stdout.write('[agent-branch-start] Worktree: /tmp/fake-worktree\\n');
  process.stdout.write('[gitguardex] Agent session id: fake-session\\n');
  process.exit(0);
}
if (args[0] === 'cockpit') {
  process.stdout.write('cockpit ok\\n');
  process.exit(0);
}
process.stderr.write('unexpected gx args ' + JSON.stringify(args) + '\\n');
process.exit(2);
`,
    'utf8',
  );
  chmodSync(path, 0o755);
}

function readGxLog(): string {
  try {
    return readFileSync(logPath, 'utf8');
  } catch {
    return '';
  }
}

function readGxCalls(): string[][] {
  return readGxLog()
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}
