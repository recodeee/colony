---
"@colony/config": minor
"@colony/embedding": minor
---

Add `codex-gpu` embedding provider that targets the recodee
`codex-gpu-embedder` HTTP service (`POST /embed`).

When `settings.embedding.provider = 'codex-gpu'`, the worker hits the
local GPU embedder over HTTP instead of running Transformers.js in
process. Endpoint defaults to `http://127.0.0.1:8100`; override via
`settings.embedding.endpoint`. Captures `dim` from a one-shot warm-up
probe at init time, matching every other provider's contract.

The recodee dev box measures ~16 ms per single embed on the GPU vs ~200
ms on local CPU, so the worker's embedding-backfill loop completes
roughly 14× faster when configured this way. Behavior unchanged for any
deployment that does not opt in via the new provider value.
