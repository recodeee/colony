import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Embedder } from '../src/memory-store.js';
import { MemoryStore } from '../src/memory-store.js';
import { classifyStatus, cosineSimilarity, findSimilarTasks } from '../src/similarity-search.js';

let dir: string;
let store: MemoryStore;

const DIM = 4;

class FakeEmbedder implements Embedder {
  readonly model = 'm1';
  readonly dim = DIM;
  embed(_text: string): Promise<Float32Array> {
    return Promise.resolve(new Float32Array(this.dim));
  }
}

function seed(...ids: string[]): void {
  for (const id of ids) {
    store.startSession({ id, ide: 'claude-code', cwd: '/r' });
  }
}

function unitVec(axis: number): Float32Array {
  const v = new Float32Array(DIM);
  v[axis] = 1;
  return v;
}

function createTask(branch: string, repo_root = '/r'): number {
  const row = store.storage.findOrCreateTask({
    title: branch,
    repo_root,
    branch,
    created_by: 'claude',
  });
  return row.id;
}

// Seed a task with N observations on the given axis. Stamps embeddings on
// every observation so the task vector ends up aligned with that axis.
function seedTask(p: { branch: string; repo_root?: string; axis: number; count?: number }): number {
  const task_id = createTask(p.branch, p.repo_root ?? '/r');
  const count = p.count ?? 6;
  for (let i = 0; i < count; i++) {
    const obs_id = store.addObservation({
      session_id: 'claude',
      task_id,
      kind: 'note',
      content: `obs ${i} on ${p.branch}`,
    });
    store.storage.putEmbedding(obs_id, 'm1', unitVec(p.axis));
  }
  return task_id;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'colony-similarity-'));
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
  seed('claude');
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('cosineSimilarity', () => {
  it('returns the dot product for unit-normalized inputs', () => {
    const a = unitVec(0);
    const b = unitVec(0);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 6);

    const c = unitVec(1);
    expect(cosineSimilarity(a, c)).toBeCloseTo(0, 6);
  });

  it('returns 0 on dimension mismatch instead of throwing', () => {
    const a = new Float32Array(4);
    const b = new Float32Array(2);
    expect(cosineSimilarity(a, b)).toBe(0);
  });
});

describe('findSimilarTasks', () => {
  it('returns an empty array on an empty corpus', () => {
    const results = findSimilarTasks(store, new FakeEmbedder(), unitVec(0));
    expect(results).toEqual([]);
  });

  it('orders results by similarity descending and respects the limit', () => {
    // Task `aligned` — every observation on axis 0 → centroid sim ≈ 1.0
    seedTask({ branch: 'aligned', axis: 0, count: 6 });
    // Task `mixed` — half axis 0, half axis 1 → centroid splits between
    // the two axes, normalized → sim ≈ 0.707 with the axis-0 query.
    const mixed_id = createTask('mixed');
    for (let i = 0; i < 3; i++) {
      const id = store.addObservation({
        session_id: 'claude',
        task_id: mixed_id,
        kind: 'note',
        content: `axis 0 obs ${i}`,
      });
      store.storage.putEmbedding(id, 'm1', unitVec(0));
    }
    for (let i = 0; i < 3; i++) {
      const id = store.addObservation({
        session_id: 'claude',
        task_id: mixed_id,
        kind: 'note',
        content: `axis 1 obs ${i}`,
      });
      store.storage.putEmbedding(id, 'm1', unitVec(1));
    }

    const results = findSimilarTasks(store, new FakeEmbedder(), unitVec(0), {
      min_similarity: 0,
      limit: 5,
    });

    expect(results).toHaveLength(2);
    expect(results[0]?.branch).toBe('aligned');
    expect(results[1]?.branch).toBe('mixed');
    expect(results[0]?.similarity ?? 0).toBeGreaterThan(results[1]?.similarity ?? 0);
  });

  it('drops results below min_similarity', () => {
    seedTask({ branch: 'aligned', axis: 0 });
    seedTask({ branch: 'orthogonal', axis: 1 });

    // Floor 0.5 — orthogonal (sim 0) drops out.
    const results = findSimilarTasks(store, new FakeEmbedder(), unitVec(0), {
      min_similarity: 0.5,
    });
    expect(results.map((r) => r.branch)).toEqual(['aligned']);
  });

  it('excludes task ids passed in exclude_task_ids (self-exclusion case)', () => {
    const selfId = seedTask({ branch: 'self', axis: 0 });
    seedTask({ branch: 'other', axis: 0 });

    const all = findSimilarTasks(store, new FakeEmbedder(), unitVec(0), {
      min_similarity: 0,
    });
    expect(all.map((r) => r.task_id).sort()).toEqual([selfId, selfId + 1].sort());

    const filtered = findSimilarTasks(store, new FakeEmbedder(), unitVec(0), {
      min_similarity: 0,
      exclude_task_ids: [selfId],
    });
    expect(filtered.map((r) => r.task_id)).not.toContain(selfId);
    expect(filtered).toHaveLength(1);
  });

  it('scopes results to repo_root when set', () => {
    seedTask({ branch: 'r1-a', repo_root: '/r1', axis: 0 });
    seedTask({ branch: 'r2-a', repo_root: '/r2', axis: 0 });

    const r1 = findSimilarTasks(store, new FakeEmbedder(), unitVec(0), {
      min_similarity: 0,
      repo_root: '/r1',
    });
    expect(r1).toHaveLength(1);
    expect(r1[0]?.repo_root).toBe('/r1');

    // Without scope, both repos surface.
    const both = findSimilarTasks(store, new FakeEmbedder(), unitVec(0), {
      min_similarity: 0,
    });
    expect(both).toHaveLength(2);
  });

  it('skips tasks too sparse to embed (returns null from getOrComputeTaskEmbedding)', () => {
    // 3 embedded observations is below the MIN_EMBEDDED_OBSERVATIONS=5
    // floor — getOrComputeTaskEmbedding returns null and the task is
    // silently skipped, not surfaced as a noise match.
    seedTask({ branch: 'sparse', axis: 0, count: 3 });
    seedTask({ branch: 'dense', axis: 0, count: 6 });

    const results = findSimilarTasks(store, new FakeEmbedder(), unitVec(0), {
      min_similarity: 0,
    });
    expect(results.map((r) => r.branch)).toEqual(['dense']);
  });
});

