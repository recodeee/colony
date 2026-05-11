## ADDED Requirements

### Requirement: Worker observation embedding batcher
The worker ingest path SHALL coalesce observation embedding requests before calling the
configured embedder.

#### Scenario: Burst coalescing
- **WHEN** 100 observations are queued rapidly for embedding
- **THEN** the worker SHALL call the embedder batch API at most 4 times
- **AND** all 100 embeddings SHALL be persisted.

#### Scenario: Single observation compatibility
- **WHEN** one observation is queued for embedding
- **THEN** the worker SHALL still persist its embedding
- **AND** the caller-facing async behavior SHALL remain awaitable.

#### Scenario: Backpressure
- **WHEN** the ingest batcher channel is full
- **THEN** ingest SHALL fail immediately with `IngestError.Backpressure`
- **AND** it SHALL NOT wait indefinitely for capacity.

#### Scenario: Flush metrics
- **WHEN** a batch flush completes
- **THEN** the worker SHALL emit metrics containing `batch_size`, `bucket_count`, `elapsed_ms`, and `texts_per_sec`.

#### Scenario: Padding-aware bucket split
- **WHEN** one flush contains observations from materially different token-length classes
- **THEN** the worker SHALL estimate tokens with `text.length / 4`
- **AND** it SHALL split the flush into the hardcoded buckets `[0..64]`, `[64..256]`, `[256..1024]`, and `[1024..]`
- **AND** it SHALL send each non-empty bucket through a separate embedder call.

#### Scenario: Tiny adjacent bucket merge
- **WHEN** a bucket has fewer than 4 observations
- **AND** an immediately adjacent non-empty bucket has enough remaining batch capacity
- **THEN** the worker SHALL merge the tiny bucket into that adjacent bucket
- **AND** it SHALL NOT merge across empty intermediate bucket ranges.

#### Scenario: Storage write scope
- **WHEN** a batch of vectors returns from the embedder
- **THEN** the worker SHALL persist SQLite embeddings one row at a time
- **AND** it SHALL NOT batch SQLite writes in this change.
