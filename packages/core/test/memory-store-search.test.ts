import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
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
let rustEnvSnapshot: Record<string, string | undefined>;

const RUST_ENV_KEYS = [
  'COLONY_RUST_SEARCH',
  'COLONY_RUST_SEARCH_REQUIRED',
  'COLONY_RUST_SEARCH_BIN',
  'COLONY_RUST_SEARCH_INDEX_DIR',
  'COLONY_RUST_SEARCH_TIMEOUT_MS',
] as const;

beforeEach(() => {
  rustEnvSnapshot = snapshotRustEnv();
  clearRustEnv();
  dir = mkdtempSync(join(tmpdir(), 'colony-core-'));
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
  restoreRustEnv(rustEnvSnapshot);
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

  it('bounds semantic reranking to keyword candidates when FTS fills the cap', async () => {
    await seedEmbeddings(store);
    const originalAllEmbeddings = store.storage.allEmbeddings.bind(store.storage);
    store.storage.allEmbeddings = () => {
      throw new Error('full embedding scan should not run for a filled FTS cap');
    };
    try {
      const hits = await store.search('cargo', 1, testEmbedder);
      expect(hits.length).toBe(1);
      expect(hits[0]?.snippet).toContain('cargo');
    } finally {
      store.storage.allEmbeddings = originalAllEmbeddings;
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

  it('uses the Rust full-text layer when enabled', async () => {
    process.env.COLONY_RUST_SEARCH = '1';
    process.env.COLONY_RUST_SEARCH_BIN = fakeRustBinary(`
const fs = require('node:fs');
const req = JSON.parse(fs.readFileSync(0, 'utf8'));
fs.writeFileSync(1, JSON.stringify({
  hits: [{
    id: 2,
    session_id: 's1',
    kind: 'note',
    snippet: 'rust:' + req.query,
    score: 42,
    ts: 123,
    task_id: null
  }]
}));
`);

    const hits = await store.search('schema', 10, undefined, undefined, { rust: 'required' });

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      id: 2,
      snippet: 'rust:schema',
      score: 42,
    });
  });

  it('falls back to SQLite FTS when optional Rust search fails', async () => {
    process.env.COLONY_RUST_SEARCH = '1';
    process.env.COLONY_RUST_SEARCH_BIN = fakeRustBinary(`
process.stderr.write('sidecar failed');
process.exit(7);
`);

    const hits = await store.search('cargo', 10);

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.snippet).toContain('cargo');
  });

  it('throws when Rust search is required but unavailable', async () => {
    await expect(
      store.search('cargo', 10, undefined, undefined, { rust: 'required' }),
    ).rejects.toThrow(/Rust search required/);
  });
});

function fakeRustBinary(source: string): string {
  const path = join(dir, `fake-rust-search-${Math.random().toString(36).slice(2)}.js`);
  writeFileSync(path, `#!/usr/bin/env node\n${source}\n`, 'utf8');
  chmodSync(path, 0o755);
  return path;
}

function snapshotRustEnv(): Record<string, string | undefined> {
  const snapshot: Record<string, string | undefined> = {};
  for (const key of RUST_ENV_KEYS) snapshot[key] = process.env[key];
  return snapshot;
}

function clearRustEnv(): void {
  for (const key of RUST_ENV_KEYS) delete process.env[key];
}

function restoreRustEnv(snapshot: Record<string, string | undefined>): void {
  for (const key of RUST_ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
