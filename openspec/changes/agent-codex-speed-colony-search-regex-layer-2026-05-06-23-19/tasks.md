# Tasks

- [x] Add Rust search configuration with safe defaults.
- [x] Add TypeScript sidecar adapter and fallback behavior.
- [x] Add Rust Tantivy search crate.
- [x] Wire CLI and worker search controls.
- [x] Add focused tests and docs.
- [x] Run targeted tests, typecheck, and OpenSpec validation.
- [ ] Finish PR, merge, and sandbox cleanup; record PR URL and `MERGED` evidence.

## Verification

- Replayed and squashed the old speed-search commits onto current `main` in `agent/codex/finish-speed-colony-search-regex-layer-2026-05-07-11-14`; resolved the `apps/cli/src/commands/config.ts` conflict by keeping the current zod-v3/v4 schema walker and the Rust-search settings.
- Fixed the old `packages/storage/test/storage.test.ts` syntax regression before rerunning verification.
- `pnpm --filter @colony/config test`: 7 passed.
- `pnpm --filter @colony/storage test -- storage.test.ts`: 35 passed.
- `pnpm --filter @colony/core test -- memory-store-search.test.ts`: 9 passed.
- `pnpm --filter @colony/worker test -- server.test.ts`: 40 passed.
- `pnpm --filter @imdeadpool/colony-cli test -- config.test.ts`: 8 passed.
- `pnpm --filter @imdeadpool/colony-cli typecheck`: passed.
- `pnpm --filter @colony/core typecheck`: passed.
- `pnpm --filter @colony/storage typecheck`: passed.
- `pnpm --filter @colony/config typecheck`: passed.
- `cargo check --manifest-path crates/colony-search/Cargo.toml`: passed.
- `cargo test --manifest-path crates/colony-search/Cargo.toml`: passed.
- `pnpm exec biome check` on touched TypeScript files: passed.
- `openspec validate --specs`: 2 passed.
- `openspec validate agent-codex-speed-colony-search-regex-layer-2026-05-06-23-19 --strict`: passed.
- `pnpm --filter @colony/worker typecheck`: blocked by baseline `test/savings-viewer.test.ts` fixture drift already present on `main` (`McpMetricsAggregateRow` now requires success/error token fields).
