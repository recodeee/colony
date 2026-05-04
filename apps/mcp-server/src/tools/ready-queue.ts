import {
  type AgentProfile,
  type ClaimHolder,
  type McpCapabilityMap,
  type MemoryStore,
  type PlanInfo,
  type SubtaskInfo,
  claimsForPaths,
  discoverMcpCapabilities,
  listMessagesForAgent,
  listPlans,
  loadProfile,
  rankCandidates,
} from '@colony/core';
import type { ObservationRow, TaskClaimRow, TaskRow } from '@colony/storage';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { type ToolContext, defaultWrapHandler } from './context.js';
import { attemptClaimPlanSubtask } from './plan.js';
import { type CompactNegativeWarning, searchNegativeWarnings } from './shared.js';

const DEFAULT_LIMIT = 5;
const RELEASE_DENSITY_WINDOW_MS = 60 * 60 * 1000;
const CURRENT_TASK_SWITCH_MARGIN = 0.2;
const RECENT_CLAIM_COOLDOWN_MS = 20 * 60 * 1000;
const RECENT_CLAIM_COOLDOWN_MARGIN = 0.05;
const RECENT_RUNTIME_SIGNAL_WINDOW_MS = 6 * 60 * 60 * 1000;
const STALE_BLOCKER_WINDOW_MS = 60 * 60 * 1000;
const LARGE_TASK_FILE_COUNT = 4;
const MISSING_CAPABILITY_SCORE = 0.2;
const CAPABLE_AGENT_SCORE = 0.5;
const QUOTA_READY_FILE_PREVIEW_LIMIT = 3;
const QUOTA_READY_TEXT_LIMIT = 240;
const PLAN_SUBTASK_KIND = 'plan-subtask';
const PLAN_SUBTASK_CLAIM_KIND = 'plan-subtask-claim';
const QUOTA_RELAY_READY_KIND = 'quota_relay_ready';
export const NO_CLAIMABLE_PLAN_SUBTASKS_EMPTY_STATE =
  'No claimable plan subtasks. Publish a Queen/task plan for multi-agent work, reinforce a proposal with task_propose/task_reinforce, or use task_list only for browsing.';
export const NO_PLAN_NEXT_ACTION =
  'Publish a Queen/task plan or promote a proposal into claimable work.';
export const NO_READY_SUBTASKS_NEXT_ACTION =
  'Complete upstream dependencies or unblock current plan waves before claiming more work.';
const CAPABILITY_HINT_TEXT: Record<string, string> = {
  ui_work: 'ui',
  api_work: 'api',
  test_work: 'test',
  infra_work: 'build config pipeline',
  doc_work: 'doc',
};

export type ReadyReason = 'continue_current_task' | 'urgent_override' | 'ready_high_score';

export interface TaskPlanClaimArgs {
  repo_root: string;
  plan_slug: string;
  subtask_index: number;
  session_id: string;
  agent: string;
  file_scope: string[];
}

export interface ReadySubtask {
  priority?: number;
  next_tool?: 'task_plan_claim_subtask';
  next_action_reason?: string;
  codex_mcp_call?: string;
  plan_slug: string;
  subtask_index: number;
  wave_index: number;
  wave_name: string;
  blocked_by_count: number;
  title: string;
  capability_hint: string | null;
  file_scope: string[];
  fit_score: number;
  reason: ReadyReason;
  reasoning: string;
  assigned_agent: string;
  routing_reason: string;
  claim_args: TaskPlanClaimArgs;
}

export interface ReadySubtaskWithWarnings extends ReadySubtask {
  negative_warnings: CompactNegativeWarning[];
}

export interface TaskClaimQuotaAcceptArgs {
  task_id: number;
  session_id: string;
  agent: string;
  handoff_observation_id: number;
}

export interface QuotaRelayReady {
  kind: typeof QUOTA_RELAY_READY_KIND;
  priority?: number;
  next_tool: 'task_claim_quota_accept';
  next_action_reason: string;
  codex_mcp_call?: string;
  task_id: number;
  old_session_id: string;
  old_owner: {
    session_id: string;
    agent: string | null;
  };
  files: string[];
  file_count: number;
  active_files: string[];
  active_file_count: number;
  evidence: string;
  next: string;
  age: {
    milliseconds: number;
    minutes: number;
  };
  repo_root: string;
  branch: string;
  expires_at: number | null;
  has_active_files: boolean;
  blocks_downstream: boolean;
  quota_observation_id: number;
  quota_observation_kind: 'handoff' | 'relay';
  task_active: boolean;
  claim_args: TaskClaimQuotaAcceptArgs;
  negative_warnings: CompactNegativeWarning[];
}

export type ReadyQueueEntry = ReadySubtaskWithWarnings | QuotaRelayReady;
type ClaimableReadyEntry = RankedSubtask | QuotaRelayReady;

export interface ReadyScopeOverlapWarning {
  code: 'ready_scope_overlap';
  severity: 'warning';
  plan_slug: string;
  wave_index: number | null;
  wave_name: string;
  file_path: string;
  protected: boolean;
  subtask_indexes: number[];
  titles: string[];
  message: string;
}

export interface ReadyForAgentResult {
  ready: ReadyQueueEntry[];
  total_available: number;
  mcp_capability_map?: McpCapabilityMap;
  ready_scope_overlap_warnings: ReadyScopeOverlapWarning[];
  next_action: string;
  next_tool?: 'task_plan_claim_subtask' | 'task_claim_quota_accept' | 'rescue_stranded_scan';
  /**
   * When true, the response carries a claimable plan sub-task that the
   * caller is expected to follow up with `task_plan_claim_subtask` (or
   * `task_claim_quota_accept` for quota relays) before treating the
   * sub-task as ready work. Surfaced so the loop adoption metric stops
   * stalling at 0% from agents that read the queue without claiming.
   */
  claim_required?: boolean;
  plan_slug?: string;
  subtask_index?: number;
  reason?: ReadyReason;
  assigned_agent?: string;
  routing_reason?: string;
  claim_args?: TaskPlanClaimArgs | TaskClaimQuotaAcceptArgs;
  rescue_candidate?: StaleBlockerRescueCandidate;
  rescue_args?: { stranded_after_minutes: number };
  codex_mcp_call?: string;
  next_action_reason?: string;
  empty_state?: string;
  /**
   * Populated when the caller passed `auto_claim: true` and the server
   * attempted the claim in-band. The result is reported regardless of
   * outcome so callers always know whether the next-step obligation was
   * fulfilled or whether they still need to react (e.g. to a takeover
   * recommendation).
   */
  auto_claimed?: AutoClaimOutcome;
}

