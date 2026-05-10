# @colony/core

## 0.8.0

### Patch Changes

- 4a68470: Fix read-then-write race in claim cleanup paths

  `releaseExpiredQuotaClaims` and `bulkRescueStrandedSessions` previously read
  eligible claims outside their DEFERRED transaction, allowing two concurrent
  callers to both snapshot the same rows and each emit a duplicate
  `claim-weakened` or `rescue-stranded` audit observation.

  The fix moves the claim read inside a `BEGIN IMMEDIATE` transaction on both
  paths so the write lock is acquired before any row is inspected. The storage
  `transaction()` helper gains an `{ immediate: true }` option that maps to
  better-sqlite3's `.immediate()` mode. A new idempotency test confirms that
  calling each cleanup path twice produces exactly one audit observation.

- e6c5766: Reject `task_claim_file` at the MCP layer when the task's branch is a protected base branch.

  `guardedClaimFile` already returned `protected_branch_rejected` (controlled by the `rejectProtectedBranchClaims` setting, default `true`) but the MCP handler silently fell through and recorded the claim anyway. The handler now checks for that status and returns a distinct `PROTECTED_BRANCH_CLAIM_REJECTED` error code with a message directing the agent to start a sandbox worktree first.

  `PROTECTED_BRANCH_CLAIM_REJECTED` is added to `TASK_THREAD_ERROR_CODES` in `@colony/core`. Two new integration tests cover the reject and allow cases.

  Note: the same `guardedClaimFile` call in `task_plan_claim_subtask` has the same gap; that is out of scope for this patch.

- 2e8fba1: Stop attributing the storage-at-rest compression claim to live `savings_report` calls

  The `Storage at rest (per observation)` reference row used to map to `['savings_report']`. Live `savings_report` output is structured JSON (~3.5k tokens per call) where the caveman compressor preserves technical tokens byte-for-byte, so the live comparison projected the row's 1k-token baseline against ~3.5k actual tokens and reported negative savings (e.g. `-155%`).

  The row stays in the static reference — caveman compression really does shrink prose observations on disk — but it is now a structural claim about the storage layer rather than a per-call cost, so `mcp_operations` is empty. `savings_report` calls now show up under `unmatched_operations` instead of inflating the row.

- Updated dependencies [4a68470]
- Updated dependencies [3898ff3]
  - @colony/storage@0.8.0

## 0.7.0

### Minor Changes

- cb4c9f9: Add `--release-expired-quota` mode to `colony coordination sweep`.
  Quota-pending claims past their `expires_at` are now downgraded to
  `weak_expired` and their linked relay/handoff observations are marked
  `expired`, with a coordination-sweep audit observation written for each
  release. Without the flag, expired quota-pending claims are still
  counted in `summary.quota_pending_claims` and `safe_cleanup` so health
  can recommend the cleanup. The new `release_expired_quota_claims`
  option on `buildCoordinationSweep` mirrors the existing
  `release_safe_stale_claims` / `release_same_branch_duplicates` shape:
  audit history is retained, dry-run remains the default, and the CLI's
  `--dry-run` flag continues to suppress all release modes.
- 46d0153: Add `colony lane contentions` to surface every file currently held by
  two or more concurrent strong claims, regardless of which session is
  asking. The verb prints each contended file with all its claimers
  (session id, agent, branch, last-seen heartbeat) and emits a suggested
  `colony lane takeover` command per losing claim — defaults to keeping
  the most recent claim and demoting the older ones. Auto-resolution is
  intentionally not done because breaking an active session's claim
  mid-edit is risky; the operator confirms by running the suggested
  takeover.

  Backed by a new `listLiveFileContentions(store, options)` helper in
  `@colony/core` that complements the existing per-session
  `liveFileContentionsForSessionClaims` / `liveFileContentionsForClaim`
  walkers.

- a27c52c: Add `--release-aged-quota-minutes <minutes>` to `colony coordination
sweep` (and the matching `release_aged_quota_pending_minutes` option on
  `buildCoordinationSweep`) for evacuating quota-pending claims that have
  been sitting open longer than the supplied threshold, regardless of
  whether the per-claim TTL has been reached. The existing
  `--release-expired-quota` flag only handles claims past `expires_at`,
  so handoffs posted while no agent was around to accept them stay in
  the signal-evaporation metric until their TTL — often hours.

  Released aged claims still go to `weak_expired` and emit a
  `coordination-sweep` audit observation; the linked relay observation
  is marked expired the same way it is for the expired-TTL path. The
  `released_expired_quota_pending_claims` array now contains both the
  expired-TTL and aged-threshold cleanups, distinguished by their
  `cleanup_action` (`release_expired_quota_pending` vs
  `release_aged_quota_pending`).

