import { Command } from 'commander';
import kleur from 'kleur';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadSettings: vi.fn(() => ({})),
  withStorage: vi.fn(),
}));

vi.mock('@colony/config', () => ({
  loadSettings: mocks.loadSettings,
}));

vi.mock('../src/util/store.js', () => ({
  withStorage: mocks.withStorage,
}));

import {
  registerDebriefCommand,
  sectionClaimCoverage,
  sectionCoordinationRatio,
} from '../src/commands/debrief.js';

interface TestCoordinationActivity {
  commits: number;
  reads: number;
  commits_by_session: Map<string, number>;
  reads_by_session: Map<string, number>;
}

interface TestClaimCoverage {
  edit_count: number;
  explicit_claim_count: number;
  auto_claim_count: number;
  explicit_claim_kinds: Array<{ kind: string; count: number }>;
  auto_claim_kinds: Array<{ kind: string; count: number }>;
}

interface TestBashCoordinationVolume {
  git_op_count: number;
  file_op_count: number;
  top_files_by_file_op: Array<{ file_path: string; count: number }>;
}

interface TestTask {
  id: number;
  title: string;
  repo_root: string;
  branch: string;
  status: string;
  created_by: string;
  created_at: number;
  updated_at: number;
}

interface TestObservation {
  id: number;
  session_id: string;
  kind: string;
  content: string;
  compressed: 0 | 1;
  intensity: string | null;
  ts: number;
  metadata: string | null;
  task_id: number | null;
  reply_to: number | null;
}

beforeEach(() => {
  mocks.loadSettings.mockClear();
  mocks.withStorage.mockReset();
  kleur.enabled = true;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  kleur.enabled = true;
});

describe('sectionCoordinationRatio', () => {
  it('renders an empty-window message when there is no coordination activity', () => {
    kleur.enabled = false;

    const output = renderSection(activity({ commits: 0, reads: 0 }));

    expect(output).toContain('7. Coordination commit ratio');
    expect(output).toContain('no coordination activity in window.');
  });

  it('renders a green healthy verdict when commits/read ratio is above the healthy threshold', () => {
    const output = renderSection(activity({ commits: 10, reads: 30 }));

    expect(output).toContain(
      'Commits:     10 (task_relay, task_hand_off, task_claim_file, task_message, ...)',
    );
    expect(output).toContain('Reads:       30 (hivemind_context, task_list, attention_inbox, ...)');
    expect(output).toContain('Ratio:       0.33');
    expect(output).toContain(kleur.green('healthy'));
  });

  it('renders a red reading-without-committing verdict when ratio is below mixed threshold', () => {
    const output = renderSection(activity({ commits: 5, reads: 100 }));

    expect(output).toContain('Ratio:       0.05');
    expect(output).toContain(kleur.red('reading without committing'));
    expect(output).toContain('agents reading colony 20x for every commit; primitives invisible');
  });

  it('sorts the per-session table by total activity descending and keeps the top five', () => {
    kleur.enabled = false;

    const output = renderSection(
      activity({
        commits: 25,
        reads: 320,
        sessions: [
          { session_id: 'sess01-alpha', ide: 'codex', commits: 2, reads: 53 },
          { session_id: 'sess02-alpha', ide: 'claude', commits: 10, reads: 20 },
          { session_id: 'sess03-alpha', ide: 'codex', commits: 7, reads: 82 },
          { session_id: 'sess04-alpha', ide: 'claude', commits: 5, reads: 35 },
          { session_id: 'sess05-alpha', ide: 'codex', commits: 1, reads: 100 },
          { session_id: 'sess06-alpha', ide: 'claude', commits: 0, reads: 29 },
        ],
      }),
    );

    const rows = output.split('\n').filter((line) => line.includes('commits='));
    expect(rows).toHaveLength(5);
    expect(rows[0]).toContain('codex@sess05...');
    expect(rows[1]).toContain('codex@sess03...');
    expect(rows[2]).toContain('codex@sess01...');
    expect(rows[3]).toContain('claude@sess04...');
    expect(rows[4]).toContain('claude@sess02...');
    expect(output).not.toContain('claude@sess06...');
  });
});

