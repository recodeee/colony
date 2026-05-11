## Why

Colony embedding backfill was still writing vectors row-by-row and could fall back to single-text embed calls even when the active embedder supports text batches. Large reindex runs need the worker to preserve the GPU batch win by sending 32 texts at a time and committing each chunk as one SQLite unit.

## What Changes

- Use the existing optional `embedBatch(texts)` embedder path for worker backfill batches.
- Keep fallback providers sequential rather than launching parallel per-row calls.
- Persist fulfilled vectors from each worker batch inside one SQLite transaction.
- Default `embedding.batchSize` to 32.
- Keep the codex-gpu provider pointed at `/embed/batch` and harden vector conversion.
- Copy SQLite embedding buffers on read so vector views do not alias transient row memory.

## Impact

- Existing CLI/config flags stay compatible; only the default batch size changes.
- No parallel chunks are introduced; the worker still drains one fetched batch at a time.
- Real GPU timing depends on the running recodee embedder, but the regression test proves 1000 rows drain as 32 batches.
