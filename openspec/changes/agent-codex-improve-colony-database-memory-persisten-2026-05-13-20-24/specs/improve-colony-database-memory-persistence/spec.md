## ADDED Requirements

### Requirement: Memory Writes Skip Redacted-Empty Content
The memory store SHALL apply privacy redaction before persisting observations or summaries, and it SHALL skip the write when the redacted content is empty or whitespace-only.

#### Scenario: Private-only observation
- **WHEN** an observation contains only content removed by private redaction
- **THEN** the memory store returns `-1`
- **AND** no session row or observation row is created for that call.

#### Scenario: Private-only summary
- **WHEN** a turn or session summary contains only content removed by private redaction
- **THEN** the memory store returns `-1`
- **AND** no session row or summary row is created for that call.

### Requirement: Memory Lookup Indexes
The storage layer SHALL create idempotent indexes for common memory lookup patterns after schema and column migrations are applied.

#### Scenario: Fresh database
- **WHEN** `Storage` opens a new writable database
- **THEN** observation indexes exist for kind/time, session/kind/time, task/kind/time, reply thread lookup, and task/time lookup
- **AND** summary indexes exist for session/time and scope/time lookup.
