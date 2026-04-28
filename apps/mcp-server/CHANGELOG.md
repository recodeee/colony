# @colony/mcp-server

## 0.6.0

### Minor Changes

- d6bfe31: Add `@colony/spec` — the spec-driven dev lane (colonykit-in-colony).
  Provides a `SPEC.md` grammar, `CHANGE.md` grammar, three-way sync
  engine, backprop failure-signature gate, and cite-scoped context
  resolver. Rides on `@colony/core`'s TaskThread, ProposalSystem, and
  MemoryStore — no parallel infrastructure.

  Six new MCP tools land in `apps/mcp-server/src/tools/spec.ts`:
  `spec_read`, `spec_change_open`, `spec_change_add_delta`,
  `spec_build_context`, `spec_build_record_failure`, `spec_archive`.

  Four matching Claude Code skills ship under `skills/` at the repo
  root: `/co:change`, `/co:build`, `/co:check`, `/co:archive`, plus
  supporting internals (`spec`, `sync`, `backprop`).

  Tests: `packages/spec/test/spec.test.ts` covers grammar round-trip,
  always-on invariant detection, stable hashing, cite-scope transitive
  closure, and all four sync conflict shapes. `apps/mcp-server` tool
  list updated to include the six new tools.

- af5d371: Expose foraged food sources to MCP clients through three new tools and
  wire `MemoryStore.search` with an optional kind/metadata filter so
  scoped queries don't pollute the main search.

  New MCP tools (registered alongside spec in `apps/mcp-server`):

  - `examples_list({ repo_root })` — compact list of indexed example
    names, manifest kinds, and cached observation counts.
  - `examples_query({ query, example_name?, limit? })` — BM25 hits
    scoped to `kind = 'foraged-pattern'` and optionally to a specific
    example. Returns compact snippets — fetch full bodies via
    `get_observations`.
  - `examples_integrate_plan({ repo_root, example_name, target_hint? })`
    — deterministic plan: npm dependency delta between the example and
    the target `package.json`, files to copy (derived from indexed
    entrypoints), `config_steps` (npm scripts), and an
    `uncertainty_notes` list for everything the planner couldn't
    resolve. No LLM in the loop.

  `@colony/foraging` adds `buildIntegrationPlan(storage, opts)`. The
  function reads manifests fresh from disk to avoid round-tripping
  structured JSON through the compressor.

  `@colony/core` extends `MemoryStore.search(query, limit?, embedder?, filter?)`
  with `{ kind?: string; metadata?: Record<string, string> }`. When a
  filter is set the method skips vector ranking — the embedding index has
  no kind column, so mixing vector hits would require a second pass to
  drop them. `@colony/storage`'s `searchFts(query, limit, filter?)`
  applies the filter in SQL via `json_extract` so the LIMIT still bounds
  the scan.

- cfb6338: Eight-part overhaul of the `task_message` system so directed-agent messaging
  behaves more like a real coordination channel than a one-shot inbox.

  `@colony/core`:

  - `MessageMetadata` gains `expires_at`, `retracted_at`, `retract_reason`, and
    `claimed_by_session_id` / `claimed_by_agent` / `claimed_at`. `MessageStatus`
    picks up `expired` and `retracted` terminal states. `parseMessage` backfills
    the new fields to `null` so legacy rows still pass the strict-null
    visibility predicates without a migration.
  - `TaskThread.postMessage` accepts `expires_in_ms`, auto-claims a still-
    unclaimed `to_agent='any'` broadcast on reply, and keeps reply-chain depth
    authoritative at 1-deep — only the immediate parent flips to `replied`.
  - New `TaskThread.retractMessage` (sender-only, refuses replied messages) and
    `TaskThread.claimBroadcastMessage` (idempotent for the existing claimer,
    rejects directed messages with `NOT_BROADCAST`).
  - `TaskThread.markMessageRead` writes a sibling `message_read` observation
    so the original sender's inbox can render read receipts; past-TTL reads
    flip the on-disk status to `expired` and throw `MESSAGE_EXPIRED`.
  - `pendingMessagesFor` and `listMessagesForAgent` filter retracted, expired,
    and other-agents'-claimed broadcasts. Inbox summaries surface `expires_at`,
    `is_claimable_broadcast`, and the claim state.
  - `buildAttentionInbox` adds `summary.blocked` (gates non-message lanes when
    any unread is `blocking`), `coalesced_messages` (groups by task / sender /
    urgency), and `read_receipts` (drops once the recipient replies). New
    `read_receipt_window_ms` / `read_receipt_limit` options.

  `@colony/mcp-server`:

  - `task_message` accepts `expires_in_minutes` (max 7 days).
  - New `task_message_retract` and `task_message_claim` tools.
  - `task_messages` shape now includes `expires_at`, `is_claimable_broadcast`,
    `claimed_by_session_id`, and `claimed_by_agent`.
  - Tool descriptions document the 1-deep reply contract, retract semantics,
    TTL behavior, and broadcast-claim flow.

