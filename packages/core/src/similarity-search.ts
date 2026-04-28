import type { Embedder, MemoryStore } from './memory-store.js';
import { ABANDONED_TASK_DAYS, SUGGESTION_THRESHOLDS } from './suggestion-thresholds.js';
import { getOrComputeTaskEmbedding } from './task-embeddings.js';

export type TaskStatus = 'completed' | 'in-progress' | 'abandoned';

export interface SimilarTask {
  task_id: number;
  similarity: number;
  branch: string;
  repo_root: string;
  status: TaskStatus;
  observation_count: number;
}

export interface FindSimilarOptions {
  // Scope to a single repo. Omit to search across all repos.
  repo_root?: string;
  // Minimum cosine similarity. Default SIMILARITY_FLOOR (0.5).
  min_similarity?: number;
  // Max results. Default 10.
  limit?: number;
  // Exclude these task IDs from results (e.g. the current task itself —
  // without exclusion, calling from inside an existing task would always
  // return the task itself as the top match).
  exclude_task_ids?: number[];
}

// Find tasks whose embedding vectors are most similar to the query
// vector. Naive linear scan — acceptable for corpora under ~10k tasks
// (the realistic ceiling). Add HNSW later if and when it ever becomes
// hot, with measured latency motivating the change.
export function findSimilarTasks(
  store: MemoryStore,
  embedder: Embedder,
  query_embedding: Float32Array,
  options: FindSimilarOptions = {},
): SimilarTask[] {
  const minSim = options.min_similarity ?? SUGGESTION_THRESHOLDS.SIMILARITY_FLOOR;
  const limit = options.limit ?? 10;
  const excludeSet = new Set(options.exclude_task_ids ?? []);

  const allTasks = store.storage.listTasks(10_000);
  const scoped = options.repo_root
    ? allTasks.filter((t) => t.repo_root === options.repo_root)
    : allTasks;

  const scored: SimilarTask[] = [];
  for (const task of scoped) {
    if (excludeSet.has(task.id)) continue;
    const taskVec = getOrComputeTaskEmbedding(store, task.id, embedder);
    if (!taskVec) continue;
    const sim = cosineSimilarity(query_embedding, taskVec);
    if (sim < minSim) continue;
    scored.push({
      task_id: task.id,
      similarity: sim,
      branch: task.branch,
      repo_root: task.repo_root,
      status: classifyStatus(store, task.id),
      observation_count: store.storage.countTaskObservations(task.id),
    });
  }

  return scored.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
}

// Both vectors are pre-normalized (computeTaskEmbedding returns unit
// length, and the embedder's outputs should match the same convention),
// so cosine similarity is just the dot product. We still guard against
// dimension mismatch — an embedding-model switch mid-corpus could leave
// stale vectors of the wrong length cached.
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return dot;
}

// Classify a task by its observation pattern:
//   - `completed` when an archived-plan observation exists for the task,
//     OR the most recent observation is an accepted handoff (the agent
//     handed the work off and someone accepted it).
//   - `abandoned` when the most recent observation is older than
//     ABANDONED_TASK_DAYS days — long silence is the strongest signal
//     a lane stalled.
//   - `in-progress` in every other case.
//
// The classification feeds directly into the suggestion payload so
// callers can tell "similar to a task that completed in 35m" from
// "similar to a task that was abandoned after 3h" — the second is a
// signal to read the timeline before starting.
export function classifyStatus(store: MemoryStore, task_id: number): TaskStatus {
  const observations = store.storage.taskTimeline(task_id, 200);
  if (observations.length === 0) return 'in-progress';

  for (const obs of observations) {
    if (obs.kind === 'plan-archived') return 'completed';
  }

  // taskTimeline returns DESC by ts, so the first row is the most
  // recent observation.
  const latest = observations[0];
  if (latest && latest.kind === 'handoff') {
    const meta = parseMeta(latest.metadata);
    if (meta.status === 'accepted') return 'completed';
  }

  const ageMs = Date.now() - (latest?.ts ?? 0);
  const abandonedThresholdMs = ABANDONED_TASK_DAYS * 24 * 60 * 60 * 1000;
  if (ageMs > abandonedThresholdMs) return 'abandoned';

  return 'in-progress';
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
