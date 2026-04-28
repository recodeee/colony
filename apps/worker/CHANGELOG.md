# @colony/worker

## 0.6.0

### Minor Changes

- e6c03f2: Add a plan publication lane on top of the existing task-thread + spec primitives. `task_plan_publish` writes a spec change document and opens one task thread per sub-task on `spec/<slug>/sub-N` branches, linking them via `metadata.parent_plan_slug`. Independent sub-tasks must not share file scopes; sequence overlapping work via `depends_on` (zero-based, must point at earlier indices). `task_plan_list` returns plan-level rollups with sub-task counts (`available | claimed | completed | blocked`) and a `next_available` list of unblocked, unclaimed sub-tasks; filterable by `repo_root`, `only_with_available_subtasks`, and `capability_match`. `task_plan_claim_subtask` claims an available sub-task race-safely (scan-before-stamp inside a SQLite transaction so two concurrent claims serialize through the write lock — first wins, second sees the prior claim observation and rejects with `PLAN_SUBTASK_NOT_AVAILABLE`); on success it joins the caller to the sub-task thread and activates file claims. `task_plan_complete_subtask` releases file claims and stamps a completion observation; downstream sub-tasks become available automatically. New observation kinds: `plan-subtask` (initial advertisement) and `plan-subtask-claim` (lifecycle transitions). New worker route `GET /api/colony/plans` exposes the same rollup to the read-only viewer. No schema migration; the lane composes over existing `task_thread` and `@colony/spec` primitives.
- Surface coordination drift in the worker viewer so release reviewers can see edits without claims, sessions without handoff, blockers without messages, and abandoned proposals from live telemetry instead of reconstructing them from raw timelines.
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

### Patch Changes

- 185a9d9: Extract shared `isMainEntry`, pidfile helpers, `isAlive`, and the
  `spawn(process.execPath, …)` wrapper into a new `@colony/process`
  package. These utilities had divergent copies in four places
  (`apps/cli/src/commands/lifecycle.ts`, `apps/cli/src/commands/worker.ts`,
  `apps/mcp-server/src/server.ts`, `apps/worker/src/server.ts`, and
  `packages/hooks/src/auto-spawn.ts`). The regex that decides whether
  Node should be invoked via `execPath` — the Windows EFTYPE guard —
  and the realpath-normalized bin-shim check both now live exactly once.

  No behavior change. Internal helper refactor only.

- c027e5d: Infer the IDE owner for sessions whose id is hyphen-delimited (e.g. `codex-colony-usage-limit-takeover-verify-...`). Previously `MemoryStore.ensureSession` hardcoded `ide = 'unknown'` and the hook-side inferrer only matched the `codex@...` / `claude@...` form, so every on-demand-materialised row landed as `unknown` in the viewer. The worker's session index now also shows an owner chip and re-infers legacy `unknown` rows at render time (italic + `?` suffix to signal the value is derived, not authoritative), and Hivemind lane cards tag the owner directly.
- Recover stranded session ownership by exposing rescue diagnostics through MCP and by letting the worker prepare relays for sessions whose owning agent vanished.
- Updated dependencies [e9e5587]
- Updated dependencies [5c9fa69]
- Updated dependencies [77b4e06]
- Updated dependencies [90bc096]
- Updated dependencies [af5d371]
- Updated dependencies [ed5a0b0]
- Updated dependencies [c027e5d]
- Updated dependencies [cfb6338]
- Updated dependencies [7e5a430]
- Updated dependencies [e6c03f2]
- Updated dependencies [9e559a4]
- Updated dependencies [b158138]
- Updated dependencies [beaf0f4]
- Updated dependencies [2f371d4]
- Updated dependencies [2aec9a9]
- Updated dependencies [49f7736]
- Updated dependencies [1fbc24e]
- Updated dependencies [754949f]
  - @colony/core@0.6.0
  - @colony/storage@0.6.0
  - @colony/config@0.6.0
  - @colony/process@0.6.0
  - @colony/embedding@0.6.0

## 0.5.0

### Patch Changes

- Updated dependencies
  - @colony/compress@0.5.0
  - @colony/config@0.5.0
  - @colony/core@0.5.0
  - @colony/embedding@0.5.0
  - @colony/storage@0.5.0

## 0.3.0

### Patch Changes

- Updated dependencies [eb4dad9]
- Updated dependencies [f1d036a]
- Updated dependencies [5f37e75]
- Updated dependencies [4076133]
- Updated dependencies [42dd222]
  - @colony/compress@0.3.0
  - @colony/config@0.3.0
  - @colony/core@0.3.0
  - @colony/embedding@0.3.0
  - @colony/storage@0.3.0

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

### Patch Changes

- Updated dependencies [416957b]
- Updated dependencies [99ca440]
- Updated dependencies [4af0d0d]
  - @colony/config@0.2.0
  - @colony/core@0.2.0
  - @colony/storage@0.2.0
  - @colony/embedding@0.2.0
  - @colony/compress@0.2.0