describe('sectionClaimCoverage', () => {
  it('renders the safety-net verdict when auto-claim carries edits without explicit claims', () => {
    kleur.enabled = false;

    const output = sectionClaimCoverage({
      storage: fakeStorage(activity({ commits: 0, reads: 0 }), {
        claimCoverage: autoClaimOnlyCoverage(),
      }),
      since: 1_000,
    }).join('\n');

    expect(output).toContain('3. Claim coverage (proactive vs auto)');
    expect(output).toContain('Explicit claim kinds:  claim=0');
    expect(output).toContain('Auto-claim kinds:      auto-claim=100');
    expect(output).toContain('Explicit claim/edit:   0%');
    expect(output).toContain('Auto-claim/edit:       100%');
    expect(output).toContain('safety net carrying load — expected');
  });
});

describe('debrief --json', () => {
  it('emits a coordination_ratio key with the structured payload', async () => {
    const storage = fakeStorage(activity({ commits: 10, reads: 30 }));
    mocks.withStorage.mockImplementation(
      async (_settings: unknown, run: (storage: unknown) => unknown) => run(storage),
    );
    const output: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      output.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    const program = new Command();
    registerDebriefCommand(program);

    await program.parseAsync(['node', 'test', 'debrief', '--json'], { from: 'node' });

    const json = JSON.parse(output.join(''));
    expect(json).toHaveProperty('coordination_ratio');
    expect(json.coordination_ratio).toMatchObject({
      commits: 10,
      reads: 30,
      ratio: 10 / 30,
      verdict: 'healthy',
    });
  });

  it('emits claim coverage and bash coordination payloads', async () => {
    const bashCoordinationVolume = {
      git_op_count: 4,
      file_op_count: 7,
      top_files_by_file_op: [
        { file_path: 'apps/cli/src/commands/debrief.ts', count: 5 },
        { file_path: 'packages/storage/src/storage.ts', count: 2 },
      ],
    };
    const storage = fakeStorage(activity({ commits: 0, reads: 0 }), {
      claimCoverage: autoClaimOnlyCoverage(),
      bashCoordinationVolume,
    });
    mocks.withStorage.mockImplementation(
      async (_settings: unknown, run: (storage: unknown) => unknown) => run(storage),
    );
    const output: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      output.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    const program = new Command();
    registerDebriefCommand(program);

    await program.parseAsync(['node', 'test', 'debrief', '--json'], { from: 'node' });

    const json = JSON.parse(output.join(''));
    expect(json.claim_coverage).toMatchObject({
      edit_count: 100,
      explicit_claim_count: 0,
      auto_claim_count: 100,
      explicit_claim_to_edit_ratio: 0,
      auto_claim_to_edit_ratio: 1,
      verdict: 'safety net carrying load — expected',
    });
    expect(json.proactive_claims).toMatchObject({
      edit_count: 100,
      claim_count: 0,
      ratio: 0,
    });
    expect(json.bash_coordination_volume).toEqual(bashCoordinationVolume);
  });

  it('emits queen activity payloads', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-28T12:00:00Z'));
    const seeded = queenActivitySeed(Date.now());
    const storage = fakeStorage(activity({ commits: 0, reads: 0 }), seeded);
    mocks.withStorage.mockImplementation(
      async (_settings: unknown, run: (storage: unknown) => unknown) => run(storage),
    );
    const output: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      output.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    const program = new Command();
    registerDebriefCommand(program);

    await program.parseAsync(['node', 'test', 'debrief', '--json'], { from: 'node' });

    const json = JSON.parse(output.join(''));
    expect(json.queen_activity).toMatchObject({
      plans_published_by_queen: 2,
      plans_published_manual: 1,
      queen_subtasks_completed: 2,
      queen_subtasks_stalled: 1,
      queen_subtasks_total: 3,
      queen_plan_median_age_minutes: 60,
    });
    expect(json.queen_activity.queen_subtask_completion_rate).toBeCloseTo(2 / 3);
  });
});

