import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@cavemem/config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Embedder, MemoryStore } from '../src/index.js';

const DIM = 4;
const MODEL = 'test-model';

// Deterministic unit embedder — same text → same vector, similar length → similar vector.
const testEmbedder: Embedder = {
  model: MODEL,
  dim: DIM,
  async embed(text: string): Promise<Float32Array> {
    const v = new Float32Array(DIM);
    for (let i = 0; i < DIM; i++) v[i] = (text.length + i) / (text.length + DIM);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    for (let i = 0; i < DIM; i++) v[i] /= norm;
    return v;
  },
};

async function seedEmbeddings(store: MemoryStore): Promise<void> {
  for (const row of store.storage.observationsMissingEmbeddings(100, MODEL)) {
    const vec = await testEmbedder.embed(row.content);
    store.storage.putEmbedding(row.id, MODEL, vec);
  }
}

let dir: string;
let store: MemoryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cavemem-core-'));
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
  store.startSession({ id: 's1', ide: 'test', cwd: '/tmp' });
  store.addObservation({
    session_id: 's1',
    kind: 'note',
    content: 'cargo build runs the release pipeline',
  });
  store.addObservation({
    session_id: 's1',
    kind: 'note',
    content: 'the database schema lives in /etc/schema.sql',
  });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('MemoryStore.search()', () => {
  it('falls back to keyword-only when no embedder provided', async () => {
    const hits = await store.search('cargo', 10);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toMatchObject({
      id: expect.any(Number),
      snippet: expect.any(String),
      score: expect.any(Number),
    });
  });

  it('falls back to keyword-only when provider is none', async () => {
    const noneStore = new MemoryStore({
      dbPath: join(dir, 'data.db'),
      settings: {
        ...defaultSettings,
        embedding: { ...defaultSettings.embedding, provider: 'none' },
      },
    });
    await seedEmbeddings(noneStore);
    const hits = await noneStore.search('cargo', 10, testEmbedder);
    expect(hits.length).toBeGreaterThan(0);
    noneStore.close();
  });

  it('falls back to keyword when no stored embeddings match the model', async () => {
    // No embeddings stored — allEmbeddings returns [] → keyword fallback
    const hits = await store.search('cargo', 10, testEmbedder);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('uses hybrid ranking when embeddings exist and returns sorted results with required fields', async () => {
    await seedEmbeddings(store);
    const hits = await store.search('cargo build', 10, testEmbedder);
    expect(hits.length).toBeGreaterThan(0);
    for (let i = 1; i < hits.length; i++) {
      const prev = hits[i - 1];
      const curr = hits[i];
      if (!prev || !curr) throw new Error('unexpected missing hit');
      expect(prev.score).toBeGreaterThanOrEqual(curr.score);
    }
    for (const h of hits) {
      expect(Object.keys(h).sort()).toEqual(['id', 'score', 'session_id', 'snippet', 'ts']);
    }
  });

  it('falls back to keyword when embedder returns wrong dimension', async () => {
    const liar: Embedder = {
      model: MODEL,
      dim: DIM,
      async embed(_text: string): Promise<Float32Array> {
        return new Float32Array(DIM * 2).fill(0.1); // wrong size
      },
    };
    await seedEmbeddings(store); // store correct-dim vectors for liar's model
    const hits = await store.search('cargo', 10, liar);
    // Dim mismatch path falls through to keyword — still returns results
    expect(hits.length).toBeGreaterThan(0);
  });
});
