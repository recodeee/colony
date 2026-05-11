import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Embedder, MemoryStore } from '../src/index.js';

const DIM = 4;
const MODEL = 'test-model';

/**
 * Deterministic embedder where each text maps to a fixed unit vector keyed
 * by its first byte. Lets the test predict cosine ranking exactly:
 * texts starting with the same byte have cosine 1.0, distinct first
 * bytes have cosine 0.
 */
function makeEmbedder(): Embedder {
  return {
    model: MODEL,
    dim: DIM,
    async embed(text: string): Promise<Float32Array> {
      const v = new Float32Array(DIM);
      const b = text.length > 0 ? text.charCodeAt(0) % DIM : 0;
      v[b] = 1;
      return v;
    },
  };
}

async function seedEmbeddings(store: MemoryStore, e: Embedder): Promise<void> {
  for (const row of store.storage.observationsMissingEmbeddings(100, MODEL)) {
    const vec = await e.embed(row.content);
    store.storage.putEmbedding(row.id, MODEL, vec);
  }
}

let dir: string;
let store: MemoryStore;
let embedder: Embedder;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'colony-semantic-'));
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
  embedder = makeEmbedder();
  store.startSession({ id: 's1', ide: 'test', cwd: '/tmp' });
  // 4 observations, distinct first-byte buckets so the embedder maps each
  // to a distinct unit vector. Query for "alpha" should rank "alpha-..."
  // first regardless of FTS.
  store.addObservation({ session_id: 's1', kind: 'note', content: 'alpha first content' });
  store.addObservation({ session_id: 's1', kind: 'note', content: 'beta second content' });
  store.addObservation({ session_id: 's1', kind: 'decision', content: 'cargo build pipeline notes' });
  store.addObservation({ session_id: 's1', kind: 'note', content: 'delta fourth row content' });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('MemoryStore.semanticSearch()', () => {
  it('returns empty when no stored embeddings match the model', async () => {
    const hits = await store.semanticSearch('alpha probe', 10, embedder);
    expect(hits).toEqual([]);
  });

  it('returns top-K by cosine similarity when embeddings are stored', async () => {
    await seedEmbeddings(store, embedder);
    const hits = await store.semanticSearch('alpha probe', 10, embedder);
    expect(hits.length).toBeGreaterThan(0);
    // The first hit should be one of the "alpha"-bucket observations
    // (first byte 0x61 mod 4 == 1), with cosine 1.0.
    expect(hits[0]?.score).toBeCloseTo(1.0);
    expect(hits[0]?.snippet).toContain('alpha');
  });

  it('ranks results descending by score', async () => {
    await seedEmbeddings(store, embedder);
    const hits = await store.semanticSearch('cargo notes', 10, embedder);
    for (let i = 1; i < hits.length; i++) {
      const prev = hits[i - 1];
      const curr = hits[i];
      if (!prev || !curr) throw new Error('unexpected missing hit');
      expect(prev.score).toBeGreaterThanOrEqual(curr.score);
    }
  });

  it('honors limit and returns at most `limit` results', async () => {
    await seedEmbeddings(store, embedder);
    const hits = await store.semanticSearch('anything', 2, embedder);
    expect(hits.length).toBeLessThanOrEqual(2);
  });

  it('returns empty when the embedder reports a wrong dim', async () => {
    await seedEmbeddings(store, embedder);
    const liar: Embedder = {
      model: MODEL,
      dim: DIM,
      async embed(_t: string): Promise<Float32Array> {
        return new Float32Array(DIM * 2);
      },
    };
    const hits = await store.semanticSearch('anything', 10, liar);
    expect(hits).toEqual([]);
  });

  it('filters by kind after ranking', async () => {
    await seedEmbeddings(store, embedder);
    const hits = await store.semanticSearch('cargo', 10, embedder, { kind: 'decision' });
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) expect(h.kind).toBe('decision');
  });

  it('returns SearchResult-shaped rows with all required fields', async () => {
    await seedEmbeddings(store, embedder);
    const hits = await store.semanticSearch('alpha probe', 5, embedder);
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(Object.keys(h).sort()).toEqual([
        'id',
        'kind',
        'score',
        'session_id',
        'snippet',
        'task_id',
        'ts',
      ]);
    }
  });
});
