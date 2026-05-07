## ADDED Requirements

### Requirement: Optional Rust Keyword Search Layer

Colony SHALL support an optional Rust keyword search sidecar for read-side
candidate retrieval while preserving SQLite FTS5 as the default and fallback.

#### Scenario: Default search keeps SQLite FTS

- **GIVEN** `search.rust.enabled` is false and no Rust search env override is set
- **WHEN** a caller runs `MemoryStore.search`
- **THEN** Colony uses SQLite FTS5 for keyword candidates
- **AND** no Rust binary is required

#### Scenario: Rust search can be enabled without changing writes

- **GIVEN** `search.rust.enabled` is true or `COLONY_RUST_SEARCH=1` is set
- **WHEN** a caller runs unfiltered `MemoryStore.search`
- **THEN** Colony asks the Rust sidecar for keyword candidates before semantic rerank
- **AND** observation writes still go through `MemoryStore` and SQLite storage

#### Scenario: Optional sidecar failure falls back

- **GIVEN** Rust search is enabled but not required
- **WHEN** the Rust sidecar is missing, exits non-zero, times out, or returns invalid JSON
- **THEN** Colony returns SQLite FTS5 keyword results instead of failing the search

#### Scenario: Required sidecar failure is explicit

- **GIVEN** Rust search is required by config, env, API, or CLI option
- **WHEN** the Rust sidecar is unavailable
- **THEN** Colony fails the search with an explicit Rust search error
