import kleur from 'kleur';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildColonyHealthPayload, formatColonyHealthOutput } from '../src/commands/health.js';

const NOW = 1_800_000_000_000;
const SINCE = NOW - 24 * 3_600_000;
const NO_CODEX_ROOT = '/var/empty/colony-health-next-fixes-test-no-codex';

interface TestToolCall {
  id: number;
  session_id: string;
  tool: string;
  ts: number;
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
  kleur.enabled = false;
});

afterEach(() => {
  kleur.enabled = true;
});

describe('colony health next fixes', () => {
  it('prioritizes execution safety and Queen readiness before adoption follow-ups', () => {
    const payload = buildColonyHealthPayload(
      fakeStorage({
        calls: [
          call(1, 'session-a', 'mcp__colony__hivemind_context', NOW - 90_000),
          call(2, 'session-a', 'mcp__colony__attention_inbox', NOW - 89_000),
          call(3, 'session-a', 'mcp__colony__task_ready_for_agent', NOW - 88_000),
          call(4, 'session-a', 'mcp__colony__task_post', NOW - 87_000),
          call(5, 'session-a', 'Edit', NOW - 86_000),
        ],
        claimBeforeEdit: {
          edit_tool_calls: 1,
          edits_with_file_path: 1,
          edits_claimed_before: 0,
        },
      }),
      {
        since: SINCE,
        window_hours: 24,
        now: NOW,
        codex_sessions_root: NO_CODEX_ROOT,
      },
    );

    expect(payload.readiness_summary).toMatchObject({
      coordination_readiness: { status: 'good' },
      execution_safety: { status: 'bad' },
      queen_plan_readiness: { status: 'bad' },
      working_state_migration: { status: 'ok' },
      signal_evaporation: { status: 'good' },
    });
    expect(payload.action_hints.map((hint) => hint.metric)).toEqual(
      expect.arrayContaining([
        'claim-before-edit',
        'Queen plan activation',
        'task_message adoption',
        'proposal adoption',
      ]),
    );

    const nextFixes = outputSection(formatColonyHealthOutput(payload), 'Next fixes');
    expect(nextFixes).toContain('1. claim-before-edit');
    expect(nextFixes).toContain('2. Queen plan activation');
    expect(nextFixes).not.toContain('task_ready_for_agent -> claim');
    expect(nextFixes).not.toContain('task_message adoption');
    expect(nextFixes).not.toContain('proposal adoption');

    const verboseNextFixes = outputSection(
      formatColonyHealthOutput(payload, { verbose: true }),
      'Next fixes',
    );
    expect(verboseNextFixes).toContain('1. claim-before-edit');
    expect(verboseNextFixes).toContain('2. Queen plan activation');
    expect(verboseNextFixes).toContain('3. task_message adoption');
    expect(verboseNextFixes).toContain('4. task_ready_for_agent -> claim');
    expect(verboseNextFixes).toContain('5. proposal adoption');
  });

  it('uses the same readiness-prioritized set for prompt snippets', () => {
    const payload = buildColonyHealthPayload(
      fakeStorage({
        calls: [
          call(1, 'session-a', 'mcp__colony__hivemind_context', NOW - 90_000),
          call(2, 'session-a', 'mcp__colony__attention_inbox', NOW - 89_000),
          call(3, 'session-a', 'mcp__colony__task_ready_for_agent', NOW - 88_000),
          call(4, 'session-a', 'mcp__colony__task_post', NOW - 87_000),
          call(5, 'session-a', 'Edit', NOW - 86_000),
        ],
        claimBeforeEdit: {
          edit_tool_calls: 1,
          edits_with_file_path: 1,
          edits_claimed_before: 0,
        },
      }),
      {
        since: SINCE,
        window_hours: 24,
        now: NOW,
        codex_sessions_root: NO_CODEX_ROOT,
      },
    );

    const snippets = outputSection(
      formatColonyHealthOutput(payload, { prompts: true }),
      'Codex prompt snippets',
    );
    expect(snippets).toContain('1. Goal: restore pre-edit auto-claim');
    expect(snippets).toContain('2. Goal: activate Queen planning');
    expect(snippets).not.toContain('move agent-to-agent coordination');
    expect(snippets).not.toContain('future-work candidates');
  });

  it('points dominant pre_tool_use_missing at runtime bridge wiring when manual claims are high', () => {
    const payload = buildColonyHealthPayload(
      fakeStorage({
        calls: [
          call(1, 'session-a', 'mcp__colony__hivemind_context', NOW - 90_000),
          call(2, 'session-a', 'mcp__colony__attention_inbox', NOW - 89_000),
          call(3, 'session-a', 'mcp__colony__task_ready_for_agent', NOW - 88_000),
          ...calls(480, 100, 'session-a', 'mcp__colony__task_claim_file'),
        ],
        claimBeforeEdit: {
          edit_tool_calls: 128,
          edits_with_file_path: 128,
          edits_claimed_before: 0,
          pre_tool_use_signals: 1,
          claim_miss_reasons: {
            no_claim_for_file: 0,
            claim_after_edit: 3,
            session_id_mismatch: 0,
            repo_root_mismatch: 0,
            branch_mismatch: 0,
            path_mismatch: 0,
            worktree_path_mismatch: 0,
            pseudo_path_skipped: 0,
            pre_tool_use_missing: 128,
          },
        },
      }),
      {
        since: SINCE,
        window_hours: 24,
        now: NOW,
        codex_sessions_root: NO_CODEX_ROOT,
      },
    );

    const evidence =
      'task_claim_file_calls=480, hook_capable_edits=128, pre_tool_use_signals=1, recent_hook_capable_edits=128, recent_pre_tool_use_missing=128';

    expect(payload.task_claim_file_before_edits.root_cause).toMatchObject({
      kind: 'lifecycle_bridge_missing',
      summary:
        'Lifecycle bridge missing: many task_claim_file calls, many hook-capable edits, near-zero pre_tool_use_signals.',
      evidence,
      action:
        'Install/wire the lifecycle bridge so OMX/Codex/Claude emits pre_tool_use before file mutation.',
      command:
        'colony bridge lifecycle --json --ide <ide> --cwd <repo_root> < colony-omx-lifecycle-v1.pre.json',
    });
    expect(payload.readiness_summary.execution_safety.root_cause).toEqual(
      payload.task_claim_file_before_edits.root_cause,
    );

    const claimHint = payload.action_hints.find((hint) => hint.metric === 'claim-before-edit');
    expect(claimHint).toMatchObject({
      current: `Lifecycle bridge missing: many task_claim_file calls, many hook-capable edits, near-zero pre_tool_use_signals. (${evidence})`,
      target: 'pre_tool_use before file mutation',
      action:
        'Install/wire the lifecycle bridge so OMX/Codex/Claude emits pre_tool_use before file mutation.',
      priority: 5,
      command:
        'colony bridge lifecycle --json --ide <ide> --cwd <repo_root> < colony-omx-lifecycle-v1.pre.json',
      prompt: expect.stringContaining('Goal: wire the runtime lifecycle bridge'),
    });
    expect(claimHint?.tool_call).toBeUndefined();

    const text = formatColonyHealthOutput(payload);
    const readiness = outputSection(text, 'Readiness summary');
    expect(readiness).toContain(
      'root cause: Lifecycle bridge missing: many task_claim_file calls, many hook-capable edits, near-zero pre_tool_use_signals.',
    );
    expect(readiness).toContain(`evidence: ${evidence}`);
    expect(readiness).toContain(
      'action: Install/wire the lifecycle bridge so OMX/Codex/Claude emits pre_tool_use before file mutation.',
    );
    expect(readiness).toContain(
      'cmd:  colony bridge lifecycle --json --ide <ide> --cwd <repo_root> < colony-omx-lifecycle-v1.pre.json',
    );

    const nextFixes = outputSection(text, 'Next fixes');
    expect(nextFixes).toContain(
      `claim-before-edit: Lifecycle bridge missing: many task_claim_file calls, many hook-capable edits, near-zero pre_tool_use_signals. (${evidence}) (target pre_tool_use before file mutation) - Install/wire the lifecycle bridge so OMX/Codex/Claude emits pre_tool_use before file mutation.`,
    );
    expect(nextFixes).toContain(
      'cmd:  colony bridge lifecycle --json --ide <ide> --cwd <repo_root> < colony-omx-lifecycle-v1.pre.json',
    );
    expect(nextFixes).not.toContain('mcp__colony__task_claim_file');
    expect(nextFixes).not.toContain('Call task_claim_file');

    const json = JSON.parse(formatColonyHealthOutput(payload, { json: true }));
    expect(json.readiness_summary.execution_safety.root_cause).toMatchObject({
      kind: 'lifecycle_bridge_missing',
      command:
        'colony bridge lifecycle --json --ide <ide> --cwd <repo_root> < colony-omx-lifecycle-v1.pre.json',
    });
    expect(json.task_claim_file_before_edits.root_cause.evidence).toBe(evidence);
  });

  it('reports lifecycle bridge missing when manual claims are high but no hook-capable edits were recorded', () => {
    const payload = buildColonyHealthPayload(
      fakeStorage({
        calls: [
          call(1, 'session-a', 'mcp__colony__hivemind_context', NOW - 90_000),
          call(2, 'session-a', 'mcp__colony__attention_inbox', NOW - 89_000),
          call(3, 'session-a', 'mcp__colony__task_ready_for_agent', NOW - 88_000),
          ...calls(1043, 100, 'session-a', 'mcp__colony__task_claim_file'),
        ],
        claimBeforeEdit: {
          edit_tool_calls: 0,
          edits_with_file_path: 0,
          edits_claimed_before: 0,
          pre_tool_use_signals: 0,
        },
      }),
      {
        since: SINCE,
        window_hours: 24,
        now: NOW,
        codex_sessions_root: NO_CODEX_ROOT,
      },
    );

    const evidence = 'task_claim_file_calls=1043, hook_capable_edits=0, pre_tool_use_signals=0';
    expect(payload.task_claim_file_before_edits.root_cause).toMatchObject({
      kind: 'lifecycle_bridge_missing',
      summary:
        'Lifecycle bridge missing: task_claim_file calls without any hook-capable edit telemetry.',
      evidence,
      action:
        'Install/wire the lifecycle bridge so OMX/Codex/Claude emits pre_tool_use before file mutation.',
      command:
        'colony bridge lifecycle --json --ide <ide> --cwd <repo_root> < colony-omx-lifecycle-v1.pre.json',
    });

    const hint = payload.action_hints.find((entry) => entry.metric === 'claim-before-edit');
    expect(hint).toMatchObject({
      current:
        'Lifecycle bridge missing: task_claim_file calls without any hook-capable edit telemetry. (task_claim_file_calls=1043, hook_capable_edits=0, pre_tool_use_signals=0)',
      target: 'pre_tool_use before file mutation',
      priority: 5,
    });

    const readiness = outputSection(formatColonyHealthOutput(payload), 'Readiness summary');
    expect(readiness).toContain(
      'root cause: Lifecycle bridge missing: task_claim_file calls without any hook-capable edit telemetry.',
    );
    expect(readiness).toContain(`evidence: ${evidence}`);
  });

  it('does not ask for bridge wiring when pre_tool_use covers write edits', () => {
    const payload = buildColonyHealthPayload(
      fakeStorage({
        calls: [
          call(1, 'session-a', 'mcp__colony__hivemind_context', NOW - 90_000),
          call(2, 'session-a', 'mcp__colony__attention_inbox', NOW - 89_000),
          call(3, 'session-a', 'mcp__colony__task_ready_for_agent', NOW - 88_000),
          call(4, 'session-a', 'mcp__colony__task_claim_file', NOW - 87_000),
          call(5, 'session-a', 'Edit', NOW - 86_000),
          call(6, 'session-a', 'Write', NOW - 85_000),
        ],
        claimBeforeEdit: {
          edit_tool_calls: 2,
          edits_with_file_path: 2,
          edits_claimed_before: 2,
          pre_tool_use_signals: 2,
          claim_miss_reasons: {
            pre_tool_use_missing: 0,
          },
        },
      }),
      {
        since: SINCE,
        window_hours: 24,
        now: NOW,
        codex_sessions_root: NO_CODEX_ROOT,
      },
    );

    expect(payload.task_claim_file_before_edits).toMatchObject({
      edit_tool_calls: 2,
      edits_with_file_path: 2,
      edits_claimed_before: 2,
      pre_tool_use_signals: 2,
    });
    expect(payload.task_claim_file_before_edits.edits_claimed_before).toBeGreaterThan(0);
    expect(payload.task_claim_file_before_edits.pre_tool_use_signals).toBeGreaterThan(0);
    expect(
      payload.action_hints.find((hint) => hint.metric === 'claim-before-edit'),
    ).toBeUndefined();

    const nextFixes = outputSection(formatColonyHealthOutput(payload), 'Next fixes');
    expect(nextFixes).not.toContain('pre_tool_use before file mutation');
    expect(nextFixes).not.toContain('Wire OMX/Codex/Claude runtime');
  });

  it('does not ask for bridge wiring when pre_tool_use covers write edits', () => {
    const payload = buildColonyHealthPayload(
      fakeStorage({
        calls: [
          call(1, 'session-a', 'mcp__colony__hivemind_context', NOW - 90_000),
          call(2, 'session-a', 'mcp__colony__attention_inbox', NOW - 89_000),
          call(3, 'session-a', 'mcp__colony__task_ready_for_agent', NOW - 88_000),
          call(4, 'session-a', 'mcp__colony__task_claim_file', NOW - 87_000),
          call(5, 'session-a', 'Edit', NOW - 86_000),
          call(6, 'session-a', 'Write', NOW - 85_000),
        ],
        claimBeforeEdit: {
          edit_tool_calls: 2,
          edits_with_file_path: 2,
          edits_claimed_before: 2,
          pre_tool_use_signals: 2,
          claim_miss_reasons: {
            pre_tool_use_missing: 0,
          },
        },
      }),
      {
        since: SINCE,
        window_hours: 24,
        now: NOW,
        codex_sessions_root: NO_CODEX_ROOT,
      },
    );

    expect(payload.task_claim_file_before_edits).toMatchObject({
      edit_tool_calls: 2,
      edits_with_file_path: 2,
      edits_claimed_before: 2,
      pre_tool_use_signals: 2,
    });
    expect(payload.task_claim_file_before_edits.edits_claimed_before).toBeGreaterThan(0);
    expect(payload.task_claim_file_before_edits.pre_tool_use_signals).toBeGreaterThan(0);
    expect(
      payload.action_hints.find((hint) => hint.metric === 'claim-before-edit'),
    ).toBeUndefined();

    const nextFixes = outputSection(formatColonyHealthOutput(payload), 'Next fixes');
    expect(nextFixes).not.toContain('pre_tool_use before file mutation');
    expect(nextFixes).not.toContain('Wire OMX/Codex/Claude runtime');
  });

  it('prioritizes bridge, quota relay, and ready Queen claims over generic claim advice', () => {
    const payload = buildColonyHealthPayload(
      fakeStorage({
        calls: [
          call(1, 'session-a', 'mcp__colony__hivemind_context', NOW - 90_000),
          call(2, 'session-a', 'mcp__colony__attention_inbox', NOW - 89_000),
          call(3, 'session-a', 'mcp__colony__task_ready_for_agent', NOW - 88_000),
          call(4, 'session-a', 'mcp__colony__task_post', NOW - 87_000),
          call(5, 'session-a', 'mcp__colony__task_message', NOW - 86_000),
          ...calls(8, 100, 'session-a', 'mcp__colony__task_claim_file'),
        ],
        claimBeforeEdit: {
          edit_tool_calls: 1,
          edits_with_file_path: 1,
          edits_claimed_before: 0,
          pre_tool_use_signals: 0,
          claim_miss_reasons: {
            pre_tool_use_missing: 1,
          },
        },
        omxRuntimeStats: {
          status: 'unavailable',
          summaries_ingested: 0,
          latest_summary_ts: null,
          warning_count: 0,
        },
        tasks: [
          { id: 1, repo_root: '/r', branch: 'main' },
          { id: 2, repo_root: '/r', branch: 'spec/current-blockers/sub-0' },
        ],
        observationsByTask: {
          2: [
            observation(1, 2, 'plan-subtask', NOW - 3_000, {
              status: 'available',
              depends_on: [],
              title: 'Claim ready Queen blocker',
              file_scope: ['src/queen.ts'],
            }),
          ],
        },
        claimsByTask: {
          1: Array.from({ length: 5 }, (_, index) => ({
            task_id: 1,
            file_path: `src/quota-${index}.ts`,
            session_id: `quota-${index}`,
            claimed_at: NOW - 60_000,
            state: 'handoff_pending' as const,
            expires_at: NOW + 60_000,
            handoff_observation_id: 100 + index,
          })),
        },
      }),
      {
        since: SINCE,
        window_hours: 24,
        now: NOW,
        codex_sessions_root: NO_CODEX_ROOT,
      },
    );

    expect(payload.task_claim_file_before_edits).toMatchObject({
      measurable_edits: 1,
      unmeasurable_edits: 0,
      reason: 'insufficient runtime metadata or bridge unavailable',
    });
    expect(payload.signal_health.quota_pending_claims).toBe(5);
    expect(payload.ready_to_claim_vs_claimed).toMatchObject({
      ready_to_claim: 1,
      claimed: 0,
    });

    const nextFixes = outputSection(formatColonyHealthOutput(payload), 'Next fixes');
    expect(nextFixes).toContain('1. OMX runtime bridge');
    expect(nextFixes).toContain('2. quota relay accept/release');
    expect(nextFixes).toContain('3. Queen ready subtask claim');
    expect(nextFixes).toContain(
      'Wire the OMX runtime summary/lifecycle bridge so health can measure live edits, quota exits, and pre_tool_use before recommending claim discipline.',
    );
    expect(nextFixes).toContain(
      'Accept the quota relay, decline/reroute it, or release expired quota-pending claims',
    );
    expect(nextFixes).toContain(
      'Claim the ready Queen subtask with task_plan_claim_subtask before starting implementation.',
    );
    expect(nextFixes).not.toContain('Call task_claim_file');
    expect(nextFixes).not.toContain('mcp__colony__task_claim_file');

    const text = formatColonyHealthOutput(payload);
    expect(text).toContain('measurement: measurable_edits=1, unmeasurable_edits=0');
    expect(text).toContain('reason: insufficient runtime metadata or bridge unavailable');

    const json = JSON.parse(formatColonyHealthOutput(payload, { json: true }));
    expect(json.task_claim_file_before_edits).toMatchObject({
      measurable_edits: 1,
      unmeasurable_edits: 0,
      reason: 'insufficient runtime metadata or bridge unavailable',
    });
  });
});

