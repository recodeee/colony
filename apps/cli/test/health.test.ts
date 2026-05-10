import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSettings } from '@colony/config';
import { type MemoryStore, TaskThread } from '@colony/core';
import {
  type ClaimBeforeEditStats,
  type ClaimMatchSources,
  type ClaimMissReasons,
  type NearestClaimExample,
  type OmxRuntimeSummaryStats,
  Storage,
} from '@colony/storage';
import Database from 'better-sqlite3';
import kleur from 'kleur';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildColonyHealthPayload,
  buildHealthFixPlan,
  formatColonyHealthOutput,
  formatHealthFixPlanOutput,
} from '../src/commands/health.js';
import { createProgram } from '../src/index.js';
import { withStore } from '../src/util/store.js';

const NOW = 1_800_000_000_000;
const SINCE = NOW - 24 * 3_600_000;
// Most tests don't exercise codex rollout merging — point the reader at a
// path that can't exist so they never accidentally read the user's real
// ~/.codex/sessions during CI or local runs.
const NO_CODEX_ROOT = '/var/empty/colony-health-test-no-codex';

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
  status?: string;
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
  it('does not crash on an old database whose task_claims table has no state column', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'colony-health-old-claims-'));
    const originalColonyHome = process.env.COLONY_HOME;
    let output = '';
    try {
      process.env.COLONY_HOME = dataDir;
      seedOldClaimSchemaDatabase(path.join(dataDir, 'data.db'));
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        output += String(chunk);
        return true;
      });

      await createProgram().parseAsync(
        ['node', 'test', 'health', '--json', '--repo-root', dataDir],
        { from: 'node' },
      );

      const payload = JSON.parse(output) as { signal_health: { total_claims: number } };
      expect(payload.signal_health.total_claims).toBe(1);
    } finally {
      vi.restoreAllMocks();
      if (originalColonyHome === undefined) delete process.env.COLONY_HOME;
      else process.env.COLONY_HOME = originalColonyHome;
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('reports adoption ratios and renders a stable human-readable shape', () => {
    const payload = buildColonyHealthPayload(
      fakeStorage({
        calls: healthyWindowCalls(),
        claimBeforeEdit: {
          edit_tool_calls: 2,
          edits_with_file_path: 2,
          edits_claimed_before: 1,
          claim_match_window_ms: 300_000,
          claim_match_sources: {
            exact_session: 0,
            repo_branch: 1,
            worktree: 0,
            agent_lane: 0,
          },
          claim_miss_reasons: {
            no_claim_for_file: 1,
            claim_after_edit: 0,
            session_id_mismatch: 0,
            repo_root_mismatch: 0,
            branch_mismatch: 0,
            path_mismatch: 0,
            worktree_path_mismatch: 0,
            pseudo_path_skipped: 0,
            pre_tool_use_missing: 0,
          },
          nearest_claim_examples: [
            nearestClaimExample({
              reason: 'no_claim_for_file',
              edit_id: 9,
              edit_session_id: 'codex-alpha-session',
              edit_file_path: 'src/missing.ts',
            }),
          ],
        },
      }),
      {
        since: SINCE,
        window_hours: 24,
        now: NOW,
        codex_sessions_root: NO_CODEX_ROOT,
        mcp_capability_sources: [
          {
            id: 'fixture',
            servers: {
              colony: { command: 'node', args: ['colony', 'mcp'] },
              omx: { command: 'omx', args: ['mcp'] },
              github: { command: 'github-mcp-server' },
              filesystem: { command: 'mcp-server-filesystem' },
            },
          },
        ],
      },
    );

    expect(payload.colony_mcp_share).toMatchObject({
      total_tool_calls: 17,
      mcp_tool_calls: 15,
      colony_mcp_tool_calls: 13,
      share_of_all_tool_calls: 13 / 17,
      share_of_mcp_tool_calls: 13 / 15,
    });
    expect(payload.mcp_capability_map.summary).toEqual([
      'colony: claims, plans',
      'filesystem: repo-inspection',
      'github: issues, PRs, repo',
      'omx: runtime-state',
    ]);
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
      task_list_first_sessions: 2,
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
      task_note_working_calls: 0,
      colony_note_calls: 1,
      omx_notepad_write_calls: 1,
      task_post_share: 1 / 2,
      colony_note_share: 1 / 2,
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
      claim_match_window_ms: 300_000,
      claim_match_sources: {
        exact_session: 0,
        repo_branch: 1,
        worktree: 0,
        agent_lane: 0,
      },
      claim_miss_reasons: {
        no_claim_for_file: 1,
        claim_after_edit: 0,
        session_id_mismatch: 0,
        repo_root_mismatch: 0,
        branch_mismatch: 0,
        path_mismatch: 0,
        worktree_path_mismatch: 0,
        pseudo_path_skipped: 0,
        pre_tool_use_missing: 0,
      },
      nearest_claim_examples: [
        expect.objectContaining({
          reason: 'no_claim_for_file',
          edit_file_path: 'src/missing.ts',
        }),
      ],
      root_cause: null,
    });
    expect(payload.signal_health).toMatchObject({
      total_claims: 2,
      active_claims: 1,
      fresh_claims: 1,
      stale_claims: 1,
      expired_claims: 0,
      weak_claims: 1,
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
    expect(payload.queen_wave_health).toMatchObject({
      active_plans: 1,
      current_wave: 'Wave 1',
      ready_subtasks: 1,
      claimed_subtasks: 1,
      blocked_subtasks: 1,
      stale_claims_blocking_downstream: 0,
      plans: [
        expect.objectContaining({
          plan_slug: 'plan',
          current_wave: 'Wave 1',
          ready_subtasks: 1,
          claimed_subtasks: 1,
          blocked_subtasks: 1,
        }),
      ],
    });
    expect(payload.readiness_summary).toMatchObject({
      coordination_readiness: {
        status: 'good',
        evidence: expect.stringContaining('MCP share 87%; hivemind->inbox 50%'),
      },
      execution_safety: {
        status: 'good',
        evidence: expect.stringContaining('claim-before-edit 50%'),
      },
      queen_plan_readiness: {
        status: 'good',
        evidence: expect.stringContaining('1 active plan(s); 1 ready, 1 claimed'),
      },
      working_state_migration: {
        status: 'bad',
        evidence: expect.stringContaining('colony note share 50%'),
      },
      signal_evaporation: {
        status: 'bad',
        evidence: expect.stringContaining(
          '1 stale claim(s); 0 quota-pending claim(s); 0 stale downstream blocker(s); 0 quota downstream blocker(s)',
        ),
      },
    });
    expect(payload.adoption_thresholds.good).toContainEqual(
      expect.objectContaining({
        name: 'hivemind_context rising',
        status: 'good',
        value: 2,
      }),
    );
    expect(payload.adoption_thresholds.bad).toContainEqual(
      expect.objectContaining({
        name: 'task_list > task_ready_for_agent',
        status: 'bad',
        value: 1,
      }),
    );

    const text = formatColonyHealthOutput(payload);
    expect(text).toContain('COLONY HEALTH');
    expect(text).toContain('At a glance ===');
    expect(text).toContain('Health focus ===');
    expect(text).toContain('Readiness summary ===');
    expect(text).toContain('Next fixes ===');
    expect(text).toContain('At a glance');
    expect(text.indexOf('At a glance')).toBeLessThan(text.indexOf('Health focus'));
    expect(text.indexOf('Health focus')).toBeLessThan(text.indexOf('Readiness summary'));
    expect(text).toContain('overall:');
    expect(text).toContain('score: 60/100 (2 fix, 0 watch, 3 ready)');
    expect(text).toContain('status:');
    expect(text).toContain('needs work:');
    expect(text).toContain('watch: none');
    expect(text).toContain('fix first:');
    expect(text).toContain('top blocker:');
    expect(text).toContain('why:');
    expect(text).toContain('next:');
    expect(text).toContain('next action:');
    expect(text).toContain('command:');
    expect(text).toContain('areas:');
    expect(text).toContain('Coordination loop (coordination_readiness)');
    expect(text).toContain('Edit safety (execution_safety)');
    expect(text).toContain('evidence: MCP share');
    expect(text).toContain('Readiness summary');
    expect(text.indexOf('Readiness summary')).toBeLessThan(text.indexOf('Next fixes'));
    expect(text).toContain('coordination_readiness');
    expect(text).toContain('execution_safety');
    expect(text).toContain('queen_plan_readiness');
    expect(text).toContain('working_state_migration');
    expect(text).toContain('signal_evaporation');
    expect(text).not.toContain('Detailed diagnostics');
    expect(text).not.toContain('Colony MCP share');
    expect(text).not.toContain('MCP capability map');
    expect(text).toContain('Next fixes');
    expect(text).toContain('now:');
    expect(text).toContain('target:');
    expect(text).toContain('next:');
    expect(text).not.toContain('\n  Good\n');
    expect(text).not.toContain('\n  Bad\n');

    const verboseText = formatColonyHealthOutput(payload, { verbose: true });
    expect(verboseText.indexOf('Next fixes')).toBeLessThan(
      verboseText.indexOf('Detailed diagnostics'),
    );
    expect(verboseText.indexOf('Detailed diagnostics')).toBeLessThan(
      verboseText.indexOf('Colony MCP share'),
    );
    expect(verboseText).toContain('Colony MCP share');
    expect(verboseText).toContain('MCP capability map');
    expect(verboseText).toContain('colony: claims, plans');
    expect(verboseText).toContain('github: issues, PRs, repo');
    expect(verboseText).toContain('hivemind_context -> attention_inbox: 1 / 2 (50%) sessions');
    expect(verboseText).toContain('attention_inbox -> task_ready_for_agent: 1 / 1 (100%) sessions');
    expect(verboseText).toContain('task_list vs task_ready_for_agent');
    expect(verboseText).toContain('task_post vs task_message');
    expect(verboseText).toContain('task_post vs OMX notepad');
    expect(verboseText).toContain('Search calls per session');
    expect(verboseText).toContain('1 / 2 edits had a claim before edit (50%)');
    expect(verboseText).toContain(
      'claim_match_sources: exact_session=0, repo_branch=1, worktree=0, agent_lane=0, window_ms=300000 (health-only fallback)',
    );
    expect(verboseText).toContain('why claims did not match edits:');
    expect(verboseText).toContain('no_claim_for_file: 1');
    expect(verboseText).toContain('nearest claim examples:');
    expect(verboseText).toContain(
      'no_claim_for_file: edit#9 src/missing.ts by codex-alpha-session; no nearby claim',
    );
    expect(verboseText).toContain('Signal health');
    expect(verboseText).toContain('Proposal decay/promotions');
    expect(verboseText).toContain('Ready-to-claim vs claimed');
    expect(verboseText).toContain('Queen wave plans');
    expect(verboseText).toContain('active plans:                       1');
    expect(verboseText).toContain('current wave:                       Wave 1');
    expect(verboseText).toContain('stale claims blocking downstream:   0');
    expect(verboseText).toContain('Adoption thresholds');
    expect(verboseText).toContain('task_list > task_ready_for_agent');
    expect(verboseText).toContain('task_list-first sessions: 2');
  });

  it('renders claim miss reason diagnostics in text and JSON payloads', () => {
    const payload = buildColonyHealthPayload(
      fakeStorage({
        calls: [call(1, 'codex-alpha-session', 'Edit', NOW - 1_000)],
        claimBeforeEdit: {
          edit_tool_calls: 1,
          edits_with_file_path: 1,
          edits_claimed_before: 0,
          claim_miss_reasons: {
            no_claim_for_file: 0,
            claim_after_edit: 1,
            session_id_mismatch: 2,
            path_mismatch: 3,
            repo_root_mismatch: 4,
            branch_mismatch: 5,
            worktree_path_mismatch: 0,
            pseudo_path_skipped: 6,
            pre_tool_use_missing: 7,
          },
        },
      }),
      { since: SINCE, window_hours: 24, now: NOW, codex_sessions_root: NO_CODEX_ROOT },
    );

    expect(payload.task_claim_file_before_edits.claim_miss_reasons).toMatchObject({
      claim_after_edit: 1,
      session_id_mismatch: 2,
      path_mismatch: 3,
      repo_root_mismatch: 4,
      branch_mismatch: 5,
      pseudo_path_skipped: 6,
      pre_tool_use_missing: 7,
    });
    const text = formatColonyHealthOutput(payload, { verbose: true });
    expect(text).toContain('why claims did not match edits:');
    expect(text).toContain('claim_after_edit: 1');
    expect(text).toContain('session_id_mismatch: 2');
    expect(text).toContain('repo_root_mismatch: 4');
    expect(text).toContain('branch_mismatch: 5');
  });

  it('explains old bad edit telemetry without blaming the current lifecycle bridge', () => {
    const recentSince = NOW - 3_600_000;
    const payload = buildColonyHealthPayload(
      fakeStorage({
        calls: Array.from({ length: 12 }, (_, index) =>
          call(
            index + 1,
            'codex-old-session',
            'mcp__colony__task_claim_file',
            SINCE + 1_000 + index,
          ),
        ),
        claimBeforeEdit: badClaimBeforeEditStats(),
        claimBeforeEditStatsBySince: (since) =>
          since >= recentSince ? cleanClaimBeforeEditStats() : badClaimBeforeEditStats(),
      }),
      { since: SINCE, window_hours: 24, now: NOW, codex_sessions_root: NO_CODEX_ROOT },
    );

    // Status is 'ok' (not 'bad') when the only red flag is stale 24h
    // telemetry and the recent window is at-or-above target — the
    // bridge is fine, the metric just needs to age out.
    expect(payload.readiness_summary.execution_safety.status).toBe('ok');
    expect(payload.task_claim_file_before_edits).toMatchObject({
      old_telemetry_pollution: true,
      recent_window_hours: 1,
      recent_hook_capable_edits: 5,
      recent_pre_tool_use_missing: 0,
      recent_pre_tool_use_signals: 5,
      recent_claim_before_edit_rate: 1,
    });
    expect(payload.readiness_summary.execution_safety.root_cause?.summary).toBe(
      '24h claim-before-edit includes older edit telemetry; no fresh pre_tool_use_missing edits detected in the recent window.',
    );
    expect(formatColonyHealthOutput(payload)).not.toContain('Lifecycle bridge missing');
    expect(payload.action_hints).toContainEqual(
      expect.objectContaining({
        metric: 'old claim-before-edit telemetry',
        current:
          '24h claim-before-edit includes older edit telemetry; no fresh pre_tool_use_missing edits detected in the recent window.',
      }),
    );
  });

  it('keeps lifecycle bridge unavailable when bad edits are fresh and runtime bridge is unavailable', () => {
    const payload = buildColonyHealthPayload(
      fakeStorage({
        calls: Array.from({ length: 12 }, (_, index) =>
          call(
            index + 1,
            'codex-fresh-session',
            'mcp__colony__task_claim_file',
            NOW - 60_000 + index,
          ),
        ),
        claimBeforeEdit: badClaimBeforeEditStats(),
        claimBeforeEditStatsBySince: () => badClaimBeforeEditStats(),
      }),
      { since: SINCE, window_hours: 24, now: NOW, codex_sessions_root: NO_CODEX_ROOT },
    );

    expect(payload.task_claim_file_before_edits.old_telemetry_pollution).toBe(false);
    expect(payload.readiness_summary.execution_safety.root_cause).toMatchObject({
      kind: 'lifecycle_bridge_unavailable',
      summary: expect.stringContaining('Lifecycle bridge unavailable'),
    });
    expect(formatColonyHealthOutput(payload)).toContain('root cause: Lifecycle bridge unavailable');
  });

  it('treats stale claim_mismatch buckets as old telemetry when the recent window is clean', () => {
    const recentSince = NOW - 3_600_000;
    // edit_tool_calls > edits_with_file_path so status='not_available' and
    // the all-time claim_before_edit_ratio is null — exactly the user
    // scenario that produces the bare `n/a` headline.
    const stalePathMismatchStats: ClaimBeforeEditStats = {
      edit_tool_calls: 35,
      edits_with_file_path: 30,
      edits_claimed_before: 25,
      claim_miss_reasons: {
        pre_tool_use_missing: 0,
        no_claim_for_file: 0,
        claim_after_edit: 0,
        session_id_mismatch: 0,
        repo_root_mismatch: 0,
        branch_mismatch: 0,
        path_mismatch: 5,
        worktree_path_mismatch: 0,
      },
      pre_tool_use_signals: 30,
    };
    const cleanRecentStats: ClaimBeforeEditStats = {
      edit_tool_calls: 12,
      edits_with_file_path: 12,
      edits_claimed_before: 12,
      claim_miss_reasons: {
        pre_tool_use_missing: 0,
        no_claim_for_file: 0,
      },
      pre_tool_use_signals: 12,
    };
    const payload = buildColonyHealthPayload(
      fakeStorage({
        calls: Array.from({ length: 12 }, (_, index) =>
          call(
            index + 1,
            'codex-fresh-session',
            'mcp__colony__task_claim_file',
            NOW - 60_000 + index,
          ),
        ),
        claimBeforeEdit: stalePathMismatchStats,
        claimBeforeEditStatsBySince: (since) =>
          since >= recentSince ? cleanRecentStats : stalePathMismatchStats,
      }),
      { since: SINCE, window_hours: 24, now: NOW, codex_sessions_root: NO_CODEX_ROOT },
    );

    expect(payload.task_claim_file_before_edits).toMatchObject({
      old_telemetry_pollution: true,
      recent_pre_tool_use_missing: 0,
      recent_claim_before_edit_rate: 1,
    });
    expect(payload.readiness_summary.execution_safety.root_cause).toMatchObject({
      kind: 'old_telemetry_pollution',
      summary: expect.stringContaining('older edit telemetry'),
    });
    expect(payload.readiness_summary.execution_safety.evidence).toBe(
      'claim-before-edit n/a (recent 1h: 100%; target 50%+); live contentions 0, dirty 0',
    );
  });

  it('treats stale claim_mismatch buckets as old telemetry when the recent window is healthy', () => {
    const recentSince = NOW - 3_600_000;
    const stalePathMismatchStats: ClaimBeforeEditStats = {
      edit_tool_calls: 35,
      edits_with_file_path: 30,
      edits_claimed_before: 25,
      claim_miss_reasons: {
        pre_tool_use_missing: 0,
        no_claim_for_file: 0,
        claim_after_edit: 0,
        session_id_mismatch: 0,
        repo_root_mismatch: 0,
        branch_mismatch: 0,
        path_mismatch: 5,
        worktree_path_mismatch: 0,
      },
      pre_tool_use_signals: 30,
    };
    const healthyRecentStats: ClaimBeforeEditStats = {
      edit_tool_calls: 15,
      edits_with_file_path: 15,
      edits_claimed_before: 14,
      claim_miss_reasons: {
        pre_tool_use_missing: 0,
        path_mismatch: 1,
      },
      pre_tool_use_signals: 21,
    };

    const payload = buildColonyHealthPayload(
      fakeStorage({
        calls: Array.from({ length: 12 }, (_, index) =>
          call(
            index + 1,
            'codex-fresh-session',
            'mcp__colony__task_claim_file',
            NOW - 60_000 + index,
          ),
        ),
        claimBeforeEdit: stalePathMismatchStats,
        claimBeforeEditStatsBySince: (since) =>
          since >= recentSince ? healthyRecentStats : stalePathMismatchStats,
      }),
      { since: SINCE, window_hours: 24, now: NOW, codex_sessions_root: NO_CODEX_ROOT },
    );

    expect(payload.task_claim_file_before_edits).toMatchObject({
      old_telemetry_pollution: true,
      recent_pre_tool_use_missing: 0,
      recent_claim_before_edit_rate: 14 / 15,
    });
    expect(payload.readiness_summary.execution_safety).toMatchObject({
      status: 'ok',
      root_cause: {
        kind: 'old_telemetry_pollution',
        summary: expect.stringContaining('older edit telemetry'),
      },
    });
  });

  it('marks the recent claim-before-edit rate n/a when there are no recent edits', () => {
    const recentSince = NOW - 3_600_000;
    const payload = buildColonyHealthPayload(
      fakeStorage({
        calls: Array.from({ length: 12 }, (_, index) =>
          call(
            index + 1,
            'codex-old-session',
            'mcp__colony__task_claim_file',
            SINCE + 1_000 + index,
          ),
        ),
        claimBeforeEdit: badClaimBeforeEditStats(),
        claimBeforeEditStatsBySince: (since) =>
          since >= recentSince ? emptyClaimBeforeEditStats() : badClaimBeforeEditStats(),
        tasks: [],
        claimsByTask: {},
      }),
      { since: SINCE, window_hours: 24, now: NOW, codex_sessions_root: NO_CODEX_ROOT },
    );

    expect(payload.readiness_summary.execution_safety.status).toBe('bad');
    expect(payload.task_claim_file_before_edits.old_telemetry_pollution).toBe(true);
    expect(payload.task_claim_file_before_edits.recent_hook_capable_edits).toBe(0);
    expect(payload.task_claim_file_before_edits.recent_claim_before_edit_rate).toBeNull();
    expect(payload.readiness_summary.execution_safety.root_cause?.summary).toBe(
      '24h claim-before-edit includes older edit telemetry; no fresh pre_tool_use_missing edits detected in the recent window.',
    );
    const text = formatColonyHealthOutput(payload, { verbose: true });
    expect(text).toContain('recent 1h: hook_capable_edits=0');
    expect(text).toContain('claim-before-edit=n/a');
    expect(text).not.toContain('Lifecycle bridge missing');
  });

  it('does not report stale branch mismatch as active when recent PreToolUse is alive', () => {
    const recentSince = NOW - 3_600_000;
    const staleBranchMismatchStats: ClaimBeforeEditStats = {
      edit_tool_calls: 250,
      edits_with_file_path: 250,
      edits_claimed_before: 93,
      claim_miss_reasons: {
        no_claim_for_file: 0,
        claim_after_edit: 0,
        session_id_mismatch: 0,
        repo_root_mismatch: 0,
        branch_mismatch: 157,
        path_mismatch: 0,
        worktree_path_mismatch: 0,
        pre_tool_use_missing: 0,
      },
      pre_tool_use_signals: 440,
    };
    const recentBridgeSignalsOnly: ClaimBeforeEditStats = {
      edit_tool_calls: 0,
      edits_with_file_path: 0,
      edits_claimed_before: 0,
      claim_miss_reasons: {
        pre_tool_use_missing: 0,
        branch_mismatch: 0,
      },
      pre_tool_use_signals: 7,
    };

    const payload = buildColonyHealthPayload(
      fakeStorage({
        calls: [
          ...Array.from({ length: 11 }, (_, index) =>
            call(
              index + 1,
              'codex-current-session',
              'mcp__colony__task_claim_file',
              SINCE + 1_000 + index,
            ),
          ),
          ...Array.from({ length: 7 }, (_, index) =>
            call(
              index + 20,
              'codex-current-session',
              'mcp__colony__task_claim_file',
              NOW - 60_000 + index,
            ),
          ),
        ],
        claimBeforeEdit: staleBranchMismatchStats,
        claimBeforeEditStatsBySince: (since) =>
          since >= recentSince ? recentBridgeSignalsOnly : staleBranchMismatchStats,
      }),
      { since: SINCE, window_hours: 24, now: NOW, codex_sessions_root: NO_CODEX_ROOT },
    );

    expect(payload.task_claim_file_before_edits).toMatchObject({
      old_telemetry_pollution: true,
      recent_hook_capable_edits: 0,
      recent_pre_tool_use_signals: 7,
      recent_pre_tool_use_missing: 0,
    });
    expect(payload.readiness_summary.execution_safety).toMatchObject({
      status: 'ok',
      root_cause: {
        kind: 'old_telemetry_pollution',
        summary: expect.stringContaining('older edit telemetry'),
      },
    });
    expect(payload.action_hints).not.toContainEqual(
      expect.objectContaining({ metric: 'claim-before-edit' }),
    );
  });

  it('reports recent claim-before-edit as insufficient sample below RECENT_CLAIM_BEFORE_EDIT_MIN_SAMPLE', () => {
    const payload = buildColonyHealthPayload(
      fakeStorage({
        calls: [],
        claimBeforeEdit: emptyClaimBeforeEditStats(),
        claimBeforeEditStatsBySince: () => ({
          edit_tool_calls: 1,
          edits_with_file_path: 1,
          edits_claimed_before: 1,
          pre_tool_use_signals: 1,
        }),
      }),
      { since: SINCE, window_hours: 24, now: NOW, codex_sessions_root: NO_CODEX_ROOT },
    );

    expect(payload.task_claim_file_before_edits.recent_claim_before_edit_rate).toBeNull();
    expect(formatColonyHealthOutput(payload, { verbose: true })).toContain(
      'claim-before-edit=insufficient sample',
    );
  });

  it('prioritizes dirty contended files over old claim-before-edit telemetry', () => {
    const recentSince = NOW - 3_600_000;
    const payload = buildColonyHealthPayload(
      fakeStorage({
        calls: Array.from({ length: 12 }, (_, index) =>
          call(
            index + 1,
            'codex-old-session',
            'mcp__colony__task_claim_file',
            SINCE + 1_000 + index,
          ),
        ),
        claimBeforeEdit: badClaimBeforeEditStats(),
        claimBeforeEditStatsBySince: (since) =>
          since >= recentSince ? emptyClaimBeforeEditStats() : badClaimBeforeEditStats(),
        tasks: [],
        claimsByTask: {},
      }),
      {
        since: SINCE,
        window_hours: 24,
        now: NOW,
        codex_sessions_root: NO_CODEX_ROOT,
        repo_root: '/repo',
        worktree_contention: fakeWorktreeContention(2),
      },
    );

    expect(payload.live_contention_health).toMatchObject({
      live_file_contentions: 0,
      dirty_contended_files: 2,
    });
    expect(payload.task_claim_file_before_edits.old_telemetry_pollution).toBe(true);

    const text = formatColonyHealthOutput(payload);
    const nextFixes = outputSection(text, 'Next fixes');
    expect(nextFixes).toContain('1. dirty contended files');
    expect(nextFixes).toContain('2. old claim-before-edit telemetry');
    expect(nextFixes.indexOf('1. dirty contended files')).toBeLessThan(
      nextFixes.indexOf('2. old claim-before-edit telemetry'),
    );
    expect(nextFixes).not.toContain('Lifecycle bridge missing');
  });

  it('keeps execution safety bad when live contentions still exist', () => {
    const recentSince = NOW - 3_600_000;
    const payload = buildColonyHealthPayload(
      fakeStorage({
        calls: Array.from({ length: 12 }, (_, index) =>
          call(
            index + 1,
            'codex-old-session',
            'mcp__colony__task_claim_file',
            SINCE + 1_000 + index,
          ),
        ),
        claimBeforeEdit: badClaimBeforeEditStats(),
        claimBeforeEditStatsBySince: (since) =>
          since >= recentSince ? cleanClaimBeforeEditStats() : badClaimBeforeEditStats(),
        tasks: [
          { id: 1, repo_root: '/repo', branch: 'agent/codex/left' },
          { id: 2, repo_root: '/repo', branch: 'agent/claude/right' },
          { id: 3, repo_root: '/repo', branch: 'agent/codex/stale' },
        ],
        claimsByTask: {
          1: [
            {
              task_id: 1,
              file_path: 'src/shared.ts',
              session_id: 'codex-left-session',
              claimed_at: NOW - 60_000,
            },
          ],
          2: [
            {
              task_id: 2,
              file_path: 'src/shared.ts',
              session_id: 'claude-right-session',
              claimed_at: NOW - 60_000,
            },
          ],
          3: [
            {
              task_id: 3,
              file_path: 'src/stale.ts',
              session_id: 'codex-stale-session',
              claimed_at: NOW - 90 * 60_000,
            },
          ],
        },
      }),
      {
        since: SINCE,
        window_hours: 24,
        now: NOW,
        claim_stale_minutes: 60,
        codex_sessions_root: NO_CODEX_ROOT,
        repo_root: '/repo',
        hivemind: {
          sessions: [
            hivemindSession({
              agent: 'codex',
              branch: 'agent/codex/left',
              session_key: 'codex-left-session',
              worktree_path: '/wt/codex-left',
              activity: 'working',
            }),
            hivemindSession({
              agent: 'claude',
              branch: 'agent/claude/right',
              session_key: 'claude-right-session',
              worktree_path: '/wt/claude-right',
              activity: 'working',
            }),
          ],
        },
        dirty_files_by_worktree: {
          '/wt/codex-left': ['src/shared.ts'],
          '/wt/claude-right': ['src/shared.ts'],
        },
        worktree_contention: fakeWorktreeContention(),
      },
    );

    expect(payload.live_contention_health.live_file_contentions).toBe(1);
    expect(payload.readiness_summary.execution_safety.status).toBe('bad');
    expect(payload.readiness_summary.execution_safety.root_cause).toMatchObject({
      kind: 'old_telemetry_pollution',
      summary:
        '24h claim-before-edit includes older edit telemetry; no fresh pre_tool_use_missing edits detected in the recent window.',
    });
    expect(payload.task_claim_file_before_edits.old_telemetry_pollution).toBe(true);
    const text = formatColonyHealthOutput(payload, { verbose: true });
    expect(text).toContain('1. live file contentions');
    expect(text).toContain('2. stale claims');
    expect(text).toContain('3. old claim-before-edit telemetry');
    expect(text.indexOf('1. live file contentions')).toBeLessThan(text.indexOf('2. stale claims'));
    expect(text.indexOf('2. stale claims')).toBeLessThan(
      text.indexOf('3. old claim-before-edit telemetry'),
    );
    expect(text).not.toContain('Lifecycle bridge missing');
  });

  it('builds a dry-run execution-safety recovery plan without running sweeps', () => {
    const payload = buildColonyHealthPayload(
      fakeStorage({
        calls: [call(1, 'codex-alpha-session', 'Edit', NOW - 1_000)],
        claimBeforeEdit: {
          edit_tool_calls: 1,
          edits_with_file_path: 1,
          edits_claimed_before: 0,
          claim_miss_reasons: {
            pre_tool_use_missing: 4,
            no_claim_for_file: 1,
          },
        },
        tasks: [{ id: 1, repo_root: '/repo', branch: 'main' }],
        observationsByTask: { 1: [] },
        claimsByTask: {
          1: [
            {
              task_id: 1,
              file_path: 'src/stale.ts',
              session_id: 'codex-stale',
              claimed_at: NOW - 5 * 3_600_000,
            },
          ],
        },
      }),
      {
        since: SINCE,
        window_hours: 24,
        now: NOW,
        codex_sessions_root: NO_CODEX_ROOT,
        repo_root: '/repo',
      },
    );

    const plan = buildHealthFixPlan(payload, {
      repo_root: '/repo',
      apply: false,
    });
    const text = formatHealthFixPlanOutput(plan);

    expect(plan.mode).toBe('dry-run');
    expect(plan.safety).toMatchObject({
      mutates_claims: false,
      installs_hooks: false,
      ran_coordination_sweep: false,
      ran_queen_sweep: false,
    });
    expect(plan.current).toMatchObject({
      pre_tool_use_missing: 4,
      pre_tool_use_missing_dominates: true,
      stale_claims: 1,
    });
    expect(text).toContain('mode: dry-run (no sweeps run)');
    expect(text).toContain('mutates_claims: false');
    expect(text).toContain('[suggested] Reinstall/restart lifecycle hooks');
    expect(text).toContain('colony install --ide codex  # then restart Codex/OMX');
    expect(text).toContain('[planned] Run coordination sweep');
    expect(text).toContain('[planned] Run queen sweep');
    expect(text).toContain('colony coordination sweep --repo-root /repo --json');
    expect(text).toContain('pnpm smoke:codex-omx-pretool');
    expect(plan.coordination_sweep).toBeUndefined();
    expect(plan.queen_sweep).toBeUndefined();
  });

  it('marks sweeps as run only when fix-plan apply data is present', () => {
    const payload = buildColonyHealthPayload(
      fakeStorage({
        calls: healthyWindowCalls(),
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
        repo_root: '/repo',
      },
    );

    const plan = buildHealthFixPlan(payload, {
      repo_root: '/repo with space',
      apply: true,
      coordination_sweep: {
        summary: {
          stale_claim_count: 2,
          expired_weak_claim_count: 1,
        },
        recommended_action: 'dry-run: release 1 expired/weak advisory claim',
      } as never,
      queen_sweep: [
        {
          items: [{ reason: 'stalled' }, { reason: 'unclaimed' }, { reason: 'ready-to-archive' }],
        },
      ] as never,
    });
    const text = formatHealthFixPlanOutput(plan);

    expect(plan.mode).toBe('apply');
    expect(plan.safety).toMatchObject({
      mutates_claims: false,
      installs_hooks: false,
      ran_coordination_sweep: true,
      ran_queen_sweep: true,
    });
    expect(text).toContain('mode: apply (sweeps run)');
    expect(text).toContain('mutates_claims: false');
    expect(text).toContain('[ran] Run coordination sweep');
    expect(text).toContain('mutates_claims: false');
    expect(text).toContain('stale=2, expired/weak=1');
    expect(text).toContain('[ran] Run queen sweep');
    expect(text).toContain('stalled=1, unclaimed=1, ready-to-archive=1');
    expect(text).toContain("colony queen sweep --repo-root '/repo with space' --json");
  });

  it('marks fix-plan apply as claim-mutating only with the safe stale claim flag', () => {
    const payload = buildColonyHealthPayload(
      fakeStorage({
        calls: healthyWindowCalls(),
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
        repo_root: '/repo',
      },
    );

    const plan = buildHealthFixPlan(payload, {
      repo_root: '/repo',
      apply: true,
      release_safe_stale_claims: true,
      coordination_sweep: {
        summary: {
          stale_claim_count: 1,
          expired_weak_claim_count: 1,
        },
        recommended_action: 'applied: released 1 safe stale claim; audit history retained',
      } as never,
    });
    const text = formatHealthFixPlanOutput(plan);

    expect(plan.safety.mutates_claims).toBe(true);
    expect(text).toContain('mutates_claims: true');
    expect(text).toContain('skips dirty, active-session, and downstream-blocking claims');
    expect(text).toContain('preserves audit observations');
  });

  it('shows the safe stale claim release flag in health help', () => {
    const program = createProgram();
    const health = program.commands.find((command) => command.name() === 'health');

    expect(health?.helpInformation()).toContain('--release-safe-stale-claims');
  });

  it('keeps health fix-plan apply from mutating claims by default', async () => {
    const fixture = createHealthFixPlanFixture();
    const originalColonyHome = process.env.COLONY_HOME;
    let output = '';
    try {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      process.env.COLONY_HOME = fixture.dataDir;
      await seedHealthSafeStaleClaims(fixture.repoRoot);
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        output += String(chunk);
        return true;
      });

      await createProgram().parseAsync(
        [
          'node',
          'test',
          'health',
          '--fix-plan',
          '--apply',
          '--json',
          '--repo-root',
          fixture.repoRoot,
        ],
        { from: 'node' },
      );

      const json = JSON.parse(output) as {
        safety: { mutates_claims: boolean };
        coordination_sweep: {
          summary: {
            released_stale_claim_count: number;
            downgraded_stale_claim_count: number;
          };
        };
      };

      expect(json.safety.mutates_claims).toBe(false);
      expect(json.coordination_sweep.summary).toMatchObject({
        released_stale_claim_count: 0,
        downgraded_stale_claim_count: 0,
      });
      await expectHealthFixtureClaims(fixture.repoRoot, [
        'src/expired.ts',
        'src/fresh.ts',
        'src/stale.ts',
      ]);
    } finally {
      if (originalColonyHome === undefined) delete process.env.COLONY_HOME;
      else process.env.COLONY_HOME = originalColonyHome;
      vi.useRealTimers();
      fixture.cleanup();
    }
  });

  it('passes safe stale claim cleanup when the health fix-plan opt-in flag is set', async () => {
    const fixture = createHealthFixPlanFixture();
    const originalColonyHome = process.env.COLONY_HOME;
    let output = '';
    try {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      process.env.COLONY_HOME = fixture.dataDir;
      await seedHealthSafeStaleClaims(fixture.repoRoot);
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        output += String(chunk);
        return true;
      });

      await createProgram().parseAsync(
        [
          'node',
          'test',
          'health',
          '--fix-plan',
          '--apply',
          '--release-safe-stale-claims',
          '--json',
          '--repo-root',
          fixture.repoRoot,
        ],
        { from: 'node' },
      );

      const json = JSON.parse(output) as {
        safety: { mutates_claims: boolean };
        coordination_sweep: {
          summary: {
            released_stale_claim_count: number;
            downgraded_stale_claim_count: number;
            skipped_dirty_claim_count: number;
          };
        };
      };

      expect(json.safety.mutates_claims).toBe(true);
      expect(json.coordination_sweep.summary).toMatchObject({
        released_stale_claim_count: 1,
        downgraded_stale_claim_count: 1,
        skipped_dirty_claim_count: 0,
      });
      await expectHealthFixtureClaims(fixture.repoRoot, ['src/fresh.ts']);
      await expectHealthFixtureAuditCount(fixture.repoRoot, 2);
    } finally {
      if (originalColonyHome === undefined) delete process.env.COLONY_HOME;
      else process.env.COLONY_HOME = originalColonyHome;
      vi.useRealTimers();
      fixture.cleanup();
    }
  });

  it('keeps expired claims out of stale and active health counts', () => {
    const payload = buildColonyHealthPayload(
      fakeStorage({
        calls: healthyWindowCalls(),
        claimBeforeEdit: {
          edit_tool_calls: 0,
          edits_with_file_path: 0,
          edits_claimed_before: 0,
        },
        tasks: [{ id: 1, repo_root: '/r', branch: 'b' }],
        observationsByTask: { 1: [] },
        claimsByTask: {
          1: [
            {
              task_id: 1,
              file_path: 'src/fresh.ts',
              session_id: 'fresh',
              claimed_at: NOW - 60_000,
            },
            {
              task_id: 1,
              file_path: 'src/stale.ts',
              session_id: 'stale',
              claimed_at: NOW - 5 * 3_600_000,
            },
            {
              task_id: 1,
              file_path: 'src/expired.ts',
              session_id: 'expired',
              claimed_at: NOW - 9 * 3_600_000,
            },
          ],
        },
      }),
      {
        since: SINCE,
        window_hours: 24,
        now: NOW,
        codex_sessions_root: NO_CODEX_ROOT,
      },
    );

    expect(payload.signal_health).toMatchObject({
      total_claims: 3,
      active_claims: 1,
      fresh_claims: 1,
      stale_claims: 1,
      expired_claims: 1,
      weak_claims: 2,
    });
  });

  it('reports quota-pending claims separately from ordinary stale claims', () => {
    const payload = buildColonyHealthPayload(
      fakeStorage({
        calls: healthyWindowCalls(),
        claimBeforeEdit: {
          edit_tool_calls: 0,
          edits_with_file_path: 0,
          edits_claimed_before: 0,
        },
        tasks: [{ id: 1, repo_root: '/r', branch: 'b' }],
        observationsByTask: {
          1: [
            observation(7, 'relay', NOW - 10 * 60_000, {
              kind: 'relay',
              reason: 'quota',
              status: 'pending',
              from_session_id: 'quota',
              from_agent: 'codex',
              expires_at: NOW + 5 * 60_000,
            }),
            observation(8, 'relay', NOW - 20 * 60_000, {
              kind: 'relay',
              reason: 'quota',
              status: 'pending',
              from_session_id: 'quota-old',
              from_agent: 'codex',
              expires_at: NOW - 60_000,
            }),
          ],
        },
        claimsByTask: {
          1: [
            {
              task_id: 1,
              file_path: 'src/quota.ts',
              session_id: 'quota',
              claimed_at: NOW - 60_000,
              state: 'handoff_pending',
              expires_at: NOW + 5 * 60_000,
              handoff_observation_id: 7,
            },
            {
              task_id: 1,
              file_path: 'src/quota-expired.ts',
              session_id: 'quota-old',
              claimed_at: NOW - 60_000,
              state: 'handoff_pending',
              expires_at: NOW - 60_000,
              handoff_observation_id: 8,
            },
          ],
        },
      }),
      {
        since: SINCE,
        window_hours: 24,
        now: NOW,
        codex_sessions_root: NO_CODEX_ROOT,
      },
    );

    expect(payload.signal_health).toMatchObject({
      total_claims: 2,
      active_claims: 0,
      stale_claims: 0,
      expired_claims: 0,
      weak_claims: 2,
      quota_pending_claims: 2,
      expired_quota_pending_claims: 1,
    });
    expect(payload.signal_health.quota_relay_actions.top_action).toBe('release expired');
    expect(payload.signal_health.quota_relay_examples).toEqual([
      expect.objectContaining({
        task_id: 1,
        handoff_observation_id: 8,
        old_owner: 'codex/quota-old',
        age_minutes: 20,
        files: ['src/quota-expired.ts'],
        state: 'expired',
        recommended_action: 'release expired',
        tool_call:
          'mcp__colony__task_claim_quota_release_expired({ task_id: 1, session_id: "<session_id>", handoff_observation_id: 8 })',
      }),
      expect.objectContaining({
        task_id: 1,
        handoff_observation_id: 7,
        old_owner: 'codex/quota',
        age_minutes: 10,
        files: ['src/quota.ts'],
        state: 'active',
        recommended_action: 'accept',
        tool_call:
          'mcp__colony__task_claim_quota_accept({ task_id: 1, session_id: "<session_id>", handoff_observation_id: 7 })',
        decline_tool_call:
          'mcp__colony__task_claim_quota_decline({ task_id: 1, session_id: "<session_id>", handoff_observation_id: 7, reason: "<reason>" })',
      }),
    ]);

    const text = formatColonyHealthOutput(payload);
    expect(text).not.toContain('quota pending:    2');
    expect(text).not.toContain('quota expired:    1');
    expect(text).not.toContain('quota top action: release expired task 1 relay #8');
    expect(text).toContain(
      'Top action: release expired task 1 relay #8 (1 file: src/quota-expired.ts). Release expired quota-pending claims with task_claim_quota_release_expired; this keeps audit history and removes active blockers.',
    );

    const verboseText = formatColonyHealthOutput(payload, { verbose: true });
    expect(verboseText).toContain('quota pending:    2');
    expect(verboseText).toContain('quota expired:    1');
    expect(verboseText).toContain('quota top action: release expired task 1 relay #8');
    expect(verboseText).toContain('quota relay examples:');
    expect(verboseText).toContain(
      'task_id=1 old_owner=codex/quota-old age=20m files=1 file: src/quota-expired.ts state=expired recommended_action=release expired',
    );
    expect(verboseText).toContain(
      'tool: mcp__colony__task_claim_quota_release_expired({ task_id: 1, session_id: "<session_id>", handoff_observation_id: 8 })',
    );
    expect(verboseText).toContain(
      'cmd:  colony task quota-release-expired --task-id 1 --handoff-observation-id 8 --session <session_id>',
    );
    expect(verboseText).toContain(
      'task_id=1 old_owner=codex/quota age=10m files=1 file: src/quota.ts state=active recommended_action=accept',
    );
    expect(verboseText).toContain(
      'decline/reroute: mcp__colony__task_claim_quota_decline({ task_id: 1, session_id: "<session_id>", handoff_observation_id: 7, reason: "<reason>" })',
    );
    expect(verboseText).toContain(
      'cmd:  colony task quota-accept --task-id 1 --handoff-observation-id 7 --session <session_id> --agent <agent>',
    );
  });

  it('renders no quota relay action when no quota relay exists', () => {
    const payload = buildColonyHealthPayload(
      fakeStorage({
        calls: healthyWindowCalls(),
        claimBeforeEdit: {
          edit_tool_calls: 0,
          edits_with_file_path: 0,
          edits_claimed_before: 0,
        },
        tasks: [{ id: 1, repo_root: '/r', branch: 'b' }],
        observationsByTask: { 1: [] },
        claimsByTask: { 1: [] },
      }),
      {
        since: SINCE,
        window_hours: 24,
        now: NOW,
        codex_sessions_root: NO_CODEX_ROOT,
      },
    );

    expect(payload.signal_health.quota_pending_claims).toBe(0);
    expect(payload.signal_health.quota_relay_examples).toEqual([]);
    expect(payload.signal_health.quota_relay_actions.top_action).toBe('none');
    expect(formatColonyHealthOutput(payload)).not.toContain('quota top action: none');
    expect(formatColonyHealthOutput(payload, { verbose: true })).toContain(
      'quota relay examples: none',
    );
  });

  it('keeps accepted quota relays out of actionable health hints', () => {
    const payload = buildColonyHealthPayload(
      fakeStorage({
        calls: healthyWindowCalls(),
        claimBeforeEdit: {
          edit_tool_calls: 0,
          edits_with_file_path: 0,
          edits_claimed_before: 0,
        },
        tasks: [{ id: 1, repo_root: '/r', branch: 'b' }],
        observationsByTask: {
          1: [
            observation(9, 'relay', NOW - 5 * 60_000, {
              kind: 'relay',
              reason: 'quota',
              status: 'accepted',
              from_session_id: 'quota-done',
              from_agent: 'codex',
              accepted_by_session_id: 'replacement',
              accepted_at: NOW - 60_000,
              expires_at: NOW + 5 * 60_000,
            }),
          ],
        },
        claimsByTask: {
          1: [
            {
              task_id: 1,
              file_path: 'src/accepted.ts',
              session_id: 'quota-done',
              claimed_at: NOW - 60_000,
              state: 'handoff_pending',
              expires_at: NOW + 5 * 60_000,
              handoff_observation_id: 9,
            },
          ],
        },
      }),
      {
        since: SINCE,
        window_hours: 24,
        now: NOW,
        codex_sessions_root: NO_CODEX_ROOT,
      },
    );

    expect(payload.signal_health.quota_pending_claims).toBe(1);
    expect(payload.signal_health.quota_relay_examples).toEqual([
      expect.objectContaining({
        task_id: 1,
        handoff_observation_id: 9,
        old_owner: 'codex/quota-done',
        state: 'accepted',
        recommended_action: 'none',
        tool_call: null,
      }),
    ]);
    expect(payload.signal_health.quota_relay_actions.top_action).toBe('none');
    expect(payload.action_hints.map((hint) => hint.metric)).not.toContain(
      'quota relay accept/release',
    );
    expect(formatColonyHealthOutput(payload)).not.toContain('quota top action: none');
    expect(formatColonyHealthOutput(payload, { verbose: true })).toContain(
      'task_id=1 old_owner=codex/quota-done age=5m files=1 file: src/accepted.ts state=accepted recommended_action=none',
    );
  });

  it('keeps 24h issue-window contention and quota fixes compact and actionable', () => {
    const quotaFiles = [
      '.omx/agent-worktrees/recodee__codex__add-fff-mcp-search-guidance/AGENTS.md',
      'gitguardex/.omx/agent-worktrees/gitguardex__codex__doctor/src/cli/main.js',
      'gitguardex/.omx/agent-worktrees/gitguardex__codex__doctor/test/doctor.test.js',
      'gitguardex/.omx/agent-worktrees/gitguardex__codex__doctor/test/setup.test.js',
    ];
    const payload = buildColonyHealthPayload(
      fakeStorage({
        calls: healthyWindowCalls(),
        claimBeforeEdit: {
          edit_tool_calls: 0,
          edits_with_file_path: 0,
          edits_claimed_before: 0,
        },
        tasks: [
          { id: 1, repo_root: '/repo', branch: 'dev' },
          { id: 2, repo_root: '/repo', branch: 'main' },
          { id: 3, repo_root: '/repo', branch: 'agent/codex/quota' },
        ],
        observationsByTask: {
          3: [
            observation(21615, 'handoff', NOW - 2 * 60_000, {
              kind: 'handoff',
              reason: 'quota',
              status: 'pending',
              from_session_id: 'quota-owner',
              from_agent: 'codex',
              expires_at: NOW - 60_000,
            }),
          ],
        },
        claimsByTask: {
          1: [
            {
              task_id: 1,
              file_path: 'README.md',
              session_id: '003bdaee-1891-44e1-b867-b67aabc883e5',
              claimed_at: NOW - 60_000,
            },
          ],
          2: [
            {
              task_id: 2,
              file_path: 'README.md',
              session_id: 'codex-main-session',
              claimed_at: NOW - 60_000,
            },
          ],
          3: quotaFiles.map((filePath) => ({
            task_id: 3,
            file_path: filePath,
            session_id: 'quota-owner',
            claimed_at: NOW - 2 * 60_000,
            state: 'handoff_pending' as const,
            expires_at: NOW - 60_000,
            handoff_observation_id: 21615,
          })),
        },
      }),
      {
        since: SINCE,
        window_hours: 24,
        now: NOW,
        claim_stale_minutes: 240,
        codex_sessions_root: NO_CODEX_ROOT,
        repo_root: '/repo',
      },
    );

    expect(payload.live_contention_health).toMatchObject({
      live_file_contentions: 1,
      protected_file_contentions: 1,
      dirty_contended_files: 0,
    });
    expect(payload.signal_health.quota_pending_claims).toBe(4);
    expect(payload.signal_health.quota_relay_actions.top_action).toBe('release expired');

    const text = formatColonyHealthOutput(payload);
    const glance = outputSection(text, 'At a glance');
    expect(glance).toContain('fix first: live file contentions');
    expect(glance).toContain('why: 1 conflict(s), 0 dirty; first README.md');
    expect(glance).toContain(
      'next: Resolve README.md first: require explicit takeover for owner unknown 003bdaee-18... (owner identity is unknown).',
    );
    expect(glance).toContain(
      "command: cmd: colony lane takeover 003bdaee-1891-44e1-b867-b67aabc883e5 --file README.md --reason 'owner identity is unknown'",
    );

    const nextFixes = outputSection(text, 'Next fixes');
    expect(nextFixes).toContain(
      '1. live file contentions: 1 conflict(s), 0 dirty; first README.md',
    );
    expect(nextFixes).toContain(
      'Resolve README.md first: require explicit takeover for owner unknown 003bdaee-18... (owner identity is unknown).',
    );
    expect(nextFixes).toContain(
      'tool: task_claim_file(task_id=1, session_id="<requester_session_id>", file_path="README.md", note="after explicit takeover")',
    );
    expect(text).not.toContain('quota top action: release expired task 3 handoff #21615');
    expect(text).toContain(
      'Top action: release expired task 3 handoff #21615 (4 files: .omx/agent-worktrees/recodee__c...-mcp-search-guidance/AGENTS.md, gitguardex/.omx/agent-worktrees..._codex__doctor/src/cli/main.js, +2 more). Release expired quota-pending claims with task_claim_quota_release_expired',
    );
    expect(text).not.toContain(
      'gitguardex/.omx/agent-worktrees/gitguardex__codex__doctor/src/cli/main.js',
    );
    expect(text).not.toContain('test/doctor.test.js, gitguardex');

    const verboseText = formatColonyHealthOutput(payload, { verbose: true });
    expect(verboseText).toContain(
      'quota top action: release expired task 3 handoff #21615 (4 files: .omx/agent-worktrees/recodee__codex__add-fff-mcp-search-guidance/AGENTS.md, gitguardex/.omx/agent-worktrees/gitguardex__codex__doctor/src/cli/main.js, gitguardex/.omx/agent-worktrees/gitguardex__codex__doctor/test/doctor.test.js, gitguardex/.omx/agent-worktrees/gitguardex__codex__doctor/test/setup.test.js)',
    );
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
        codex_sessions_root: NO_CODEX_ROOT,
      },
    );

    const json = JSON.parse(formatColonyHealthOutput(payload, { json: true }));

    expect(json).toHaveProperty('readiness_summary');
    expect(json.readiness_summary).toHaveProperty('coordination_readiness');
    expect(json.readiness_summary).toHaveProperty('execution_safety');
    expect(json.readiness_summary).toHaveProperty('queen_plan_readiness');
    expect(json.readiness_summary).toHaveProperty('working_state_migration');
    expect(json.readiness_summary).toHaveProperty('signal_evaporation');
    expect(json).toHaveProperty('colony_mcp_share');
    expect(json).toHaveProperty('conversions');
    expect(json).toHaveProperty('task_list_vs_task_ready_for_agent');
    expect(json).toHaveProperty('task_post_vs_task_message');
    expect(json).toHaveProperty('task_post_vs_omx_notepad');
    expect(json).toHaveProperty('search_calls_per_session');
    expect(json).toHaveProperty('task_claim_file_before_edits');
    expect(json.task_claim_file_before_edits).toHaveProperty('claim_miss_reasons');
    expect(json.task_claim_file_before_edits).toHaveProperty('nearest_claim_examples');
    expect(json.task_claim_file_before_edits).toHaveProperty('root_cause');
    expect(json).toHaveProperty('signal_health');
    expect(json).toHaveProperty('proposal_health');
    expect(json).toHaveProperty('ready_to_claim_vs_claimed');
    expect(json).toHaveProperty('queen_wave_health');
    expect(json).toHaveProperty('live_contention_health');
    expect(json.live_contention_health).toHaveProperty('recommended_actions');
    expect(json).toHaveProperty('adoption_thresholds');
    expect(json).toHaveProperty('action_hints');
    expect(json.action_hints[0]).toHaveProperty('tool_call');
    expect(json.action_hints[0]).toHaveProperty('prompt');
  });

  it('reports live same-file contentions with owners, branches, dirty files, and takeover signals', () => {
    const payload = buildColonyHealthPayload(
      fakeStorage({
        calls: healthyWindowCalls(),
        claimBeforeEdit: {
          edit_tool_calls: 2,
          edits_with_file_path: 2,
          edits_claimed_before: 2,
        },
        tasks: [
          { id: 10, repo_root: '/repo', branch: 'agent/codex/left' },
          { id: 11, repo_root: '/repo', branch: 'agent/claude/right' },
          { id: 12, repo_root: '/repo', branch: 'main' },
        ],
        claimsByTask: {
          10: [
            {
              task_id: 10,
              file_path: 'src/shared.ts',
              session_id: 'codex-left-session',
              claimed_at: NOW - 60_000,
            },
          ],
          11: [
            {
              task_id: 11,
              file_path: 'src/shared.ts',
              session_id: 'claude-right-session',
              claimed_at: NOW - 90_000,
            },
          ],
          12: [
            {
              task_id: 12,
              file_path: 'src/shared.ts',
              session_id: 'codex-main-session',
              claimed_at: NOW - 30_000,
            },
          ],
        },
        observationsByTask: {
          10: [
            observation(100, 'handoff', NOW - 10_000, {
              kind: 'handoff',
              status: 'pending',
              summary: 'Session hit usage limit; takeover requested.',
              expires_at: NOW + 60_000,
            }),
          ],
          11: [],
          12: [],
        },
        proposals: [],
        reinforcements: {},
      }),
      {
        since: SINCE,
        window_hours: 24,
        now: NOW,
        claim_stale_minutes: 60,
        codex_sessions_root: NO_CODEX_ROOT,
        hivemind: {
          sessions: [
            hivemindSession({
              agent: 'codex',
              branch: 'agent/codex/left',
              session_key: 'codex-left-session',
              worktree_path: '/wt/codex-left',
              activity: 'working',
            }),
            hivemindSession({
              agent: 'codex',
              branch: 'agent/codex/left',
              session_key: 'codex-left-other',
              worktree_path: '/wt/codex-left-other',
              activity: 'idle',
            }),
            hivemindSession({
              agent: 'claude',
              branch: 'agent/claude/right',
              session_key: 'claude-right-session',
              worktree_path: '/wt/claude-right',
              activity: 'stalled',
            }),
            hivemindSession({
              agent: 'codex',
              branch: 'main',
              session_key: 'codex-main-session',
              worktree_path: '/repo',
              activity: 'working',
            }),
          ],
        },
        dirty_files_by_worktree: {
          '/wt/codex-left': ['src/shared.ts'],
          '/wt/codex-left-other': [],
          '/wt/claude-right': ['src/other.ts'],
          '/repo': [],
        },
        worktree_contention: fakeWorktreeContention(),
      },
    );

    expect(payload.live_contention_health).toMatchObject({
      live_file_contentions: 1,
      protected_file_contentions: 1,
      paused_lanes: 2,
      takeover_requests: 1,
      competing_worktrees: 2,
      dirty_contended_files: 1,
      top_conflicts: [
        {
          file_path: 'src/shared.ts',
          owner_count: 3,
          protected: true,
          dirty_worktrees: ['/wt/codex-left'],
          owners: expect.arrayContaining([
            expect.objectContaining({
              owner: 'codex',
              session_id: 'codex-left-session',
              branch: 'agent/codex/left',
              dirty: true,
              classification: 'active known owner',
            }),
            expect.objectContaining({
              owner: 'claude',
              session_id: 'claude-right-session',
              branch: 'agent/claude/right',
              classification: 'inactive known owner',
            }),
            expect.objectContaining({
              owner: 'codex',
              session_id: 'codex-main-session',
              branch: 'main',
              classification: 'active known owner',
            }),
          ]),
        },
      ],
      recommended_actions: expect.arrayContaining([
        expect.objectContaining({
          file_path: 'src/shared.ts',
          action: 'keep owner codex-left-session',
          classification: 'active known owner',
        }),
        expect.objectContaining({
          file_path: 'src/shared.ts',
          action: 'release/weaken owner claude-right-session',
          classification: 'inactive known owner',
          command: expect.stringContaining('colony lane takeover claude-right-session'),
          mcp_tool_hint: expect.stringContaining('task_hand_off'),
        }),
        expect.objectContaining({
          file_path: 'src/shared.ts',
          action: 'require explicit takeover',
          reason: 'multiple active owners claim this file',
          command: expect.stringContaining('colony lane takeover codex-left-session'),
        }),
      ]),
    });

    expect(payload.readiness_summary.execution_safety).toMatchObject({
      status: 'bad',
      evidence: expect.stringContaining('live contentions 1, dirty 1'),
    });
    expect(payload.action_hints[0]).toMatchObject({
      metric: 'live file contentions',
      current: '1 conflict(s), 1 dirty; first src/shared.ts',
      command:
        "colony lane takeover claude-right-session --file src/shared.ts --reason 'protected contention resolution'",
    });
    expect(payload.live_contention_health.protected_claim_action_queue).toMatchObject({
      protected_claims: 1,
      takeover_actions: 2,
      release_or_weaken_actions: 1,
      keep_owner_actions: 2,
      commands: expect.arrayContaining([
        "colony lane takeover claude-right-session --file src/shared.ts --reason 'protected contention resolution'",
      ]),
    });
    expect(payload.action_hints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metric: 'paused dirty lanes',
          current: '2 paused lane(s), 1 dirty contended file(s)',
          action:
            'paused lanes with dirty files should be finished, handed off, or cleaned before broad verification.',
        }),
      ]),
    );

    const text = formatColonyHealthOutput(payload, { verbose: true });
    expect(text).toContain('Live contention health');
    expect(text).toContain('live_file_contentions:      1');
    expect(text).toContain('protected_file_contentions: 1');
    expect(text).toContain('paused_lanes:               2');
    expect(text).toContain('takeover_requests:          1');
    expect(text).toContain('competing_worktrees:        2');
    expect(text).toContain('dirty_contended_files:      1');
    expect(text).toContain('src/shared.ts (3 owners; protected, dirty)');
    expect(text).toContain(
      'owner=codex session=codex-left-... branch=agent/codex/left activity=working class=active known owner',
    );
    expect(text).toContain(
      'owner=claude session=claude-righ... branch=agent/claude/right activity=stalled class=inactive known owner',
    );
    expect(text).toContain(
      'owner=codex session=codex-main-... branch=main activity=working class=active known owner',
    );
    expect(text).toContain('recommended actions:');
    expect(text).toContain('src/shared.ts: release/weaken owner claude-right-session');
    expect(text).toContain('command: colony lane takeover claude-right-session');
    expect(text).toContain('tool: owner can call task_hand_off');
    expect(text).toContain(
      'paused lanes with dirty files should be finished, handed off, or cleaned before broad verification.',
    );
  });

  it('classifies known active and unknown protected contention owners', () => {
    const payload = buildColonyHealthPayload(
      fakeStorage({
        calls: healthyWindowCalls(),
        claimBeforeEdit: {
          edit_tool_calls: 1,
          edits_with_file_path: 1,
          edits_claimed_before: 1,
        },
        tasks: [
          { id: 20, repo_root: '/repo', branch: 'main' },
          { id: 21, repo_root: '/repo', branch: 'agent/unknown/duplicate' },
        ],
        claimsByTask: {
          20: [
            {
              task_id: 20,
              file_path: 'src/protected.ts',
              session_id: 'codex-main-session',
              claimed_at: NOW - 30_000,
            },
          ],
          21: [
            {
              task_id: 21,
              file_path: 'src/protected.ts',
              session_id: 'mystery-session',
              claimed_at: NOW - 20_000,
            },
          ],
        },
        observationsByTask: { 20: [], 21: [] },
        proposals: [],
        reinforcements: {},
      }),
      {
        since: SINCE,
        window_hours: 24,
        now: NOW,
        claim_stale_minutes: 60,
        codex_sessions_root: NO_CODEX_ROOT,
        hivemind: {
          sessions: [
            hivemindSession({
              agent: 'codex',
              branch: 'main',
              session_key: 'codex-main-session',
              worktree_path: '/repo',
              activity: 'working',
            }),
          ],
        },
        dirty_files_by_worktree: { '/repo': [] },
      },
    );

    expect(payload.live_contention_health.top_conflicts[0]?.owners).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          session_id: 'codex-main-session',
          classification: 'active known owner',
        }),
        expect.objectContaining({
          session_id: 'mystery-session',
          classification: 'unknown owner',
        }),
      ]),
    );
    expect(payload.live_contention_health.recommended_actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'keep owner codex-main-session',
          classification: 'active known owner',
        }),
        expect.objectContaining({
          action: 'require explicit takeover',
          session_id: 'mystery-session',
          classification: 'unknown owner',
          command: expect.stringContaining('colony lane takeover mystery-session'),
        }),
      ]),
    );
  });

  it('recommends release or weaken for inactive protected contention owners', () => {
    const payload = buildColonyHealthPayload(
      fakeStorage({
        calls: healthyWindowCalls(),
        claimBeforeEdit: {
          edit_tool_calls: 1,
          edits_with_file_path: 1,
          edits_claimed_before: 1,
        },
        tasks: [
          { id: 30, repo_root: '/repo', branch: 'main' },
          { id: 31, repo_root: '/repo', branch: 'agent/codex/stale' },
        ],
        claimsByTask: {
          30: [
            {
              task_id: 30,
              file_path: 'src/inactive.ts',
              session_id: 'codex-main-session',
              claimed_at: NOW - 30_000,
            },
          ],
          31: [
            {
              task_id: 31,
              file_path: 'src/inactive.ts',
              session_id: 'codex@inactive',
              claimed_at: NOW - 10 * 60_000,
            },
          ],
        },
        observationsByTask: { 30: [], 31: [] },
        proposals: [],
        reinforcements: {},
      }),
      {
        since: SINCE,
        window_hours: 24,
        now: NOW,
        claim_stale_minutes: 60,
        codex_sessions_root: NO_CODEX_ROOT,
        hivemind: {
          sessions: [
            hivemindSession({
              agent: 'codex',
              branch: 'main',
              session_key: 'codex-main-session',
              worktree_path: '/repo',
              activity: 'working',
            }),
          ],
        },
        dirty_files_by_worktree: { '/repo': [] },
      },
    );

    expect(payload.live_contention_health.recommended_actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'release/weaken owner codex@inactive',
          classification: 'inactive known owner',
          command: expect.stringContaining('colony lane takeover'),
          mcp_tool_hint: expect.stringContaining('released_files'),
        }),
      ]),
    );
  });

  it('requires explicit takeover when protected active owners compete', () => {
    const payload = buildColonyHealthPayload(
      fakeStorage({
        calls: healthyWindowCalls(),
        claimBeforeEdit: {
          edit_tool_calls: 1,
          edits_with_file_path: 1,
          edits_claimed_before: 1,
        },
        tasks: [
          { id: 40, repo_root: '/repo', branch: 'main' },
          { id: 41, repo_root: '/repo', branch: 'agent/codex/feature' },
        ],
        claimsByTask: {
          40: [
            {
              task_id: 40,
              file_path: 'src/active.ts',
              session_id: 'codex-main-session',
              claimed_at: NOW - 30_000,
            },
          ],
          41: [
            {
              task_id: 41,
              file_path: 'src/active.ts',
              session_id: 'claude-feature-session',
              claimed_at: NOW - 20_000,
            },
          ],
        },
        observationsByTask: { 40: [], 41: [] },
        proposals: [],
        reinforcements: {},
      }),
      {
        since: SINCE,
        window_hours: 24,
        now: NOW,
        claim_stale_minutes: 60,
        codex_sessions_root: NO_CODEX_ROOT,
        hivemind: {
          sessions: [
            hivemindSession({
              agent: 'codex',
              branch: 'main',
              session_key: 'codex-main-session',
              worktree_path: '/repo',
              activity: 'working',
            }),
            hivemindSession({
              agent: 'claude',
              branch: 'agent/codex/feature',
              session_key: 'claude-feature-session',
              worktree_path: '/wt/feature',
              activity: 'working',
            }),
          ],
        },
        dirty_files_by_worktree: { '/repo': [], '/wt/feature': [] },
      },
    );

    expect(payload.live_contention_health.recommended_actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'require explicit takeover',
          session_id: 'codex-main-session',
          reason: 'multiple active owners claim this file',
        }),
        expect.objectContaining({
          action: 'require explicit takeover',
          session_id: 'claude-feature-session',
          reason: 'multiple active owners claim this file',
        }),
      ]),
    );
  });

  it('keeps recommended actions stable when protected contentions have no dirty files', () => {
    const payload = buildColonyHealthPayload(
      fakeStorage({
        calls: healthyWindowCalls(),
        claimBeforeEdit: {
          edit_tool_calls: 1,
          edits_with_file_path: 1,
          edits_claimed_before: 1,
        },
        tasks: [
          { id: 50, repo_root: '/repo', branch: 'main' },
          { id: 51, repo_root: '/repo', branch: 'agent/codex/clean' },
        ],
        claimsByTask: {
          50: [
            {
              task_id: 50,
              file_path: 'src/clean.ts',
              session_id: 'codex-main-session',
              claimed_at: NOW - 30_000,
            },
          ],
          51: [
            {
              task_id: 51,
              file_path: 'src/clean.ts',
              session_id: 'codex-clean-session',
              claimed_at: NOW - 20_000,
            },
          ],
        },
        observationsByTask: { 50: [], 51: [] },
        proposals: [],
        reinforcements: {},
      }),
      {
        since: SINCE,
        window_hours: 24,
        now: NOW,
        claim_stale_minutes: 60,
        codex_sessions_root: NO_CODEX_ROOT,
        hivemind: {
          sessions: [
            hivemindSession({
              agent: 'codex',
              branch: 'main',
              session_key: 'codex-main-session',
              worktree_path: '/repo',
              activity: 'working',
            }),
            hivemindSession({
              agent: 'codex',
              branch: 'agent/codex/clean',
              session_key: 'codex-clean-session',
              worktree_path: '/wt/clean',
              activity: 'idle',
            }),
          ],
        },
        dirty_files_by_worktree: { '/repo': [], '/wt/clean': [] },
        worktree_contention: {
          generated_at: new Date(NOW).toISOString(),
          repo_root: '/repo',
          summary: {
            worktree_count: 2,
            dirty_worktree_count: 0,
            dirty_file_count: 0,
            contention_count: 0,
          },
          inspected_roots: [],
          worktrees: [],
          contentions: [],
        } as never,
      },
    );

    expect(payload.live_contention_health).toMatchObject({
      live_file_contentions: 1,
      protected_file_contentions: 1,
      dirty_contended_files: 0,
    });
    expect(payload.live_contention_health.recommended_actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'keep owner codex-main-session' }),
        expect.objectContaining({
          action: 'require explicit takeover',
          reason: 'multiple active owners claim this file',
        }),
      ]),
    );
  });

  it('renders claim miss reasons and nearest claim examples in text and JSON output', () => {
    const payload = buildColonyHealthPayload(
      fakeStorage({
        calls: healthyWindowCalls(),
        claimBeforeEdit: {
          edit_tool_calls: 9,
          edits_with_file_path: 9,
          edits_claimed_before: 0,
          claim_miss_reasons: {
            no_claim_for_file: 1,
            claim_after_edit: 1,
            session_id_mismatch: 1,
            repo_root_mismatch: 1,
            branch_mismatch: 1,
            path_mismatch: 1,
            worktree_path_mismatch: 1,
            pseudo_path_skipped: 1,
            pre_tool_use_missing: 1,
          },
          nearest_claim_examples: [
            nearestClaimExample({
              reason: 'session_id_mismatch',
              edit_id: 31,
              edit_session_id: 'edit-session',
              edit_file_path: 'src/session.ts',
              nearest_claim_id: 30,
              claim_session_id: 'claim-session',
              claim_file_path: 'src/session.ts',
              distance_ms: 1_000,
            }),
          ],
        },
      }),
      {
        since: SINCE,
        window_hours: 24,
        now: NOW,
        codex_sessions_root: NO_CODEX_ROOT,
      },
    );

    expect(payload.task_claim_file_before_edits.claim_miss_reasons).toMatchObject({
      no_claim_for_file: 1,
      claim_after_edit: 1,
      session_id_mismatch: 1,
      repo_root_mismatch: 1,
      branch_mismatch: 1,
      path_mismatch: 1,
      worktree_path_mismatch: 1,
      pseudo_path_skipped: 1,
      pre_tool_use_missing: 1,
    });
    expect(payload.task_claim_file_before_edits.nearest_claim_examples).toContainEqual(
      expect.objectContaining({
        reason: 'session_id_mismatch',
        edit_file_path: 'src/session.ts',
        claim_file_path: 'src/session.ts',
      }),
    );

    const text = formatColonyHealthOutput(payload, { verbose: true });
    expect(text).toContain('why claims did not match edits:');
    expect(text).toContain('session_id_mismatch: 1');
    expect(text).toContain('worktree_path_mismatch: 1');
    expect(text).toContain('nearest claim examples:');
    expect(text).toContain(
      'session_id_mismatch: edit#31 src/session.ts by edit-session; claim#30 src/session.ts by claim-session 1000ms away',
    );

    const json = JSON.parse(formatColonyHealthOutput(payload, { json: true }));
    expect(json.task_claim_file_before_edits.claim_miss_reasons).toMatchObject({
      path_mismatch: 1,
      pre_tool_use_missing: 1,
    });
    expect(json.task_claim_file_before_edits.nearest_claim_examples[0]).toMatchObject({
      reason: 'session_id_mismatch',
      nearest_claim_id: 30,
    });
  });

  it('reports stale claimed subtasks that block later Queen waves', () => {
    const payload = buildColonyHealthPayload(
      fakeStorage({
        calls: [],
        claimBeforeEdit: {
          edit_tool_calls: 0,
          edits_with_file_path: 0,
          edits_claimed_before: 0,
        },
        tasks: [
          { id: 9, repo_root: '/r', branch: 'spec/waves', status: 'open' },
          { id: 10, repo_root: '/r', branch: 'spec/waves/sub-0' },
          { id: 11, repo_root: '/r', branch: 'spec/waves/sub-1' },
          { id: 12, repo_root: '/r', branch: 'spec/waves/sub-2' },
          { id: 14, repo_root: '/r', branch: 'spec/done', status: 'open' },
          { id: 13, repo_root: '/r', branch: 'spec/done/sub-0' },
        ],
        observationsByTask: {
          10: [
            observation(10, 'plan-subtask-claim', NOW - 3 * 3_600_000, {
              status: 'claimed',
              session_id: 'stale-session',
              agent: 'codex',
            }),
            observation(11, 'plan-subtask', NOW - 4 * 3_600_000, {
              status: 'available',
              depends_on: [],
              file_scope: ['src/foundation.ts'],
            }),
            observation(16, 'relay', NOW - 30_000, {
              kind: 'relay',
              reason: 'quota',
              status: 'pending',
              expires_at: NOW + 15 * 60_000,
            }),
            observation(17, 'handoff', NOW - 2 * 3_600_000, {
              kind: 'handoff',
              status: 'pending',
              from_agent: 'codex',
              quota_exhausted: true,
              summary: 'Codex quota exhausted',
              expires_at: NOW + 60_000,
            }),
          ],
          11: [
            observation(12, 'plan-subtask', NOW - 3_000, {
              status: 'available',
              depends_on: [0],
              file_scope: ['src/downstream-a.ts'],
            }),
          ],
          12: [
            observation(13, 'plan-subtask', NOW - 3_000, {
              status: 'available',
              depends_on: [0],
              file_scope: ['src/downstream-b.ts'],
            }),
          ],
          13: [
            observation(14, 'plan-subtask-claim', NOW - 2_000, {
              status: 'completed',
            }),
            observation(15, 'plan-subtask', NOW - 3_000, {
              status: 'available',
              depends_on: [],
            }),
          ],
        },
        claimsByTask: {
          10: [
            { task_id: 10, file_path: 'src/a.ts', session_id: 'stale-session', claimed_at: NOW },
          ],
        },
        sessionsById: {
          'stale-session': { id: 'stale-session', ide: 'codex', cwd: '/r' },
        },
        proposals: [],
        reinforcements: {},
      }),
      {
        since: SINCE,
        window_hours: 24,
        now: NOW,
        claim_stale_minutes: 60,
        codex_sessions_root: NO_CODEX_ROOT,
      },
    );

    expect(payload.queen_wave_health).toMatchObject({
      active_plans: 1,
      current_wave: 'Wave 1',
      ready_subtasks: 0,
      claimed_subtasks: 1,
      blocked_subtasks: 2,
      stale_claims_blocking_downstream: 1,
      quota_handoffs_blocking_downstream: 1,
      replacement_recommendation: {
        recommended_replacement_agent: 'claude-code',
        reason: 'Codex recently hit quota on this branch',
        next_tool: 'task_accept_handoff',
      },
      plans: [
        {
          plan_slug: 'waves',
          current_wave: 'Wave 1',
          ready_subtasks: 0,
          claimed_subtasks: 1,
          blocked_subtasks: 2,
          stale_claims_blocking_downstream: 1,
          quota_handoffs_blocking_downstream: 1,
          downstream_blockers: [
            expect.objectContaining({
              task_id: 10,
              subtask_index: 0,
              file_path: 'src/foundation.ts',
              owner_session_id: 'stale-session',
              owner_agent: 'codex',
              age_minutes: 180,
              unlock_candidate: expect.objectContaining({
                task_id: 11,
                subtask_index: 1,
              }),
            }),
          ],
          replacement_recommendation: {
            recommended_replacement_agent: 'claude-code',
            reason: 'Codex recently hit quota on this branch',
          },
        },
      ],
      downstream_blockers: [
        expect.objectContaining({
          task_id: 10,
          file_path: 'src/foundation.ts',
          owner_session_id: 'stale-session',
          unlock_candidate: expect.objectContaining({ subtask_index: 1 }),
        }),
      ],
    });
    expect(payload.action_hints).toContainEqual(
      expect.objectContaining({
        metric: 'stale claims blocking downstream',
        current: '1',
        target: '0',
      }),
    );

    const text = formatColonyHealthOutput(payload, { verbose: true });
    expect(text).toContain('stale claims blocking downstream:   1');
    expect(text).toContain('quota handoffs blocking downstream: 1');
    expect(text).toContain(
      'waves: current Wave 1; ready 0, claimed 1, blocked 2, stale blockers 1, quota blockers 1',
    );
    expect(text).toContain('stale downstream blockers:');
    expect(text).toContain(
      'waves/sub-0 task #10 src/foundation.ts owner=stale-session age=180m -> unlock candidate sub-1',
    );
    expect(text).toContain(
      'recommended replacement:           claude-code (Codex recently hit quota on this branch; next task_accept_handoff)',
    );
    expect(text).toContain('replacement: claude-code - Codex recently hit quota on this branch');
  });

  it('colors adoption threshold status labels by severity', () => {
    const payload = buildColonyHealthPayload(
      fakeStorage({
        calls: healthyWindowCalls(),
        claimBeforeEdit: {
          edit_tool_calls: 2,
          edits_with_file_path: 2,
          edits_claimed_before: 1,
        },
      }),
      { since: SINCE, window_hours: 24, now: NOW, codex_sessions_root: NO_CODEX_ROOT },
    );

    kleur.enabled = true;
    try {
      const text = formatColonyHealthOutput(payload, { verbose: true });
      expect(text).toContain(kleur.green('good'.padEnd(15)));
      expect(text).toContain(kleur.yellow('ok'.padEnd(15)));
      expect(text).toContain(kleur.red('bad'.padEnd(15)));
    } finally {
      kleur.enabled = false;
    }
  });

  it('flags notepad and missing inbox or ready queue adoption gaps', () => {
    const payload = buildColonyHealthPayload(
      fakeStorage({
        calls: [
          call(1, 'codex-alpha-session', 'mcp__colony__hivemind_context', NOW - 90_000),
          call(2, 'codex-alpha-session', 'mcp__colony__task_list', NOW - 89_000),
          call(3, 'codex-alpha-session', 'mcp__omx_memory__notepad_write_working', NOW - 88_000),
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

    expect(payload.adoption_thresholds.bad).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'notepad_write_working > task_post/task_note_working',
          status: 'bad',
          value: 1,
        }),
        expect.objectContaining({ name: 'attention_inbox = 0', status: 'bad', value: 0 }),
        expect.objectContaining({ name: 'task_ready_for_agent = 0', status: 'bad', value: 0 }),
      ]),
    );
  });

  it('builds concrete next-fix actions with targets for bad health thresholds', () => {
    const payload = buildColonyHealthPayload(
      fakeStorage({
        calls: [
          call(1, 'session-a', 'mcp__colony__hivemind_context', NOW - 90_000),
          call(2, 'session-a', 'mcp__colony__task_list', NOW - 89_000),
          call(3, 'session-a', 'mcp__colony__task_ready_for_agent', NOW - 88_000),
          call(4, 'session-a', 'mcp__omx_memory__notepad_write_working', NOW - 87_000),
          call(5, 'session-b', 'mcp__colony__task_list', NOW - 86_000),
          call(6, 'session-c', 'mcp__colony__task_list', NOW - 85_000),
          call(7, 'session-d', 'mcp__colony__task_list', NOW - 84_000),
        ],
        claimBeforeEdit: {
          edit_tool_calls: 2,
          edits_with_file_path: 2,
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

    expect(payload.action_hints).toEqual([
      expect.objectContaining({
        metric: 'hivemind_context -> attention_inbox',
        current: '0%',
        target: '50%+',
        action: expect.stringContaining('call attention_inbox'),
        tool_call: expect.stringContaining('mcp__colony__attention_inbox'),
        prompt: expect.stringContaining('attention_inbox'),
      }),
      expect.objectContaining({
        metric: 'task_list -> task_ready_for_agent',
        current: '25%',
        target: '30%+',
        action: expect.stringContaining('call task_ready_for_agent'),
        tool_call: expect.stringContaining('mcp__colony__task_ready_for_agent'),
        prompt: expect.stringContaining('task_ready_for_agent'),
      }),
      // task_ready_for_agent -> claim hint is suppressed here: the fixture
      // has a task_ready_for_agent call with no follow-up
      // task_plan_claim_subtask call, but a `plan-subtask-claim` observation
      // with status='claimed' on sub-2 — the auto_claim signature. The new
      // gate in healthActionHints prevents the false-positive hint when the
      // server's auto_claim is doing the claiming silently.
      expect.objectContaining({
        metric: 'claim-before-edit',
        current: '0%',
        target: '50%+',
        // Action wording branches on whether PreToolUse telemetry exists; both
        // branches reference task_claim_file, but the missing-hook branch
        // recommends reinstalling the hook before relying on agent discipline.
        action: expect.stringContaining('PreToolUse auto-claim hook is not firing'),
        tool_call: expect.stringContaining('mcp__colony__task_claim_file'),
        command: expect.stringContaining('colony install --ide <ide>'),
        prompt: expect.stringContaining('Goal: restore pre-edit auto-claim'),
      }),
      expect.objectContaining({
        metric: 'stale claims',
        current: '1',
        target: '0',
        action: expect.stringContaining('dry stale-claim sweep'),
        tool_call: expect.stringContaining('mcp__colony__rescue_stranded_scan'),
        command: 'colony coordination sweep --json',
        prompt: expect.stringContaining('colony coordination sweep --json'),
      }),
      expect.objectContaining({
        metric: 'task_post/task_note_working share',
        current: '0%',
        target: '70%+',
        action: expect.stringContaining('task_note_working first'),
        tool_call: expect.stringContaining('mcp__colony__task_note_working'),
        prompt: expect.stringContaining('branch/task/blocker/next/evidence'),
      }),
    ]);

    const text = formatColonyHealthOutput(payload);
    const nextFixesStart = text.indexOf('Next fixes');
    const adoptionStart = text.indexOf('\nAdoption thresholds', nextFixesStart);
    const nextFixes = text.slice(nextFixesStart, adoptionStart);
    expect(text).toContain('Next fixes');
    expect(nextFixes.indexOf('claim-before-edit: 0%')).toBeLessThan(
      nextFixes.indexOf('stale claims: 1'),
    );
    expect(nextFixes.indexOf('stale claims: 1')).toBeLessThan(
      nextFixes.indexOf('task_post/task_note_working share: 0%'),
    );
    expect(text).not.toContain('hivemind_context -> attention_inbox: 0%');
    expect(text).not.toContain('task_list -> task_ready_for_agent: 25%');
    expect(text).not.toContain('task_ready_for_agent -> claim: 0%');
    expect(text).toContain(
      'claim-before-edit: 0% (target 50%+) - PreToolUse auto-claim hook is not firing',
    );
    expect(text).toContain(
      'tool: mcp__colony__task_claim_file({ task_id: <task_id>, session_id: "<session_id>", file_path: "<file>", note: "pre-edit claim" })',
    );
    expect(text).toContain('cmd:  colony install --ide <ide>');
    expect(text).toContain('stale claims: 1 (target 0) - Run a dry stale-claim sweep');
    expect(text).toContain('cmd:  colony coordination sweep --json');
    expect(text).toContain(
      'task_post/task_note_working share: 0% (target 70%+) - Use task_note_working first',
    );
    expect(text).toContain('tool: mcp__colony__task_note_working');

    const promptText = formatColonyHealthOutput(payload, { prompts: true });
    expect(promptText).toContain('Codex prompt snippets');
    expect(promptText).toContain('Inspect: colony coordination sweep --json');
    expect(promptText).toContain('Accept: working notes use branch/task/blocker/next/evidence');

    const verboseText = formatColonyHealthOutput(payload, { verbose: true });
    expect(verboseText).toContain(
      'hivemind_context -> attention_inbox: 0% (target 50%+) - After hivemind_context, call attention_inbox',
    );
    expect(verboseText).toContain(
      'task_list -> task_ready_for_agent: 25% (target 30%+) - Keep task_list for browsing/debugging only',
    );
  });

  it('renders actionable Codex prompts for the current failing adoption metrics', () => {
    const payload = buildColonyHealthPayload(
      fakeStorage({
        calls: [
          call(1, 'session-a', 'mcp__colony__task_ready_for_agent', NOW - 90_000),
          call(2, 'session-a', 'mcp__colony__task_post', NOW - 89_000),
        ],
        claimBeforeEdit: {
          edit_tool_calls: 1,
          edits_with_file_path: 1,
          edits_claimed_before: 0,
        },
        tasks: [],
        observationsByTask: {},
        claimsByTask: {},
        proposals: [],
        reinforcements: {},
      }),
      {
        since: SINCE,
        window_hours: 24,
        now: NOW,
        codex_sessions_root: NO_CODEX_ROOT,
      },
    );

    const prompts = formatColonyHealthOutput(payload, { prompts: true });
    expect(prompts).toContain('Codex prompt snippets');

    for (const metric of [
      'task_ready_for_agent -> claim',
      'task_message adoption',
      'claim-before-edit',
      'Queen plan activation',
      'proposal adoption',
    ]) {
      expect(payload.action_hints.map((hint) => hint.metric)).toContain(metric);
    }

    expect(prompts).toContain('Goal: restore pre-edit auto-claim for hook-capable edits');
    expect(prompts).toContain('Current: claim-before-edit 0%, missing 1');
    expect(prompts).toContain('Inspect: mcp__colony__task_claim_file');
    expect(prompts).toContain(
      'Accept: claim-before-edit reaches target and agents still manually call task_claim_file until hooks are proven',
    );

    expect(prompts).toContain('Goal: activate Queen planning for multi-agent work');
    expect(prompts).toContain('Current: active Queen plans 0, plan subtasks 0');
    expect(prompts).toContain('Inspect: mcp__colony__queen_plan_goal');
    expect(prompts).toContain(
      'Accept: a plan exists with claimable subtasks and task_ready_for_agent returns exact claim args',
    );

    expect(prompts).not.toContain('Goal: convert ready work into an owned plan subtask');
    expect(prompts).not.toContain(
      'Goal: move agent-to-agent coordination from task_post notes to task_message',
    );
    expect(prompts).not.toContain(
      'Goal: make future-work candidates flow through proposals instead of chat-only notes',
    );

    const verbosePrompts = formatColonyHealthOutput(payload, { prompts: true, verbose: true });
    expect(verbosePrompts).toContain('Goal: convert ready work into an owned plan subtask');
    expect(verbosePrompts).toContain(
      'Goal: move agent-to-agent coordination from task_post notes to task_message',
    );
    expect(verbosePrompts).toContain(
      'Goal: make future-work candidates flow through proposals instead of chat-only notes',
    );
  });

  it('surfaces top recorded tools and a hook-wiring hint when no mcp__ calls land in the window', () => {
    const payload = buildColonyHealthPayload(
      fakeStorage({
        calls: [
          call(1, 'codex-alpha-session', 'Bash', NOW - 90_000),
          call(2, 'codex-alpha-session', 'Bash', NOW - 89_000),
          call(3, 'codex-alpha-session', 'Read', NOW - 88_000),
          call(4, 'codex-alpha-session', 'Edit', NOW - 87_000),
          call(5, 'codex-alpha-session', 'Bash', NOW - 86_000),
        ],
        claimBeforeEdit: {
          edit_tool_calls: 1,
          edits_with_file_path: 0,
          edits_claimed_before: 0,
        },
      }),
      { since: SINCE, window_hours: 24, now: NOW, codex_sessions_root: NO_CODEX_ROOT },
    );

    expect(payload.colony_mcp_share).toMatchObject({
      total_tool_calls: 5,
      mcp_tool_calls: 0,
      colony_mcp_tool_calls: 0,
    });
    expect(payload.colony_mcp_share.top_tools).toEqual([
      { tool: 'Bash', calls: 3 },
      { tool: 'Edit', calls: 1 },
      { tool: 'Read', calls: 1 },
    ]);

    const text = formatColonyHealthOutput(payload, { verbose: true });
    expect(text).toContain('no mcp__ tool calls in window');
    expect(text).toContain('top recorded tools: Bash (3), Edit (1), Read (1)');
  });

  it('diagnoses missing session binding separately from a missing PreToolUse hook', () => {
    const payload = buildColonyHealthPayload(
      fakeStorage({
        calls: [call(1, 'codex-alpha-session', 'Edit', NOW - 1_000)],
        claimBeforeEdit: {
          edit_tool_calls: 1,
          edits_with_file_path: 1,
          edits_claimed_before: 0,
          pre_tool_use_signals: 1,
          session_binding_missing: 1,
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
      likely_missing_hook: false,
      pre_tool_use_signals: 1,
      session_binding_missing: 1,
      install_hint: expect.stringContaining('session binding is missing'),
    });
    const claimHint = payload.action_hints.find((hint) => hint.metric === 'claim-before-edit');
    expect(claimHint).toMatchObject({
      action: expect.stringContaining('session binding is missing'),
      prompt: expect.stringContaining(
        'Goal: bind PreToolUse telemetry to the active Colony session',
      ),
    });
    expect(claimHint?.action).not.toContain('hook is not firing');

    const text = formatColonyHealthOutput(payload, { verbose: true });
    expect(text).toContain('session binding missing: 1');
    expect(text).not.toContain('PreToolUse auto-claim hook is not firing');
  });

  it('omits the zero-mcp diagnostic when the window is genuinely empty', () => {
    const payload = buildColonyHealthPayload(
      fakeStorage({
        calls: [],
        claimBeforeEdit: {
          edit_tool_calls: 0,
          edits_with_file_path: 0,
          edits_claimed_before: 0,
        },
      }),
      { since: SINCE, window_hours: 24, now: NOW, codex_sessions_root: NO_CODEX_ROOT },
    );

    expect(payload.colony_mcp_share.top_tools).toEqual([]);
    const text = formatColonyHealthOutput(payload, { verbose: true });
    expect(text).not.toContain('no mcp__ tool calls in window');
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
        codex_sessions_root: NO_CODEX_ROOT,
      },
    );

    expect(payload.task_claim_file_before_edits).toMatchObject({
      status: 'not_available',
      edit_tool_calls: 1,
      edits_with_file_path: 0,
      claim_before_edit_ratio: null,
    });
    expect(formatColonyHealthOutput(payload, { verbose: true })).toContain('not available');
    expect(payload.task_post_vs_omx_notepad.status).toBe('unavailable');
  });

  it('merges Codex rollout mcp_tool_call_end events into the share view', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'colony-health-codex-'));
    try {
      // NOW = 1_800_000_000_000 → 2027-01-15T08:00:00Z. Window is the prior 24h.
      const dir = path.join(tmpRoot, '2027', '01', '15');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(
        dir,
        'rollout-2027-01-15T07-00-00-019dd000-1111-2222-3333-444455556666.jsonl',
      );
      fs.writeFileSync(
        file,
        [
          codexRolloutLine(NOW - 60 * 60_000, 'colony', 'hivemind_context'),
          codexRolloutLine(NOW - 50 * 60_000, 'colony', 'hivemind_context'),
          codexRolloutLine(NOW - 40 * 60_000, 'colony', 'task_post'),
          codexRolloutLine(NOW - 30 * 60_000, 'omx_state', 'state_get_status'),
        ].join('\n'),
      );
      // Pin the mtime inside the synthetic window so the reader's
      // mtime-predates-window short-circuit doesn't skip the fixture.
      const insideWindow = new Date(NOW - 30 * 60_000);
      fs.utimesSync(file, insideWindow, insideWindow);

      const payload = buildColonyHealthPayload(
        fakeStorage({
          calls: [
            call(1, 'claude-session', 'Bash', NOW - 90_000),
            call(2, 'claude-session', 'Edit', NOW - 80_000),
          ],
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
          codex_sessions_root: tmpRoot,
        },
      );

      expect(payload.colony_mcp_share).toMatchObject({
        total_tool_calls: 6,
        mcp_tool_calls: 4,
        colony_mcp_tool_calls: 3,
        source_breakdown: { colony_observations: 2, codex_rollouts: 4 },
      });
      expect(payload.task_post_vs_task_message.task_post_calls).toBe(1);

      const text = formatColonyHealthOutput(payload, { verbose: true });
      expect(text).toContain('all tools: 3 / 6');
      expect(text).toContain('MCP tools: 3 / 4');
      expect(text).toContain('sources:   colony obs 2, codex rollouts 4');
      expect(text).not.toContain('no mcp__ tool calls in window');
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('reports Codex rollout edits separately from hook-capable claim-before-edit metrics', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'colony-health-codex-edits-'));
    try {
      const dir = path.join(tmpRoot, '2027', '01', '15');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(
        dir,
        'rollout-2027-01-15T07-00-00-019dd000-1111-2222-3333-444455556666.jsonl',
      );
      fs.writeFileSync(
        file,
        [
          codexFunctionCallLine(NOW - 60 * 60_000, 'Edit'),
          codexFunctionCallLine(NOW - 50 * 60_000, 'Write'),
        ].join('\n'),
      );
      const insideWindow = new Date(NOW - 30 * 60_000);
      fs.utimesSync(file, insideWindow, insideWindow);

      const payload = buildColonyHealthPayload(
        fakeStorage({
          calls: [],
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
          codex_sessions_root: tmpRoot,
        },
      );

      expect(payload.task_claim_file_before_edits).toMatchObject({
        status: 'no_data',
        claim_before_edit_ratio: null,
        likely_missing_hook: false,
        codex_rollout_without_bridge: true,
        edit_source_breakdown: {
          colony_post_tool_edits: 0,
          codex_rollout_edits: 2,
          hook_capable_edits: 0,
          pre_tool_use_signals: 0,
        },
      });

      const hint = payload.action_hints.find((entry) => entry.metric === 'claim-before-edit');
      expect(hint).toMatchObject({
        current: '2 Codex rollout edits, 0 PreToolUse signals',
        target: 'Codex PreToolUse signals > 0',
        command: 'colony install --ide codex  # then restart Codex',
        action: expect.stringContaining('Codex rollouts'),
      });
      expect(hint?.action).not.toContain('Run colony install --ide <ide>');

      const text = formatColonyHealthOutput(payload, { verbose: true });
      expect(text).toContain(
        'edit source breakdown: colony_post_tool_edits=0, codex_rollout_edits=2, hook_capable_edits=0, pre_tool_use_signals=0',
      );
      expect(text).toContain(
        'diagnosis: Codex rollout edits are present, but no Codex PreToolUse hook or rollout bridge signal is firing.',
      );
      expect(text).toContain('cmd:  colony install --ide codex');
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('shows OMX runtime bridge summary ingestion status', () => {
    const payload = buildColonyHealthPayload(
      fakeStorage({
        calls: healthyWindowCalls(),
        claimBeforeEdit: {
          edit_tool_calls: 0,
          edits_with_file_path: 0,
          edits_claimed_before: 0,
        },
        omxRuntimeStats: {
          status: 'available',
          summaries_ingested: 2,
          latest_summary_ts: NOW - 5 * 60_000,
          warning_count: 3,
        },
      }),
      { since: SINCE, window_hours: 24, now: NOW, codex_sessions_root: NO_CODEX_ROOT },
    );

    expect(payload.omx_runtime_bridge).toMatchObject({
      status: 'available',
      summaries_ingested: 2,
      latest_summary_age_ms: 5 * 60_000,
      warning_count: 3,
    });
    const text = formatColonyHealthOutput(payload, { verbose: true });
    expect(text).toContain('OMX runtime bridge');
    expect(text).toContain('summaries ingested:  2');
    expect(text).toContain('latest summary age:  5m');
  });

  it('shows OMX runtime bridge unavailable when no local summary exists', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'colony-health-omx-empty-repo-'));
    const globalSummaryDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'colony-health-omx-empty-global-'),
    );
    try {
      const payload = buildColonyHealthPayload(
        fakeStorage({
          calls: healthyWindowCalls(),
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
          repo_root: repoRoot,
          omx_runtime_summary_global_dir: globalSummaryDir,
        },
      );

      expect(payload.omx_runtime_bridge).toMatchObject({
        status: 'unavailable',
        summaries_ingested: 0,
        latest_summary_age_ms: null,
        warning_count: 0,
      });
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
      fs.rmSync(globalSummaryDir, { recursive: true, force: true });
    }
  });

  it('shows OMX runtime bridge available when a fresh v1 summary exists', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'colony-health-omx-fresh-'));
    const stateDir = path.join(repoRoot, '.omx', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'colony-runtime-summary.json'),
      JSON.stringify({
        schema: 'colony-runtime-summary-v1',
        session_id: 'codex@fresh',
        agent: 'codex',
        repo_root: repoRoot,
        timestamp: new Date(NOW - 60_000).toISOString(),
        active_sessions: ['codex@fresh'],
        recent_edit_paths: ['apps/cli/src/commands/health.ts'],
        quota_warning: 'quota near',
      }),
    );
    try {
      const payload = buildColonyHealthPayload(
        fakeStorage({
          calls: healthyWindowCalls(),
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
          repo_root: repoRoot,
          omx_runtime_summary_global_dir: null,
        },
      );

      expect(payload.omx_runtime_bridge).toMatchObject({
        status: 'available',
        summaries_ingested: 1,
        latest_summary_age_ms: 60_000,
        warning_count: 1,
        active_sessions: 1,
        recent_edit_paths: ['apps/cli/src/commands/health.ts'],
      });
      const text = formatColonyHealthOutput(payload, { verbose: true });
      expect(text).toContain('status:              available');
      expect(text).toContain('active sessions:     1');
      expect(text).toContain('recent edit paths:   apps/cli/src/commands/health.ts');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('joins fresh OMX runtime lifecycle events into claim-before-edit health', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'colony-health-omx-joined-'));
    const stateDir = path.join(repoRoot, '.omx', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'colony-runtime-summary.json'),
      JSON.stringify({
        schema: 'colony-runtime-summary-v1',
        session_id: 'codex@joined',
        agent: 'codex',
        repo_root: repoRoot,
        timestamp: new Date(NOW).toISOString(),
        active_sessions: ['codex@joined'],
        recent_edit_paths: ['apps/cli/src/commands/health.ts'],
        lifecycle_events: [
          {
            event_id: 'evt_joined_pre',
            event_type: 'pre_tool_use',
            timestamp: new Date(NOW - 200).toISOString(),
            extracted_paths: ['apps/cli/src/commands/health.ts'],
          },
          {
            event_id: 'evt_joined_post',
            parent_event_id: 'evt_joined_pre',
            event_type: 'post_tool_use',
            timestamp: new Date(NOW - 100).toISOString(),
            extracted_paths: ['apps/cli/src/commands/health.ts'],
          },
        ],
      }),
    );
    try {
      const payload = buildColonyHealthPayload(
        fakeStorage({
          calls: healthyWindowCalls(),
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
          repo_root: repoRoot,
          omx_runtime_summary_global_dir: null,
        },
      );

      expect(payload.omx_runtime_bridge).toMatchObject({
        status: 'available',
        latest_summary_age_ms: 0,
        recent_edit_paths: ['apps/cli/src/commands/health.ts'],
        claim_before_edit: {
          hook_capable_edits: 1,
          pre_tool_use_signals: 1,
          measurable_edits: 1,
          edits_claimed_before: 1,
        },
      });
      expect(payload.task_claim_file_before_edits).toMatchObject({
        status: 'available',
        hook_capable_edits: 1,
        pre_tool_use_signals: 1,
        measurable_edits: 1,
        edits_with_claim: 1,
        edits_missing_claim: 0,
        claim_before_edit_ratio: 1,
        root_cause: null,
      });
      const nextFixText = payload.action_hints.map((hint) => hint.current).join('\n');
      expect(nextFixText).not.toContain('Lifecycle bridge missing');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('diagnoses fresh runtime edit paths that are not joined into claim-before-edit stats', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'colony-health-omx-not-joined-'));
    const stateDir = path.join(repoRoot, '.omx', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'colony-runtime-summary.json'),
      JSON.stringify({
        schema: 'colony-runtime-summary-v1',
        session_id: 'codex@not-joined',
        agent: 'codex',
        repo_root: repoRoot,
        timestamp: new Date(NOW).toISOString(),
        active_sessions: ['codex@not-joined'],
        recent_edit_paths: ['apps/cli/src/commands/health.ts'],
      }),
    );
    try {
      const payload = buildColonyHealthPayload(
        fakeStorage({
          calls: healthyWindowCalls(),
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
          repo_root: repoRoot,
          omx_runtime_summary_global_dir: null,
        },
      );

      expect(payload.omx_runtime_bridge).toMatchObject({
        status: 'available',
        latest_summary_age_ms: 0,
        recent_edit_paths: ['apps/cli/src/commands/health.ts'],
        claim_before_edit: {
          hook_capable_edits: 0,
          pre_tool_use_signals: 0,
        },
      });
      expect(payload.task_claim_file_before_edits).toMatchObject({
        hook_capable_edits: 0,
        pre_tool_use_signals: 0,
        measurable_edits: 0,
        root_cause: {
          kind: 'lifecycle_summary_not_joined',
          summary:
            'Runtime bridge is fresh and sees edit paths, but claim-before-edit telemetry is not joined into health stats.',
        },
      });
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('does not mark the OMX runtime bridge stale when fresh runtime activity updated the summary file', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'colony-health-omx-fresh-mtime-'));
    const stateDir = path.join(repoRoot, '.omx', 'state');
    const summaryPath = path.join(stateDir, 'colony-runtime-summary.json');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      summaryPath,
      JSON.stringify({
        schema: 'colony-runtime-summary-v1',
        session_id: 'codex@fresh-mtime',
        agent: 'codex',
        repo_root: repoRoot,
        timestamp: new Date(NOW - 30 * 60_000).toISOString(),
        recent_edit_paths: ['apps/cli/src/commands/health.ts'],
      }),
    );
    fs.utimesSync(summaryPath, new Date(NOW - 1_000), new Date(NOW - 1_000));
    try {
      const payload = buildColonyHealthPayload(
        fakeStorage({
          calls: healthyWindowCalls(),
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
          repo_root: repoRoot,
          omx_runtime_summary_global_dir: null,
          omx_runtime_summary_stale_ms: 15 * 60_000,
        },
      );

      expect(payload.omx_runtime_bridge).toMatchObject({
        status: 'available',
        summaries_ingested: 1,
        latest_summary_age_ms: 1_000,
        recent_edit_paths: ['apps/cli/src/commands/health.ts'],
      });
      expect(payload.action_hints).not.toContainEqual(
        expect.objectContaining({ metric: 'OMX runtime bridge' }),
      );
      expect(formatColonyHealthOutput(payload, { verbose: true })).toContain(
        'status:              available',
      );
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('shows OMX runtime bridge stale when the latest v1 summary is old', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'colony-health-omx-stale-'));
    const stateDir = path.join(repoRoot, '.omx', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'colony-runtime-summary.json'),
      JSON.stringify({
        schema: 'colony-runtime-summary-v1',
        session_id: 'codex@stale',
        repo_root: repoRoot,
        timestamp: new Date(NOW - 30 * 60_000).toISOString(),
      }),
    );
    try {
      const payload = buildColonyHealthPayload(
        fakeStorage({
          calls: healthyWindowCalls(),
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
          repo_root: repoRoot,
          omx_runtime_summary_global_dir: null,
          omx_runtime_summary_stale_ms: 15 * 60_000,
        },
      );

      expect(payload.omx_runtime_bridge).toMatchObject({
        status: 'stale',
        summaries_ingested: 1,
        latest_summary_age_ms: 30 * 60_000,
      });
      const text = formatColonyHealthOutput(payload, { verbose: true });
      const glance = outputSection(text, 'At a glance');
      expect(text).toContain('status:              stale');
      expect(glance).toContain('fix first: OMX runtime bridge');
      expect(glance).toContain('why: stale');
      expect(glance).toContain(
        'next: Metric unreliable: refresh the OMX runtime summary bridge so health sees current sessions, edit paths, and quota exits before judging claim failures.',
      );
      expect(glance).toContain(
        'command: cmd: colony bridge runtime-summary --json --repo-root <repo_root> < .omx/state/colony-runtime-summary.json',
      );
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('shows malformed OMX runtime bridge summaries as warnings', () => {
    withRuntimeSummaryHealth(
      (repoRoot) => ({
        schema: 'wrong-schema',
        session_id: 'codex@bad',
        repo_root: repoRoot,
        last_seen_at: new Date(NOW - 60_000).toISOString(),
      }),
      ({ payload, summaryPath }) => {
        expect(payload.omx_runtime_bridge).toMatchObject({
          status: 'unavailable',
          summaries_ingested: 0,
          warning_count: 1,
          malformed_summary_count: 1,
          malformed_summary_errors: [
            `${summaryPath}: expected schema colony-runtime-summary-v1, got wrong-schema`,
          ],
        });
        expect(payload.omx_runtime_bridge.malformed_summary_examples[0]).toMatchObject({
          path: summaryPath,
          error: `${summaryPath}: expected schema colony-runtime-summary-v1, got wrong-schema`,
          schema_value: 'wrong-schema',
          missing_required_fields: [],
          invalid_field_types: [],
          modified_time: expect.any(String),
          modified_time_ms: expect.any(Number),
        });
        const text = formatColonyHealthOutput(payload, { verbose: true });
        expect(text).toContain('malformed summaries: 1');
        expect(text).toContain(`${summaryPath} (modified`);
        expect(text).toContain('schema: wrong-schema');
        expect(text).toContain('missing required fields: none');
      },
    );
  });

  it('explains invalid JSON in OMX runtime bridge summaries', () => {
    withRuntimeSummaryHealth('{ "schema": ', ({ payload, summaryPath }) => {
      expect(payload.omx_runtime_bridge).toMatchObject({
        status: 'unavailable',
        summaries_ingested: 0,
        warning_count: 1,
        malformed_summary_count: 1,
      });
      expect(payload.omx_runtime_bridge.malformed_summary_errors[0]).toContain(
        `${summaryPath}: invalid JSON:`,
      );
      expect(payload.omx_runtime_bridge.malformed_summary_examples[0]).toMatchObject({
        path: summaryPath,
        schema_value: null,
        missing_required_fields: [],
        invalid_field_types: [],
        modified_time: expect.any(String),
        modified_time_ms: expect.any(Number),
      });
      expect(formatColonyHealthOutput(payload, { verbose: true })).toContain(
        `${summaryPath}: invalid JSON:`,
      );
    });
  });

  it('explains missing schema in OMX runtime bridge summaries', () => {
    withRuntimeSummaryHealth(
      (repoRoot) => ({
        version: 1,
        runtime: 'omx',
        session_id: 'codex@missing-schema',
        repo_root: repoRoot,
        last_seen_at: new Date(NOW - 60_000).toISOString(),
      }),
      ({ payload, summaryPath }) => {
        expect(payload.omx_runtime_bridge.malformed_summary_examples[0]).toMatchObject({
          path: summaryPath,
          error: `${summaryPath}: missing required fields: schema`,
          schema_value: 1,
          missing_required_fields: ['schema'],
          invalid_field_types: [],
        });
        expect(payload.omx_runtime_bridge.malformed_summary_errors).toEqual([
          `${summaryPath}: missing required fields: schema`,
        ]);
        expect(formatColonyHealthOutput(payload, { verbose: true })).toContain(
          'missing required fields: schema',
        );
      },
    );
  });

  it('explains missing session_id in OMX runtime bridge summaries', () => {
    withRuntimeSummaryHealth(
      (repoRoot) => ({
        schema: 'colony-runtime-summary-v1',
        repo_root: repoRoot,
        last_seen_at: new Date(NOW - 60_000).toISOString(),
      }),
      ({ payload, summaryPath }) => {
        expect(payload.omx_runtime_bridge.malformed_summary_examples[0]).toMatchObject({
          path: summaryPath,
          error: `${summaryPath}: missing required fields: session_id`,
          schema_value: 'colony-runtime-summary-v1',
          missing_required_fields: ['session_id'],
          invalid_field_types: [],
        });
      },
    );
  });

  it('explains missing repo_root in OMX runtime bridge summaries', () => {
    withRuntimeSummaryHealth(
      () => ({
        schema: 'colony-runtime-summary-v1',
        session_id: 'codex@missing-repo-root',
        last_seen_at: new Date(NOW - 60_000).toISOString(),
      }),
      ({ payload, summaryPath }) => {
        expect(payload.omx_runtime_bridge.malformed_summary_examples[0]).toMatchObject({
          path: summaryPath,
          error: `${summaryPath}: missing required fields: repo_root`,
          schema_value: 'colony-runtime-summary-v1',
          missing_required_fields: ['repo_root'],
          invalid_field_types: [],
        });
      },
    );
  });

  it('explains invalid last_seen_at in OMX runtime bridge summaries', () => {
    withRuntimeSummaryHealth(
      (repoRoot) => ({
        schema: 'colony-runtime-summary-v1',
        session_id: 'codex@bad-last-seen',
        repo_root: repoRoot,
        last_seen_at: 'not-a-date',
      }),
      ({ payload, summaryPath }) => {
        expect(payload.omx_runtime_bridge.malformed_summary_examples[0]).toMatchObject({
          path: summaryPath,
          error: `${summaryPath}: invalid field types: last_seen_at expected valid ISO timestamp string or epoch milliseconds got string`,
          schema_value: 'colony-runtime-summary-v1',
          missing_required_fields: [],
          invalid_field_types: [
            {
              field: 'last_seen_at',
              expected: 'valid ISO timestamp string or epoch milliseconds',
              actual: 'string',
            },
          ],
        });
        expect(formatColonyHealthOutput(payload, { verbose: true })).toContain(
          'invalid field types: last_seen_at expected valid ISO timestamp string or epoch milliseconds got string',
        );
      },
    );
  });

  it('merges PreToolUse signals from a repo-local store so health reflects per-cwd hook writes', () => {
    const taskClaimCalls = Array.from({ length: 12 }, (_, index) =>
      call(index + 1, 'codex-merged-session', 'mcp__colony__task_claim_file', NOW - 60_000 + index),
    );
    const primary = fakeStorage({
      calls: taskClaimCalls,
      claimBeforeEdit: emptyClaimBeforeEditStats(),
    });
    const repoStore = fakeStorage({
      calls: [],
      claimBeforeEdit: cleanClaimBeforeEditStats(),
    });
    const repoStorePath = '/repo/.omx/colony-home/data.db';

    const payload = buildColonyHealthPayload(primary, {
      since: SINCE,
      window_hours: 24,
      now: NOW,
      codex_sessions_root: NO_CODEX_ROOT,
      merge_storages: [repoStore],
      merged_repo_stores: [repoStorePath],
    });

    expect(payload.colony_mcp_share.source_breakdown).toMatchObject({
      merged_repo_stores: [repoStorePath],
    });
    expect(payload.task_claim_file_before_edits).toMatchObject({
      edit_tool_calls: 5,
      edits_with_file_path: 5,
      edits_claimed_before: 5,
      pre_tool_use_signals: 5,
      claim_before_edit_ratio: 1,
    });
    expect(payload.task_claim_file_before_edits.root_cause?.kind).not.toBe(
      'lifecycle_bridge_unavailable',
    );
  });
});