- 7e5a430: Add opt-in `auto_archive` flag to `task_plan_publish`. When set, the parent spec change three-way-merges and archives automatically after the last sub-task completes via `task_plan_complete_subtask`. Default is `false` because silent state change after the final completion is risky if the merged spec has not been verified — opt in per plan once the lane lands cleanly. Conflicts on the three-way merge are non-fatal: the completion still returns `status: 'completed'`, the archive is skipped, and a `plan-archive-blocked` observation is recorded on the parent spec task so resolution stays explicit. Other auto-archive failures (missing `CHANGE.md`, write errors) are likewise recorded as `plan-archive-error` observations and never propagate as tool errors. The completion response now carries an `auto_archive: { status, reason?, archived_path?, merged_root_hash?, applied?, conflicts? }` field that reports the outcome on every call. New observation kinds: `plan-config` (publish-time policy on the parent spec task), `plan-archived`, `plan-archive-blocked`, `plan-archive-error`. Also fixes a latent lifecycle race in `@colony/core` `readSubtask`: when a `claimed` and `completed` `plan-subtask-claim` observation share the same millisecond timestamp (back-to-back claim then complete in tests or fast-running flows), SQLite's `ORDER BY ts DESC` had undefined tie-breaker behavior and could surface the sub-task as `claimed`. Status is now resolved with terminal-state-wins precedence (`completed > blocked > claimed`) so a completion is authoritative once it exists.
- e6c03f2: Add a plan publication lane on top of the existing task-thread + spec primitives. `task_plan_publish` writes a spec change document and opens one task thread per sub-task on `spec/<slug>/sub-N` branches, linking them via `metadata.parent_plan_slug`. Independent sub-tasks must not share file scopes; sequence overlapping work via `depends_on` (zero-based, must point at earlier indices). `task_plan_list` returns plan-level rollups with sub-task counts (`available | claimed | completed | blocked`) and a `next_available` list of unblocked, unclaimed sub-tasks; filterable by `repo_root`, `only_with_available_subtasks`, and `capability_match`. `task_plan_claim_subtask` claims an available sub-task race-safely (scan-before-stamp inside a SQLite transaction so two concurrent claims serialize through the write lock — first wins, second sees the prior claim observation and rejects with `PLAN_SUBTASK_NOT_AVAILABLE`); on success it joins the caller to the sub-task thread and activates file claims. `task_plan_complete_subtask` releases file claims and stamps a completion observation; downstream sub-tasks become available automatically. New observation kinds: `plan-subtask` (initial advertisement) and `plan-subtask-claim` (lifecycle transitions). New worker route `GET /api/colony/plans` exposes the same rollup to the read-only viewer. No schema migration; the lane composes over existing `task_thread` and `@colony/spec` primitives.
- f48269e: Add `recall_session` MCP tool. An agent passes a `target_session_id` plus its own `current_session_id`, and the tool returns a compact timeline of the target (IDs + kind + ts only — bodies still come from `get_observations(ids[])`) while writing a `kind: 'recall'` observation into the _caller's_ session as the audit trail.

  The recall observation introduces a new wire contract that other code may filter on:

  - `kind === 'recall'`
  - `metadata.recalled_session_id` — the consulted session
  - `metadata.owner_ide` — `inferIdeFromSessionId` fallback when the target's `ide` column is `unknown`, so foreign-session recalls stay traceable without re-inferring at read time
  - `metadata.observation_ids` — the timeline slice that was returned
  - `metadata.around_id` and `metadata.limit` — the request parameters that produced the slice

  Both session ids are validated via `Storage.getSession()` before any write. `MemoryStore.addObservation` routes through `ensureSession` (memory-store.ts:96), which silently materialises a missing sessions row — without these checks a typo'd `current_session_id` would create a phantom session and write a recall observation into it. Errors come back as `{ code: 'SESSION_NOT_FOUND', error }`.

  Also extends `GET /api/sessions/:id/observations` on the worker viewer with an `?around=<id>&limit=<n>` query so the same paged timeline is reachable from the HTTP surface (the route already proxied to `Storage.timeline`, which has supported `aroundId` for a while). Cross-session `?around` ids cleanly return `[]` rather than spilling into the target window, matching the SQL filter on `session_id`.

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