function fakeStorage(args: {
  calls: TestToolCall[];
  claimBeforeEdit: {
    edit_tool_calls: number;
    edits_with_file_path: number;
    edits_claimed_before: number;
    pre_tool_use_signals?: number;
    claim_miss_reasons?: {
      no_claim_for_file?: number;
      claim_after_edit?: number;
      session_id_mismatch?: number;
      repo_root_mismatch?: number;
      branch_mismatch?: number;
      path_mismatch?: number;
      worktree_path_mismatch?: number;
      pseudo_path_skipped?: number;
      pre_tool_use_missing?: number;
    };
  };
  omxRuntimeStats?: {
    status: 'available' | 'unavailable';
    summaries_ingested: number;
    latest_summary_ts: number | null;
    warning_count: number;
  };
  tasks?: Array<{ id: number; repo_root: string; branch: string }>;
  observationsByTask?: Record<number, TestObservation[]>;
  claimsByTask?: Record<
    number,
    Array<{
      task_id: number;
      file_path: string;
      session_id: string;
      claimed_at: number;
      state?: 'active' | 'handoff_pending';
      expires_at?: number | null;
      handoff_observation_id?: number | null;
    }>
  >;
}): never {
  const tasks = args.tasks ?? [];
  const observationsByTask = args.observationsByTask ?? {};
  const claimsByTask = args.claimsByTask ?? {};
  return {
    toolCallsSince: () => args.calls,
    claimBeforeEditStats: () => args.claimBeforeEdit,
    omxRuntimeSummaryStats: () =>
      args.omxRuntimeStats ?? {
        status: 'available',
        summaries_ingested: 1,
        latest_summary_ts: NOW - 60_000,
        warning_count: 0,
      },
    listTasks: () => tasks,
    listClaims: (taskId: number) => claimsByTask[taskId] ?? [],
    taskTimeline: (taskId: number) => observationsByTask[taskId] ?? [],
    taskObservationsByKind: () => [],
    listProposalsForBranch: () => [],
    listReinforcements: () => [],
  } as never;
}

function call(id: number, sessionId: string, tool: string, ts: number): TestToolCall {
  return { id, session_id: sessionId, tool, ts };
}

function calls(count: number, firstId: number, sessionId: string, tool: string): TestToolCall[] {
  return Array.from({ length: count }, (_, index) =>
    call(firstId + index, sessionId, tool, NOW - 80_000 + index),
  );
}

function outputSection(output: string, heading: string): string {
  const start = output.indexOf(heading);
  if (start === -1) return '';
  const rest = output.slice(start);
  const nextHeading = rest.slice(heading.length).search(/\n[A-Z][^\n]+\n/);
  return nextHeading === -1 ? rest : rest.slice(0, heading.length + nextHeading);
}

function observation(
  id: number,
  taskId: number,
  kind: string,
  ts: number,
  metadata: Record<string, unknown>,
): TestObservation {
  return {
    id,
    session_id: 'session',
    kind,
    content: 'Claim ready Queen blocker',
    compressed: 0,
    intensity: null,
    ts,
    metadata: JSON.stringify(metadata),
    task_id: taskId,
    reply_to: null,
  };
}
