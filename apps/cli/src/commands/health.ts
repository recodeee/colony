import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defaultSettings, loadSettings } from '@colony/config';
import {
  type CoordinationSweepResult,
  type HivemindSession,
  type McpCapabilityMap,
  type McpConfigSource,
  type OmxRuntimeSummaryHealthStats,
  ProposalSystem,
  type WorktreeContentionReport,
  buildCoordinationSweep,
  classifyClaimAge,
  currentSignalStrength,
  discoverMcpCapabilities,
  discoverOmxRuntimeSummaryStats,
  isSignalExpired,
  isStrongClaimAge,
  mergeOmxRuntimeSummaryStats,
  readHivemind,
  readWorktreeContentionReport,
  signalMetadataFromObservation,
  signalMetadataFromProposal,
} from '@colony/core';
import {
  type QueenReplacementAgent,
  type QueenReplacementRecommendation,
  sweepQueenPlans,
} from '@colony/queen';
import { isProtectedBranch as isProtectedBaseBranch } from '@colony/storage';
import type {
  ClaimBeforeEditStats,
  ClaimMatchSources,
  ClaimMissReasons,
  NearestClaimExample,
  ObservationRow,
  OmxRuntimeSummaryStats,
  ProposalRow,
  ReinforcementRow,
  Storage,
  TaskRow,
  ToolCallRow,
} from '@colony/storage';
import type { Command } from 'commander';
import kleur from 'kleur';
import { readCodexEditToolCallsSince, readCodexMcpToolCallsSince } from '../lib/codex-rollouts.js';

const DEFAULT_HOURS = 24;
const DEFAULT_RECENT_WINDOW_HOURS = 1;
const HEALTH_TOOL_LIMIT = 5;
const QUOTA_RELAY_EXAMPLE_LIMIT = 5;
const QUOTA_RELAY_FILE_PREVIEW_LIMIT = 2;
const DEFAULT_HEALTH_TEXT_LIMIT = 64;
const DEFAULT_HANDOFF_TTL_MS = 2 * 60 * 60_000;
const PLAN_SUBTASK_BRANCH_RE = /^spec\/([a-z0-9-]+)\/sub-(\d+)$/;
const PLAN_ROOT_BRANCH_RE = /^spec\/([a-z0-9-]+)$/;
const TARGET_HIVEMIND_TO_ATTENTION = 0.5;
const TARGET_TASK_LIST_TO_READY = 0.3;
const TARGET_READY_TO_CLAIM = 0.3;
const TARGET_CLAIM_BEFORE_EDIT = 0.5;
const TARGET_COLONY_NOTE_SHARE = 0.7;
const TARGET_TASK_MESSAGE_SHARE = 0.2;
const TASK_MESSAGE_ADOPTION_DIRECTED_CALL =
  'mcp__colony__task_message({ agent: "codex", session_id: "<session_id>", task_id: <task_id>, to_agent: "codex", urgency: "needs_reply", content: "<short directed request>" })';
const TASK_MESSAGE_ADOPTION_SHARED_NOTE_CALL =
  'mcp__colony__task_post({ task_id: <task_id>, session_id: "<session_id>", kind: "note", content: "branch=<branch>; task=<task>; blocker=<blocker>; next=<next>; evidence=<evidence>" })';
const RECENT_CLAIM_BEFORE_EDIT_MIN_SAMPLE = 5;
const LIFECYCLE_BRIDGE_MISSING_MIN_TASK_CLAIM_FILE_CALLS = 10;
const LIFECYCLE_BRIDGE_MISSING_MIN_HOOK_CAPABLE_EDITS = 10;
const LIFECYCLE_BRIDGE_NEAR_ZERO_PRE_TOOL_USE_SIGNAL_RATIO = 0.05;
const LIFECYCLE_BRIDGE_UNAVAILABLE_ROOT_CAUSE =
  'Lifecycle bridge unavailable: runtime bridge is not available, so health cannot trust edit telemetry.';
const LIFECYCLE_BRIDGE_SILENT_ROOT_CAUSE =
  'Lifecycle bridge silent: runtime bridge is available, but edit-path telemetry is empty or near-zero.';
const LIFECYCLE_PATHS_MISSING_ROOT_CAUSE =
  'Lifecycle paths missing: PreToolUse telemetry exists, but edit events do not include file_path metadata.';
const LIFECYCLE_SUMMARY_NOT_JOINED_ROOT_CAUSE =
  'Runtime bridge is fresh and sees edit paths, but claim-before-edit telemetry is not joined into health stats.';
const LIFECYCLE_CLAIM_MISMATCH_ROOT_CAUSE =
  'Lifecycle claim mismatch: file paths are present, but lifecycle claims do not match edit scope.';
const NO_HOOK_CAPABLE_EDITS_ROOT_CAUSE =
  'No hook-capable edits: health saw no file edit events in the selected window.';
const OLD_TELEMETRY_POLLUTION_ROOT_CAUSE =
  '24h claim-before-edit includes older edit telemetry; no fresh pre_tool_use_missing edits detected in the recent window.';
const LIFECYCLE_BRIDGE_ACTION =
  'Install/wire the lifecycle bridge so OMX/Codex/Claude emits pre_tool_use before file mutation.';
const LIFECYCLE_BRIDGE_COMMAND =
  'colony bridge lifecycle --json --ide <ide> --cwd <repo_root> < colony-omx-lifecycle-v1.pre.json';
const LIFECYCLE_INSTALL_VERIFY_COMMAND =
  'colony install --ide <ide>  # then restart; pnpm smoke:codex-omx-pretool; colony health --hours 1 --json';
const LIFECYCLE_HEALTH_VERIFY_COMMAND = 'colony health --hours 1 --json';
const OMX_RUNTIME_SUMMARY_COMMAND =
  'colony bridge runtime-summary --json --repo-root <repo_root> < .omx/state/colony-runtime-summary.json';
const INSUFFICIENT_RUNTIME_METADATA_REASON = 'insufficient runtime metadata or bridge unavailable';
const PROTECTED_BRANCHES = new Set(['main', 'dev', 'master', 'trunk']);
const CLAIM_MISMATCH_TOOL_CALL =
  'mcp__colony__task_claim_file({ task_id: <task_id>, session_id: "<session_id>", file_path: "<file>", note: "pre-edit claim in same repo/branch/worktree" })';
const STALE_CLAIM_SWEEP_COMMAND = 'colony coordination sweep --json';

const CONVERSIONS = [
  ['hivemind_context', 'attention_inbox'],
  ['attention_inbox', 'task_ready_for_agent'],
  ['task_list', 'task_ready_for_agent'],
  ['task_ready_for_agent', 'task_plan_claim_subtask'],
] as const;

const HEALTH_HEADER_WIDTH = 72;

type HealthHeadingTone = 'blue' | 'cyan' | 'green' | 'magenta' | 'red' | 'yellow';

type ConversionName =
  | 'hivemind_context_to_attention_inbox'
  | 'attention_inbox_to_task_ready_for_agent'
  | 'task_list_to_task_ready_for_agent'
  | 'task_ready_for_agent_to_task_plan_claim_subtask';

interface SharePayload {
  total_tool_calls: number;
  mcp_tool_calls: number;
  colony_mcp_tool_calls: number;
  share_of_all_tool_calls: number | null;
  share_of_mcp_tool_calls: number | null;
  top_tools: Array<{ tool: string; calls: number }>;
  source_breakdown: {
    colony_observations: number;
    codex_rollouts: number;
    repo_store_observations?: number;
    merged_repo_stores?: string[];
  };
}

interface ConversionPayload {
  from_tool: string;
  to_tool: string;
  from_calls: number;
  to_calls: number;
  from_sessions: number;
  converted_sessions: number;
  conversion_rate: number | null;
}

interface TaskPostMessagePayload {
  task_post_calls: number;
  task_message_calls: number;
  task_message_share: number | null;
}

interface TaskSelectionPayload {
  task_list_calls: number;
  task_ready_for_agent_calls: number;
  task_list_first_sessions: number;
  task_ready_share: number | null;
  task_ready_per_task_list: number | null;
}

interface TaskPostNotepadPayload {
  status: 'available' | 'unavailable';
  task_post_calls: number;
  task_note_working_calls: number;
  colony_note_calls: number;
  omx_notepad_write_calls: number;
  task_post_share: number | null;
  colony_note_share: number | null;
}

interface OmxRuntimeBridgePayload extends OmxRuntimeSummaryHealthStats {
  latest_summary_age_ms: number | null;
}

interface SearchCallsPayload {
  total_search_calls: number;
  active_sessions: number;
  average_per_active_session: number | null;
  sessions: Array<{ session_id: string; calls: number }>;
}

interface ClaimBeforeEditPayload extends ClaimBeforeEditStats {
  status: 'available' | 'not_available' | 'no_data';
  hook_capable_edits: number;
  measurable_edits: number;
  unmeasurable_edits: number;
  runtime_bridge_status: OmxRuntimeBridgePayload['status'];
  reason: string | null;
  task_claim_file_calls: number;
  edits_with_claim: number;
  edits_missing_claim: number;
  auto_claimed_before_edit: number;
  edits_without_claim_before: number;
  claim_before_edit_ratio: number | null;
  /** Total claim-before-edit telemetry rows in window — non-zero means the
   *  PreToolUse hook is firing somewhere; zero with edits > 0 strongly
   *  suggests the hook is not wired into the active editor session. */
  pre_tool_use_signals: number;
  old_telemetry_pollution: boolean;
  recent_window_hours: number;
  recent_hook_capable_edits: number;
  recent_pre_tool_use_missing: number;
  recent_pre_tool_use_signals: number;
  recent_claim_before_edit_rate: number | null;
  /** PreToolUse fired, but the hook session id was not present in Colony
   *  storage, so telemetry was recorded under the diagnostics fallback. */
  session_binding_missing: number;
  edit_source_breakdown: {
    colony_post_tool_edits: number;
    codex_rollout_edits: number;
    hook_capable_edits: number;
    pre_tool_use_signals: number;
  };
  /** Codex rollouts show edits, but no Codex PreToolUse signal/bridge rows
   *  exist in Colony. These edits are intentionally excluded from the
   *  claim-before-edit denominator until hook/bridge support is installed. */
  codex_rollout_without_bridge: boolean;
  /** True when edits happened but no PreToolUse telemetry was recorded —
   *  diagnostic that points at hook wiring rather than agent discipline. */
  likely_missing_hook: boolean;
  /** Clear operator diagnosis when agents are manually claiming files but the
   *  lifecycle bridge is not producing pre_tool_use telemetry. */
  root_cause: RootCauseSummary | null;
  /** User-facing remediation for hook wiring or session-binding failures. */
  install_hint: string | null;
  claim_match_window_ms: number;
  claim_match_sources: ClaimMatchSources;
  claim_miss_reasons: ClaimMissReasons;
  nearest_claim_examples: NearestClaimExample[];
}

interface SignalHealthPayload {
  total_claims: number;
  active_claims: number;
  fresh_claims: number;
  stale_claims: number;
  expired_claims: number;
  weak_claims: number;
  quota_pending_claims: number;
  expired_quota_pending_claims: number;
  quota_relay_actions: QuotaRelayActionsPayload;
  quota_relay_examples: QuotaRelayExample[];
  stale_claim_minutes: number;
  expired_handoffs: number;
  expired_messages: number;
}

type QuotaRelayState = 'active' | 'expired' | 'accepted' | 'declined/rerouted' | 'unknown';
type QuotaRelayRecommendedAction = 'accept' | 'release expired' | 'decline/reroute' | 'none';

interface QuotaRelayExample {
  task_id: number;
  baton_kind: 'handoff' | 'relay';
  handoff_observation_id: number;
  old_owner: string;
  age_ms: number;
  age_minutes: number;
  files: string[];
  state: QuotaRelayState;
  recommended_action: QuotaRelayRecommendedAction;
  tool_call: string | null;
  decline_tool_call: string | null;
  command: string;
}

interface QuotaRelayActionsPayload {
  accept: number;
  release_expired: number;
  decline_reroute: number;
  none: number;
  top_action: QuotaRelayRecommendedAction;
  top_example: QuotaRelayExample | null;
}

interface ProposalHealthPayload {
  proposals_seen: number;
  pending: number;
  promoted: number;
  evaporated: number;
  pending_below_noise_floor: number;
  promotion_rate: number | null;
}

interface ReadyClaimPayload {
  plan_subtasks: number;
  ready_to_claim: number;
  claimed: number;
  ready_to_claim_per_claimed: number | null;
  claimed_share_of_actionable: number | null;
}

interface QueenWavePlanSummary {
  plan_slug: string;
  current_wave: string | null;
  ready_subtasks: number;
  claimed_subtasks: number;
  blocked_subtasks: number;
  next_ready_subtask_index: number | null;
  next_ready_subtask_title: string | null;
  stale_claims_blocking_downstream: number;
  downstream_blockers: QueenDownstreamBlockerReport[];
  quota_handoffs_blocking_downstream: number;
  replacement_recommendation: QueenReplacementRecommendation | null;
}

type QueenPlanLifecycleState =
  | 'active'
  | 'completed'
  | 'archived'
  | 'orphan-subtasks'
  | 'inactive-with-remaining-subtasks';

type QueenPlanRepairAction =
  | 'claim-ready-subtasks'
  | 'archive-completed-plan'
  | 'delete-orphan-subtasks'
  | 'reactivate-plan'
  | 'publish-new-plan'
  | 'none';

interface QueenPlanRepairRecommendation {
  action: QueenPlanRepairAction;
  summary: string;
  command: string | null;
  tool_call: string | null;
}

interface QueenPlanStateSummary {
  plan_slug: string;
  repo_root: string;
  state: QueenPlanLifecycleState;
  parent_task_id: number | null;
  parent_task_status: string | null;
  subtask_count: number;
  completed_subtask_count: number;
  remaining_subtask_count: number;
  ready_subtask_count: number;
  claimed_subtask_count: number;
  blocked_subtask_count: number;
  recommendation: QueenPlanRepairRecommendation;
}

interface QueenWaveHealthPayload {
  active_plans: number;
  completed_plans: number;
  archived_plans: number;
  archived_plans_with_remaining_subtasks: number;
  orphan_subtasks: number;
  inactive_plans_with_remaining_subtasks: number;
  current_wave: string | null;
  ready_subtasks: number;
  claimed_subtasks: number;
  blocked_subtasks: number;
  stale_claims_blocking_downstream: number;
  quota_handoffs_blocking_downstream: number;
  replacement_recommendation: QueenReplacementRecommendation | null;
  plans: QueenWavePlanSummary[];
  plan_state_recommendations: QueenPlanStateSummary[];
  downstream_blockers: QueenDownstreamBlockerReport[];
}

interface QueenDownstreamBlockerReport {
  plan_slug: string;
  task_id: number;
  subtask_index: number;
  subtask_title: string;
  file_path: string;
  owner_session_id: string;
  owner_agent: string | null;
  age_minutes: number;
  unlock_candidate: {
    task_id: number;
    subtask_index: number;
    title: string;
  };
}

interface LiveContentionOwner {
  owner: string;
  session_id: string;
  branch: string;
  task_id: number;
  task_status: string;
  activity: string;
  worktree_path: string;
  claim_age_minutes: number;
  claim_strength: string;
  dirty: boolean;
  classification: LiveContentionOwnerClassification;
}

interface LiveContentionConflict {
  file_path: string;
  owner_count: number;
  protected: boolean;
  dirty_worktrees: string[];
  owners: LiveContentionOwner[];
}

type LiveContentionOwnerClassification =
  | 'active known owner'
  | 'inactive known owner'
  | 'unknown owner'
  | 'same branch duplicate';

interface LiveContentionRecommendedAction {
  file_path: string;
  action: string;
  owner: string;
  session_id: string;
  branch: string;
  classification: LiveContentionOwnerClassification;
  reason: string;
  command?: string;
  mcp_tool_hint?: string;
}

interface ProtectedClaimActionQueue {
  protected_claims: number;
  takeover_actions: number;
  release_or_weaken_actions: number;
  keep_owner_actions: number;
  next_action: string;
  commands: string[];
}

interface LiveContentionPayload {
  live_file_contentions: number;
  protected_file_contentions: number;
  paused_lanes: number;
  takeover_requests: number;
  competing_worktrees: number;
  dirty_contended_files: number;
  top_conflicts: LiveContentionConflict[];
  recommended_actions: LiveContentionRecommendedAction[];
  protected_claim_action_queue: ProtectedClaimActionQueue;
}

interface AdoptionSignal {
  name: string;
  status: 'good' | 'ok' | 'bad' | 'needs_attention';
  value: number | null;
  target: number | null;
  hint: string;
}

interface AdoptionThresholdsPayload {
  good: AdoptionSignal[];
  bad: AdoptionSignal[];
}

interface ActionHint {
  metric: string;
  status: 'bad';
  current: string;
  target: string;
  action: string;
  readiness_scope: ReadinessScope;
  priority: number;
  plan_slug?: string;
  current_wave?: string | null;
  tool_call?: string;
  command?: string;
  prompt: string;
}

interface RootCauseSummary {
  kind:
    | 'lifecycle_bridge_unavailable'
    | 'lifecycle_bridge_silent'
    | 'lifecycle_paths_missing'
    | 'lifecycle_summary_not_joined'
    | 'lifecycle_claim_mismatch'
    | 'no_hook_capable_edits'
    | 'old_telemetry_pollution';
  summary: string;
  evidence: string;
  evidence_counters: RootCauseEvidenceCounters;
  action: string;
  command?: string;
}

interface RootCauseEvidenceCounters {
  runtime_bridge_status: OmxRuntimeBridgePayload['status'];
  task_claim_file_calls: number;
  edit_tool_calls: number;
  hook_capable_edits: number;
  pre_tool_use_signals: number;
  recent_task_claim_file_calls: number;
  recent_hook_capable_edits: number;
  recent_pre_tool_use_signals: number;
  recent_pre_tool_use_missing: number;
  edits_without_claim_before: number;
  live_file_contentions: number;
  dirty_contended_files: number;
  dominant_claim_miss_reason: keyof ClaimMissReasons | null;
}

interface HealthFixPlanStep {
  title: string;
  status: 'suggested' | 'planned' | 'ran' | 'skipped';
  detail: string;
  command?: string;
}

interface HealthFixPlanPayload {
  generated_at: string;
  mode: 'dry-run' | 'apply';
  readiness_summary: ReadinessSummaryPayload;
  safety: {
    mutates_claims: boolean;
    installs_hooks: false;
    ran_coordination_sweep: boolean;
    ran_queen_sweep: boolean;
    release_safe_stale_claims: boolean;
  };
  current: {
    pre_tool_use_missing: number;
    pre_tool_use_missing_dominates: boolean;
    stale_claims: number;
    expired_weak_claims: number;
    live_contentions: number;
    dirty_contended_files: number;
    stale_downstream_blockers: number;
  };
  steps: HealthFixPlanStep[];
  verification_commands: string[];
  coordination_sweep?: CoordinationSweepResult | undefined;
  queen_sweep?: ReturnType<typeof sweepQueenPlans> | undefined;
}

function codexPrompt(input: {
  goal: string;
  current: string;
  inspect: string;
  acceptance: string;
}): string {
  return `Goal: ${input.goal} | Current: ${input.current} | Inspect: ${input.inspect} | Accept: ${input.acceptance}`;
}

type ReadinessStatus = 'good' | 'ok' | 'bad';

interface ReadinessSummaryItem {
  status: ReadinessStatus;
  evidence: string;
  root_cause?: RootCauseSummary;
}

interface ReadinessSummaryPayload {
  coordination_readiness: ReadinessSummaryItem;
  execution_safety: ReadinessSummaryItem;
  queen_plan_readiness: ReadinessSummaryItem;
  working_state_migration: ReadinessSummaryItem;
  signal_evaporation: ReadinessSummaryItem;
}

type ReadinessSummaryKey = keyof ReadinessSummaryPayload;
type ReadinessScope = ReadinessSummaryKey | 'adoption_followup';

const READINESS_LABELS: Record<ReadinessSummaryKey, string> = {
  coordination_readiness: 'Coordination loop',
  execution_safety: 'Edit safety',
  queen_plan_readiness: 'Plan readiness',
  working_state_migration: 'Working notes',
  signal_evaporation: 'Stale signals',
};

export interface ColonyHealthPayload {
  generated_at: string;
  window_hours: number;
  readiness_summary: ReadinessSummaryPayload;
  colony_mcp_share: SharePayload;
  mcp_capability_map: McpCapabilityMap;
  conversions: Record<ConversionName, ConversionPayload>;
  task_list_vs_task_ready_for_agent: TaskSelectionPayload;
  task_post_vs_task_message: TaskPostMessagePayload;
  task_post_vs_omx_notepad: TaskPostNotepadPayload;
  omx_runtime_bridge: OmxRuntimeBridgePayload;
  search_calls_per_session: SearchCallsPayload;
  task_claim_file_before_edits: ClaimBeforeEditPayload;
  signal_health: SignalHealthPayload;
  proposal_health: ProposalHealthPayload;
  ready_to_claim_vs_claimed: ReadyClaimPayload;
  queen_wave_health: QueenWaveHealthPayload;
  live_contention_health: LiveContentionPayload;
  adoption_thresholds: AdoptionThresholdsPayload;
  action_hints: ActionHint[];
}

type ColonyHealthPayloadWithoutHints = Omit<
  ColonyHealthPayload,
  'readiness_summary' | 'action_hints'
>;

type ClaimBeforeEditStorage = Pick<Storage, 'claimBeforeEditStats' | 'toolCallsSince'>;

export function buildColonyHealthPayload(
  storage: Pick<
    Storage,
    | 'toolCallsSince'
    | 'claimBeforeEditStats'
    | 'listTasks'
    | 'listClaims'
    | 'getSession'
    | 'taskTimeline'
    | 'taskObservationsByKind'
    | 'listProposalsForBranch'
    | 'listReinforcements'
  >,
  options: {
    since: number;
    window_hours: number;
    recent_window_hours?: number;
    now?: number;
    claim_stale_minutes?: number;
    codex_sessions_root?: string;
    repo_root?: string;
    hivemind?: { sessions: HivemindSession[] };
    dirty_files_by_worktree?: Record<string, string[]>;
    worktree_contention?: WorktreeContentionReport;
    mcp_capability_sources?: McpConfigSource[];
    omx_runtime_summary_stale_ms?: number;
    omx_runtime_summary_global_dir?: string | null;
    omx_runtime_summary_paths?: string[];
    /**
     * Read-only storages whose claim-before-edit and tool-call rows are merged
     * into the metric inputs. Lets `colony health` see PreToolUse signals that
     * the codex hook recorded against per-repo `.omx/colony-home/data.db`
     * stores when COLONY_HOME redirects writes off the global DB.
     */
    merge_storages?: ClaimBeforeEditStorage[];
    /** Origin paths of `merge_storages`, surfaced in payload diagnostics. */
    merged_repo_stores?: string[];
  },
): ColonyHealthPayload {
  const now = options.now ?? Date.now();
  const recentWindowHours = options.recent_window_hours ?? DEFAULT_RECENT_WINDOW_HOURS;
  const recentSince = Math.max(options.since, now - recentWindowHours * 3_600_000);
  const mergeStorages = options.merge_storages ?? [];
  const mergedRepoStores = options.merged_repo_stores ?? [];
  const colonyCalls = storage.toolCallsSince(options.since);
  // Codex CLI doesn't fire colony's PostToolUse hook, so its MCP traffic never
  // reaches the colony observations table — see the recodee dashboard backend
  // at `app/modules/cavemem_hivemind/service.py::_count_codex_mcp_tool_calls`
  // for the parallel ingest path. Merge both sources so `colony health`
  // matches what dashboard surfaces.
  const codexCalls = readCodexMcpToolCallsSince(options.since, {
    now,
    root: options.codex_sessions_root,
  });
  const codexEditCalls = readCodexEditToolCallsSince(options.since, {
    now,
    root: options.codex_sessions_root,
  });
  const repoStoreCalls = mergeStorages.flatMap((s) => s.toolCallsSince(options.since));
  const calls: ToolCallRow[] = [...colonyCalls, ...repoStoreCalls, ...codexCalls].sort(
    (a, b) => a.ts - b.ts || a.id - b.id,
  );
  const tasks = storage.listTasks(2000);
  const totalToolCalls = calls.length;
  const mcpToolCalls = calls.filter((call) => isMcpTool(call.tool)).length;
  const colonyMcpToolCalls = calls.filter((call) => isColonyMcpTool(call.tool)).length;
  const conversionEntries = CONVERSIONS.map(([from, to]) => [
    conversionKey(from, to),
    conversion(calls, from, to),
  ]);
  const taskPostCalls = countTool(calls, 'task_post');
  const taskNoteWorkingCalls = countTool(calls, 'task_note_working');
  const taskMessageCalls = countTool(calls, 'task_message');
  const storedOmxRuntimeStats = omxRuntimeSummaryStats(storage, options.since);
  const discoveredOmxRuntimeStats =
    options.repo_root !== undefined ||
    options.omx_runtime_summary_paths !== undefined ||
    options.omx_runtime_summary_global_dir !== undefined
      ? discoverOmxRuntimeSummaryStats({
          since: options.since,
          now,
          ...(options.repo_root !== undefined ? { repoRoot: options.repo_root } : {}),
          ...(options.omx_runtime_summary_stale_ms !== undefined
            ? { staleMs: options.omx_runtime_summary_stale_ms }
            : {}),
          ...(options.omx_runtime_summary_global_dir !== undefined
            ? { globalSummaryDir: options.omx_runtime_summary_global_dir }
            : {}),
          ...(options.omx_runtime_summary_paths !== undefined
            ? { paths: options.omx_runtime_summary_paths }
            : {}),
        })
      : null;
  const omxRuntimeStats = mergeOmxRuntimeSummaryStats(
    [storedOmxRuntimeStats, discoveredOmxRuntimeStats],
    {
      now,
      ...(options.omx_runtime_summary_stale_ms !== undefined
        ? { staleMs: options.omx_runtime_summary_stale_ms }
        : {}),
    },
  );
  const searchCalls = searchCallsPerSession(calls);
  const runtimeClaimBeforeEdit =
    omxRuntimeStats.status === 'available' ? omxRuntimeStats.claim_before_edit : undefined;
  const baseClaimStats = storage.claimBeforeEditStats(options.since);
  const baseRecentClaimStats = storage.claimBeforeEditStats(recentSince);
  const repoClaimStats = mergeStorages.map((s) => s.claimBeforeEditStats(options.since));
  const repoRecentClaimStats = mergeStorages.map((s) => s.claimBeforeEditStats(recentSince));
  const claimBeforeEditStats = claimBeforeEditStatsWithRuntimeSummary(
    mergeClaimBeforeEditStats(baseClaimStats, repoClaimStats),
    runtimeClaimBeforeEdit,
  );
  const recentClaimBeforeEditStats = claimBeforeEditStatsWithRuntimeSummary(
    mergeClaimBeforeEditStats(baseRecentClaimStats, repoRecentClaimStats),
    runtimeClaimBeforeEdit,
  );
  const taskSelection = taskSelectionPayload(calls);
  const taskClaimFileCalls = countTool(calls, 'task_claim_file');
  const recentTaskClaimFileCalls = countTool(
    calls.filter((call) => call.ts >= recentSince),
    'task_claim_file',
  );
  const liveContention = liveContentionPayload(storage, tasks, {
    since: options.since,
    now,
    stale_claim_minutes: options.claim_stale_minutes ?? defaultSettings.claimStaleMinutes,
    ...(options.repo_root !== undefined ? { repo_root: options.repo_root } : {}),
    ...(options.hivemind !== undefined ? { hivemind: options.hivemind } : {}),
    ...(options.dirty_files_by_worktree !== undefined
      ? { dirty_files_by_worktree: options.dirty_files_by_worktree }
      : {}),
    ...(options.worktree_contention !== undefined
      ? { worktree_contention: options.worktree_contention }
      : {}),
  });

  const payload: ColonyHealthPayloadWithoutHints = {
    generated_at: new Date(now).toISOString(),
    window_hours: options.window_hours,
    colony_mcp_share: {
      total_tool_calls: totalToolCalls,
      mcp_tool_calls: mcpToolCalls,
      colony_mcp_tool_calls: colonyMcpToolCalls,
      share_of_all_tool_calls: ratio(colonyMcpToolCalls, totalToolCalls),
      share_of_mcp_tool_calls: ratio(colonyMcpToolCalls, mcpToolCalls),
      top_tools: topToolsByCount(calls, HEALTH_TOOL_LIMIT),
      source_breakdown: {
        colony_observations: colonyCalls.length,
        codex_rollouts: codexCalls.length,
        ...(repoStoreCalls.length > 0 ? { repo_store_observations: repoStoreCalls.length } : {}),
        ...(mergedRepoStores.length > 0 ? { merged_repo_stores: mergedRepoStores } : {}),
      },
    },
    mcp_capability_map: discoverMcpCapabilities({
      now,
      ...(options.mcp_capability_sources !== undefined
        ? { sources: options.mcp_capability_sources }
        : {}),
    }),
    conversions: Object.fromEntries(conversionEntries) as Record<ConversionName, ConversionPayload>,
    task_list_vs_task_ready_for_agent: taskSelection,
    task_post_vs_task_message: {
      task_post_calls: taskPostCalls,
      task_message_calls: taskMessageCalls,
      task_message_share: ratio(taskMessageCalls, taskPostCalls + taskMessageCalls),
    },
    task_post_vs_omx_notepad: taskPostVsNotepadPayload(calls, taskPostCalls, taskNoteWorkingCalls),
    omx_runtime_bridge: omxRuntimeBridgePayload(omxRuntimeStats, now),
    search_calls_per_session: searchCalls,
    task_claim_file_before_edits: claimBeforeEditPayload(
      claimBeforeEditStats,
      taskClaimFileCalls,
      codexEditCalls.length,
      {
        recent_stats: recentClaimBeforeEditStats,
        recent_task_claim_file_calls: recentTaskClaimFileCalls,
        recent_window_hours: recentWindowHours,
        omx_runtime_bridge: omxRuntimeStats,
        live_file_contentions: liveContention.live_file_contentions,
        dirty_contended_files: liveContention.dirty_contended_files,
      },
    ),
    signal_health: signalHealthPayload(storage, tasks, {
      since: options.since,
      now,
      stale_claim_minutes: options.claim_stale_minutes ?? defaultSettings.claimStaleMinutes,
    }),
    proposal_health: proposalHealthPayload(storage, tasks, {
      since: options.since,
      now,
    }),
    ready_to_claim_vs_claimed: readyClaimPayload(storage, tasks),
    queen_wave_health: queenWaveHealthPayload(storage, tasks, {
      now,
      stale_claim_minutes: options.claim_stale_minutes ?? defaultSettings.claimStaleMinutes,
    }),
    live_contention_health: liveContention,
    adoption_thresholds: adoptionThresholds(calls, {
      colony_mcp_share: ratio(colonyMcpToolCalls, mcpToolCalls),
      task_claim_file_calls: taskClaimFileCalls,
      task_post_calls: taskPostCalls,
      task_note_working_calls: taskNoteWorkingCalls,
    }),
  };

  const readinessSummary = readinessSummaryPayload(payload);

  return {
    ...payload,
    readiness_summary: readinessSummary,
    action_hints: healthActionHints(payload),
  };
}

