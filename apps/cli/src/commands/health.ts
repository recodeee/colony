import { execFileSync } from 'node:child_process';
import { defaultSettings, loadSettings } from '@colony/config';
import {
  type HivemindSession,
  ProposalSystem,
  type WorktreeContentionReport,
  classifyClaimAge,
  currentSignalStrength,
  isSignalExpired,
  isStrongClaimAge,
  readHivemind,
  readWorktreeContentionReport,
  signalMetadataFromObservation,
  signalMetadataFromProposal,
} from '@colony/core';
import type {
  ClaimBeforeEditStats,
  ClaimMatchSources,
  ClaimMissReasons,
  NearestClaimExample,
  ObservationRow,
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
const HEALTH_TOOL_LIMIT = 5;
const DEFAULT_HANDOFF_TTL_MS = 2 * 60 * 60_000;
const PLAN_SUBTASK_BRANCH_RE = /^spec\/([a-z0-9-]+)\/sub-(\d+)$/;
const TARGET_HIVEMIND_TO_ATTENTION = 0.5;
const TARGET_TASK_LIST_TO_READY = 0.3;
const TARGET_READY_TO_CLAIM = 0.3;
const TARGET_CLAIM_BEFORE_EDIT = 0.5;
const TARGET_COLONY_NOTE_SHARE = 0.7;
const TARGET_TASK_MESSAGE_SHARE = 0.2;
const LIFECYCLE_BRIDGE_MISSING_MIN_TASK_CLAIM_FILE_CALLS = 10;
const LIFECYCLE_BRIDGE_MISSING_MIN_HOOK_CAPABLE_EDITS = 10;
const LIFECYCLE_BRIDGE_NEAR_ZERO_PRE_TOOL_USE_SIGNAL_RATIO = 0.05;
const LIFECYCLE_BRIDGE_ROOT_CAUSE =
  'Lifecycle bridge missing: many task_claim_file calls, many hook-capable edits, near-zero pre_tool_use_signals.';
const LIFECYCLE_BRIDGE_ACTION =
  'Install/wire the lifecycle bridge so OMX/Codex/Claude emits pre_tool_use before file mutation.';
const LIFECYCLE_BRIDGE_COMMAND =
  'colony bridge lifecycle --json --ide <ide> --cwd <repo_root> < colony-omx-lifecycle-v1.pre.json';
const PROTECTED_BRANCHES = new Set(['main', 'dev', 'master', 'trunk']);

const CONVERSIONS = [
  ['hivemind_context', 'attention_inbox'],
  ['attention_inbox', 'task_ready_for_agent'],
  ['task_list', 'task_ready_for_agent'],
  ['task_ready_for_agent', 'task_plan_claim_subtask'],
] as const;

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

interface SearchCallsPayload {
  total_search_calls: number;
  active_sessions: number;
  average_per_active_session: number | null;
  sessions: Array<{ session_id: string; calls: number }>;
}

interface ClaimBeforeEditPayload extends ClaimBeforeEditStats {
  status: 'available' | 'not_available' | 'no_data';
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
  stale_claim_minutes: number;
  expired_handoffs: number;
  expired_messages: number;
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
  stale_claims_blocking_downstream: number;
}

interface QueenWaveHealthPayload {
  active_plans: number;
  current_wave: string | null;
  ready_subtasks: number;
  claimed_subtasks: number;
  blocked_subtasks: number;
  stale_claims_blocking_downstream: number;
  plans: QueenWavePlanSummary[];
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
}

interface LiveContentionConflict {
  file_path: string;
  owner_count: number;
  protected: boolean;
  dirty_worktrees: string[];
  owners: LiveContentionOwner[];
}

interface LiveContentionPayload {
  live_file_contentions: number;
  protected_file_contentions: number;
  paused_lanes: number;
  takeover_requests: number;
  competing_worktrees: number;
  dirty_contended_files: number;
  top_conflicts: LiveContentionConflict[];
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
  tool_call?: string;
  command?: string;
  prompt: string;
}

interface RootCauseSummary {
  kind: 'lifecycle_bridge_missing';
  summary: string;
  evidence: string;
  action: string;
  command: string;
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

type ReadinessScope = keyof ReadinessSummaryPayload | 'adoption_followup';

export interface ColonyHealthPayload {
  generated_at: string;
  window_hours: number;
  readiness_summary: ReadinessSummaryPayload;
  colony_mcp_share: SharePayload;
  conversions: Record<ConversionName, ConversionPayload>;
  task_list_vs_task_ready_for_agent: TaskSelectionPayload;
  task_post_vs_task_message: TaskPostMessagePayload;
  task_post_vs_omx_notepad: TaskPostNotepadPayload;
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

export function buildColonyHealthPayload(
  storage: Pick<
    Storage,
    | 'toolCallsSince'
    | 'claimBeforeEditStats'
    | 'listTasks'
    | 'listClaims'
    | 'taskTimeline'
    | 'taskObservationsByKind'
    | 'listProposalsForBranch'
    | 'listReinforcements'
  >,
  options: {
    since: number;
    window_hours: number;
    now?: number;
    claim_stale_minutes?: number;
    codex_sessions_root?: string;
    repo_root?: string;
    hivemind?: { sessions: HivemindSession[] };
    dirty_files_by_worktree?: Record<string, string[]>;
    worktree_contention?: WorktreeContentionReport;
  },
): ColonyHealthPayload {
  const now = options.now ?? Date.now();
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
  const calls: ToolCallRow[] = [...colonyCalls, ...codexCalls].sort(
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
  const searchCalls = searchCallsPerSession(calls);
  const claimBeforeEditStats = storage.claimBeforeEditStats(options.since);
  const taskSelection = taskSelectionPayload(calls);
  const taskClaimFileCalls = countTool(calls, 'task_claim_file');

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
      },
    },
    conversions: Object.fromEntries(conversionEntries) as Record<ConversionName, ConversionPayload>,
    task_list_vs_task_ready_for_agent: taskSelection,
    task_post_vs_task_message: {
      task_post_calls: taskPostCalls,
      task_message_calls: taskMessageCalls,
      task_message_share: ratio(taskMessageCalls, taskPostCalls + taskMessageCalls),
    },
    task_post_vs_omx_notepad: taskPostVsNotepadPayload(calls, taskPostCalls, taskNoteWorkingCalls),
    search_calls_per_session: searchCalls,
    task_claim_file_before_edits: claimBeforeEditPayload(
      claimBeforeEditStats,
      taskClaimFileCalls,
      codexEditCalls.length,
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
    live_contention_health: liveContentionPayload(storage, tasks, {
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
    }),
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

  const lines = [
    kleur.bold('colony health'),
    kleur.dim(`window: last ${payload.window_hours}h`),
    '',
    kleur.bold('Readiness summary'),
    ...formatReadinessSummary(payload.readiness_summary),
    '',
    kleur.bold('Colony MCP share'),
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
  ];

  if (payload.colony_mcp_share.source_breakdown.codex_rollouts > 0) {
    lines.push(
      kleur.dim(
        `  sources:   colony obs ${payload.colony_mcp_share.source_breakdown.colony_observations}, codex rollouts ${payload.colony_mcp_share.source_breakdown.codex_rollouts}`,
      ),
    );
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

  lines.push('', kleur.bold('Loop adoption'));

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
    kleur.bold('task_list vs task_ready_for_agent'),
    `  task_list:            ${payload.task_list_vs_task_ready_for_agent.task_list_calls}`,
    `  task_ready_for_agent: ${payload.task_list_vs_task_ready_for_agent.task_ready_for_agent_calls}`,
    `  ready share:          ${formatPercent(payload.task_list_vs_task_ready_for_agent.task_ready_share)}`,
    '',
    kleur.bold('task_post vs task_message'),
    `  task_post:    ${payload.task_post_vs_task_message.task_post_calls}`,
    `  task_message: ${payload.task_post_vs_task_message.task_message_calls}`,
    `  message share: ${formatPercent(payload.task_post_vs_task_message.task_message_share)}`,
    '',
    kleur.bold('task_post vs OMX notepad'),
    `  status:              ${payload.task_post_vs_omx_notepad.status}`,
    `  task_post:           ${payload.task_post_vs_omx_notepad.task_post_calls}`,
    `  task_note_working:   ${payload.task_post_vs_omx_notepad.task_note_working_calls}`,
    `  colony note calls:   ${payload.task_post_vs_omx_notepad.colony_note_calls}`,
    `  omx writes:          ${payload.task_post_vs_omx_notepad.omx_notepad_write_calls}`,
    `  task_post share:     ${formatPercent(payload.task_post_vs_omx_notepad.task_post_share)}`,
    `  colony note share:   ${formatPercent(payload.task_post_vs_omx_notepad.colony_note_share)}`,
    '',
    kleur.bold('Search calls per session'),
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

  lines.push('', kleur.bold('task_claim_file before edits'));
  lines.push(...formatClaimBeforeEdit(payload.task_claim_file_before_edits));

  lines.push('', kleur.bold('Live contention health'));
  lines.push(...formatLiveContention(payload.live_contention_health));

  lines.push(
    '',
    kleur.bold('Signal health'),
    `  total claims:     ${payload.signal_health.total_claims}`,
    `  active claims:    ${payload.signal_health.active_claims}`,
    `  stale claims:     ${payload.signal_health.stale_claims} (>${payload.signal_health.stale_claim_minutes}m)`,
    `  expired/weak:     ${payload.signal_health.expired_claims}`,
    `  expired handoffs: ${payload.signal_health.expired_handoffs}`,
    `  expired messages: ${payload.signal_health.expired_messages}`,
    '',
    kleur.bold('Proposal decay/promotions'),
    `  proposals seen:      ${payload.proposal_health.proposals_seen}`,
    `  pending:             ${payload.proposal_health.pending}`,
    `  promoted:            ${payload.proposal_health.promoted}`,
    `  evaporated:          ${payload.proposal_health.evaporated}`,
    `  below noise floor:   ${payload.proposal_health.pending_below_noise_floor}`,
    `  promotion rate:      ${formatPercent(payload.proposal_health.promotion_rate)}`,
    '',
    kleur.bold('Ready-to-claim vs claimed'),
    `  plan subtasks:       ${payload.ready_to_claim_vs_claimed.plan_subtasks}`,
    `  ready to claim:      ${payload.ready_to_claim_vs_claimed.ready_to_claim}`,
    `  claimed:             ${payload.ready_to_claim_vs_claimed.claimed}`,
    `  ready/claimed:       ${formatNumber(payload.ready_to_claim_vs_claimed.ready_to_claim_per_claimed)}`,
    `  claimed actionable:  ${formatPercent(payload.ready_to_claim_vs_claimed.claimed_share_of_actionable)}`,
    '',
    kleur.bold('Queen wave plans'),
    `  active plans:                       ${payload.queen_wave_health.active_plans}`,
    `  current wave:                       ${payload.queen_wave_health.current_wave ?? 'n/a'}`,
    `  ready subtasks:                     ${payload.queen_wave_health.ready_subtasks}`,
    `  claimed subtasks:                   ${payload.queen_wave_health.claimed_subtasks}`,
    `  blocked subtasks:                   ${payload.queen_wave_health.blocked_subtasks}`,
    `  stale claims blocking downstream:   ${payload.queen_wave_health.stale_claims_blocking_downstream}`,
  );

  if (payload.queen_wave_health.plans.length === 0) {
    lines.push(kleur.dim('  plans: none active'));
  } else {
    for (const plan of payload.queen_wave_health.plans.slice(0, HEALTH_TOOL_LIMIT)) {
      lines.push(
        `  ${plan.plan_slug}: current ${plan.current_wave ?? 'complete'}; ready ${plan.ready_subtasks}, claimed ${plan.claimed_subtasks}, blocked ${plan.blocked_subtasks}, stale blockers ${plan.stale_claims_blocking_downstream}`,
      );
    }
  }

  const visibleHints = visibleActionHints(payload, { verbose: Boolean(options.verbose) });

  lines.push('', kleur.bold('Next fixes'));
  if (visibleHints.length === 0) {
    if (payload.action_hints.length > 0) {
      lines.push(kleur.green('  none: readiness bottlenecks meet current targets'));
      lines.push(kleur.dim('  hidden: lower-priority follow-ups available with --verbose'));
    } else {
      lines.push(kleur.green('  none: tracked thresholds meet targets'));
    }
  } else {
    visibleHints.forEach((hint, index) => {
      lines.push(
        `  ${index + 1}. ${hint.metric}: ${hint.current} (target ${hint.target}) - ${hint.action}`,
      );
      if (hint.tool_call) lines.push(kleur.dim(`     tool: ${hint.tool_call}`));
      if (hint.command) lines.push(kleur.dim(`     cmd:  ${hint.command}`));
    });
  }

  if (options.prompts) {
    lines.push('', kleur.bold('Codex prompt snippets'));
    if (visibleHints.length === 0) {
      lines.push(kleur.green('  none: tracked thresholds meet targets'));
    } else {
      visibleHints.forEach((hint, index) => {
        lines.push(`  ${index + 1}. ${hint.prompt}`);
      });
    }
  }

  lines.push('', kleur.bold('Adoption thresholds'));
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
  const executionStatus: ReadinessStatus =
    liveContention.live_file_contentions > 0 ||
    liveContention.protected_file_contentions > 0 ||
    liveContention.dirty_contended_files > 0 ||
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
  const queenStatus: ReadinessStatus =
    queen.active_plans > 0
      ? queen.ready_subtasks + queen.claimed_subtasks > 0
        ? 'good'
        : 'ok'
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
    signals.stale_claims === 0 && queen.stale_claims_blocking_downstream === 0
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
      evidence: `claim-before-edit ${formatPercent(
        claimBeforeEdit.claim_before_edit_ratio,
      )} (target ${formatPercent(TARGET_CLAIM_BEFORE_EDIT)}+); live contentions ${liveContention.live_file_contentions}, dirty ${liveContention.dirty_contended_files}`,
      ...(claimBeforeEdit.root_cause ? { root_cause: claimBeforeEdit.root_cause } : {}),
    },
    queen_plan_readiness: {
      status: queenStatus,
      evidence: `${queen.active_plans} active plan(s); ${queen.ready_subtasks} ready, ${queen.claimed_subtasks} claimed`,
    },
    working_state_migration: {
      status: noteStatus,
      evidence: `colony note share ${formatPercent(
        noteMigration.colony_note_share,
      )} (target ${formatPercent(TARGET_COLONY_NOTE_SHARE)}+)`,
    },
    signal_evaporation: {
      status: signalStatus,
      evidence: `${signals.stale_claims} stale claim(s); ${queen.stale_claims_blocking_downstream} downstream blocker(s)`,
    },
  };
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

function formatReadinessItem(label: string, item: ReadinessSummaryItem): string[] {
  const lines = [`  ${label.padEnd(25)} ${formatReadinessStatus(item.status)} ${item.evidence}`];
  if (item.root_cause) {
    lines.push(
      `    root cause: ${item.root_cause.summary}`,
      `    evidence: ${item.root_cause.evidence}`,
      `    action: ${item.root_cause.action}`,
      `    cmd:  ${item.root_cause.command}`,
    );
  }
  return lines;
}

function formatReadinessStatus(status: ReadinessStatus): string {
  const label = status.padEnd(4);
  if (status === 'good') return kleur.green(label);
  if (status === 'bad') return kleur.red(label);
  return kleur.yellow(label);
}

export function registerHealthCommand(program: Command): void {
  program
    .command('health')
    .description('Show Colony adoption ratios from local DB evidence')
    .option('--hours <n>', 'Window size in hours', String(DEFAULT_HOURS))
    .option('--json', 'emit structured JSON')
    .option('--prompts', 'emit compact Codex prompt snippets for next fixes')
    .option('--verbose', 'show lower-priority health follow-ups in next fixes')
    .action(
      async (opts: { hours: string; json?: boolean; prompts?: boolean; verbose?: boolean }) => {
        const hours = parseHours(opts.hours);
        const settings = loadSettings();
        const { withStorage } = await import('../util/store.js');
        await withStorage(
          settings,
          (storage) => {
            const payload = buildColonyHealthPayload(storage, {
              since: Date.now() - hours * 3_600_000,
              window_hours: hours,
              claim_stale_minutes: settings.claimStaleMinutes,
            });
            const formatOptions = opts.json
              ? { json: true }
              : { prompts: Boolean(opts.prompts), verbose: Boolean(opts.verbose) };
            process.stdout.write(`${formatColonyHealthOutput(payload, formatOptions)}\n`);
          },
          { readonly: true },
        );
      },
    );
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
    task_ready_share: ratio(taskReadyCalls, taskListCalls + taskReadyCalls),
    task_ready_per_task_list: ratio(taskReadyCalls, taskListCalls),
  };
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

function claimBeforeEditPayload(
  stats: ClaimBeforeEditStats,
  taskClaimFileCalls: number,
  codexRolloutEdits: number,
): ClaimBeforeEditPayload {
  const editsWithoutClaimBefore = stats.edits_with_file_path - stats.edits_claimed_before;
  const autoClaimedBeforeEdit = stats.auto_claimed_before_edit ?? 0;
  const preToolUseSignals = stats.pre_tool_use_signals ?? 0;
  const sessionBindingMissing = stats.session_binding_missing ?? 0;
  const claimMatchSources = claimMatchSourcesPayload(stats.claim_match_sources);
  const claimMissReasons = claimMissReasonsPayload(
    stats.claim_miss_reasons,
    editsWithoutClaimBefore,
  );
  const codexRolloutWithoutBridge = codexRolloutEdits > 0 && preToolUseSignals === 0;
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
    task_claim_file_calls: taskClaimFileCalls,
    hook_capable_edits: stats.edits_with_file_path,
    pre_tool_use_signals: preToolUseSignals,
  });
  const sessionBindingHint =
    sessionBindingMissing > 0
      ? 'PreToolUse is firing, but Colony session binding is missing. Restart the editor session so SessionStart binds the session id; keep calling task_claim_file manually until binding is restored.'
      : null;
  const installHint =
    codexRolloutHint ??
    (likelyMissingHook
      ? 'PreToolUse auto-claim is not covering hook-capable edits in this window. Run colony install --ide <ide>, restart the editor session, and ensure an active task is bound for the session.'
      : sessionBindingHint);
  return {
    ...stats,
    status,
    task_claim_file_calls: taskClaimFileCalls,
    edits_with_claim: stats.edits_claimed_before,
    edits_missing_claim: editsWithoutClaimBefore,
    auto_claimed_before_edit: autoClaimedBeforeEdit,
    edits_without_claim_before: editsWithoutClaimBefore,
    claim_before_edit_ratio:
      status === 'available' ? ratio(stats.edits_claimed_before, stats.edits_with_file_path) : null,
    pre_tool_use_signals: preToolUseSignals,
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
  task_claim_file_calls: number;
  hook_capable_edits: number;
  pre_tool_use_signals: number;
}): RootCauseSummary | null {
  if (input.task_claim_file_calls < LIFECYCLE_BRIDGE_MISSING_MIN_TASK_CLAIM_FILE_CALLS) {
    return null;
  }
  if (input.hook_capable_edits < LIFECYCLE_BRIDGE_MISSING_MIN_HOOK_CAPABLE_EDITS) {
    return null;
  }
  if (!isNearZeroPreToolUseSignals(input.pre_tool_use_signals, input.hook_capable_edits)) {
    return null;
  }
  return {
    kind: 'lifecycle_bridge_missing',
    summary: LIFECYCLE_BRIDGE_ROOT_CAUSE,
    evidence: `task_claim_file_calls=${input.task_claim_file_calls}, hook_capable_edits=${input.hook_capable_edits}, pre_tool_use_signals=${input.pre_tool_use_signals}`,
    action: LIFECYCLE_BRIDGE_ACTION,
    command: LIFECYCLE_BRIDGE_COMMAND,
  };
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
    classifyClaimAge(claim.claimed_at, {
      now: options.now,
      claim_stale_minutes: options.stale_claim_minutes,
    }),
  );
  const activeClaims = classified.filter(isStrongClaimAge).length;
  const staleClaims = classified.filter((claim) => claim.age_class === 'stale').length;
  const expiredClaims = classified.filter((claim) => claim.age_class === 'expired/weak').length;
  const weakClaims = classified.filter((claim) => claim.ownership_strength === 'weak').length;
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
    stale_claim_minutes: options.stale_claim_minutes,
    expired_handoffs: expiredHandoffs,
    expired_messages: expiredMessages,
  };
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
    lines.push(...formatEditSourceBreakdown(payload));
    if (payload.install_hint) lines.push(kleur.yellow(`  ${payload.install_hint}`));
    return lines;
  }
  if (payload.status === 'not_available') {
    lines.push(
      `  not available (${payload.edits_with_file_path} / ${payload.edit_tool_calls} edit calls include file_path metadata)`,
    );
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
        `    - owner=${owner.owner} session=${shortSession(owner.session_id)} branch=${owner.branch} activity=${owner.activity}`,
      );
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