function outputSection(output: string, heading: string): string {
  const start = output.indexOf(heading);
  if (start === -1) return '';
  const rest = output.slice(start);
  const nextHeading = rest.slice(heading.length).search(/\n[A-Z][^\n]+\n/);
  return nextHeading === -1 ? rest : rest.slice(0, heading.length + nextHeading);
}

function withRuntimeSummaryHealth(
  content: string | ((repoRoot: string) => Record<string, unknown>),
  assertPayload: (args: {
    payload: ReturnType<typeof buildColonyHealthPayload>;
    repoRoot: string;
    summaryPath: string;
  }) => void,
): void {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'colony-health-omx-malformed-'));
  const stateDir = path.join(repoRoot, '.omx', 'state');
  const summaryPath = path.join(stateDir, 'colony-runtime-summary.json');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    summaryPath,
    typeof content === 'string' ? content : JSON.stringify(content(repoRoot)),
  );
  try {
    const payload = buildColonyHealthPayload(
      fakeStorage({
        calls: healthyWindowCalls(),
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
        repo_root: repoRoot,
        omx_runtime_summary_global_dir: null,
      },
    );

    assertPayload({ payload, repoRoot, summaryPath });
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
}

function codexRolloutLine(tsMs: number, server: string, tool: string): string {
  return JSON.stringify({
    timestamp: new Date(tsMs).toISOString(),
    type: 'event_msg',
    payload: {
      type: 'mcp_tool_call_end',
      call_id: `call_${tool}`,
      invocation: { server, tool, arguments: {} },
    },
  });
}

function codexFunctionCallLine(tsMs: number, name: string): string {
  return JSON.stringify({
    timestamp: new Date(tsMs).toISOString(),
    type: 'event_msg',
    payload: {
      type: 'function_call',
      name,
      arguments: '{}',
      call_id: `call_${name}`,
    },
  });
}

function hivemindSession(args: {
  agent: string;
  branch: string;
  session_key: string;
  worktree_path: string;
  activity: 'working' | 'thinking' | 'idle' | 'stalled' | 'dead' | 'unknown';
}): never {
  return {
    repo_root: '/repo',
    source: 'active-session',
    branch: args.branch,
    task: 'task',
    task_name: 'task',
    latest_task_preview: 'task',
    agent: args.agent,
    cli: args.agent,
    state: args.activity === 'working' || args.activity === 'idle' ? args.activity : '',
    activity: args.activity,
    activity_summary: args.activity,
    worktree_path: args.worktree_path,
    pid: null,
    pid_alive: null,
    started_at: new Date(NOW - 60_000).toISOString(),
    last_heartbeat_at: new Date(NOW - 1_000).toISOString(),
    updated_at: new Date(NOW - 1_000).toISOString(),
    elapsed_seconds: 60,
    task_mode: '',
    openspec_tier: '',
    routing_reason: '',
    snapshot_name: '',
    project_name: '',
    session_key: args.session_key,
    locked_file_count: 0,
    locked_file_preview: [],
    file_path: '',
  } as never;
}

function fakeWorktreeContention(contentionCount = 1): never {
  return {
    generated_at: new Date(NOW).toISOString(),
    repo_root: '/repo',
    summary: {
      worktree_count: 2,
      dirty_worktree_count: 2,
      dirty_file_count: 2,
      contention_count: contentionCount,
    },
    inspected_roots: [],
    worktrees: [],
    contentions: [
      {
        file_path: 'src/shared.ts',
        worktrees: [
          {
            branch: 'agent/codex/left',
            path: '/wt/codex-left',
            managed_root: '.omx/agent-worktrees',
            dirty_status: ' M',
            claimed: true,
            active_session_key: 'codex-left-session',
          },
          {
            branch: 'agent/claude/right',
            path: '/wt/claude-right',
            managed_root: '.omx/agent-worktrees',
            dirty_status: ' M',
            claimed: true,
            active_session_key: 'claude-right-session',
          },
        ],
      },
    ],
  } as never;
}

function createHealthFixPlanFixture(): {
  dataDir: string;
  repoRoot: string;
  cleanup: () => void;
} {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'colony-health-fix-plan-data-'));
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'colony-health-fix-plan-repo-'));
  return {
    dataDir,
    repoRoot,
    cleanup: () => {
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(repoRoot, { recursive: true, force: true });
    },
  };
}

