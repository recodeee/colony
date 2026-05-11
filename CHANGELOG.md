# Changelog

## Unreleased

### Changed

- Batch embedding backfill work in 32-observation chunks, call embedder batch APIs when available, and persist each chunk in one SQLite transaction.

### Added

- Add the `colony-embedder` Rust crate with an `EmbedderBackend` trait,
  startup-time backend auto-pick, one-time selection logging, and a deterministic
  `cpu-stub` fallback.
