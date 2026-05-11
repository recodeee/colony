## ADDED Requirements

### Requirement: Batched Embedding Backfill
The worker embedding backfill SHALL send each fetched observation batch to the configured embedder batch API when that API exists.

#### Scenario: 1000-row corpus
- **WHEN** 1000 observations are missing embeddings and embedding.batchSize is 32
- **THEN** the worker drains the corpus through 32 embedding batches
- **AND** the final batch contains 8 observations.

#### Scenario: Non-batch embedder
- **WHEN** the configured embedder has only embed(text)
- **THEN** the worker preserves compatibility by embedding texts sequentially
- **AND** it does not launch parallel per-row embed calls.

### Requirement: Chunk Transaction Writes
Each embedding backfill chunk SHALL persist fulfilled vectors inside one SQLite transaction.

#### Scenario: Batch persisted
- **WHEN** a worker batch returns vectors for selected observations
- **THEN** those vector writes happen within one storage transaction
- **AND** the high-water observation id advances for persisted rows.

### Requirement: Safe Embedding Buffer Reads
Storage embedding reads SHALL return owned vector memory rather than direct views over SQLite row buffers.

#### Scenario: Read stored vector
- **WHEN** a caller reads an embedding from storage
- **THEN** the returned Float32Array is a copy of the persisted bytes
- **AND** it does not alias the caller original vector buffer.
