import { defaultSettings, loadSettings } from '@colony/config';
import {
  ProposalSystem,
  classifyClaimAge,
  currentSignalStrength,
  isSignalExpired,
  isStrongClaimAge,
  signalMetadataFromObservation,
  signalMetadataFromProposal,
} from '@colony/core';
import type {
  ClaimBeforeEditStats,
  ObservationRow,
  ProposalRow,
  ReinforcementRow,
  Storage,
  TaskRow,
  ToolCallRow,
} from '@colony/storage';
import type { Command } from 'commander';
import kleur from 'kleur';
import { readCodexMcpToolCallsSince } from '../lib/codex-rollouts.js';

const DEFAULT_HOURS = 24;
const HEALTH_TOOL_LIMIT = 5;
const DEFAULT_HANDOFF_TTL_MS = 2 * 60 * 60_000;
const PLAN_SUBTASK_BRANCH_RE = /^spec\/([a-z0-9-]+)\/sub-(\d+)$/;
const TARGET_HIVEMIND_TO_ATTENTION = 0.5;
const TARGET_TASK_LIST_TO_READY = 0.3;
const TARGET_READY_TO_CLAIM = 0.3;
const TARGET_CLAIM_BEFORE_EDIT = 0.5;
const TARGET_COLONY_NOTE_SHARE = 0.7;

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
}

export interface ColonyHealthPayload {
  generated_at: string;
  window_hours: number;
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
  adoption_thresholds: AdoptionThresholdsPayload;
  action_hints: ActionHint[];
}

type ColonyHealthPayloadWithoutHints = Omit<ColonyHealthPayload, 'action_hints'>;

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
    task_claim_file_before_edits: claimBeforeEditPayload(claimBeforeEditStats, taskClaimFileCalls),
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
    adoption_thresholds: adoptionThresholds(calls, {
      colony_mcp_share: ratio(colonyMcpToolCalls, mcpToolCalls),
      task_claim_file_calls: taskClaimFileCalls,
      task_post_calls: taskPostCalls,
      task_note_working_calls: taskNoteWorkingCalls,
    }),
  };

  return {
    ...payload,
    action_hints: healthActionHints(payload),
  };
}

export function formatColonyHealthOutput(
  payload: ColonyHealthPayload,
  options: { json?: boolean } = {},
): string {
  if (options.json) return JSON.stringify(payload, null, 2);

  const lines = [
    kleur.bold('colony health'),
    kleur.dim(`window: last ${payload.window_hours}h`),
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

  lines.push('', kleur.bold('Next fixes'));
  if (payload.action_hints.length === 0) {
    lines.push(kleur.green('  none: tracked thresholds meet targets'));
  } else {
    payload.action_hints.forEach((hint, index) => {
      lines.push(
        `  ${index + 1}. ${hint.metric}: ${hint.current} (target ${hint.target}) - ${hint.action}`,
      );
    });
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

export function registerHealthCommand(program: Command): void {
  program
    .command('health')
    .description('Show Colony adoption ratios from local DB evidence')
    .option('--hours <n>', 'Window size in hours', String(DEFAULT_HOURS))
    .option('--json', 'emit structured JSON')
    .action(async (opts: { hours: string; json?: boolean }) => {
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
          const formatOptions = opts.json ? { json: true } : {};
          process.stdout.write(`${formatColonyHealthOutput(payload, formatOptions)}\n`);
        },
        { readonly: true },
      );
    });
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
): ClaimBeforeEditPayload {
  const editsWithoutClaimBefore = stats.edits_with_file_path - stats.edits_claimed_before;
  const autoClaimedBeforeEdit = stats.auto_claimed_before_edit ?? 0;
  const status =
    stats.edit_tool_calls === 0
      ? 'no_data'
      : stats.edit_tool_calls === stats.edits_with_file_path
        ? 'available'
        : 'not_available';
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
    return lines;
  }
  if (payload.status === 'not_available') {
    lines.push(
      `  not available (${payload.edits_with_file_path} / ${payload.edit_tool_calls} edit calls include file_path metadata)`,
    );
    return lines;
  }
  lines.push(
    `  ${payload.edits_claimed_before} / ${payload.edits_with_file_path} edits had explicit claims first (${formatPercent(
      payload.claim_before_edit_ratio,
    )})`,
  );
  lines.push(`  missing proactive claim: ${payload.edits_without_claim_before}`);
  lines.push(
    `  telemetry: edits_with_claim=${payload.edits_with_claim}, edits_missing_claim=${payload.edits_missing_claim}, auto_claimed_before_edit=${payload.auto_claimed_before_edit}`,
  );
  return lines;
}

function healthActionHints(payload: ColonyHealthPayloadWithoutHints): ActionHint[] {
  const hints: ActionHint[] = [];
  const hivemindToAttention = payload.conversions.hivemind_context_to_attention_inbox;
  if (isBelowTarget(hivemindToAttention.conversion_rate, TARGET_HIVEMIND_TO_ATTENTION)) {
    hints.push({
      metric: 'hivemind_context -> attention_inbox',
      status: 'bad',
      current: formatPercent(hivemindToAttention.conversion_rate),
      target: `${formatPercent(TARGET_HIVEMIND_TO_ATTENTION)}+`,
      action:
        'After hivemind_context, call attention_inbox to clear handoffs, unread messages, and blockers.',
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
    });
  }

  const readyToClaim = payload.conversions.task_ready_for_agent_to_task_plan_claim_subtask;
  if (isBelowTarget(readyToClaim.conversion_rate, TARGET_READY_TO_CLAIM)) {
    hints.push({
      metric: 'task_ready_for_agent -> claim',
      status: 'bad',
      current: formatPercent(readyToClaim.conversion_rate),
      target: `${formatPercent(TARGET_READY_TO_CLAIM)}+`,
      action:
        'When ready work fits, claim it with task_plan_claim_subtask, then claim touched files before implementation.',
    });
  }

  if (
    isBelowTarget(
      payload.task_claim_file_before_edits.claim_before_edit_ratio,
      TARGET_CLAIM_BEFORE_EDIT,
    )
  ) {
    hints.push({
      metric: 'claim-before-edit',
      status: 'bad',
      current: formatPercent(payload.task_claim_file_before_edits.claim_before_edit_ratio),
      target: `${formatPercent(TARGET_CLAIM_BEFORE_EDIT)}+`,
      action: 'Call task_claim_file for touched files before Edit or Write tool use.',
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
    });
  }

  if (payload.queen_wave_health.stale_claims_blocking_downstream > 0) {
    hints.push({
      metric: 'stale claims blocking downstream',
      status: 'bad',
      current: String(payload.queen_wave_health.stale_claims_blocking_downstream),
      target: '0',
      action: 'Run colony queen sweep/rescue so later waves can become claimable.',
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
    });
  }

  return hints;
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

function parseHours(raw: string): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_HOURS;
}

function shortSession(sessionId: string): string {
  if (sessionId.length <= 14) return sessionId;
  return `${sessionId.slice(0, 11)}...`;
}