export function formatColonyHealthOutput(
  payload: ColonyHealthPayload,
  options: { json?: boolean; prompts?: boolean; verbose?: boolean } = {},
): string {
  if (options.json) return JSON.stringify(payload, null, 2);

  const visibleHints = visibleActionHints(payload, { verbose: Boolean(options.verbose) });
  const readiness = readinessEntries(payload.readiness_summary);
  const badReadinessCount = readiness.filter(([, item]) => item.status === 'bad').length;
  const okReadinessCount = readiness.filter(([, item]) => item.status === 'ok').length;
  const queueTone = readinessTone(badReadinessCount, okReadinessCount);
  const lines = [
    kleur.bold(kleur.cyan('COLONY HEALTH')),
    kleur.cyan('='.repeat(HEALTH_HEADER_WIDTH)),
    kleur.dim(`window: last ${payload.window_hours}h`),
    '',
    healthSectionHeading('At a glance', queueTone),
    ...formatAtAGlance(payload, visibleHints),
    '',
    healthSectionHeading('Health focus', visibleHints.length > 0 ? 'red' : 'green'),
    ...formatHealthFocus(payload, visibleHints),
    '',
    healthSectionHeading('Readiness summary', 'blue'),
    ...formatReadinessSummary(payload.readiness_summary),
    '',
    healthSectionHeading('Next fixes', visibleHints.length > 0 ? 'yellow' : 'green'),
    ...formatNextFixes(payload, visibleHints),
  ];

  if (options.prompts) {
    lines.push(
      '',
      healthSectionHeading('Codex prompt snippets', 'magenta'),
      ...formatPromptSnippets(visibleHints),
    );
  }

  if (!options.verbose) return lines.join('\n');

  lines.push(
    '',
    healthSectionHeading('Detailed diagnostics', 'cyan'),
    kleur.dim('  Telemetry below explains the action plan above. Use --json for automation.'),
    '',
    healthSubheading('Colony MCP share', 'cyan'),
    `  all tools: ${countRatio(
      payload.colony_mcp_share.colony_mcp_tool_calls,
      payload.colony_mcp_share.total_tool_calls,
      payload.colony_mcp_share.share_of_all_tool_calls,
    )}`,
    `  MCP tools: ${countRatio(
      payload.colony_mcp_share.colony_mcp_tool_calls,
      payload.colony_mcp_share.mcp_tool_calls,
      payload.colony_mcp_share.share_of_mcp_tool_calls,
    )}`,
  );

  if (payload.colony_mcp_share.source_breakdown.codex_rollouts > 0) {
    lines.push(
      kleur.dim(
        `  sources:   colony obs ${payload.colony_mcp_share.source_breakdown.colony_observations}, codex rollouts ${payload.colony_mcp_share.source_breakdown.codex_rollouts}`,
      ),
    );
  }

  lines.push('', healthSubheading('MCP capability map', 'blue'));
  if (payload.mcp_capability_map.summary.length === 0) {
    lines.push(kleur.dim('  none configured'));
  } else {
    for (const summary of payload.mcp_capability_map.summary.slice(0, HEALTH_TOOL_LIMIT)) {
      lines.push(`  ${summary}`);
    }
    if (payload.mcp_capability_map.summary.length > HEALTH_TOOL_LIMIT) {
      lines.push(
        kleur.dim(
          `  +${payload.mcp_capability_map.summary.length - HEALTH_TOOL_LIMIT} more configured MCP server(s)`,
        ),
      );
    }
  }

  // When the window has tool calls but none look like MCP, the recording layer
  // is almost certainly bypassing colony's PostToolUse hook for this editor —
  // surface the actual top tools so the zero-state is debuggable instead of
  // silent.
  if (
    payload.colony_mcp_share.mcp_tool_calls === 0 &&
    payload.colony_mcp_share.total_tool_calls > 0
  ) {
    lines.push(
      kleur.yellow(
        '  no mcp__ tool calls in window — colony hook may not be wired into this editor session',
      ),
    );
    if (payload.colony_mcp_share.top_tools.length > 0) {
      const summary = payload.colony_mcp_share.top_tools
        .map((entry) => `${entry.tool} (${entry.calls})`)
        .join(', ');
      lines.push(`  top recorded tools: ${summary}`);
    }
  }

  lines.push('', healthSubheading('Loop adoption', 'magenta'));

  for (const item of Object.values(payload.conversions)) {
    lines.push(
      `  ${item.from_tool} -> ${item.to_tool}: ${countRatio(
        item.converted_sessions,
        item.from_sessions,
        item.conversion_rate,
      )} sessions (${item.from_calls} -> ${item.to_calls} calls)`,
    );
  }

  lines.push(
    '',
    healthSubheading('task_list vs task_ready_for_agent', 'cyan'),
    `  task_list:            ${payload.task_list_vs_task_ready_for_agent.task_list_calls}`,
    `  task_ready_for_agent: ${payload.task_list_vs_task_ready_for_agent.task_ready_for_agent_calls}`,
    `  task_list-first sessions: ${payload.task_list_vs_task_ready_for_agent.task_list_first_sessions}`,
    `  ready share:          ${formatPercent(payload.task_list_vs_task_ready_for_agent.task_ready_share)}`,
    '',
    healthSubheading('task_post vs task_message', 'magenta'),
    `  task_post:    ${payload.task_post_vs_task_message.task_post_calls}`,
    `  task_message: ${payload.task_post_vs_task_message.task_message_calls}`,
    `  message share: ${formatPercent(payload.task_post_vs_task_message.task_message_share)}`,
    '',
    healthSubheading('task_post vs OMX notepad', 'blue'),
    `  status:              ${payload.task_post_vs_omx_notepad.status}`,
    `  task_post:           ${payload.task_post_vs_omx_notepad.task_post_calls}`,
    `  task_note_working:   ${payload.task_post_vs_omx_notepad.task_note_working_calls}`,
    `  colony note calls:   ${payload.task_post_vs_omx_notepad.colony_note_calls}`,
    `  omx writes:          ${payload.task_post_vs_omx_notepad.omx_notepad_write_calls}`,
    `  task_post share:     ${formatPercent(payload.task_post_vs_omx_notepad.task_post_share)}`,
    `  colony note share:   ${formatPercent(payload.task_post_vs_omx_notepad.colony_note_share)}`,
    '',
    healthSubheading('OMX runtime bridge', 'green'),
    `  status:              ${payload.omx_runtime_bridge.status}`,
    `  summaries ingested:  ${payload.omx_runtime_bridge.summaries_ingested}`,
    `  latest summary age:  ${formatDuration(payload.omx_runtime_bridge.latest_summary_age_ms)}`,
    `  warnings:            ${payload.omx_runtime_bridge.warning_count}`,
    `  active sessions:     ${payload.omx_runtime_bridge.active_sessions}`,
    `  recent edit paths:   ${payload.omx_runtime_bridge.recent_edit_paths.length ? payload.omx_runtime_bridge.recent_edit_paths.join(', ') : 'none'}`,
    `  malformed summaries: ${payload.omx_runtime_bridge.malformed_summary_count}`,
    ...formatMalformedSummaryExamples(payload.omx_runtime_bridge.malformed_summary_examples),
    '',
    healthSubheading('Search calls per session', 'cyan'),
    `  total: ${payload.search_calls_per_session.total_search_calls}`,
    `  avg per active session: ${formatNumber(
      payload.search_calls_per_session.average_per_active_session,
    )}`,
  );

  if (payload.search_calls_per_session.sessions.length === 0) {
    lines.push(kleur.dim('  none'));
  } else {
    for (const row of payload.search_calls_per_session.sessions) {
      lines.push(`  ${shortSession(row.session_id).padEnd(16)} ${row.calls}`);
    }
  }

  lines.push('', healthSubheading('task_claim_file before edits', 'yellow'));
  lines.push(...formatClaimBeforeEdit(payload.task_claim_file_before_edits));

  lines.push('', healthSubheading('Live contention health', 'red'));
  lines.push(...formatLiveContention(payload.live_contention_health));

  lines.push(
    '',
    healthSubheading('Signal health', 'yellow'),
    `  total claims:     ${payload.signal_health.total_claims}`,
    `  active claims:    ${payload.signal_health.active_claims}`,
    `  stale claims:     ${payload.signal_health.stale_claims} (>${payload.signal_health.stale_claim_minutes}m)`,
    `  expired/weak:     ${payload.signal_health.expired_claims}`,
    `  quota pending:    ${payload.signal_health.quota_pending_claims}`,
    `  quota expired:    ${payload.signal_health.expired_quota_pending_claims}`,
    `  quota top action: ${formatQuotaRelayTopAction(payload.signal_health.quota_relay_actions, {
      verbose: true,
    })}`,
    ...(options.verbose
      ? formatQuotaRelayExamples(payload.signal_health.quota_relay_examples)
      : []),
    `  expired handoffs: ${payload.signal_health.expired_handoffs}`,
    `  expired messages: ${payload.signal_health.expired_messages}`,
    '',
    healthSubheading('Proposal decay/promotions', 'magenta'),
    `  proposals seen:      ${payload.proposal_health.proposals_seen}`,
    `  pending:             ${payload.proposal_health.pending}`,
    `  promoted:            ${payload.proposal_health.promoted}`,
    `  evaporated:          ${payload.proposal_health.evaporated}`,
    `  below noise floor:   ${payload.proposal_health.pending_below_noise_floor}`,
    `  promotion rate:      ${formatPercent(payload.proposal_health.promotion_rate)}`,
    '',
    healthSubheading('Ready-to-claim vs claimed', 'cyan'),
    `  plan subtasks:       ${payload.ready_to_claim_vs_claimed.plan_subtasks}`,
    `  ready to claim:      ${payload.ready_to_claim_vs_claimed.ready_to_claim}`,
    `  claimed:             ${payload.ready_to_claim_vs_claimed.claimed}`,
    `  ready/claimed:       ${formatNumber(payload.ready_to_claim_vs_claimed.ready_to_claim_per_claimed)}`,
    `  claimed actionable:  ${formatPercent(payload.ready_to_claim_vs_claimed.claimed_share_of_actionable)}`,
    '',
    healthSubheading('Queen wave plans', 'blue'),
    `  active plans:                       ${payload.queen_wave_health.active_plans}`,
    `  completed plans:                    ${payload.queen_wave_health.completed_plans}`,
    `  archived plans:                     ${payload.queen_wave_health.archived_plans}`,
    `  archived with remaining subtasks:   ${payload.queen_wave_health.archived_plans_with_remaining_subtasks}`,
    `  orphan subtasks:                    ${payload.queen_wave_health.orphan_subtasks}`,
    `  inactive plans with remaining:      ${payload.queen_wave_health.inactive_plans_with_remaining_subtasks}`,
    `  current wave:                       ${payload.queen_wave_health.current_wave ?? 'n/a'}`,
    `  ready subtasks:                     ${payload.queen_wave_health.ready_subtasks}`,
    `  claimed subtasks:                   ${payload.queen_wave_health.claimed_subtasks}`,
    `  blocked subtasks:                   ${payload.queen_wave_health.blocked_subtasks}`,
    `  stale claims blocking downstream:   ${payload.queen_wave_health.stale_claims_blocking_downstream}`,
    `  quota handoffs blocking downstream: ${payload.queen_wave_health.quota_handoffs_blocking_downstream}`,
  );
  if (payload.queen_wave_health.replacement_recommendation) {
    const rec = payload.queen_wave_health.replacement_recommendation;
    lines.push(
      `  recommended replacement:           ${rec.recommended_replacement_agent} (${rec.reason}; next ${rec.next_tool})`,
    );
  }

  if (payload.queen_wave_health.plans.length === 0) {
    lines.push(kleur.dim('  plans: none active'));
  } else {
    for (const plan of payload.queen_wave_health.plans.slice(0, HEALTH_TOOL_LIMIT)) {
      lines.push(
        `  ${plan.plan_slug}: current ${plan.current_wave ?? 'complete'}; ready ${plan.ready_subtasks}, claimed ${plan.claimed_subtasks}, blocked ${plan.blocked_subtasks}, stale blockers ${plan.stale_claims_blocking_downstream}, quota blockers ${plan.quota_handoffs_blocking_downstream}`,
      );
    }
  }
  if (payload.queen_wave_health.plan_state_recommendations.length > 0) {
    lines.push('  plan-state recommendations:');
    for (const item of payload.queen_wave_health.plan_state_recommendations.slice(
      0,
      HEALTH_TOOL_LIMIT,
    )) {
      lines.push(
        `    ${item.plan_slug} ${item.state}: ${item.recommendation.action} - ${item.recommendation.summary}`,
      );
      if (item.recommendation.command) {
        lines.push(kleur.dim(`      cmd:  ${item.recommendation.command}`));
      }
      if (item.recommendation.tool_call) {
        lines.push(kleur.dim(`      tool: ${item.recommendation.tool_call}`));
      }
    }
  }
  if (payload.queen_wave_health.downstream_blockers.length > 0) {
    lines.push('  stale downstream blockers:');
    for (const blocker of payload.queen_wave_health.downstream_blockers.slice(
      0,
      HEALTH_TOOL_LIMIT,
    )) {
      lines.push(
        `    ${blocker.plan_slug}/sub-${blocker.subtask_index} task #${blocker.task_id} ${blocker.file_path} owner=${blocker.owner_session_id} age=${blocker.age_minutes}m -> unlock candidate sub-${blocker.unlock_candidate.subtask_index}`,
      );
      const replacement = payload.queen_wave_health.replacement_recommendation;
      if (replacement) {
        lines.push(
          `    replacement: ${replacement.recommended_replacement_agent} - ${replacement.reason}`,
        );
      }
    }
  }

  lines.push('', healthSubheading('Adoption thresholds', 'green'));
  for (const signal of payload.adoption_thresholds.good) {
    lines.push(formatSignal(signal));
  }
  for (const signal of payload.adoption_thresholds.bad) {
    lines.push(formatSignal(signal));
  }

  return lines.join('\n');
}

function readinessSummaryPayload(
  payload: ColonyHealthPayloadWithoutHints,
): ReadinessSummaryPayload {
  const mcpShare = payload.colony_mcp_share.share_of_mcp_tool_calls;
  const hivemindToInbox = payload.conversions.hivemind_context_to_attention_inbox;
  const hasCoordinationSignals =
    payload.colony_mcp_share.colony_mcp_tool_calls > 0 ||
    hivemindToInbox.from_calls > 0 ||
    hivemindToInbox.to_calls > 0;
  const coordinationStatus: ReadinessStatus =
    mcpShare !== null &&
    mcpShare > 0 &&
    isAtOrAboveTarget(hivemindToInbox.conversion_rate, TARGET_HIVEMIND_TO_ATTENTION)
      ? 'good'
      : hasCoordinationSignals
        ? 'ok'
        : 'bad';

  const claimBeforeEdit = payload.task_claim_file_before_edits;
  const liveContention = payload.live_contention_health;
  const hasLiveContentionFailure =
    liveContention.live_file_contentions > 0 ||
    liveContention.protected_file_contentions > 0 ||
    liveContention.dirty_contended_files > 0;
  // `old_telemetry_pollution` represents stale 24h data, not an active
  // failure. When the recent window is healthy and nothing else is on
  // fire, the readiness status should de-escalate to 'ok' so operators
  // are not nagged to "fix" a bridge that is already fine. Any other
  // root cause keeps the 'bad' status — those reflect real, current
  // bridge problems.
  const onlyOldTelemetryPollution =
    !hasLiveContentionFailure &&
    !claimBeforeEdit.codex_rollout_without_bridge &&
    claimBeforeEdit.session_binding_missing === 0 &&
    claimBeforeEdit.root_cause?.kind === 'old_telemetry_pollution' &&
    claimBeforeEdit.recent_claim_before_edit_rate !== null &&
    isAtOrAboveTarget(claimBeforeEdit.recent_claim_before_edit_rate, TARGET_CLAIM_BEFORE_EDIT);
  const executionStatus: ReadinessStatus = onlyOldTelemetryPollution
    ? 'ok'
    : hasLiveContentionFailure ||
        claimBeforeEdit.codex_rollout_without_bridge ||
        claimBeforeEdit.root_cause !== null ||
        claimBeforeEdit.session_binding_missing > 0
      ? 'bad'
      : claimBeforeEdit.claim_before_edit_ratio !== null
        ? isAtOrAboveTarget(claimBeforeEdit.claim_before_edit_ratio, TARGET_CLAIM_BEFORE_EDIT)
          ? 'good'
          : 'bad'
        : claimBeforeEdit.edit_tool_calls === 0 || claimBeforeEdit.task_claim_file_calls > 0
          ? 'ok'
          : 'bad';

  const queen = payload.queen_wave_health;
  const brokenPlanState =
    queen.orphan_subtasks > 0 ||
    queen.inactive_plans_with_remaining_subtasks > 0 ||
    queen.archived_plans_with_remaining_subtasks > 0;
  const readyUnclaimedPlan = firstReadyUnclaimedQueenPlan(queen);
  const queenStatus: ReadinessStatus = brokenPlanState
    ? 'bad'
    : queen.active_plans > 0
      ? readyUnclaimedPlan
        ? 'bad'
        : queen.ready_subtasks + queen.claimed_subtasks > 0
          ? 'good'
          : 'ok'
      : queen.completed_plans > 0 || queen.archived_plans > 0
        ? 'ok'
        : 'bad';

  const noteMigration = payload.task_post_vs_omx_notepad;
  const noteStatus: ReadinessStatus =
    noteMigration.colony_note_share !== null
      ? isAtOrAboveTarget(noteMigration.colony_note_share, TARGET_COLONY_NOTE_SHARE)
        ? 'good'
        : 'bad'
      : noteMigration.status === 'unavailable'
        ? 'ok'
        : 'bad';

  const signals = payload.signal_health;
  const signalStatus: ReadinessStatus =
    signals.stale_claims === 0 &&
    signals.quota_pending_claims === 0 &&
    queen.stale_claims_blocking_downstream === 0 &&
    queen.quota_handoffs_blocking_downstream === 0
      ? signals.expired_handoffs === 0 && signals.expired_messages === 0
        ? 'good'
        : 'ok'
      : 'bad';

  return {
    coordination_readiness: {
      status: coordinationStatus,
      evidence: `MCP share ${formatPercent(mcpShare)}; hivemind->inbox ${formatPercent(
        hivemindToInbox.conversion_rate,
      )} (target ${formatPercent(TARGET_HIVEMIND_TO_ATTENTION)}+)`,
    },
    execution_safety: {
      status: executionStatus,
      // When the all-time ratio cannot be computed (status !== 'available'
      // because some edits lacked file_path metadata) but the recent
      // window has enough samples to score, surface the recent rate so
      // operators see real signal instead of a bare `n/a`. The headline
      // still leads with `n/a` so the gating reason stays visible.
      evidence:
        claimBeforeEdit.claim_before_edit_ratio === null &&
        claimBeforeEdit.recent_claim_before_edit_rate !== null
          ? `claim-before-edit n/a (recent ${claimBeforeEdit.recent_window_hours}h: ${formatPercent(claimBeforeEdit.recent_claim_before_edit_rate)}; target ${formatPercent(TARGET_CLAIM_BEFORE_EDIT)}+); live contentions ${liveContention.live_file_contentions}, dirty ${liveContention.dirty_contended_files}`
          : `claim-before-edit ${formatPercent(
              claimBeforeEdit.claim_before_edit_ratio,
            )} (target ${formatPercent(TARGET_CLAIM_BEFORE_EDIT)}+); live contentions ${liveContention.live_file_contentions}, dirty ${liveContention.dirty_contended_files}`,
      ...(claimBeforeEdit.root_cause ? { root_cause: claimBeforeEdit.root_cause } : {}),
    },
    queen_plan_readiness: {
      status: queenStatus,
      evidence: `${queen.active_plans} active plan(s); ${queen.ready_subtasks} ready, ${queen.claimed_subtasks} claimed; completed plans ${queen.completed_plans}, archived plans with remaining subtasks ${queen.archived_plans_with_remaining_subtasks}, orphan subtasks ${queen.orphan_subtasks}, inactive remaining ${queen.inactive_plans_with_remaining_subtasks}`,
    },
    working_state_migration: {
      status: noteStatus,
      evidence: `colony note share ${formatPercent(
        noteMigration.colony_note_share,
      )} (target ${formatPercent(TARGET_COLONY_NOTE_SHARE)}+)`,
    },
    signal_evaporation: {
      status: signalStatus,
      evidence: `${signals.stale_claims} stale claim(s); ${signals.quota_pending_claims} quota-pending claim(s); ${queen.stale_claims_blocking_downstream} stale downstream blocker(s); ${queen.quota_handoffs_blocking_downstream} quota downstream blocker(s)`,
    },
  };
}

function formatNextFixes(payload: ColonyHealthPayload, visibleHints: ActionHint[]): string[] {
  if (visibleHints.length === 0) {
    if (payload.action_hints.length > 0) {
      return [
        kleur.green('  none: readiness bottlenecks meet current targets'),
        kleur.dim('  hidden: lower-priority follow-ups available with --verbose'),
      ];
    }
    return [kleur.green('  none: tracked thresholds meet targets')];
  }

  return visibleHints.flatMap((hint, index) => {
    const lines = [
      `  ${index + 1}. ${hint.metric}: ${hint.current} (target ${hint.target}) - ${hint.action}`,
      `     now: ${hint.current}`,
      `     target: ${hint.target}`,
      `     next: ${hint.action}`,
    ];
    if (hint.tool_call) lines.push(kleur.dim(`     tool: ${hint.tool_call}`));
    if (hint.command) lines.push(kleur.dim(`     cmd:  ${hint.command}`));
    return lines;
  });
}

function healthSectionHeading(title: string, tone: HealthHeadingTone): string {
  return kleur.bold(colorHealthHeading(paddedHealthHeading(title, '='), tone));
}

function healthSubheading(title: string, tone: HealthHeadingTone): string {
  return colorHealthHeading(paddedHealthHeading(title, '-'), tone);
}

function paddedHealthHeading(title: string, fill: '=' | '-'): string {
  const prefix = `${title} `;
  return `${prefix}${fill.repeat(Math.max(3, HEALTH_HEADER_WIDTH - prefix.length))}`;
}

function readinessTone(badCount: number, okCount: number): HealthHeadingTone {
  if (badCount > 0) return 'red';
  if (okCount > 0) return 'yellow';
  return 'green';
}

function colorHealthHeading(value: string, tone: HealthHeadingTone): string {
  if (tone === 'blue') return kleur.blue(value);
  if (tone === 'cyan') return kleur.cyan(value);
  if (tone === 'green') return kleur.green(value);
  if (tone === 'magenta') return kleur.magenta(value);
  if (tone === 'red') return kleur.red(value);
  return kleur.yellow(value);
}

function formatPromptSnippets(visibleHints: ActionHint[]): string[] {
  if (visibleHints.length === 0) return [kleur.green('  none: tracked thresholds meet targets')];
  return visibleHints.map((hint, index) => `  ${index + 1}. ${hint.prompt}`);
}

function formatAtAGlance(payload: ColonyHealthPayload, visibleHints: ActionHint[]): string[] {
  const entries = readinessEntries(payload.readiness_summary);
  const bad = entries.filter(([, item]) => item.status === 'bad');
  const ok = entries.filter(([, item]) => item.status === 'ok');
  const topHint = visibleHints[0];
  const nextStep = topHint ? preferredAction(topHint) : null;
  const needsWork =
    bad.length > 0 ? bad.map(([scope]) => READINESS_LABELS[scope]).join(', ') : 'none';
  const lines = [
    `  overall: ${formatOverallReadiness(bad.length, ok.length)}`,
    `  needs work: ${needsWork}`,
  ];

  if (topHint) {
    lines.push(
      `  fix first: ${topHint.metric}`,
      `  why: ${topHint.current}`,
      `  next: ${topHint.action}`,
    );
    lines.push(`  command: ${nextStep ?? 'none'}`);
  } else {
    lines.push(
      '  fix first: none',
      '  why: tracked thresholds meet targets',
      '  next: keep current loop',
      '  command: none',
    );
  }

  lines.push('  areas:');
  for (const [scope, item] of entries) {
    lines.push(`    ${formatReadinessBadge(item.status)} ${READINESS_LABELS[scope]} (${scope})`);
  }
  return lines;
}

