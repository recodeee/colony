# @colony/config

## 0.7.0

### Patch Changes

- f769824: `quotaSafeOperatingContract` is rewritten as 7 dense paragraphs instead
  of 36 numbered bullets. Every protocol token (tool names, RTK command
  forms, section markers) and load-bearing phrase is preserved; only the
  prose framing is collapsed. The constant is injected into the
  SessionStart preface every IDE start, so the smaller payload reduces the
  per-session token tax without changing the contract agents must follow.

  `@colony/hooks` and `@colony/installers` re-export the constant
  unchanged; their existing test suites (token-anchored
  `QUOTA_SAFE_CONTRACT_TERMS` plus prose substring assertions) still pass.

- 43ef76a: Reduce burst load from many concurrent agents by coalescing SessionStart foraging scans and adding configurable active-session reconciliation throttling for MCP servers.
- 2a077ed: Add an optional Rust/Tantivy keyword search sidecar with SQLite FTS fallback.

## 0.6.0

### Minor Changes

- 90bc096: Add the foraging indexer and a storage-aware `scanExamples` wrapper.

  `indexFoodSource(food, store, opts)` converts a discovered `FoodSource`
  into 1–N `foraged-pattern` observations (manifest, README,
  entrypoints, filetree), scrubs env-assignment secrets through
  `redact`, and persists via `MemoryStore` so compression and the
  `<private>` tag stripper both run on the write path.

  `scanExamples({ repo_root, store, session_id, limits?, extra_secret_env_names? })`
  walks `<repo_root>/examples/*`, compares each discovered source's
  `content_hash` against `storage.getExample(...)`, and only re-indexes
  when the hash has shifted. Before re-indexing it calls the new
  `Storage.deleteForagedObservations(repo_root, example_name)` so the
  observation set never duplicates across scans.

  Two helpers on `Storage` to let the indexer (and the forthcoming MCP
  tool) work without opening the DB themselves:

  - `deleteForagedObservations(repo_root, example_name): number`
  - `listForagedObservations(repo_root, example_name): ObservationRow[]`

  New `settings.foraging` block (defaults: enabled, `maxDepth: 2`,
  `maxFileBytes: 200_000`, `maxFilesPerSource: 50`,
  `scanOnSessionStart: true`, `extraSecretEnvNames: []`). `colony config
show` and `settingsDocs()` pick it up automatically.

  No MCP tools, CLI commands, or hook wiring yet — those arrive in the
  next PR.

- b158138: Smoothness pack: macOS idle-sleep prevention, desktop notifier slot, and
  cross-task links.

  `@colony/process`:

  - New `notify({ level, title, body }, { provider, minLevel, log })` helper.
    `provider: 'desktop'` fans out to `osascript` on darwin / `notify-send` on
    linux; `'none'` is a no-op. Fire-and-forget: never awaits the spawned
    helper, never throws, never blocks a hot path. Spawn failures are reported
    via the optional `log` callback rather than crashing the caller.
  - Re-exports `NotifyLevel`, `NotifyMessage`, `NotifyOptions`, plus a
    `buildNotifyArgv` helper for testing.

  `@colony/config`:

  - New `notify` settings group: `provider: 'desktop' | 'none'` (default
    `'none'` so a fresh install is silent) and `minLevel: 'info' | 'warn' |
'error'` (default `'warn'`). Picked up automatically by `colony config
show` and `settingsDocs()`.

  `@colony/storage`:

  - Schema bumps to v8. New `task_links` table stores cross-task edges as one
    row per unordered pair (`low_id < high_id` enforced via CHECK), with
    `created_by`, `created_at`, and an optional `note`.
  - `Storage.linkTasks(p)` is idempotent — re-linking a pair preserves the
    original metadata. `Storage.unlinkTasks(a, b)` returns whether a row was
    removed. `Storage.linkedTasks(task_id)` returns the _other_ side of each
    edge with link metadata, regardless of which side originally linked.
  - Self-links (`task_id_a === task_id_b`) are rejected as a caller bug.
  - New types: `TaskLinkRow`, `NewTaskLink`, `LinkedTask`.

  `@colony/core`:

  - `TaskThread.linkedTasks()`, `TaskThread.link(other_task_id, created_by,
note?)`, `TaskThread.unlink(other_task_id)` — symmetric helpers around
    the storage primitives.

  `@colony/worker`:

  - New `apps/worker/src/caffeinate.ts` holds a `caffeinate -i -w <pid>`
    assertion on darwin while the embed loop is running, so a laptop lid-close
    or system idle doesn't suspend long-running embedding backfills. No-op on
    non-darwin and on missing binary; never started when the embedder failed
    to load (the worker is then just a viewer + state file writer).
  - Worker now emits a desktop notification via `@colony/process` when the
    embedder fails to load, so users see a real signal instead of a stderr
    line they may never read. Honours `settings.notify`.

  `@colony/mcp-server`:

  - New tools: `task_link(task_id, other_task_id, session_id, note?)`,
    `task_unlink(task_id, other_task_id)`, `task_links(task_id)`. Symmetric:
    callers don't need to think about ordering, and re-linking the same pair
    is idempotent.

  Inspired by patterns in agent-orchestrator (caffeinate, plugin-style
  notifier slot) and hive (worktree connections / cross-task linking).

