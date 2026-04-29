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
});

function fakeStorage(args: {
  calls: TestToolCall[];
  claimBeforeEdit: {
    edit_tool_calls: number;
    edits_with_file_path: number;
    edits_claimed_before: number;
  };
}): never {
  return {
    toolCallsSince: () => args.calls,
    claimBeforeEditStats: () => args.claimBeforeEdit,
    listTasks: () => [],
    listClaims: () => [],
    taskTimeline: () => [],
    taskObservationsByKind: () => [],
    listProposalsForBranch: () => [],
    listReinforcements: () => [],
  } as never;
}

function call(id: number, sessionId: string, tool: string, ts: number): TestToolCall {
  return { id, session_id: sessionId, tool, ts };
}

function outputSection(output: string, heading: string): string {
  const start = output.indexOf(heading);
  if (start === -1) return '';
  const rest = output.slice(start);
  const nextHeading = rest.slice(heading.length).search(/\n[A-Z][^\n]+\n/);
  return nextHeading === -1 ? rest : rest.slice(0, heading.length + nextHeading);
}