function formatHealthFocus(payload: ColonyHealthPayload, visibleHints: ActionHint[]): string[] {
  const entries = readinessEntries(payload.readiness_summary);
  const bad = entries.filter(([, item]) => item.status === 'bad');
  const ok = entries.filter(([, item]) => item.status === 'ok');
  const topHint = visibleHints[0];
  const lines = [
    `  status: ${formatHealthFocusStatus(bad.length, ok.length)}`,
    `  bad areas: ${bad.length > 0 ? bad.map(([scope]) => scope).join(', ') : 'none'}`,
  ];

  if (!topHint) {
    lines.push('  top blocker: none', '  next action: none');
    return lines;
  }

  lines.push(
    `  top blocker: ${topHint.metric}: ${topHint.current}`,
    `  next action: ${topHint.action}`,
  );
  if (topHint.tool_call) lines.push(kleur.dim(`  tool: ${topHint.tool_call}`));
  if (topHint.command) lines.push(kleur.dim(`  cmd:  ${topHint.command}`));

  const nextCommands = visibleHints
    .map((hint) => {
      const action = preferredAction(hint);
      return action ? `    ${hint.readiness_scope}: ${action}` : null;
    })
    .filter((line): line is string => line !== null);
  if (nextCommands.length > 0) {
    lines.push('  next commands:', ...nextCommands);
  }
  if (payload.task_claim_file_before_edits.reason) {
    lines.push(...formatClaimBeforeEditMeasurement(payload.task_claim_file_before_edits));
  }

  return lines;
}

function formatHealthFocusStatus(badCount: number, okCount: number): string {
  if (badCount > 0) return `${badCount} bad readiness area(s)`;
  if (okCount > 0) return `${okCount} watch readiness area(s)`;
  return 'clear';
}

function readinessEntries(
  summary: ReadinessSummaryPayload,
): Array<[ReadinessSummaryKey, ReadinessSummaryItem]> {
  return Object.entries(summary) as Array<[ReadinessSummaryKey, ReadinessSummaryItem]>;
}

function formatOverallReadiness(badCount: number, okCount: number): string {
  if (badCount > 0)
    return kleur.red(`needs attention (${badCount} area${badCount === 1 ? '' : 's'})`);
  if (okCount > 0) return kleur.yellow(`watch (${okCount} area${okCount === 1 ? '' : 's'})`);
  return kleur.green('ready');
}

function preferredAction(hint: ActionHint): string | null {
  if (hint.command) return `cmd: ${hint.command}`;
  if (hint.tool_call) return `tool: ${hint.tool_call}`;
  return null;
}

function formatReadinessBadge(status: ReadinessStatus): string {
  if (status === 'good') return kleur.green('[ready]');
  if (status === 'bad') return kleur.red('[fix]');
  return kleur.yellow('[watch]');
}

function formatReadinessSummary(summary: ReadinessSummaryPayload): string[] {
  return [
    ...formatReadinessItem('coordination_readiness', summary.coordination_readiness),
    ...formatReadinessItem('execution_safety', summary.execution_safety),
    ...formatReadinessItem('queen_plan_readiness', summary.queen_plan_readiness),
    ...formatReadinessItem('working_state_migration', summary.working_state_migration),
    ...formatReadinessItem('signal_evaporation', summary.signal_evaporation),
  ];
}

function formatReadinessItem(label: ReadinessSummaryKey, item: ReadinessSummaryItem): string[] {
  const lines = [
    `  ${formatReadinessStatus(item.status)} ${READINESS_LABELS[label]} (${label})`,
    `    evidence: ${item.evidence}`,
  ];
  if (item.root_cause) {
    lines.push(
      `    root cause: ${item.root_cause.summary}`,
      `    evidence: ${item.root_cause.evidence}`,
      `    action: ${item.root_cause.action}`,
    );
    if (item.root_cause.command) {
      lines.push(`    cmd:  ${item.root_cause.command}`);
    }
  }
  return lines;
}

function formatReadinessStatus(status: ReadinessStatus): string {
  const label = status.padEnd(4);
  if (status === 'good') return kleur.green(label);
  if (status === 'bad') return kleur.red(label);
  return kleur.yellow(label);
}

function formatQuotaRelayTopAction(
  actions: QuotaRelayActionsPayload,
  options: { verbose?: boolean } = {},
): string {
  if (!actions.top_example || actions.top_action === 'none') return 'none';
  return `${actions.top_action} task ${actions.top_example.task_id} ${actions.top_example.baton_kind} #${actions.top_example.handoff_observation_id} (${formatQuotaRelayFiles(actions.top_example.files, options)})`;
}

function formatQuotaRelayExamples(examples: QuotaRelayExample[]): string[] {
  if (examples.length === 0) return [kleur.dim('  quota relay examples: none')];
  const lines = ['  quota relay examples:'];
  for (const example of examples) {
    lines.push(
      `    - task_id=${example.task_id} old_owner=${example.old_owner} age=${formatDuration(
        example.age_ms,
      )} files=${formatQuotaRelayFiles(example.files, { verbose: true })} state=${example.state} recommended_action=${example.recommended_action}`,
    );
    if (example.tool_call) lines.push(kleur.dim(`      tool: ${example.tool_call}`));
    if (example.decline_tool_call) {
      lines.push(kleur.dim(`      decline/reroute: ${example.decline_tool_call}`));
    }
    lines.push(kleur.dim(`      cmd:  ${example.command}`));
  }
  return lines;
}

function formatQuotaRelayFiles(files: string[], options: { verbose?: boolean } = {}): string {
  if (files.length === 0) return '-';
  const previewLimit = options.verbose ? files.length : QUOTA_RELAY_FILE_PREVIEW_LIMIT;
  const preview = files.slice(0, previewLimit);
  const remaining = files.length - preview.length;
  const suffix = remaining > 0 ? `, +${remaining} more` : '';
  const label = files.length === 1 ? 'file' : 'files';
  const formattedPreview = options.verbose ? preview : preview.map(formatDefaultHealthText);
  return `${files.length} ${label}: ${formattedPreview.join(', ')}${suffix}`;
}

function formatDefaultHealthText(value: string): string {
  if (value.length <= DEFAULT_HEALTH_TEXT_LIMIT) return value;
  const ellipsis = '...';
  const available = DEFAULT_HEALTH_TEXT_LIMIT - ellipsis.length;
  const head = Math.ceil(available / 2);
  const tail = Math.floor(available / 2);
  return `${value.slice(0, head)}${ellipsis}${value.slice(value.length - tail)}`;
}

function formatMalformedSummaryExamples(
  examples: OmxRuntimeBridgePayload['malformed_summary_examples'],
): string[] {
  if (examples.length === 0) return [];
  const lines = ['  malformed summary examples:'];
  for (const example of examples) {
    lines.push(
      `    ${example.path} (modified ${example.modified_time ?? 'unknown'}): ${example.error}`,
      `      schema: ${formatJsonPrimitive(example.schema_value)}`,
      `      missing required fields: ${example.missing_required_fields.length ? example.missing_required_fields.join(', ') : 'none'}`,
      `      invalid field types: ${formatMalformedFieldTypes(example.invalid_field_types)}`,
    );
  }
  return lines;
}

function formatMalformedFieldTypes(
  fields: OmxRuntimeBridgePayload['malformed_summary_examples'][number]['invalid_field_types'],
): string {
  if (fields.length === 0) return 'none';
  return fields
    .map((field) => `${field.field} expected ${field.expected} got ${field.actual}`)
    .join('; ');
}

function formatJsonPrimitive(value: string | number | boolean | null): string {
  return value === null ? 'null' : String(value);
}

export function registerHealthCommand(program: Command): void {
  program
    .command('health')
    .description('Show Colony adoption ratios from local DB evidence')
    .option('--hours <n>', 'Window size in hours', String(DEFAULT_HOURS))
    .option(
      '--recent-window-hours <n>',
      'Recent execution-safety subwindow in hours',
      String(DEFAULT_RECENT_WINDOW_HOURS),
    )
    .option(
      '--repo-root <path>',
      'repo root for fix-plan sweep commands (defaults to process.cwd())',
    )
    .option('--json', 'emit structured JSON')
    .option('--prompts', 'emit compact Codex prompt snippets for next fixes')
    .option('--verbose', 'show detailed diagnostics and lower-priority health follow-ups')
    .option(
      '--fix-plan',
      'print an execution-safety recovery plan instead of the full health report',
    )
    .option(
      '--apply',
      'with --fix-plan, run coordination and queen sweeps; claim cleanup requires --release-safe-stale-claims',
    )
    .option(
      '--release-safe-stale-claims',
      'with --fix-plan --apply, release only safe stale claims through the coordination sweep',
    )
    .option(
      '--merge-repo-store',
      'merge claim-before-edit signals from <repo_root>/.omx/colony-home/data.db when present (covers per-repo COLONY_HOME redirects)',
    )
    .action(
      async (opts: {
        hours: string;
        recentWindowHours: string;
        repoRoot?: string;
        json?: boolean;
        prompts?: boolean;
        verbose?: boolean;
        fixPlan?: boolean;
        apply?: boolean;
        releaseSafeStaleClaims?: boolean;
        mergeRepoStore?: boolean;
      }) => {
        const hours = parseHours(opts.hours);
        const recentWindowHours = parseHours(opts.recentWindowHours);
        const settings = loadSettings();
        const repoRoot = resolve(opts.repoRoot ?? process.cwd());
        const repoStorePath =
          opts.mergeRepoStore === true ? join(repoRoot, '.omx', 'colony-home', 'data.db') : null;
        const repoStorePathToMerge =
          repoStorePath !== null && existsSync(repoStorePath) ? repoStorePath : null;

        if (opts.fixPlan === true) {
          const { withStore } = await import('../util/store.js');
          await withStore(settings, async (store) => {
            await withMergedRepoStorages(
              repoStorePathToMerge,
              async (mergeStorages, mergedRepoStores) => {
                const payload = buildColonyHealthPayload(store.storage, {
                  since: Date.now() - hours * 3_600_000,
                  window_hours: hours,
                  recent_window_hours: recentWindowHours,
                  claim_stale_minutes: settings.claimStaleMinutes,
                  repo_root: repoRoot,
                  merge_storages: mergeStorages,
                  merged_repo_stores: mergedRepoStores,
                });
                const coordinationSweep =
                  opts.apply === true
                    ? buildCoordinationSweep(store, {
                        repo_root: repoRoot,
                        release_safe_stale_claims: opts.releaseSafeStaleClaims === true,
                      })
                    : undefined;
                const queenSweep =
                  opts.apply === true
                    ? sweepQueenPlans(store, {
                        repo_root: repoRoot,
                        auto_message: false,
                      })
                    : undefined;
                const fixPlan = buildHealthFixPlan(payload, {
                  repo_root: repoRoot,
                  apply: opts.apply === true,
                  release_safe_stale_claims: opts.releaseSafeStaleClaims === true,
                  ...(coordinationSweep !== undefined
                    ? { coordination_sweep: coordinationSweep }
                    : {}),
                  ...(queenSweep !== undefined ? { queen_sweep: queenSweep } : {}),
                });
                process.stdout.write(
                  `${opts.json === true ? JSON.stringify(fixPlan, null, 2) : formatHealthFixPlanOutput(fixPlan)}\n`,
                );
              },
            );
          });
          return;
        }

        const { withStorage } = await import('../util/store.js');
        await withStorage(
          settings,
          async (storage) => {
            await withMergedRepoStorages(
              repoStorePathToMerge,
              async (mergeStorages, mergedRepoStores) => {
                const payload = buildColonyHealthPayload(storage, {
                  since: Date.now() - hours * 3_600_000,
                  window_hours: hours,
                  recent_window_hours: recentWindowHours,
                  claim_stale_minutes: settings.claimStaleMinutes,
                  repo_root: repoRoot,
                  merge_storages: mergeStorages,
                  merged_repo_stores: mergedRepoStores,
                });
                const formatOptions = opts.json
                  ? { json: true }
                  : { prompts: Boolean(opts.prompts), verbose: Boolean(opts.verbose) };
                process.stdout.write(`${formatColonyHealthOutput(payload, formatOptions)}\n`);
              },
            );
          },
          { readonly: true },
        );
      },
    );
}

export function buildHealthFixPlan(
  payload: ColonyHealthPayload,
  options: {
    repo_root: string;
    apply: boolean;
    release_safe_stale_claims?: boolean;
    coordination_sweep?: CoordinationSweepResult;
    queen_sweep?: ReturnType<typeof sweepQueenPlans>;
  },
): HealthFixPlanPayload {
  const claim = payload.task_claim_file_before_edits;
  const preToolUseMissing = claim.claim_miss_reasons.pre_tool_use_missing;
  const preToolUseMissingDominates = isDominantPreToolUseMiss(claim.claim_miss_reasons);
  const healthCommand = `colony health --repo-root ${shellQuote(options.repo_root)} --json`;
  const coordinationCommand = `colony coordination sweep --repo-root ${shellQuote(options.repo_root)} --json`;
  const queenCommand = `colony queen sweep --repo-root ${shellQuote(options.repo_root)} --json`;
  const mutatesClaims = options.apply && options.release_safe_stale_claims === true;
  const steps: HealthFixPlanStep[] = [];

  if (preToolUseMissingDominates && !claim.old_telemetry_pollution) {
    steps.push({
      title: 'Reinstall/restart lifecycle hooks',
      status: 'suggested',
      detail:
        'pre_tool_use_missing dominates claim misses; reinstall the affected IDE hooks, then restart the operator session before trusting claim-before-edit telemetry.',
      command: 'colony install --ide codex  # then restart Codex/OMX',
    });
  } else {
    steps.push({
      title: 'Lifecycle hook reinstall',
      status: 'skipped',
      detail: 'pre_tool_use_missing does not dominate current claim misses.',
    });
  }

  steps.push({
    title: 'Inspect live contentions',
    status:
      payload.live_contention_health.live_file_contentions > 0 ||
      payload.live_contention_health.dirty_contended_files > 0
        ? 'suggested'
        : 'skipped',
    detail:
      payload.live_contention_health.live_file_contentions > 0
        ? 'Resolve same-file owners before broad verification; hand off, reclaim, or wait instead of overwriting another lane.'
        : 'No live same-file contention is visible in current health.',
    command: healthCommand,
  });
  if (payload.live_contention_health.protected_claim_action_queue.protected_claims > 0) {
    steps.push({
      title: 'Clear protected branch claims',
      status: 'suggested',
      detail: payload.live_contention_health.protected_claim_action_queue.next_action,
      command:
        payload.live_contention_health.protected_claim_action_queue.commands[0] ?? healthCommand,
    });
  }

  if (options.apply) {
    steps.push({
      title: 'Run coordination sweep',
      status: 'ran',
      detail:
        options.coordination_sweep === undefined
          ? 'Coordination sweep result was not provided.'
          : `stale=${options.coordination_sweep.summary.stale_claim_count}, expired/weak=${options.coordination_sweep.summary.expired_weak_claim_count}; mutates_claims: ${mutatesClaims}; ${options.coordination_sweep.recommended_action}`,
      command: coordinationCommand,
    });
    steps.push({
      title: 'Run queen sweep',
      status: 'ran',
      detail:
        options.queen_sweep === undefined
          ? 'Queen sweep result was not provided.'
          : queenSweepSummary(options.queen_sweep),
      command: queenCommand,
    });
  } else {
    steps.push({
      title: 'Run coordination sweep',
      status: 'planned',
      detail:
        'Dry-run only: pass --apply to run this sweep. Claim mutation stays off unless --release-safe-stale-claims is also set.',
      command: coordinationCommand,
    });
    steps.push({
      title: 'Run queen sweep',
      status: 'planned',
      detail:
        'Dry-run only: pass --apply to run this sweep. The command uses auto-message=false and does not mutate claims.',
      command: queenCommand,
    });
  }

  return {
    generated_at: payload.generated_at,
    mode: options.apply ? 'apply' : 'dry-run',
    readiness_summary: payload.readiness_summary,
    safety: {
      mutates_claims: mutatesClaims,
      installs_hooks: false,
      ran_coordination_sweep: options.apply,
      ran_queen_sweep: options.apply,
      release_safe_stale_claims: options.release_safe_stale_claims === true,
    },
    current: {
      pre_tool_use_missing: preToolUseMissing,
      pre_tool_use_missing_dominates: preToolUseMissingDominates,
      stale_claims: payload.signal_health.stale_claims,
      expired_weak_claims: payload.signal_health.expired_claims,
      live_contentions: payload.live_contention_health.live_file_contentions,
      dirty_contended_files: payload.live_contention_health.dirty_contended_files,
      stale_downstream_blockers: payload.queen_wave_health.stale_claims_blocking_downstream,
    },
    steps,
    verification_commands: [
      healthCommand,
      coordinationCommand,
      queenCommand,
      'pnpm smoke:codex-omx-pretool',
    ],
    coordination_sweep: options.coordination_sweep,
    queen_sweep: options.queen_sweep,
  };
}

export function formatHealthFixPlanOutput(plan: HealthFixPlanPayload): string {
  const claimSafety = plan.safety.mutates_claims
    ? 'releases only safe stale claims; skips dirty, active-session, and downstream-blocking claims; preserves audit observations'
    : 'does not release claims';
  const lines = [
    kleur.bold('colony health --fix-plan'),
    `mode: ${plan.mode}${plan.mode === 'dry-run' ? ' (no sweeps run)' : ' (sweeps run)'}`,
    `safety: mutates_claims: ${plan.safety.mutates_claims}; ${claimSafety}; does not install hooks; queen sweep auto-message disabled`,
    '',
    kleur.bold('Current health'),
    `  pre_tool_use_missing: ${plan.current.pre_tool_use_missing}${plan.current.pre_tool_use_missing_dominates ? ' (dominates)' : ''}`,
    `  stale claims:         ${plan.current.stale_claims}`,
    `  expired/weak claims:  ${plan.current.expired_weak_claims}`,
    `  live contentions:     ${plan.current.live_contentions}`,
    `  dirty contended:      ${plan.current.dirty_contended_files}`,
    `  stale downstream:     ${plan.current.stale_downstream_blockers}`,
    '',
    kleur.bold('Recovery plan'),
  ];

  plan.steps.forEach((step, index) => {
    lines.push(`  ${index + 1}. [${step.status}] ${step.title}: ${step.detail}`);
    if (step.command) lines.push(kleur.dim(`     cmd: ${step.command}`));
  });

  lines.push('', kleur.bold('Verification commands'));
  for (const command of plan.verification_commands) {
    lines.push(`  ${command}`);
  }

  return lines.join('\n');
}

