import type { MemoryStore } from './memory-store.js';
import {
  MIN_CORPUS_SIZE,
  MIN_SIMILAR_TASKS_FOR_SUGGESTION,
  SIMILARITY_FLOOR,
} from './suggestion-thresholds.js';

export type TaskStatus = 'completed' | 'in-progress' | 'abandoned';

export interface SimilarTask {
  task_id: number;
  similarity: number;
  branch: string;
  repo_root: string;
  status: TaskStatus;
  observation_count: number;
}

export interface FirstFileLikelyClaimed {
  file_path: string;
  appears_in_count: number;
  confidence: number;
}

export type PatternToWatchKind =
  | 'expired-handoff'
  | 'cancelled-handoff'
  | 'plan-archive-blocked'
  | 'stalled-subtask';

export interface PatternToWatch {
  description: string;
  seen_in_task_id: number;
  kind: PatternToWatchKind;
}

export interface ResolutionHints {
  median_elapsed_minutes: number;
  median_handoff_count: number;
  median_subtask_count: number | null;
  completed_sample_size: number;
}

export interface SuggestionPayload {
  similar_tasks: SimilarTask[];
  first_files_likely_claimed: FirstFileLikelyClaimed[];
  patterns_to_watch: PatternToWatch[];
  resolution_hints: ResolutionHints | null;
  insufficient_data_reason: string | null;
}

const FIRST_CLAIM_LIMIT = 3;
const PATTERN_LIMIT = 5;
const PATTERN_DESCRIPTION_LIMIT = 100;

export function insufficientSuggestionPayload(reason: string): SuggestionPayload {
  return {
    similar_tasks: [],
    first_files_likely_claimed: [],
    patterns_to_watch: [],
    resolution_hints: null,
    insufficient_data_reason: reason,
  };
}

export function buildSuggestionPayload(
  store: MemoryStore,
  similar_tasks: SimilarTask[],
): SuggestionPayload {
  if (store.storage.listTasks(10_000).length < MIN_CORPUS_SIZE) {
    return insufficientSuggestionPayload('corpus too small');
  }

  const confidentSimilarTasks = similar_tasks.filter((task) => task.similarity >= SIMILARITY_FLOOR);
  if (confidentSimilarTasks.length < MIN_SIMILAR_TASKS_FOR_SUGGESTION) {
    return insufficientSuggestionPayload('not enough similar tasks');
  }

  return {
    similar_tasks: confidentSimilarTasks,
    first_files_likely_claimed: firstFilesLikelyClaimed(store, confidentSimilarTasks),
    patterns_to_watch: patternsToWatch(store, confidentSimilarTasks),
    resolution_hints: resolutionHints(store, confidentSimilarTasks),
    insufficient_data_reason: null,
  };
}

function firstFilesLikelyClaimed(
  store: MemoryStore,
  similarTasks: SimilarTask[],
): FirstFileLikelyClaimed[] {
  const aggregate = new Map<string, number>();

  for (const task of similarTasks) {
    const seenInTask = new Set<string>();
    const claims = store.storage
      .taskTimeline(task.task_id, 500)
      .filter((obs) => obs.kind === 'claim')
      .sort((a, b) => a.ts - b.ts);

    for (const claim of claims) {
      const metadata = parseMetadata(claim.metadata);
      const filePath = typeof metadata.file_path === 'string' ? metadata.file_path : null;
      if (!filePath || seenInTask.has(filePath)) continue;
      seenInTask.add(filePath);
      aggregate.set(filePath, (aggregate.get(filePath) ?? 0) + 1);
      if (seenInTask.size >= FIRST_CLAIM_LIMIT) break;
    }
  }

  const total = similarTasks.length;
  return Array.from(aggregate, ([file_path, appears_in_count]) => ({
    file_path,
    appears_in_count,
    confidence: wilsonLowerBound(appears_in_count, total),
  })).sort((a, b) => {
    if (b.appears_in_count !== a.appears_in_count) {
      return b.appears_in_count - a.appears_in_count;
    }
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return a.file_path.localeCompare(b.file_path);
  });
}

function patternsToWatch(store: MemoryStore, similarTasks: SimilarTask[]): PatternToWatch[] {
  const patterns: PatternToWatch[] = [];

  for (const task of similarTasks) {
    const observations = store.storage.taskTimeline(task.task_id, 500).sort((a, b) => a.ts - b.ts);
    for (const observation of observations) {
      const kind = patternKind(observation.kind, observation.metadata);
      if (!kind) continue;
      patterns.push({
        description: truncate(observation.content.replace(/\s+/g, ' ').trim()),
        seen_in_task_id: task.task_id,
        kind,
      });
      if (patterns.length >= PATTERN_LIMIT) return patterns;
    }
  }

  return patterns;
}

function patternKind(kind: string, metadataRaw: string | null): PatternToWatchKind | null {
  if (
    kind === 'expired-handoff' ||
    kind === 'cancelled-handoff' ||
    kind === 'plan-archive-blocked' ||
    kind === 'stalled-subtask'
  ) {
    return kind;
  }

  if (kind !== 'handoff') return null;
  const metadata = parseMetadata(metadataRaw);
  if (metadata.status === 'expired') return 'expired-handoff';
  if (metadata.status === 'cancelled') return 'cancelled-handoff';
  return null;
}

function resolutionHints(store: MemoryStore, similarTasks: SimilarTask[]): ResolutionHints | null {
  const completed = similarTasks.filter((task) => task.status === 'completed');
  if (completed.length < 2) return null;

  const elapsedMinutes: number[] = [];
  const handoffCounts: number[] = [];
  const subtaskCounts: number[] = [];

  for (const task of completed) {
    const observations = store.storage.taskTimeline(task.task_id, 1000);
    if (observations.length === 0) continue;

    const timestamps = observations.map((obs) => obs.ts);
    const first = Math.min(...timestamps);
    const last = Math.max(...timestamps);
    elapsedMinutes.push(Math.max(0, (last - first) / 60_000));
    handoffCounts.push(observations.filter((obs) => obs.kind === 'handoff').length);

    const subtaskCount = observations.filter((obs) => obs.kind === 'plan-subtask').length;
    if (subtaskCount > 0) subtaskCounts.push(subtaskCount);
  }

  return {
    median_elapsed_minutes: median(elapsedMinutes),
    median_handoff_count: median(handoffCounts),
    median_subtask_count: subtaskCounts.length > 0 ? median(subtaskCounts) : null,
    completed_sample_size: completed.length,
  };
}

function wilsonLowerBound(positive: number, total: number): number {
  if (total <= 0) return 0;
  const z = 1.0;
  const p = positive / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const center = p + z2 / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);
  return roundConfidence((center - margin) / denominator);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function parseMetadata(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function truncate(value: string): string {
  if (value.length <= PATTERN_DESCRIPTION_LIMIT) return value;
  return value.slice(0, PATTERN_DESCRIPTION_LIMIT);
}

function roundConfidence(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(3))));
}
