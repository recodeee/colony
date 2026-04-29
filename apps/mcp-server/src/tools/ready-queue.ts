import {
  type AgentProfile,
  type ClaimHolder,
  type MemoryStore,
  type SubtaskInfo,
  claimsForPaths,
  listMessagesForAgent,
  listPlans,
  loadProfile,
  rankCandidates,
} from '@colony/core';
import type { ObservationRow } from '@colony/storage';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { type ToolContext, defaultWrapHandler } from './context.js';
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
const PLAN_SUBTASK_KIND = 'plan-subtask';
const PLAN_SUBTASK_CLAIM_KIND = 'plan-subtask-claim';
export const NO_CLAIMABLE_PLAN_SUBTASKS_EMPTY_STATE =
  'No claimable plan subtasks. Publish a Queen/task plan for multi-agent work, or use task_list only for browsing.';
export const NO_PLAN_NEXT_ACTION = 'Publish a Queen/task plan for multi-agent work.';
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
  next_tool?: 'task_plan_claim_subtask';
  next_action_reason?: string;
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

export interface ReadyForAgentResult {
  ready: ReadySubtaskWithWarnings[];
  total_available: number;
  next_action: string;
  next_tool?: 'task_plan_claim_subtask' | 'rescue_stranded_scan';
  plan_slug?: string;
  subtask_index?: number;
  reason?: ReadyReason;
  assigned_agent?: string;
  routing_reason?: string;
  claim_args?: TaskPlanClaimArgs;
  rescue_candidate?: StaleBlockerRescueCandidate;
  rescue_args?: { stranded_after_minutes: number };
  codex_mcp_call?: string;
  next_action_reason?: string;
  empty_state?: string;
}

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
    'Find the next task to claim for this agent. Use this when deciding what to work on. Returns exact task_plan_claim_subtask args when work is claimable, or a compact empty_state when no plan sub-tasks can be claimed.',
    {
      session_id: z.string().min(1),
      agent: z.string().min(1),
      repo_root: z.string().min(1).optional(),
      limit: z.number().int().positive().max(20).optional(),
    },
    wrapHandler('task_ready_for_agent', async ({ session_id, agent, repo_root, limit }) => {
      return jsonReply(
        await buildReadyForAgent(store, {
          session_id,
          agent,
          ...(repo_root !== undefined ? { repo_root } : {}),
          ...(limit !== undefined ? { limit } : {}),
        }),
      );
    }),
  );
}

export async function buildReadyForAgent(
  store: MemoryStore,
  args: { session_id: string; agent: string; repo_root?: string; limit?: number },
): Promise<ReadyForAgentResult> {
  const plans = listPlans(store, {
    ...(args.repo_root !== undefined ? { repo_root: args.repo_root } : {}),
    limit: 2000,
  });
  const profile = loadProfile(store.storage, args.agent);
  const tasksById = new Map(
    store.storage
      .listTasks(2000)
      .map((t) => [t.id, { created_at: t.created_at, created_by: t.created_by }]),
  );
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
  const ranked = rankForSelection(
    available.map((task) =>
      urgentTaskIds.has(task.task_id) ? { ...task, reason: 'urgent_override' } : task,
    ),
    currentClaims,
  ).map((task) => applyRuntimeRouting(store, task, args.agent, args.repo_root));

  const selected = ranked.slice(0, args.limit ?? DEFAULT_LIMIT);
  const claimable = ranked.find((task) => !task.current_claim) ?? null;
  const ready = await Promise.all(
    selected.map(
      async ({
        created_at: _createdAt,
        task_id: _taskId,
        claim_ts: _claimTs,
        current_claim: _currentClaim,
        ...entry
      }) => {
        const claimMetadata = _currentClaim
          ? {}
          : {
              next_tool: 'task_plan_claim_subtask' as const,
              next_action_reason: claimReason(entry),
            };
        return {
          ...entry,
          ...claimMetadata,
          negative_warnings: await readyNegativeWarnings(store, entry),
        };
      },
    ),
  );

  return buildReadyResult(
    { ready, total_available: available.length },
    claimable,
    args,
    plans.length > 0,
    available.length === 0 ? staleBlockerRescueCandidate(plans) : null,
  );
}

function buildReadyResult(
  base: Pick<ReadyForAgentResult, 'ready' | 'total_available'>,
  claimable: RankedSubtask | null,
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

function readyNextAction(
  ready: ReadySubtaskWithWarnings[],
  args: { session_id: string; agent: string },
): string {
  const top = ready[0];
  if (!top) {
    return 'No ready plan sub-tasks; publish claimable work with queen_plan_goal or task_plan_publish, or complete upstream dependencies.';
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
  plans: Array<{ plan_slug: string; subtasks: SubtaskInfo[] }>,
): StaleBlockerRescueCandidate | null {
  const now = Date.now();
  const candidates: StaleBlockerRescueCandidate[] = [];
  for (const plan of plans) {
    for (const subtask of plan.subtasks.filter((entry) => isStaleClaimedSubtask(entry, now))) {
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

function applyRuntimeRouting(
  store: MemoryStore,
  task: RankedSubtask,
  requestedAgent: string,
  repoRoot: string | undefined,
): RankedSubtask {
  if (task.current_claim) return task;

  const signal = runtimeRoutingSignal(store, task, requestedAgent, repoRoot);
  if (!signal.shouldRouteAway) {
    return { ...task, assigned_agent: requestedAgent, routing_reason: signal.reason };
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
    ? value.filter((entry): entry is string => typeof entry === 'string')
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