export type AutoClaimOutcome =
  | {
      ok: true;
      plan_slug: string;
      subtask_index: number;
      task_id: number;
      branch: string;
      file_scope: string[];
    }
  | {
      ok: false;
      plan_slug: string;
      subtask_index: number;
      code: string;
      message: string;
    };

interface RankedSubtask extends ReadySubtask {
  task_id: number;
  created_at: number;
  claim_ts: number | null;
  current_claim: boolean;
}

interface ScopeConflict {
  file_path: string;
  holder: ClaimHolder;
}

export interface StaleBlockerRescueCandidate {
  plan_slug: string;
  task_id: number;
  subtask_index: number;
  title: string;
  file: string | null;
  owner_session_id: string | null;
  owner_agent: string | null;
  age_minutes: number;
  unlock_candidate: {
    task_id: number;
    subtask_index: number;
    title: string;
    file_scope: string[];
  } | null;
}

export function register(server: McpServer, ctx: ToolContext): void {
  const wrapHandler = ctx.wrapHandler ?? defaultWrapHandler;
  const { store } = ctx;

  server.tool(
    'task_ready_for_agent',
    'Find the next task to claim for this agent. Use this when deciding what to work on. Returns exact task_plan_claim_subtask args when work is claimable, or a compact empty_state when no plan sub-tasks can be claimed. Capability map is opt-in via include_capability_map. Pass auto_claim=true to have the server claim the single unambiguous candidate in the same call (only fires when next_tool would be task_plan_claim_subtask and assigned_agent matches the caller).',
    {
      session_id: z.string().min(1),
      agent: z.string().min(1),
      repo_root: z.string().min(1).optional(),
      limit: z.number().int().positive().max(20).optional(),
      include_capability_map: z.boolean().optional(),
      auto_claim: z.boolean().optional(),
    },
    wrapHandler(
      'task_ready_for_agent',
      async ({ session_id, agent, repo_root, limit, include_capability_map, auto_claim }) => {
        const result = await buildReadyForAgent(store, {
          session_id,
          agent,
          ...(repo_root !== undefined ? { repo_root } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(include_capability_map !== undefined ? { include_capability_map } : {}),
        });
        if (auto_claim) {
          const enriched = await maybeAutoClaim(store, result, { session_id, agent });
          return jsonReply(enriched);
        }
        return jsonReply(result);
      },
    ),
  );
}

async function maybeAutoClaim(
  store: MemoryStore,
  result: ReadyForAgentResult,
  caller: { session_id: string; agent: string },
): Promise<ReadyForAgentResult> {
  if (!result.claim_required) return result;
  if (result.next_tool !== 'task_plan_claim_subtask') return result;
  const claim_args = result.claim_args;
  if (!claim_args || !('plan_slug' in claim_args)) return result;
  if (
    result.assigned_agent !== undefined &&
    result.assigned_agent !== caller.agent &&
    result.assigned_agent !== 'any'
  ) {
    return result;
  }
  const claimResult = attemptClaimPlanSubtask(store, {
    plan_slug: claim_args.plan_slug,
    subtask_index: claim_args.subtask_index,
    session_id: caller.session_id,
    agent: caller.agent,
  });
  if (claimResult.ok) {
    return {
      ...result,
      auto_claimed: {
        ok: true,
        plan_slug: claim_args.plan_slug,
        subtask_index: claim_args.subtask_index,
        task_id: claimResult.task_id,
        branch: claimResult.branch,
        file_scope: claimResult.file_scope,
      },
      next_action: `Auto-claimed ${claim_args.plan_slug}/sub-${claim_args.subtask_index}: claim files before edits with task_claim_file, then post task_note_working.`,
    };
  }
  return {
    ...result,
    auto_claimed: {
      ok: false,
      plan_slug: claim_args.plan_slug,
      subtask_index: claim_args.subtask_index,
      code: claimResult.code,
      message: claimResult.message,
    },
  };
}

export async function buildReadyForAgent(
  store: MemoryStore,
  args: {
    session_id: string;
    agent: string;
    repo_root?: string;
    limit?: number;
    include_capability_map?: boolean;
  },
): Promise<ReadyForAgentResult> {
  const allTasks = store.storage.listTasks(2000);
  const plans = listPlans(store, {
    ...(args.repo_root !== undefined ? { repo_root: args.repo_root } : {}),
    limit: 2000,
  });
  const profile = loadProfile(store.storage, args.agent);
  const tasksById = new Map(
    allTasks.map((t) => [t.id, { created_at: t.created_at, created_by: t.created_by }]),
  );
  const quotaRelays = quotaRelayReadyItems(store, args, plans, allTasks);
  const available = plans.flatMap((plan) =>
    plan.next_available.map((subtask) =>
      rankSubtask(store, {
        plan_slug: plan.plan_slug,
        repo_root: plan.repo_root,
        subtask,
        session_id: args.session_id,
        agent: args.agent,
        profile,
        parent_plan_created_by: tasksById.get(plan.spec_task_id)?.created_by ?? null,
        created_at: tasksById.get(subtask.task_id)?.created_at ?? plan.created_at,
        reason: 'ready_high_score',
        current_claim: false,
      }),
    ),
  );
  const currentClaims = plans.flatMap((plan) =>
    plan.subtasks
      .filter(
        (subtask) =>
          subtask.status === 'claimed' && subtask.claimed_by_session_id === args.session_id,
      )
      .map((subtask) =>
        rankSubtask(store, {
          plan_slug: plan.plan_slug,
          repo_root: plan.repo_root,
          subtask,
          session_id: args.session_id,
          agent: args.agent,
          profile,
          parent_plan_created_by: tasksById.get(plan.spec_task_id)?.created_by ?? null,
          created_at: tasksById.get(subtask.task_id)?.created_at ?? plan.created_at,
          reason: 'continue_current_task',
          current_claim: true,
        }),
      ),
  );
  const urgentTaskIds = blockingMessageTaskIds(store, {
    session_id: args.session_id,
    agent: args.agent,
    task_ids: [...new Set([...available, ...currentClaims].map((task) => task.task_id))],
  });
  const planRanked = rankForSelection(
    available.map((task) =>
      urgentTaskIds.has(task.task_id) ? { ...task, reason: 'urgent_override' } : task,
    ),
    currentClaims,
  ).map((task) => applyRuntimeRouting(store, task, args.agent, args.repo_root));
  const ranked = rankReadyEntries(quotaRelays, planRanked);
  const selected = ranked.slice(0, args.limit ?? DEFAULT_LIMIT);
  const claimable = ranked.find(isClaimableEntry) ?? null;
  const ready = await Promise.all(
    selected.map(async (entry, index) => {
      const priority = index + 1;
      if (isQuotaRelayReady(entry)) {
        return {
          ...entry,
          priority,
          codex_mcp_call: quotaMcpCall(entry.claim_args),
        };
      }
      const {
        created_at: _createdAt,
        task_id: _taskId,
        claim_ts: _claimTs,
        current_claim: _currentClaim,
        ...subtaskEntry
      } = entry;
      const claimMetadata = _currentClaim
        ? {}
        : {
            next_tool: 'task_plan_claim_subtask' as const,
            next_action_reason: claimReason(subtaskEntry),
            codex_mcp_call: codexMcpCall(subtaskEntry.claim_args),
          };
      return {
        ...subtaskEntry,
        priority,
        ...claimMetadata,
        negative_warnings: await readyNegativeWarnings(store, subtaskEntry),
      };
    }),
  );

  return buildReadyResult(
    {
      ready,
      total_available: available.length + quotaRelays.length,
      ...(args.include_capability_map ? { mcp_capability_map: discoverMcpCapabilities() } : {}),
      ready_scope_overlap_warnings: readyScopeOverlapWarnings(store, plans),
    },
    claimable,
    args,
    plans.length > 0,
    available.length === 0 && quotaRelays.length === 0 ? staleBlockerRescueCandidate(plans) : null,
  );
}

function buildReadyResult(
  base: Pick<
    ReadyForAgentResult,
    'ready' | 'total_available' | 'mcp_capability_map' | 'ready_scope_overlap_warnings'
  >,
  claimable: ClaimableReadyEntry | null,
  args: { session_id: string; agent: string },
  hasPlans: boolean,
  rescueCandidate: StaleBlockerRescueCandidate | null,
): ReadyForAgentResult {
  if (claimable === null) {
    if (base.ready.length > 0) {
      return {
        ...base,
        next_action: readyNextAction(base.ready, args),
      };
    }
    if (rescueCandidate) {
      return {
        ...base,
        next_action: `Rescue stale blocker ${rescueCandidate.plan_slug}/sub-${rescueCandidate.subtask_index}; it blocks sub-${rescueCandidate.unlock_candidate?.subtask_index ?? 'unknown'}.`,
        next_tool: 'rescue_stranded_scan',
        plan_slug: rescueCandidate.plan_slug,
        subtask_index: rescueCandidate.subtask_index,
        rescue_candidate: rescueCandidate,
        rescue_args: { stranded_after_minutes: STALE_BLOCKER_WINDOW_MS / 60_000 },
      };
    }
    return {
      ...base,
      next_action: hasPlans ? NO_READY_SUBTASKS_NEXT_ACTION : NO_PLAN_NEXT_ACTION,
      empty_state: NO_CLAIMABLE_PLAN_SUBTASKS_EMPTY_STATE,
    };
  }

  if (isQuotaRelayReady(claimable)) {
    return {
      ...base,
      next_action: readyNextAction(base.ready, args),
      next_tool: 'task_claim_quota_accept',
      claim_required: true,
      claim_args: claimable.claim_args,
      codex_mcp_call: quotaMcpCall(claimable.claim_args),
      next_action_reason: claimable.next_action_reason,
    };
  }

  const claim_args = claimable.claim_args;
  if (claimable.assigned_agent !== args.agent && claimable.assigned_agent !== 'any') {
    return {
      ...base,
      next_action: `Route ${claimable.plan_slug}/sub-${claimable.subtask_index} to ${claimable.assigned_agent}: ${claimable.routing_reason}.`,
      plan_slug: claimable.plan_slug,
      subtask_index: claimable.subtask_index,
      reason: claimable.reason,
      assigned_agent: claimable.assigned_agent,
      routing_reason: claimable.routing_reason,
    };
  }
  return {
    ...base,
    next_action: readyNextAction(base.ready, args),
    next_tool: 'task_plan_claim_subtask',
    claim_required: true,
    plan_slug: claimable.plan_slug,
    subtask_index: claimable.subtask_index,
    reason: claimable.reason,
    assigned_agent: claimable.assigned_agent,
    routing_reason: claimable.routing_reason,
    next_action_reason: claimReason(claimable),
    claim_args,
    codex_mcp_call: codexMcpCall(claim_args),
  };
}

function codexMcpCall(args: TaskPlanClaimArgs): string {
  return `mcp__colony__task_plan_claim_subtask({ agent: ${JSON.stringify(args.agent)}, session_id: ${JSON.stringify(args.session_id)}, repo_root: ${JSON.stringify(args.repo_root)}, plan_slug: ${JSON.stringify(args.plan_slug)}, subtask_index: ${args.subtask_index}, file_scope: ${JSON.stringify(args.file_scope)} })`;
}

function quotaMcpCall(args: TaskClaimQuotaAcceptArgs): string {
  return `mcp__colony__task_claim_quota_accept({ session_id: ${JSON.stringify(args.session_id)}, agent: ${JSON.stringify(args.agent)}, task_id: ${args.task_id}, handoff_observation_id: ${args.handoff_observation_id} })`;
}

function readyNextAction(
  ready: ReadyQueueEntry[],
  args: { session_id: string; agent: string },
): string {
  const top = ready[0];
  if (!top) {
    return 'No ready plan sub-tasks; publish claimable work with queen_plan_goal or task_plan_publish, or complete upstream dependencies.';
  }
  if (isQuotaRelayReady(top)) {
    return `Call task_claim_quota_accept for quota-stopped task ${top.task_id}, branch="${top.branch}", session_id="${args.session_id}", agent="${args.agent}".`;
  }
  if (top.reason === 'continue_current_task') {
    return `Continue claimed sub-task ${top.plan_slug}/sub-${top.subtask_index}; call task_plan_complete_subtask when done. Claim different ready work only when it should override the current task.`;
  }
  return `Call task_plan_claim_subtask with plan_slug="${top.plan_slug}", subtask_index=${top.subtask_index}, session_id="${args.session_id}", agent="${args.agent}".`;
}

function claimReason(entry: ReadySubtask): string {
  if (entry.reason === 'urgent_override') {
    return `Claim ${entry.plan_slug}/sub-${entry.subtask_index}: blocking task message overrides the current task bias.`;
  }
  return `Claim ${entry.plan_slug}/sub-${entry.subtask_index}: it is unclaimed, dependencies are met, and it is the highest-ranked claimable ready item.`;
}

async function readyNegativeWarnings(
  store: MemoryStore,
  entry: ReadySubtask,
): Promise<CompactNegativeWarning[]> {
  const seen = new Set<number>();
  const warnings: CompactNegativeWarning[] = [];
  for (const query of readyWarningQueries(entry)) {
    const hits = await searchNegativeWarnings(store, query, 3);
    for (const hit of hits) {
      if (seen.has(hit.id)) continue;
      seen.add(hit.id);
      warnings.push(hit);
      if (warnings.length >= 3) return warnings;
    }
  }
  return warnings;
}

function readyWarningQueries(entry: ReadySubtask): string[] {
  const queries = [
    compactTitleQuery(entry.title),
    ...entry.file_scope.map(fileTokenQuery),
    entry.title,
  ].filter((query) => query.length > 0);
  return [...new Set(queries)].map((query) => query.slice(0, 800));
}

function readyScopeOverlapWarnings(
  store: MemoryStore,
  plans: PlanInfo[],
): ReadyScopeOverlapWarning[] {
  const warnings: ReadyScopeOverlapWarning[] = [];
  for (const plan of plans) {
    const subtasksByFile = new Map<string, SubtaskInfo[]>();
    for (const subtask of plan.next_available) {
      for (const file of subtask.file_scope) {
        const bucket = subtasksByFile.get(file) ?? [];
        bucket.push(subtask);
        subtasksByFile.set(file, bucket);
      }
    }

    for (const [filePath, subtasks] of subtasksByFile) {
      if (subtasks.length < 2) continue;
      const waveIndexes = [...new Set(subtasks.map((subtask) => subtask.wave_index))];
      const protectedFile = isProtectedReadyFile(store, filePath);
      warnings.push({
        code: 'ready_scope_overlap',
        severity: 'warning',
        plan_slug: plan.plan_slug,
        wave_index: waveIndexes.length === 1 ? (waveIndexes[0] ?? null) : null,
        wave_name: waveIndexes.length === 1 ? (subtasks[0]?.wave_name ?? 'Wave 1') : 'mixed waves',
        file_path: filePath,
        protected: protectedFile,
        subtask_indexes: subtasks.map((subtask) => subtask.subtask_index),
        titles: subtasks.map((subtask) => subtask.title),
        message: `${plan.plan_slug} has ${subtasks.length} ready subtasks touching ${protectedFile ? 'protected ' : ''}${filePath}; serialize with depends_on before parallel claims.`,
      });
    }
  }

  return warnings.sort(
    (left, right) =>
      left.plan_slug.localeCompare(right.plan_slug) ||
      left.file_path.localeCompare(right.file_path) ||
      (left.subtask_indexes[0] ?? -1) - (right.subtask_indexes[0] ?? -1),
  );
}

function isProtectedReadyFile(store: MemoryStore, filePath: string): boolean {
  const normalized = normalizeReadyFile(filePath);
  return (
    store.settings.protected_files.some((file) => normalizeReadyFile(file) === normalized) ||
    isProtectedFile(filePath)
  );
}

function normalizeReadyFile(filePath: string): string {
  return filePath.replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+/g, '/');
}