describe('classifyStatus', () => {
  it('returns in-progress for a task with no observations', () => {
    const task_id = createTask('empty/task');
    expect(classifyStatus(store, task_id)).toBe('in-progress');
  });

  it('returns completed when a plan-archived observation exists', () => {
    const task_id = createTask('archived/task');
    store.addObservation({
      session_id: 'claude',
      task_id,
      kind: 'plan-archived',
      content: 'auto-archived',
    });
    expect(classifyStatus(store, task_id)).toBe('completed');
  });

  it('returns completed when the most recent observation is an accepted handoff', () => {
    const task_id = createTask('handed-off/task');
    // Use insertObservation so we can stamp explicit timestamps —
    // store.addObservation uses Date.now() and two back-to-back calls
    // can land in the same millisecond, leaving DESC order undefined.
    const now = Date.now();
    store.storage.insertObservation({
      session_id: 'claude',
      kind: 'note',
      content: 'earlier note',
      compressed: false,
      intensity: null,
      task_id,
      ts: now - 1000,
    });
    store.storage.insertObservation({
      session_id: 'claude',
      kind: 'handoff',
      content: 'transferred to codex',
      compressed: false,
      intensity: null,
      task_id,
      ts: now,
      metadata: { status: 'accepted' },
    });
    expect(classifyStatus(store, task_id)).toBe('completed');
  });

  it('returns abandoned when the latest observation is older than 7 days', () => {
    const task_id = createTask('abandoned/task');
    // Insert directly via Storage so we can stamp a back-dated ts.
    // MemoryStore.addObservation always uses Date.now().
    store.storage.insertObservation({
      session_id: 'claude',
      kind: 'note',
      content: 'last seen long ago',
      compressed: false,
      intensity: null,
      task_id,
      ts: Date.now() - 8 * 24 * 60 * 60 * 1000,
    });
    expect(classifyStatus(store, task_id)).toBe('abandoned');
  });

  it('returns in-progress for a task with recent activity that is not an accepted handoff', () => {
    const task_id = createTask('active/task');
    store.addObservation({
      session_id: 'claude',
      task_id,
      kind: 'note',
      content: 'still working',
    });
    expect(classifyStatus(store, task_id)).toBe('in-progress');
  });
});
