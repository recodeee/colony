# @colony/hooks

## 0.7.0

### Minor Changes

- 6bfc818: Surface a `claim_required: true` flag on `task_ready_for_agent` whenever
  the response carries a claimable plan sub-task or quota-relay handoff
  that the calling agent should follow up on with
  `task_plan_claim_subtask` (or `task_claim_quota_accept`). Loop adoption
  sat at 0% across sessions because the queue response only carried a
  hint inside `next_action`; agents that stopped reading at the result
  shape skipped the claim. The new boolean lets clients gate work
  selection on the explicit signal.

  SessionStart now appends a one-line `## Ready Queen sub-tasks` preface
  when the active repo has unclaimed plan sub-tasks, listing the count
  and reminding the agent to follow `task_ready_for_agent` with
  `task_plan_claim_subtask`. The nudge is silent when no cwd is detected,
  no real `(repo_root, branch)` resolves, or no plan has unclaimed work.

### Patch Changes

- 77c9e30: Make PreToolUse auto-claim coverage observable and surface hook-wiring problems instead of agent-discipline ones.

  - The Claude installer now scopes PreToolUse and PostToolUse to a write-tool matcher so the hook does not fire (or get blamed) for unrelated tools.
  - `colony hook run pre-tool-use` now writes its warning back through Claude Code's PreToolUse `permissionDecision: allow` so the agent sees the missing-claim warning instead of it being silently dropped on stderr.
  - The pre-tool-use warning embeds a concrete `next_call` (an exact `mcp__colony__task_claim_file({...})` invocation) and a multi-line actionable `message`, so an agent that hits ACTIVE_TASK_NOT_FOUND / AMBIGUOUS_ACTIVE_TASK / SESSION_NOT_FOUND knows exactly what to do.
  - `claimBeforeEditStats` adds a `pre_tool_use_signals` count of `claim-before-edit` telemetry rows in the window. `colony health` and `hivemind_context`'s claim-before-edit nudge use it to distinguish "hook is not firing" from "agent skipped the claim", and emit an install/restart hint in the former case.
  - `colony health` also reports explicit/manual vs auto-claim breakdown and reads "had a claim before edit" instead of "explicit claims first".

- 43ef76a: Reduce burst load from many concurrent agents by coalescing SessionStart foraging scans and adding configurable active-session reconciliation throttling for MCP servers.
- 99b9715: Make PreToolUse auto-claim work for fresh sessions in real worktrees.
  Previously, sessions that hadn't joined any Colony task (e.g. external
  agents in `agent/...` worktrees that share Colony as a memory backend)
  hit `ACTIVE_TASK_NOT_FOUND` on every edit, leaving the
  `claim-before-edit` health metric stuck at 0% even when PreToolUse
  signals fired correctly. PreToolUse now mirrors the existing PostToolUse
  fallback: when the session has no candidate task and the working tree
  resolves to a real `(repo_root, branch)`, it materializes a TaskThread
  on that branch and joins the session before retrying the auto-claim.
  Sessions without a real checkout keep the existing
  `ACTIVE_TASK_NOT_FOUND` warning so callers still see actionable
  guidance instead of silent synthetic-task creation.
- 36bd261: Trim the session-start "Joined with" line and the per-turn conflict
  preface so they stop scaling with all-time-joined participants and full
  agent-worktree paths. Long-running task threads were spending hundreds
  of tokens on stale session lists every resume; the conflict preface was
  spending hundreds more per turn on duplicated worktree prefixes. Cap
  joined-with at 8 entries with `+N more` overflow, gate by a 1-hour
  last-activity window, and strip `.omx|.omc/agent-worktrees/<dir>/`
  from claimed file paths plus collapse session ids to their 8-char
  shorthand.
- Updated dependencies [b937fb7]
- Updated dependencies [6b09a3d]
- Updated dependencies [f769824]
- Updated dependencies [7d86bd2]
- Updated dependencies [cb4c9f9]
- Updated dependencies [43ef76a]
- Updated dependencies [46d0153]
- Updated dependencies [36e95ba]
- Updated dependencies [528b5ba]
- Updated dependencies [9424987]
- Updated dependencies [a27c52c]
- Updated dependencies [2a077ed]
- Updated dependencies [08e4700]
- Updated dependencies [2ddc284]
- Updated dependencies [7d86bd2]
- Updated dependencies [fa4e1a3]
- Updated dependencies [919cc9b]
  - @colony/core@0.7.0
  - @colony/config@0.7.0

