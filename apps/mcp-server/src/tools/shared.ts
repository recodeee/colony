import type {
  HivemindOptions,
  HivemindSession,
  HivemindSnapshot,
  SearchResult,
} from '@colony/core';
import { TASK_THREAD_ERROR_CODES, TaskThreadError } from '@colony/core';
import type { TaskThreadErrorCode } from '@colony/core';

export interface HivemindToolOptions {
  repo_root: string | undefined;
  repo_roots: string[] | undefined;
  include_stale: boolean | undefined;
  limit: number | undefined;
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
    memory_hit_count: number;
    needs_attention_count: number;
    next_action: string;
  };
  counts: HivemindSnapshot['counts'];
  query: string;
  lanes: HivemindContextLane[];
  memory_hits: SearchResult[];
}

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
    | 'PLAN_SCOPE_OVERLAP'
    | 'PLAN_SUBTASK_NOT_FOUND'
    | 'PLAN_SUBTASK_DEPS_UNMET'
    | 'PLAN_SUBTASK_NOT_AVAILABLE'
    | 'PLAN_SUBTASK_NOT_CLAIMED'
    | 'PLAN_SUBTASK_NOT_YOURS',
  error: string,
): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify({ code, error }) }],
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
  query: string,
): HivemindContext {
  const lanes = snapshot.sessions.map(toContextLane);
  const needsAttentionCount = lanes.filter((lane) => lane.needs_attention).length;

  return {
    generated_at: snapshot.generated_at,
    repo_roots: snapshot.repo_roots,
    summary: {
      lane_count: lanes.length,
      memory_hit_count: memoryHits.length,
      needs_attention_count: needsAttentionCount,
      next_action: nextAction(lanes, memoryHits),
    },
    counts: snapshot.counts,
    query,
    lanes,
    memory_hits: memoryHits,
  };
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
  if (session.activity === 'dead') return 'dead session';
  if (session.activity === 'stalled') return 'stale telemetry';
  if (session.activity === 'unknown') return 'unknown runtime state';
  return 'none';
}

function nextAction(lanes: HivemindContextLane[], memoryHits: SearchResult[]): string {
  if (lanes.some((lane) => lane.needs_attention)) {
    return 'Inspect lanes with needs_attention before taking over or editing nearby files.';
  }
  if (lanes.length > 0 && memoryHits.length > 0) {
    return 'Use lane ownership first, then fetch only the specific memory IDs needed.';
  }
  if (lanes.length > 0) {
    return 'Use lane ownership before editing; no matching memory hit was needed.';
  }
  if (memoryHits.length > 0) {
    return 'No live lanes found; fetch only the memory IDs needed.';
  }
  return 'No live lanes or matching memory found.';
}
