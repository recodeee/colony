# Proposal

## Why

Colony search currently does keyword candidate retrieval through SQLite FTS5 in
the Node process. That is a good default, but the target p95 gets harder as the
local memory DB grows and semantic reranking has to start from a larger
candidate pool.

## What

- Add an optional Rust `colony-search` sidecar that builds a Tantivy index from
  the existing SQLite observations table.
- Keep SQLite FTS5 as the default and fallback path.
- Route only read-side keyword candidate search through Rust; the write path
  remains `MemoryStore -> Storage -> SQLite`.
- Add config/env/CLI/API switches to enable, require, or disable Rust search.
- Keep semantic reranking in the existing TypeScript path.

## Impact

Default installs keep current behavior. Operators who install the Rust binary
can enable faster keyword candidate search without changing the memory DB
schema or observation writes.
