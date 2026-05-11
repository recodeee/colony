import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsSchema } from '@colony/config';
import { type Embedder, MemoryStore } from '@colony/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BATCH_MAX,
  IngestBatcher,
  IngestError,
  startEmbedLoop,
  stateFilePath,
} from '../src/embed-loop.js';

let dir: string;
let store: MemoryStore;

function buildSettings() {
  return SettingsSchema.parse({
    dataDir: dir,
    embedding: {
      provider: 'local',
      model: 'mock-model',
      batchSize: 8,
      autoStart: false,
      idleShutdownMs: 60_000,
    },
  });
}

function mockEmbedder(
  model: string,
  dim: number,
  calls?: { single: number; batch: number },
): Embedder {
  const vector = () => {
    const v = new Float32Array(dim);
    for (let i = 0; i < dim; i++) v[i] = Math.random();
    return v;
  };
  return {
    model,
    dim,
    async embed(_text: string) {
      if (calls) calls.single += 1;
      return vector();
    },
    async embedBatch(texts: readonly string[]) {
      if (calls) calls.batch += 1;
      return texts.map(() => vector());
    },
  };
}

function trackingEmbedder(batches: string[][]): Embedder {
  return {
    model: 'mock-model',
    dim: 4,
    async embed(text: string) {
      batches.push([text]);
      return new Float32Array(4);
    },
    async embedBatch(texts: readonly string[]) {
      batches.push([...texts]);
      return texts.map(() => new Float32Array(4));
    },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'colony-embed-'));
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: buildSettings() });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('embed loop', () => {
  it('backfills all missing observations and writes a state file', async () => {
    store.startSession({ id: 'sess', ide: 'test', cwd: '/tmp' });
    for (let i = 0; i < 5; i++) {
      store.addObservation({ session_id: 'sess', kind: 'note', content: `observation ${i}` });
    }
    expect(store.storage.countEmbeddings()).toBe(0);

    const handle = startEmbedLoop({
      store,
      embedder: mockEmbedder('mock-model', 4),
      settings: buildSettings(),
      idleTickMs: 20,
    });

    // Wait for at least one batch to run.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && store.storage.countEmbeddings() < 5) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await handle.stop();

    expect(store.storage.countEmbeddings()).toBe(5);
    const state = JSON.parse(readFileSync(stateFilePath(buildSettings()), 'utf8')) as {
      embedded: number;
      total: number;
      model: string;
      dim: number;
    };
    expect(state.embedded).toBe(5);
    expect(state.total).toBe(5);
    expect(state.model).toBe('mock-model');
    expect(state.dim).toBe(4);
  });

  it('coalesces a 100 observation burst into four embedder batch calls', async () => {
    store.startSession({ id: 'sess', ide: 'test', cwd: '/tmp' });
    for (let i = 0; i < 100; i++) {
      store.addObservation({ session_id: 'sess', kind: 'note', content: `observation ${i}` });
    }
    const calls = { single: 0, batch: 0 };
    const settings = SettingsSchema.parse({
      ...buildSettings(),
      embedding: {
        ...buildSettings().embedding,
        batchSize: 100,
      },
    });

    const handle = startEmbedLoop({
      store,
      embedder: mockEmbedder('mock-model', 4, calls),
      settings,
      idleTickMs: 20,
    });

    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && store.storage.countEmbeddings() < 100) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await handle.stop();

    expect(store.storage.countEmbeddings()).toBe(100);
    expect(calls.single).toBe(0);
    expect(calls.batch).toBeLessThanOrEqual(Math.ceil(100 / BATCH_MAX));
  });

  it('fails fast when the ingest batcher channel is full', async () => {
    const batcher = new IngestBatcher(mockEmbedder('mock-model', 4), {
      capacity: 1,
      windowMs: 100,
      log: () => {},
    });

    const first = batcher.ingest(1, 'one');
    await expect(batcher.ingest(2, 'two')).rejects.toMatchObject({
      code: IngestError.BACKPRESSURE,
    });
    await expect(first).resolves.toMatchObject({ id: 1 });
  });

  it('splits mixed-length ingest flushes into padding-aware buckets', async () => {
    const batches: string[][] = [];
    const batcher = new IngestBatcher(trackingEmbedder(batches), {
      maxBatch: BATCH_MAX,
      windowMs: 1000,
      log: () => {},
    });
    const short = 's'.repeat(20);
    const long = 'l'.repeat(8000);
    const texts = [...Array.from({ length: 31 }, () => short), long];

    await Promise.all(texts.map((text, index) => batcher.ingest(index, text)));

    expect(batches).toHaveLength(2);
    expect(batches.map((batch) => batch.length).sort((a, b) => a - b)).toEqual([1, 31]);
    const baselinePaddingWork = (long.length / 4) * texts.length;
    const bucketedPaddingWork = batches.reduce((total, batch) => {
      const maxTokens = Math.max(...batch.map((text) => text.length / 4));
      return total + maxTokens * batch.length;
    }, 0);
    expect(baselinePaddingWork / bucketedPaddingWork).toBeGreaterThan(3);
  });

  it('merges tiny adjacent buckets when the neighbor has batch capacity', async () => {
    const batches: string[][] = [];
    const batcher = new IngestBatcher(trackingEmbedder(batches), {
      maxBatch: 8,
      windowMs: 1000,
      log: () => {},
    });
    const short = 's'.repeat(20);
    const medium = 'm'.repeat(400);
    const texts = [short, short, short, medium, medium, medium, medium, medium];

    await Promise.all(texts.map((text, index) => batcher.ingest(index, text)));

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(8);
  });

  it('drops stale-model embeddings on startup', async () => {
    store.startSession({ id: 'sess', ide: 'test', cwd: '/tmp' });
    const a = store.addObservation({ session_id: 'sess', kind: 'note', content: 'a' });
    const b = store.addObservation({ session_id: 'sess', kind: 'note', content: 'b' });
    store.storage.putEmbedding(a, 'old-model', new Float32Array([1, 2]));
    store.storage.putEmbedding(b, 'old-model', new Float32Array([3, 4]));
    expect(store.storage.countEmbeddings()).toBe(2);

    const handle = startEmbedLoop({
      store,
      embedder: mockEmbedder('new-model', 3),
      settings: buildSettings(),
      idleTickMs: 20,
    });

    const deadline = Date.now() + 2000;
    while (
      Date.now() < deadline &&
      store.storage.countEmbeddings({ model: 'new-model', dim: 3 }) < 2
    ) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await handle.stop();

    // Stale rows dropped, new rows created.
    expect(store.storage.countEmbeddings({ model: 'old-model', dim: 2 })).toBe(0);
    expect(store.storage.countEmbeddings({ model: 'new-model', dim: 3 })).toBe(2);
  });

  it('writes state file at a predictable path', () => {
    const p = stateFilePath(buildSettings());
    // File may not exist yet; path must be inside the data dir.
    expect(p.startsWith(dir)).toBe(true);
    expect(p.endsWith('worker.state.json')).toBe(true);
    // exhaust the "does the file path look right?" check regardless of state.
    expect(existsSync(dir)).toBe(true);
  });

  it('avoids full missing-embedding scans while the observation high-water is unchanged', async () => {
    let fullScans = 0;
    let incrementalScans = 0;
    const fullScan = store.storage.observationsMissingEmbeddings.bind(store.storage);
    const incrementalScan = store.storage.observationsMissingEmbeddingsAfter.bind(store.storage);
    store.storage.observationsMissingEmbeddings = (...args) => {
      fullScans += 1;
      return fullScan(...args);
    };
    store.storage.observationsMissingEmbeddingsAfter = (...args) => {
      incrementalScans += 1;
      return incrementalScan(...args);
    };

    const handle = startEmbedLoop({
      store,
      embedder: mockEmbedder('mock-model', 4),
      settings: buildSettings(),
      idleTickMs: 20,
      fullScanIntervalMs: 10_000,
    });

    const deadline = Date.now() + 500;
    while (Date.now() < deadline && fullScans === 0) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 80));
    await handle.stop();

    expect(fullScans).toBe(1);
    expect(incrementalScans).toBe(0);
  });

  it('uses incremental scans for observations inserted after a clean full scan', async () => {
    let fullScans = 0;
    let incrementalScans = 0;
    const fullScan = store.storage.observationsMissingEmbeddings.bind(store.storage);
    const incrementalScan = store.storage.observationsMissingEmbeddingsAfter.bind(store.storage);
    store.storage.observationsMissingEmbeddings = (...args) => {
      fullScans += 1;
      return fullScan(...args);
    };
    store.storage.observationsMissingEmbeddingsAfter = (...args) => {
      incrementalScans += 1;
      return incrementalScan(...args);
    };

    store.startSession({ id: 'sess', ide: 'test', cwd: '/tmp' });
    const handle = startEmbedLoop({
      store,
      embedder: mockEmbedder('mock-model', 4),
      settings: buildSettings(),
      idleTickMs: 20,
      fullScanIntervalMs: 10_000,
    });

    const scanDeadline = Date.now() + 500;
    while (Date.now() < scanDeadline && fullScans === 0) {
      await new Promise((r) => setTimeout(r, 20));
    }
    store.addObservation({ session_id: 'sess', kind: 'note', content: 'new observation' });

    const embedDeadline = Date.now() + 1000;
    while (Date.now() < embedDeadline && store.storage.countEmbeddings() < 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await handle.stop();

    expect(store.storage.countEmbeddings()).toBe(1);
    expect(fullScans).toBe(1);
    expect(incrementalScans).toBeGreaterThan(0);
  });
});
