import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expand } from '@colony/compress';
import type { Settings } from '@colony/config';
import { resolveDataDir } from '@colony/config';
import type { Embedder, MemoryStore } from '@colony/core';

export interface EmbedLoopState {
  provider: string;
  model: string;
  dim: number;
  embedded: number;
  total: number;
  lastBatchAt: number | null;
  lastBatchMs: number | null;
  lastError: string | null;
  /** Set by the HTTP layer whenever a viewer request hits, so the loop's
   * idle-shutdown considers UI activity as "still wanted". */
  lastHttpAt: number;
  startedAt: number;
}

export interface EmbedLoopHandle {
  /** Stop the loop and wait for the current batch to finish. */
  stop: () => Promise<void>;
  /** Bump the HTTP activity timestamp (call on every request). */
  touch: () => void;
  /** Read the current state snapshot. */
  state: () => EmbedLoopState;
}

export function stateFilePath(settings: Settings): string {
  return join(resolveDataDir(settings.dataDir), 'worker.state.json');
}

export const BATCH_MAX = 32;
export const BATCH_WINDOW_MS = 50;
const INGEST_CHANNEL_CAPACITY = BATCH_MAX * 4;
const SMALL_BUCKET_MIN = 4;

export class IngestError extends Error {
  static readonly BACKPRESSURE = 'Backpressure';

  readonly code: string;

  private constructor(code: string, message: string) {
    super(message);
    this.name = 'IngestError';
    this.code = code;
  }

  static backpressure(): IngestError {
    return new IngestError(IngestError.BACKPRESSURE, 'ingest batcher channel is full');
  }
}

interface PendingObservation {
  id: number;
  text: string;
  resolve: (result: IngestResult) => void;
  reject: (err: unknown) => void;
}

interface IngestResult {
  id: number;
  vector: Float32Array;
}

export class IngestBatcher {
  private readonly buffer: PendingObservation[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private queued = 0;

  constructor(
    private readonly embedder: Embedder,
    private readonly opts: {
      maxBatch?: number;
      windowMs?: number;
      capacity?: number;
      log?: (line: string) => void;
    } = {},
  ) {}

  ingest(id: number, text: string): Promise<IngestResult> {
    const capacity = this.opts.capacity ?? INGEST_CHANNEL_CAPACITY;
    if (this.queued >= capacity) {
      return Promise.reject(IngestError.backpressure());
    }
    this.queued += 1;
    return new Promise((resolve, reject) => {
      this.buffer.push({ id, text, resolve, reject });
      if (this.buffer.length >= (this.opts.maxBatch ?? BATCH_MAX)) {
        this.flushSoon();
        return;
      }
      this.armTimer();
    });
  }

  private armTimer(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flushSoon();
    }, this.opts.windowMs ?? BATCH_WINDOW_MS);
  }

  private flushSoon(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    void this.flush();
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0, this.opts.maxBatch ?? BATCH_MAX);
    const t0 = Date.now();
    try {
      const vectorsById = new Map<PendingObservation, Float32Array>();
      const buckets = buildPaddingAwareBuckets(batch, this.opts.maxBatch ?? BATCH_MAX);
      for (const bucket of buckets) {
        const vectors = await embedTexts(
          this.embedder,
          bucket.map((item) => item.text),
        );
        if (vectors.length !== bucket.length) {
          throw new Error(`embedder returned ${vectors.length} vectors for ${bucket.length} texts`);
        }
        for (let i = 0; i < bucket.length; i++) {
          const item = bucket[i];
          const vector = vectors[i];
          if (item && vector) vectorsById.set(item, vector);
        }
      }
      if (vectorsById.size !== batch.length) {
        throw new Error(`embedder returned ${vectorsById.size} vectors for ${batch.length} texts`);
      }
      const elapsedMs = Math.max(1, Date.now() - t0);
      const textsPerSec = Number(((batch.length * 1000) / elapsedMs).toFixed(1));
      (this.opts.log ?? defaultBatchLog)(
        `[colony worker] embed batch flush batch_size=${batch.length} bucket_count=${buckets.length} elapsed_ms=${elapsedMs} texts_per_sec=${textsPerSec}`,
      );
      for (const item of batch) {
        const vector = vectorsById.get(item);
        if (!item || !vector) continue;
        item.resolve({ id: item.id, vector });
      }
    } catch (err) {
      for (const item of batch) item.reject(err);
    } finally {
      this.queued -= batch.length;
      if (this.buffer.length > 0) this.armTimer();
    }
  }
}

