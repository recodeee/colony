## Why

Colony embedding backfill was sending one observation at a time to the configured embedder and writing each vector separately. Reindexing large corpora paid per-row HTTP/model overhead even when the active embedder can accept text batches.

## What Changes

- Add an optional `embedBatch(texts)` embedder interface while keeping existing single-text `embed(text)` callers compatible.
- Teach the codex-gpu provider to call the recodee `/embed/batch` endpoint.
- Change the worker embed loop to process the configured batch as one embedder call and one SQLite transaction.
- Default embedding backfill batches to 32 observations.
- Copy SQLite embedding buffers on read so returned vectors do not alias row memory.

## Impact

- Existing embedders without `embedBatch` keep the old sequential fallback.
- No parallel chunks are introduced; the worker still processes one batch at a time.
- The user-visible CLI/config surface is unchanged except the default `embedding.batchSize` value increasing from 16 to 32.