function queenSweepSummary(result: ReturnType<typeof sweepQueenPlans>): string {
  const items = result.flatMap((plan) => plan.items);
  const stalled = items.filter((item) => item.reason === 'stalled').length;
  const unclaimed = items.filter((item) => item.reason === 'unclaimed').length;
  const ready = items.filter((item) => item.reason === 'ready-to-archive').length;
  if (items.length === 0) return 'no queen plans need attention';
  return `${result.length} plan(s) need attention; stalled=${stalled}, unclaimed=${unclaimed}, ready-to-archive=${ready}`;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function conversion(calls: ToolCallRow[], fromTool: string, toTool: string): ConversionPayload {
  const fromCalls = countTool(calls, fromTool);
  const toCalls = countTool(calls, toTool);
  const bySession = new Map<string, ToolCallRow[]>();
  for (const call of calls) {
    const bucket = bySession.get(call.session_id) ?? [];
    bucket.push(call);
    bySession.set(call.session_id, bucket);
  }

  let fromSessions = 0;
  let convertedSessions = 0;
  for (const sessionCalls of bySession.values()) {
    const firstFrom = sessionCalls.find((call) => isColonyTool(call.tool, fromTool));
    if (!firstFrom) continue;
    fromSessions++;
    if (sessionCalls.some((call) => call.ts > firstFrom.ts && isColonyTool(call.tool, toTool))) {
      convertedSessions++;
    }
  }

  return {
    from_tool: fromTool,
    to_tool: toTool,
    from_calls: fromCalls,
    to_calls: toCalls,
    from_sessions: fromSessions,
    converted_sessions: convertedSessions,
    conversion_rate: ratio(convertedSessions, fromSessions),
  };
}

function searchCallsPerSession(calls: ToolCallRow[]): SearchCallsPayload {
  const activeSessions = new Set(calls.map((call) => call.session_id)).size;
  const bySession = new Map<string, number>();
  for (const call of calls) {
    if (!isColonyTool(call.tool, 'search')) continue;
    bySession.set(call.session_id, (bySession.get(call.session_id) ?? 0) + 1);
  }
  const sessions = Array.from(bySession, ([session_id, callCount]) => ({
    session_id,
    calls: callCount,
  }))
    .sort((a, b) => b.calls - a.calls || a.session_id.localeCompare(b.session_id))
    .slice(0, HEALTH_TOOL_LIMIT);
  const totalSearchCalls = Array.from(bySession.values()).reduce((sum, count) => sum + count, 0);
  return {
    total_search_calls: totalSearchCalls,
    active_sessions: activeSessions,
    average_per_active_session: ratio(totalSearchCalls, activeSessions),
    sessions,
  };
}

function taskSelectionPayload(calls: ToolCallRow[]): TaskSelectionPayload {
  const taskListCalls = countTool(calls, 'task_list');
  const taskReadyCalls = countTool(calls, 'task_ready_for_agent');
  return {
    task_list_calls: taskListCalls,
    task_ready_for_agent_calls: taskReadyCalls,
    task_list_first_sessions: taskListFirstSessions(calls),
    task_ready_share: ratio(taskReadyCalls, taskListCalls + taskReadyCalls),
    task_ready_per_task_list: ratio(taskReadyCalls, taskListCalls),
  };
}

function taskListFirstSessions(calls: ToolCallRow[]): number {
  const bySession = new Map<string, ToolCallRow[]>();
  for (const call of calls) {
    if (!isColonyTool(call.tool, 'task_list') && !isColonyTool(call.tool, 'task_ready_for_agent')) {
      continue;
    }
    const sessionCalls = bySession.get(call.session_id) ?? [];
    sessionCalls.push(call);
    bySession.set(call.session_id, sessionCalls);
  }

  let sessions = 0;
  for (const sessionCalls of bySession.values()) {
    const first = sessionCalls.sort((left, right) => left.ts - right.ts)[0];
    if (first && isColonyTool(first.tool, 'task_list')) sessions++;
  }
  return sessions;
}

function taskPostVsNotepadPayload(
  calls: ToolCallRow[],
  taskPostCalls: number,
  taskNoteWorkingCalls: number,
): TaskPostNotepadPayload {
  const colonyNoteCalls = taskPostCalls + taskNoteWorkingCalls;
  const omxNotepadWriteCalls = calls.filter((call) => isOmxNotepadWrite(call.tool)).length;
  const hasOmxMetrics = calls.some((call) => isOmxMetricTool(call.tool));
  const status = hasOmxMetrics || omxNotepadWriteCalls > 0 ? 'available' : 'unavailable';
  return {
    status,
    task_post_calls: taskPostCalls,
    task_note_working_calls: taskNoteWorkingCalls,
    colony_note_calls: colonyNoteCalls,
    omx_notepad_write_calls: omxNotepadWriteCalls,
    task_post_share:
      status === 'available' ? ratio(taskPostCalls, taskPostCalls + omxNotepadWriteCalls) : null,
    colony_note_share:
      status === 'available'
        ? ratio(colonyNoteCalls, colonyNoteCalls + omxNotepadWriteCalls)
        : null,
  };
}

function omxRuntimeBridgePayload(
  stats: OmxRuntimeSummaryHealthStats,
  now: number,
): OmxRuntimeBridgePayload {
  return {
    ...stats,
    latest_summary_age_ms:
      stats.latest_summary_ts === null ? null : Math.max(0, now - stats.latest_summary_ts),
  };
}

function omxRuntimeSummaryStats(storage: unknown, since: number): OmxRuntimeSummaryStats {
  const maybe = storage as Partial<Pick<Storage, 'omxRuntimeSummaryStats'>>;
  return (
    maybe.omxRuntimeSummaryStats?.(since) ?? {
      status: 'unavailable',
      summaries_ingested: 0,
      latest_summary_ts: null,
      warning_count: 0,
    }
  );
}

function mergeClaimBeforeEditStats(
  base: ClaimBeforeEditStats,
  additional: ClaimBeforeEditStats[],
): ClaimBeforeEditStats {
  if (additional.length === 0) return base;
  return additional.reduce<ClaimBeforeEditStats>((acc, next) => {
    const claimMatchWindowMs = acc.claim_match_window_ms ?? next.claim_match_window_ms;
    const claimMatchSources = mergeClaimMatchSources(
      acc.claim_match_sources,
      next.claim_match_sources,
    );
    const claimMissReasons = mergeClaimMissReasons(acc.claim_miss_reasons, next.claim_miss_reasons);
    const nearestClaimExamples = [
      ...(acc.nearest_claim_examples ?? []),
      ...(next.nearest_claim_examples ?? []),
    ];
    return {
      edit_tool_calls: acc.edit_tool_calls + next.edit_tool_calls,
      edits_with_file_path: acc.edits_with_file_path + next.edits_with_file_path,
      edits_claimed_before: acc.edits_claimed_before + next.edits_claimed_before,
      auto_claimed_before_edit:
        (acc.auto_claimed_before_edit ?? 0) + (next.auto_claimed_before_edit ?? 0),
      session_binding_missing:
        (acc.session_binding_missing ?? 0) + (next.session_binding_missing ?? 0),
      pre_tool_use_signals: (acc.pre_tool_use_signals ?? 0) + (next.pre_tool_use_signals ?? 0),
      ...(claimMatchWindowMs !== undefined ? { claim_match_window_ms: claimMatchWindowMs } : {}),
      ...(claimMatchSources !== undefined ? { claim_match_sources: claimMatchSources } : {}),
      ...(claimMissReasons !== undefined ? { claim_miss_reasons: claimMissReasons } : {}),
      ...(nearestClaimExamples.length > 0 ? { nearest_claim_examples: nearestClaimExamples } : {}),
    };
  }, base);
}

function mergeClaimMatchSources(
  a: Partial<ClaimMatchSources> | undefined,
  b: Partial<ClaimMatchSources> | undefined,
): Partial<ClaimMatchSources> | undefined {
  if (a === undefined && b === undefined) return undefined;
  return {
    exact_session: (a?.exact_session ?? 0) + (b?.exact_session ?? 0),
    repo_branch: (a?.repo_branch ?? 0) + (b?.repo_branch ?? 0),
    worktree: (a?.worktree ?? 0) + (b?.worktree ?? 0),
    agent_lane: (a?.agent_lane ?? 0) + (b?.agent_lane ?? 0),
  };
}

function mergeClaimMissReasons(
  a: Partial<ClaimMissReasons> | undefined,
  b: Partial<ClaimMissReasons> | undefined,
): Partial<ClaimMissReasons> | undefined {
  if (a === undefined && b === undefined) return undefined;
  return {
    no_claim_for_file: (a?.no_claim_for_file ?? 0) + (b?.no_claim_for_file ?? 0),
    claim_after_edit: (a?.claim_after_edit ?? 0) + (b?.claim_after_edit ?? 0),
    session_id_mismatch: (a?.session_id_mismatch ?? 0) + (b?.session_id_mismatch ?? 0),
    repo_root_mismatch: (a?.repo_root_mismatch ?? 0) + (b?.repo_root_mismatch ?? 0),
    branch_mismatch: (a?.branch_mismatch ?? 0) + (b?.branch_mismatch ?? 0),
    path_mismatch: (a?.path_mismatch ?? 0) + (b?.path_mismatch ?? 0),
    worktree_path_mismatch: (a?.worktree_path_mismatch ?? 0) + (b?.worktree_path_mismatch ?? 0),
    pseudo_path_skipped: (a?.pseudo_path_skipped ?? 0) + (b?.pseudo_path_skipped ?? 0),
    pre_tool_use_missing: (a?.pre_tool_use_missing ?? 0) + (b?.pre_tool_use_missing ?? 0),
  };
}

async function withMergedRepoStorages<T>(
  repoStorePath: string | null,
  fn: (mergeStorages: ClaimBeforeEditStorage[], mergedRepoStores: string[]) => Promise<T> | T,
): Promise<T> {
  if (repoStorePath === null) return fn([], []);
  const { Storage } = await import('@colony/storage');
  const storage = new Storage(repoStorePath, { readonly: true });
  try {
    return await fn([storage], [repoStorePath]);
  } finally {
    storage.close();
  }
}

function claimBeforeEditStatsWithRuntimeSummary(
  stats: ClaimBeforeEditStats,
  runtime: OmxRuntimeSummaryHealthStats['claim_before_edit'] | undefined,
): ClaimBeforeEditStats {
  if (!runtime || runtime.measurable_edits <= 0) return stats;
  const existingPreToolUseSignals = stats.pre_tool_use_signals ?? 0;
  const syntheticHookCapableEdits = Math.max(
    runtime.hook_capable_edits - stats.edits_with_file_path,
    0,
  );
  const syntheticClaimedBefore = Math.min(
    syntheticHookCapableEdits,
    Math.max(runtime.edits_claimed_before - stats.edits_claimed_before, 0),
  );
  const syntheticPreToolUseSignals = Math.max(
    runtime.pre_tool_use_signals - existingPreToolUseSignals,
    0,
  );
  if (
    syntheticHookCapableEdits === 0 &&
    syntheticClaimedBefore === 0 &&
    syntheticPreToolUseSignals === 0
  ) {
    return stats;
  }
  return {
    ...stats,
    edit_tool_calls: stats.edit_tool_calls + syntheticHookCapableEdits,
    edits_with_file_path: stats.edits_with_file_path + syntheticHookCapableEdits,
    edits_claimed_before: stats.edits_claimed_before + syntheticClaimedBefore,
    pre_tool_use_signals: existingPreToolUseSignals + syntheticPreToolUseSignals,
  };
}

function claimBeforeEditPayload(
  stats: ClaimBeforeEditStats,
  taskClaimFileCalls: number,
  codexRolloutEdits: number,
  recent: {
    recent_stats: ClaimBeforeEditStats;
    recent_task_claim_file_calls: number;
    recent_window_hours: number;
    omx_runtime_bridge: OmxRuntimeSummaryHealthStats;
    live_file_contentions: number;
    dirty_contended_files: number;
  },
): ClaimBeforeEditPayload {
  const editsWithoutClaimBefore = stats.edits_with_file_path - stats.edits_claimed_before;
  const autoClaimedBeforeEdit = stats.auto_claimed_before_edit ?? 0;
  const preToolUseSignals = stats.pre_tool_use_signals ?? 0;
  const recentPreToolUseSignals = recent.recent_stats.pre_tool_use_signals ?? 0;
  const recentEditsWithoutClaimBefore =
    recent.recent_stats.edits_with_file_path - recent.recent_stats.edits_claimed_before;
  const recentClaimMissReasons = claimMissReasonsPayload(
    recent.recent_stats.claim_miss_reasons,
    recentEditsWithoutClaimBefore,
  );
  const sessionBindingMissing = stats.session_binding_missing ?? 0;
  const claimMatchSources = claimMatchSourcesPayload(stats.claim_match_sources);
  const claimMissReasons = claimMissReasonsPayload(
    stats.claim_miss_reasons,
    editsWithoutClaimBefore,
  );
  const codexRolloutWithoutBridge = codexRolloutEdits > 0 && preToolUseSignals === 0;
  const measurableEdits = stats.edits_with_file_path;
  const unmeasurableEdits =
    Math.max(stats.edit_tool_calls - stats.edits_with_file_path, 0) + codexRolloutEdits;
  const reason =
    measurableEdits > 0 &&
    measurableEdits < RECENT_CLAIM_BEFORE_EDIT_MIN_SAMPLE &&
    (recent.omx_runtime_bridge.status !== 'available' || unmeasurableEdits > 0)
      ? INSUFFICIENT_RUNTIME_METADATA_REASON
      : null;
  const status =
    stats.edit_tool_calls === 0
      ? 'no_data'
      : stats.edit_tool_calls === stats.edits_with_file_path
        ? 'available'
        : 'not_available';
  // If edits landed but no claim-before-edit observation was ever written,
  // PreToolUse is almost certainly not firing for the active editor.
  const likelyMissingHook =
    stats.edit_tool_calls > 0 && preToolUseSignals === 0 && !codexRolloutWithoutBridge;
  const codexRolloutHint = codexRolloutWithoutBridge
    ? 'Codex rollout edits are present, but no Codex PreToolUse signal is installed or firing. Run colony install --ide codex and restart Codex; without Codex hooks or a rollout bridge, rollout edits stay unsupported for claim-before-edit auto-claim.'
    : null;
  const rootCause = lifecycleBridgeRootCause({
    runtime_bridge_status: recent.omx_runtime_bridge.status,
    task_claim_file_calls: taskClaimFileCalls,
    edit_tool_calls: stats.edit_tool_calls,
    hook_capable_edits: stats.edits_with_file_path,
    pre_tool_use_signals: preToolUseSignals,
    recent_task_claim_file_calls: recent.recent_task_claim_file_calls,
    recent_hook_capable_edits: recent.recent_stats.edits_with_file_path,
    recent_pre_tool_use_signals: recentPreToolUseSignals,
    recent_pre_tool_use_missing: recentClaimMissReasons.pre_tool_use_missing,
    recent_claim_mismatch_count: lifecycleClaimMismatchCount(recentClaimMissReasons),
    edits_without_claim_before: editsWithoutClaimBefore,
    claim_miss_reasons: claimMissReasons,
    runtime_summary_recent_edit_paths: recent.omx_runtime_bridge.recent_edit_paths.length,
    runtime_summary_hook_capable_edits:
      recent.omx_runtime_bridge.claim_before_edit.hook_capable_edits,
    runtime_summary_pre_tool_use_signals:
      recent.omx_runtime_bridge.claim_before_edit.pre_tool_use_signals,
    live_file_contentions: recent.live_file_contentions,
    dirty_contended_files: recent.dirty_contended_files,
  });
  const sessionBindingHint =
    sessionBindingMissing > 0
      ? 'PreToolUse is firing, but Colony session binding is missing. Restart the editor session so SessionStart binds the session id; keep calling task_claim_file manually until binding is restored.'
      : null;
  const installHint =
    codexRolloutHint ??
    (rootCause !== null && rootCause.kind !== 'old_telemetry_pollution'
      ? rootCause.action
      : null) ??
    (likelyMissingHook
      ? 'PreToolUse auto-claim is not covering hook-capable edits in this window. Run colony install --ide <ide>, restart the editor session, and ensure an active task is bound for the session.'
      : sessionBindingHint);
  return {
    ...stats,
    status,
    hook_capable_edits: stats.edits_with_file_path,
    measurable_edits: measurableEdits,
    unmeasurable_edits: unmeasurableEdits,
    runtime_bridge_status: recent.omx_runtime_bridge.status,
    reason,
    task_claim_file_calls: taskClaimFileCalls,
    edits_with_claim: stats.edits_claimed_before,
    edits_missing_claim: editsWithoutClaimBefore,
    auto_claimed_before_edit: autoClaimedBeforeEdit,
    edits_without_claim_before: editsWithoutClaimBefore,
    claim_before_edit_ratio:
      status === 'available' ? ratio(stats.edits_claimed_before, stats.edits_with_file_path) : null,
    pre_tool_use_signals: preToolUseSignals,
    old_telemetry_pollution: rootCause?.kind === 'old_telemetry_pollution',
    recent_window_hours: recent.recent_window_hours,
    recent_hook_capable_edits: recent.recent_stats.edits_with_file_path,
    recent_pre_tool_use_missing: recentClaimMissReasons.pre_tool_use_missing,
    recent_pre_tool_use_signals: recentPreToolUseSignals,
    recent_claim_before_edit_rate:
      recent.recent_stats.edits_with_file_path < RECENT_CLAIM_BEFORE_EDIT_MIN_SAMPLE
        ? null
        : ratio(recent.recent_stats.edits_claimed_before, recent.recent_stats.edits_with_file_path),
    session_binding_missing: sessionBindingMissing,
    edit_source_breakdown: {
      colony_post_tool_edits: stats.edit_tool_calls,
      codex_rollout_edits: codexRolloutEdits,
      hook_capable_edits: stats.edits_with_file_path,
      pre_tool_use_signals: preToolUseSignals,
    },
    codex_rollout_without_bridge: codexRolloutWithoutBridge,
    likely_missing_hook: likelyMissingHook,
    root_cause: rootCause,
    install_hint: installHint,
    claim_match_window_ms: stats.claim_match_window_ms ?? 0,
    claim_match_sources: claimMatchSources,
    claim_miss_reasons: claimMissReasons,
    nearest_claim_examples: stats.nearest_claim_examples ?? [],
  };
}

function lifecycleBridgeRootCause(input: {
  runtime_bridge_status: OmxRuntimeBridgePayload['status'];
  task_claim_file_calls: number;
  edit_tool_calls: number;
  hook_capable_edits: number;
  pre_tool_use_signals: number;
  recent_task_claim_file_calls: number;
  recent_hook_capable_edits: number;
  recent_pre_tool_use_signals: number;
  recent_pre_tool_use_missing: number;
  recent_claim_mismatch_count: number;
  edits_without_claim_before: number;
  claim_miss_reasons: ClaimMissReasons;
  runtime_summary_recent_edit_paths: number;
  runtime_summary_hook_capable_edits: number;
  runtime_summary_pre_tool_use_signals: number;
  live_file_contentions: number;
  dirty_contended_files: number;
}): RootCauseSummary | null {
  const counters = rootCauseEvidenceCounters(input);
  const evidence = formatRootCauseEvidence(counters);
  const freshPreToolUseMissing =
    input.recent_hook_capable_edits > 0 && input.recent_pre_tool_use_missing > 0;
  const noFreshBadEdits = !freshPreToolUseMissing && input.recent_claim_mismatch_count === 0;

  if (
    input.runtime_bridge_status === 'available' &&
    input.runtime_summary_recent_edit_paths > 0 &&
    input.hook_capable_edits === 0 &&
    input.pre_tool_use_signals === 0
  ) {
    return {
      kind: 'lifecycle_summary_not_joined',
      summary: LIFECYCLE_SUMMARY_NOT_JOINED_ROOT_CAUSE,
      evidence,
      evidence_counters: counters,
      action:
        'Join runtime summary lifecycle PreToolUse/PostToolUse event metadata into claim-before-edit health before recommending lifecycle bridge reinstall.',
      command: LIFECYCLE_HEALTH_VERIFY_COMMAND,
    };
  }

  if (
    input.hook_capable_edits >= LIFECYCLE_BRIDGE_MISSING_MIN_HOOK_CAPABLE_EDITS &&
    isNearZeroPreToolUseSignals(input.pre_tool_use_signals, input.hook_capable_edits) &&
    noFreshBadEdits
  ) {
    return {
      kind: 'old_telemetry_pollution',
      summary: OLD_TELEMETRY_POLLUTION_ROOT_CAUSE,
      evidence,
      evidence_counters: counters,
      action:
        'Wait for older telemetry to age out of the selected health window, or narrow --hours when checking current bridge state.',
    };
  }

  if (
    input.runtime_bridge_status !== 'available' &&
    input.task_claim_file_calls >= LIFECYCLE_BRIDGE_MISSING_MIN_TASK_CLAIM_FILE_CALLS &&
    isNearZeroPreToolUseSignals(input.pre_tool_use_signals, input.hook_capable_edits)
  ) {
    return {
      kind: 'lifecycle_bridge_unavailable',
      summary: LIFECYCLE_BRIDGE_UNAVAILABLE_ROOT_CAUSE,
      evidence,
      evidence_counters: counters,
      action:
        'Metric unreliable until the runtime summary and lifecycle bridge are current; refresh/install the bridge, restart the editor, then rerun health.',
      command: LIFECYCLE_INSTALL_VERIFY_COMMAND,
    };
  }

  if (input.task_claim_file_calls < LIFECYCLE_BRIDGE_MISSING_MIN_TASK_CLAIM_FILE_CALLS) {
    if (
      input.runtime_bridge_status === 'available' &&
      input.edit_tool_calls === 0 &&
      input.hook_capable_edits === 0 &&
      input.pre_tool_use_signals === 0 &&
      input.recent_task_claim_file_calls > 0
    ) {
      return {
        kind: 'no_hook_capable_edits',
        summary: NO_HOOK_CAPABLE_EDITS_ROOT_CAUSE,
        evidence,
        evidence_counters: counters,
        action:
          'Run a hook-capable file edit in the selected window, then rerun health before diagnosing hook wiring.',
        command: LIFECYCLE_HEALTH_VERIFY_COMMAND,
      };
    }
    return null;
  }

  if (
    input.pre_tool_use_signals > 0 &&
    input.edit_tool_calls > 0 &&
    input.hook_capable_edits === 0
  ) {
    return {
      kind: 'lifecycle_paths_missing',
      summary: LIFECYCLE_PATHS_MISSING_ROOT_CAUSE,
      evidence,
      evidence_counters: counters,
      action:
        'Fix the lifecycle bridge to emit file_path metadata for edit tools, then verify claim-before-edit again.',
      command: LIFECYCLE_BRIDGE_COMMAND,
    };
  }

  if (input.hook_capable_edits === 0 && input.pre_tool_use_signals === 0) {
    return {
      kind: 'lifecycle_bridge_silent',
      summary: LIFECYCLE_BRIDGE_SILENT_ROOT_CAUSE,
      evidence,
      evidence_counters: counters,
      action:
        'Verify lifecycle hook installation and restart the editor session so PreToolUse emits edit-path telemetry.',
      command: LIFECYCLE_INSTALL_VERIFY_COMMAND,
    };
  }
  if (input.hook_capable_edits < LIFECYCLE_BRIDGE_MISSING_MIN_HOOK_CAPABLE_EDITS) {
    return null;
  }

  const claimMismatchCount = lifecycleClaimMismatchCount(input.claim_miss_reasons);
  if (
    !isNearZeroPreToolUseSignals(input.pre_tool_use_signals, input.hook_capable_edits) &&
    input.edits_without_claim_before > 0 &&
    claimMismatchCount > 0
  ) {
    // The 24h window can keep dragging mismatch buckets long after the
    // bridge has been re-wired. If the recent window has zero fresh
    // pre_tool_use_missing edits, the mismatches are leftover stale
    // telemetry — surface as `old_telemetry_pollution` so the headline
    // and Next-fixes guidance match the existing
    // `narrow --hours when checking current bridge state` recovery
    // path instead of demanding another lifecycle bridge install.
    if (
      noFreshBadEdits &&
      input.recent_hook_capable_edits >= LIFECYCLE_BRIDGE_MISSING_MIN_HOOK_CAPABLE_EDITS
    ) {
      return {
        kind: 'old_telemetry_pollution',
        summary: OLD_TELEMETRY_POLLUTION_ROOT_CAUSE,
        evidence,
        evidence_counters: counters,
        action:
          'Wait for older telemetry to age out of the selected health window, or narrow --hours when checking current bridge state.',
      };
    }
    return {
      kind: 'lifecycle_claim_mismatch',
      summary: LIFECYCLE_CLAIM_MISMATCH_ROOT_CAUSE,
      evidence,
      evidence_counters: counters,
      action:
        'Reclaim the edited files in the same repo, branch, worktree, and session; then rerun lifecycle health.',
      command: LIFECYCLE_BRIDGE_COMMAND,
    };
  }

  if (!isNearZeroPreToolUseSignals(input.pre_tool_use_signals, input.hook_capable_edits)) {
    return null;
  }
  return {
    kind: 'lifecycle_bridge_silent',
    summary: LIFECYCLE_BRIDGE_SILENT_ROOT_CAUSE,
    evidence,
    evidence_counters: counters,
    action: LIFECYCLE_BRIDGE_ACTION,
    command: LIFECYCLE_INSTALL_VERIFY_COMMAND,
  };
}

function rootCauseEvidenceCounters(input: {
  runtime_bridge_status: OmxRuntimeBridgePayload['status'];
  task_claim_file_calls: number;
  edit_tool_calls: number;
  hook_capable_edits: number;
  pre_tool_use_signals: number;
  recent_task_claim_file_calls: number;
  recent_hook_capable_edits: number;
  recent_pre_tool_use_signals: number;
  recent_pre_tool_use_missing: number;
  edits_without_claim_before: number;
  claim_miss_reasons: ClaimMissReasons;
  runtime_summary_recent_edit_paths: number;
  runtime_summary_hook_capable_edits: number;
  runtime_summary_pre_tool_use_signals: number;
  live_file_contentions: number;
  dirty_contended_files: number;
}): RootCauseEvidenceCounters {
  return {
    runtime_bridge_status: input.runtime_bridge_status,
    task_claim_file_calls: input.task_claim_file_calls,
    edit_tool_calls: input.edit_tool_calls,
    hook_capable_edits: input.hook_capable_edits,
    pre_tool_use_signals: input.pre_tool_use_signals,
    recent_task_claim_file_calls: input.recent_task_claim_file_calls,
    recent_hook_capable_edits: input.recent_hook_capable_edits,
    recent_pre_tool_use_signals: input.recent_pre_tool_use_signals,
    recent_pre_tool_use_missing: input.recent_pre_tool_use_missing,
    edits_without_claim_before: input.edits_without_claim_before,
    live_file_contentions: input.live_file_contentions,
    dirty_contended_files: input.dirty_contended_files,
    dominant_claim_miss_reason: dominantClaimMissReason(input.claim_miss_reasons),
  };
}

function formatRootCauseEvidence(counters: RootCauseEvidenceCounters): string {
  return [
    `runtime_bridge_status=${counters.runtime_bridge_status}`,
    `task_claim_file_calls=${counters.task_claim_file_calls}`,
    `edit_tool_calls=${counters.edit_tool_calls}`,
    `hook_capable_edits=${counters.hook_capable_edits}`,
    `pre_tool_use_signals=${counters.pre_tool_use_signals}`,
    `recent_task_claim_file_calls=${counters.recent_task_claim_file_calls}`,
    `recent_hook_capable_edits=${counters.recent_hook_capable_edits}`,
    `recent_pre_tool_use_signals=${counters.recent_pre_tool_use_signals}`,
    `recent_pre_tool_use_missing=${counters.recent_pre_tool_use_missing}`,
    `edits_without_claim_before=${counters.edits_without_claim_before}`,
    `dominant_claim_miss_reason=${counters.dominant_claim_miss_reason ?? 'none'}`,
  ].join(', ');
}

function lifecycleClaimMismatchCount(reasons: ClaimMissReasons): number {
  return (
    reasons.no_claim_for_file +
    reasons.claim_after_edit +
    reasons.session_id_mismatch +
    reasons.repo_root_mismatch +
    reasons.branch_mismatch +
    reasons.path_mismatch +
    reasons.worktree_path_mismatch
  );
}

function dominantClaimMissReason(reasons: ClaimMissReasons): keyof ClaimMissReasons | null {
  let maxReason: keyof ClaimMissReasons | null = null;
  let maxCount = 0;
  for (const [reason, count] of Object.entries(reasons) as Array<
    [keyof ClaimMissReasons, number]
  >) {
    if (count > maxCount) {
      maxReason = reason;
      maxCount = count;
    }
  }
  return maxReason;
}

function isNearZeroPreToolUseSignals(preToolUseSignals: number, hookCapableEdits: number): boolean {
  if (preToolUseSignals === 0) return true;
  if (hookCapableEdits <= 0) return false;
  const nearZeroLimit = Math.max(
    1,
    Math.floor(hookCapableEdits * LIFECYCLE_BRIDGE_NEAR_ZERO_PRE_TOOL_USE_SIGNAL_RATIO),
  );
  return preToolUseSignals <= nearZeroLimit;
}

function claimMatchSourcesPayload(
  sources: Partial<ClaimMatchSources> | undefined,
): ClaimMatchSources {
  return {
    exact_session: sources?.exact_session ?? 0,
    repo_branch: sources?.repo_branch ?? 0,
    worktree: sources?.worktree ?? 0,
    agent_lane: sources?.agent_lane ?? 0,
  };
}

function claimMissReasonsPayload(
  reasons: Partial<ClaimMissReasons> | undefined,
  fallbackNoClaim: number,
): ClaimMissReasons {
  return {
    no_claim_for_file: reasons?.no_claim_for_file ?? fallbackNoClaim,
    claim_after_edit: reasons?.claim_after_edit ?? 0,
    session_id_mismatch: reasons?.session_id_mismatch ?? 0,
    repo_root_mismatch: reasons?.repo_root_mismatch ?? 0,
    branch_mismatch: reasons?.branch_mismatch ?? 0,
    path_mismatch: reasons?.path_mismatch ?? 0,
    worktree_path_mismatch: reasons?.worktree_path_mismatch ?? 0,
    pseudo_path_skipped: reasons?.pseudo_path_skipped ?? 0,
    pre_tool_use_missing: reasons?.pre_tool_use_missing ?? 0,
  };
}

function signalHealthPayload(
  storage: Pick<Storage, 'listClaims' | 'taskObservationsByKind'>,
  tasks: TaskRow[],
  options: { since: number; now: number; stale_claim_minutes: number },
): SignalHealthPayload {
  const claims = tasks.flatMap((task) => storage.listClaims(task.id));
  const classified = claims.map((claim) =>
    classifyClaimAge(claim, {
      now: options.now,
      claim_stale_minutes: options.stale_claim_minutes,
    }),
  );
  const activeClaims = classified.filter(isStrongClaimAge).length;
  const staleClaims = classified.filter(
    (claim) => claim.state === 'active' && claim.age_class === 'stale',
  ).length;
  const expiredClaims = classified.filter(
    (claim) => claim.state === 'active' && claim.age_class === 'expired/weak',
  ).length;
  const weakClaims = classified.filter((claim) => claim.ownership_strength === 'weak').length;
  const quotaPendingClaims = classified.filter((claim) => claim.state === 'handoff_pending').length;
  const expiredQuotaPendingClaims = classified.filter(
    (claim) => claim.state === 'handoff_pending' && claim.age_class === 'expired/weak',
  ).length;
  const quotaRelayExamples = quotaRelayExamplesPayload(storage, tasks, claims, options.now);
  const quotaRelayActions = quotaRelayActionsPayload(quotaRelayExamples);
  let expiredHandoffs = 0;
  let expiredMessages = 0;

  for (const task of tasks) {
    expiredHandoffs += storage
      .taskObservationsByKind(task.id, 'handoff', 1000)
      .filter((row) => row.ts > options.since)
      .filter((row) => isExpiredLifecycleRow(row, options.now, 'handoff')).length;
    expiredMessages += storage
      .taskObservationsByKind(task.id, 'message', 1000)
      .filter((row) => row.ts > options.since)
      .filter((row) => isExpiredLifecycleRow(row, options.now, 'message')).length;
  }

  return {
    total_claims: claims.length,
    active_claims: activeClaims,
    fresh_claims: activeClaims,
    stale_claims: staleClaims,
    expired_claims: expiredClaims,
    weak_claims: weakClaims,
    quota_pending_claims: quotaPendingClaims,
    expired_quota_pending_claims: expiredQuotaPendingClaims,
    quota_relay_actions: quotaRelayActions,
    quota_relay_examples: quotaRelayExamples,
    stale_claim_minutes: options.stale_claim_minutes,
    expired_handoffs: expiredHandoffs,
    expired_messages: expiredMessages,
  };
}

function quotaRelayExamplesPayload(
  storage: Pick<Storage, 'taskObservationsByKind'>,
  tasks: TaskRow[],
  claims: Array<{
    task_id: number;
    file_path: string;
    session_id: string;
    claimed_at: number;
    state?: string;
    expires_at?: number | null;
    handoff_observation_id?: number | null;
  }>,
  now: number,
): QuotaRelayExample[] {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const observationsByTask = new Map<number, Map<number, ObservationRow>>();
  for (const task of tasks) {
    const rows = [
      ...storage.taskObservationsByKind(task.id, 'handoff', 1000),
      ...storage.taskObservationsByKind(task.id, 'relay', 1000),
    ];
    observationsByTask.set(task.id, new Map(rows.map((row) => [row.id, row])));
  }

  const groups = new Map<
    string,
    {
      task: TaskRow;
      old_owner: string;
      handoff_observation_id: number;
      claims: typeof claims;
    }
  >();

  for (const claim of claims) {
    if (claim.handoff_observation_id === null || claim.handoff_observation_id === undefined) {
      continue;
    }
    const task = taskById.get(claim.task_id);
    if (!task) continue;
    const key = `${claim.task_id}:${claim.handoff_observation_id}:${claim.session_id}`;
    const existing = groups.get(key);
    if (existing) {
      existing.claims.push(claim);
    } else {
      groups.set(key, {
        task,
        old_owner: claim.session_id,
        handoff_observation_id: claim.handoff_observation_id,
        claims: [claim],
      });
    }
  }

  return [...groups.values()]
    .map((group): QuotaRelayExample | null => {
      const row = observationsByTask.get(group.task.id)?.get(group.handoff_observation_id);
      if (!row || (row.kind !== 'handoff' && row.kind !== 'relay')) return null;
      const metadata = parseJsonObject(row.metadata);
      if (!isQuotaRelayHealthObservation(row, metadata)) return null;
      const state = quotaRelayState(group.claims, metadata, now);
      const files = [...new Set(group.claims.map((claim) => claim.file_path))].sort();
      const action = quotaRelayRecommendedAction(state);
      const ageMs = Math.max(0, now - row.ts);
      const example: QuotaRelayExample = {
        task_id: group.task.id,
        baton_kind: row.kind,
        handoff_observation_id: group.handoff_observation_id,
        old_owner: quotaRelayOldOwner(group.old_owner, metadata),
        age_ms: ageMs,
        age_minutes: Math.floor(ageMs / 60_000),
        files,
        state,
        recommended_action: action,
        tool_call: quotaRelayToolCall(action, group.task.id, group.handoff_observation_id),
        decline_tool_call:
          action === 'accept'
            ? quotaRelayToolCall('decline/reroute', group.task.id, group.handoff_observation_id)
            : null,
        command: quotaRelayCommand(action, group.task.id, group.handoff_observation_id),
      };
      return example;
    })
    .filter((example): example is QuotaRelayExample => example !== null)
    .sort((a, b) => {
      const actionRank =
        quotaRelayActionRank(a.recommended_action) - quotaRelayActionRank(b.recommended_action);
      return actionRank || b.age_ms - a.age_ms || a.task_id - b.task_id;
    })
    .slice(0, QUOTA_RELAY_EXAMPLE_LIMIT);
}

function quotaRelayActionsPayload(examples: QuotaRelayExample[]): QuotaRelayActionsPayload {
  const accept = examples.filter((example) => example.recommended_action === 'accept').length;
  const releaseExpired = examples.filter(
    (example) => example.recommended_action === 'release expired',
  ).length;
  const declineReroute = examples.filter(
    (example) => example.recommended_action === 'decline/reroute',
  ).length;
  const none = examples.filter((example) => example.recommended_action === 'none').length;
  const topExample =
    examples.find((example) => example.recommended_action !== 'none') ?? examples[0] ?? null;
  return {
    accept,
    release_expired: releaseExpired,
    decline_reroute: declineReroute,
    none,
    top_action: topExample?.recommended_action ?? 'none',
    top_example: topExample,
  };
}

function quotaRelayActionRank(action: QuotaRelayRecommendedAction): number {
  if (action === 'release expired') return 0;
  if (action === 'accept') return 1;
  if (action === 'decline/reroute') return 2;
  return 3;
}

function quotaRelayState(
  claims: Array<{ state?: string; expires_at?: number | null }>,
  metadata: Record<string, unknown>,
  now: number,
): QuotaRelayState {
  const status = readStringOrNull(metadata.status);
  if (status === 'accepted') return 'accepted';
  if (status === 'cancelled') return 'declined/rerouted';
  if (status === 'expired') return 'expired';
  if (
    claims.some(
      (claim) =>
        claim.state === 'weak_expired' ||
        (typeof claim.expires_at === 'number' && now >= claim.expires_at),
    )
  ) {
    return 'expired';
  }
  if (status === null || status === 'pending') return 'active';
  return 'unknown';
}

function quotaRelayRecommendedAction(state: QuotaRelayState): QuotaRelayRecommendedAction {
  if (state === 'expired') return 'release expired';
  if (state === 'active') return 'accept';
  return 'none';
}

function quotaRelayToolCall(
  action: QuotaRelayRecommendedAction,
  taskId: number,
  handoffObservationId: number,
): string | null {
  if (action === 'accept') {
    return `mcp__colony__task_claim_quota_accept({ task_id: ${taskId}, session_id: "<session_id>", handoff_observation_id: ${handoffObservationId} })`;
  }
  if (action === 'release expired') {
    return `mcp__colony__task_claim_quota_release_expired({ task_id: ${taskId}, session_id: "<session_id>", handoff_observation_id: ${handoffObservationId} })`;
  }
  if (action === 'decline/reroute') {
    return `mcp__colony__task_claim_quota_decline({ task_id: ${taskId}, session_id: "<session_id>", handoff_observation_id: ${handoffObservationId}, reason: "<reason>" })`;
  }
  return null;
}

function quotaRelayCommand(
  action: QuotaRelayRecommendedAction,
  taskId: number,
  handoffObservationId: number,
): string {
  if (action === 'accept') {
    return `colony task quota-accept --task-id ${taskId} --handoff-observation-id ${handoffObservationId} --session <session_id> --agent <agent>`;
  }
  if (action === 'release expired') {
    return `colony task quota-release-expired --task-id ${taskId} --handoff-observation-id ${handoffObservationId} --session <session_id>`;
  }
  if (action === 'decline/reroute') {
    return `colony task quota-decline --task-id ${taskId} --handoff-observation-id ${handoffObservationId} --session <session_id> --reason <reason>`;
  }
  return 'colony task ready --repo-root <repo_root> --agent <agent> --session <session_id> --json';
}

function quotaRelayOldOwner(oldOwnerSessionId: string, metadata: Record<string, unknown>): string {
  const sessionId = readStringOrNull(metadata.from_session_id) ?? oldOwnerSessionId;
  const agent = readStringOrNull(metadata.from_agent);
  return agent ? `${agent}/${shortSession(sessionId)}` : shortSession(sessionId);
}

function isQuotaRelayHealthObservation(
  row: ObservationRow,
  metadata: Record<string, unknown>,
): boolean {
  const reason = readStringOrNull(metadata.reason);
  if (row.kind === 'relay' && reason === 'quota') return true;
  if (row.kind === 'handoff' && reason === 'quota_exhausted') return true;
  const text = [
    row.content,
    readStringMetadata(metadata.reason),
    readStringMetadata(metadata.summary),
    readStringMetadata(metadata.one_line),
    readStringArrayMetadata(metadata.blockers).join(' '),
  ]
    .filter(Boolean)
    .join(' ');
  return (
    metadata.quota_exhausted === true ||
    /\bquota(?:[-_\s]*exhausted|[-_\s]*hit|[-_\s]*reached|[-_\s]*exceeded)?\b/i.test(text)
  );
}

function proposalHealthPayload(
  storage: Pick<Storage, 'listProposalsForBranch' | 'listReinforcements'>,
  tasks: TaskRow[],
  options: { since: number; now: number },
): ProposalHealthPayload {
  const proposals = knownBranchProposals(storage, tasks).filter(
    (proposal) =>
      proposal.status === 'pending' ||
      proposal.proposed_at > options.since ||
      (proposal.promoted_at !== null && proposal.promoted_at > options.since),
  );
  let pending = 0;
  let promoted = 0;
  let evaporated = 0;
  let pendingBelowNoiseFloor = 0;

  for (const proposal of proposals) {
    if (proposal.status === 'active') promoted++;
    if (proposal.status === 'evaporated') evaporated++;
    if (proposal.status !== 'pending') continue;
    pending++;
    const reinforcements = storage.listReinforcements(proposal.id);
    const strength = currentProposalStrength(proposal, reinforcements, options.now);
    if (strength < ProposalSystem.NOISE_FLOOR) pendingBelowNoiseFloor++;
  }

  return {
    proposals_seen: proposals.length,
    pending,
    promoted,
    evaporated,
    pending_below_noise_floor: pendingBelowNoiseFloor,
    promotion_rate: ratio(promoted, pending + promoted + evaporated),
  };
}

function readyClaimPayload(
  storage: Pick<Storage, 'taskTimeline'>,
  tasks: TaskRow[],
): ReadyClaimPayload {
  const subtasks = readPlanSubtasks(storage, tasks);
  const byPlan = new Map<string, PlanSubtaskHealth[]>();
  for (const subtask of subtasks) {
    const bucket = byPlan.get(subtask.plan_slug) ?? [];
    bucket.push(subtask);
    byPlan.set(subtask.plan_slug, bucket);
  }

  let readyToClaim = 0;
  let claimed = 0;
  for (const subtask of subtasks) {
    if (subtask.status === 'claimed') claimed++;
    if (subtask.status !== 'available') continue;
    const siblings = byPlan.get(subtask.plan_slug) ?? [];
    const depsMet = subtask.depends_on.every((depIndex) =>
      siblings.some(
        (candidate) => candidate.index === depIndex && candidate.status === 'completed',
      ),
    );
    if (depsMet) readyToClaim++;
  }

  return {
    plan_subtasks: subtasks.length,
    ready_to_claim: readyToClaim,
    claimed,
    ready_to_claim_per_claimed: ratio(readyToClaim, claimed),
    claimed_share_of_actionable: ratio(claimed, readyToClaim + claimed),
  };
}

function formatClaimBeforeEdit(payload: ClaimBeforeEditPayload): string[] {
  const lines = [`  task_claim_file calls: ${payload.task_claim_file_calls}`];
  if (payload.status === 'no_data') {
    lines.push(kleur.dim('  n/a (no edit tool observations in window)'));
    lines.push(...formatClaimBeforeEditMeasurement(payload));
    lines.push(formatRecentClaimBeforeEdit(payload));
    lines.push(...formatEditSourceBreakdown(payload));
    if (payload.install_hint) lines.push(kleur.yellow(`  ${payload.install_hint}`));
    return lines;
  }
  if (payload.status === 'not_available') {
    lines.push(
      `  not available (${payload.edits_with_file_path} / ${payload.edit_tool_calls} edit calls include file_path metadata)`,
    );
    lines.push(...formatClaimBeforeEditMeasurement(payload));
    lines.push(formatRecentClaimBeforeEdit(payload));
    lines.push(...formatEditSourceBreakdown(payload));
    if (payload.install_hint) lines.push(kleur.yellow(`  ${payload.install_hint}`));
    return lines;
  }
  const explicitClaims = Math.max(
    payload.edits_claimed_before - payload.auto_claimed_before_edit,
    0,
  );
  lines.push(
    `  ${payload.edits_claimed_before} / ${payload.edits_with_file_path} edits had a claim before edit (${formatPercent(
      payload.claim_before_edit_ratio,
    )})`,
  );
  lines.push(`  explicit/manual claims before edit: ${explicitClaims}`);
  lines.push(`  auto-claimed before edit: ${payload.auto_claimed_before_edit}`);
  lines.push(`  missing proactive claim: ${payload.edits_without_claim_before}`);
  lines.push(
    `  telemetry: edits_with_claim=${payload.edits_with_claim}, edits_missing_claim=${payload.edits_missing_claim}, auto_claimed_before_edit=${payload.auto_claimed_before_edit}, pre_tool_use_signals=${payload.pre_tool_use_signals}`,
  );
  lines.push(...formatClaimBeforeEditMeasurement(payload));
  lines.push(formatRecentClaimBeforeEdit(payload));
  lines.push(...formatClaimMatchSources(payload));
  lines.push(...formatClaimMissReasons(payload.claim_miss_reasons));
  lines.push(...formatNearestClaimExamples(payload.nearest_claim_examples));
  lines.push(...formatEditSourceBreakdown(payload));
  if (payload.session_binding_missing > 0) {
    lines.push(kleur.yellow(`  session binding missing: ${payload.session_binding_missing}`));
  }
  if (payload.likely_missing_hook && payload.install_hint) {
    lines.push(kleur.yellow(`  ${payload.install_hint}`));
  } else if (payload.session_binding_missing > 0 && payload.install_hint) {
    lines.push(kleur.yellow(`  ${payload.install_hint}`));
  }
  return lines;
}

function formatClaimBeforeEditMeasurement(payload: ClaimBeforeEditPayload): string[] {
  const lines = [
    `  measurement: measurable_edits=${payload.measurable_edits}, unmeasurable_edits=${payload.unmeasurable_edits}, runtime_bridge_status=${payload.runtime_bridge_status}`,
  ];
  if (payload.reason) {
    lines.push(`  reason: ${payload.reason}`);
    lines.push(`  metric unreliable: ${payload.reason}`);
  }
  return lines;
}

function formatRecentClaimBeforeEdit(payload: ClaimBeforeEditPayload): string {
  const claimBeforeEdit =
    payload.recent_claim_before_edit_rate === null &&
    payload.recent_hook_capable_edits > 0 &&
    payload.recent_hook_capable_edits < RECENT_CLAIM_BEFORE_EDIT_MIN_SAMPLE
      ? 'insufficient sample'
      : formatPercent(payload.recent_claim_before_edit_rate);
  return `  recent ${payload.recent_window_hours}h: hook_capable_edits=${payload.recent_hook_capable_edits}, pre_tool_use_signals=${payload.recent_pre_tool_use_signals}, pre_tool_use_missing=${payload.recent_pre_tool_use_missing}, claim-before-edit=${claimBeforeEdit}`;
}

function formatClaimMatchSources(payload: ClaimBeforeEditPayload): string[] {
  const sources = payload.claim_match_sources;
  return [
    `  claim_match_sources: exact_session=${sources.exact_session}, repo_branch=${sources.repo_branch}, worktree=${sources.worktree}, agent_lane=${sources.agent_lane}, window_ms=${payload.claim_match_window_ms} (health-only fallback)`,
  ];
}

function formatClaimMissReasons(reasons: ClaimMissReasons): string[] {
  return [
    '  why claims did not match edits:',
    `    no_claim_for_file: ${reasons.no_claim_for_file}`,
    `    claim_after_edit: ${reasons.claim_after_edit}`,
    `    session_id_mismatch: ${reasons.session_id_mismatch}`,
    `    repo_root_mismatch: ${reasons.repo_root_mismatch}`,
    `    branch_mismatch: ${reasons.branch_mismatch}`,
    `    path_mismatch: ${reasons.path_mismatch}`,
    `    worktree_path_mismatch: ${reasons.worktree_path_mismatch}`,
    `    pseudo_path_skipped: ${reasons.pseudo_path_skipped}`,
    `    pre_tool_use_missing: ${reasons.pre_tool_use_missing}`,
  ];
}

function formatNearestClaimExamples(examples: NearestClaimExample[]): string[] {
  if (examples.length === 0) return [];
  const lines = ['  nearest claim examples:'];
  for (const example of examples.slice(0, HEALTH_TOOL_LIMIT)) {
    const claimRef =
      example.nearest_claim_id === null
        ? 'no nearby claim'
        : `claim#${example.nearest_claim_id} ${example.claim_file_path ?? 'unknown'} by ${example.claim_session_id ?? 'unknown'} ${formatDistance(example.distance_ms)}`;
    lines.push(
      `    ${example.reason}: edit#${example.edit_id} ${example.edit_file_path ?? 'unknown'} by ${example.edit_session_id}; ${claimRef}`,
    );
  }
  return lines;
}

function formatDistance(distanceMs: number | null): string {
  if (distanceMs === null) return '';
  return `${distanceMs}ms away`;
}

function formatLiveContention(payload: LiveContentionPayload): string[] {
  const lines = [
    `  live_file_contentions:      ${payload.live_file_contentions}`,
    `  protected_file_contentions: ${payload.protected_file_contentions}`,
    `  paused_lanes:               ${payload.paused_lanes}`,
    `  takeover_requests:          ${payload.takeover_requests}`,
    `  competing_worktrees:        ${payload.competing_worktrees}`,
    `  dirty_contended_files:      ${payload.dirty_contended_files}`,
  ];

  if (payload.top_conflicts.length === 0) {
    lines.push(kleur.dim('  top conflicts: none'));
    return lines;
  }

  lines.push('  top conflicts:');
  for (const conflict of payload.top_conflicts) {
    const flags = [
      conflict.protected ? 'protected' : '',
      conflict.dirty_worktrees.length > 0 ? 'dirty' : '',
    ]
      .filter(Boolean)
      .join(', ');
    lines.push(
      `  ${conflict.file_path} (${conflict.owner_count} owners${flags ? `; ${flags}` : ''})`,
    );
    for (const owner of conflict.owners) {
      lines.push(
        `    - owner=${owner.owner} session=${shortSession(owner.session_id)} branch=${owner.branch} activity=${owner.activity} class=${owner.classification}`,
      );
    }
  }
  if (payload.recommended_actions.length > 0) {
    lines.push('  recommended actions:');
    for (const action of payload.recommended_actions.slice(0, HEALTH_TOOL_LIMIT)) {
      lines.push(
        `    - ${action.file_path}: ${action.action}; owner=${action.owner} session=${shortSession(action.session_id)} reason=${action.reason}`,
      );
      if (action.command) lines.push(`      command: ${action.command}`);
      if (action.mcp_tool_hint) lines.push(`      tool: ${action.mcp_tool_hint}`);
    }
  }
  if (payload.protected_claim_action_queue.protected_claims > 0) {
    const queue = payload.protected_claim_action_queue;
    lines.push('  protected claim action queue:');
    lines.push(`    protected_claims: ${queue.protected_claims}`);
    lines.push(
      `    actions: takeover=${queue.takeover_actions}, release_or_weaken=${queue.release_or_weaken_actions}, keep_owner=${queue.keep_owner_actions}`,
    );
    lines.push(`    next: ${queue.next_action}`);
    for (const command of queue.commands.slice(0, HEALTH_TOOL_LIMIT)) {
      lines.push(`    command: ${command}`);
    }
  }
  return lines;
}

function formatEditSourceBreakdown(payload: ClaimBeforeEditPayload): string[] {
  const source = payload.edit_source_breakdown;
  const lines = [
    `  edit source breakdown: colony_post_tool_edits=${source.colony_post_tool_edits}, codex_rollout_edits=${source.codex_rollout_edits}, hook_capable_edits=${source.hook_capable_edits}, pre_tool_use_signals=${source.pre_tool_use_signals}`,
  ];
  if (payload.codex_rollout_without_bridge) {
    lines.push(
      kleur.yellow(
        '  diagnosis: Codex rollout edits are present, but no Codex PreToolUse hook or rollout bridge signal is firing.',
      ),
    );
  }
  return lines;
}

function omxRuntimeBridgeNeedsAttention(payload: ColonyHealthPayloadWithoutHints): boolean {
  if (payload.task_claim_file_before_edits.root_cause?.kind === 'lifecycle_bridge_unavailable') {
    return true;
  }
  if (payload.omx_runtime_bridge.status === 'available') return false;
  return (
    payload.omx_runtime_bridge.sources.length > 0 ||
    payload.omx_runtime_bridge.malformed_summary_count > 0 ||
    (payload.task_claim_file_before_edits.reason === INSUFFICIENT_RUNTIME_METADATA_REASON &&
      payload.signal_health.quota_pending_claims > 0) ||
    payload.task_claim_file_before_edits.codex_rollout_without_bridge
  );
}

function quotaRelayActionHint(payload: SignalHealthPayload): {
  current: string;
  action: string;
  tool_call: string;
  command: string;
  inspect: string;
} {
  const top = payload.quota_relay_actions.top_example;
  if (!top || payload.quota_relay_actions.top_action === 'none') {
    return {
      current: String(payload.quota_pending_claims),
      action:
        'Resolve quota-pending ownership first: accept if taking over, decline/reroute if not, or release expired quota claims with audit.',
      tool_call:
        'mcp__colony__attention_inbox({ agent: <agent>, session_id: <session_id>, repo_root: <repo_root> })',
      command: 'colony inbox --json',
      inspect:
        'colony inbox --json, mcp__colony__attention_inbox, mcp__colony__task_claim_quota_accept',
    };
  }

  const action = formatQuotaRelayTopAction(payload.quota_relay_actions);
  const details = `${payload.quota_pending_claims} quota-pending claim(s); top action: ${action}`;
  const recommendedAction = payload.quota_relay_actions.top_action;
  const toolCall =
    top.tool_call ??
    quotaRelayToolCall('decline/reroute', top.task_id, top.handoff_observation_id) ??
    'mcp__colony__attention_inbox({ agent: <agent>, session_id: <session_id>, repo_root: <repo_root> })';
  const declineHint = top.decline_tool_call
    ? ` If you will not take it, decline/reroute with ${top.decline_tool_call}.`
    : '';
  const actionText =
    recommendedAction === 'release expired'
      ? 'Release expired quota-pending claims with task_claim_quota_release_expired; this keeps audit history and removes active blockers.'
      : recommendedAction === 'accept'
        ? `Accept the quota relay with task_claim_quota_accept only if you will continue the lane; otherwise decline/reroute it before treating ownership as free.${declineHint}`
        : recommendedAction === 'decline/reroute'
          ? 'Decline/reroute the quota relay before treating the claim as available.'
          : 'Inspect quota-pending ownership and resolve it before treating the lane as ordinary weak ownership.';
  return {
    current: details,
    action: `Top action: ${action}. ${actionText}`,
    tool_call: toolCall,
    command: top.command,
    inspect: `${top.command}, ${toolCall}`,
  };
}

function liveContentionCurrent(payload: LiveContentionPayload): string {
  const firstConflict = payload.top_conflicts[0];
  const firstFile = firstConflict
    ? `; first ${formatDefaultHealthText(firstConflict.file_path)}`
    : '';
  return `${payload.live_file_contentions} conflict(s), ${payload.dirty_contended_files} dirty${firstFile}`;
}

function liveContentionResolutionHint(payload: LiveContentionPayload): {
  action: string;
  tool_call?: string;
  command?: string;
} | null {
  const firstAction =
    payload.recommended_actions.find((action) => !action.action.startsWith('keep owner ')) ??
    payload.recommended_actions[0];
  if (!firstAction) return null;
  const owner = `${firstAction.owner} ${shortSession(firstAction.session_id)}`.trim();
  return {
    action: `Resolve ${formatDefaultHealthText(firstAction.file_path)} first: ${firstAction.action} for owner ${owner} (${firstAction.reason}).`,
    ...(firstAction.mcp_tool_hint ? { tool_call: firstAction.mcp_tool_hint } : {}),
    ...(firstAction.command ? { command: firstAction.command } : {}),
  };
}

function runtimeBridgeAction(payload: ColonyHealthPayloadWithoutHints): string {
  if (payload.omx_runtime_bridge.status === 'stale') {
    return 'Metric unreliable: refresh the OMX runtime summary bridge so health sees current sessions, edit paths, and quota exits before judging claim failures.';
  }
  return 'Metric unreliable: wire the OMX runtime summary/lifecycle bridge so health can measure live edits, quota exits, and pre_tool_use before recommending claim discipline.';
}

function runtimeBridgeCommand(payload: ColonyHealthPayloadWithoutHints): string {
  return payload.omx_runtime_bridge.status === 'stale'
    ? OMX_RUNTIME_SUMMARY_COMMAND
    : LIFECYCLE_BRIDGE_COMMAND;
}

function healthActionHints(payload: ColonyHealthPayloadWithoutHints): ActionHint[] {
  const hints: ActionHint[] = [];
  const liveContention = payload.live_contention_health;
  if (liveContention.live_file_contentions > 0) {
    const resolutionHint = liveContentionResolutionHint(liveContention);
    hints.push({
      metric: 'live file contentions',
      status: 'bad',
      current: liveContentionCurrent(liveContention),
      target: '0 conflicts',
      action:
        resolutionHint?.action ??
        'Resolve same-file multi-owner claims before running broad verification or trusting branch health.',
      readiness_scope: 'execution_safety',
      priority: 1,
      tool_call:
        resolutionHint?.tool_call ??
        'mcp__colony__hivemind_context({ agent: "<agent>", session_id: "<session_id>", repo_root: "<repo_root>", files: ["<file>"] })',
      command: resolutionHint?.command ?? 'colony health --json',
      prompt: codexPrompt({
        goal: 'resolve live same-file ownership conflicts before branch verification',
        current: liveContentionCurrent(liveContention),
        inspect:
          'colony health --json, mcp__colony__hivemind_context, mcp__colony__attention_inbox',
        acceptance:
          'top conflicts are handed off, released, or reclaimed and live_file_contentions returns 0',
      }),
    });
  }
  if (liveContention.live_file_contentions === 0 && liveContention.dirty_contended_files > 0) {
    hints.push({
      metric: 'dirty contended files',
      status: 'bad',
      current: String(liveContention.dirty_contended_files),
      target: '0',
      action:
        'Clear or hand off dirty worktrees that still contend for the same files before trusting branch health.',
      readiness_scope: 'execution_safety',
      priority: 2,
      command: 'colony health --json',
      prompt: codexPrompt({
        goal: 'clear dirty contended worktrees before branch verification',
        current: `${liveContention.dirty_contended_files} dirty contended files`,
        inspect: 'colony health --json, git status --short, mcp__colony__hivemind_context',
        acceptance: 'dirty_contended_files returns 0 or ownership has a recorded handoff',
      }),
    });
  }

  if (liveContention.paused_lanes > 0 && liveContention.dirty_contended_files > 0) {
    hints.push({
      metric: 'paused dirty lanes',
      status: 'bad',
      current: `${liveContention.paused_lanes} paused lane(s), ${liveContention.dirty_contended_files} dirty contended file(s)`,
      target: '0 paused dirty lanes',
      action:
        'paused lanes with dirty files should be finished, handed off, or cleaned before broad verification.',
      readiness_scope: 'execution_safety',
      priority: 6,
      command: 'colony health --json',
      prompt: codexPrompt({
        goal: 'clear paused dirty lanes before broad verification',
        current: `${liveContention.paused_lanes} paused lanes; ${liveContention.dirty_contended_files} dirty contended files`,
        inspect: 'git status in each paused worktree, task_note_working, task_hand_off',
        acceptance:
          'dirty paused lanes are finished, handed off, or intentionally cleaned before broad verification',
      }),
    });
  }

  const protectedBranchOwners = liveContention.top_conflicts.flatMap((conflict) =>
    conflict.owners.filter((owner) => isProtectedBaseBranch(owner.branch)),
  );
  if (protectedBranchOwners.length > 0) {
    const branches = [...new Set(protectedBranchOwners.map((owner) => owner.branch))].sort();
    const queue = liveContention.protected_claim_action_queue;
    hints.push({
      metric: 'claims on protected branches',
      status: 'bad',
      current: `${protectedBranchOwners.length} claim(s) held on ${branches.join(', ')}`,
      target: '0 (claims should live on agent/* branches inside .omx/agent-worktrees/)',
      action:
        queue.next_action ||
        'Move work to a worktree before claiming files, then hand off, release, or explicitly reclaim protected-base claims.',
      readiness_scope: 'execution_safety',
      priority: 3,
      command: queue.commands[0] ?? 'gx branch start "<task>" "<agent>"',
      prompt: codexPrompt({
        goal: 'move active claims off protected base branches onto agent/* worktrees',
        current: `${protectedBranchOwners.length} claim(s) on protected branches: ${branches.join(', ')}`,
        inspect: ['colony health --json (top_conflicts owner branch field)', ...queue.commands]
          .filter(Boolean)
          .join(', '),
        acceptance:
          'no LiveContentionOwner claim_strength=strong rows reference branches in main/master/dev/develop/production/release',
      }),
    });
  }

  const bridgeNeedsAttention = omxRuntimeBridgeNeedsAttention(payload);
  if (bridgeNeedsAttention) {
    hints.push({
      metric: 'OMX runtime bridge',
      status: 'bad',
      current: payload.omx_runtime_bridge.status,
      target: 'runtime summary/lifecycle bridge available',
      action: runtimeBridgeAction(payload),
      readiness_scope: 'execution_safety',
      priority: 4,
      command: runtimeBridgeCommand(payload),
      prompt: codexPrompt({
        goal: 'wire the OMX runtime summary and lifecycle bridge',
        current: `OMX runtime bridge ${payload.omx_runtime_bridge.status} in colony health`,
        inspect:
          'colony health --json, colony bridge runtime-summary --json --repo-root <repo_root>, colony bridge lifecycle --json --ide <ide> --cwd <repo_root>, packages/hooks/src/lifecycle-envelope.ts',
        acceptance:
          'omx_runtime_bridge.status is available and lifecycle pre_tool_use appears before file mutation',
      }),
    });
  }

  const hivemindToAttention = payload.conversions.hivemind_context_to_attention_inbox;
  if (isBelowTarget(hivemindToAttention.conversion_rate, TARGET_HIVEMIND_TO_ATTENTION)) {
    hints.push({
      metric: 'hivemind_context -> attention_inbox',
      status: 'bad',
      current: formatPercent(hivemindToAttention.conversion_rate),
      target: `${formatPercent(TARGET_HIVEMIND_TO_ATTENTION)}+`,
      action:
        'After hivemind_context, call attention_inbox to clear handoffs, unread messages, and blockers.',
      readiness_scope: 'coordination_readiness',
      priority: 60,
      tool_call:
        'mcp__colony__attention_inbox({ agent: "<agent>", session_id: "<session_id>", repo_root: "<repo_root>" })',
      prompt: codexPrompt({
        goal: 'make every hivemind_context run clear attention before work selection',
        current: `hivemind_context -> attention_inbox ${formatPercent(hivemindToAttention.conversion_rate)}`,
        inspect: 'mcp__colony__hivemind_context, mcp__colony__attention_inbox, docs/mcp.md',
        acceptance:
          'agents call attention_inbox after hivemind_context and clear blockers before choosing work',
      }),
    });
  }

  const taskListToReady = payload.conversions.task_list_to_task_ready_for_agent;
  if (isBelowTarget(taskListToReady.conversion_rate, TARGET_TASK_LIST_TO_READY)) {
    hints.push({
      metric: 'task_list -> task_ready_for_agent',
      status: 'bad',
      current: formatPercent(taskListToReady.conversion_rate),
      target: `${formatPercent(TARGET_TASK_LIST_TO_READY)}+`,
      action:
        'Keep task_list for browsing/debugging only; call task_ready_for_agent before selecting work.',
      readiness_scope: 'coordination_readiness',
      priority: 61,
      tool_call:
        'mcp__colony__task_ready_for_agent({ agent: "<agent>", session_id: "<session_id>", repo_root: "<repo_root>" })',
      prompt: codexPrompt({
        goal: 'route task selection through task_ready_for_agent instead of task_list browsing',
        current: `task_list -> task_ready_for_agent ${formatPercent(taskListToReady.conversion_rate)}`,
        inspect: 'mcp__colony__task_ready_for_agent, mcp__colony__task_list, docs/mcp.md',
        acceptance:
          'task_list stays inventory/debug only and task_ready_for_agent is called before choosing work',
      }),
    });
  }

  const readyToClaim = payload.conversions.task_ready_for_agent_to_task_plan_claim_subtask;
  const queenReadyWithoutClaims =
    payload.ready_to_claim_vs_claimed.ready_to_claim > 0 &&
    payload.ready_to_claim_vs_claimed.claimed === 0;
  const queenInactiveWithSubtasks =
    payload.queen_wave_health.active_plans === 0 &&
    payload.ready_to_claim_vs_claimed.plan_subtasks > 0;
  // task_ready_for_agent now defaults to auto_claim=true, which closes the
  // ready→claim loop inside the same MCP call without an explicit follow-up
  // task_plan_claim_subtask invocation. The conversion metric only counts
  // tool_use observations, so this read-as-zero on every health run even
  // though sub-tasks are getting claimed. Detect that signature — agents
  // are calling task_ready_for_agent, no explicit task_plan_claim_subtask
  // follow-ups exist, but plan sub-tasks are claimed — and suppress the
  // false-positive hint.
  const autoClaimDominant =
    readyToClaim.from_calls > 0 &&
    readyToClaim.to_calls === 0 &&
    payload.ready_to_claim_vs_claimed.claimed > 0;
  if (
    isBelowTarget(readyToClaim.conversion_rate, TARGET_READY_TO_CLAIM) &&
    !queenReadyWithoutClaims &&
    !queenInactiveWithSubtasks &&
    !autoClaimDominant
  ) {
    const hasPlanSubtasks =
      payload.queen_wave_health.active_plans > 0 ||
      payload.ready_to_claim_vs_claimed.plan_subtasks > 0;
    hints.push({
      metric: 'task_ready_for_agent -> claim',
      status: 'bad',
      current: formatPercent(readyToClaim.conversion_rate),
      target: `${formatPercent(TARGET_READY_TO_CLAIM)}+`,
      action:
        'When ready work fits, claim it with task_plan_claim_subtask, then claim touched files before implementation.',
      readiness_scope: hasPlanSubtasks ? 'queen_plan_readiness' : 'adoption_followup',
      priority: hasPlanSubtasks ? 30 : 85,
      tool_call:
        'mcp__colony__task_plan_claim_subtask({ agent: "<agent>", session_id: "<session_id>", plan_slug: "<plan_slug>", subtask_index: <index> })',
      prompt: codexPrompt({
        goal: 'convert ready work into an owned plan subtask',
        current: `task_ready_for_agent -> task_plan_claim_subtask ${formatPercent(readyToClaim.conversion_rate)}`,
        inspect:
          'mcp__colony__task_ready_for_agent, mcp__colony__task_plan_claim_subtask, mcp__colony__task_claim_file',
        acceptance:
          'selected ready subtasks are claimed and touched files are claimed before implementation',
      }),
    });
  }

  const readyUnclaimedPlan = firstReadyUnclaimedQueenPlan(payload.queen_wave_health);
  if (
    readyUnclaimedPlan &&
    readyUnclaimedPlan.next_ready_subtask_index !== null &&
    readyUnclaimedPlan.ready_subtasks > 0
  ) {
    const currentWave = readyUnclaimedPlan.current_wave ?? 'n/a';
    const planSlug = readyUnclaimedPlan.plan_slug;
    const subtaskIndex = readyUnclaimedPlan.next_ready_subtask_index;
    hints.push({
      metric: 'Queen ready subtasks unclaimed',
      status: 'bad',
      current: `${planSlug} / ${currentWave}: ${readyUnclaimedPlan.ready_subtasks} ready, ${readyUnclaimedPlan.claimed_subtasks} claimed`,
      target: 'ready subtasks claimed through task_plan_claim_subtask',
      action: `Call task_ready_for_agent for ${planSlug} (${currentWave}), then call task_plan_claim_subtask with the returned claim args. First ready subtask index: ${subtaskIndex}.`,
      readiness_scope: 'queen_plan_readiness',
      priority: 25,
      plan_slug: planSlug,
      current_wave: readyUnclaimedPlan.current_wave,
      tool_call: `mcp__colony__task_ready_for_agent({ agent: "<agent>", session_id: "<session_id>", repo_root: "<repo_root>" }) -> mcp__colony__task_plan_claim_subtask({ agent: "<agent>", session_id: "<session_id>", plan_slug: ${JSON.stringify(planSlug)}, subtask_index: ${subtaskIndex} })`,
      prompt: codexPrompt({
        goal: `claim ready Queen work for ${planSlug}`,
        current: `plan_slug=${planSlug}; current_wave=${currentWave}; ready_subtasks=${readyUnclaimedPlan.ready_subtasks}; claimed_subtasks=${readyUnclaimedPlan.claimed_subtasks}`,
        inspect:
          'mcp__colony__task_ready_for_agent, mcp__colony__task_plan_claim_subtask, mcp__colony__task_plan_list, packages/queen',
        acceptance:
          'health no longer shows an active plan with ready subtasks and zero claimed subtasks',
      }),
    });
  }

  const messageShare = payload.task_post_vs_task_message.task_message_share;
  if (
    payload.task_post_vs_task_message.task_post_calls > 0 &&
    isBelowTarget(messageShare, TARGET_TASK_MESSAGE_SHARE)
  ) {
    hints.push({
      metric: 'task_message adoption',
      status: 'bad',
      current: `${payload.task_post_vs_task_message.task_message_calls} task_message / ${payload.task_post_vs_task_message.task_post_calls} task_post (${formatPercent(messageShare)})`,
      target: `${formatPercent(TARGET_TASK_MESSAGE_SHARE)}+`,
      action:
        'Use task_message when a post names an agent, asks can you/please/check/review/answer, says needs reply, or says handoff to; keep task_post for shared task-thread notes and decisions.',
      readiness_scope: 'adoption_followup',
      priority: 80,
      tool_call: TASK_MESSAGE_ADOPTION_DIRECTED_CALL,
      prompt: codexPrompt({
        goal: 'move agent-to-agent coordination from task_post notes to task_message',
        current: `${payload.task_post_vs_task_message.task_message_calls} task_message calls, ${payload.task_post_vs_task_message.task_post_calls} task_post calls`,
        inspect: `directed patterns: @claude/@codex, can you, please, check, review, answer, needs reply, handoff to; directed call: ${TASK_MESSAGE_ADOPTION_DIRECTED_CALL}; shared note: ${TASK_MESSAGE_ADOPTION_SHARED_NOTE_CALL}; mcp__colony__task_messages, mcp__colony__attention_inbox, docs/mcp.md`,
        acceptance:
          'directed coordination and reply-needed posts use task_message, shared task notes and decisions keep task_post, and unread replies surface in attention_inbox',
      }),
    });
  }

  const claimBeforeEdit = payload.task_claim_file_before_edits;
  const preToolUseMissing = claimBeforeEdit.claim_miss_reasons.pre_tool_use_missing;
  const preToolUseMissingDominates = isDominantPreToolUseMiss(claimBeforeEdit.claim_miss_reasons);
  const bridgeUnavailable = bridgeNeedsAttention;
  const highTaskClaimFileAdoption =
    claimBeforeEdit.task_claim_file_calls >=
    Math.max(RECENT_CLAIM_BEFORE_EDIT_MIN_SAMPLE, claimBeforeEdit.measurable_edits);
  const suppressGenericTaskClaimAdvice = bridgeUnavailable || highTaskClaimFileAdoption;
  if (
    claimBeforeEdit.root_cause &&
    isLifecycleRootCauseKind(claimBeforeEdit.root_cause.kind) &&
    claimBeforeEdit.root_cause.kind !== 'lifecycle_bridge_unavailable'
  ) {
    hints.push({
      metric: 'claim-before-edit',
      status: 'bad',
      current: `${claimBeforeEdit.root_cause.summary} (${claimBeforeEdit.root_cause.evidence})`,
      target: 'pre_tool_use before file mutation',
      action: claimBeforeEdit.root_cause.action,
      readiness_scope: 'execution_safety',
      priority: 5,
      ...(claimBeforeEdit.root_cause.kind === 'lifecycle_claim_mismatch'
        ? { tool_call: CLAIM_MISMATCH_TOOL_CALL }
        : {}),
      command: claimBeforeEdit.root_cause.command ?? LIFECYCLE_BRIDGE_COMMAND,
      prompt: codexPrompt({
        goal: 'wire the runtime lifecycle bridge before file mutation',
        current: claimBeforeEdit.root_cause.evidence,
        inspect:
          'colony bridge lifecycle --json --ide <ide> --cwd <repo_root>, packages/contracts/fixtures/colony-omx-lifecycle-v1/*.pre.json, packages/hooks/src/lifecycle-envelope.ts, pnpm smoke:codex-omx-pretool',
        acceptance:
          'runtime emits pre_tool_use before file mutation and pre_tool_use_signals rises above near-zero',
      }),
    });
  } else if (
    claimBeforeEdit.codex_rollout_without_bridge &&
    (claimBeforeEdit.claim_before_edit_ratio === null ||
      isBelowTarget(claimBeforeEdit.claim_before_edit_ratio, TARGET_CLAIM_BEFORE_EDIT))
  ) {
    hints.push({
      metric: 'claim-before-edit',
      status: 'bad',
      current: `${claimBeforeEdit.edit_source_breakdown.codex_rollout_edits} Codex rollout edits, ${claimBeforeEdit.pre_tool_use_signals} PreToolUse signals`,
      target: 'Codex PreToolUse signals > 0',
      action:
        'Most edit evidence is from Codex rollouts, but no Codex PreToolUse hook or rollout bridge is firing. Install Codex hooks or add a rollout bridge before counting rollout edits as claim-before-edit eligible.',
      readiness_scope: 'execution_safety',
      priority: 10,
      command: 'colony install --ide codex  # then restart Codex',
      prompt: codexPrompt({
        goal: 'make Codex edits produce claim-before-edit telemetry before edit tools run',
        current: `${claimBeforeEdit.edit_source_breakdown.codex_rollout_edits} Codex rollout edits, ${claimBeforeEdit.pre_tool_use_signals} PreToolUse signals`,
        inspect:
          'packages/hooks/src/handlers/pre-tool-use.ts, packages/hooks/src/auto-claim.ts, apps/cli/src/lib/codex-rollouts.ts, colony install --ide codex',
        acceptance:
          'Codex PreToolUse or rollout bridge fires and claim-before-edit coverage can be measured',
      }),
    });
  } else if (
    !claimBeforeEdit.old_telemetry_pollution &&
    !suppressGenericTaskClaimAdvice &&
    preToolUseMissingDominates &&
    isBelowTarget(claimBeforeEdit.claim_before_edit_ratio, TARGET_CLAIM_BEFORE_EDIT)
  ) {
    const manualClaimAdoptionHigh =
      preToolUseMissing > 0 && claimBeforeEdit.task_claim_file_calls >= preToolUseMissing;
    hints.push({
      metric: 'claim-before-edit',
      status: 'bad',
      current: `pre_tool_use_missing: ${preToolUseMissing}, task_claim_file calls: ${claimBeforeEdit.task_claim_file_calls}`,
      target: 'pre_tool_use before file mutation',
      action: LIFECYCLE_BRIDGE_ACTION,
      readiness_scope: 'execution_safety',
      priority: 5,
      command: LIFECYCLE_BRIDGE_COMMAND,
      prompt: codexPrompt({
        goal: 'wire the runtime lifecycle bridge before file mutation',
        current: manualClaimAdoptionHigh
          ? `manual claims already high (${claimBeforeEdit.task_claim_file_calls}); pre_tool_use_missing dominates (${preToolUseMissing})`
          : `pre_tool_use_missing dominates (${preToolUseMissing})`,
        inspect:
          'colony bridge lifecycle --json --ide <ide> --cwd <repo_root>, packages/contracts/fixtures/colony-omx-lifecycle-v1/*.pre.json, packages/hooks/src/lifecycle-envelope.ts, pnpm smoke:codex-omx-pretool',
        acceptance:
          'runtime emits pre_tool_use before file mutation and pre_tool_use_missing stops dominating health misses',
      }),
    });
  } else if (
    claimBeforeEdit.old_telemetry_pollution &&
    isBelowTarget(claimBeforeEdit.claim_before_edit_ratio, TARGET_CLAIM_BEFORE_EDIT)
  ) {
    const oldTelemetryAction =
      claimBeforeEdit.root_cause?.kind === 'old_telemetry_pollution'
        ? claimBeforeEdit.root_cause.action
        : 'Wait for older telemetry to age out of the selected health window, or narrow --hours when checking current bridge state.';
    hints.push({
      metric: 'old claim-before-edit telemetry',
      status: 'bad',
      current: claimBeforeEdit.root_cause?.summary ?? OLD_TELEMETRY_POLLUTION_ROOT_CAUSE,
      target: 'recent pre_tool_use_missing = 0 stays clean until old telemetry ages out',
      action: oldTelemetryAction,
      readiness_scope: 'execution_safety',
      priority: 12,
      prompt: codexPrompt({
        goal: 'avoid chasing old claim-before-edit telemetry as the current blocker',
        current: `recent ${claimBeforeEdit.recent_window_hours}h hook_capable_edits=${claimBeforeEdit.recent_hook_capable_edits}, pre_tool_use_missing=${claimBeforeEdit.recent_pre_tool_use_missing}`,
        inspect: 'colony health --hours 1 --json, colony health --hours 24 --json',
        acceptance:
          'current failures are resolved first; selected-window claim-before-edit improves as old telemetry ages out',
      }),
    });
  } else if (
    !claimBeforeEdit.old_telemetry_pollution &&
    !suppressGenericTaskClaimAdvice &&
    isBelowTarget(claimBeforeEdit.claim_before_edit_ratio, TARGET_CLAIM_BEFORE_EDIT)
  ) {
    const missingHook =
      claimBeforeEdit.likely_missing_hook && !claimBeforeEdit.old_telemetry_pollution;
    const sessionBindingMissing = claimBeforeEdit.session_binding_missing > 0;
    hints.push({
      metric: 'claim-before-edit',
      status: 'bad',
      current: formatPercent(claimBeforeEdit.claim_before_edit_ratio),
      target: `${formatPercent(TARGET_CLAIM_BEFORE_EDIT)}+`,
      action: missingHook
        ? claimBeforeEdit.old_telemetry_pollution
          ? OLD_TELEMETRY_POLLUTION_ROOT_CAUSE
          : 'PreToolUse auto-claim hook is not firing for hook-capable edits. Reinstall and restart the editor; PreToolUse will auto-claim before edits.'
        : sessionBindingMissing
          ? 'PreToolUse is firing, but session binding is missing. Restart the editor so SessionStart binds the active session before relying on auto-claim.'
          : 'Call task_claim_file for touched files before Edit or Write tool use.',
      readiness_scope: 'execution_safety',
      priority: 10,
      tool_call:
        'mcp__colony__task_claim_file({ task_id: <task_id>, session_id: "<session_id>", file_path: "<file>", note: "pre-edit claim" })',
      command: missingHook
        ? 'colony install --ide <ide>  # then restart the editor session'
        : sessionBindingMissing
          ? 'colony install --ide <ide>  # then restart the editor session to refresh SessionStart binding'
          : 'colony install --ide <ide>  # enables pre-edit auto-claim hooks',
      prompt: codexPrompt({
        goal: missingHook
          ? 'restore pre-edit auto-claim for hook-capable edits'
          : sessionBindingMissing
            ? 'bind PreToolUse telemetry to the active Colony session'
            : 'make every edit visible through task_claim_file before editing',
        current: `claim-before-edit ${formatPercent(claimBeforeEdit.claim_before_edit_ratio)}, missing ${claimBeforeEdit.edits_without_claim_before}`,
        inspect:
          'mcp__colony__task_claim_file, packages/hooks/src/handlers/pre-tool-use.ts, packages/hooks/src/auto-claim.ts, packages/hooks/test/auto-claim.test.ts',
        acceptance:
          'claim-before-edit reaches target and agents still manually call task_claim_file until hooks are proven',
      }),
    });
  }

  if (queenInactiveWithSubtasks) {
    hints.push({
      metric: 'Queen activation/claim',
      status: 'bad',
      current: `active plans ${payload.queen_wave_health.active_plans}, plan subtasks ${payload.ready_to_claim_vs_claimed.plan_subtasks}`,
      target: 'active Queen plan or claimed repair subtask',
      action:
        'Reactivate Queen planning or claim/requeue the existing plan subtask so task_ready_for_agent surfaces concrete repair work.',
      readiness_scope: 'queen_plan_readiness',
      priority: 7,
      tool_call:
        'mcp__colony__task_ready_for_agent({ agent: "<agent>", session_id: "<session_id>", repo_root: "<repo_root>" }) -> mcp__colony__task_plan_claim_subtask(...) or mcp__colony__queen_plan_goal(...)',
      prompt: codexPrompt({
        goal: 'repair inactive Queen plan state with existing subtasks',
        current: `${payload.queen_wave_health.active_plans} active Queen plans, ${payload.ready_to_claim_vs_claimed.plan_subtasks} plan subtask(s) exist`,
        inspect:
          'mcp__colony__task_ready_for_agent, mcp__colony__task_plan_claim_subtask, mcp__colony__queen_plan_goal, colony health --json',
        acceptance:
          'Queen has an active plan with claimable subtasks, or existing subtasks are claimed/requeued with evidence',
      }),
    });
  }

  if (queenReadyWithoutClaims && !queenInactiveWithSubtasks) {
    hints.push({
      metric: 'Queen ready subtask claim',
      status: 'bad',
      current: `${payload.ready_to_claim_vs_claimed.ready_to_claim} ready, ${payload.ready_to_claim_vs_claimed.claimed} claimed`,
      target: 'ready subtasks claimed',
      action:
        'Claim the ready Queen subtask with task_plan_claim_subtask before starting implementation.',
      readiness_scope: 'queen_plan_readiness',
      priority: 7,
      tool_call:
        'mcp__colony__task_plan_claim_subtask({ agent: "<agent>", session_id: "<session_id>", plan_slug: "<plan_slug>", subtask_index: <index> })',
      prompt: codexPrompt({
        goal: 'claim ready Queen work before starting implementation',
        current: `${payload.ready_to_claim_vs_claimed.ready_to_claim} ready Queen subtask(s), 0 claimed`,
        inspect: 'mcp__colony__task_ready_for_agent, mcp__colony__task_plan_claim_subtask',
        acceptance: 'ready Queen subtasks are claimed or intentionally deferred with evidence',
      }),
    });
  }

  const queenStateRepair = payload.queen_wave_health.plan_state_recommendations.find(
    (item) => item.recommendation.action !== 'claim-ready-subtasks',
  );
  if (queenStateRepair) {
    hints.push({
      metric: 'Queen plan state repair',
      status: 'bad',
      current: `${queenStateRepair.plan_slug} ${queenStateRepair.state}; remaining ${queenStateRepair.remaining_subtask_count}`,
      target: 'active plan with claimable work or archived completed plan',
      action: queenStateRepair.recommendation.summary,
      readiness_scope: 'queen_plan_readiness',
      priority:
        queenStateRepair.recommendation.action === 'delete-orphan-subtasks'
          ? 8
          : queenStateRepair.recommendation.action === 'reactivate-plan'
            ? 8
            : 9,
      ...(queenStateRepair.recommendation.tool_call
        ? { tool_call: queenStateRepair.recommendation.tool_call }
        : {}),
      ...(queenStateRepair.recommendation.command
        ? { command: queenStateRepair.recommendation.command }
        : {}),
      prompt: codexPrompt({
        goal: 'repair Queen plan state before treating subtasks as ready work',
        current: `${queenStateRepair.plan_slug} is ${queenStateRepair.state} with ${queenStateRepair.remaining_subtask_count} remaining subtask(s)`,
        inspect:
          'colony queen sweep --json, colony coordination sweep --archive-completed-plans, colony health --json, mcp__colony__task_plan_list',
        acceptance:
          'completed plans are archived, inactive plans are reactivated, orphan subtasks are deleted, or a replacement plan is published',
      }),
    });
  }

  if (
    payload.queen_wave_health.active_plans === 0 &&
    payload.ready_to_claim_vs_claimed.plan_subtasks === 0
  ) {
    hints.push({
      metric: 'Queen plan activation',
      status: 'bad',
      current: `active plans ${payload.queen_wave_health.active_plans}, plan subtasks ${payload.ready_to_claim_vs_claimed.plan_subtasks}`,
      target: 'active plans > 0 for multi-agent work',
      action:
        'Publish a Queen/task plan for multi-agent work so task_ready_for_agent can return claimable subtasks.',
      readiness_scope: 'queen_plan_readiness',
      priority: 20,
      tool_call:
        'mcp__colony__queen_plan_goal({ session_id: "<session_id>", repo_root: "<repo_root>", goal_title: "<goal>", problem: "<problem>", acceptance_criteria: ["<done>"] })',
      prompt: codexPrompt({
        goal: 'activate Queen planning for multi-agent work',
        current: `active Queen plans ${payload.queen_wave_health.active_plans}, plan subtasks ${payload.ready_to_claim_vs_claimed.plan_subtasks}`,
        inspect:
          'mcp__colony__queen_plan_goal, mcp__colony__task_plan_publish, mcp__colony__task_ready_for_agent, docs/QUEEN.md',
        acceptance:
          'a plan exists with claimable subtasks and task_ready_for_agent returns exact claim args',
      }),
    });
  }

  if (
    payload.proposal_health.proposals_seen === 0 ||
    (payload.proposal_health.pending > 0 &&
      payload.proposal_health.promoted === 0 &&
      payload.proposal_health.promotion_rate === 0)
  ) {
    hints.push({
      metric: 'proposal adoption',
      status: 'bad',
      current: `seen ${payload.proposal_health.proposals_seen}, pending ${payload.proposal_health.pending}, promoted ${payload.proposal_health.promoted}`,
      target: 'pending or promoted proposals > 0',
      action:
        'Use task_foraging_report before inventing work; propose future work with task_propose and reinforce rediscovered candidates with task_reinforce.',
      readiness_scope: 'adoption_followup',
      priority: 90,
      tool_call:
        'mcp__colony__task_foraging_report({ repo_root: "<repo_root>", branch: "<branch>" })',
      prompt: codexPrompt({
        goal: 'make future-work candidates flow through proposals instead of chat-only notes',
        current: `proposals seen ${payload.proposal_health.proposals_seen}, promoted ${payload.proposal_health.promoted}`,
        inspect:
          'mcp__colony__task_foraging_report, mcp__colony__task_propose, mcp__colony__task_reinforce, packages/core/src/proposal-system.ts',
        acceptance:
          'task_foraging_report shows pending/promoted work and rediscovered proposals can promote into tasks',
      }),
    });
  }

  if (payload.signal_health.stale_claims > 0) {
    hints.push({
      metric: 'stale claims',
      status: 'bad',
      current: String(payload.signal_health.stale_claims),
      target: '0',
      action:
        'Run a dry stale-claim sweep; release only safe inactive/non-dirty claims with --release-safe-stale-claims, and hand off or reclaim the rest.',
      readiness_scope: 'signal_evaporation',
      priority: 11,
      tool_call: 'mcp__colony__rescue_stranded_scan({ stranded_after_minutes: <minutes> })',
      command: STALE_CLAIM_SWEEP_COMMAND,
      prompt: codexPrompt({
        goal: 'clear stale ownership before agents trust current file claims',
        current: `${payload.signal_health.stale_claims} stale claims`,
        inspect:
          'colony coordination sweep --json, colony coordination sweep --release-safe-stale-claims --json, mcp__colony__rescue_stranded_scan, mcp__colony__hivemind_context',
        acceptance: 'stale claims are released, handed off, or reclaimed with audit evidence',
      }),
    });
  }

  if (
    payload.signal_health.quota_pending_claims > 0 &&
    (payload.signal_health.quota_relay_examples.length === 0 ||
      payload.signal_health.quota_relay_actions.top_action !== 'none')
  ) {
    const quotaAction = quotaRelayActionHint(payload.signal_health);
    hints.push({
      metric: 'quota relay accept/release',
      status: 'bad',
      current: quotaAction.current,
      target: '0',
      action: quotaAction.action,
      readiness_scope: 'signal_evaporation',
      priority: 6,
      tool_call: quotaAction.tool_call,
      command: quotaAction.command,
      prompt: codexPrompt({
        goal: 'resolve quota-pending ownership without deleting claim history',
        current: quotaAction.current,
        inspect: quotaAction.inspect,
        acceptance: 'quota relay is accepted or expires into weak audit-only ownership',
      }),
    });
  }

  if (payload.queen_wave_health.stale_claims_blocking_downstream > 0) {
    hints.push({
      metric: 'stale claims blocking downstream',
      status: 'bad',
      current: String(payload.queen_wave_health.stale_claims_blocking_downstream),
      target: '0',
      action: 'Run colony queen sweep/rescue so later waves can become claimable.',
      readiness_scope: 'queen_plan_readiness',
      priority: 3,
      tool_call: 'mcp__colony__rescue_stranded_scan({ stranded_after_minutes: <minutes> })',
      command: 'colony queen sweep --json',
      prompt: codexPrompt({
        goal: 'unblock downstream Queen waves',
        current: `${payload.queen_wave_health.stale_claims_blocking_downstream} stale blockers`,
        inspect:
          'colony queen sweep --json, mcp__colony__rescue_stranded_scan, packages/queen/src/sweep.ts',
        acceptance: 'stale blockers are rescued and later wave subtasks become claimable',
      }),
    });
  }

  if (payload.queen_wave_health.quota_handoffs_blocking_downstream > 0) {
    hints.push({
      metric: 'quota handoffs blocking downstream',
      status: 'bad',
      current: String(payload.queen_wave_health.quota_handoffs_blocking_downstream),
      target: '0',
      action: 'Accept or reroute quota relays before waiting on downstream waves.',
      readiness_scope: 'queen_plan_readiness',
      priority: 24,
      tool_call:
        'mcp__colony__attention_inbox({ agent: <agent>, session_id: <session_id>, repo_root: <repo_root> })',
      command: 'colony inbox --json',
      prompt: codexPrompt({
        goal: 'unblock downstream Queen waves held by quota relays',
        current: `${payload.queen_wave_health.quota_handoffs_blocking_downstream} quota blockers`,
        inspect: 'colony inbox --json, task_accept_relay, task_decline_relay',
        acceptance: 'quota relays are accepted, declined, or expired with audit trail intact',
      }),
    });
  }

  if (
    payload.task_post_vs_omx_notepad.status === 'available' &&
    isBelowTarget(payload.task_post_vs_omx_notepad.colony_note_share, TARGET_COLONY_NOTE_SHARE)
  ) {
    hints.push({
      metric: 'task_post/task_note_working share',
      status: 'bad',
      current: formatPercent(payload.task_post_vs_omx_notepad.colony_note_share),
      target: `${formatPercent(TARGET_COLONY_NOTE_SHARE)}+`,
      action:
        'Use task_note_working first for working state; use task_post when task_id is known; use OMX notepad only when Colony is unavailable.',
      readiness_scope: 'working_state_migration',
      priority: 50,
      tool_call:
        'mcp__colony__task_note_working({ session_id: "<session_id>", repo_root: "<repo_root>", branch: "<branch>", content: "branch=<branch>; task=<task>; blocker=<blocker>; next=<next>; evidence=<evidence>" })',
      prompt: codexPrompt({
        goal: 'store resumable working state in Colony before OMX notepad fallback',
        current: `Colony note share ${formatPercent(payload.task_post_vs_omx_notepad.colony_note_share)}`,
        inspect: 'mcp__colony__task_note_working, mcp__colony__task_post, .omx/notepad.md',
        acceptance:
          'working notes use branch/task/blocker/next/evidence and OMX notepad is only fallback',
      }),
    });
  }

  return hints;
}

function isDominantPreToolUseMiss(reasons: ClaimMissReasons): boolean {
  const preToolUseMissing = reasons.pre_tool_use_missing;
  if (preToolUseMissing <= 0) return false;
  const otherMax = Math.max(
    reasons.no_claim_for_file,
    reasons.claim_after_edit,
    reasons.session_id_mismatch,
    reasons.repo_root_mismatch,
    reasons.branch_mismatch,
    reasons.path_mismatch,
    reasons.worktree_path_mismatch,
    reasons.pseudo_path_skipped,
  );
  return preToolUseMissing >= otherMax;
}

function isLifecycleRootCauseKind(kind: RootCauseSummary['kind']): boolean {
  return kind !== 'old_telemetry_pollution';
}

function visibleActionHints(
  payload: ColonyHealthPayload,
  options: { verbose: boolean },
): ActionHint[] {
  const byPriority = (hints: ActionHint[]) => [...hints].sort(compareActionHints);
  const directBlockerHints = (hints: ActionHint[]) =>
    hints.filter(
      (hint) =>
        hint.metric === 'OMX runtime bridge' ||
        hint.metric === 'quota relay accept/release' ||
        hint.metric === 'Queen activation/claim' ||
        hint.metric === 'Queen ready subtask claim',
    );
  const uniqueHints = (hints: ActionHint[]) => {
    const seen = new Set<string>();
    return hints.filter((hint) => {
      const key = `${hint.metric}:${hint.current}:${hint.target}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  if (options.verbose) return byPriority(payload.action_hints);

  const badReadinessScopes = new Set<ReadinessScope>(
    Object.entries(payload.readiness_summary)
      .filter(([, item]) => item.status === 'bad')
      .map(([scope]) => scope as ReadinessScope),
  );
  const readinessBottlenecks = payload.action_hints.filter((hint) =>
    badReadinessScopes.has(hint.readiness_scope),
  );
  if (readinessBottlenecks.length > 0) {
    return byPriority(
      uniqueHints([...readinessBottlenecks, ...directBlockerHints(payload.action_hints)]),
    );
  }
  const directBlockers = directBlockerHints(payload.action_hints);
  if (directBlockers.length > 0) return byPriority(directBlockers);

  return byPriority(
    payload.action_hints.filter((hint) => hint.readiness_scope === 'adoption_followup'),
  );
}

function compareActionHints(left: ActionHint, right: ActionHint): number {
  return (
    actionHintScopeRank(left) - actionHintScopeRank(right) ||
    left.priority - right.priority ||
    left.metric.localeCompare(right.metric)
  );
}

function actionHintScopeRank(hint: ActionHint): number {
  if (hint.metric === 'old claim-before-edit telemetry') return 1.5;
  return readinessScopeRank(hint.readiness_scope);
}

function readinessScopeRank(scope: ReadinessScope): number {
  if (scope === 'execution_safety') return 0;
  if (scope === 'signal_evaporation') return 1;
  if (scope === 'queen_plan_readiness') return 2;
  if (scope === 'working_state_migration') return 3;
  if (scope === 'coordination_readiness') return 4;
  return 5;
}

function adoptionThresholds(
  calls: ToolCallRow[],
  metrics: {
    colony_mcp_share: number | null;
    task_claim_file_calls: number;
    task_post_calls: number;
    task_note_working_calls: number;
  },
): AdoptionThresholdsPayload {
  const hivemindContextCalls = countTool(calls, 'hivemind_context');
  const taskListCalls = countTool(calls, 'task_list');
  const taskReadyCalls = countTool(calls, 'task_ready_for_agent');
  const attentionInboxCalls = countTool(calls, 'attention_inbox');
  const colonyWorkingNoteCalls = metrics.task_post_calls + metrics.task_note_working_calls;
  const notepadWriteWorkingCalls = countAnyTool(calls, [
    'mcp__omx_memory__notepad_write_working',
    'omx_notepad_write_working',
    'notepad_write_working',
  ]);
  const colonyNoteShare = ratio(
    colonyWorkingNoteCalls,
    colonyWorkingNoteCalls + notepadWriteWorkingCalls,
  );

  return {
    good: [
      {
        name: 'hivemind_context rising',
        status: hivemindContextCalls > 0 ? 'good' : 'needs_attention',
        value: hivemindContextCalls,
        target: null,
        hint: 'Keep hivemind_context as the first coordination read.',
      },
      {
        name: 'task_claim_file rising',
        status: metrics.task_claim_file_calls > 0 ? 'good' : 'needs_attention',
        value: metrics.task_claim_file_calls,
        target: null,
        hint: 'Claim files before edits so ownership is visible.',
      },
      {
        name: 'MCP share rising',
        status:
          metrics.colony_mcp_share !== null && metrics.colony_mcp_share > 0
            ? 'good'
            : 'needs_attention',
        value: metrics.colony_mcp_share,
        target: null,
        hint: 'Colony MCP calls should take a visible share of MCP traffic.',
      },
    ],
    bad: [
      {
        name: 'task_list > task_ready_for_agent',
        status: taskListCalls > taskReadyCalls ? 'bad' : 'ok',
        value: taskListCalls - taskReadyCalls,
        target: TARGET_TASK_LIST_TO_READY,
        hint: 'Use task_ready_for_agent to choose claimable work; task_list is inventory.',
      },
      {
        name: 'notepad_write_working > task_post/task_note_working',
        status:
          colonyNoteShare !== null && colonyNoteShare < TARGET_COLONY_NOTE_SHARE ? 'bad' : 'ok',
        value: notepadWriteWorkingCalls - colonyWorkingNoteCalls,
        target: TARGET_COLONY_NOTE_SHARE,
        hint: 'Use task_note_working first; use task_post only when task_id is already known.',
      },
      {
        name: 'attention_inbox = 0',
        status: attentionInboxCalls === 0 ? 'bad' : 'ok',
        value: attentionInboxCalls,
        target: TARGET_HIVEMIND_TO_ATTENTION,
        hint: 'Call attention_inbox after hivemind_context.',
      },
      {
        name: 'task_ready_for_agent = 0',
        status: taskReadyCalls === 0 ? 'bad' : 'ok',
        value: taskReadyCalls,
        target: TARGET_TASK_LIST_TO_READY,
        hint: 'Call task_ready_for_agent before choosing work.',
      },
    ],
  };
}

function formatSignal(signal: AdoptionSignal): string {
  const target = signal.target === null ? '' : ` target ${formatPercent(signal.target)}+;`;
  return `  ${formatSignalStatus(signal.status)} ${signal.name}: ${formatSignalValue(signal.value)} -${target} ${signal.hint}`;
}

function formatSignalStatus(status: AdoptionSignal['status']): string {
  const label = status.padEnd(15);
  if (status === 'good') return kleur.green(label);
  if (status === 'bad') return kleur.red(label);
  return kleur.yellow(label);
}

function formatSignalValue(value: number | null): string {
  return value === null ? 'n/a' : String(value);
}

function countTool(calls: ToolCallRow[], toolName: string): number {
  return calls.filter((call) => isColonyTool(call.tool, toolName)).length;
}

function countAnyTool(calls: ToolCallRow[], tools: string[]): number {
  const names = new Set(tools);
  return calls.filter((call) => names.has(call.tool)).length;
}

function topToolsByCount(
  calls: ToolCallRow[],
  limit: number,
): Array<{ tool: string; calls: number }> {
  const counts = new Map<string, number>();
  for (const call of calls) {
    counts.set(call.tool, (counts.get(call.tool) ?? 0) + 1);
  }
  return Array.from(counts, ([tool, count]) => ({ tool, calls: count }))
    .sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool))
    .slice(0, limit);
}

function isMcpTool(tool: string): boolean {
  return tool.startsWith('mcp__') || tool.startsWith('colony.');
}

function isColonyMcpTool(tool: string): boolean {
  return tool.startsWith('mcp__colony__') || tool.startsWith('colony.');
}

function isColonyTool(tool: string, toolName: string): boolean {
  return tool === toolName || tool === `colony.${toolName}` || tool === `mcp__colony__${toolName}`;
}

function isOmxMetricTool(tool: string): boolean {
  return tool.includes('omx') || tool.includes('notepad');
}

function isOmxNotepadWrite(tool: string): boolean {
  return /(^|[_:.])notepad_write(_|$)/.test(tool) || /omx.*notepad.*write/i.test(tool);
}

function conversionKey(fromTool: string, toTool: string): ConversionName {
  return `${fromTool}_to_${toTool}` as ConversionName;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function isBelowTarget(value: number | null, target: number): boolean {
  return value !== null && value < target;
}

function isAtOrAboveTarget(value: number | null, target: number): boolean {
  return value !== null && value >= target;
}

function countRatio(numerator: number, denominator: number, value: number | null): string {
  return `${numerator} / ${denominator} (${formatPercent(value)})`;
}

function formatPercent(value: number | null): string {
  return value === null ? 'n/a' : `${Math.round(value * 100)}%`;
}

function formatNumber(value: number | null): string {
  return value === null ? 'n/a' : value.toFixed(2);
}

function formatDuration(value: number | null): string {
  if (value === null) return 'n/a';
  const minutes = Math.round(value / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return `${hours}h`;
}

function knownBranchProposals(
  storage: Pick<Storage, 'listProposalsForBranch'>,
  tasks: TaskRow[],
): ProposalRow[] {
  const pairs = new Map<string, { repo_root: string; branch: string }>();
  for (const task of tasks) {
    pairs.set(`${task.repo_root}\0${task.branch}`, {
      repo_root: task.repo_root,
      branch: task.branch,
    });
  }
  const proposals = new Map<number, ProposalRow>();
  for (const pair of pairs.values()) {
    for (const proposal of storage.listProposalsForBranch(pair.repo_root, pair.branch)) {
      proposals.set(proposal.id, proposal);
    }
  }
  return [...proposals.values()];
}

function currentProposalStrength(
  proposal: ProposalRow,
  reinforcements: ReinforcementRow[],
  now: number,
): number {
  const signal = signalMetadataFromProposal(proposal, {
    reinforcements,
    half_life_minutes: 60,
  });
  return currentSignalStrength(signal, now);
}

function isExpiredLifecycleRow(
  row: ObservationRow,
  now: number,
  kind: 'handoff' | 'message',
): boolean {
  const metadata = parseJsonObject(row.metadata);
  const status = metadata.status;
  if (status === 'expired') return true;
  const signal = signalMetadataFromObservation(row, {
    signal_kind: kind,
    expires_at: kind === 'handoff' ? row.ts + DEFAULT_HANDOFF_TTL_MS : null,
  });
  if (!signal || !isSignalExpired(signal, now)) return false;
  return kind === 'handoff' ? status === 'pending' : status === 'unread';
}

interface PlanSubtaskHealth {
  task_id: number;
  repo_root: string;
  plan_slug: string;
  index: number;
  title: string;
  status: 'available' | 'claimed' | 'completed' | 'blocked';
  depends_on: number[];
  file_scope: string[];
  claimed_at: number | null;
  claimed_by_session_id: string | null;
  claimed_by_agent: string | null;
  quota_handoff_pending: boolean;
  wave_index: number;
  wave_name: string;
}

function readPlanSubtasks(
  storage: Pick<Storage, 'taskTimeline'>,
  tasks: TaskRow[],
): PlanSubtaskHealth[] {
  const subtasks: PlanSubtaskHealth[] = [];
  for (const task of tasks) {
    const branchMatch = task.branch.match(PLAN_SUBTASK_BRANCH_RE);
    const planSlug = branchMatch?.[1];
    const index = branchMatch?.[2] ? Number(branchMatch[2]) : Number.NaN;
    if (!planSlug || !Number.isFinite(index)) continue;
    const rows = storage.taskTimeline(task.id, 500);
    const initial = rows.find((row) => row.kind === 'plan-subtask');
    if (!initial) continue;
    const initialMeta = parseJsonObject(initial.metadata);
    const lifecycle = readSubtaskLifecycle(rows, initialMeta, initial.ts);
    const titleLine = initial.content.split('\n\n')[0] ?? '(untitled)';
    subtasks.push({
      task_id: task.id,
      repo_root: task.repo_root,
      plan_slug: planSlug,
      index,
      title: typeof initialMeta.title === 'string' ? initialMeta.title : titleLine,
      status: lifecycle.status,
      depends_on: readNumberArray(initialMeta.depends_on),
      file_scope: readStringArrayMetadata(initialMeta.file_scope),
      claimed_at: lifecycle.claimed_at,
      claimed_by_session_id: lifecycle.claimed_by_session_id,
      claimed_by_agent: lifecycle.claimed_by_agent,
      quota_handoff_pending: lifecycle.quota_handoff_pending,
      wave_index: 0,
      wave_name: 'Wave 1',
    });
  }
  return annotatePlanSubtaskWaves(subtasks);
}

function readSubtaskLifecycle(
  rows: ObservationRow[],
  initialMeta: Record<string, unknown>,
  initialTs: number,
): Pick<
  PlanSubtaskHealth,
  'status' | 'claimed_at' | 'claimed_by_session_id' | 'claimed_by_agent' | 'quota_handoff_pending'
> {
  const quota_handoff_pending = rows.some((row) => {
    if (row.kind !== 'relay') return false;
    const meta = parseJsonObject(row.metadata);
    return meta.reason === 'quota' && meta.status === 'pending';
  });
  const claimRows = rows
    .filter((row) => row.kind === 'plan-subtask-claim')
    .map((row) => ({ row, metadata: parseJsonObject(row.metadata) }))
    .filter((entry) => isPlanSubtaskStatus(entry.metadata.status))
    .sort((a, b) => b.row.ts - a.row.ts || b.row.id - a.row.id);
  const completed = claimRows.find((entry) => entry.metadata.status === 'completed');
  const resolved = completed ?? claimRows[0];
  if (resolved) {
    const status = resolved.metadata.status as PlanSubtaskHealth['status'];
    return {
      status,
      claimed_at: status === 'claimed' ? resolved.row.ts : null,
      claimed_by_session_id:
        status === 'claimed' && typeof resolved.metadata.session_id === 'string'
          ? (resolved.metadata.session_id as string)
          : null,
      claimed_by_agent:
        status === 'claimed' && typeof resolved.metadata.agent === 'string'
          ? (resolved.metadata.agent as string)
          : null,
      quota_handoff_pending,
    };
  }
  const initialStatus = initialMeta.status;
  if (
    initialStatus === 'available' ||
    initialStatus === 'claimed' ||
    initialStatus === 'completed' ||
    initialStatus === 'blocked'
  ) {
    return {
      status: initialStatus,
      claimed_at: initialStatus === 'claimed' ? initialTs : null,
      claimed_by_session_id:
        initialStatus === 'claimed' ? readStringOrNull(initialMeta.session_id) : null,
      claimed_by_agent: initialStatus === 'claimed' ? readStringOrNull(initialMeta.agent) : null,
      quota_handoff_pending,
    };
  }
  return {
    status: 'available',
    claimed_at: null,
    claimed_by_session_id: null,
    claimed_by_agent: null,
    quota_handoff_pending,
  };
}

function queenPlanStateSummaries(
  storage: Pick<Storage, 'taskObservationsByKind'>,
  tasks: TaskRow[],
  subtasks: PlanSubtaskHealth[],
): QueenPlanStateSummary[] {
  const rootTasks = new Map<string, TaskRow>();
  const tasksById = new Map<number, TaskRow>();
  for (const task of tasks) {
    tasksById.set(task.id, task);
    const rootMatch = task.branch.match(PLAN_ROOT_BRANCH_RE);
    if (rootMatch?.[1]) rootTasks.set(planKey(task.repo_root, rootMatch[1]), task);
  }

  const summaries: QueenPlanStateSummary[] = [];
  for (const [groupKey, siblings] of groupPlanSubtasksByRepo(subtasks)) {
    const [repoRoot, planSlug] = splitPlanKey(groupKey);
    const root = rootTasks.get(groupKey) ?? null;
    const completedSubtaskCount = siblings.filter(
      (subtask) => subtask.status === 'completed',
    ).length;
    // Archived sub-tasks are intentionally closed out (`colony queen archive`
    // or auto-archive on plan cancellation) and don't represent unfinished
    // work. The lifecycle status read from `plan-subtask-claim` observations
    // never carries an `archived` value, so detect archive state via the
    // `tasks` row that `archiveQueenPlan` flips. Without this, a fully
    // archived plan keeps tripping `archived_plans_with_remaining_subtasks`
    // even after every row is closed.
    const archivedSubtaskCount = siblings.filter(
      (subtask) => tasksById.get(subtask.task_id)?.status === 'archived',
    ).length;
    const remainingSubtaskCount = siblings.length - completedSubtaskCount - archivedSubtaskCount;
    const readySubtaskCount = siblings.filter((subtask) =>
      isReadyPlanSubtask(subtask, siblings),
    ).length;
    const claimedSubtaskCount = siblings.filter((subtask) => subtask.status === 'claimed').length;
    const blockedSubtaskCount = siblings.filter((subtask) =>
      isBlockedPlanSubtask(subtask, siblings),
    ).length;
    const state = classifyQueenPlanState(storage, root, remainingSubtaskCount);

    summaries.push({
      plan_slug: planSlug,
      repo_root: repoRoot,
      state,
      parent_task_id: root?.id ?? null,
      parent_task_status: root?.status ?? null,
      subtask_count: siblings.length,
      completed_subtask_count: completedSubtaskCount,
      remaining_subtask_count: remainingSubtaskCount,
      ready_subtask_count: readySubtaskCount,
      claimed_subtask_count: claimedSubtaskCount,
      blocked_subtask_count: blockedSubtaskCount,
      recommendation: queenPlanStateRecommendation(state, {
        plan_slug: planSlug,
        repo_root: repoRoot,
        ready_subtask_count: readySubtaskCount,
        remaining_subtask_count: remainingSubtaskCount,
        parent_task_status: root?.status ?? null,
      }),
    });
  }

  return summaries.sort(
    (a, b) =>
      queenPlanStateRank(a.state) - queenPlanStateRank(b.state) ||
      a.plan_slug.localeCompare(b.plan_slug),
  );
}

function classifyQueenPlanState(
  storage: Pick<Storage, 'taskObservationsByKind'>,
  root: TaskRow | null,
  remainingSubtaskCount: number,
): QueenPlanLifecycleState {
  if (root === null) return 'orphan-subtasks';
  const status = root.status.toLowerCase();
  if (
    status === 'archived' ||
    status === 'auto-archived' ||
    storage.taskObservationsByKind(root.id, 'plan-archived', 1).length > 0 ||
    storage.taskObservationsByKind(root.id, 'plan-auto-archive', 1).length > 0
  ) {
    return 'archived';
  }
  if (remainingSubtaskCount === 0) return 'completed';
  if (status !== 'open' && status !== 'active') return 'inactive-with-remaining-subtasks';
  return 'active';
}

function queenPlanStateRecommendation(
  state: QueenPlanLifecycleState,
  plan: {
    plan_slug: string;
    repo_root: string;
    ready_subtask_count: number;
    remaining_subtask_count: number;
    parent_task_status: string | null;
  },
): QueenPlanRepairRecommendation {
  if (state === 'completed') {
    return {
      action: 'archive-completed-plan',
      summary: 'All subtasks are complete; archive the completed plan.',
      command: `colony plan close ${plan.plan_slug} --cwd ${shellQuote(plan.repo_root)}`,
      tool_call:
        'mcp__colony__spec_archive({ agent: "<agent>", session_id: "<session_id>", repo_root: "<repo_root>", slug: "<plan_slug>" })',
    };
  }
  if (state === 'orphan-subtasks') {
    return {
      action: 'delete-orphan-subtasks',
      summary:
        'Subtasks exist without a spec/<plan> parent task; delete orphan subtasks or publish a new plan before claiming work.',
      command: null,
      tool_call: null,
    };
  }
  if (state === 'inactive-with-remaining-subtasks') {
    return {
      action: 'reactivate-plan',
      summary: `Plan root is ${plan.parent_task_status ?? 'inactive'} with ${plan.remaining_subtask_count} remaining subtask(s); reactivate it before claiming work.`,
      command: null,
      tool_call:
        'mcp__colony__task_plan_publish({ session_id: "<session_id>", agent: "<agent>", repo_root: "<repo_root>", slug: "<replacement_slug>", subtasks: [...] })',
    };
  }
  if (state === 'archived') {
    return {
      action: plan.remaining_subtask_count > 0 ? 'publish-new-plan' : 'none',
      summary:
        plan.remaining_subtask_count > 0
          ? 'Archived plan still has remaining subtasks; publish a new plan for follow-up work.'
          : 'Plan is archived; no action needed.',
      command:
        plan.remaining_subtask_count > 0
          ? `colony queen plan --repo-root ${shellQuote(plan.repo_root)} "<goal>"`
          : null,
      tool_call:
        plan.remaining_subtask_count > 0
          ? 'mcp__colony__queen_plan_goal({ session_id: "<session_id>", repo_root: "<repo_root>", goal_title: "<goal>", problem: "<problem>", acceptance_criteria: ["<done>"] })'
          : null,
    };
  }
  if (plan.ready_subtask_count > 0) {
    return {
      action: 'claim-ready-subtasks',
      summary: `${plan.ready_subtask_count} ready subtask(s) should be claimed.`,
      command: null,
      tool_call:
        'mcp__colony__task_plan_claim_subtask({ agent: "<agent>", session_id: "<session_id>", plan_slug: "<plan_slug>", subtask_index: <index> })',
    };
  }
  return {
    action: 'none',
    summary: 'Plan is active but no subtask is currently claimable.',
    command: null,
    tool_call: null,
  };
}

function queenPlanStateRank(state: QueenPlanLifecycleState): number {
  if (state === 'orphan-subtasks') return 0;
  if (state === 'inactive-with-remaining-subtasks') return 1;
  if (state === 'completed') return 2;
  if (state === 'archived') return 3;
  return 4;
}

function queenWaveHealthPayload(
  storage: Pick<Storage, 'taskTimeline' | 'taskObservationsByKind' | 'listClaims' | 'getSession'>,
  tasks: TaskRow[],
  options: { now: number; stale_claim_minutes: number },
): QueenWaveHealthPayload {
  const plans: QueenWavePlanSummary[] = [];
  const subtasks = readPlanSubtasks(storage, tasks);
  const planStates = queenPlanStateSummaries(storage, tasks, subtasks);
  const activePlanSlugs = new Set(
    planStates
      .filter((state) => state.state === 'active')
      .map((state) => planKey(state.repo_root, state.plan_slug)),
  );

  for (const [groupKey, planSubtasks] of groupPlanSubtasksByRepo(subtasks)) {
    const [repoRoot, planSlug] = splitPlanKey(groupKey);
    if (!activePlanSlugs.has(planKey(repoRoot, planSlug))) continue;
    const incomplete = planSubtasks.filter((subtask) => subtask.status !== 'completed');
    if (incomplete.length === 0) continue;

    const currentWaveIndex = Math.min(...incomplete.map((subtask) => subtask.wave_index));
    const currentWave =
      planSubtasks.find((subtask) => subtask.wave_index === currentWaveIndex)?.wave_name ?? null;
    const readySubtasks = planSubtasks
      .filter((subtask) => isReadyPlanSubtask(subtask, planSubtasks))
      .sort((a, b) => a.index - b.index);
    const downstreamBlockers = staleDownstreamBlockers(planSubtasks, options);

    plans.push({
      plan_slug: planSlug,
      current_wave: currentWave,
      ready_subtasks: readySubtasks.length,
      claimed_subtasks: planSubtasks.filter((subtask) => subtask.status === 'claimed').length,
      blocked_subtasks: planSubtasks.filter((subtask) =>
        isBlockedPlanSubtask(subtask, planSubtasks),
      ).length,
      next_ready_subtask_index: readySubtasks[0]?.index ?? null,
      next_ready_subtask_title: readySubtasks[0]?.title ?? null,
      stale_claims_blocking_downstream: downstreamBlockers.length,
      downstream_blockers: downstreamBlockers,
      quota_handoffs_blocking_downstream: planSubtasks.filter(
        (subtask) => subtask.quota_handoff_pending && blocksDownstream(subtask, planSubtasks),
      ).length,
      replacement_recommendation: planReplacementRecommendation(
        storage,
        planSlug,
        planSubtasks,
        options,
      ),
    });
  }

  const currentWaves = new Set(plans.map((plan) => plan.current_wave).filter(Boolean));
  const stateRecommendations = planStates.filter(
    (state) =>
      state.recommendation.action !== 'none' &&
      state.recommendation.action !== 'claim-ready-subtasks',
  );
  return {
    active_plans: plans.length,
    completed_plans: planStates.filter((state) => state.state === 'completed').length,
    archived_plans: planStates.filter((state) => state.state === 'archived').length,
    archived_plans_with_remaining_subtasks: planStates.filter(
      (state) => state.state === 'archived' && state.remaining_subtask_count > 0,
    ).length,
    orphan_subtasks: planStates
      .filter((state) => state.state === 'orphan-subtasks')
      .reduce((sum, state) => sum + state.subtask_count, 0),
    inactive_plans_with_remaining_subtasks: planStates.filter(
      (state) => state.state === 'inactive-with-remaining-subtasks',
    ).length,
    current_wave:
      plans.length === 0
        ? null
        : currentWaves.size === 1
          ? (plans[0]?.current_wave ?? null)
          : 'multiple',
    ready_subtasks: plans.reduce((sum, plan) => sum + plan.ready_subtasks, 0),
    claimed_subtasks: plans.reduce((sum, plan) => sum + plan.claimed_subtasks, 0),
    blocked_subtasks: plans.reduce((sum, plan) => sum + plan.blocked_subtasks, 0),
    stale_claims_blocking_downstream: plans.reduce(
      (sum, plan) => sum + plan.stale_claims_blocking_downstream,
      0,
    ),
    downstream_blockers: plans
      .flatMap((plan) => plan.downstream_blockers)
      .sort(
        (a, b) =>
          b.age_minutes - a.age_minutes ||
          a.plan_slug.localeCompare(b.plan_slug) ||
          a.subtask_index - b.subtask_index,
      ),
    quota_handoffs_blocking_downstream: plans.reduce(
      (sum, plan) => sum + plan.quota_handoffs_blocking_downstream,
      0,
    ),
    replacement_recommendation:
      plans.find((plan) => plan.replacement_recommendation !== null)?.replacement_recommendation ??
      null,
    plans: plans.sort((a, b) => a.plan_slug.localeCompare(b.plan_slug)),
    plan_state_recommendations: stateRecommendations,
  };
}

function firstReadyUnclaimedQueenPlan(queen: QueenWaveHealthPayload): QueenWavePlanSummary | null {
  return queen.plans.find((plan) => plan.ready_subtasks > 0 && plan.claimed_subtasks === 0) ?? null;
}

function planReplacementRecommendation(
  storage: Pick<Storage, 'taskObservationsByKind' | 'listClaims' | 'getSession'>,
  planSlug: string,
  subtasks: PlanSubtaskHealth[],
  options: { now: number; stale_claim_minutes: number },
): QueenReplacementRecommendation | null {
  const blocker = subtasks
    .filter((subtask) => isStalePlanClaim(subtask, options) && blocksDownstream(subtask, subtasks))
    .sort((a, b) => (a.claimed_at ?? options.now) - (b.claimed_at ?? options.now))[0];
  if (!blocker || blocker.claimed_at === null) return null;

  const ageMinutes = Math.max(0, Math.floor((options.now - blocker.claimed_at) / 60_000));
  const claimedFileCount = storage.listClaims(blocker.task_id).length;
  const taskSize = blocker.file_scope.length;
  const runtimeHistory = blocker.claimed_by_session_id
    ? (storage.getSession(blocker.claimed_by_session_id)?.ide ?? null)
    : null;
  const quotaHandoff = latestQuotaExhaustedHandoffForHealth(storage, blocker.task_id, options.now);
  const staleAgent = normalizeRuntimeAgentForHealth(
    quotaHandoff?.from_agent ?? blocker.claimed_by_agent ?? runtimeHistory,
  );
  const recommended = oppositeRuntimeForHealth(staleAgent, claimedFileCount, taskSize);

  if (quotaHandoff !== null) {
    return {
      recommended_replacement_agent: recommended,
      reason: `${displayRuntimeForHealth(staleAgent)} recently hit quota on this branch`,
      next_tool: 'task_accept_handoff',
      claim_args: {
        handoff_observation_id: quotaHandoff.id,
        session_id: '<session_id>',
      },
      signals: {
        stale_blocker_age_minutes: ageMinutes,
        claimed_file_count: claimedFileCount,
        task_size: taskSize,
        claimed_by_agent: blocker.claimed_by_agent,
        runtime_history: runtimeHistory,
        quota_exhausted_handoff_id: quotaHandoff.id,
      },
    };
  }

  return {
    recommended_replacement_agent: recommended,
    reason: `${displayRuntimeForHealth(staleAgent)} stale for ${ageMinutes}m on ${claimedFileCount} claimed file(s); task size ${taskSize} file(s)`,
    next_tool: 'task_plan_claim_subtask',
    claim_args: {
      plan_slug: planSlug,
      subtask_index: blocker.index,
      session_id: '<session_id>',
      agent: recommended,
      file_scope: blocker.file_scope,
    },
    signals: {
      stale_blocker_age_minutes: ageMinutes,
      claimed_file_count: claimedFileCount,
      task_size: taskSize,
      claimed_by_agent: blocker.claimed_by_agent,
      runtime_history: runtimeHistory,
      quota_exhausted_handoff_id: null,
    },
  };
}

function liveContentionPayload(
  storage: Pick<Storage, 'listClaims' | 'taskObservationsByKind'>,
  tasks: TaskRow[],
  options: {
    since: number;
    now: number;
    stale_claim_minutes: number;
    repo_root?: string;
    hivemind?: { sessions: HivemindSession[] };
    dirty_files_by_worktree?: Record<string, string[]>;
    worktree_contention?: WorktreeContentionReport;
  },
): LiveContentionPayload {
  const sessions =
    options.hivemind?.sessions ??
    (options.repo_root
      ? readHivemind({
          repoRoot: options.repo_root,
          includeStale: true,
          limit: 100,
          now: options.now,
        }).sessions
      : []);
  const liveSessions = sessions.filter((session) => session.activity !== 'dead');
  const sessionsById = new Map<string, HivemindSession>();
  const sessionsByBranch = new Map<string, HivemindSession[]>();

  for (const session of liveSessions) {
    if (session.session_key) sessionsById.set(session.session_key, session);
    const bucket = sessionsByBranch.get(session.branch) ?? [];
    bucket.push(session);
    sessionsByBranch.set(session.branch, bucket);
  }

  const dirtyFilesByWorktree = readDirtyFilesForSessions(
    liveSessions,
    options.dirty_files_by_worktree,
  );
  const claimOwners: Array<{
    file_path: string;
    owner_key: string;
    owner: LiveContentionOwner;
  }> = [];

  for (const task of tasks) {
    for (const claim of storage.listClaims(task.id)) {
      const filePath = normalizeHealthFilePath(claim.file_path);
      if (!filePath) continue;

      const age = classifyClaimAge(claim, {
        now: options.now,
        claim_stale_minutes: options.stale_claim_minutes,
      });
      const session = sessionsById.get(claim.session_id) ?? sessionsByBranch.get(task.branch)?.[0];
      const hasLiveOwner = Boolean(session && session.activity !== 'dead');
      if (!hasLiveOwner && !isStrongClaimAge(age)) continue;

      const worktreePath = session?.worktree_path ?? '';
      const dirty = worktreePath
        ? (dirtyFilesByWorktree.get(worktreePath)?.has(filePath) ?? false)
        : false;
      const owner = session?.agent || ownerFromSessionId(claim.session_id);

      claimOwners.push({
        file_path: filePath,
        owner_key: `${claim.session_id}\0${task.branch}`,
        owner: {
          owner,
          session_id: claim.session_id,
          branch: task.branch,
          task_id: task.id,
          task_status: task.status ?? '',
          activity: session?.activity ?? (isStrongClaimAge(age) ? 'claim-active' : 'unknown'),
          worktree_path: worktreePath,
          claim_age_minutes: age.age_minutes,
          claim_strength: age.ownership_strength,
          dirty,
          classification: 'unknown owner',
        },
      });
    }
  }

  const conflicts = Array.from(groupByFilePath(claimOwners).entries())
    .map(([filePath, owners]) => {
      const uniqueOwners = uniqueContentionOwners(owners);
      if (uniqueOwners.length <= 1) return null;
      const classifiedOwners = classifyContentionOwners(uniqueOwners);
      const dirtyWorktrees = uniqueOwners
        .filter((owner) => owner.dirty && owner.worktree_path)
        .map((owner) => owner.worktree_path);
      return {
        file_path: filePath,
        owner_count: classifiedOwners.length,
        protected: classifiedOwners.some((owner) => isProtectedBranch(owner.branch)),
        dirty_worktrees: [...new Set(dirtyWorktrees)].sort(),
        owners: classifiedOwners.sort(compareContentionOwners),
      } satisfies LiveContentionConflict;
    })
    .filter((conflict): conflict is LiveContentionConflict => conflict !== null)
    .sort(compareContentionConflicts);
  const worktreeContention =
    options.worktree_contention ?? readWorktreeContention(options.repo_root, options.now);
  const dirtyClaimContentions = conflicts.filter(
    (conflict) => conflict.dirty_worktrees.length > 0,
  ).length;
  const dirtyWorktreeContentions = worktreeContention?.summary.contention_count ?? 0;
  const competingWorktreesFromDirtyContention = countCompetingWorktrees(worktreeContention);

  const recommendedActions = recommendedLiveContentionActions(conflicts);
  return {
    live_file_contentions: conflicts.length,
    protected_file_contentions: conflicts.filter((conflict) => conflict.protected).length,
    paused_lanes: liveSessions.filter(
      (session) => session.activity === 'idle' || session.activity === 'stalled',
    ).length,
    takeover_requests: takeoverRequestCount(storage, tasks, {
      since: options.since,
      now: options.now,
    }),
    competing_worktrees: Math.max(
      competingWorktreeBranchCount(liveSessions),
      competingWorktreesFromDirtyContention,
    ),
    dirty_contended_files: Math.max(dirtyClaimContentions, dirtyWorktreeContentions),
    top_conflicts: conflicts.slice(0, HEALTH_TOOL_LIMIT),
    recommended_actions: recommendedActions.slice(0, HEALTH_TOOL_LIMIT),
    protected_claim_action_queue: buildProtectedClaimActionQueue(
      conflicts,
      recommendedActions,
      options.repo_root,
    ),
  };
}

function groupPlanSubtasks(subtasks: PlanSubtaskHealth[]): Map<string, PlanSubtaskHealth[]> {
  const byPlan = new Map<string, PlanSubtaskHealth[]>();
  for (const subtask of subtasks) {
    const bucket = byPlan.get(subtask.plan_slug) ?? [];
    bucket.push(subtask);
    byPlan.set(subtask.plan_slug, bucket);
  }
  return byPlan;
}

function groupPlanSubtasksByRepo(subtasks: PlanSubtaskHealth[]): Map<string, PlanSubtaskHealth[]> {
  const byPlan = new Map<string, PlanSubtaskHealth[]>();
  for (const subtask of subtasks) {
    const key = planKey(subtask.repo_root, subtask.plan_slug);
    const bucket = byPlan.get(key) ?? [];
    bucket.push(subtask);
    byPlan.set(key, bucket);
  }
  return byPlan;
}

function planKey(repoRoot: string, slug: string): string {
  return `${repoRoot}\0${slug}`;
}

function splitPlanKey(key: string): [string, string] {
  const [repoRoot, slug] = key.split('\0');
  return [repoRoot ?? '', slug ?? ''];
}

function annotatePlanSubtaskWaves(subtasks: PlanSubtaskHealth[]): PlanSubtaskHealth[] {
  const annotated: PlanSubtaskHealth[] = [];
  for (const siblings of groupPlanSubtasks(subtasks).values()) {
    const byIndex = new Map(siblings.map((subtask) => [subtask.index, subtask]));
    const waveByIndex = new Map<number, number>();
    const resolveWave = (subtask: PlanSubtaskHealth, visiting = new Set<number>()): number => {
      const cached = waveByIndex.get(subtask.index);
      if (cached !== undefined) return cached;
      if (visiting.has(subtask.index)) return 0;
      visiting.add(subtask.index);
      const wave =
        subtask.depends_on.length === 0
          ? 0
          : Math.max(
              ...subtask.depends_on.map((depIndex) => {
                const dep = byIndex.get(depIndex);
                return dep ? resolveWave(dep, visiting) + 1 : 1;
              }),
            );
      visiting.delete(subtask.index);
      waveByIndex.set(subtask.index, wave);
      return wave;
    };

    for (const subtask of siblings) {
      const waveIndex = resolveWave(subtask);
      annotated.push({
        ...subtask,
        wave_index: waveIndex,
        wave_name: `Wave ${waveIndex + 1}`,
      });
    }
  }
  return annotated;
}

function isReadyPlanSubtask(subtask: PlanSubtaskHealth, siblings: PlanSubtaskHealth[]): boolean {
  return subtask.status === 'available' && arePlanSubtaskDepsMet(subtask, siblings);
}

function isBlockedPlanSubtask(subtask: PlanSubtaskHealth, siblings: PlanSubtaskHealth[]): boolean {
  return (
    subtask.status === 'blocked' ||
    (subtask.status === 'available' && !arePlanSubtaskDepsMet(subtask, siblings))
  );
}

function arePlanSubtaskDepsMet(subtask: PlanSubtaskHealth, siblings: PlanSubtaskHealth[]): boolean {
  return subtask.depends_on.every((depIndex) =>
    siblings.some((candidate) => candidate.index === depIndex && candidate.status === 'completed'),
  );
}

function isStalePlanClaim(
  subtask: PlanSubtaskHealth,
  options: { now: number; stale_claim_minutes: number },
): boolean {
  return (
    subtask.status === 'claimed' &&
    subtask.claimed_at !== null &&
    options.now - subtask.claimed_at > options.stale_claim_minutes * 60_000
  );
}

function blocksDownstream(subtask: PlanSubtaskHealth, siblings: PlanSubtaskHealth[]): boolean {
  return siblings.some(
    (candidate) => candidate.status !== 'completed' && candidate.depends_on.includes(subtask.index),
  );
}

function staleDownstreamBlockers(
  subtasks: PlanSubtaskHealth[],
  options: { now: number; stale_claim_minutes: number },
): QueenDownstreamBlockerReport[] {
  const blockers: QueenDownstreamBlockerReport[] = [];
  for (const subtask of subtasks) {
    if (!isStalePlanClaim(subtask, options) || !blocksDownstream(subtask, subtasks)) continue;
    const unlockCandidate = subtasks.find(
      (candidate) =>
        candidate.status !== 'completed' && candidate.depends_on.includes(subtask.index),
    );
    if (!unlockCandidate || !subtask.claimed_by_session_id || subtask.claimed_at === null) {
      continue;
    }
    blockers.push({
      plan_slug: subtask.plan_slug,
      task_id: subtask.task_id,
      subtask_index: subtask.index,
      subtask_title: subtask.title,
      file_path: subtask.file_scope[0] ?? '(unscoped)',
      owner_session_id: subtask.claimed_by_session_id,
      owner_agent: subtask.claimed_by_agent,
      age_minutes: Math.floor((options.now - subtask.claimed_at) / 60_000),
      unlock_candidate: {
        task_id: unlockCandidate.task_id,
        subtask_index: unlockCandidate.index,
        title: unlockCandidate.title,
      },
    });
  }
  return blockers.sort(
    (a, b) =>
      b.age_minutes - a.age_minutes ||
      a.plan_slug.localeCompare(b.plan_slug) ||
      a.subtask_index - b.subtask_index,
  );
}

function readNumberArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((item): item is number => typeof item === 'number')
    : [];
}

function isPlanSubtaskStatus(value: unknown): value is PlanSubtaskHealth['status'] {
  return (
    value === 'available' || value === 'claimed' || value === 'completed' || value === 'blocked'
  );
}

function latestQuotaExhaustedHandoffForHealth(
  storage: Pick<Storage, 'taskObservationsByKind'>,
  taskId: number,
  now: number,
): { id: number; from_agent: string | null } | null {
  const rows = storage.taskObservationsByKind(taskId, 'handoff', 100);
  for (const row of rows) {
    const meta = parseJsonObject(row.metadata);
    const status = readStringOrNull(meta.status);
    if (status !== null && status !== 'pending') continue;
    const expiresAt = readNumber(meta.expires_at);
    if (expiresAt !== null && now >= expiresAt) continue;
    const text = [
      row.content,
      readStringMetadata(meta.reason),
      readStringMetadata(meta.summary),
      readStringMetadata(meta.one_line),
      readStringArrayMetadata(meta.blockers).join(' '),
    ]
      .filter(Boolean)
      .join(' ');
    if (
      meta.quota_exhausted === true ||
      /\bquota(?:[-_\s]*exhausted|[-_\s]*hit|[-_\s]*reached|[-_\s]*exceeded)?\b/i.test(text)
    ) {
      return { id: row.id, from_agent: readStringOrNull(meta.from_agent) };
    }
  }
  return null;
}

function normalizeRuntimeAgentForHealth(value: string | null | undefined): QueenReplacementAgent {
  const normalized = value?.toLowerCase() ?? '';
  if (normalized.includes('claude')) return 'claude-code';
  if (normalized.includes('codex')) return 'codex';
  return 'any';
}

function oppositeRuntimeForHealth(
  staleAgent: QueenReplacementAgent,
  claimedFileCount: number,
  taskSize: number,
): QueenReplacementAgent {
  if (staleAgent === 'codex') return 'claude-code';
  if (staleAgent === 'claude-code') return 'codex';
  return claimedFileCount > 3 || taskSize > 3 ? 'any' : 'codex';
}

function displayRuntimeForHealth(agent: QueenReplacementAgent): string {
  if (agent === 'claude-code') return 'Claude';
  if (agent === 'codex') return 'Codex';
  return 'Unknown runtime';
}

function readStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function parseJsonObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function groupByFilePath(
  claims: Array<{ file_path: string; owner_key: string; owner: LiveContentionOwner }>,
): Map<string, Array<{ owner_key: string; owner: LiveContentionOwner }>> {
  const byFile = new Map<string, Array<{ owner_key: string; owner: LiveContentionOwner }>>();
  for (const claim of claims) {
    const bucket = byFile.get(claim.file_path) ?? [];
    bucket.push({ owner_key: claim.owner_key, owner: claim.owner });
    byFile.set(claim.file_path, bucket);
  }
  return byFile;
}

function uniqueContentionOwners(
  owners: Array<{ owner_key: string; owner: LiveContentionOwner }>,
): LiveContentionOwner[] {
  const byOwner = new Map<string, LiveContentionOwner>();
  for (const entry of owners) {
    const existing = byOwner.get(entry.owner_key);
    if (!existing || entry.owner.claim_age_minutes < existing.claim_age_minutes) {
      byOwner.set(entry.owner_key, entry.owner);
    }
  }
  return [...byOwner.values()];
}

function classifyContentionOwners(owners: LiveContentionOwner[]): LiveContentionOwner[] {
  const branchCounts = new Map<string, number>();
  for (const owner of owners) {
    branchCounts.set(owner.branch, (branchCounts.get(owner.branch) ?? 0) + 1);
  }
  return owners.map((owner) => ({
    ...owner,
    classification: classifyContentionOwner(owner, branchCounts),
  }));
}

function classifyContentionOwner(
  owner: LiveContentionOwner,
  branchCounts: Map<string, number>,
): LiveContentionOwnerClassification {
  if ((branchCounts.get(owner.branch) ?? 0) > 1) return 'same branch duplicate';
  if (owner.owner === 'unknown') return 'unknown owner';
  return isActiveContentionActivity(owner.activity) ? 'active known owner' : 'inactive known owner';
}

function isActiveContentionActivity(activity: string): boolean {
  return activity === 'working' || activity === 'thinking' || activity === 'idle';
}

function recommendedLiveContentionActions(
  conflicts: LiveContentionConflict[],
): LiveContentionRecommendedAction[] {
  const actions: LiveContentionRecommendedAction[] = [];
  for (const conflict of conflicts.filter((entry) => entry.protected)) {
    for (const owner of conflict.owners) {
      if (owner.classification === 'active known owner') {
        actions.push(keepOwnerAction(conflict, owner));
      } else if (owner.classification === 'inactive known owner') {
        actions.push(releaseOrWeakenOwnerAction(conflict, owner, 'owner is known but not active'));
      } else if (owner.classification === 'same branch duplicate') {
        actions.push(
          releaseOrWeakenOwnerAction(conflict, owner, 'duplicate claim on the same branch'),
        );
      } else {
        actions.push(requireTakeoverAction(conflict, owner, 'owner identity is unknown'));
      }
    }
    const activeKnownOwners = conflict.owners.filter(
      (owner) => owner.classification === 'active known owner',
    );
    if (activeKnownOwners.length > 1) {
      for (const owner of activeKnownOwners) {
        actions.push(
          requireTakeoverAction(conflict, owner, 'multiple active owners claim this file'),
        );
      }
    }
  }
  return actions;
}

function buildProtectedClaimActionQueue(
  conflicts: LiveContentionConflict[],
  actions: LiveContentionRecommendedAction[],
  repoRoot?: string,
): ProtectedClaimActionQueue {
  const protectedOwners = conflicts.flatMap((conflict) =>
    conflict.owners.filter((owner) => isProtectedBaseBranch(owner.branch)),
  );
  const releaseOrWeaken = actions.filter((action) =>
    action.action.startsWith('release/weaken owner '),
  );
  const takeover = actions.filter((action) => action.action === 'require explicit takeover');
  const keepOwner = actions.filter((action) => action.action.startsWith('keep owner '));
  const commands = new Set<string>();
  if (releaseOrWeaken.some((action) => action.classification === 'same branch duplicate')) {
    commands.add(coordinationSweepCommand(repoRoot, '--release-same-branch-duplicates'));
  }
  for (const action of [...releaseOrWeaken, ...takeover]) {
    if (action.command) commands.add(action.command);
  }
  if (protectedOwners.length > 0) commands.add(healthCommandForRepo(repoRoot));

  let nextAction = 'No protected branch claim cleanup needed.';
  if (protectedOwners.length > 0 && releaseOrWeaken.length > 0) {
    nextAction =
      'Release or weaken inactive/duplicate protected claims first, then rerun health before broad verification.';
  } else if (protectedOwners.length > 0 && takeover.length > 0) {
    nextAction =
      'Resolve protected claims with explicit takeover or directed handoff; do not overwrite competing owners.';
  } else if (protectedOwners.length > 0) {
    nextAction = 'Keep the active owner, but move future claims off protected base branches.';
  }

  return {
    protected_claims: protectedOwners.length,
    takeover_actions: takeover.length,
    release_or_weaken_actions: releaseOrWeaken.length,
    keep_owner_actions: keepOwner.length,
    next_action: nextAction,
    commands: [...commands].slice(0, HEALTH_TOOL_LIMIT),
  };
}

function coordinationSweepCommand(repoRoot: string | undefined, flag: string): string {
  return repoRoot
    ? `colony coordination sweep --repo-root ${shellQuote(repoRoot)} ${flag} --json`
    : `colony coordination sweep ${flag} --json`;
}

function healthCommandForRepo(repoRoot: string | undefined): string {
  return repoRoot
    ? `colony health --repo-root ${shellQuote(repoRoot)} --json`
    : 'colony health --json';
}

function keepOwnerAction(
  conflict: LiveContentionConflict,
  owner: LiveContentionOwner,
): LiveContentionRecommendedAction {
  return {
    file_path: conflict.file_path,
    action: `keep owner ${owner.session_id}`,
    owner: owner.owner,
    session_id: owner.session_id,
    branch: owner.branch,
    classification: owner.classification,
    reason: 'known active owner on protected contention',
  };
}

function releaseOrWeakenOwnerAction(
  conflict: LiveContentionConflict,
  owner: LiveContentionOwner,
  reason: string,
): LiveContentionRecommendedAction {
  return {
    file_path: conflict.file_path,
    action: `release/weaken owner ${owner.session_id}`,
    owner: owner.owner,
    session_id: owner.session_id,
    branch: owner.branch,
    classification: owner.classification,
    reason,
    command: `colony lane takeover ${shellQuote(owner.session_id)} --file ${shellQuote(
      conflict.file_path,
    )} --reason ${shellQuote('protected contention resolution')}`,
    mcp_tool_hint: `owner can call task_hand_off(task_id=${owner.task_id}, session_id="${owner.session_id}", released_files=["${conflict.file_path}"], summary="release protected contention", next_steps=["claim after release"])`,
  };
}

function requireTakeoverAction(
  conflict: LiveContentionConflict,
  owner: LiveContentionOwner,
  reason: string,
): LiveContentionRecommendedAction {
  return {
    file_path: conflict.file_path,
    action: 'require explicit takeover',
    owner: owner.owner,
    session_id: owner.session_id,
    branch: owner.branch,
    classification: owner.classification,
    reason,
    command: `colony lane takeover ${shellQuote(owner.session_id)} --file ${shellQuote(
      conflict.file_path,
    )} --reason ${shellQuote(reason)}`,
    mcp_tool_hint: `task_claim_file(task_id=${owner.task_id}, session_id="<requester_session_id>", file_path="${conflict.file_path}", note="after explicit takeover")`,
  };
}

function compareContentionOwners(left: LiveContentionOwner, right: LiveContentionOwner): number {
  if (left.dirty !== right.dirty) return left.dirty ? -1 : 1;
  if (left.claim_strength !== right.claim_strength) {
    return left.claim_strength === 'strong' ? -1 : 1;
  }
  return (
    left.branch.localeCompare(right.branch) ||
    left.owner.localeCompare(right.owner) ||
    left.session_id.localeCompare(right.session_id)
  );
}

function compareContentionConflicts(
  left: LiveContentionConflict,
  right: LiveContentionConflict,
): number {
  if (left.dirty_worktrees.length !== right.dirty_worktrees.length) {
    return right.dirty_worktrees.length - left.dirty_worktrees.length;
  }
  if (left.protected !== right.protected) return left.protected ? -1 : 1;
  if (left.owner_count !== right.owner_count) return right.owner_count - left.owner_count;
  return left.file_path.localeCompare(right.file_path);
}

function readDirtyFilesForSessions(
  sessions: HivemindSession[],
  override?: Record<string, string[]>,
): Map<string, Set<string>> {
  const paths = new Set(
    sessions.map((session) => session.worktree_path).filter((path) => path.length > 0),
  );
  const result = new Map<string, Set<string>>();
  for (const worktreePath of paths) {
    const files =
      override && Object.prototype.hasOwnProperty.call(override, worktreePath)
        ? (override[worktreePath] ?? [])
        : readDirtyFiles(worktreePath);
    result.set(worktreePath, new Set(files.map(normalizeHealthFilePath).filter(Boolean)));
  }
  return result;
}

function readDirtyFiles(worktreePath: string): string[] {
  try {
    const output = execFileSync(
      'git',
      ['-C', worktreePath, 'status', '--porcelain', '--untracked-files=no'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    return output
      .split('\n')
      .map(parseGitStatusFilePath)
      .map(normalizeHealthFilePath)
      .filter(Boolean);
  } catch {
    return [];
  }
}

function parseGitStatusFilePath(line: string): string {
  if (line.length < 4) return '';
  const raw = line.slice(3).trim();
  const renameIndex = raw.indexOf(' -> ');
  return stripGitStatusQuotes(renameIndex >= 0 ? raw.slice(renameIndex + 4) : raw);
}

function stripGitStatusQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function normalizeHealthFilePath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function ownerFromSessionId(sessionId: string): string {
  const match = sessionId.match(/^(codex|claude|gemini|cursor|opencode|agent)(?:[@:_-]|$)/i);
  return match?.[1]?.toLowerCase() ?? 'unknown';
}

function isProtectedBranch(branch: string): boolean {
  return PROTECTED_BRANCHES.has(branch);
}

function competingWorktreeBranchCount(sessions: HivemindSession[]): number {
  const byBranch = new Map<string, Set<string>>();
  for (const session of sessions) {
    if (!session.branch || !session.worktree_path) continue;
    const bucket = byBranch.get(session.branch) ?? new Set<string>();
    bucket.add(session.worktree_path);
    byBranch.set(session.branch, bucket);
  }
  return [...byBranch.values()].filter((worktrees) => worktrees.size > 1).length;
}

function readWorktreeContention(
  repoRoot: string | undefined,
  now: number,
): WorktreeContentionReport | null {
  if (!repoRoot) return null;
  try {
    return readWorktreeContentionReport({ repoRoot, now });
  } catch {
    return null;
  }
}

function countCompetingWorktrees(report: WorktreeContentionReport | null): number {
  if (!report) return 0;
  const paths = new Set<string>();
  for (const contention of report.contentions) {
    for (const worktree of contention.worktrees) {
      paths.add(worktree.path);
    }
  }
  return paths.size;
}

function takeoverRequestCount(
  storage: Pick<Storage, 'taskObservationsByKind'>,
  tasks: TaskRow[],
  options: { since: number; now: number },
): number {
  let count = 0;
  for (const task of tasks) {
    for (const kind of ['handoff', 'relay'] as const) {
      count += storage
        .taskObservationsByKind(task.id, kind, 1000)
        .filter((row) => row.ts > options.since)
        .filter((row) => isPendingTakeoverRequest(row, options.now)).length;
    }
  }
  return count;
}

function isPendingTakeoverRequest(row: ObservationRow, now: number): boolean {
  const metadata = parseJsonObject(row.metadata);
  if (metadata.status && metadata.status !== 'pending') return false;
  const expiresAt = readNumber(metadata.expires_at);
  if (expiresAt !== null && now >= expiresAt) return false;
  const text = [
    row.content,
    readStringMetadata(metadata.summary),
    readStringMetadata(metadata.one_line),
    readStringMetadata(metadata.reason),
    readStringArrayMetadata(metadata.blockers).join(' '),
  ]
    .filter(Boolean)
    .join(' ');
  return (
    metadata.auto_takeover === true || /takeover requested|usage limit|rate limit|quota/i.test(text)
  );
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readStringMetadata(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readStringArrayMetadata(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function parseHours(raw: string): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_HOURS;
}

function shortSession(sessionId: string): string {
  if (sessionId.length <= 14) return sessionId;
  return `${sessionId.slice(0, 11)}...`;
}
