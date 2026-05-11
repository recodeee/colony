## ADDED Requirements

### Requirement: Batched Embedding Backfill
The worker embedding backfill SHALL send each fetched observation batch to an embedder batch API when the embedder exposes one.

#### Scenario: Batch-capable embedder
- **WHEN** 1000 observations are missing embeddings and `embedding.batchSize` is 32
- **THEN** the worker embeds them through 32 batch calls
- **AND** the final batch contains the remaining 8 observations.

#### Scenario: Single-text embedder
- **WHEN** the configured embedder does not expose a batch API
- **THEN** the worker SHALL preserve compatibility by embedding texts sequentially with `embed(text)`.

### Requirement: Chunk Transaction Writes
Each embedding backfill batch SHALL persist all vectors inside one SQLite transaction.

#### Scenario: Batch persisted
- **WHEN** a worker batch returns vectors for each selected observation
- **THEN** the storage writes for that batch happen inside one transaction
- **AND** the high-water observation id advances only for persisted rows.

### Requirement: Safe Embedding Buffer Reads
Storage APIs SHALL return embedding vectors backed by owned ArrayBuffer memory, not direct views over SQLite row buffers.

#### Scenario: Read stored vector
- **WHEN** a caller reads an embedding from storage
- **THEN** the returned Float32Array is a copy of the persisted bytes
- **AND** it does not alias the caller's original vector buffer.