async function seedHealthSafeStaleClaims(repoRoot: string): Promise<void> {
  const settings = loadSettings();
  await withStore(settings, (store) => {
    vi.setSystemTime(NOW - 720 * 60_000);
    store.startSession({ id: 'codex@stale', ide: 'codex', cwd: repoRoot });
    const thread = TaskThread.open(store, {
      repo_root: repoRoot,
      branch: 'main',
      title: 'health safe stale claims',
      session_id: 'codex@stale',
    });
    thread.join('codex@stale', 'codex');
    thread.claimFile({ session_id: 'codex@stale', file_path: 'src/expired.ts' });

    vi.setSystemTime(NOW - 300 * 60_000);
    thread.claimFile({ session_id: 'codex@stale', file_path: 'src/stale.ts' });

    vi.setSystemTime(NOW - 10 * 60_000);
    thread.claimFile({ session_id: 'codex@stale', file_path: 'src/fresh.ts' });

    vi.setSystemTime(NOW);
  });
}

async function expectHealthFixtureClaims(repoRoot: string, expected: string[]): Promise<void> {
  const settings = loadSettings();
  await withStore(settings, (store) => {
    const taskId = healthFixtureTaskId(store, repoRoot);
    expect(
      store.storage
        .listClaims(taskId)
        .map((claim) => claim.file_path)
        .sort(),
    ).toEqual([...expected].sort());
  });
}