function compactTitleQuery(title: string): string {
  const stop = new Set([
    'add',
    'review',
    'update',
    'implement',
    'fix',
    'create',
    'protect',
    'keep',
    'the',
    'a',
    'an',
    'and',
    'to',
    'for',
  ]);
  return title
    .split(/\s+/)
    .filter((token) => token && !stop.has(token.toLowerCase()))
    .join(' ');
}

function fileTokenQuery(filePath: string): string {
  return filePath
    .split(/[^A-Za-z0-9_]+/)
    .filter(Boolean)
    .slice(-3)
    .join(' ');
}

function rankSubtask(
  store: MemoryStore,
  args: {
    plan_slug: string;
    repo_root: string;
    subtask: SubtaskInfo;
    session_id: string;
    agent: string;
    profile: AgentProfile;
    parent_plan_created_by: string | null;
    created_at: number;
    reason: ReadyReason;
    current_claim: boolean;
  },
): RankedSubtask {
  const capabilityMatch = capabilityMatchScore(args.subtask.capability_hint, args.profile);
  const conflicts = scopeConflicts(store, args.subtask.file_scope, args.session_id);
  const scopeConflictPenalty = conflicts.length > 0 ? 1 : 0;
  const recentClaimDensity = recentReleaseDensity(store, args.subtask.file_scope);
  const queenBonus = args.parent_plan_created_by === 'queen' ? 0.1 : 0;
  const fitScore = clampScore(
    capabilityMatch - 0.3 * scopeConflictPenalty - 0.1 * recentClaimDensity + queenBonus,
  );

  return {
    task_id: args.subtask.task_id,
    plan_slug: args.plan_slug,
    subtask_index: args.subtask.subtask_index,
    wave_index: args.subtask.wave_index,
    wave_name: args.subtask.wave_name,
    blocked_by_count: args.subtask.blocked_by_count,
    title: args.subtask.title,
    capability_hint: args.subtask.capability_hint,
    file_scope: args.subtask.file_scope,
    fit_score: fitScore,
    reason: args.reason,
    reasoning: buildReasoning({
      capability_hint: args.subtask.capability_hint,
      capability_match: capabilityMatch,
      file_count: args.subtask.file_scope.length,
      conflicts,
      recent_claim_density: recentClaimDensity,
      queen_bonus: queenBonus,
    }),
    assigned_agent: args.agent,
    routing_reason: 'Current agent remains eligible for this task.',
    claim_args: {
      repo_root: args.repo_root,
      plan_slug: args.plan_slug,
      subtask_index: args.subtask.subtask_index,
      session_id: args.session_id,
      agent: args.agent,
      file_scope: args.subtask.file_scope,
    },
    created_at: args.created_at,
    claim_ts: args.current_claim
      ? currentClaimTimestamp(store, args.subtask.task_id, args.session_id)
      : null,
    current_claim: args.current_claim,
  };
}

