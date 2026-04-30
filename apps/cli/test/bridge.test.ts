import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

const payload = {
  schema: 'colony.omx_hud_status.v1',
  generated_at: '2026-04-29T00:00:00.000Z',
  runtime_source: 'omx',
  hivemind: {
    lane_count: 1,
    total_lane_count: 1,
    lanes_truncated: false,
    needs_attention_count: 0,
    counts: { working: 1, thinking: 0, idle: 0, stalled: 0, dead: 0, unknown: 0 },
    lane_preview: [
      {
        branch: 'agent/codex/bridge-cli',
        task: 'Ship bridge CLI status',
        owner: 'codex/codex',
        activity: 'working',
        needs_attention: false,
        risk: 'none',
        source: 'active-session',
        locked_file_count: 1,
        locked_file_preview: ['apps/cli/src/commands/bridge.ts'],
      },
    ],
  },
  branch: 'agent/codex/bridge-cli',
  task: 'Bridge CLI implementation',
  blocker: null,
  next_action: 'Continue agent/codex/bridge-cli.',
  next: 'Continue agent/codex/bridge-cli.',
  evidence: {
    task_id: 17,
    latest_working_note_id: 43,
    attention_observation_ids: [],
    attention_observation_ids_truncated: false,
    hydrate_with: 'get_observations',
  },
  attention: {
    unread_count: 0,
    blocking_count: 0,
    blocking: false,
    pending_handoff_count: 0,
    pending_wake_count: 0,
    stalled_lane_count: 0,
  },
  attention_counts: {
    lane_needs_attention_count: 0,
    pending_handoff_count: 0,
    pending_wake_count: 0,
    unread_message_count: 0,
    stalled_lane_count: 0,
    recent_other_claim_count: 0,
    blocked: false,
  },
  ready_work_count: 0,
  ready_work_preview: [],
  claimed_file_count: 1,
  claimed_file_preview: [
    {
      task_id: 17,
      file_path: 'apps/cli/src/commands/bridge.ts',
      by_session_id: 'agent-session',
      claimed_at: 1710000000000,
      yours: true,
    },
  ],
  claimed_files: [
    {
      task_id: 17,
      file_path: 'apps/cli/src/commands/bridge.ts',
      by_session_id: 'agent-session',
      claimed_at: 1710000000000,
      yours: true,
    },
  ],
  latest_working_note: {
    id: 43,
    task_id: 17,
    session_id: 'agent-session',
    ts: 1710000001000,
    content:
      'branch=agent/codex/bridge-cli; task=bridge status cli; blocker=none; next=run tests; evidence=colony bridge status --json',
  },
};

const mocks = vi.hoisted(() => ({
  loadSettings: vi.fn(() => ({ fileHeatHalfLifeMinutes: 120 })),
  withStore: vi.fn(async (_settings: unknown, run: (store: unknown) => unknown) =>
    run({ kind: 'store' }),
  ),
  buildBridgeStatusPayload: vi.fn(),
  readStdin: vi.fn(),
  runOmxLifecycleEnvelope: vi.fn(),
}));

vi.mock('@colony/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@colony/config')>();
  return {
    ...actual,
    loadSettings: mocks.loadSettings,
  };
});

vi.mock('../src/util/store.js', () => ({
  withStore: mocks.withStore,
}));

import { registerBridgeCommand } from '../src/commands/bridge.js';

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('bridge status --json', () => {
  it('prints the compact HUD payload and forwards CLI identity options', async () => {
    mocks.buildBridgeStatusPayload.mockResolvedValue(payload);
    const output: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      output.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    const program = new Command();
    registerBridgeCommand(program, {
      buildBridgeStatusPayload: mocks.buildBridgeStatusPayload,
    });

    await program.parseAsync(
      [
        'node',
        'test',
        'bridge',
        'status',
        '--json',
        '--repo-root',
        '/repo',
        '--session-id',
        'agent-session',
        '--agent',
        'codex',
        '--branch',
        'agent/codex/bridge-cli',
      ],
      { from: 'node' },
    );

    expect(mocks.buildBridgeStatusPayload).toHaveBeenCalledWith(
      { kind: 'store' },
      {
        session_id: 'agent-session',
        agent: 'codex',
        repo_root: '/repo',
        branch: 'agent/codex/bridge-cli',
      },
    );
    expect(output.join('')).toBe(`${JSON.stringify(payload)}\n`);
    expect(JSON.parse(output.join(''))).toEqual(payload);
  });

  it('infers bridge status agent with the shared core session-id classifier', async () => {
    mocks.buildBridgeStatusPayload.mockResolvedValue(payload);
    const output: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      output.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    const program = new Command();
    registerBridgeCommand(program, {
      buildBridgeStatusPayload: mocks.buildBridgeStatusPayload,
    });

    await program.parseAsync(
      [
        'node',
        'test',
        'bridge',
        'status',
        '--json',
        '--repo-root',
        '/repo',
        '--session-id',
        'agent/claude/fix-unknown-ide-owner-infer-2026-04-24-21-21',
      ],
      { from: 'node' },
    );

    expect(mocks.buildBridgeStatusPayload).toHaveBeenCalledWith(
      { kind: 'store' },
      {
        session_id: 'agent/claude/fix-unknown-ide-owner-infer-2026-04-24-21-21',
        agent: 'claude',
        repo_root: '/repo',
      },
    );
    expect(JSON.parse(output.join(''))).toEqual(payload);
  });
});

