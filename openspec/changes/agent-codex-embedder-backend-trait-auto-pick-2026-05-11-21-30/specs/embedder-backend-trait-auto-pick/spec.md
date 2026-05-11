## ADDED Requirements

### Requirement: Rust Embedder Backend Trait
The system SHALL expose a Rust `EmbedderBackend` trait that is `Send + Sync` and embeds a slice of input texts through `embed(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>>`.

#### Scenario: CPU stub embeds a batch
- **WHEN** the `cpu-stub` backend embeds multiple input texts
- **THEN** it returns one 384-dimensional vector for each input
- **AND** the vectors are deterministic and unit-normalized.

### Requirement: Automatic Backend Selection
The system SHALL select the first compiled and usable backend in this order: `ort-cuda`, `ort-cpu`, `tract`, then `cpu-stub`.

#### Scenario: Only CPU stub is compiled
- **WHEN** `auto_pick()` runs in the default build
- **THEN** it returns the `cpu-stub` backend
- **AND** it logs the selected backend once at `tracing::info!`.

#### Scenario: Debug override
- **WHEN** a debug build sets `COLONY_EMBEDDER_FORCE=<name>`
- **THEN** `auto_pick()` tries that backend first for diagnostics
- **AND** release builds ignore the override.
