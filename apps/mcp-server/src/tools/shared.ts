import { resolve } from 'node:path';
import type {
  AttentionInbox,
  HivemindOptions,
  HivemindSession,
  HivemindSnapshot,
  MemoryStore,
  SearchResult,
} from '@colony/core';
import {
  type ClaimAgeClass,
  type ClaimOwnershipStrength,
  NEGATIVE_COORDINATION_KINDS,
  PheromoneSystem,
  TASK_THREAD_ERROR_CODES,
  TaskThreadError,
  classifyClaimAge,
  isNegativeCoordinationKind,
  isStrongClaimAge,
} from '@colony/core';
import type { TaskThreadErrorCode } from '@colony/core';

export interface HivemindToolOptions {
  repo_root: string | undefined;
  repo_roots: string[] | undefined;
  include_stale: boolean | undefined;
  limit: number | undefined;
}

export interface HivemindContextBuildOptions {
  maxClaims?: number;
  maxHotFiles?: number;
  attention?: HivemindContextAttentionInput;
  localContext?: HivemindLocalContext;
  readyWorkCount?: number;
  adoptionNudges?: HivemindAdoptionNudge[];
}

export interface HivemindContextAttentionInput {
  session_id: string;
  agent: string;
  summary: AttentionInbox['summary'];
  observation_ids: number[];
  observation_ids_truncated: boolean;
}

export type HivemindAdoptionNudgeKey =
  | 'task_list_overuse'
  | 'notepad_overuse'
  | 'claim_before_edit_low';

export interface HivemindAdoptionNudge {
  key: HivemindAdoptionNudgeKey;
  tool: 'task_ready_for_agent' | 'task_note_working' | 'task_claim_file';
  current: string;
  hint: string;
}

export interface HivemindContextLane {
  repo_root: string;
  branch: string;
  task: string;
  owner: string;
  activity: HivemindSession['activity'];
  activity_summary: string;
  needs_attention: boolean;
  risk: string;
  source: HivemindSession['source'];
  worktree_path: string;
  updated_at: string;
  elapsed_seconds: number;
  locked_file_count: number;
  locked_file_preview: string[];
}

export interface HivemindContext {
  generated_at: string;
  repo_roots: string[];
  summary: {
    lane_count: number;
    total_lane_count: number;
    lanes_truncated: boolean;
    memory_hit_count: number;
    negative_warning_count: number;
    needs_attention_count: number;
    claim_count: number;
    hot_file_count: number;
    next_action: string;
    suggested_tools: string[];
    must_check_attention: boolean;
    attention_hint: string;
    ready_work_hint: string;
    unread_message_count: number;
    pending_handoff_count: number;
    blocking: boolean;
    ready_work_count?: number;
    adoption_nudges: HivemindAdoptionNudge[];
    attention_counts: HivemindContextAttentionCounts;
    state_tool_replacements: Record<string, string[]>;
  };
  counts: HivemindSnapshot['counts'];
  query: string;
  lanes: HivemindContextLane[];
  ownership: HivemindContextOwnership;
  attention: HivemindContextAttention;
  local_context: HivemindLocalContext | null;
  memory_hits: SearchResult[];
  negative_warnings: CompactNegativeWarning[];
}

export interface HivemindLocalTask {
  id: number;
  title: string;
  repo_root: string;
  branch: string;
  status: string;
  created_by: string;
  updated_at: number;
}

export interface HivemindLocalClaim {
  task_id: number;
  file_path: string;
  by_session_id: string;
  claimed_at: number;
  age_minutes: number;
  age_class: ClaimAgeClass;
  ownership_strength: ClaimOwnershipStrength;
  yours: boolean;
}

export interface HivemindLocalPheromoneTrail {
  file_path: string;
  total_strength: number;
  by_session: Array<{ session_id: string; strength: number }>;
}

export interface HivemindLocalContext {
  mode: 'local';
  session_id: string;
  requested_task_id: number | null;
  files: string[];
  current_task: HivemindLocalTask | null;
  claims: HivemindLocalClaim[];
  claims_truncated: boolean;
  pheromone_trails: HivemindLocalPheromoneTrail[];
  pheromone_trails_truncated: boolean;
  negative_pheromones: CompactNegativeWarning[];
  memory_hits: SearchResult[];
  attention: HivemindContextAttention;
  ready_next_action: string;
  hydration: string;
}