## 0.5.0

### Minor Changes

- Sync linked release with the 0.4.0 MCP heartbeat bump so `@imdeadpool/colony`
  and the supporting `@colony/*` workspace packages publish together.

## 0.3.0

### Patch Changes

- eb4dad9: Rename the public CLI package and workspace package/import namespace from cavemem to Colony. The CLI binary is now `colony`, workspace imports use `@colony/*`, release scripts pack `colony`, and installed hook scripts call `colony`.

## 0.2.0

### Minor Changes

- 416957b: Wire embeddings end-to-end and make lifecycle obvious.

  **Embeddings (previously dead code) now work out of the box**

  - New `@colony/embedding` package exports `createEmbedder(settings)` with three providers: `local` (Transformers.js, default — `Xenova/all-MiniLM-L6-v2`, 384 dim), `ollama`, and `openai`. `@xenova/transformers` is an optional dependency: installs automatically with `npm install -g cavemem` on supported platforms, falls back gracefully otherwise.
  - The worker now runs an embedding backfill loop: polls `observationsMissingEmbeddings`, embeds the expanded (human-readable) text, persists. On startup it drops rows whose model differs from settings so switching providers never pollutes cosine ranking.
  - Storage gains a model/dim filter on `allEmbeddings()` plus `dropEmbeddingsWhereModelNot`, `countObservations`, `countEmbeddings`, and a model-scoped variant of `observationsMissingEmbeddings`.
  - The `Embedder` interface in `@colony/core` now exposes `model` and `dim` so the store can reject mismatched rows before cosine computation.
  - Both the CLI `search` command and the MCP `search` tool instantiate the embedder lazily and pass it into `MemoryStore.search`. Semantic search is on by default; `cavemem search --no-semantic` bypasses it.
  - Worker writes a `worker.state.json` snapshot after every batch so `cavemem status` can show "embedded 124 / 200 (62%)" without hitting HTTP.

  **Lifecycle (previously unclear) is now ergonomic**

  - Hooks auto-spawn the worker detached + pidfile-guarded when it is not running (fast path < 2 ms; full `stat` + `process.kill(pid, 0)` probe). Respects `CAVEMEM_NO_AUTOSTART` for deterministic tests. Skipped when `embedding.autoStart=false` or `provider=none`.
  - Worker idle-exits after `embedding.idleShutdownMs` (default 10 min) of no embed work and no viewer traffic. No launchd/systemd integration needed.
  - New top-level `cavemem start`, `cavemem stop`, `cavemem restart`, and `cavemem viewer` commands — thin wrappers around the existing pidfile-managing implementation.

  **Config UX**

  - New `cavemem status` top-level command: single-pane dashboard showing settings path, data dir, DB counts, installed IDEs, embedding provider/model, backfill progress, worker pid and uptime.
  - New `cavemem config show|get|set|open|path|reset` command backed by zod `.describe()` — the schema is self-documenting; no parallel docs to maintain.
  - New `settingsDocs()` export from `@colony/config` returns `[{path, type, default, description}]` for every field.
  - `cavemem install` now prints a multi-line "what to try next" block explaining that there is no daemon to start, and surfaces the embedding model + weight-download cost.
  - Settings schema gains `embedding.batchSize`, `embedding.autoStart`, and `embedding.idleShutdownMs` — every field now has a `.describe(...)` string.

  **MCP server**

  - Lazy-singleton embedder resolution — MCP handshake stays fast; model loads on first `search` tool call.
  - New `list_sessions` tool.

  **Non-negotiable rule update**

  - CLAUDE.md now documents the "no daemon on the write path" invariant: hooks may detach-spawn the worker but must never wait on it; observations write synchronously.