describe('debrief output', () => {
  it('explains mirror rows in the tool distribution section', async () => {
    kleur.enabled = false;
    const storage = fakeStorage(activity({ commits: 0, reads: 0 }), {
      toolDistribution: [{ tool: 'TaskCreate', count: 1 }],
    });
    mocks.withStorage.mockImplementation(
      async (_settings: unknown, run: (storage: unknown) => unknown) => run(storage),
    );
    const output: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      output.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    const program = new Command();
    registerDebriefCommand(program);

    await program.parseAsync(['node', 'test', 'debrief'], { from: 'node' });

    expect(output.join('')).toContain(
      '*-mirror rows are passive copies of built-in TaskCreate/TaskUpdate calls attached to task threads.',
    );
  });

  it('renders queen activity counts and the queen invocation prompt', async () => {
    kleur.enabled = false;
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-28T12:00:00Z'));
    const storage = fakeStorage(activity({ commits: 0, reads: 0 }), queenActivitySeed(Date.now()));
    mocks.withStorage.mockImplementation(
      async (_settings: unknown, run: (storage: unknown) => unknown) => run(storage),
    );
    const output: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      output.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    const program = new Command();
    registerDebriefCommand(program);

    await program.parseAsync(['node', 'test', 'debrief'], { from: 'node' });

    const text = output.join('');
    expect(text).toContain('10. Queen activity');
    expect(text).toContain('plans_published_by_queen:      2');
    expect(text).toContain('plans_published_manual:        1');
    expect(text).toContain('queen_subtask_completion_rate: 67% (2/3 completed)');
    expect(text).toContain('queen_subtasks_stalled:        1');
    expect(text).toContain('queen_plan_median_age_minutes: 60');
    expect(text).toContain(
      '• If queen activity is low, check whether any agent or human is actually invoking queen_plan_goal — the substrate works only if called.',
    );
  });

  it('prints a single no-activity line and skips queen metrics when there are no queen plans', async () => {
    kleur.enabled = false;
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-28T12:00:00Z'));
    const storage = fakeStorage(activity({ commits: 0, reads: 0 }), manualPlanSeed(Date.now()));
    mocks.withStorage.mockImplementation(
      async (_settings: unknown, run: (storage: unknown) => unknown) => run(storage),
    );
    const output: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      output.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    const program = new Command();
    registerDebriefCommand(program);

    await program.parseAsync(['node', 'test', 'debrief'], { from: 'node' });

    const text = output.join('');
    expect(text.match(/No queen activity in window\./g)).toHaveLength(1);
    expect(text).not.toContain('plans_published_by_queen:');
    expect(text).not.toContain('queen_subtask_completion_rate:');
    expect(text).not.toContain('queen_plan_median_age_minutes:');
  });
});

function renderSection(coordinationActivity: TestCoordinationActivity): string {
  return sectionCoordinationRatio({
    storage: fakeStorage(coordinationActivity),
    since: 1_000,
  }).join('\n');
}

function fakeStorage(
  coordinationActivity: TestCoordinationActivity,
  opts: {
    bashCoordinationVolume?: TestBashCoordinationVolume;
    claimCoverage?: TestClaimCoverage;
    observations?: TestObservation[];
    tasks?: TestTask[];
    toolDistribution?: Array<{ tool: string; count: number }>;
  } = {},
): never {
  const claimCoverage = opts.claimCoverage ?? emptyClaimCoverage();
  const observations = opts.observations ?? [];
  return {
    coordinationActivity: vi.fn(() => coordinationActivity),
    listSessions: vi.fn(() =>
      [
        ...coordinationActivity.commits_by_session.keys(),
        ...coordinationActivity.reads_by_session.keys(),
      ].map((id) => ({
        id,
        ide:
          id.includes('sess02') || id.includes('sess04') || id.includes('sess06')
            ? 'claude'
            : 'codex',
        cwd: '/repo',
        started_at: 1_000,
        ended_at: null,
        metadata: null,
      })),
    ),
    participantJoinFor: vi.fn(() => undefined),
    claimCoverageStats: vi.fn(() => claimCoverage),
    editVsClaimStats: vi.fn(() => ({
      edit_count: claimCoverage.edit_count,
      claim_count: claimCoverage.explicit_claim_count,
    })),
    handoffStatusDistribution: vi.fn(() => ({
      accepted: 0,
      cancelled: 0,
      expired: 0,
      pending: 0,
    })),
    handoffAcceptLatencies: vi.fn(() => []),
    listTasks: vi.fn(() => opts.tasks ?? []),
    toolUsageBySession: vi.fn(() => []),
    toolInvocationDistribution: vi.fn(() => opts.toolDistribution ?? []),
    bashCoordinationVolume: vi.fn(
      () =>
        opts.bashCoordinationVolume ?? {
          git_op_count: 0,
          file_op_count: 0,
          top_files_by_file_op: [],
        },
    ),
    taskObservationsByKind: vi.fn((taskId: number, kind: string, limit = 100) =>
      observations
        .filter((row) => row.task_id === taskId && row.kind === kind)
        .sort((a, b) => b.ts - a.ts)
        .slice(0, limit),
    ),
    taskTimeline: vi.fn((taskId: number, limit = 50) =>
      observations
        .filter((row) => row.task_id === taskId)
        .sort((a, b) => b.ts - a.ts)
        .slice(0, limit),
    ),
    mixedTimeline: vi.fn(() => []),
  } as never;
}