function healthActionHints(payload: ColonyHealthPayloadWithoutHints): ActionHint[] {
  const hints: ActionHint[] = [];
  const liveContention = payload.live_contention_health;
  if (liveContention.live_file_contentions > 0) {
    hints.push({
      metric: 'live file contentions',
      status: 'bad',
      current: `${liveContention.live_file_contentions} conflict(s), ${liveContention.dirty_contended_files} dirty`,
      target: '0 conflicts',
      action:
        'Resolve same-file multi-owner claims before running broad verification or trusting branch health.',
      readiness_scope: 'execution_safety',
      priority: 5,
      tool_call:
        'mcp__colony__hivemind_context({ agent: "<agent>", session_id: "<session_id>", repo_root: "<repo_root>", files: ["<file>"] })',
      command: 'colony health --json',
      prompt: codexPrompt({
        goal: 'resolve live same-file ownership conflicts before branch verification',
        current: `${liveContention.live_file_contentions} live file contentions; ${liveContention.dirty_contended_files} dirty contended files`,
        inspect:
          'colony health --json, mcp__colony__hivemind_context, mcp__colony__attention_inbox',
        acceptance:
          'top conflicts are handed off, released, or reclaimed and live_file_contentions returns 0',
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
  if (isBelowTarget(readyToClaim.conversion_rate, TARGET_READY_TO_CLAIM)) {
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
        'Use task_message for directed agent-to-agent coordination; keep task_post for task-thread notes and decisions.',
      readiness_scope: 'adoption_followup',
      priority: 80,
      tool_call:
        'mcp__colony__task_message({ agent: "<agent>", session_id: "<session_id>", task_id: <task_id>, to_agent: "<agent|any>", urgency: "needs_reply", content: "<short request>" })',
      prompt: codexPrompt({
        goal: 'move agent-to-agent coordination from task_post notes to task_message',
        current: `${payload.task_post_vs_task_message.task_message_calls} task_message calls, ${payload.task_post_vs_task_message.task_post_calls} task_post calls`,
        inspect:
          'mcp__colony__task_message, mcp__colony__task_messages, mcp__colony__attention_inbox, docs/mcp.md',
        acceptance:
          'directed coordination uses task_message and unread replies surface in attention_inbox',
      }),
    });
  }

  const claimBeforeEdit = payload.task_claim_file_before_edits;
  const preToolUseMissing = claimBeforeEdit.claim_miss_reasons.pre_tool_use_missing;
  const preToolUseMissingDominates = isDominantPreToolUseMiss(claimBeforeEdit.claim_miss_reasons);
  if (claimBeforeEdit.root_cause?.kind === 'lifecycle_bridge_missing') {
    hints.push({
      metric: 'claim-before-edit',
      status: 'bad',
      current: `${claimBeforeEdit.root_cause.summary} (${claimBeforeEdit.root_cause.evidence})`,
      target: 'pre_tool_use before file mutation',
      action: claimBeforeEdit.root_cause.action,
      readiness_scope: 'execution_safety',
      priority: 5,
      command: claimBeforeEdit.root_cause.command,
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
  } else if (isBelowTarget(claimBeforeEdit.claim_before_edit_ratio, TARGET_CLAIM_BEFORE_EDIT)) {
    const missingHook = claimBeforeEdit.likely_missing_hook;
    const sessionBindingMissing = claimBeforeEdit.session_binding_missing > 0;
    hints.push({
      metric: 'claim-before-edit',
      status: 'bad',
      current: formatPercent(claimBeforeEdit.claim_before_edit_ratio),
      target: `${formatPercent(TARGET_CLAIM_BEFORE_EDIT)}+`,
      action: missingHook
        ? 'PreToolUse auto-claim hook is not firing for hook-capable edits. Reinstall and restart the editor; PreToolUse will auto-claim before edits.'
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
        'Run colony coordination sweep/rescue, then release, hand off, or reclaim stale ownership.',
      readiness_scope: 'signal_evaporation',
      priority: 40,
      tool_call: 'mcp__colony__rescue_stranded_scan({ stranded_after_minutes: <minutes> })',
      command: 'colony coordination sweep --json',
      prompt: codexPrompt({
        goal: 'clear stale ownership before agents trust current file claims',
        current: `${payload.signal_health.stale_claims} stale claims`,
        inspect:
          'colony coordination sweep --json, mcp__colony__rescue_stranded_scan, mcp__colony__hivemind_context',
        acceptance: 'stale claims are released, handed off, or reclaimed with audit evidence',
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
      priority: 25,
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

function visibleActionHints(
  payload: ColonyHealthPayload,
  options: { verbose: boolean },
): ActionHint[] {
  const byPriority = (hints: ActionHint[]) =>
    [...hints].sort((a, b) => a.priority - b.priority || a.metric.localeCompare(b.metric));

  if (options.verbose) return byPriority(payload.action_hints);

  const badReadinessScopes = new Set<ReadinessScope>(
    Object.entries(payload.readiness_summary)
      .filter(([, item]) => item.status === 'bad')
      .map(([scope]) => scope as ReadinessScope),
  );
  const readinessBottlenecks = payload.action_hints.filter((hint) =>
    badReadinessScopes.has(hint.readiness_scope),
  );
  if (readinessBottlenecks.length > 0) return byPriority(readinessBottlenecks);

  return byPriority(
    payload.action_hints.filter((hint) => hint.readiness_scope === 'adoption_followup'),
  );
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
  plan_slug: string;
  index: number;
  status: 'available' | 'claimed' | 'completed' | 'blocked';
  depends_on: number[];
  claimed_at: number | null;
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
    subtasks.push({
      plan_slug: planSlug,
      index,
      status: lifecycle.status,
      depends_on: readNumberArray(initialMeta.depends_on),
      claimed_at: lifecycle.claimed_at,
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
): Pick<PlanSubtaskHealth, 'status' | 'claimed_at'> {
  const claimRows = rows.filter((row) => row.kind === 'plan-subtask-claim');
  for (const precedence of ['completed', 'blocked', 'claimed'] as const) {
    const match = claimRows
      .filter((row) => parseJsonObject(row.metadata).status === precedence)
      .sort((a, b) => b.ts - a.ts)[0];
    if (match)
      return { status: precedence, claimed_at: precedence === 'claimed' ? match.ts : null };
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
    };
  }
  return { status: 'available', claimed_at: null };
}

function queenWaveHealthPayload(
  storage: Pick<Storage, 'taskTimeline'>,
  tasks: TaskRow[],
  options: { now: number; stale_claim_minutes: number },
): QueenWaveHealthPayload {
  const plans: QueenWavePlanSummary[] = [];

  for (const [planSlug, subtasks] of groupPlanSubtasks(readPlanSubtasks(storage, tasks))) {
    const incomplete = subtasks.filter((subtask) => subtask.status !== 'completed');
    if (incomplete.length === 0) continue;

    const currentWaveIndex = Math.min(...incomplete.map((subtask) => subtask.wave_index));
    const currentWave =
      subtasks.find((subtask) => subtask.wave_index === currentWaveIndex)?.wave_name ?? null;

    plans.push({
      plan_slug: planSlug,
      current_wave: currentWave,
      ready_subtasks: subtasks.filter((subtask) => isReadyPlanSubtask(subtask, subtasks)).length,
      claimed_subtasks: subtasks.filter((subtask) => subtask.status === 'claimed').length,
      blocked_subtasks: subtasks.filter((subtask) => isBlockedPlanSubtask(subtask, subtasks))
        .length,
      stale_claims_blocking_downstream: subtasks.filter(
        (subtask) => isStalePlanClaim(subtask, options) && blocksDownstream(subtask, subtasks),
      ).length,
    });
  }

  const currentWaves = new Set(plans.map((plan) => plan.current_wave).filter(Boolean));
  return {
    active_plans: plans.length,
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
    plans: plans.sort((a, b) => a.plan_slug.localeCompare(b.plan_slug)),
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

      const age = classifyClaimAge(claim.claimed_at, {
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

      claimOwners.push({
        file_path: filePath,
        owner_key: `${claim.session_id}\0${task.branch}`,
        owner: {
          owner: session?.agent || ownerFromSessionId(claim.session_id),
          session_id: claim.session_id,
          branch: task.branch,
          task_id: task.id,
          task_status: task.status ?? '',
          activity: session?.activity ?? (isStrongClaimAge(age) ? 'claim-active' : 'unknown'),
          worktree_path: worktreePath,
          claim_age_minutes: age.age_minutes,
          claim_strength: age.ownership_strength,
          dirty,
        },
      });
    }
  }

  const conflicts = Array.from(groupByFilePath(claimOwners).entries())
    .map(([filePath, owners]) => {
      const uniqueOwners = uniqueContentionOwners(owners);
      if (uniqueOwners.length <= 1) return null;
      const dirtyWorktrees = uniqueOwners
        .filter((owner) => owner.dirty && owner.worktree_path)
        .map((owner) => owner.worktree_path);
      return {
        file_path: filePath,
        owner_count: uniqueOwners.length,
        protected: uniqueOwners.some((owner) => isProtectedBranch(owner.branch)),
        dirty_worktrees: [...new Set(dirtyWorktrees)].sort(),
        owners: uniqueOwners.sort(compareContentionOwners),
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

function readNumberArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((item): item is number => typeof item === 'number')
    : [];
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