export interface CompactNegativeWarning {
  id: number;
  kind: string;
  session_id: string;
  snippet: string;
  ts: number;
  task_id: number | null;
}

export interface HivemindContextClaim {
  file_path: string;
  branch: string;
  owner: string;
  source: HivemindSession['source'];
  worktree_path: string;
}

export interface HivemindContextHotFile {
  file_path: string;
  claim_count: number;
  branches: string[];
  owners: string[];
}

export interface HivemindContextOwnership {
  claim_count: number;
  claims: HivemindContextClaim[];
  claims_truncated: boolean;
  hot_files: HivemindContextHotFile[];
  hot_files_truncated: boolean;
}

export interface HivemindContextAttention {
  session_id: string | null;
  agent: string | null;
  unread_messages: number;
  pending_handoffs: number;
  pending_wakes: number;
  blocking: boolean;
  stale_claims: number;
  expired_claims: number;
  weak_claims: number;
  stalled_lanes: number;
  counts: HivemindContextAttentionCounts;
  observation_ids: number[];
  observation_ids_truncated: boolean;
  hydration: string;
  hydrate_with: string;
  next_action: string;
}

export interface HivemindContextAttentionCounts {
  lane_needs_attention_count: number;
  pending_handoff_count: number;
  pending_wake_count: number;
  unread_message_count: number;
  stalled_lane_count: number;
  recent_other_claim_count: number;
  fresh_other_claim_count: number;
  stale_other_claim_count: number;
  expired_other_claim_count: number;
  weak_other_claim_count: number;
  blocked: boolean;
}

const HIVEMIND_FUNNEL_NEXT_ACTION =
  'Do not choose work yet. Call attention_inbox, then task_ready_for_agent.';
const HIVEMIND_SUGGESTED_TOOLS = ['attention_inbox', 'task_ready_for_agent'];
const HIVEMIND_ATTENTION_HINT =
  'Call attention_inbox to review pending handoffs, unread messages, blockers, and stalled lanes before claiming work.';
const HIVEMIND_READY_WORK_HINT =
  'Then call task_ready_for_agent to choose claimable work. Use task_list only for browsing/debugging.';
const STATE_TOOL_REPLACEMENTS = {
  state_get_status: ['hivemind_context', 'attention_inbox'],
  state_list_active: ['hivemind_context'],
  state_write: ['task_note_working', 'task_post'],
  state_read: ['task_timeline', 'get_observations'],
  state_clear: ['task_message_mark_read', 'attention_inbox'],
};

export function toHivemindOptions(input: HivemindToolOptions): HivemindOptions {
  const options: HivemindOptions = {};
  if (input.repo_root !== undefined) options.repoRoot = input.repo_root;
  if (input.repo_roots !== undefined) options.repoRoots = input.repo_roots;
  if (input.include_stale !== undefined) options.includeStale = input.include_stale;
  if (input.limit !== undefined) options.limit = input.limit;
  return options;
}

export function mcpError(err: unknown): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} {
  const error = err instanceof Error ? err.message : String(err);
  const code =
    err instanceof TaskThreadError ? err.code : TASK_THREAD_ERROR_CODES.OBSERVATION_NOT_ON_TASK;
  return {
    content: [{ type: 'text', text: JSON.stringify({ code, error }) }],
    isError: true,
  };
}

export function mcpErrorResponse(
  code:
    | TaskThreadErrorCode
    | 'SPEC_TASK_NOT_FOUND'
    | 'SPEC_CHANGE_NOT_FOUND'
    | 'PLAN_INVALID_DEPENDENCY'
    | 'PLAN_INVALID_WAVE_DEPENDENCY'
    | 'PLAN_SCOPE_OVERLAP'
    | 'PLAN_WAVE_SCOPE_OVERLAP'
    | 'PLAN_FINALIZER_NOT_LAST'
    | 'PLAN_SUBTASK_NOT_FOUND'
    | 'PLAN_SUBTASK_DEPS_UNMET'
    | 'PLAN_SUBTASK_NOT_AVAILABLE'
    | 'PLAN_SUBTASK_NOT_CLAIMED'
    | 'PLAN_SUBTASK_NOT_YOURS'
    | 'QUEEN_INVALID_GOAL'
    | 'RESCUE_CONFIRM_REQUIRED'
    | 'SESSION_NOT_FOUND'
    | 'SPEC_ARCHIVE_CONFLICT'
    | 'TASK_LINK_SELF',
  error: string,
  details: Record<string, unknown> = {},
): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify({ code, error, ...details }) }],
    isError: true,
  };
}

