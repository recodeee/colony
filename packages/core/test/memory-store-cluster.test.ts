import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Embedder, MemoryStore } from '../src/index.js';

const DIM = 4;
const MODEL = 'test-model';

/**
 * First-character bucket embedder: texts that start with the same first
 * character produce identical unit vectors (cosine 1.0). Lets the
 * cluster test predict groupings exactly.
 */
function makeBucketEmbedder(): Embedder {
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
let idA1 = 0;
let idA2 = 0;
let idA3 = 0;
let idB1 = 0;
let idC1 = 0;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'colony-cluster-'));
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
  embedder = makeBucketEmbedder();
  store.startSession({ id: 's1', ide: 'test', cwd: '/tmp' });
  // Three "alpha-bucket" observations (first char 'a' → identical embeddings),
  // one "beta-bucket", one "cargo-bucket". The clusterer with threshold 0.99
  // should return three clusters: {a1, a2, a3}, {b1}, {c1}.
  idA1 = store.addObservation({
    session_id: 's1',
    kind: 'note',
    content: 'alpha first variant of the handoff',
  });
  idA2 = store.addObservation({
    session_id: 's1',
    kind: 'note',
    content: 'alpha second variant with different wording',
  });
  idA3 = store.addObservation({
    session_id: 's1',
    kind: 'note',
    content: 'alpha third near-duplicate report',
  });
  idB1 = store.addObservation({
    session_id: 's1',
    kind: 'note',
    content: 'beta unrelated lane',
  });
  idC1 = store.addObservation({
    session_id: 's1',
    kind: 'decision',
    content: 'cargo build pipeline notes',
  });
  await seedEmbeddings(store, embedder);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('MemoryStore.clusterObservations()', () => {
  it('returns empty clusters and empty unembedded for empty input', async () => {
    const out = await store.clusterObservations([], 0.85, embedder);
    expect(out).toEqual({ clusters: [], unembedded: [] });
  });

  it('groups observations whose cosine to canonical is >= threshold', async () => {
    const out = await store.clusterObservations([idA1, idA2, idA3, idB1, idC1], 0.99, embedder);
    expect(out.unembedded).toEqual([]);
    expect(out.clusters.length).toBe(3);
    const alphaCluster = out.clusters.find((c) => c.canonical_id === idA1);
    expect(alphaCluster?.member_ids.sort((a, b) => a - b)).toEqual([idA1, idA2, idA3]);
    expect(out.clusters.find((c) => c.canonical_id === idB1)?.member_ids).toEqual([idB1]);
    expect(out.clusters.find((c) => c.canonical_id === idC1)?.member_ids).toEqual([idC1]);
  });

  it('picks the earliest id as canonical within each cluster', async () => {
    // The three alpha rows were inserted in order, so idA1 < idA2 < idA3.
    const out = await store.clusterObservations([idA3, idA1, idA2], 0.99, embedder);
    const cluster = out.clusters[0];
    expect(cluster).toBeDefined();
    expect(cluster?.canonical_id).toBe(idA1);
  });

  it('drops duplicate input ids without affecting clusters', async () => {
    const out = await store.clusterObservations([idA1, idA1, idA2], 0.99, embedder);
    expect(out.clusters.length).toBe(1);
    expect(out.clusters[0]?.member_ids.sort((a, b) => a - b)).toEqual([idA1, idA2]);
  });

  it('reports ids without a stored embedding under `unembedded`', async () => {
    // Add a brand-new observation but do NOT seed its embedding.
    const noEmbed = store.addObservation({
      session_id: 's1',
      kind: 'note',
      content: 'never embedded',
    });
    const out = await store.clusterObservations([idA1, noEmbed], 0.99, embedder);
    expect(out.unembedded).toEqual([noEmbed]);
    expect(out.clusters.length).toBe(1);
    expect(out.clusters[0]?.canonical_id).toBe(idA1);
  });

  it('rejects out-of-range threshold', async () => {
    await expect(store.clusterObservations([idA1], 1.5, embedder)).rejects.toThrow(/threshold/);
    await expect(store.clusterObservations([idA1], -2, embedder)).rejects.toThrow(/threshold/);
    await expect(store.clusterObservations([idA1], Number.NaN, embedder)).rejects.toThrow(/threshold/);
  });

  it('keeps each observation in exactly one cluster (no double-assignment)', async () => {
    const out = await store.clusterObservations([idA1, idA2, idA3, idB1, idC1], 0.5, embedder);
    const allMembers = out.clusters.flatMap((c) => c.member_ids);
    expect(new Set(allMembers).size).toBe(allMembers.length);
  });
});