## 0.6.0

### Minor Changes

- f8f1bcc: Finish the foraging loop: users get a `colony foraging` command group
  and SessionStart auto-scans in the background.

  CLI (`@imdeadpool/colony-cli`):

  - `colony foraging scan [--cwd <path>]` — synchronous scan of
    `<cwd>/examples` that re-indexes changed food sources and leaves
    unchanged ones alone. Respects every field in `settings.foraging.*`.
  - `colony foraging list [--cwd <path>]` — prints the cached example
    rows (name, manifest kind, observation count, last-scanned date).
  - `colony foraging clear [--example <name>] [--cwd <path>]` — drops
    example rows and their foraged-pattern observations.

  Hooks (`@colony/hooks`):

  - `sessionStart` now detach-spawns `colony foraging scan --cwd <cwd>`
    via `@colony/process#spawnNodeScript` when `settings.foraging.enabled`
    and `scanOnSessionStart` are both true. The hook never waits on it —
    the synchronous preface only surfaces state from previous scans,
    keeping the 150 ms p95 budget intact.
  - New `buildForagingPreface(store, input)` injects a compact
    "## Examples indexed (foraging)" block when cached examples exist
    for the current cwd: lists up to 5 example names with an overflow
    count, and points agents at `examples_query` /
    `examples_integrate_plan`.

  Closes the foraging roadmap: agents can now discover, query, and plan
  integrations against `<repo_root>/examples` without a manual step.

- Make edit hooks claim files automatically after successful write tools so the hook layer records observed ownership even when agents forget to claim manually.
- 754949f: Add wake-request primitive and attention inbox for idle/stalled cross-agent nudges.

  - `task_wake` / `task_ack_wake` / `task_cancel_wake` MCP tools post lightweight nudges on a task thread — no claim transfer, no baton pass. Targets see the request on their next SessionStart or UserPromptSubmit turn with a copy-paste-ready ack call.
  - `attention_inbox` MCP tool + `colony inbox` CLI command aggregate pending handoffs, pending wakes, stalled lanes from the hivemind snapshot, and recent other-session file claims into one compact view. Bodies are not expanded; fetch via `get_observations`.
  - Hook injection extended: `buildTaskPreface` surfaces pending wake requests alongside pending handoffs; `buildTaskUpdatesPreface` inlines an ack call for wake requests that arrive between turns.

  Deferred follow-ups (not in this change): safe session takeover, claim TTL renewal, session Stop checkpoint, and any terminal-control wake mechanism.

### Patch Changes

- Remove stale `task_ack_wake` guidance from hook prefaces now that wake MCP tools are retired; pending wake observations remain visible, but agents are routed to `task_message` / `task_post`.
- 1b076d8: Remind Claude Code to read existing files before edit tools so Update/Edit/MultiEdit calls do not stop with "File must be read first".
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
- Mirror built-in TaskCreate and TaskUpdate calls into Colony task observations so task activity is visible without changing agent tool habits.
- Record Bash git and file operations as coordination observations so checkout, branch, merge, rm, mv, cp, and redirect side effects show up in debrief and timeline evidence.
- Reveal Bash coordination writes from PostToolUse by keeping git/file operation observations separate from redirect auto-claims.
- Updated dependencies [e9e5587]
- Updated dependencies [90bc096]
- Updated dependencies [af5d371]
- Updated dependencies [ed5a0b0]
- Updated dependencies [c027e5d]
- Updated dependencies [cfb6338]
- Updated dependencies [7e5a430]
- Updated dependencies [e6c03f2]
- Updated dependencies [9e559a4]
- Updated dependencies [b158138]
- Updated dependencies [2aec9a9]
- Updated dependencies [49f7736]
- Updated dependencies [1fbc24e]
- Updated dependencies [754949f]
  - @colony/core@0.6.0
  - @colony/config@0.6.0
  - @colony/process@0.6.0

## 0.5.0

### Patch Changes

- Updated dependencies
  - @colony/config@0.5.0
  - @colony/core@0.5.0

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

## 0.3.0

### Minor Changes