export function buildContextQuery(query: string | undefined, sessions: HivemindSession[]): string {
  if (query?.trim()) return query.trim();
  const taskText = sessions
    .flatMap((session) => [
      session.task,
      session.task_name,
      session.routing_reason,
      ...session.locked_file_preview,
    ])
    .map((entry) => entry.trim())
    .filter(Boolean);
  return [...new Set(taskText)].join(' ').slice(0, 800);
}

export function buildHivemindContext(
  snapshot: HivemindSnapshot,
  memoryHits: SearchResult[],
  negativeWarnings: CompactNegativeWarning[],
  query: string,
  options: HivemindContextBuildOptions = {},
): HivemindContext {
  const lanes = snapshot.sessions.map(toContextLane);
  const needsAttentionCount = lanes.filter((lane) => lane.needs_attention).length;
  const ownership = buildOwnership(lanes, options.maxClaims, options.maxHotFiles);
  const attention = buildAttention(needsAttentionCount, options.attention);
  const localContext = options.localContext ?? null;
  const adoptionNudges = options.adoptionNudges ?? [];

  return {
    generated_at: snapshot.generated_at,
    repo_roots: snapshot.repo_roots,
    summary: {
      lane_count: lanes.length,
      total_lane_count: snapshot.session_count,
      lanes_truncated: snapshot.session_count > lanes.length,
      memory_hit_count: memoryHits.length,
      negative_warning_count: negativeWarnings.length,
      needs_attention_count: needsAttentionCount,
      claim_count: ownership.claim_count,
      hot_file_count: ownership.hot_files.length,
      next_action: localContext?.ready_next_action ?? HIVEMIND_FUNNEL_NEXT_ACTION,
      suggested_tools: [
        ...new Set([...HIVEMIND_SUGGESTED_TOOLS, ...adoptionNudges.map((nudge) => nudge.tool)]),
      ],
      must_check_attention: true,
      attention_hint: HIVEMIND_ATTENTION_HINT,
      ready_work_hint: HIVEMIND_READY_WORK_HINT,
      unread_message_count: attention.counts.unread_message_count,
      pending_handoff_count: attention.counts.pending_handoff_count,
      blocking: attention.counts.blocked,
      ...(options.readyWorkCount !== undefined ? { ready_work_count: options.readyWorkCount } : {}),
      adoption_nudges: adoptionNudges,
      attention_counts: attention.counts,
      state_tool_replacements: STATE_TOOL_REPLACEMENTS,
    },
    counts: snapshot.counts,
    query,
    lanes,
    ownership,
    attention,
    local_context: localContext,
    memory_hits: memoryHits,
    negative_warnings: negativeWarnings,
  };
}

export function resolveLocalContextTask(
  store: MemoryStore,
  input: { repoRoot?: string; sessionId: string; taskId?: number; files?: string[] },
): HivemindLocalTask | null {
  if (input.taskId !== undefined) return compactLocalTask(store, input, input.taskId);

  const fileScopedTask = findFileScopedLocalTask(store, input);
  if (fileScopedTask) return fileScopedTask;

  const taskId = store.storage.findActiveTaskForSession(input.sessionId);
  if (taskId === undefined) return null;
  return compactLocalTask(store, input, taskId);
}

function compactLocalTask(
  store: MemoryStore,
  input: { repoRoot?: string },
  taskId: number,
): HivemindLocalTask | null {
  const task = store.storage.getTask(taskId);
  if (!task) return null;
  if (input.repoRoot && resolve(task.repo_root) !== resolve(input.repoRoot)) return null;
  return {
    id: task.id,
    title: task.title,
    repo_root: task.repo_root,
    branch: task.branch,
    status: task.status,
    created_by: task.created_by,
    updated_at: task.updated_at,
  };
}