function buildPaddingAwareBuckets(
  batch: readonly PendingObservation[],
  maxBatch: number,
): PendingObservation[][] {
  const buckets: PendingObservation[][] = [[], [], [], []];
  const sorted = [...batch].sort((a, b) => estimateTokens(a.text) - estimateTokens(b.text));
  for (const item of sorted) {
    buckets[bucketIndex(estimateTokens(item.text))]?.push(item);
  }

  for (let index = 0; index < buckets.length; index++) {
    const bucket = buckets[index];
    if (!bucket || bucket.length === 0 || bucket.length >= SMALL_BUCKET_MIN) continue;
    const targetIndex = mergeTargetIndex(buckets, index, maxBatch);
    if (targetIndex === null) continue;
    buckets[targetIndex]?.push(...bucket);
    bucket.length = 0;
  }

  return buckets.filter((bucket) => bucket.length > 0);
}

function mergeTargetIndex(
  buckets: readonly PendingObservation[][],
  sourceIndex: number,
  maxBatch: number,
): number | null {
  const source = buckets[sourceIndex];
  if (!source) return null;
  const candidates = [sourceIndex - 1, sourceIndex + 1].filter(
    (index) => index >= 0 && index < buckets.length,
  );
  for (const index of candidates) {
    const bucket = buckets[index];
    if (bucket && bucket.length > 0 && bucket.length + source.length <= maxBatch) {
      return index;
    }
  }
  return null;
}

function bucketIndex(estimatedTokens: number): number {
  if (estimatedTokens < 64) return 0;
  if (estimatedTokens < 256) return 1;
  if (estimatedTokens < 1024) return 2;
  return 3;
}

function estimateTokens(text: string): number {
  return Math.floor(text.length / 4);
}

async function embedTexts(embedder: Embedder, texts: readonly string[]): Promise<Float32Array[]> {
  if (texts.length === 1) {
    const [text] = texts;
    if (text === undefined) return [];
    return [await embedder.embed(text)];
  }
  if (embedder.embedBatch) {
    return embedder.embedBatch(texts);
  }
  return Promise.all(texts.map((text) => embedder.embed(text)));
}

function defaultBatchLog(line: string): void {
  process.stderr.write(`${line}\n`);
}

/**
 * Run the embedding backfill loop in-process. Writes a snapshot JSON after
 * every batch so `colony status` can read it without HTTP.
 *
 * Lifecycle:
 *   1. Drop embeddings rows that don't match the current model/dim.
 *   2. Loop: fetch up-to-batchSize observations without embeddings, embed
 *      the expanded text (semantic search matches human intent, not caveman
 *      grammar), persist.
 *   3. When nothing left, sleep {idleTickMs}. After {idleShutdownMs} with
 *      no embed work and no HTTP traffic, invoke onIdleExit.
 */