describe('bridge lifecycle --json', () => {
  it('forwards stdin JSON to the lifecycle receiver', async () => {
    mocks.readStdin.mockResolvedValue(
      JSON.stringify({
        event_id: 'evt_cli',
        event_name: 'task_bind',
        session_id: 'codex@cli',
        agent: 'codex',
        cwd: '/repo',
        repo_root: '/repo',
        branch: 'main',
        timestamp: '2026-04-29T10:01:00.000Z',
        source: 'omx',
      }),
    );
    mocks.runOmxLifecycleEnvelope.mockResolvedValue({
      ok: true,
      ms: 3,
      event_id: 'evt_cli',
      event_type: 'task_bind',
      route: 'task_bind',
    });
    const output: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      output.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    const program = new Command();
    registerBridgeCommand(program, {
      readStdin: mocks.readStdin,
      runOmxLifecycleEnvelope: mocks.runOmxLifecycleEnvelope,
    });

    await program.parseAsync(
      ['node', 'test', 'bridge', 'lifecycle', '--json', '--ide', 'codex', '--cwd', '/repo'],
      { from: 'node' },
    );

    expect(mocks.runOmxLifecycleEnvelope).toHaveBeenCalledWith(
      {
        event_id: 'evt_cli',
        event_name: 'task_bind',
        session_id: 'codex@cli',
        agent: 'codex',
        cwd: '/repo',
        repo_root: '/repo',
        branch: 'main',
        timestamp: '2026-04-29T10:01:00.000Z',
        source: 'omx',
      },
      { defaultCwd: '/repo', ide: 'codex' },
    );
    expect(JSON.parse(output.join(''))).toEqual({
      ok: true,
      ms: 3,
      event_id: 'evt_cli',
      event_type: 'task_bind',
      route: 'task_bind',
    });
  });
});

describe('bridge runtime-summary --json', () => {
  it('ingests compact OMX runtime summaries from stdin', async () => {
    mocks.readStdin.mockResolvedValue(
      JSON.stringify({
        session_id: 'codex@runtime',
        quota_warning: 'Usage limit near',
        last_failed_tool: { name: 'Bash', error: 'spawn EPERM' },
      }),
    );
    const ingest = vi.fn(() => ({
      ok: true,
      observation_id: 101,
      task_id: 17,
      warnings: ['quota_warning' as const, 'last_failed_tool' as const],
    }));
    const output: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      output.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    const program = new Command();
    registerBridgeCommand(program, {
      readStdin: mocks.readStdin,
      ingestOmxRuntimeSummary: ingest,
    });

    await program.parseAsync(
      [
        'node',
        'test',
        'bridge',
        'runtime-summary',
        '--json',
        '--repo-root',
        '/repo',
        '--branch',
        'agent/codex/runtime',
      ],
      { from: 'node' },
    );

    expect(ingest).toHaveBeenCalledWith(
      { kind: 'store' },
      {
        session_id: 'codex@runtime',
        quota_warning: 'Usage limit near',
        last_failed_tool: { name: 'Bash', error: 'spawn EPERM' },
      },
      { repoRoot: '/repo', branch: 'agent/codex/runtime' },
    );
    expect(JSON.parse(output.join(''))).toMatchObject({
      ok: true,
      observation_id: 101,
      warnings: ['quota_warning', 'last_failed_tool'],
    });
  });
});