function findFileScopedLocalTask(
  store: MemoryStore,
  input: { repoRoot?: string; sessionId: string; files?: string[] },
): HivemindLocalTask | null {
  const files = normalizeFiles(input.files ?? []);
  if (files.length === 0) return null;
  const repoRoot = input.repoRoot ? resolve(input.repoRoot) : null;
  const task = store.storage
    .listTasks(200)
    .filter((candidate) => {
      if (repoRoot && resolve(candidate.repo_root) !== repoRoot) return false;
      if (store.storage.getParticipantAgent(candidate.id, input.sessionId) === undefined) {
        return false;
      }
      return files.some((file) => {
        const claim = store.storage.getClaim(candidate.id, file);
        if (!claim) return false;
        const age = classifyClaimAge(claim.claimed_at, {
          claim_stale_minutes: store.settings.claimStaleMinutes,
        });
        return isStrongClaimAge(age);
      });
    })
    .sort((a, b) => b.updated_at - a.updated_at)[0];
  return task ? compactLocalTask(store, input, task.id) : null;
}

export function buildLocalContextQuery(input: {
  query: string | undefined;
  currentTask: HivemindLocalTask | null;
  files: string[];
  sessions: HivemindSession[];
}): string {
  if (input.query?.trim()) return input.query.trim();
  const taskTokens = input.currentTask
    ? [input.currentTask.title, input.currentTask.branch, ...input.files]
    : [];
  const sessionTokens = buildContextQuery(undefined, input.sessions);
  return [...taskTokens, sessionTokens]
    .map((entry) => entry.trim())
    .filter(Boolean)
    .join(' ')
    .slice(0, 800);
}

export function buildHivemindLocalContext(
  store: MemoryStore,
  input: {
    sessionId: string;
    requestedTaskId?: number;
    files: string[];
    currentTask: HivemindLocalTask | null;
    memoryHits: SearchResult[];
    negativeWarnings: CompactNegativeWarning[];
    attention: HivemindContextAttention;
    maxClaims?: number;
    maxHotFiles?: number;
  },
): HivemindLocalContext {
  const files = normalizeFiles(input.files);
  const claims = input.currentTask
    ? localClaims(store, {
        taskId: input.currentTask.id,
        sessionId: input.sessionId,
        files,
        limit: input.maxClaims ?? 12,
      })
    : { rows: [], truncated: false };
  const trails = input.currentTask
    ? localPheromoneTrails(store, {
        taskId: input.currentTask.id,
        files,
        limit: input.maxHotFiles ?? 8,
      })
    : { rows: [], truncated: false };

  return {
    mode: 'local',
    session_id: input.sessionId,
    requested_task_id: input.requestedTaskId ?? null,
    files,
    current_task: input.currentTask,
    claims: claims.rows,
    claims_truncated: claims.truncated,
    pheromone_trails: trails.rows,
    pheromone_trails_truncated: trails.truncated,
    negative_pheromones: input.negativeWarnings,
    memory_hits: input.memoryHits,
    attention: input.attention,
    ready_next_action: localNextAction({
      sessionId: input.sessionId,
      currentTask: input.currentTask,
      files,
      claims: claims.rows,
      pheromoneTrails: trails.rows,
      negativeWarnings: input.negativeWarnings,
      attention: input.attention,
    }),
    hydration: 'Use get_observations with memory, negative_pheromone, or attention IDs for bodies.',
  };
}

export async function searchNegativeWarnings(
  store: MemoryStore,
  query: string,
  limit = 3,
): Promise<CompactNegativeWarning[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const results = await Promise.all(
    NEGATIVE_COORDINATION_KINDS.map((kind) => store.search(trimmed, limit, undefined, { kind })),
  );
  const byId = new Map<number, SearchResult>();
  for (const hit of results.flat()) {
    if (!isNegativeCoordinationKind(hit.kind)) continue;
    const current = byId.get(hit.id);
    if (
      !current ||
      hit.score > current.score ||
      (hit.score === current.score && hit.ts > current.ts)
    ) {
      byId.set(hit.id, hit);
    }
  }
  return Array.from(byId.values())
    .sort((a, b) => b.score - a.score || b.ts - a.ts)
    .slice(0, limit)
    .map((hit) => ({
      id: hit.id,
      kind: hit.kind,
      session_id: hit.session_id,
      snippet: hit.snippet,
      ts: hit.ts,
      task_id: hit.task_id,
    }));
}

function normalizeFiles(files: string[]): string[] {
  return [...new Set(files.map((file) => file.trim()).filter(Boolean))];
}

