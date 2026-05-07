# Faster Search Path

## Problem

Colony search can pay avoidable startup and vector-scan cost on common keyword queries. The CLI search path also opens the store in write mode even though it only reads memory.

## Change

- Open CLI search stores in readonly mode.
- Keep SQLite FTS as the first search layer.
- Bound semantic reranking to FTS candidate observation ids when FTS already fills the requested result cap.
- Preserve full-vector semantic fallback when FTS does not fill the cap.
- Add an optional Rust/Tantivy read-side keyword layer behind safe default-off config, env, CLI, and worker API controls.
- Fall back to SQLite FTS when optional Rust search is missing, failing, or returns invalid output.
- Ignore the local external `examples/claude-obsidian/` working source so the base tree stops showing unrelated dirt.

## Acceptance

- Keyword-filled searches do not call the full embedding scan.
- Sparse keyword searches can still use full-vector fallback.
- CLI `colony search` can read memory without schema/migration writes.
- Default installs require no Rust sidecar; `--rust` / `rust=required` surfaces explicit sidecar failures.
- `examples/claude-obsidian/` no longer appears as an untracked repo change after the ignore lands.

## Verification

- `pnpm --filter @colony/storage test -- storage.test.ts`: 35 passed.
- `pnpm --filter @colony/config test -- schema.test.ts`: 7 passed.
- `pnpm --filter @colony/core test -- memory-store-search.test.ts`: 9 passed.
- `pnpm --filter @colony/worker test -- server.test.ts`: 40 passed.
- `pnpm --filter @imdeadpool/colony-cli test -- config.test.ts program.test.ts`: 22 passed.
- `pnpm --filter @colony/core build`: passed.
- `pnpm --filter @colony/worker build`: passed.
- `pnpm --filter @imdeadpool/colony-cli build`: passed.
- `cargo check --offline --manifest-path crates/colony-search/Cargo.toml`: passed.
- `cargo test --offline --manifest-path crates/colony-search/Cargo.toml`: passed.
- `node apps/cli/dist/index.js search "colony search" --no-semantic --limit 2`: passed, no readonly write error.
- `biome check` on touched TypeScript files: passed.
- `git diff --check`: passed.
- `openspec validate --specs`: 2 passed.
- `openspec validate agent-codex-speed-colony-search-regex-layer-2026-05-06-23-19 --strict`: passed.
- Focused typecheck note: `@colony/config` passed; `@colony/core`, `@colony/storage`, `@colony/worker`, and `@imdeadpool/colony-cli` are blocked by existing `better-sqlite3` declaration resolution. `@colony/worker` also reports pre-existing savings-viewer fixture type drift.