function rankForSelection(
  available: RankedSubtask[],
  currentClaims: RankedSubtask[],
): RankedSubtask[] {
  const orderedCurrent = [...currentClaims].sort(compareCurrentClaims);
  const activeCurrent = orderedCurrent[0] ?? null;
  if (!activeCurrent) {
    return [...available].sort(compareReady);
  }

  const switchMargin =
    activeCurrent.claim_ts !== null &&
    Date.now() - activeCurrent.claim_ts < RECENT_CLAIM_COOLDOWN_MS
      ? CURRENT_TASK_SWITCH_MARGIN + RECENT_CLAIM_COOLDOWN_MARGIN
      : CURRENT_TASK_SWITCH_MARGIN;
  const highScoreThreshold = activeCurrent.fit_score + switchMargin;

  return [...available, ...orderedCurrent].sort((a, b) => {
    const priorityDelta =
      selectionPriority(a, highScoreThreshold) - selectionPriority(b, highScoreThreshold);
    if (priorityDelta !== 0) return priorityDelta;
    if (a.current_claim || b.current_claim) return compareCurrentClaims(a, b);
    return compareReady(a, b);
  });
}

function rankReadyEntries(
  quotaRelays: QuotaRelayReady[],
  planRanked: RankedSubtask[],
): Array<QuotaRelayReady | RankedSubtask> {
  return [...quotaRelays, ...planRanked].sort((a, b) => {
    const priorityDelta = readyEntryPriority(a) - readyEntryPriority(b);
    if (priorityDelta !== 0) return priorityDelta;
    if (isQuotaRelayReady(a) && isQuotaRelayReady(b)) return compareQuotaRelays(a, b);
    if (isQuotaRelayReady(a)) return -1;
    if (isQuotaRelayReady(b)) return 1;
    if (a.current_claim || b.current_claim) return compareCurrentClaims(a, b);
    return compareReady(a, b);
  });
}

