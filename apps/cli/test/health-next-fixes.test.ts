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

  it('prints a copy-paste task_message call while keeping shared notes on task_post', () => {
    const payload = buildColonyHealthPayload(
      fakeStorage({
        calls: [
          call(1, 'session-a', 'mcp__colony__hivemind_context', NOW - 90_000),
          call(2, 'session-a', 'mcp__colony__attention_inbox', NOW - 89_000),
          call(3, 'session-a', 'mcp__colony__task_ready_for_agent', NOW - 88_000),
          ...calls(80, 10, 'session-a', 'mcp__colony__task_post'),
          ...calls(4, 200, 'session-a', 'mcp__colony__task_message'),
        ],
        claimBeforeEdit: {
          edit_tool_calls: 0,
          edits_with_file_path: 0,
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

    expect(payload.task_post_vs_task_message).toMatchObject({
      task_post_calls: 80,
      task_message_calls: 4,
      task_message_share: 4 / 84,
    });

    const hint = payload.action_hints.find((entry) => entry.metric === 'task_message adoption');
    expect(hint).toMatchObject({
      action:
        'Use task_message when a post names an agent, asks can you/please/check/review/answer, says needs reply, or says handoff to; keep task_post for shared task-thread notes and decisions.',
      tool_call:
        'mcp__colony__task_message({ agent: "codex", session_id: "<session_id>", task_id: <task_id>, to_agent: "codex", urgency: "needs_reply", content: "<short directed request>" })',
    });
    expect(hint?.prompt).toContain('directed patterns: @claude/@codex');
    expect(hint?.prompt).toContain('directed call: mcp__colony__task_message({ agent: "codex"');
    expect(hint?.prompt).toContain('shared note: mcp__colony__task_post({ task_id: <task_id>');
    expect(hint?.prompt).toContain('shared task notes and decisions keep task_post');

    const nextFixes = outputSection(
      formatColonyHealthOutput(payload, { verbose: true }),
      'Next fixes',
    );
    expect(nextFixes).toContain(
      'tool: mcp__colony__task_message({ agent: "codex", session_id: "<session_id>", task_id: <task_id>, to_agent: "codex", urgency: "needs_reply", content: "<short directed request>" })',
    );

    const snippets = outputSection(
      formatColonyHealthOutput(payload, { prompts: true, verbose: true }),
      'Codex prompt snippets',
    );
    expect(snippets).toContain('directed call: mcp__colony__task_message');
    expect(snippets).toContain('shared note: mcp__colony__task_post');
  });

  it('points dominant pre_tool_use_missing at a silent lifecycle bridge when manual claims are high', () => {
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
      'runtime_bridge_status=available, task_claim_file_calls=480, edit_tool_calls=128, hook_capable_edits=128, pre_tool_use_signals=1, recent_task_claim_file_calls=480, recent_hook_capable_edits=128, recent_pre_tool_use_signals=1, recent_pre_tool_use_missing=128, edits_without_claim_before=128, dominant_claim_miss_reason=pre_tool_use_missing';

    expect(payload.task_claim_file_before_edits.root_cause).toMatchObject({
      kind: 'lifecycle_bridge_silent',
      summary:
        'Lifecycle bridge silent: runtime bridge is available, but edit-path telemetry is empty or near-zero.',
      evidence,
      action:
        'Install/wire the lifecycle bridge so OMX/Codex/Claude emits pre_tool_use before file mutation.',
      command:
        'colony install --ide <ide>  # then restart; pnpm smoke:codex-omx-pretool; colony health --hours 1 --json',
      evidence_counters: {
        runtime_bridge_status: 'available',
        task_claim_file_calls: 480,
        edit_tool_calls: 128,
        hook_capable_edits: 128,
        pre_tool_use_signals: 1,
      },
    });
    expect(payload.readiness_summary.execution_safety.root_cause).toEqual(
      payload.task_claim_file_before_edits.root_cause,
    );

    const claimHint = payload.action_hints.find((hint) => hint.metric === 'claim-before-edit');
    expect(claimHint).toMatchObject({
      current: `Lifecycle bridge silent: runtime bridge is available, but edit-path telemetry is empty or near-zero. (${evidence})`,
      target: 'pre_tool_use before file mutation',
      action:
        'Install/wire the lifecycle bridge so OMX/Codex/Claude emits pre_tool_use before file mutation.',
      priority: 5,
      command:
        'colony install --ide <ide>  # then restart; pnpm smoke:codex-omx-pretool; colony health --hours 1 --json',
      prompt: expect.stringContaining('Goal: wire the runtime lifecycle bridge'),
    });
    expect(claimHint?.tool_call).toBeUndefined();

    const text = formatColonyHealthOutput(payload);
    const readiness = outputSection(text, 'Readiness summary');
    expect(readiness).toContain(
      'root cause: Lifecycle bridge silent: runtime bridge is available, but edit-path telemetry is empty or near-zero.',
    );
    expect(readiness).toContain(`evidence: ${evidence}`);
    expect(readiness).toContain(
      'action: Install/wire the lifecycle bridge so OMX/Codex/Claude emits pre_tool_use before file mutation.',
    );
    expect(readiness).toContain(
      'cmd:  colony install --ide <ide>  # then restart; pnpm smoke:codex-omx-pretool; colony health --hours 1 --json',
    );

    const nextFixes = outputSection(text, 'Next fixes');
    expect(nextFixes).toContain(
      `claim-before-edit: Lifecycle bridge silent: runtime bridge is available, but edit-path telemetry is empty or near-zero. (${evidence}) (target pre_tool_use before file mutation) - Install/wire the lifecycle bridge so OMX/Codex/Claude emits pre_tool_use before file mutation.`,
    );
    expect(nextFixes).toContain(
      'cmd:  colony install --ide <ide>  # then restart; pnpm smoke:codex-omx-pretool; colony health --hours 1 --json',
    );
    expect(nextFixes).not.toContain('mcp__colony__task_claim_file');
    expect(nextFixes).not.toContain('Call task_claim_file');

    const json = JSON.parse(formatColonyHealthOutput(payload, { json: true }));
    expect(json.readiness_summary.execution_safety.root_cause).toMatchObject({
      kind: 'lifecycle_bridge_silent',
      command:
        'colony install --ide <ide>  # then restart; pnpm smoke:codex-omx-pretool; colony health --hours 1 --json',
    });
    expect(json.task_claim_file_before_edits.root_cause.evidence).toBe(evidence);
    expect(json.task_claim_file_before_edits.root_cause.evidence_counters).toMatchObject({
      runtime_bridge_status: 'available',
      task_claim_file_calls: 480,
      hook_capable_edits: 128,
      pre_tool_use_signals: 1,
    });
  });

  it('reports lifecycle bridge silent when manual claims are high but no hook-capable edits were recorded', () => {
    const payload = buildColonyHealthPayload(
      fakeStorage({
        calls: [
          call(1, 'session-a', 'mcp__colony__hivemind_context', NOW - 90_000),
          call(2, 'session-a', 'mcp__colony__attention_inbox', NOW - 89_000),
          call(3, 'session-a', 'mcp__colony__task_ready_for_agent', NOW - 88_000),
          ...calls(492, 100, 'session-a', 'mcp__colony__task_claim_file'),
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

    const evidence =
      'runtime_bridge_status=available, task_claim_file_calls=492, edit_tool_calls=0, hook_capable_edits=0, pre_tool_use_signals=0, recent_task_claim_file_calls=492, recent_hook_capable_edits=0, recent_pre_tool_use_signals=0, recent_pre_tool_use_missing=0, edits_without_claim_before=0, dominant_claim_miss_reason=none';
    expect(payload.task_claim_file_before_edits.root_cause).toMatchObject({
      kind: 'lifecycle_bridge_silent',
      summary:
        'Lifecycle bridge silent: runtime bridge is available, but edit-path telemetry is empty or near-zero.',
      evidence,
      action:
        'Verify lifecycle hook installation and restart the editor session so PreToolUse emits edit-path telemetry.',
      command:
        'colony install --ide <ide>  # then restart; pnpm smoke:codex-omx-pretool; colony health --hours 1 --json',
      evidence_counters: {
        runtime_bridge_status: 'available',
        task_claim_file_calls: 492,
        hook_capable_edits: 0,
        pre_tool_use_signals: 0,
      },
    });

    const hint = payload.action_hints.find((entry) => entry.metric === 'claim-before-edit');
    expect(hint).toMatchObject({
      current:
        'Lifecycle bridge silent: runtime bridge is available, but edit-path telemetry is empty or near-zero. (runtime_bridge_status=available, task_claim_file_calls=492, edit_tool_calls=0, hook_capable_edits=0, pre_tool_use_signals=0, recent_task_claim_file_calls=492, recent_hook_capable_edits=0, recent_pre_tool_use_signals=0, recent_pre_tool_use_missing=0, edits_without_claim_before=0, dominant_claim_miss_reason=none)',
      target: 'pre_tool_use before file mutation',
      priority: 5,
    });

    const text = formatColonyHealthOutput(payload);
    const focus = outputSection(text, 'Health focus');
    expect(focus).toContain('top blocker: claim-before-edit: Lifecycle bridge silent');
    expect(focus).toContain('cmd:  colony install --ide <ide>');
    const readiness = outputSection(text, 'Readiness summary');
    expect(readiness).toContain(
      'root cause: Lifecycle bridge silent: runtime bridge is available, but edit-path telemetry is empty or near-zero.',
    );
    expect(readiness).toContain(`evidence: ${evidence}`);
  });

  it('reports lifecycle bridge unavailable separately from silent bridge telemetry', () => {
    const payload = buildColonyHealthPayload(
      fakeStorage({
        calls: [
          call(1, 'session-a', 'mcp__colony__hivemind_context', NOW - 90_000),
          call(2, 'session-a', 'mcp__colony__attention_inbox', NOW - 89_000),
          call(3, 'session-a', 'mcp__colony__task_ready_for_agent', NOW - 88_000),
          ...calls(12, 100, 'session-a', 'mcp__colony__task_claim_file'),
        ],
        claimBeforeEdit: {
          edit_tool_calls: 0,
          edits_with_file_path: 0,
          edits_claimed_before: 0,
          pre_tool_use_signals: 0,
        },
        omxRuntimeStats: {
          status: 'unavailable',
          summaries_ingested: 0,
          latest_summary_ts: null,
          warning_count: 0,
        },
      }),
      {
        since: SINCE,
        window_hours: 24,
        now: NOW,
        codex_sessions_root: NO_CODEX_ROOT,
      },
    );

    expect(payload.task_claim_file_before_edits.root_cause).toMatchObject({
      kind: 'lifecycle_bridge_unavailable',
      summary:
        'Lifecycle bridge unavailable: runtime bridge is not available, so health cannot trust edit telemetry.',
      evidence_counters: {
        runtime_bridge_status: 'unavailable',
        task_claim_file_calls: 12,
        hook_capable_edits: 0,
        pre_tool_use_signals: 0,
      },
    });
    const nextFixes = outputSection(formatColonyHealthOutput(payload), 'Next fixes');
    expect(nextFixes).toContain('1. OMX runtime bridge');
    expect(nextFixes).not.toContain('1. claim-before-edit');
  });

  it('reports lifecycle paths missing when PreToolUse exists without file_path metadata', () => {
    const payload = buildColonyHealthPayload(
      fakeStorage({
        calls: [
          call(1, 'session-a', 'mcp__colony__hivemind_context', NOW - 90_000),
          call(2, 'session-a', 'mcp__colony__attention_inbox', NOW - 89_000),
          call(3, 'session-a', 'mcp__colony__task_ready_for_agent', NOW - 88_000),
          ...calls(12, 100, 'session-a', 'mcp__colony__task_claim_file'),
        ],
        claimBeforeEdit: {
          edit_tool_calls: 4,
          edits_with_file_path: 0,
          edits_claimed_before: 0,
          pre_tool_use_signals: 4,
        },
      }),
      {
        since: SINCE,
        window_hours: 24,
        now: NOW,
        codex_sessions_root: NO_CODEX_ROOT,
      },
    );

    expect(payload.task_claim_file_before_edits.root_cause).toMatchObject({
      kind: 'lifecycle_paths_missing',
      summary:
        'Lifecycle paths missing: PreToolUse telemetry exists, but edit events do not include file_path metadata.',
      evidence_counters: {
        runtime_bridge_status: 'available',
        edit_tool_calls: 4,
        hook_capable_edits: 0,
        pre_tool_use_signals: 4,
      },
    });
    expect(formatColonyHealthOutput(payload)).toContain(
      'root cause: Lifecycle paths missing: PreToolUse telemetry exists, but edit events do not include file_path metadata.',
    );
  });

  it('reports lifecycle claim mismatch when paths exist but claims do not match edit scope', () => {
    const payload = buildColonyHealthPayload(
      fakeStorage({
        calls: [
          call(1, 'session-a', 'mcp__colony__hivemind_context', NOW - 90_000),
          call(2, 'session-a', 'mcp__colony__attention_inbox', NOW - 89_000),
          call(3, 'session-a', 'mcp__colony__task_ready_for_agent', NOW - 88_000),
          ...calls(12, 100, 'session-a', 'mcp__colony__task_claim_file'),
        ],
        claimBeforeEdit: {
          edit_tool_calls: 12,
          edits_with_file_path: 12,
          edits_claimed_before: 0,
          pre_tool_use_signals: 12,
          claim_miss_reasons: {
            no_claim_for_file: 0,
            branch_mismatch: 12,
            pre_tool_use_missing: 1,
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

    expect(payload.task_claim_file_before_edits.root_cause).toMatchObject({
      kind: 'lifecycle_claim_mismatch',
      summary:
        'Lifecycle claim mismatch: file paths are present, but lifecycle claims do not match edit scope.',
      action:
        'Reclaim the edited files in the same repo, branch, worktree, and session; then rerun lifecycle health.',
      command:
        'colony bridge lifecycle --json --ide <ide> --cwd <repo_root> < colony-omx-lifecycle-v1.pre.json',
      evidence_counters: {
        runtime_bridge_status: 'available',
        hook_capable_edits: 12,
        pre_tool_use_signals: 12,
        edits_without_claim_before: 12,
        dominant_claim_miss_reason: 'branch_mismatch',
      },
    });
    const json = JSON.parse(formatColonyHealthOutput(payload, { json: true }));
    expect(json.task_claim_file_before_edits.root_cause.kind).toBe('lifecycle_claim_mismatch');
    expect(json.readiness_summary.execution_safety.root_cause).toMatchObject({
      action:
        'Reclaim the edited files in the same repo, branch, worktree, and session; then rerun lifecycle health.',
      command:
        'colony bridge lifecycle --json --ide <ide> --cwd <repo_root> < colony-omx-lifecycle-v1.pre.json',
    });
    const nextFixes = outputSection(formatColonyHealthOutput(payload), 'Next fixes');
    expect(nextFixes).toContain(
      'tool: mcp__colony__task_claim_file({ task_id: <task_id>, session_id: "<session_id>", file_path: "<file>", note: "pre-edit claim in same repo/branch/worktree" })',
    );
  });

  it('reports no hook-capable edits when recent claims exist but no edit event exists yet', () => {
    const payload = buildColonyHealthPayload(
      fakeStorage({
        calls: [
          call(1, 'session-a', 'mcp__colony__hivemind_context', NOW - 90_000),
          call(2, 'session-a', 'mcp__colony__attention_inbox', NOW - 89_000),
          call(3, 'session-a', 'mcp__colony__task_ready_for_agent', NOW - 88_000),
          call(4, 'session-a', 'mcp__colony__task_claim_file', NOW - 87_000),
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

    expect(payload.task_claim_file_before_edits.root_cause).toMatchObject({
      kind: 'no_hook_capable_edits',
      summary: 'No hook-capable edits: health saw no file edit events in the selected window.',
      command: 'colony health --hours 1 --json',
      evidence_counters: {
        runtime_bridge_status: 'available',
        task_claim_file_calls: 1,
        hook_capable_edits: 0,
        pre_tool_use_signals: 0,
      },
    });
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

  it('keeps the health focus explicit when no action is visible', () => {
    const payload = buildColonyHealthPayload(
      fakeStorage({
        calls: [
          call(1, 'session-a', 'mcp__colony__hivemind_context', NOW - 90_000),
          call(2, 'session-a', 'mcp__colony__attention_inbox', NOW - 89_000),
          call(3, 'session-a', 'mcp__colony__task_ready_for_agent', NOW - 88_000),
          call(4, 'session-a', 'mcp__colony__task_claim_file', NOW - 87_000),
          call(5, 'session-a', 'Edit', NOW - 86_000),
        ],
        claimBeforeEdit: {
          edit_tool_calls: 1,
          edits_with_file_path: 1,
          edits_claimed_before: 1,
          pre_tool_use_signals: 1,
        },
      }),
      {
        since: SINCE,
        window_hours: 24,
        now: NOW,
        codex_sessions_root: NO_CODEX_ROOT,
      },
    );
    const clearPayload = {
      ...payload,
      readiness_summary: Object.fromEntries(
        Object.entries(payload.readiness_summary).map(([key, item]) => [
          key,
          { ...item, status: 'good' as const },
        ]),
      ) as typeof payload.readiness_summary,
      action_hints: [],
    };

    const focus = outputSection(formatColonyHealthOutput(clearPayload), 'Health focus');
    expect(focus).toContain('status: clear');
    expect(focus).toContain('next action: none');
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
    expect(nextFixes).toContain('3. Queen activation/claim');
    expect(nextFixes).toContain(
      'Metric unreliable: wire the OMX runtime summary/lifecycle bridge so health can measure live edits, quota exits, and pre_tool_use before recommending claim discipline.',
    );
    expect(nextFixes).toContain(
      'Resolve quota-pending ownership first: accept if taking over, decline/reroute if not, or release expired quota claims with audit.',
    );
    expect(nextFixes).toContain(
      'Reactivate Queen planning or claim/requeue the existing plan subtask',
    );
    expect(nextFixes).not.toContain('Call task_claim_file');
    expect(nextFixes).not.toContain('mcp__colony__task_claim_file');

    const text = formatColonyHealthOutput(payload);
    const focus = outputSection(text, 'Health focus');
    expect(focus).toContain('status: 3 bad readiness area(s)');
    expect(focus).toContain(
      'bad areas: execution_safety, queen_plan_readiness, signal_evaporation',
    );
    expect(focus).toContain('top blocker: OMX runtime bridge: unavailable');
    expect(focus).toContain(
      'next action: Metric unreliable: wire the OMX runtime summary/lifecycle bridge so health can measure live edits, quota exits, and pre_tool_use before recommending claim discipline.',
    );
    expect(focus).toContain(
      'cmd:  colony bridge lifecycle --json --ide <ide> --cwd <repo_root> < colony-omx-lifecycle-v1.pre.json',
    );
    expect(focus).not.toContain('hidden follow-ups:');
    expect(focus).toContain('next commands:');
    expect(focus).toContain(
      'execution_safety: cmd: colony bridge lifecycle --json --ide <ide> --cwd <repo_root> < colony-omx-lifecycle-v1.pre.json',
    );
    expect(focus).toContain('signal_evaporation: cmd: colony inbox --json');
    expect(focus).toContain(
      'queen_plan_readiness: tool: mcp__colony__task_ready_for_agent({ agent: "<agent>", session_id: "<session_id>", repo_root: "<repo_root>" }) -> mcp__colony__task_plan_claim_subtask(...) or mcp__colony__queen_plan_goal(...)',
    );
    expect(text).toContain('measurement: measurable_edits=1, unmeasurable_edits=0');
    expect(text).toContain('reason: insufficient runtime metadata or bridge unavailable');

    const json = JSON.parse(formatColonyHealthOutput(payload, { json: true }));
    expect(json.task_claim_file_before_edits).toMatchObject({
      measurable_edits: 1,
      unmeasurable_edits: 0,
      runtime_bridge_status: 'unavailable',
      reason: 'insufficient runtime metadata or bridge unavailable',
    });
  });

  it('repairs inactive Queen state when subtasks exist without generic claim adoption advice', () => {
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
          { id: 2, repo_root: '/r', branch: 'spec/inactive-blockers/sub-0' },
        ],
        observationsByTask: {
          2: [
            observation(1, 2, 'plan-subtask', NOW - 3_000, {
              status: 'completed',
              depends_on: [],
              title: 'Completed orphan Queen blocker',
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

    expect(payload.queen_wave_health.active_plans).toBe(0);
    expect(payload.ready_to_claim_vs_claimed.plan_subtasks).toBe(1);
    expect(payload.signal_health.quota_pending_claims).toBe(5);
    expect(payload.task_claim_file_before_edits).toMatchObject({
      measurable_edits: 1,
      unmeasurable_edits: 0,
      runtime_bridge_status: 'unavailable',
      reason: 'insufficient runtime metadata or bridge unavailable',
    });

    const text = formatColonyHealthOutput(payload);
    const focus = outputSection(text, 'Health focus');
    expect(focus).toContain('top blocker: OMX runtime bridge: unavailable');
    expect(focus).not.toContain('hidden follow-ups:');
    expect(focus).toContain('next commands:');
    const nextFixes = outputSection(text, 'Next fixes');
    expect(nextFixes).toContain('1. OMX runtime bridge');
    expect(nextFixes).toContain('2. quota relay accept/release');
    expect(nextFixes).toContain('3. Queen activation/claim');
    expect(nextFixes).toContain(
      'Reactivate Queen planning or claim/requeue the existing plan subtask',
    );
    expect(nextFixes).not.toContain('Call task_claim_file');
    expect(nextFixes).not.toContain('mcp__colony__task_claim_file');
    expect(nextFixes).not.toContain('task_ready_for_agent -> claim');
    expect(text).toContain(
      'measurement: measurable_edits=1, unmeasurable_edits=0, runtime_bridge_status=unavailable',
    );
    expect(text).toContain(
      'metric unreliable: insufficient runtime metadata or bridge unavailable',
    );

    const json = JSON.parse(formatColonyHealthOutput(payload, { json: true }));
    expect(json.task_claim_file_before_edits).toMatchObject({
      measurable_edits: 1,
      unmeasurable_edits: 0,
      runtime_bridge_status: 'unavailable',
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
    countMcpMetricsSince: () => 0,
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
