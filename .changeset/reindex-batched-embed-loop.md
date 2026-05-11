---
"@colony/worker": patch
"@colony/embedding": patch
"@colony/core": patch
"@colony/storage": patch
"@colony/config": patch
---

Changed the embedding backfill loop to send one batch of texts to embedders that support `embedBatch`, default worker batches to 32 observations, and persist each batch in a single SQLite transaction. The codex-gpu provider now calls `/embed/batch`, while storage copies returned embedding buffers so vector reads do not alias SQLite row memory.