function readyEntryPriority(entry: QuotaRelayReady | RankedSubtask): number {
  if (isQuotaRelayReady(entry)) {
    if (entry.blocks_downstream) return 0;
    if (entry.has_active_files) return 3;
    return 5;
  }
  if (entry.reason === 'urgent_override') return 1;
  if (entry.current_claim) return 2;
  return 4;
}

function compareQuotaRelays(a: QuotaRelayReady, b: QuotaRelayReady): number {
  return (
    Number(b.blocks_downstream) - Number(a.blocks_downstream) ||
    Number(b.has_active_files) - Number(a.has_active_files) ||
    b.age.milliseconds - a.age.milliseconds ||
    a.repo_root.localeCompare(b.repo_root) ||
    a.branch.localeCompare(b.branch) ||
    a.task_id - b.task_id ||
    a.quota_observation_id - b.quota_observation_id
  );
}

function isClaimableEntry(entry: QuotaRelayReady | RankedSubtask): entry is ClaimableReadyEntry {
  return isQuotaRelayReady(entry) || !entry.current_claim;
}

function isQuotaRelayReady(entry: unknown): entry is QuotaRelayReady {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    (entry as { kind?: unknown }).kind === QUOTA_RELAY_READY_KIND
  );
}

function selectionPriority(task: RankedSubtask, highScoreThreshold: number): number {
  if (task.reason === 'urgent_override') return 0;
  if (!task.current_claim && task.fit_score >= highScoreThreshold) return 1;
  if (task.current_claim) return 2;
  return 3;
}

function compareReady(a: RankedSubtask, b: RankedSubtask): number {
  return (
    b.fit_score - a.fit_score ||
    a.created_at - b.created_at ||
    a.plan_slug.localeCompare(b.plan_slug) ||
    a.subtask_index - b.subtask_index
  );
}

function compareCurrentClaims(a: RankedSubtask, b: RankedSubtask): number {
  const aClaim = a.claim_ts ?? a.created_at;
  const bClaim = b.claim_ts ?? b.created_at;
  return (
    bClaim - aClaim ||
    b.fit_score - a.fit_score ||
    a.created_at - b.created_at ||
    a.plan_slug.localeCompare(b.plan_slug) ||
    a.subtask_index - b.subtask_index
  );
}

function blockingMessageTaskIds(
  store: MemoryStore,
  args: { session_id: string; agent: string; task_ids: number[] },
): Set<number> {
  if (args.task_ids.length === 0) return new Set();
  return new Set(
    listMessagesForAgent(store, {
      session_id: args.session_id,
      agent: args.agent,
      task_ids: args.task_ids,
      unread_only: true,
      limit: 200,
    })
      .filter((message) => message.urgency === 'blocking')
      .map((message) => message.task_id),
  );
}

function currentClaimTimestamp(
  store: MemoryStore,
  taskId: number,
  sessionId: string,
): number | null {
  const row = store.storage
    .taskObservationsByKind(taskId, PLAN_SUBTASK_CLAIM_KIND, 500)
    .find((entry) => {
      const meta = parseMeta(entry.metadata);
      return meta.status === 'claimed' && meta.session_id === sessionId;
    });
  return row?.ts ?? null;
}

function capabilityMatchScore(capabilityHint: string | null, profile: AgentProfile): number {
  if (capabilityHint === null) return 0.5;
  const summary = CAPABILITY_HINT_TEXT[capabilityHint] ?? capabilityHint.replace(/_/g, ' ');
  return clampScore(rankCandidates({ summary }, [profile])[0]?.score ?? 0);
}

function staleBlockerRescueCandidate(
  plans: Array<{
    plan_slug: string;
    subtasks: SubtaskInfo[];
  }>,
): StaleBlockerRescueCandidate | null {
  const now = Date.now();
  const candidates: StaleBlockerRescueCandidate[] = [];
  for (const plan of plans) {
    for (const subtask of plan.subtasks) {
      if (!isStaleClaimedSubtask(subtask, now)) continue;
      const unlock = unlockCandidateFor(subtask, plan.subtasks);
      if (!unlock) continue;
      candidates.push({
        plan_slug: plan.plan_slug,
        task_id: subtask.task_id,
        subtask_index: subtask.subtask_index,
        title: subtask.title,
        file: subtask.file_scope[0] ?? null,
        owner_session_id: subtask.claimed_by_session_id,
        owner_agent: subtask.claimed_by_agent,
        age_minutes: Math.floor((now - (subtask.claimed_at ?? now)) / 60_000),
        unlock_candidate: {
          task_id: unlock.task_id,
          subtask_index: unlock.subtask_index,
          title: unlock.title,
          file_scope: unlock.file_scope,
        },
      });
    }
  }

  return (
    candidates.sort(
      (a, b) =>
        b.age_minutes - a.age_minutes ||
        a.plan_slug.localeCompare(b.plan_slug) ||
        a.subtask_index - b.subtask_index,
    )[0] ?? null
  );
}

function isStaleClaimedSubtask(subtask: SubtaskInfo, now: number): boolean {
  return (
    subtask.status === 'claimed' &&
    subtask.claimed_at !== null &&
    now - subtask.claimed_at >= STALE_BLOCKER_WINDOW_MS
  );
}

function unlockCandidateFor(blocker: SubtaskInfo, subtasks: SubtaskInfo[]): SubtaskInfo | null {
  return (
    subtasks
      .filter(
        (subtask) =>
          subtask.status !== 'completed' &&
          subtask.subtask_index !== blocker.subtask_index &&
          subtask.blocked_by.includes(blocker.subtask_index),
      )
      .sort((a, b) => a.wave_index - b.wave_index || a.subtask_index - b.subtask_index)[0] ?? null
  );
}