function queenActivitySeed(now: number): { tasks: TestTask[]; observations: TestObservation[] } {
  return {
    tasks: [
      testTask(1, 'spec/queen-one', now - 90 * 60_000, 'agent-3'),
      testTask(2, 'spec/queen-one/sub-0', now - 89 * 60_000, 'agent-3'),
      testTask(3, 'spec/queen-one/sub-1', now - 88 * 60_000, 'agent-3'),
      testTask(4, 'spec/queen-two', now - 30 * 60_000, 'planner'),
      testTask(5, 'spec/queen-two/sub-0', now - 29 * 60_000, 'planner'),
      testTask(6, 'spec/manual-one', now - 10 * 60_000, 'human'),
      testTask(7, 'spec/manual-one/sub-0', now - 9 * 60_000, 'human'),
    ],
    observations: [
      testObservation(1, 1, 'plan-config', { source: 'queen_plan_goal' }, now - 90 * 60_000),
      testObservation(2, 2, 'plan-subtask', { status: 'available' }, now - 89 * 60_000),
      testObservation(3, 2, 'plan-subtask-claim', { status: 'completed' }, now - 80 * 60_000),
      testObservation(4, 3, 'plan-subtask', { status: 'available' }, now - 88 * 60_000),
      testObservation(5, 3, 'plan-subtask-claim', { status: 'blocked' }, now - 70 * 60_000),
      testObservation(6, 4, 'plan-config', { published_by: 'queen' }, now - 30 * 60_000),
      testObservation(7, 5, 'plan-subtask', { status: 'available' }, now - 29 * 60_000),
      testObservation(8, 5, 'plan-subtask-claim', { status: 'completed' }, now - 20 * 60_000),
      testObservation(9, 6, 'plan-config', {}, now - 10 * 60_000),
      testObservation(10, 7, 'plan-subtask', { status: 'available' }, now - 9 * 60_000),
    ],
  };
}

function manualPlanSeed(now: number): { tasks: TestTask[]; observations: TestObservation[] } {
  return {
    tasks: [
      testTask(6, 'spec/manual-one', now - 10 * 60_000, 'human'),
      testTask(7, 'spec/manual-one/sub-0', now - 9 * 60_000, 'human'),
    ],
    observations: [
      testObservation(9, 6, 'plan-config', {}, now - 10 * 60_000),
      testObservation(10, 7, 'plan-subtask', { status: 'available' }, now - 9 * 60_000),
    ],
  };
}

function testTask(id: number, branch: string, createdAt: number, createdBy: string): TestTask {
  return {
    id,
    title: branch,
    repo_root: '/repo',
    branch,
    status: 'open',
    created_by: createdBy,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

function testObservation(
  id: number,
  taskId: number,
  kind: string,
  metadata: Record<string, unknown>,
  ts: number,
): TestObservation {
  return {
    id,
    session_id: 'planner',
    kind,
    content: `${kind} ${id}`,
    compressed: 0,
    intensity: null,
    ts,
    metadata: JSON.stringify(metadata),
    task_id: taskId,
    reply_to: null,
  };
}

function emptyClaimCoverage(): TestClaimCoverage {
  return {
    edit_count: 0,
    explicit_claim_count: 0,
    auto_claim_count: 0,
    explicit_claim_kinds: [{ kind: 'claim', count: 0 }],
    auto_claim_kinds: [{ kind: 'auto-claim', count: 0 }],
  };
}

function autoClaimOnlyCoverage(): TestClaimCoverage {
  return {
    edit_count: 100,
    explicit_claim_count: 0,
    auto_claim_count: 100,
    explicit_claim_kinds: [{ kind: 'claim', count: 0 }],
    auto_claim_kinds: [{ kind: 'auto-claim', count: 100 }],
  };
}

function activity(args: {
  commits: number;
  reads: number;
  sessions?: Array<{
    session_id: string;
    ide: string;
    commits: number;
    reads: number;
  }>;
}): TestCoordinationActivity {
  const commitsBySession = new Map<string, number>();
  const readsBySession = new Map<string, number>();
  for (const session of args.sessions ?? []) {
    commitsBySession.set(session.session_id, session.commits);
    readsBySession.set(session.session_id, session.reads);
  }
  return {
    commits: args.commits,
    reads: args.reads,
    commits_by_session: commitsBySession,
    reads_by_session: readsBySession,
  };
}
