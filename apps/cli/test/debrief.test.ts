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

import { registerDebriefCommand, sectionCoordinationRatio } from '../src/commands/debrief.js';

interface TestCoordinationActivity {
  commits: number;
  reads: number;
  commits_by_session: Map<string, number>;
  reads_by_session: Map<string, number>;
}

beforeEach(() => {
  mocks.loadSettings.mockClear();
  mocks.withStorage.mockReset();
  kleur.enabled = true;
});

afterEach(() => {
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

    expect(output).toContain('Commits:     10 (task_hand_off, task_claim_file, task_message, ...)');
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
});

function renderSection(coordinationActivity: TestCoordinationActivity): string {
  return sectionCoordinationRatio({
    storage: fakeStorage(coordinationActivity),
    since: 1_000,
  }).join('\n');
}

function fakeStorage(coordinationActivity: TestCoordinationActivity): never {
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
    editVsClaimStats: vi.fn(() => ({ edit_count: 0, claim_count: 0 })),
    handoffStatusDistribution: vi.fn(() => ({
      accepted: 0,
      cancelled: 0,
      expired: 0,
      pending: 0,
    })),
    handoffAcceptLatencies: vi.fn(() => []),
    toolUsageBySession: vi.fn(() => []),
    toolInvocationDistribution: vi.fn(() => []),
    mixedTimeline: vi.fn(() => []),
  } as never;
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
