# colony — Agent Playbook

This file is the source of truth for AI coding assistants working on this repository. Follow it before generating code, tests, or documentation. If a request conflicts with this file, pause and ask.

## Project identity

colony is a cross-agent persistent memory system for coding assistants. It captures observations from editor sessions, compresses prose using the project's deterministic caveman grammar, stores entries in a local SQLite + vector index, and exposes them to agents through a Model Context Protocol (MCP) server and a local web viewer.

The signature property of the project is that **memory is stored compressed**. Every write path runs text through `@colony/compress`. Every human-facing read path runs it back through `@colony/compress#expand`. Model-facing reads may keep content compressed when the caller requests it.

## Non-negotiable rules

1. **Use relative paths before absolute paths.** For file reads, edits, searches, and command arguments inside this repository, use paths relative to the current worktree first, such as `CLAUDE.md` or `packages/storage/src/index.ts`. Use absolute paths only when crossing repo/worktree boundaries or when a tool explicitly requires them.
2. **All persisted prose must pass through `packages/compress` before hitting storage.** Writing raw prose to SQLite is a defect. If you add a new write path, it must use `MemoryStore`, which enforces this.
3. **Never compress technical tokens.** Code blocks, inline code, URLs, file paths, shell commands, version numbers, dates, numeric literals, and quoted identifiers are preserved byte-for-byte. The tokenizer in `packages/compress/src/tokenize.ts` is the single authority.
4. **Round-trip tests must pass.** Any change to the compressor, the lexicon, or the tokenizer requires `pnpm --filter @colony/compress test` green, including the technical-token preservation suite.
5. **Progressive disclosure in MCP.** `search` and `timeline` return compact results (IDs + snippets). Full observation bodies are only returned by `get_observations(ids[])`. Do not bloat the compact shapes.
6. **Hot-path hooks are fast.** Hook handlers in `packages/hooks` must complete under 150 ms p95. Summarization, embedding, and indexing are handed off to the worker. No network calls in hooks.
7. **Privacy is enforced at the write boundary.** Content inside `<private>…</private>` tags is stripped. Paths matching `settings.excludePatterns` are never read. Neither appears in logs.
8. **Local by default.** Default embedding provider is local (Transformers.js). Remote providers are opt-in via settings. Do not add default network calls.
9. **No silent failures.** Hook and worker errors are logged as structured JSON; user-visible commands surface failures with a non-zero exit code and a short message.
10. **No daemon on the write path.** Hooks write observations synchronously through `MemoryStore.addObservation` — never across a network or HTTP boundary. Hooks may *detach-spawn* the worker to kick off background embedding, but they must never wait on it. If the worker is down, writes still succeed; only the semantic-search side is degraded (BM25 keeps working).
11. **Never edit on the local base branch.** Treat the local `main` checkout as read-only. Every task — even a typo or one-line fix — runs on a dedicated `agent/*` branch inside a worktree. Do not run `git checkout main` / `git switch main` to start work, do not `git commit` on the primary working tree, and do not push to `main` directly. This matches what codex does via Guardex and keeps parallel lanes safe.

## Worktree discipline

Claude Code works the same way Codex does in this repo: isolated `agent/*` branches in worktrees, never on the primary checkout.

- **Start a lane before editing.** `gx branch start "<task>" "claude-code"` (alias: `guardex branch start ...`). Optionally pass `--tier T0|T1|T2|T3`. Work only inside the resulting `.omc/agent-worktrees/...` directory.
- **Tier routing.** `T0` = typo / format / comment-only. `T1` = ≤5 files, one capability, no API or schema change. `T2` = behavior / API / schema / multi-module. `T3` = cross-cutting or plan-driven. Default small-fix posture is `T0` / `T1`.
- **Claim files before touching them.** `gx locks claim --branch "<agent-branch>" <file...>`. Release on completion.
- **Never switch the primary checkout.** If currently on `main`, create the lane first; the worktree must not flip the primary tree's branch. A `post-checkout` hook reverts accidental primary-branch switches — do not bypass it except via an explicit approved override.
- **Finish via PR, not a direct push.** `gx branch finish --branch "<agent-branch>" --base main --via-pr --wait-for-merge --cleanup`. A lane is only complete when: commit pushed → PR opened → `MERGED` → worktree pruned.
- **Resume the existing lane.** If an `agent/claude/...` branch or worktree is already open for this task/chat, continue in it instead of opening a new lane. Only start a fresh lane when no matching one exists or the user explicitly splits scope.
- **Coordinate via colony MCP.** Post `task_post` notes, use `task_claim_file` for shared files, and `task_hand_off` for ownership transfers so codex/claude sessions stay aligned.

## Architectural rules