function quotaRelayReadyItems(
  store: MemoryStore,
  args: { session_id: string; agent: string; repo_root?: string },
  plans: PlanInfo[],
  tasks: TaskRow[],
): QuotaRelayReady[] {
  const now = Date.now();
  const subtasksByTaskId = new Map<number, { plan: PlanInfo; subtask: SubtaskInfo }>();
  for (const plan of plans) {
    for (const subtask of plan.subtasks) {
      subtasksByTaskId.set(subtask.task_id, { plan, subtask });
    }
  }

  const groups = new Map<
    string,
    {
      task: TaskRow;
      old_owner_session_id: string;
      quota_observation_id: number;
      claims: TaskClaimRow[];
    }
  >();
  for (const task of tasks) {
    if (args.repo_root !== undefined && task.repo_root !== args.repo_root) continue;
    for (const claim of store.storage.listClaims(task.id)) {
      if (!isQuotaClaimReadyState(claim) || claim.handoff_observation_id === null) continue;
      const key = `${task.id}:${claim.session_id}:${claim.handoff_observation_id}`;
      const existing = groups.get(key);
      if (existing) {
        existing.claims.push(claim);
      } else {
        groups.set(key, {
          task,
          old_owner_session_id: claim.session_id,
          quota_observation_id: claim.handoff_observation_id,
          claims: [claim],
        });
      }
    }
  }

  const ready: QuotaRelayReady[] = [];
  for (const group of groups.values()) {
    const obs = store.storage.getObservation(group.quota_observation_id);
    if (!obs || obs.task_id !== group.task.id || !isQuotaRelayKind(obs.kind)) continue;
    const meta = parseMeta(obs.metadata);
    if (!isQuotaReadyObservation(obs, meta)) continue;
    if (!quotaObservationVisible(meta, args.session_id, args.agent)) continue;
    if (!quotaObservationClaimableStatus(meta)) continue;

    const allFiles = [...new Set(group.claims.map((claim) => claim.file_path))].sort();
    if (allFiles.length === 0) continue;
    const allActiveFiles = [
      ...new Set(
        group.claims
          .filter((claim) => claim.state === 'handoff_pending')
          .map((claim) => claim.file_path),
      ),
    ].sort();
    const files = allFiles.slice(0, QUOTA_READY_FILE_PREVIEW_LIMIT);
    const activeFiles = allActiveFiles.slice(0, QUOTA_READY_FILE_PREVIEW_LIMIT);
    const planSubtask = subtasksByTaskId.get(group.task.id);
    const blocksDownstream =
      planSubtask !== undefined &&
      unlockCandidateFor(planSubtask.subtask, planSubtask.plan.subtasks) !== null;
    const expiresAt = readNumber(meta.expires_at) ?? latestClaimExpiresAt(group.claims);
    const oldOwnerAgent =
      readString(meta.from_agent) ??
      store.storage.getParticipantAgent(group.task.id, group.old_owner_session_id) ??
      store.storage.getSession(group.old_owner_session_id)?.ide ??
      null;
    const ageMs = Math.max(0, now - obs.ts);

    ready.push({
      kind: QUOTA_RELAY_READY_KIND,
      next_tool: 'task_claim_quota_accept',
      next_action_reason: quotaRelayClaimReason(group.task, blocksDownstream),
      task_id: group.task.id,
      old_session_id: group.old_owner_session_id,
      old_owner: {
        session_id: group.old_owner_session_id,
        agent: oldOwnerAgent,
      },
      files,
      file_count: allFiles.length,
      active_files: activeFiles,
      active_file_count: allActiveFiles.length,
      evidence: compactQuotaReadyText(quotaRelayEvidence(obs, meta)),
      next: compactQuotaReadyText(quotaRelayNext(obs, meta)),
      age: {
        milliseconds: ageMs,
        minutes: Math.floor(ageMs / 60_000),
      },
      repo_root: group.task.repo_root,
      branch: group.task.branch,
      expires_at: expiresAt,
      has_active_files: allActiveFiles.length > 0,
      blocks_downstream: blocksDownstream,
      quota_observation_id: group.quota_observation_id,
      quota_observation_kind: obs.kind,
      task_active: group.task.status === 'open',
      claim_args: {
        task_id: group.task.id,
        session_id: args.session_id,
        agent: args.agent,
        handoff_observation_id: group.quota_observation_id,
      },
      negative_warnings: [],
    });
  }

  return ready;
}

function quotaRelayClaimReason(task: TaskRow, blocksDownstream: boolean): string {
  return blocksDownstream
    ? `Claim quota-stopped task ${task.id}: old owner stopped on quota and downstream plan work is blocked.`
    : `Claim quota-stopped task ${task.id}: old owner stopped on quota and the task is ready for replacement ownership.`;
}

function quotaRelayEvidence(obs: ObservationRow, meta: Record<string, unknown>): string {
  const quotaContext = readRecord(meta.quota_context);
  const lastVerification = readRecord(quotaContext?.last_verification);
  const command = readString(lastVerification?.command);
  const result = readString(lastVerification?.result);
  if (command !== null || result !== null) {
    return `last_verification=${command ?? 'unknown'} -> ${result ?? 'unknown'}`;
  }

  const worktreeRecipe = readRecord(meta.worktree_recipe);
  const fetchFilesAt = readString(worktreeRecipe?.fetch_files_at);
  if (fetchFilesAt !== null) return `fetch_files_at=${fetchFilesAt}`;

  const line = firstContentLine(obs.content);
  return line !== null
    ? `observation ${obs.id} ${obs.kind}: ${line}`
    : `observation ${obs.id} ${obs.kind}`;
}

function quotaRelayNext(obs: ObservationRow, meta: Record<string, unknown>): string {
  const nextStep = readStringArray(meta.next_steps)[0] ?? null;
  if (nextStep !== null) return nextStep;

  const quotaContext = readRecord(meta.quota_context);
  const suggestedNext = readString(quotaContext?.suggested_next_step);
  if (suggestedNext !== null) return suggestedNext;

  const oneLine = readString(meta.one_line);
  if (oneLine !== null) return oneLine;

  const resumableState = readRecord(meta.resumable_state);
  const lastHandoffSummary = readString(resumableState?.last_handoff_summary);
  if (lastHandoffSummary !== null) return lastHandoffSummary;

  const summary = readString(meta.summary);
  if (summary !== null) return summary;

  return firstContentLine(obs.content) ?? `Inspect ${obs.kind} #${obs.id}`;
}

function compactQuotaReadyText(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= QUOTA_READY_TEXT_LIMIT) return compact;
  return `${compact.slice(0, QUOTA_READY_TEXT_LIMIT - 3)}...`;
}

function isQuotaClaimReadyState(claim: TaskClaimRow): boolean {
  return claim.state === 'handoff_pending' || claim.state === 'weak_expired';
}

function isQuotaRelayKind(kind: string): kind is 'handoff' | 'relay' {
  return kind === 'handoff' || kind === 'relay';
}

function isQuotaReadyObservation(row: ObservationRow, meta: Record<string, unknown>): boolean {
  if (row.kind === 'relay')
    return readString(meta.reason) === 'quota' || isQuotaObservation(row, meta);
  return readString(meta.reason) === 'quota_exhausted' || isQuotaObservation(row, meta);
}

