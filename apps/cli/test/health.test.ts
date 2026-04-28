import kleur from 'kleur';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildColonyHealthPayload, formatColonyHealthOutput } from '../src/commands/health.js';

const NOW = 1_800_000_000_000;
const SINCE = NOW - 24 * 3_600_000;

interface TestToolCall {
  id: number;
  session_id: string;
  tool: string;
  ts: number;
}

interface TestTask {
  id: number;
  repo_root: string;
  branch: string;
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

interface TestProposal {
  id: number;
  repo_root: string;
  branch: string;
  summary: string;
  rationale: string;
  touches_files: string;
  status: 'pending' | 'active' | 'evaporated';
  proposed_by: string;
  proposed_at: number;
  promoted_at: number | null;
  task_id: number | null;
}

interface TestReinforcement {
  id: number;
  proposal_id: number;
  session_id: string;
  kind: 'explicit' | 'rediscovered' | 'adjacent';
  weight: number;
  reinforced_at: number;
}

beforeEach(() => {
  kleur.enabled = false;
});

afterEach(() => {
  kleur.enabled = true;
});

describe('colony health payload', () => {
  it('reports adoption ratios and renders a stable human-readable shape', () => {
    const payload = buildColonyHealthPayload(
      fakeStorage({
        calls: healthyWindowCalls(),
        claimBeforeEdit: {
          edit_tool_calls: 2,
          edits_with_file_path: 2,
          edits_claimed_before: 1,
        },
      }),
      {
        since: SINCE,
        window_hours: 24,
        now: NOW,
      },
    );

    expect(payload.colony_mcp_share).toMatchObject({
      total_tool_calls: 17,
      mcp_tool_calls: 15,
      colony_mcp_tool_calls: 13,
      share_of_all_tool_calls: 13 / 17,
      share_of_mcp_tool_calls: 13 / 15,
    });
    expect(payload.conversions.hivemind_context_to_attention_inbox).toMatchObject({
      from_sessions: 2,
      converted_sessions: 1,
      conversion_rate: 1 / 2,
    });
    expect(payload.conversions.task_list_to_task_ready_for_agent).toMatchObject({
      from_sessions: 2,
      converted_sessions: 1,
    });
    expect(payload.conversions.attention_inbox_to_task_ready_for_agent).toMatchObject({
      from_sessions: 1,
      converted_sessions: 1,
    });
    expect(payload.conversions.task_ready_for_agent_to_task_plan_claim_subtask).toMatchObject({
      from_sessions: 1,
      converted_sessions: 1,
    });
    expect(payload.task_list_vs_task_ready_for_agent).toMatchObject({
      task_list_calls: 2,
      task_ready_for_agent_calls: 1,
      task_ready_share: 1 / 3,
    });
    expect(payload.task_post_vs_task_message).toMatchObject({
      task_post_calls: 1,
      task_message_calls: 1,
      task_message_share: 1 / 2,
    });
    expect(payload.task_post_vs_omx_notepad).toMatchObject({
      status: 'available',
      task_post_calls: 1,
      omx_notepad_write_calls: 1,
      task_post_share: 1 / 2,
    });
    expect(payload.search_calls_per_session).toMatchObject({
      total_search_calls: 3,
      active_sessions: 3,
      average_per_active_session: 1,
      sessions: [
        { session_id: 'claude-beta-session', calls: 2 },
        { session_id: 'codex-alpha-session', calls: 1 },
      ],
    });
    expect(payload.task_claim_file_before_edits).toMatchObject({
      status: 'available',
      edit_tool_calls: 2,
      edits_with_file_path: 2,
      edits_claimed_before: 1,
      edits_without_claim_before: 1,
      claim_before_edit_ratio: 1 / 2,
    });
    expect(payload.signal_health).toMatchObject({
      active_claims: 2,
      stale_claims: 1,
      expired_handoffs: 1,
      expired_messages: 1,
    });
    expect(payload.proposal_health).toMatchObject({
      proposals_seen: 3,
      pending: 1,
      promoted: 1,
      evaporated: 1,
      pending_below_noise_floor: 1,
      promotion_rate: 1 / 3,
    });
    expect(payload.ready_to_claim_vs_claimed).toMatchObject({
      plan_subtasks: 3,
      ready_to_claim: 1,
      claimed: 1,
      ready_to_claim_per_claimed: 1,
      claimed_share_of_actionable: 1 / 2,
    });

    const text = formatColonyHealthOutput(payload);
    expect(text).toContain('colony health');
    expect(text).toContain('Colony MCP share');
    expect(text).toContain('hivemind_context -> attention_inbox: 1 / 2 (50%) sessions');
    expect(text).toContain('attention_inbox -> task_ready_for_agent: 1 / 1 (100%) sessions');
    expect(text).toContain('task_list vs task_ready_for_agent');
    expect(text).toContain('task_post vs task_message');
    expect(text).toContain('task_post vs OMX notepad');
    expect(text).toContain('Search calls per session');
    expect(text).toContain('1 / 2 edits had explicit claims first (50%)');
    expect(text).toContain('Signal health');
    expect(text).toContain('Proposal decay/promotions');
    expect(text).toContain('Ready-to-claim vs claimed');
  });

  it('emits parseable JSON with the same top-level sections', () => {
    const payload = buildColonyHealthPayload(
      fakeStorage({
        calls: healthyWindowCalls(),
        claimBeforeEdit: {
          edit_tool_calls: 2,
          edits_with_file_path: 2,
          edits_claimed_before: 1,
        },
      }),
      {
        since: SINCE,
        window_hours: 24,
        now: NOW,
      },
    );

    const json = JSON.parse(formatColonyHealthOutput(payload, { json: true }));

    expect(json).toHaveProperty('colony_mcp_share');
    expect(json).toHaveProperty('conversions');
    expect(json).toHaveProperty('task_list_vs_task_ready_for_agent');
    expect(json).toHaveProperty('task_post_vs_task_message');
    expect(json).toHaveProperty('task_post_vs_omx_notepad');
    expect(json).toHaveProperty('search_calls_per_session');
    expect(json).toHaveProperty('task_claim_file_before_edits');
    expect(json).toHaveProperty('signal_health');
    expect(json).toHaveProperty('proposal_health');
    expect(json).toHaveProperty('ready_to_claim_vs_claimed');
  });

  it('reports claim-before-edit correlation as unavailable when edit metadata is incomplete', () => {
    const payload = buildColonyHealthPayload(
      fakeStorage({
        calls: [call(1, 'codex-alpha-session', 'Edit', NOW - 1_000)],
        claimBeforeEdit: {
          edit_tool_calls: 1,
          edits_with_file_path: 0,
          edits_claimed_before: 0,
        },
      }),
      {
        since: SINCE,
        window_hours: 24,
        now: NOW,
      },
    );

    expect(payload.task_claim_file_before_edits).toMatchObject({
      status: 'not_available',
      edit_tool_calls: 1,
      edits_with_file_path: 0,
      claim_before_edit_ratio: null,
    });
    expect(formatColonyHealthOutput(payload)).toContain('not available');
    expect(payload.task_post_vs_omx_notepad.status).toBe('unavailable');
  });
});

function fakeStorage(args: {
  calls: TestToolCall[];
  claimBeforeEdit: {
    edit_tool_calls: number;
    edits_with_file_path: number;
    edits_claimed_before: number;
  };
  tasks?: TestTask[];
  observationsByTask?: Record<number, TestObservation[]>;
  claimsByTask?: Record<
    number,
    Array<{ task_id: number; file_path: string; session_id: string; claimed_at: number }>
  >;
  proposals?: TestProposal[];
  reinforcements?: Record<number, TestReinforcement[]>;
}): never {
  const tasks = args.tasks ?? healthyTasks();
  const observationsByTask = args.observationsByTask ?? healthyObservationsByTask();
  const claimsByTask = args.claimsByTask ?? healthyClaimsByTask();
  const proposals = args.proposals ?? healthyProposals();
  const reinforcements = args.reinforcements ?? healthyReinforcements();
  return {
    toolCallsSince: () => args.calls,
    claimBeforeEditStats: () => args.claimBeforeEdit,
    listTasks: () => tasks,
    listClaims: (taskId: number) => claimsByTask[taskId] ?? [],
    taskTimeline: (taskId: number) => observationsByTask[taskId] ?? [],
    taskObservationsByKind: (taskId: number, kind: string) =>
      (observationsByTask[taskId] ?? []).filter((row) => row.kind === kind),
    listProposalsForBranch: (repoRoot: string, branch: string) =>
      proposals.filter((proposal) => proposal.repo_root === repoRoot && proposal.branch === branch),
    listReinforcements: (proposalId: number) => reinforcements[proposalId] ?? [],
  } as never;
}

function healthyWindowCalls(): TestToolCall[] {
  return [
    call(1, 'codex-alpha-session', 'mcp__colony__hivemind_context', NOW - 90_000),
    call(2, 'codex-alpha-session', 'mcp__colony__attention_inbox', NOW - 89_000),
    call(3, 'codex-alpha-session', 'mcp__colony__task_list', NOW - 88_000),
    call(4, 'codex-alpha-session', 'mcp__colony__task_ready_for_agent', NOW - 87_000),
    call(5, 'codex-alpha-session', 'mcp__colony__task_plan_claim_subtask', NOW - 86_000),
    call(6, 'codex-alpha-session', 'mcp__colony__task_claim_file', NOW - 85_500),
    call(7, 'codex-alpha-session', 'mcp__colony__task_message', NOW - 84_000),
    call(8, 'codex-alpha-session', 'mcp__colony__search', NOW - 83_000),
    call(9, 'codex-alpha-session', 'Edit', NOW - 82_000),
    call(10, 'claude-beta-session', 'mcp__colony__hivemind_context', NOW - 80_000),
    call(11, 'claude-beta-session', 'mcp__colony__task_list', NOW - 79_000),
    call(12, 'claude-beta-session', 'mcp__colony__task_post', NOW - 78_000),
    call(13, 'claude-beta-session', 'mcp__colony__search', NOW - 77_000),
    call(14, 'claude-beta-session', 'mcp__colony__search', NOW - 76_000),
    call(15, 'claude-beta-session', 'Edit', NOW - 75_000),
    call(16, 'other-mcp-session', 'mcp__github__pr_view', NOW - 74_000),
    call(17, 'other-mcp-session', 'mcp__omx_memory__notepad_write_working', NOW - 73_000),
  ];
}

function call(id: number, sessionId: string, tool: string, ts: number): TestToolCall {
  return { id, session_id: sessionId, tool, ts };
}

function healthyTasks(): TestTask[] {
  return [
    { id: 1, repo_root: '/r', branch: 'b' },
    { id: 2, repo_root: '/r', branch: 'spec/plan/sub-0' },
    { id: 3, repo_root: '/r', branch: 'spec/plan/sub-1' },
    { id: 4, repo_root: '/r', branch: 'spec/plan/sub-2' },
  ];
}

function healthyClaimsByTask(): Record<
  number,
  Array<{ task_id: number; file_path: string; session_id: string; claimed_at: number }>
> {
  return {
    1: [{ task_id: 1, file_path: 'src/old.ts', session_id: 'A', claimed_at: NOW - 5 * 3_600_000 }],
    2: [{ task_id: 2, file_path: 'src/new.ts', session_id: 'B', claimed_at: NOW - 60_000 }],
  };
}

function healthyObservationsByTask(): Record<number, TestObservation[]> {
  return {
    1: [
      observation(1, 'handoff', NOW - 3 * 3_600_000, {
        kind: 'handoff',
        status: 'pending',
      }),
      observation(2, 'message', NOW - 4_000, {
        kind: 'message',
        status: 'expired',
        expires_at: NOW - 2_000,
      }),
    ],
    2: [
      observation(3, 'plan-subtask', NOW - 3_000, {
        status: 'available',
        depends_on: [],
      }),
    ],
    3: [
      observation(4, 'plan-subtask', NOW - 3_000, {
        status: 'available',
        depends_on: [0],
      }),
    ],
    4: [
      observation(5, 'plan-subtask-claim', NOW - 2_000, {
        status: 'claimed',
        session_id: 'claimer',
      }),
      observation(6, 'plan-subtask', NOW - 3_000, {
        status: 'available',
        depends_on: [],
      }),
    ],
  };
}

function healthyProposals(): TestProposal[] {
  return [
    proposal(1, 'pending', NOW - 10 * 3_600_000, null),
    proposal(2, 'active', NOW - 2 * 3_600_000, NOW - 60_000),
    proposal(3, 'evaporated', NOW - 2 * 3_600_000, null),
  ];
}

function healthyReinforcements(): Record<number, TestReinforcement[]> {
  return {
    1: [reinforcement(1, 1, 'A', 1, NOW - 10 * 3_600_000)],
    2: [reinforcement(2, 2, 'A', 1, NOW - 2 * 3_600_000)],
  };
}

function observation(
  id: number,
  kind: string,
  ts: number,
  metadata: Record<string, unknown>,
): TestObservation {
  return {
    id,
    session_id: 'session',
    kind,
    content: '',
    compressed: 0,
    intensity: null,
    ts,
    metadata: JSON.stringify(metadata),
    task_id: 1,
    reply_to: null,
  };
}

function proposal(
  id: number,
  status: TestProposal['status'],
  proposedAt: number,
  promotedAt: number | null,
): TestProposal {
  return {
    id,
    repo_root: '/r',
    branch: 'b',
    summary: `proposal ${id}`,
    rationale: '',
    touches_files: '[]',
    status,
    proposed_by: 'A',
    proposed_at: proposedAt,
    promoted_at: promotedAt,
    task_id: status === 'active' ? 99 : null,
  };
}

function reinforcement(
  id: number,
  proposalId: number,
  sessionId: string,
  weight: number,
  reinforcedAt: number,
): TestReinforcement {
  return {
    id,
    proposal_id: proposalId,
    session_id: sessionId,
    kind: 'explicit',
    weight,
    reinforced_at: reinforcedAt,
  };
}