- 49f7736: Add a direct-message primitive on task threads so agents can coordinate in prose without transferring file claims. `task_message` sends a message with explicit addressing (`to_agent: claude | codex | any`, optional `to_session_id`) and an `urgency` (`fyi | needs_reply | blocking`) that controls preface prominence. `task_messages` returns the compact inbox addressed to the caller across every task they participate in; `task_message_mark_read` flips a message to `read` idempotently. Replies (`reply_to`) flip the parent's status to `replied` atomically on the send so resolution is authoritative rather than advisory. Storage reuses the existing observation write path — no schema migration — with lifecycle fields kept in `metadata` alongside the existing `handoff` / `wake_request` primitives.
- 1fbc24e: Add `task_relay`: a coordination primitive for passing in-flight work to
  another agent when the sender is being cut off (quota, rate-limit,
  turn-cap) and can't write a thoughtful handoff. The sender provides one
  sentence; everything else — recently edited files, active claims, recent
  decisions and blockers, last baton-pass summary, search seeds — is
  synthesized from the last 30 minutes of task-thread activity at emit
  time. A `worktree_recipe` block (base branch, claims to inherit, optional
  git sha, untracked-file warning) lets a receiver in a different worktree
  set up an equivalent tree before editing.

  Difference from `task_hand_off`: relays assume the sender is gone, so
  their claims are _dropped_ at emit time and re-claimed by the receiver
  on accept (mirrors the `transferred_files` invariant — no third agent
  can grab a file in the gap). The `expires_at` window is shorter (4h
  default vs. 2h for handoffs but stricter ceiling — work the relay
  describes goes stale fast).

  Core (`@colony/core`):

  - `TaskThread.relay()` / `acceptRelay()` / `declineRelay()` /
    `pendingRelaysFor()` parallel the handoff/wake/message primitives
    with their own typed metadata, error codes (`NOT_RELAY`,
    `RELAY_EXPIRED`), and content rendering.
  - New exports: `RelayMetadata`, `RelayObservation`, `RelayArgs`,
    `RelayStatus`, `RelayTarget`, `RelayReason`. Existing
    `CoordinationKind` union extended with `'relay'`.
  - Heterogeneous-metadata-safe synthesis of `last_handoff_summary`:
    branches on observation kind so `summary` (handoffs) and `one_line`
    (relays) both feed the field correctly when the most recent
    baton-pass is one or the other.

  MCP (`@colony/mcp-server`):

  - Three new tools: `task_relay`, `task_accept_relay`,
    `task_decline_relay`. Registered next to `task_message` so
    coordination primitives stay contiguous.

- 754949f: Add wake-request primitive and attention inbox for idle/stalled cross-agent nudges.

  - `task_wake` / `task_ack_wake` / `task_cancel_wake` MCP tools post lightweight nudges on a task thread — no claim transfer, no baton pass. Targets see the request on their next SessionStart or UserPromptSubmit turn with a copy-paste-ready ack call.
  - `attention_inbox` MCP tool + `colony inbox` CLI command aggregate pending handoffs, pending wakes, stalled lanes from the hivemind snapshot, and recent other-session file claims into one compact view. Bodies are not expanded; fetch via `get_observations`.
  - Hook injection extended: `buildTaskPreface` surfaces pending wake requests alongside pending handoffs; `buildTaskUpdatesPreface` inlines an ack call for wake requests that arrive between turns.

  Deferred follow-ups (not in this change): safe session takeover, claim TTL renewal, session Stop checkpoint, and any terminal-control wake mechanism.

### Patch Changes