- Monorepo with pnpm workspaces. Dependency direction is strictly downward: `apps/*` may depend on `packages/*`; `packages/*` may depend on each other only in the order `process → config → compress → storage → { core, embedding } → hooks → installers`. (`core` and `embedding` are siblings — both consume `config` and `storage`, neither depends on the other. `process` has no upstream deps — only `node:` builtins.) No upward or sideways imports that break this order.
- All database I/O goes through `@colony/storage`. No other package opens the DB directly.
- Settings access goes through `@colony/config`. No direct reads from `~/.colony/settings.json` elsewhere.
- All user-visible strings default to the caveman intensity from settings (default `full`).
- Public package exports are listed in each package's `package.json#exports`. Internal files are not imported across package boundaries.

## Layout

```
apps/cli          user-facing binary
apps/worker       local HTTP daemon: read-only viewer + embedding backfill loop
apps/mcp-server   stdio MCP server
packages/process  shared pidfile / spawn / isMainEntry helpers (no deps)
packages/config   settings schema, loader, defaults, settingsDocs()
packages/compress compression engine + lexicon
packages/storage  SQLite + FTS5 + vector adapter
packages/core     domain models, MemoryStore facade, Embedder interface
packages/embedding provider factory (local / ollama / openai / none)
packages/hooks    lifecycle hook handlers + worker auto-spawn
packages/installers per-IDE integration modules
viewer            Vite + React read-only UI
hooks-scripts     portable shell stubs that invoke node handlers
docs              architecture + user docs
evals             token-savings and round-trip harness
```

## Development workflow

- `pnpm install` once. Node ≥ 20.
- `pnpm dev` runs the CLI and worker in watch mode against `.colony-dev/` in the repo root (isolated data dir).
- The four required gates before merging:
  - `pnpm typecheck`
  - `pnpm lint`
  - `pnpm test`
  - `pnpm build`
- New features require unit tests. Any change that affects MCP contracts requires an integration test via the MCP inspector.
- Every PR touching a package under `packages/*` or `apps/*` needs a changeset entry (`pnpm changeset`).

## End-to-end publish test

Unit tests cover handlers, storage, and protocol contracts in isolation. They cannot catch issues that only show up in a globally-installed binary: bin-shim symlink resolution, ESM chunk shebangs, `prepublishOnly` staging, native `better-sqlite3` resolution, dynamic-import bundling. Those failure modes have bitten this repo before — they are now guarded by a dedicated script.

- `bash scripts/e2e-publish.sh` — covers the **changeset publish** path (CI default). Builds, packs (mirroring what `changeset publish` ships), installs into an isolated `.e2e/` prefix with an isolated `$HOME`, drives every Claude Code hook event with a realistic payload, exercises FTS search and the MCP server, then uninstalls. Self-cleans on success. Required to pass in CI before `changeset publish` runs.
- `bash scripts/e2e-pack-release.sh` — covers the **`pnpm publish:release`** path (legacy bespoke flow that uses `apps/cli/scripts/pack-release.mjs` to write `apps/cli/release/`). Run this if you change `pack-release.mjs` or the `dependencies` block of `apps/cli/package.json`.
- The 15 numbered checks in `e2e-publish.sh` must stay green. If you change anything in `apps/cli/`, `packages/installers/`, the hook handler stdout/stderr contract, or the publish surface, re-run it locally before opening a PR.
- Touching the tsup config, the `prepublishOnly` script, or the bin entrypoint guards (`isMainEntry()`) without re-running both scripts is a defect.

## Extension points

- **New IDE integration**: add a module in `packages/installers/src/` that implements the `Installer` interface (`detect`, `install`, `uninstall`, `status`) and register it in the installer index. Update the CLI `install` command choices.
- **New MCP tool**: register in `apps/mcp-server/src/server.ts`, document contract in `docs/mcp.md`, add an inspector test fixture.
- **New compression rule**: update `packages/compress/src/lexicon.json`, add at least one round-trip fixture under `packages/compress/test/fixtures/`, and re-run the benchmark in `evals/`.
- **New embedding provider**: add a module in `packages/embedding/src/providers/`, wire it into the `createEmbedder` switch in `packages/embedding/src/index.ts`, and extend the `EmbeddingProvider` enum in `packages/config/src/schema.ts`. Each provider must expose `{ model, dim, embed(text) }` — `dim` must be correct before the first `embed()` call completes (warm-up probe).
- **New storage migration**: add a numbered SQL file in `packages/storage/src/migrations/`. Migrations are forward-only.
- **New CLI setting**: add the field to `SettingsSchema` with a `.describe(…)` string. `colony config show` and `settingsDocs()` pick it up automatically — no parallel docs to maintain.

## Performance budgets

- Hook handler p95 runtime: 150 ms.
- `search` MCP call p95: 50 ms for up to 50k observations.
- Compression throughput: ≥ 5 MB/s on one core.
- Worker cold start: ≤ 500 ms on Node, ≤ 100 ms on Bun.

## Release policy

- Versioning via changesets. Releases are cut by GitHub Actions (`.github/workflows/release.yml`) on merge to `main` when a release changeset exists. Publishing from a laptop is not allowed.
- Conventional Commits for commit messages. PRs require passing CI and one review.

## Authorship voice

Code comments are minimal and explain **why**, not what. Keep naming explicit. Prefer pure functions. Avoid adding dependencies when the standard library or an existing package covers the need.