- 5f37e75: Add pheromone trails: ambient decaying activity signal per (task, file, session). `PostToolUse` deposits pheromone on every write-tool invocation; strength decays exponentially (10-minute half-life, cap 10.0). The new `UserPromptSubmit` preface warns when another session has a strong trail on a file the current session has also touched, complementing the existing claim-based preface with a graded intensity signal that doesn't fire for stale collisions. Schema bumped to version 4 — adds `pheromones` table with FK cascade on sessions and tasks.
- 4076133: Add proposal system: pre-tasks that auto-promote via collective reinforcement. Agents call `task_propose` to surface a candidate improvement; other agents call `task_reinforce` (kind `explicit` or `rediscovered`), and PostToolUse adds weak `adjacent` reinforcement whenever an edit touches a file listed in a pending proposal's `touches_files`. Total decayed strength (1-hour half-life, weights 1.0 / 0.7 / 0.3 by kind) is recomputed on every read; when it crosses `PROMOTION_THRESHOLD` (2.5), the proposal is auto-promoted to a real `TaskThread` on a synthetic branch `{branch}/proposal-{id}`. The new `task_foraging_report` MCP tool lists pending (above the 0.3 noise floor) and promoted proposals; `SessionStart` surfaces the same report in-preface. Schema bumped 4 → 5: adds `proposals` and `proposal_reinforcements`.
- 42dd222: Add response-threshold routing for broadcast (`to_agent: 'any'`) handoffs. Each agent identity (Claude, Codex, …) can register a capability profile (`ui_work`, `api_work`, `test_work`, `infra_work`, `doc_work`, each `0..1`) via the new `agent_upsert_profile` MCP tool; unknown agents default to `0.5` across all dimensions. When `TaskThread.handOff` runs with `to_agent: 'any'`, it snapshots a keyword-weighted ranking of every non-sender participant into `HandoffMetadata.suggested_candidates`. `SessionStart` preface surfaces the top match and the viewing agent's own score inline with each pending broadcast handoff, so receivers can see at a glance whether they are the best fit. New `agent_get_profile` MCP tool exposes read-only inspection. Schema bumped 5 → 6: adds `agent_profiles` table.

### Patch Changes

- eb4dad9: Rename the public CLI package and workspace package/import namespace from cavemem to Colony. The CLI binary is now `colony`, workspace imports use `@colony/*`, release scripts pack `colony`, and installed hook scripts call `colony`.
- f1d036a: Bind hook-created sessions back to their repository cwd so colony views can see live Codex/Claude work instead of orphan `cwd: null` sessions.
- Updated dependencies [eb4dad9]
- Updated dependencies [5f37e75]
- Updated dependencies [4076133]
- Updated dependencies [42dd222]
  - @colony/config@0.3.0
  - @colony/core@0.3.0

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

- 99ca440: Fix the Claude Code hook integration end-to-end and harden the npm publish path. With these changes the memory system actually works after `npm install -g cavemem` — verified by the new `scripts/e2e-publish.sh` test that packs the artifact, installs it into an isolated prefix, and drives every hook event with realistic Claude Code payloads.

  **Hook protocol**

  - Handlers now read the field names Claude Code actually sends — `tool_name`, `tool_response`, `last_assistant_message`, `source`, `reason` — while keeping the legacy aliases (`tool`, `tool_output`, `turn_summary`) for non-Claude IDEs and existing tests.
  - The CLI no longer dumps internal telemetry JSON onto stdout. That JSON was being injected verbatim into the agent's context as `additionalContext` for `SessionStart` / `UserPromptSubmit`. Telemetry now goes to stderr; stdout carries Claude Code's `{ "hookSpecificOutput": { "hookEventName": "...", "additionalContext": "..." } }` shape only when there is real context to surface.
  - `Storage.createSession` is now `INSERT OR IGNORE`, and `SessionStart` skips the prior-session preface for non-startup sources, so resume / clear / compact no longer crash with PK conflicts.
  - The Claude Code installer writes `cavemem hook run <name> --ide claude-code`, and the CLI's `hook run` accepts `--ide` so handlers know who invoked them (Claude Code itself never sends an `ide` field).

  **Publishable artifact**

  - `cavemem` no longer lists the private `@colony/mcp-server` and `@colony/worker` packages as runtime dependencies. Tsup already bundles every `@colony/*` module via `noExternal`, so the workspace deps moved to `devDependencies` and `npm install cavemem` resolves cleanly.
  - The bin entrypoint guard (`isMainEntry()`) now compares realpaths via `pathToFileURL(realpathSync(...))`, so the binary works when invoked through npm's symlinked `bin/` shim — previously `--version` and every other command silently exited 0 with no output.
  - Tsup's `banner` option was producing two `#!/usr/bin/env node` lines in every dynamic-import chunk (one from the source file, one from the banner), which broke `cavemem mcp` with `SyntaxError: Invalid or unexpected token`. The banner is gone; the shebang lives in the source files that need it.
  - A new `prepublishOnly` script (`apps/cli/scripts/prepack.mjs`) stages `README.md`, `LICENSE`, and `hooks-scripts/` into `apps/cli/` so `changeset publish` produces a complete tarball. The script no-ops outside the source repo so installing the tarball never re-runs it.
  - The root workspace package was renamed from `cavemem` to `cavemem-monorepo` (still `private:true`) to remove a name collision that caused `pnpm --filter cavemem` to match the root instead of the publishable cli package.

  **CI**

  - The release workflow now runs all four gates (`pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`) and the new `bash scripts/e2e-publish.sh` end-to-end check before `changeset publish` is allowed to publish.

