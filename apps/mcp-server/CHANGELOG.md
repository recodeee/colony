# @colony/mcp-server

## 0.5.0

### Patch Changes

- Updated dependencies
  - @colony/compress@0.5.0
  - @colony/config@0.5.0
  - @colony/core@0.5.0
  - @colony/embedding@0.5.0
  - @colony/hooks@0.5.0

## 0.4.0

### Minor Changes

- Register the MCP caller in hivemind on startup and on every tool call. When a
  client (e.g. codex) attaches to the colony stdio server without ever running
  colony's lifecycle hooks, the server now writes / refreshes
  `.omx/state/active-sessions/<session_id>.json` using the caller's cwd plus a
  session id derived from `CODEX_SESSION_ID`, `CLAUDECODE_SESSION_ID`,
  `CLAUDE_SESSION_ID`, `COLONY_CLIENT_SESSION_ID`, or a per-parent-process
  fallback. Existing hook-written heartbeats are preserved — the writer never
  overwrites a richer task preview with a blank one.

  Exposes `upsertActiveSession` / `removeActiveSession` from `@colony/hooks` so
  other non-hook runtimes can reuse the same writer.

### Patch Changes

- Updated dependencies
  - @colony/hooks@0.4.0

## 0.3.0

### Minor Changes

- f853481: Add a compact `hivemind` MCP tool that maps active proxy-runtime agent sessions to their current tasks.
- 4076133: Add proposal system: pre-tasks that auto-promote via collective reinforcement. Agents call `task_propose` to surface a candidate improvement; other agents call `task_reinforce` (kind `explicit` or `rediscovered`), and PostToolUse adds weak `adjacent` reinforcement whenever an edit touches a file listed in a pending proposal's `touches_files`. Total decayed strength (1-hour half-life, weights 1.0 / 0.7 / 0.3 by kind) is recomputed on every read; when it crosses `PROMOTION_THRESHOLD` (2.5), the proposal is auto-promoted to a real `TaskThread` on a synthetic branch `{branch}/proposal-{id}`. The new `task_foraging_report` MCP tool lists pending (above the 0.3 noise floor) and promoted proposals; `SessionStart` surfaces the same report in-preface. Schema bumped 4 → 5: adds `proposals` and `proposal_reinforcements`.
- 42dd222: Add response-threshold routing for broadcast (`to_agent: 'any'`) handoffs. Each agent identity (Claude, Codex, …) can register a capability profile (`ui_work`, `api_work`, `test_work`, `infra_work`, `doc_work`, each `0..1`) via the new `agent_upsert_profile` MCP tool; unknown agents default to `0.5` across all dimensions. When `TaskThread.handOff` runs with `to_agent: 'any'`, it snapshots a keyword-weighted ranking of every non-sender participant into `HandoffMetadata.suggested_candidates`. `SessionStart` preface surfaces the top match and the viewing agent's own score inline with each pending broadcast handoff, so receivers can see at a glance whether they are the best fit. New `agent_get_profile` MCP tool exposes read-only inspection. Schema bumped 5 → 6: adds `agent_profiles` table.

### Patch Changes

- Fix `colony mcp` never starting the stdio server.

  `apps/mcp-server/src/server.ts` gated `main()` behind an `isMainEntry()` check
  so it only ran when executed directly. The CLI `mcp` command invoked it via
  `await import('@colony/mcp-server')`, which triggered the guard (entry was
  the CLI binary, not `server.js`) and skipped `main()` — the process exited
  immediately after the dynamic import, causing IDE clients (Codex, Claude
  Code) to fail the MCP handshake with "connection closed: initialize
  response".

  `main` is now exported from the server module and invoked explicitly by the
  CLI command.

- Updated dependencies [eb4dad9]
- Updated dependencies [5f37e75]
- Updated dependencies [4076133]
- Updated dependencies [42dd222]
  - @colony/compress@0.3.0
  - @colony/config@0.3.0
  - @colony/core@0.3.0
  - @colony/embedding@0.3.0

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
- Updated dependencies [4af0d0d]
  - @colony/config@0.2.0
  - @colony/core@0.2.0
  - @colony/embedding@0.2.0
  - @colony/compress@0.2.0