- 919cc9b: Add per-operation token instrumentation and a savings surface with three
  entry points that share one data source:

  - New `mcp_metrics` SQLite table records `(operation, ts, input_bytes,
output_bytes, input_tokens, output_tokens, duration_ms, ok)` for every
    wrapped MCP tool call. Recording is best-effort: a write failure cannot
    break a tool call. Tokens are counted via `@colony/compress#countTokens`
    so values align with observation token receipts.
  - `Storage.recordMcpMetric` and `Storage.aggregateMcpMetrics` expose the
    table; new types `NewMcpMetric`, `AggregateMcpMetricsOptions`,
    `McpMetricsAggregate`, and `McpMetricsAggregateRow` ship from
    `@colony/storage`.
  - `apps/mcp-server` composes a metrics wrapper alongside the existing
    heartbeat wrapper. Heartbeat outer (touches active session before the
    handler), metrics inner (measures handler input/output around the actual
    work).
  - New MCP tool `savings_report` returns hand-authored reference rows plus
    live per-operation usage. CLI `colony gain` renders the same data with
    optional `--hours`, `--since`, `--operation`, `--json` flags. Worker
    exposes `/savings` (HTML) and `/api/colony/savings` (JSON), reachable
    from the index page link.
  - Hand-authored reference table lives in
    `packages/core/src/savings-reference.ts` so all three surfaces stay in
    sync from one source.

### Patch Changes

- b937fb7: Cap `attention_inbox` stalled lane rows by default while preserving total
  counts and explicit expansion.
- 6b09a3d: Add a CocoIndex-ready compact session source for Codex and Claude token usage.
- 7d86bd2: `buildCoordinationSweep` now accepts an `archive_completed_plans` option that scans for queen plans whose every sub-task's latest `plan-subtask-claim` observation is `metadata.status='completed'` and archives the parent + sub-task rows via `archiveQueenPlan`. The MCP plan-tool sweep only fires for plans with `auto_archive=true` in plan-config, so opt-out plans linger as "completed but unarchived" on the queen_plan_readiness health signal forever; this gives operators an explicit CLI-driven path to clear them. Sweep result gains `archived_completed_plans` (rows) and `summary.archived_completed_plan_count` (count). Idempotent — already-archived plans are not re-counted.

  Exposed via `colony coordination sweep --archive-completed-plans` (skipped automatically when `--dry-run` is set, like the other release flags).

- 36e95ba: Show live gain receipts before the reference model and expand the savings
  operation catalog.
