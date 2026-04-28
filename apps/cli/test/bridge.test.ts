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
}));

vi.mock('@colony/config', () => ({
  loadSettings: mocks.loadSettings,
}));

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
});