function localClaims(
  store: MemoryStore,
  input: { taskId: number; sessionId: string; files: string[]; limit: number },
): { rows: HivemindLocalClaim[]; truncated: boolean } {
  const claims =
    input.files.length > 0
      ? input.files.flatMap((filePath) => {
          const claim = store.storage.getClaim(input.taskId, filePath);
          return claim ? [claim] : [];
        })
      : store.storage.listClaims(input.taskId);
  const classified = claims.map((claim) => {
    const age = classifyClaimAge(claim.claimed_at, {
      claim_stale_minutes: store.settings.claimStaleMinutes,
    });
    return { claim, age };
  });
  const sorted = classified.sort((a, b) => {
    const strengthDelta = Number(isStrongClaimAge(b.age)) - Number(isStrongClaimAge(a.age));
    return strengthDelta || b.claim.claimed_at - a.claim.claimed_at;
  });
  return {
    rows: sorted.slice(0, input.limit).map(({ claim, age }) => ({
      task_id: claim.task_id,
      file_path: claim.file_path,
      by_session_id: claim.session_id,
      claimed_at: claim.claimed_at,
      age_minutes: age.age_minutes,
      age_class: age.age_class,
      ownership_strength: age.ownership_strength,
      yours: claim.session_id === input.sessionId,
    })),
    truncated: sorted.length > input.limit,
  };
}

function localPheromoneTrails(
  store: MemoryStore,
  input: { taskId: number; files: string[]; limit: number },
): { rows: HivemindLocalPheromoneTrail[]; truncated: boolean } {
  const pheromones = new PheromoneSystem(store.storage);
  const trails =
    input.files.length > 0
      ? input.files.flatMap((filePath) => {
          const sniffed = pheromones.sniff({ task_id: input.taskId, file_path: filePath });
          if (sniffed.total < 0.1) return [];
          return [
            {
              file_path: filePath,
              total_strength: roundStrength(sniffed.total),
              by_session: sniffed.bySession
                .filter((entry) => entry.strength >= 0.1)
                .sort((a, b) => b.strength - a.strength)
                .map((entry) => ({
                  session_id: entry.session_id,
                  strength: roundStrength(entry.strength),
                })),
            },
          ];
        })
      : pheromones.strongestTrails(input.taskId).map((trail) => ({
          file_path: trail.file_path,
          total_strength: roundStrength(trail.total_strength),
          by_session: trail.bySession.map((entry) => ({
            session_id: entry.session_id,
            strength: roundStrength(entry.strength),
          })),
        }));
  const sorted = trails.sort((a, b) => b.total_strength - a.total_strength);
  return { rows: sorted.slice(0, input.limit), truncated: sorted.length > input.limit };
}