export function startEmbedLoop(opts: {
  store: MemoryStore;
  embedder: Embedder;
  settings: Settings;
  onIdleExit?: () => void;
  /** Poll cadence when the queue is empty. Defaults to 10s. */
  idleTickMs?: number;
  /** Full backlog scan cadence after the first clean scan. Defaults to 60s. */
  fullScanIntervalMs?: number;
}): EmbedLoopHandle {
  const { store, embedder, settings } = opts;
  const idleTickMs = opts.idleTickMs ?? 10_000;
  const fullScanIntervalMs = opts.fullScanIntervalMs ?? 60_000;
  const batchSize = settings.embedding.batchSize;
  const idleShutdownMs = settings.embedding.idleShutdownMs;

  // Nuke stale-model embeddings once on startup.
  const dropped = store.storage.dropEmbeddingsWhereModelNot(embedder.model);
  if (dropped > 0) {
    process.stderr.write(
      `[colony worker] dropped ${dropped} stale embeddings (model switched to ${embedder.model})\n`,
    );
  }

  const state: EmbedLoopState = {
    provider: settings.embedding.provider,
    model: embedder.model,
    dim: embedder.dim,
    embedded: store.storage.countEmbeddings({ model: embedder.model, dim: embedder.dim }),
    total: store.storage.countObservations(),
    lastBatchAt: null,
    lastBatchMs: null,
    lastError: null,
    lastHttpAt: Date.now(),
    startedAt: Date.now(),
  };

  const statePath = stateFilePath(settings);
  let stopped = false;
  let current: Promise<void> | null = null;
  let highWaterObservationId = 0;
  let needsFullScan = true;
  let nextFullScanAt = Date.now() + fullScanIntervalMs;
  const batcher = new IngestBatcher(embedder);

  const snapshot = () => {
    try {
      writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    } catch {
      // Best effort — status will just show slightly stale data.
    }
  };
  snapshot();

  const processOnce = async (): Promise<boolean> => {
    let latestObservationId = highWaterObservationId;
    if (!needsFullScan) {
      latestObservationId = store.storage.lastObservationId();
      if (latestObservationId <= highWaterObservationId) return false;
    }

    const rows = needsFullScan
      ? store.storage.observationsMissingEmbeddings(batchSize, embedder.model)
      : store.storage.observationsMissingEmbeddingsAfter(
          highWaterObservationId,
          batchSize,
          embedder.model,
        );
    if (rows.length === 0) {
      if (needsFullScan) {
        state.total = store.storage.countObservations();
        highWaterObservationId = store.storage.lastObservationId();
        needsFullScan = false;
        nextFullScanAt = Date.now() + fullScanIntervalMs;
        snapshot();
      } else {
        highWaterObservationId = Math.max(highWaterObservationId, latestObservationId);
      }
      return false;
    }
    const t0 = Date.now();
    const pending = rows.map((row) => {
      // Expand for semantic fidelity: caveman grammar is lossless but
      // models were trained on natural text, so expand first.
      return batcher.ingest(row.id, expand(row.content));
    });
    const results = await Promise.allSettled(pending);
    let processed = 0;
    for (const result of results) {
      if (stopped) return true;
      if (result.status === 'rejected') {
        state.lastError =
          result.reason instanceof Error ? result.reason.message : String(result.reason);
        process.stderr.write(`[colony worker] embed error: ${state.lastError}\n`);
        continue;
      }
      store.storage.putEmbedding(result.value.id, embedder.model, result.value.vector);
      highWaterObservationId = Math.max(highWaterObservationId, result.value.id);
      processed += 1;
    }
    if (processed === 0) return false;
    state.lastBatchAt = Date.now();
    state.lastBatchMs = state.lastBatchAt - t0;
    state.embedded = store.storage.countEmbeddings({ model: embedder.model, dim: embedder.dim });
    state.total = store.storage.countObservations();
    snapshot();
    return true;
  };

  const run = async () => {
    let idleSince = Date.now();
    while (!stopped) {
      if (!needsFullScan && Date.now() >= nextFullScanAt) {
        needsFullScan = true;
      }
      const didWork = await processOnce();
      if (didWork) {
        idleSince = Date.now();
        continue;
      }
      const now = Date.now();
      const noWork = now - idleSince;
      const noTraffic = now - state.lastHttpAt;
      if (noWork > idleShutdownMs && noTraffic > idleShutdownMs) {
        process.stderr.write(
          `[colony worker] idle ${Math.round(noWork / 1000)}s + no traffic ${Math.round(
            noTraffic / 1000,
          )}s — exiting\n`,
        );
        opts.onIdleExit?.();
        return;
      }
      await sleep(idleTickMs);
    }
  };

  current = run().catch((err) => {
    state.lastError = err instanceof Error ? err.message : String(err);
    snapshot();
  });

  return {
    stop: async () => {
      stopped = true;
      if (current) await current;
    },
    touch: () => {
      state.lastHttpAt = Date.now();
    },
    state: () => ({ ...state }),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
