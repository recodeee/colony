## Why

- Observation embedding currently pays provider overhead per row during worker ingest bursts.
  Session start and reindex-adjacent bursts can saturate CPU because the provider cannot
  amortize tokenizer/inference setup across rows.

## What Changes

- Add an `IngestBatcher` in the worker embed loop that coalesces observations for up to
  50 ms or 32 rows before calling the embedder batch API.
- Sort each flush by cheap `text.length / 4` token estimates and split it across hardcoded
  padding buckets `[0..64]`, `[64..256]`, `[256..1024]`, and `[1024..]`, with tiny
  adjacent buckets merged when there is remaining batch capacity.
- Extend the embedder contract with optional `embedBatch(texts)` support and wire local,
  Ollama, and OpenAI-compatible providers to use their batch-capable surfaces.
- Keep SQLite writes one row at a time after vectors return; only embedding calls are batched.
- Add regression coverage for single-observation ingest, burst coalescing, padding-aware
  splitting, tiny adjacent-bucket merging, and backpressure.

## Impact

- Worker embedding throughput improves during bursts without changing MCP tool APIs.
- Mixed short/long observation bursts avoid paying one long row's padding cost across the
  whole batch.
- Providers that do not implement `embedBatch` still work through the single-text fallback.
- Reindex behavior and storage transaction shape are intentionally unchanged.