function roundStrength(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function localNextAction(input: {
  sessionId: string;
  currentTask: HivemindLocalTask | null;
  files: string[];
  claims: HivemindLocalClaim[];
  pheromoneTrails: HivemindLocalPheromoneTrail[];
  negativeWarnings: CompactNegativeWarning[];
  attention: HivemindContextAttention;
}): string {
  if (
    input.attention.counts.blocked ||
    input.attention.counts.pending_handoff_count > 0 ||
    input.attention.counts.pending_wake_count > 0
  ) {
    return input.attention.next_action;
  }
  const otherClaims = input.claims.filter(
    (claim) => !claim.yours && claim.ownership_strength === 'strong',
  );
  if (otherClaims.length > 0) {
    return 'Coordinate before editing: another session claims one of these local files.';
  }
  if (input.negativeWarnings.length > 0) {
    return 'Review negative pheromones before repeating a known failed path.';
  }
  const otherTrails = input.pheromoneTrails.filter((trail) =>
    trail.by_session.some((entry) => entry.session_id !== input.sessionId),
  );
  if (otherTrails.length > 0) {
    return 'Recent edit pheromones touch these files; coordinate if you will edit the same surface.';
  }
  if (!input.currentTask) {
    return 'No current local task found; call task_ready_for_agent before claiming files.';
  }
  if (input.files.length > 0) {
    return 'No local blockers found; claim these files before editing.';
  }
  return 'No local blockers found; continue the current task or call task_ready_for_agent for the next claim.';
}

function toContextLane(session: HivemindSession): HivemindContextLane {
  const risk = laneRisk(session);
  return {
    repo_root: session.repo_root,
    branch: session.branch,
    task: session.task,
    owner: `${session.agent}/${session.cli}`,
    activity: session.activity,
    activity_summary: session.activity_summary,
    needs_attention: risk !== 'none',
    risk,
    source: session.source,
    worktree_path: session.worktree_path,
    updated_at: session.updated_at,
    elapsed_seconds: session.elapsed_seconds,
    locked_file_count: session.locked_file_count,
    locked_file_preview: session.locked_file_preview,
  };
}

function laneRisk(session: HivemindSession): string {
  if (session.source === 'managed-worktree') return 'stranded lane';
  if (session.activity === 'dead') return 'dead session';
  if (session.activity === 'stalled') return 'stale telemetry';
  if (session.activity === 'unknown') return 'unknown runtime state';
  return 'none';
}

function buildOwnership(
  lanes: HivemindContextLane[],
  maxClaims = 12,
  maxHotFiles = 8,
): HivemindContextOwnership {
  const claims = lanes.flatMap((lane) =>
    lane.locked_file_preview.map((filePath) => ({
      file_path: filePath,
      branch: lane.branch,
      owner: lane.owner,
      source: lane.source,
      worktree_path: lane.worktree_path,
    })),
  );
  const claimCount = lanes.reduce((total, lane) => total + lane.locked_file_count, 0);
  const allHotFiles = buildHotFiles(claims);
  const hotFiles = allHotFiles.slice(0, maxHotFiles);

  return {
    claim_count: claimCount,
    claims: claims.slice(0, maxClaims),
    claims_truncated: claimCount > Math.min(claims.length, maxClaims),
    hot_files: hotFiles,
    hot_files_truncated: allHotFiles.length > hotFiles.length,
  };
}

function buildHotFiles(claims: HivemindContextClaim[]): HivemindContextHotFile[] {
  const byFile = new Map<
    string,
    { claim_count: number; branches: Set<string>; owners: Set<string> }
  >();
  for (const claim of claims) {
    const entry = byFile.get(claim.file_path) ?? {
      claim_count: 0,
      branches: new Set<string>(),
      owners: new Set<string>(),
    };
    entry.claim_count += 1;
    entry.branches.add(claim.branch);
    entry.owners.add(claim.owner);
    byFile.set(claim.file_path, entry);
  }

  return [...byFile.entries()]
    .map(([file_path, entry]) => ({
      file_path,
      claim_count: entry.claim_count,
      branches: [...entry.branches].sort(),
      owners: [...entry.owners].sort(),
    }))
    .sort((left, right) => {
      const countDelta = right.claim_count - left.claim_count;
      return countDelta !== 0 ? countDelta : left.file_path.localeCompare(right.file_path);
    });
}

function buildAttention(
  laneNeedsAttentionCount: number,
  input: HivemindContextAttentionInput | undefined,
): HivemindContextAttention {
  const counts: HivemindContextAttentionCounts = {
    lane_needs_attention_count: laneNeedsAttentionCount,
    pending_handoff_count: input?.summary.pending_handoff_count ?? 0,
    pending_wake_count: input?.summary.pending_wake_count ?? 0,
    unread_message_count: input?.summary.unread_message_count ?? 0,
    stalled_lane_count: Math.max(input?.summary.stalled_lane_count ?? 0, laneNeedsAttentionCount),
    recent_other_claim_count: input?.summary.recent_other_claim_count ?? 0,
    fresh_other_claim_count: input?.summary.fresh_other_claim_count ?? 0,
    stale_other_claim_count: input?.summary.stale_other_claim_count ?? 0,
    expired_other_claim_count: input?.summary.expired_other_claim_count ?? 0,
    weak_other_claim_count: input?.summary.weak_other_claim_count ?? 0,
    blocked: input?.summary.blocked ?? false,
  };

  return {
    session_id: input?.session_id ?? null,
    agent: input?.agent ?? null,
    unread_messages: counts.unread_message_count,
    pending_handoffs: counts.pending_handoff_count,
    pending_wakes: counts.pending_wake_count,
    blocking: counts.blocked,
    stale_claims: counts.stale_other_claim_count,
    expired_claims: counts.expired_other_claim_count,
    weak_claims: counts.weak_other_claim_count,
    stalled_lanes: counts.stalled_lane_count,
    counts,
    observation_ids: input?.observation_ids ?? [],
    observation_ids_truncated: input?.observation_ids_truncated ?? false,
    hydration:
      'Hydrate with attention_inbox; call get_observations with observation_ids only for bodies.',
    hydrate_with: 'attention_inbox',
    next_action: input?.summary.next_action ?? '',
  };
}