async function expectHealthFixtureAuditCount(repoRoot: string, expected: number): Promise<void> {
  const settings = loadSettings();
  await withStore(settings, (store) => {
    const taskId = healthFixtureTaskId(store, repoRoot);
    expect(store.storage.taskObservationsByKind(taskId, 'coordination-sweep')).toHaveLength(
      expected,
    );
  });
}

function healthFixtureTaskId(store: MemoryStore, repoRoot: string): number {
  const task = store.storage
    .listTasks(100)
    .find((candidate) => candidate.repo_root === repoRoot && candidate.branch === 'main');
  if (!task) throw new Error(`missing health fixture task for ${repoRoot}`);
  return task.id;
}

function fakeStorage(args: {
  calls: TestToolCall[];
  claimBeforeEdit: {
    edit_tool_calls: number;
    edits_with_file_path: number;
    edits_claimed_before: number;
    claim_match_window_ms?: number;
    claim_match_sources?: Partial<ClaimMatchSources>;
    claim_miss_reasons?: Partial<ClaimMissReasons>;
    nearest_claim_examples?: NearestClaimExample[];
    auto_claimed_before_edit?: number;
    session_binding_missing?: number;
    pre_tool_use_signals?: number;
  };
  claimBeforeEditStatsBySince?: (since: number) => ClaimBeforeEditStats;
  tasks?: TestTask[];
  observationsByTask?: Record<number, TestObservation[]>;
  claimsByTask?: Record<
    number,
    Array<{
      task_id: number;
      file_path: string;
      session_id: string;
      claimed_at: number;
      state?: 'active' | 'handoff_pending' | 'weak_expired';
      expires_at?: number | null;
      handoff_observation_id?: number | null;
    }>
  >;
  sessionsById?: Record<string, { id: string; ide: string; cwd: string | null }>;
  proposals?: TestProposal[];
  reinforcements?: Record<number, TestReinforcement[]>;
  omxRuntimeStats?: OmxRuntimeSummaryStats;
}): never {
  const tasks = args.tasks ?? healthyTasks();
  const observationsByTask = args.observationsByTask ?? healthyObservationsByTask();
  const claimsByTask = args.claimsByTask ?? healthyClaimsByTask();
  const sessionsById = args.sessionsById ?? {};
  const proposals = args.proposals ?? healthyProposals();
  const reinforcements = args.reinforcements ?? healthyReinforcements();
  return {
    toolCallsSince: () => args.calls,
    claimBeforeEditStats: (since: number) =>
      args.claimBeforeEditStatsBySince?.(since) ?? args.claimBeforeEdit,
    omxRuntimeSummaryStats: () =>
      args.omxRuntimeStats ?? {
        status: 'unavailable',
        summaries_ingested: 0,
        latest_summary_ts: null,
        warning_count: 0,
      },
    listTasks: () => tasks,
    getSession: (id: string) =>
      sessionsById[id]
        ? {
            ...sessionsById[id],
            started_at: NOW - 3_600_000,
            ended_at: null,
            metadata: null,
          }
        : undefined,
    listClaims: (taskId: number) => claimsByTask[taskId] ?? [],
    listParticipants: (taskId: number) => {
      const task = tasks.find((candidate) => candidate.id === taskId);
      const isPlanRoot = task?.branch.startsWith('spec/') && !task.branch.includes('/sub-');
      return isPlanRoot
        ? [{ task_id: taskId, session_id: 'queen-session', agent: 'queen', joined_at: NOW - 90_000 }]
        : [];
    },
    taskTimeline: (taskId: number) => observationsByTask[taskId] ?? [],
    taskObservationsByKind: (taskId: number, kind: string) =>
      (observationsByTask[taskId] ?? []).filter((row) => row.kind === kind),
    listProposalsForBranch: (repoRoot: string, branch: string) =>
      proposals.filter((proposal) => proposal.repo_root === repoRoot && proposal.branch === branch),
    listReinforcements: (proposalId: number) => reinforcements[proposalId] ?? [],
  } as never;
}

