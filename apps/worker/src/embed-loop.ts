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
    if (stopped) return true;
    const t0 = Date.now();
    let processed = 0;
    try {
      const texts = rows.map((row) => expand(row.content));
      const embeds = embedder.embedBatch
        ? await embedder.embedBatch(texts)
        : await embedSequentially(embedder, texts);
      if (embeds.length !== rows.length) {
        throw new Error(`embed batch returned ${embeds.length} vectors for ${rows.length} rows`);
      }
      store.storage.transaction(() => {
        rows.forEach((row, index) => {
          const vec = embeds[index];
          if (!vec) throw new Error(`embed batch missing vector for row=${row.id}`);
          store.storage.putEmbedding(row.id, embedder.model, vec);
          highWaterObservationId = Math.max(highWaterObservationId, row.id);
          processed += 1;
        });
      });
    } catch (err) {
      state.lastError = err instanceof Error ? err.message : String(err);
      const firstRowId = rows[0]?.id ?? 'unknown';
      process.stderr.write(`[colony worker] embed error row=${firstRowId}: ${state.lastError}\n`);
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

async function embedSequentially(
  embedder: Embedder,
  texts: readonly string[],
): Promise<Float32Array[]> {
  const embeds: Float32Array[] = [];
  for (const text of texts) {
    embeds.push(await embedder.embed(text));
  }
  return embeds;
}
