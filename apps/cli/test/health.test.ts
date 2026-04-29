import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  ClaimMatchSources,
  ClaimMissReasons,
  NearestClaimExample,
  OmxRuntimeSummaryStats,
} from '@colony/storage';
import kleur from 'kleur';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildColonyHealthPayload,
  buildHealthFixPlan,
  formatColonyHealthOutput,
  formatHealthFixPlanOutput,
} from '../src/commands/health.js';

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
        evidence: expect.stringContaining('1 stale claim(s); 0 downstream blocker(s)'),
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
    expect(text).toContain('colony health');
    expect(text).toContain('Readiness summary');
    expect(text.indexOf('Readiness summary')).toBeLessThan(text.indexOf('Colony MCP share'));
    expect(text).toContain('coordination_readiness');
    expect(text).toContain('execution_safety');
    expect(text).toContain('queen_plan_readiness');
    expect(text).toContain('working_state_migration');
    expect(text).toContain('signal_evaporation');
    expect(text).toContain('Colony MCP share');
    expect(text).toContain('hivemind_context -> attention_inbox: 1 / 2 (50%) sessions');
    expect(text).toContain('attention_inbox -> task_ready_for_agent: 1 / 1 (100%) sessions');
    expect(text).toContain('task_list vs task_ready_for_agent');
    expect(text).toContain('task_post vs task_message');
    expect(text).toContain('task_post vs OMX notepad');
    expect(text).toContain('Search calls per session');
    expect(text).toContain('1 / 2 edits had a claim before edit (50%)');
    expect(text).toContain(
      'claim_match_sources: exact_session=0, repo_branch=1, worktree=0, agent_lane=0, window_ms=300000 (health-only fallback)',
    );
    expect(text).toContain('why claims did not match edits:');
    expect(text).toContain('no_claim_for_file: 1');
    expect(text).toContain('nearest claim examples:');
    expect(text).toContain(
      'no_claim_for_file: edit#9 src/missing.ts by codex-alpha-session; no nearby claim',
    );
    expect(text).toContain('Signal health');
    expect(text).toContain('Proposal decay/promotions');
    expect(text).toContain('Ready-to-claim vs claimed');
    expect(text).toContain('Queen wave plans');
    expect(text).toContain('active plans:                       1');
    expect(text).toContain('current wave:                       Wave 1');
    expect(text).toContain('stale claims blocking downstream:   0');
    expect(text).toContain('Next fixes');
    expect(text).toContain('Adoption thresholds');
    expect(text).toContain('task_list > task_ready_for_agent');
    expect(text).not.toContain('\n  Good\n');
    expect(text).not.toContain('\n  Bad\n');
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
    const text = formatColonyHealthOutput(payload);
    expect(text).toContain('why claims did not match edits:');
    expect(text).toContain('claim_after_edit: 1');
    expect(text).toContain('session_id_mismatch: 2');
    expect(text).toContain('repo_root_mismatch: 4');
    expect(text).toContain('branch_mismatch: 5');
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
          items: [
            { reason: 'stalled' },
            { reason: 'unclaimed' },
            { reason: 'ready-to-archive' },
          ],
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
    expect(text).toContain('[ran] Run coordination sweep');
    expect(text).toContain('stale=2, expired/weak=1');
    expect(text).toContain('[ran] Run queen sweep');
    expect(text).toContain('stalled=1, unclaimed=1, ready-to-archive=1');
    expect(text).toContain("colony queen sweep --repo-root '/repo with space' --json");
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
            }),
            expect.objectContaining({
              owner: 'claude',
              session_id: 'claude-right-session',
              branch: 'agent/claude/right',
            }),
            expect.objectContaining({
              owner: 'codex',
              session_id: 'codex-main-session',
              branch: 'main',
            }),
          ]),
        },
      ],
    });

    expect(payload.readiness_summary.execution_safety).toMatchObject({
      status: 'bad',
      evidence: expect.stringContaining('live contentions 1, dirty 1'),
    });
    expect(payload.action_hints[0]).toMatchObject({
      metric: 'live file contentions',
      current: '1 conflict(s), 1 dirty',
      command: 'colony health --json',
    });

    const text = formatColonyHealthOutput(payload);
    expect(text).toContain('Live contention health');
    expect(text).toContain('live_file_contentions:      1');
    expect(text).toContain('protected_file_contentions: 1');
    expect(text).toContain('paused_lanes:               2');
    expect(text).toContain('takeover_requests:          1');
    expect(text).toContain('competing_worktrees:        2');
    expect(text).toContain('dirty_contended_files:      1');
    expect(text).toContain('src/shared.ts (3 owners; protected, dirty)');
    expect(text).toContain(
      'owner=codex session=codex-left-... branch=agent/codex/left activity=working',
    );
    expect(text).toContain(
      'owner=claude session=claude-righ... branch=agent/claude/right activity=stalled',
    );
    expect(text).toContain('owner=codex session=codex-main-... branch=main activity=working');
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

    const text = formatColonyHealthOutput(payload);
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
          { id: 10, repo_root: '/r', branch: 'spec/waves/sub-0' },
          { id: 11, repo_root: '/r', branch: 'spec/waves/sub-1' },
          { id: 12, repo_root: '/r', branch: 'spec/waves/sub-2' },
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
              file_scope: ['src/a.ts', 'src/b.ts'],
            }),
            observation(16, 'handoff', NOW - 2 * 3_600_000, {
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
            }),
          ],
          12: [
            observation(13, 'plan-subtask', NOW - 3_000, {
              status: 'available',
              depends_on: [0],
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
          replacement_recommendation: {
            recommended_replacement_agent: 'claude-code',
            reason: 'Codex recently hit quota on this branch',
          },
        },
      ],
    });
    expect(payload.action_hints).toContainEqual(
      expect.objectContaining({
        metric: 'stale claims blocking downstream',
        current: '1',
        target: '0',
      }),
    );

    const text = formatColonyHealthOutput(payload);
    expect(text).toContain('stale claims blocking downstream:   1');
    expect(text).toContain(
      'recommended replacement:           claude-code (Codex recently hit quota on this branch; next task_accept_handoff)',
    );
    expect(text).toContain(
      'waves: current Wave 1; ready 0, claimed 1, blocked 2, stale blockers 1',
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
      const text = formatColonyHealthOutput(payload);
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
      expect.objectContaining({
        metric: 'task_ready_for_agent -> claim',
        current: '0%',
        target: '30%+',
        action: expect.stringContaining('task_plan_claim_subtask'),
        tool_call: expect.stringContaining('mcp__colony__task_plan_claim_subtask'),
        prompt: expect.stringContaining('task_plan_claim_subtask'),
      }),
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
        action: expect.stringContaining('coordination sweep/rescue'),
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
    expect(text).toContain('Next fixes');
    expect(text.indexOf('claim-before-edit: 0%')).toBeLessThan(text.indexOf('stale claims: 1'));
    expect(text.indexOf('stale claims: 1')).toBeLessThan(
      text.indexOf('task_post/task_note_working share: 0%'),
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
    expect(text).toContain('stale claims: 1 (target 0) - Run colony coordination sweep/rescue');
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

    const text = formatColonyHealthOutput(payload);
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

    const text = formatColonyHealthOutput(payload);
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
    const text = formatColonyHealthOutput(payload);
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
    expect(formatColonyHealthOutput(payload)).toContain('not available');
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

      const text = formatColonyHealthOutput(payload);
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

      const text = formatColonyHealthOutput(payload);
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
    const text = formatColonyHealthOutput(payload);
    expect(text).toContain('OMX runtime bridge');
    expect(text).toContain('summaries ingested:  2');
    expect(text).toContain('latest summary age:  5m');
  });
});

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

function fakeWorktreeContention(): never {
  return {
    generated_at: new Date(NOW).toISOString(),
    repo_root: '/repo',
    summary: {
      worktree_count: 2,
      dirty_worktree_count: 2,
      dirty_file_count: 2,
      contention_count: 1,
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
  tasks?: TestTask[];
  observationsByTask?: Record<number, TestObservation[]>;
  claimsByTask?: Record<
    number,
    Array<{ task_id: number; file_path: string; session_id: string; claimed_at: number }>
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
    claimBeforeEditStats: () => args.claimBeforeEdit,
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