- 7278a69: Fix `spawn EFTYPE` on Windows and unblock installs on Windows end-to-end.

  **Root cause**

  The CLI's `process.argv[1]` (and everything `resolveCliPath()` derives from it) is the `.js` entry file, not a native executable. Node's `child_process.spawn` cannot exec a raw `.js` on Windows — it has no associated binfmt handler, so the launcher bubbles up `EFTYPE`. Every background code path that self-spawned the CLI — `cavemem start`, `cavemem restart`, `cavemem viewer`, and the hook auto-spawn in `@colony/hooks` — hit this, so the worker never started and hooks stayed degraded with no embeddings. The installers then wrote the same bad shape into IDE configs (`command: <cliPath.js>` for MCP servers; `"<cliPath.js> hook run …"` as a shell string for Claude Code hooks), so even opening Claude Code / Cursor / Codex / Gemini / OpenCode could not launch the CLI.

  **Fix**

  - Every internal `spawn(cli, [...])` now spawns `process.execPath` with the CLI path as the first arg — cross-platform and does not rely on the OS knowing how to exec a `.js`.
  - `InstallContext` gains a required `nodeBin` field (populated with `process.execPath`). All five installers write `command: nodeBin, args: [cliPath, "mcp", ...]` instead of `command: cliPath, args: ["mcp"]`.
  - The Claude Code installer's hook command strings are now `"<nodeBin>" "<cliPath>" hook run <name> --ide claude-code`, with paths wrapped via a new `shellQuote` helper so `C:\Program Files\nodejs\node.exe` and `C:\Users\Some User\...\index.js` survive both cmd.exe and sh without splitting.
  - Added a Windows-path regression test in `packages/installers/test/installers.test.ts` so the quoting stays correct.

  **Upgrade note**

  Existing Windows installs still have the broken shape written into `~/.claude/settings.json`, `~/.cursor/mcp.json`, etc. After upgrading, run `cavemem install` (and `cavemem install --ide cursor`, etc.) once to rewrite those files with the corrected `nodeBin + cliPath` form. Nothing else changes for macOS and Linux users.

- 4af0d0d: Build, lint, and test-ecosystem fixes:

  - Drop `incremental: true` from the base tsconfig so `tsup --dts` stops failing with TS5074 and `pnpm build` is green again.
  - Resolve the full Biome lint backlog (organizeImports, useImportType) across every package. `pnpm lint` is now clean.
  - Fix a compression bug where `collapseWhitespace` would eat the single space between prose and preserved tokens (paths, inline code, URLs), producing unreadable output like `at/tmp/foo.txt`. Boundary spacing is now preserved on compress and round-tripped through expand.
  - Fix `Storage.timeline(sessionId, aroundId, limit)` — the previous single-UNION query let the "after" half swallow the whole window. Replaced with two bounded queries merged in JS so both halves are respected.
  - Remove a double `expand()` call in the MCP `get_observations` tool; expansion now happens exactly once inside `MemoryStore`.
  - `runHook()` now accepts an injected `MemoryStore` so tests (and other integrations) can avoid touching the user's real `~/.colony` data directory.

  Test ecosystem: brand-new suites for `@colony/hooks` (runner + all 5 handlers + hot-path budget check), `@colony/installers` (claude-code idempotency, settings preservation, cursor install/uninstall, registry, deepMerge), `@colony/mcp-server` (InMemory MCP client hitting every tool and asserting the progressive-disclosure shape), `@colony/worker` (Hono `app.request()` integration tests for every HTTP route), and the `cavemem` CLI (command registration smoke test). Total tests: 22 → 54.

  None of the new test directories are shipped — every published package keeps its `files` allowlist pointed at `dist` only.

- Updated dependencies [416957b]
  - @colony/config@0.2.0
  - @colony/core@0.2.0