- 528b5ba: Add `task_autopilot_tick` and `task_drift_check` MCP tools — light-weight ports of two ideas from the Ruflo autopilot/swarm playbook, mapped onto Colony primitives.

  `task_autopilot_tick` is a one-shot advisor that combines `attention_inbox` + `task_ready_for_agent` into a single decision (next tool + args + sleep hint). The loop itself stays caller-side (Claude Code's `ScheduleWakeup`, the `/loop` skill, or cron) — this MCP call is stateless. Decision priority: pending handoff → quota relay → blocking message → claim ready subtask → continue current claim → no-op. Stalled lanes whose only signal is "Session start"/"No active swarm" are classified as dead heartbeats and excluded from the actionable count, so callers don't escalate on noise.

  `task_drift_check` compares a session's claims for a given task against its recent edit-tool observations within a configurable window. Surfaces files edited without a matching claim (drift) and claims with no recent edit activity (potentially abandoned). File-scope drift only — does not analyze semantic drift from the task description.

  Both tools are pure compositions of existing storage and core helpers; no SQL migration, no new package, no edits to `packages/storage/src/storage.ts`. `@colony/core` re-exports `InboxQuotaPendingClaim` so downstream tools can build typed quota-relay payloads.

- 9424987: Expand the token-savings reference model and README explanation so publishable
  packages show clearer Colony gain examples.
- 2a077ed: Add an optional Rust/Tantivy keyword search sidecar with SQLite FTS fallback.
- 08e4700: Add 3 reference rows to `SAVINGS_REFERENCE_ROWS`: **Blocker recurrence** (search-keyed lookup of prior `failed_approach` notes vs cold re-investigation), **Drift / failed-verification recovery** (`spec_build_record_failure` surfacing the matching §V invariant after a test fails vs re-deriving the constraint), and **Quota-exhausted handoff** (`task_relay` carrying claim+next+evidence to the rescuer vs reconstructing from worktree + git log). README savings table updated to match.
- 2ddc284: Add 4 reference rows to `SAVINGS_REFERENCE_ROWS` so `colony gain` can match operations that were previously bucketed as unmatched: **Plan publication & goal anchoring** (`queen_plan_goal`, `task_plan_publish`, `task_plan_validate`, `task_propose`), **Task thread note** (`task_post`, `task_reinforce`), **Task dependency linking** (`task_link`, `task_links`, `task_unlink`), and **Agent profile sync** (`agent_get_profile`, `agent_upsert_profile`). The "Live matched total" and "Top saving" lines in the gain report now reflect savings on these surfaces instead of leaving the calls in the unmatched footer.
- 7d86bd2: `guardedClaimFile` now attaches a `protected_branch` warning to its `GuardedClaimResult` when the task lives on a protected base branch (`main`, `master`, `dev`, `develop`, `production`, `release`). Soft signal only — the claim is still recorded so sessions that lawfully resume an existing `main`-bound task aren't broken — but downstream callers (MCP, hooks, CLI) can now surface the worktree-discipline violation before it shows up on the health dashboard as a same-branch duplicate-owner contention. Uses the new `isProtectedBranch` helper exported from `@colony/storage` so all coordination layers share one definition.
- fa4e1a3: Add typed signal metadata helpers for decaying coordination signals.
- Updated dependencies [77c9e30]
- Updated dependencies [c94ed35]
- Updated dependencies [f769824]
- Updated dependencies [43ef76a]
- Updated dependencies [211c646]
- Updated dependencies [2d84352]
- Updated dependencies [127fdf3]
- Updated dependencies [2a077ed]
- Updated dependencies [610d5c8]
- Updated dependencies [919cc9b]
  - @colony/storage@0.7.0
  - @colony/config@0.7.0

## 0.6.0

### Minor Changes

- e9e5587: Bridge the foraging proposal system to the Plans page: when a proposal crosses the promotion threshold (strength ≥ 2.5), `ProposalSystem.maybePromote` now also synthesizes a "lite" plan via `synthesizePlanFromProposal`. The synthesized plan opens a parent task on `spec/proposal-<id>` plus one sub-task per file in `touches_files` (capped at 20 to match `task_plan_publish`), stamps `plan-config` and `plan-subtask` observations matching the explicit-publish wire shape, and co-stamps a `proposal-promoted` event observation that the Plans page side feed renders as "Proposal #N <summary> crossed strength 2.5 and auto-promoted to a plan with N sub-tasks."

  Two intentional differences from `task_plan_publish`:

  1. No `openspec/changes/<slug>/CHANGE.md` is written. The lite plan exists entirely in the observation timeline so the autonomous foraging code path has no filesystem side effects. Humans can scaffold OpenSpec docs later if the auto-promoted plan proves out.
  2. `auto_archive` defaults to `false`. The first wave of auto-published plans needs human review before silent state transitions on final sub-task completion.

  Empty-`touches_files` proposals still promote to a `TaskThread` as before; plan synthesis is skipped (returns `skipped_reason: 'no_touches_files'`) because there's no meaningful sub-task partition without file scope. The promoted thread is the load-bearing contract; the plan is a bonus.

  Idempotency: synthesis runs exactly once per proposal because `proposal.status` flips from `'pending'` to `'active'` _before_ the bridge is invoked, and `maybePromote` short-circuits at the status guard for any subsequent reinforcement-driven entry. Failures inside synthesis are caught and logged as a `plan-synthesis-failed` observation on the promoted task so a buggy bridge cannot unwind a successful promotion.

  New exports from `@colony/core`:

  - `synthesizePlanFromProposal(store, proposal, options?)`
  - `type SynthesizedPlan`
  - `type ProposalForSynthesis`

  New observation kinds emitted on the spec root task:

  - `proposal-promoted` — drives the Plans page side feed
  - `plan-synthesis-failed` — diagnostic only, fires when the bridge throws

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

- e6c03f2: Add a plan publication lane on top of the existing task-thread + spec primitives. `task_plan_publish` writes a spec change document and opens one task thread per sub-task on `spec/<slug>/sub-N` branches, linking them via `metadata.parent_plan_slug`. Independent sub-tasks must not share file scopes; sequence overlapping work via `depends_on` (zero-based, must point at earlier indices). `task_plan_list` returns plan-level rollups with sub-task counts (`available | claimed | completed | blocked`) and a `next_available` list of unblocked, unclaimed sub-tasks; filterable by `repo_root`, `only_with_available_subtasks`, and `capability_match`. `task_plan_claim_subtask` claims an available sub-task race-safely (scan-before-stamp inside a SQLite transaction so two concurrent claims serialize through the write lock — first wins, second sees the prior claim observation and rejects with `PLAN_SUBTASK_NOT_AVAILABLE`); on success it joins the caller to the sub-task thread and activates file claims. `task_plan_complete_subtask` releases file claims and stamps a completion observation; downstream sub-tasks become available automatically. New observation kinds: `plan-subtask` (initial advertisement) and `plan-subtask-claim` (lifecycle transitions). New worker route `GET /api/colony/plans` exposes the same rollup to the read-only viewer. No schema migration; the lane composes over existing `task_thread` and `@colony/spec` primitives.
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

- 2aec9a9: Add task-level embeddings — a per-task vector representing the task's
  "meaning" in the same embedding space the observations live in. This is
  the foundation sub-system for the predictive-suggestions layer
  (`task_suggest_approach`) and includes the core similarity scan used by
  later surface tools.

  `@colony/storage`:

  - New `task_embeddings` table (schema version 10). One row per task with
    `(task_id, model, dim, embedding, observation_count, computed_at)`.
    `observation_count` is the cache invalidation key — recomputation
    triggers when the actual count drifts more than 20% from the cached
    value.
  - New methods: `upsertTaskEmbedding(p)`, `getTaskEmbedding(task_id)`,
    `countTaskObservations(task_id)`, `hasEmbedding(observation_id, model?)`.
    All four are used by the core embedding-compute path; none are
    exposed to MCP yet.
  - `getTaskEmbedding`, `upsertTaskEmbedding`, and
    `countTaskObservations` use cached prepared statements for the
    similarity scan hot path.

  `@colony/core`:

  - New module `task-embeddings.ts` exporting `computeTaskEmbedding(store,
task_id, embedder)` and `getOrComputeTaskEmbedding(store, task_id,
embedder)`. The compute function is a kind-weighted centroid of the
    task's observation embeddings — handoffs and decisions count 2×, claims
    and messages 1×, tool-use 0.25× — normalized to unit length so cosine
    similarity reduces to a dot product.
  - Returns null when fewer than `MIN_EMBEDDED_OBSERVATIONS` (5) embeddings
    exist for the task. The honesty discipline: sparse data must produce
    honest no-results rather than invented vectors.
  - Cache invalidation triggers on observation-count drift > 20% OR model
    mismatch. `KIND_WEIGHTS`, `MIN_EMBEDDED_OBSERVATIONS`, and
    `CACHE_DRIFT_TOLERANCE` are all exported so the suggestion layer can
    reference them as the load-bearing constants they are.
  - New `findSimilarTasks(store, embedder, query_embedding, options)` scans
    up to 10,000 tasks, computes or reuses task embeddings, filters by repo,
    exclusions, and minimum cosine similarity, then returns top-N task
    summaries sorted by similarity.

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

- ed5a0b0: Extend `inferIdeFromSessionId` so session ids that mirror the Guardex branch name (`agent/<name>/<task-slug>`, e.g. `agent/codex/make-openspec-lighter-with-colony-spec-m-2026-04-24-21-32`) resolve to the correct IDE. Previously the leading segment was the literal `agent`, so those rows were classified as `unknown` and the viewer showed no owner.
- c027e5d: Infer the IDE owner for sessions whose id is hyphen-delimited (e.g. `codex-colony-usage-limit-takeover-verify-...`). Previously `MemoryStore.ensureSession` hardcoded `ide = 'unknown'` and the hook-side inferrer only matched the `codex@...` / `claude@...` form, so every on-demand-materialised row landed as `unknown` in the viewer. The worker's session index now also shows an owner chip and re-infers legacy `unknown` rows at render time (italic + `?` suffix to signal the value is derived, not authoritative), and Hivemind lane cards tag the owner directly.
- 7e5a430: Add opt-in `auto_archive` flag to `task_plan_publish`. When set, the parent spec change three-way-merges and archives automatically after the last sub-task completes via `task_plan_complete_subtask`. Default is `false` because silent state change after the final completion is risky if the merged spec has not been verified — opt in per plan once the lane lands cleanly. Conflicts on the three-way merge are non-fatal: the completion still returns `status: 'completed'`, the archive is skipped, and a `plan-archive-blocked` observation is recorded on the parent spec task so resolution stays explicit. Other auto-archive failures (missing `CHANGE.md`, write errors) are likewise recorded as `plan-archive-error` observations and never propagate as tool errors. The completion response now carries an `auto_archive: { status, reason?, archived_path?, merged_root_hash?, applied?, conflicts? }` field that reports the outcome on every call. New observation kinds: `plan-config` (publish-time policy on the parent spec task), `plan-archived`, `plan-archive-blocked`, `plan-archive-error`. Also fixes a latent lifecycle race in `@colony/core` `readSubtask`: when a `claimed` and `completed` `plan-subtask-claim` observation share the same millisecond timestamp (back-to-back claim then complete in tests or fast-running flows), SQLite's `ORDER BY ts DESC` had undefined tie-breaker behavior and could surface the sub-task as `claimed`. Status is now resolved with terminal-state-wins precedence (`completed > blocked > claimed`) so a completion is authoritative once it exists.
- 9e559a4: Suppress fresh read receipts in `attention_inbox` until they ripen.

  `buildAttentionInbox` now filters out `message_read` siblings that are
  younger than `read_receipt_min_age_ms` (default 5 minutes). The receipt
  exists in storage immediately, but the inbox only surfaces it once
  "the recipient had time to respond and didn't" is honest signal —
  otherwise the sender's preface gets a "follow up?" hint every turn the
  recipient is still typing.

  The min-age window is configurable per call so tests and hot-debug
  sessions can pass `read_receipt_min_age_ms: 0` to opt out.

- Updated dependencies [5c9fa69]
- Updated dependencies [77b4e06]
- Updated dependencies [90bc096]
- Updated dependencies [af5d371]
- Updated dependencies [b158138]
- Updated dependencies [beaf0f4]
- Updated dependencies [2f371d4]
- Updated dependencies [2aec9a9]
  - @colony/storage@0.6.0
  - @colony/config@0.6.0

## 0.5.0

### Minor Changes

- Sync linked release with the 0.4.0 MCP heartbeat bump so `@imdeadpool/colony`
  and the supporting `@colony/*` workspace packages publish together.

### Patch Changes

- Updated dependencies
  - @colony/compress@0.5.0
  - @colony/config@0.5.0
  - @colony/storage@0.5.0

## 0.3.0

### Minor Changes

- 5f37e75: Add pheromone trails: ambient decaying activity signal per (task, file, session). `PostToolUse` deposits pheromone on every write-tool invocation; strength decays exponentially (10-minute half-life, cap 10.0). The new `UserPromptSubmit` preface warns when another session has a strong trail on a file the current session has also touched, complementing the existing claim-based preface with a graded intensity signal that doesn't fire for stale collisions. Schema bumped to version 4 — adds `pheromones` table with FK cascade on sessions and tasks.
- 4076133: Add proposal system: pre-tasks that auto-promote via collective reinforcement. Agents call `task_propose` to surface a candidate improvement; other agents call `task_reinforce` (kind `explicit` or `rediscovered`), and PostToolUse adds weak `adjacent` reinforcement whenever an edit touches a file listed in a pending proposal's `touches_files`. Total decayed strength (1-hour half-life, weights 1.0 / 0.7 / 0.3 by kind) is recomputed on every read; when it crosses `PROMOTION_THRESHOLD` (2.5), the proposal is auto-promoted to a real `TaskThread` on a synthetic branch `{branch}/proposal-{id}`. The new `task_foraging_report` MCP tool lists pending (above the 0.3 noise floor) and promoted proposals; `SessionStart` surfaces the same report in-preface. Schema bumped 4 → 5: adds `proposals` and `proposal_reinforcements`.
- 42dd222: Add response-threshold routing for broadcast (`to_agent: 'any'`) handoffs. Each agent identity (Claude, Codex, …) can register a capability profile (`ui_work`, `api_work`, `test_work`, `infra_work`, `doc_work`, each `0..1`) via the new `agent_upsert_profile` MCP tool; unknown agents default to `0.5` across all dimensions. When `TaskThread.handOff` runs with `to_agent: 'any'`, it snapshots a keyword-weighted ranking of every non-sender participant into `HandoffMetadata.suggested_candidates`. `SessionStart` preface surfaces the top match and the viewing agent's own score inline with each pending broadcast handoff, so receivers can see at a glance whether they are the best fit. New `agent_get_profile` MCP tool exposes read-only inspection. Schema bumped 5 → 6: adds `agent_profiles` table.

### Patch Changes

- eb4dad9: Rename the public CLI package and workspace package/import namespace from cavemem to Colony. The CLI binary is now `colony`, workspace imports use `@colony/*`, release scripts pack `colony`, and installed hook scripts call `colony`.
- Updated dependencies [eb4dad9]
- Updated dependencies [f1d036a]
- Updated dependencies [5f37e75]
- Updated dependencies [4076133]
- Updated dependencies [42dd222]
  - @colony/compress@0.3.0
  - @colony/config@0.3.0
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
  - @colony/storage@0.2.0
  - @colony/compress@0.2.0