function seedOldClaimSchemaDatabase(dbPath: string): void {
  const storage = new Storage(dbPath);
  try {
    storage.createSession({
      id: 'old-owner',
      ide: 'codex',
      cwd: '/repo',
      started_at: NOW - 60_000,
      metadata: null,
    });
    const task = storage.findOrCreateTask({
      title: 'old task',
      repo_root: '/repo',
      branch: 'main',
      created_by: 'old-owner',
    });
    storage.claimFile({
      task_id: task.id,
      file_path: 'src/claimed.ts',
      session_id: 'old-owner',
    });
  } finally {
    storage.close();
  }

  rewriteTaskClaimsAsOldSchema(dbPath);
}

function rewriteTaskClaimsAsOldSchema(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      ALTER TABLE task_claims RENAME TO task_claims_new;
      CREATE TABLE task_claims (
        task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        claimed_at INTEGER NOT NULL,
        PRIMARY KEY (task_id, file_path)
      );
      INSERT INTO task_claims(task_id, file_path, session_id, claimed_at)
        SELECT task_id, file_path, session_id, claimed_at FROM task_claims_new;
      DROP TABLE task_claims_new;
      CREATE INDEX IF NOT EXISTS idx_task_claims_session ON task_claims(session_id);
    `);
  } finally {
    db.close();
  }
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

function badClaimBeforeEditStats(): ClaimBeforeEditStats {
  return {
    edit_tool_calls: 12,
    edits_with_file_path: 12,
    edits_claimed_before: 0,
    claim_miss_reasons: {
      pre_tool_use_missing: 12,
      no_claim_for_file: 0,
    },
    pre_tool_use_signals: 0,
  };
}

function cleanClaimBeforeEditStats(): ClaimBeforeEditStats {
  return {
    edit_tool_calls: 5,
    edits_with_file_path: 5,
    edits_claimed_before: 5,
    claim_miss_reasons: {
      pre_tool_use_missing: 0,
      no_claim_for_file: 0,
    },
    pre_tool_use_signals: 5,
  };
}

function emptyClaimBeforeEditStats(): ClaimBeforeEditStats {
  return {
    edit_tool_calls: 0,
    edits_with_file_path: 0,
    edits_claimed_before: 0,
    claim_miss_reasons: {
      pre_tool_use_missing: 0,
      no_claim_for_file: 0,
    },
    pre_tool_use_signals: 0,
  };
}

function nearestClaimExample(
  overrides: Partial<NearestClaimExample> & Pick<NearestClaimExample, 'reason'>,
): NearestClaimExample {
  return {
    reason: overrides.reason,
    edit_id: overrides.edit_id ?? 1,
    edit_session_id: overrides.edit_session_id ?? 'edit-session',
    edit_file_path: overrides.edit_file_path ?? 'src/edit.ts',
    edit_repo_root: overrides.edit_repo_root ?? null,
    edit_branch: overrides.edit_branch ?? null,
    edit_worktree_path: overrides.edit_worktree_path ?? null,
    edit_ts: overrides.edit_ts ?? NOW - 1_000,
    nearest_claim_id: overrides.nearest_claim_id ?? null,
    claim_session_id: overrides.claim_session_id ?? null,
    claim_file_path: overrides.claim_file_path ?? null,
    claim_repo_root: overrides.claim_repo_root ?? null,
    claim_branch: overrides.claim_branch ?? null,
    claim_worktree_path: overrides.claim_worktree_path ?? null,
    claim_ts: overrides.claim_ts ?? null,
    distance_ms: overrides.distance_ms ?? null,
    relation: overrides.relation ?? {
      same_file_path: false,
      same_session_id: false,
      same_repo_root: null,
      same_branch: null,
      same_worktree_path: null,
      claim_before_edit: null,
    },
  };
}

function healthyTasks(): TestTask[] {
  return [
    { id: 1, repo_root: '/r', branch: 'b' },
    { id: 5, repo_root: '/r', branch: 'spec/plan', status: 'open' },
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