- 2217a68: Remove the unused wake MCP tools from the live server surface and make `task_message` match `task_post` ergonomics: callers can now send a broadcast with only `task_id`, `session_id`, `agent`, and `content`, while directed-message knobs remain optional.
- 185a9d9: Extract shared `isMainEntry`, pidfile helpers, `isAlive`, and the
  `spawn(process.execPath, …)` wrapper into a new `@colony/process`
  package. These utilities had divergent copies in four places
  (`apps/cli/src/commands/lifecycle.ts`, `apps/cli/src/commands/worker.ts`,
  `apps/mcp-server/src/server.ts`, `apps/worker/src/server.ts`, and
  `packages/hooks/src/auto-spawn.ts`). The regex that decides whether
  Node should be invoked via `execPath` — the Windows EFTYPE guard —
  and the realpath-normalized bin-shim check both now live exactly once.

  No behavior change. Internal helper refactor only.

- 5c17c92: Split `apps/mcp-server/src/server.ts` into eight per-tool-group modules
  under `src/tools/` (search, hivemind, task, handoff, proposal, profile,
  wake, plus shared/context/heartbeat helpers). `buildServer()` is now a
  small registration list that calls `register(server, ctx)` on each
  group in the same order the tools appeared in the pre-split file.
  Behavior is unchanged — all 17 mcp-server tests (InMemory MCP client
  hitting every tool + task-thread suites) pass without modification.
- 18412d3: Document the task relay fallback on the MCP tools that remain visible when a
  client does not expose `task_relay`. `task_post` now tells agents what relay
  context to record, `task_hand_off` explains how to resume from a base branch
  instead of a missing source lane, and `colony debrief` names `task_relay` as a
  coordination commit example.
- d710353: Close two test gaps that were quiet failure modes.

  **`task_relay` MCP-level lifecycle tests** (`apps/mcp-server/test/task-threads.test.ts`):
  the relay primitive shipped without integration coverage in the MCP
  test suite — only core-level unit tests existed. Added four lifecycle
  tests round-tripped through the MCP client transport that pin the
  contract reviewers actually care about: claims-drop-at-emit, receiver
  re-claim on accept, decline-cancels-and-blocks-future-accept, directed
  relay refuses non-target agents, expired relay flips status to
  `expired` instead of staying `pending`. Without these tests an
  internal storage/metadata change could silently break the receiver's
  re-claim path or leave expired relays advertising themselves as live.

  **`renderFrame` snapshot test** (`apps/cli/test/observe.test.ts`):
  the `colony observe` dashboard's unclaimed-edits footer is the
  load-bearing diagnostic for whether proactive claiming is happening,
  but the renderer wasn't under test — a metadata field rename or a
  `safeJson` typo would have surfaced as nonsense on the dashboard, the
  worst way to find out. `renderFrame` is now exported and a Vitest
  suite seeds a deterministic fixture (frozen clock, kleur disabled),
  calls the renderer, and asserts on the structural anchors that would
  break under those regressions: task header, participants, claims,
  pending handoffs (`from_agent → to_agent: summary`), and the
  unclaimed-edits footer in both populated and zero-state forms.

- Recover stranded session ownership by exposing rescue diagnostics through MCP and by letting the worker prepare relays for sessions whose owning agent vanished.
- Rewrite Colony MCP tool descriptions so intent-based searches prefer the active coordination primitives and make the fallback guidance discoverable from the server surface.
- 82251e7: Remove the dead `task_wake`, `task_ack_wake`, and `task_cancel_wake` MCP surface after `ScheduleWakeup` won the coordination fight. The wake storage substrate stays in place so a future `ScheduleWakeup` interception can still reuse `wake_request` observations.
- Updated dependencies [d6bfe31]
- Updated dependencies [e9e5587]
- Updated dependencies [1b076d8]
- Updated dependencies [185a9d9]
- Updated dependencies [f8f1bcc]
- Updated dependencies [90bc096]
- Updated dependencies [af5d371]
- Updated dependencies [beaf0f4]
- Updated dependencies [ed5a0b0]
- Updated dependencies [c027e5d]
- Updated dependencies [cfb6338]
- Updated dependencies [7e5a430]
- Updated dependencies [e6c03f2]
- Updated dependencies [9e559a4]
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies [b158138]
- Updated dependencies [2aec9a9]
- Updated dependencies [49f7736]
- Updated dependencies [1fbc24e]
- Updated dependencies [754949f]
  - @colony/spec@0.6.0
  - @colony/core@0.6.0
  - @colony/hooks@0.6.0
  - @colony/foraging@0.6.0
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