function quotaObservationVisible(
  meta: Record<string, unknown>,
  sessionId: string,
  agent: string,
): boolean {
  const toSession = readString(meta.to_session_id);
  const toAgent = readString(meta.to_agent);
  return (
    (toSession === null || toSession === sessionId) &&
    (toAgent === null || toAgent === 'any' || toAgent === agent)
  );
}

function quotaObservationClaimableStatus(meta: Record<string, unknown>): boolean {
  const status = readString(meta.status);
  return status === null || status === 'pending' || status === 'expired';
}

function latestClaimExpiresAt(claims: TaskClaimRow[]): number | null {
  const values = claims
    .map((claim) => claim.expires_at)
    .filter((value): value is number => typeof value === 'number');
  return values.length > 0 ? Math.max(...values) : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function firstContentLine(content: string | null): string | null {
  const line = content
    ?.split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  return line ?? null;
}

function applyRuntimeRouting(
  store: MemoryStore,
  task: RankedSubtask,
  requestedAgent: string,
  repoRoot: string | undefined,
): RankedSubtask {
  if (task.current_claim) return task;

  const signal = runtimeRoutingSignal(store, task, requestedAgent, repoRoot);
  if (!signal.shouldRouteAway) {
    return {
      ...task,
      assigned_agent: requestedAgent,
      routing_reason: signal.reason,
    };
  }

  return {
    ...task,
    assigned_agent: bestAlternateRuntime(store, task, requestedAgent, repoRoot, signal),
    routing_reason: signal.reason,
  };
}

function runtimeRoutingSignal(
  store: MemoryStore,
  task: RankedSubtask,
  requestedAgent: string,
  repoRoot: string | undefined,
): { shouldRouteAway: boolean; reason: string; quotaAgents: Set<string> } {
  const quotaAgents = recentQuotaAgents(store, repoRoot, task.task_id);
  const requestedQuota = quotaAgents.has(normalizeAgentKey(requestedAgent));
  const fileCount = task.file_scope.length;
  const protectedCount = protectedFileCount(task.file_scope);
  const staleBlockers = staleBlockerCount(store, task.task_id);
  const requestedCapability = capabilityMatchScore(
    task.capability_hint,
    loadProfile(store.storage, requestedAgent),
  );
  const missingCapability =
    task.capability_hint !== null && requestedCapability <= MISSING_CAPABILITY_SCORE;
  const largeTask = fileCount >= LARGE_TASK_FILE_COUNT;
  const riskyAfterQuota = requestedQuota && (largeTask || protectedCount > 0 || staleBlockers > 0);

  if (missingCapability) {
    return {
      shouldRouteAway: hasCapableAlternate(store, task, requestedAgent, repoRoot, quotaAgents),
      reason: `${displayAgent(requestedAgent)} lacks known ${task.capability_hint} capability; task requires ${task.capability_hint}.`,
      quotaAgents,
    };
  }

  if (riskyAfterQuota) {
    return {
      shouldRouteAway: true,
      reason: quotaRoutingReason(requestedAgent, fileCount, protectedCount, staleBlockers),
      quotaAgents,
    };
  }

  if (requestedQuota) {
    return {
      shouldRouteAway: false,
      reason:
        fileCount <= 1 && protectedCount === 0
          ? `${displayAgent(requestedAgent)} recently hit quota, but this task is tiny and isolated.`
          : `${displayAgent(requestedAgent)} recently hit quota, but this task stays below routing-away thresholds.`,
      quotaAgents,
    };
  }

  return {
    shouldRouteAway: false,
    reason: 'No recent runtime quota or capability signal requires rerouting.',
    quotaAgents,
  };
}

function quotaRoutingReason(
  agent: string,
  fileCount: number,
  protectedCount: number,
  staleBlockers: number,
): string {
  const details: string[] = [];
  if (fileCount >= LARGE_TASK_FILE_COUNT) details.push(`task spans ${fileCount} files`);
  if (protectedCount > 0) {
    details.push(`task touches ${protectedCount} protected file${protectedCount === 1 ? '' : 's'}`);
  }
  if (staleBlockers > 0) {
    details.push(`${staleBlockers} stale blocker${staleBlockers === 1 ? '' : 's'} exist`);
  }
  return `${displayAgent(agent)} recently hit quota on this branch; ${details.join('; ')}`;
}

function bestAlternateRuntime(
  store: MemoryStore,
  task: RankedSubtask,
  requestedAgent: string,
  repoRoot: string | undefined,
  signal: { quotaAgents: Set<string> },
): string {
  const requestedKey = normalizeAgentKey(requestedAgent);
  const candidates = candidateAgents(store, repoRoot).filter((agent) => {
    const key = normalizeAgentKey(agent);
    return key !== requestedKey && !signal.quotaAgents.has(key);
  });
  if (candidates.length === 0 && requestedKey === 'codex') {
    return 'claude-code';
  }
  if (candidates.length === 0) return 'any';

  const ranked = candidates
    .map((agent) => ({
      agent,
      score: capabilityMatchScore(task.capability_hint, loadProfile(store.storage, agent)),
    }))
    .sort((a, b) => b.score - a.score || a.agent.localeCompare(b.agent));
  return ranked[0]?.agent ?? 'any';
}

function hasCapableAlternate(
  store: MemoryStore,
  task: RankedSubtask,
  requestedAgent: string,
  repoRoot: string | undefined,
  quotaAgents: Set<string>,
): boolean {
  const requestedKey = normalizeAgentKey(requestedAgent);
  return candidateAgents(store, repoRoot).some((agent) => {
    const key = normalizeAgentKey(agent);
    if (key === requestedKey || quotaAgents.has(key)) return false;
    return (
      capabilityMatchScore(task.capability_hint, loadProfile(store.storage, agent)) >=
      CAPABLE_AGENT_SCORE
    );
  });
}

function candidateAgents(store: MemoryStore, repoRoot: string | undefined): string[] {
  const agents = new Set<string>();
  for (const row of store.storage.listAgentProfiles()) agents.add(row.agent);
  for (const session of store.storage.listSessions(500)) {
    if (repoRoot !== undefined && session.cwd !== repoRoot) continue;
    const ide = session.ide?.trim();
    if (ide) agents.add(ide);
    const prefix = session.id.includes('@') ? session.id.split('@')[0]?.trim() : '';
    if (prefix) agents.add(prefix);
  }
  for (const task of store.storage.listTasks(2000)) {
    if (repoRoot !== undefined && task.repo_root !== repoRoot) continue;
    for (const participant of store.storage.listParticipants(task.id)) {
      agents.add(participant.agent);
    }
  }
  return [...agents].filter((agent) => !isSystemAgent(agent)).sort();
}

function isSystemAgent(agent: string): boolean {
  const key = normalizeAgentKey(agent);
  return key === 'any' || key === 'queen' || key === 'planner';
}

function recentQuotaAgents(
  store: MemoryStore,
  repoRoot: string | undefined,
  preferredTaskId: number,
): Set<string> {
  const since = Date.now() - RECENT_RUNTIME_SIGNAL_WINDOW_MS;
  const agents = new Set<string>();
  const tasks = store.storage
    .listTasks(2000)
    .filter((task) => repoRoot === undefined || task.repo_root === repoRoot)
    .sort((a, b) => (a.id === preferredTaskId ? -1 : b.id === preferredTaskId ? 1 : 0));

  for (const task of tasks) {
    for (const row of store.storage.taskTimeline(task.id, 200)) {
      if (row.ts < since) continue;
      const meta = parseMeta(row.metadata);
      if (!isQuotaObservation(row, meta)) continue;
      const agent = readRuntimeAgent(store, task.id, row, meta);
      if (agent) agents.add(normalizeAgentKey(agent));
    }
  }
  return agents;
}

function readRuntimeAgent(
  store: MemoryStore,
  taskId: number,
  row: ObservationRow,
  meta: Record<string, unknown>,
): string | null {
  for (const key of ['from_agent', 'agent', 'claimed_by_agent']) {
    const value = meta[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return (
    store.storage.getParticipantAgent(taskId, row.session_id) ??
    store.storage.getSession(row.session_id)?.ide ??
    null
  );
}

function isQuotaObservation(row: ObservationRow, meta: Record<string, unknown>): boolean {
  const text = [
    row.kind,
    row.content,
    ...Object.values(meta).flatMap((value) =>
      typeof value === 'string'
        ? [value]
        : Array.isArray(value)
          ? value.filter((entry): entry is string => typeof entry === 'string')
          : [],
    ),
  ].join(' ');
  return /\b(quota(?:[_\s-]*exhausted|[_\s-]*exceeded|[_\s-]*hit)?|usage[_\s-]*limit|rate[_\s-]*limit|RATE_LIMIT_EXCEEDED)\b/i.test(
    text,
  );
}

function protectedFileCount(fileScope: string[]): number {
  return fileScope.filter((file) => isProtectedFile(file)).length;
}

function isProtectedFile(file: string): boolean {
  return (
    file === 'AGENTS.md' ||
    file === 'package.json' ||
    file === 'pnpm-lock.yaml' ||
    file.startsWith('.github/') ||
    file.startsWith('.githooks/') ||
    file.startsWith('openspec/') ||
    file.startsWith('scripts/') ||
    file.endsWith('/schema.ts')
  );
}

function staleBlockerCount(store: MemoryStore, taskId: number): number {
  const before = Date.now() - STALE_BLOCKER_WINDOW_MS;
  return store.storage
    .taskTimeline(taskId, 200)
    .filter((row) => row.ts <= before && isBlockerObservation(row, parseMeta(row.metadata))).length;
}

function isBlockerObservation(row: ObservationRow, meta: Record<string, unknown>): boolean {
  return (
    row.kind === 'blocker' || (row.kind === PLAN_SUBTASK_CLAIM_KIND && meta.status === 'blocked')
  );
}

function normalizeAgentKey(agent: string): string {
  return agent.toLowerCase().replace(/[_\s]+/g, '-');
}

function displayAgent(agent: string): string {
  const key = normalizeAgentKey(agent);
  if (key === 'codex') return 'Codex';
  if (key === 'claude' || key === 'claude-code') return 'Claude';
  return agent;
}

function scopeConflicts(
  store: MemoryStore,
  fileScope: string[],
  sessionId: string,
): ScopeConflict[] {
  return [...claimsForPaths(store, fileScope).entries()]
    .filter((entry): entry is [string, ClaimHolder] => {
      const holder = entry[1];
      return holder !== null && holder.session_id !== sessionId;
    })
    .map(([file_path, holder]) => ({ file_path, holder }));
}

function recentReleaseDensity(store: MemoryStore, fileScope: string[]): number {
  if (fileScope.length === 0) return 0;
  const scope = new Set(fileScope);
  const since = Date.now() - RELEASE_DENSITY_WINDOW_MS;
  let density = 0;

  for (const task of store.storage.listTasks(2000)) {
    const rows = store.storage.taskTimeline(task.id, 500);
    const subtaskScope = readInitialSubtaskScope(rows);
    for (const row of rows) {
      if (row.ts < since) continue;
      const meta = parseMeta(row.metadata);
      density += countReleasedFiles(meta, scope);
      if (row.kind === PLAN_SUBTASK_CLAIM_KIND && meta.status === 'completed') {
        density += countOverlap(subtaskScope, scope);
      }
    }
  }

  return density;
}

function readInitialSubtaskScope(rows: ObservationRow[]): string[] {
  const initial = rows.find((row) => row.kind === PLAN_SUBTASK_KIND);
  if (!initial) return [];
  const meta = parseMeta(initial.metadata);
  return readStringArray(meta.file_scope);
}

function countReleasedFiles(meta: Record<string, unknown>, scope: Set<string>): number {
  return [
    ...readStringArray(meta.released_files),
    ...readStringArray(meta.transferred_files),
  ].filter((file) => scope.has(file)).length;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : [];
}

function countOverlap(files: string[], scope: Set<string>): number {
  return files.filter((file) => scope.has(file)).length;
}

function parseMeta(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function buildReasoning(args: {
  capability_hint: string | null;
  capability_match: number;
  file_count: number;
  conflicts: ScopeConflict[];
  recent_claim_density: number;
  queen_bonus: number;
}): string {
  const capability =
    args.capability_hint === null
      ? `neutral unhinted fit (${formatScore(args.capability_match)})`
      : `${fitLabel(args.capability_match)} ${args.capability_hint} fit (${formatScore(
          args.capability_match,
        )})`;
  const scope =
    args.conflicts.length === 0
      ? 'scope clear of live claims'
      : `${args.conflicts.length} of ${args.file_count} files in scope held by ${holderSummary(
          args.conflicts,
        )}`;
  const queen = args.queen_bonus > 0 ? '; queen-published plan, +0.1 fit boost' : '';
  return `${capability}; ${scope}; recent claim density ${args.recent_claim_density}${queen}`;
}

function holderSummary(conflicts: ScopeConflict[]): string {
  const holders = [
    ...new Set(
      conflicts.map((conflict) =>
        conflict.holder.agent
          ? `${conflict.holder.agent}@${conflict.holder.session_id}`
          : conflict.holder.session_id,
      ),
    ),
  ];
  return holders.slice(0, 3).join(', ');
}

function fitLabel(score: number): string {
  if (score >= 0.75) return 'strong';
  if (score >= 0.5) return 'solid';
  return 'weak';
}

function formatScore(score: number): string {
  return score.toFixed(2);
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(1, Number(score.toFixed(3))));
}

function jsonReply(payload: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}
