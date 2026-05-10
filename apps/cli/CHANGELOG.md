# @imdeadpool/colony-cli

## 0.8.0

### Minor Changes

- 86a62d9: `colony bridge lifecycle` gains `--replay <file>` and `--dry-run` so a saved `colony-omx-lifecycle-v1` envelope (e.g. captured `.pre.json`) can be routed offline through the real lifecycle logic without touching the live data dir. Combined with `--json`, this gives runtime integrators a CI-shaped harness for asserting on `route`, `event_type`, `extracted_paths`, and `ok`.

### Patch Changes

- 55581ed: Add `colony demo`: a 60-second guided walkthrough of file-claim contention prevention. Two simulated agents (`claude-code` and `codex`) join the same task and try to claim `src/api.ts`; the second agent gets `blocked_active_owner`, then `claude-code` releases and `codex` retries successfully. The demo runs against an isolated temp data dir and cleans up on exit, with `--json` for a structured transcript and `--keep-data` for inspection. Also ship pre-baked `~/.colony/settings.json` fragments under `examples/policies/` for Next.js monorepos, Python packages, and Rust workspaces — each fragment lists stack-appropriate `privacy.excludePatterns` (build output, caches, `.env`) and `protected_files` (lockfiles, root config). README points to both surfaces from the install block.
- 9376314: Stop mislabelling generic MCP errors and reduce SQLite contention failures.

  - `mcpError` now codes non-`TaskThreadError` throws as `INTERNAL_ERROR` instead of `OBSERVATION_NOT_ON_TASK`, so validation failures and SQLite "database is locked" errors surface honestly in `mcp_metrics` and `colony gain`.
  - Storage now sets `PRAGMA busy_timeout = 5000` on every connection (worker daemon, MCP server, CLI hooks all open separate handles to the same WAL DB), so concurrent writers wait the kernel out instead of throwing `SQLITE_BUSY` immediately.

## 0.7.0

### Minor Changes

- f824d52: Daemonize `colony bridge lifecycle` to cut hot-path CPU.

  Every IDE tool event triggers `colony bridge lifecycle ...` from external hook integrations (oh-my-codex's `ColonyBridge.spawnSync`, Codex/Claude Code settings). Cold-starting Node + JIT + bundle load on each event pegs ~one core for ~300 ms. Multiplied across concurrent agents this is a measurable CPU storm.

  The CLI bin entry is now a POSIX shell wrapper at `apps/cli/bin/colony.sh`. When invoked as `colony bridge lifecycle --json`, the wrapper POSTs the envelope to the long-lived worker daemon at `POST /api/bridge/lifecycle` and exits — no Node startup. Anything else (or any failure on the fast path) execs the Node CLI exactly as before.

  Rule #10 in CLAUDE.md is reworded to reflect that writes still complete in-process when the daemon is unavailable: the wrapper buffers stdin and falls back to Node on curl missing, connection refused, timeout (~2s), non-200, unknown flags, or invocation without `--json`. The fallback is regression-tested in `apps/cli/test/bin-shim.test.ts`. The daemon path itself is tested in `apps/worker/test/server.test.ts` (`POST /api/bridge/lifecycle` block).

  Opt out at any time with `COLONY_BRIDGE_FAST=0`.

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
- 50e13df: `colony health` now merges Codex CLI rollout `mcp_tool_call_end` events from `~/.codex/sessions/` into its share view, matching the recodee dashboard's existing ingest path. Codex doesn't fire colony's PostToolUse hook, so previously every Codex-side MCP call was invisible to `colony health` — `0 / 0 (n/a)` even when the dashboard counted hundreds. The reader honours `CODEX_CLI_SESSIONS_ROOT` like the dashboard backend, and the formatter prints a `sources` line whenever any rollout event was folded in so the breakdown stays auditable.
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

- 58c60b0: Self-healing coordination: periodic claim sweep + protected-branch guard.

  Two architectural fixes that close the loop on the recurring "execution_safety / signal_evaporation" red flags in `colony health`:

  **Auto-sweep loop (`apps/worker/src/coordination-sweep-loop.ts`).** The worker now runs `buildCoordinationSweep({ release_safe_stale_claims: true, release_expired_quota_claims: true })` every `coordinationSweepIntervalMinutes` (default 60). The infrastructure already existed — `Storage.sweepStaleClaims` and `releaseSafeStaleClaims` — but had no automatic trigger, so orphaned claims from sessions that exited without releasing piled up indefinitely (the user just had to release **159** of them at once via a manual sweep). Set the setting to 0 to disable.

  **Protected-branch claim guard (`packages/core/src/scoped-claim.ts`).** `task_claim_file` now rejects claims targeting tasks bound to protected base branches (`main` / `master` / `dev` / `develop` / `production` / `release`) with a new `protected_branch_rejected` status, instead of recording them with a soft warning. This is what stops the dashboard's "claims on protected branches: 2" from reappearing within an hour of every cleanup. The new `rejectProtectedBranchClaims` setting (default true) toggles the behavior; the existing soft-warn path stays available via `rejectProtectedBranchClaims: false` or per-call `COLONY_ALLOW_PROTECTED_CLAIM=1`.

  Also fixes a follow-up regression from PR #444: lowercase `-v` canonicalization is moved from the bin entrypoint into `createProgram().parseAsync` so tests calling `program.parseAsync(['node', 'test', '-v'])` directly hit the same flag-rewrite path. Updates the matching `--help` snapshot.

  Tests:

  - `packages/core/test/scoped-claim.test.ts` — rejection by default; legacy `rejectProtectedBranchClaims: false`; `COLONY_ALLOW_PROTECTED_CLAIM=1` override
  - Existing `apps/mcp-server/test/task-threads.test.ts` opts into the legacy soft-warn behavior since those tests verify contention semantics, not branch policy
  - One outdated `auto-claim` fixture moved off `branch: 'main'` to a canonical `agent/codex/...` branch for the same reason

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

- 2353dce: Expand `colony health` with ant-model coordination health metrics.
- 8e800f4: `attention_inbox` now defaults to a compact payload (`summary` +
  `observation_ids`) and accepts a new `format: "compact" | "full"` flag
  that opts back into the historical fully hydrated shape. Compact mode
  trims the response to the counts and IDs an agent actually needs to
  decide what to call next; bodies stay one `get_observations(ids)` call
  away.

  The `verbose` and `audit` flags keep their existing semantics
  (weak-expired audit-claim visibility) and are now orthogonal to
  `format` — full payload + audit, compact + audit, etc., are all valid.
  Existing `attention_inbox` callers that depended on the inbox arrays
  must pass `format: "full"`.

- b937fb7: Cap `attention_inbox` stalled lane rows by default while preserving total
  counts and explicit expansion.
- 77c9e30: Make PreToolUse auto-claim coverage observable and surface hook-wiring problems instead of agent-discipline ones.

  - The Claude installer now scopes PreToolUse and PostToolUse to a write-tool matcher so the hook does not fire (or get blamed) for unrelated tools.
  - `colony hook run pre-tool-use` now writes its warning back through Claude Code's PreToolUse `permissionDecision: allow` so the agent sees the missing-claim warning instead of it being silently dropped on stderr.
  - The pre-tool-use warning embeds a concrete `next_call` (an exact `mcp__colony__task_claim_file({...})` invocation) and a multi-line actionable `message`, so an agent that hits ACTIVE_TASK_NOT_FOUND / AMBIGUOUS_ACTIVE_TASK / SESSION_NOT_FOUND knows exactly what to do.
  - `claimBeforeEditStats` adds a `pre_tool_use_signals` count of `claim-before-edit` telemetry rows in the window. `colony health` and `hivemind_context`'s claim-before-edit nudge use it to distinguish "hook is not firing" from "agent skipped the claim", and emit an install/restart hint in the former case.
  - `colony health` also reports explicit/manual vs auto-claim breakdown and reads "had a claim before edit" instead of "explicit claims first".

- 4b212e2: Apply `biome check --write` to clear the pre-existing formatting and import-ordering debt that was failing CI lint on every PR. Also rewrites three `try/catch { continue }` patterns in foraging code to the equivalent `null`-guarded `if (!x) continue` shape so biome's `noUnnecessaryContinue` rule passes without an unsafe auto-fix. No behavioral changes.
- 6c8e718: Add a root publish wrapper for the public CLI package and normalize the CLI bin metadata so `npm publish` targets `apps/cli` instead of the private monorepo root.
- 6b09a3d: Add a CocoIndex-ready compact session source for Codex and Claude token usage.
- f769824: `quotaSafeOperatingContract` is rewritten as 7 dense paragraphs instead
  of 36 numbered bullets. Every protocol token (tool names, RTK command
  forms, section markers) and load-bearing phrase is preserved; only the
  prose framing is collapsed. The constant is injected into the
  SessionStart preface every IDE start, so the smaller payload reduces the
  per-session token tax without changing the contract agents must follow.

  `@colony/hooks` and `@colony/installers` re-export the constant
  unchanged; their existing test suites (token-anchored
  `QUOTA_SAFE_CONTRACT_TERMS` plus prose substring assertions) still pass.

- 7d86bd2: `buildCoordinationSweep` now accepts an `archive_completed_plans` option that scans for queen plans whose every sub-task's latest `plan-subtask-claim` observation is `metadata.status='completed'` and archives the parent + sub-task rows via `archiveQueenPlan`. The MCP plan-tool sweep only fires for plans with `auto_archive=true` in plan-config, so opt-out plans linger as "completed but unarchived" on the queen_plan_readiness health signal forever; this gives operators an explicit CLI-driven path to clear them. Sweep result gains `archived_completed_plans` (rows) and `summary.archived_completed_plan_count` (count). Idempotent — already-archived plans are not re-counted.

  Exposed via `colony coordination sweep --archive-completed-plans` (skipped automatically when `--dry-run` is set, like the other release flags).

- 8a9e088: `colony health` no longer flags the `task_ready_for_agent -> claim` conversion as bad when the dashboard's auto_claim signature is present. `task_ready_for_agent` defaulted to `auto_claim=true` in PR #402, so the server claims the unambiguous ready sub-task in the same MCP call without an explicit follow-up `task_plan_claim_subtask` invocation. The conversion metric only counts `tool_use` observations, so it reads near-zero on every health run even though sub-tasks are getting claimed. New gate: when `from_calls > 0`, `to_calls === 0`, and `ready_to_claim_vs_claimed.claimed > 0`, the hint is suppressed because the auto_claim path is doing the work silently. The conversion number itself is unchanged — only the false-positive hint goes away.
- 18df8a1: `docs/mcp.md` `task_ready_for_agent` entry now documents `auto_claim` (defaulted to `true` since PR #402): the server claims the unambiguous ready sub-task in the same MCP call and returns `auto_claimed: { ok, plan_slug, subtask_index, task_id, branch, file_scope }` plus a `next_action` pointing at `task_claim_file`. Also notes that the dashboard's `task_ready_for_agent -> task_plan_claim_subtask` conversion metric reads near-zero in normal operation because the loop closes inside one MCP call, and that `colony health` suppresses the false-positive hint when the auto-claim signature is detected (PR #424).
- 85582a4: `colony health` execution_safety now de-escalates from `bad` to `ok`
  when the only red flag is `old_telemetry_pollution` and the recent
  window is at-or-above the claim-before-edit target. The headline still
  shows the root cause (so the operator knows why the 24h ratio looks
  weak), but the readiness scorer no longer nags to "fix" a lifecycle
  bridge that is already healthy — it just needs the older edits to age
  out of the selected window.

  Any actually-current red flag (live contentions, dirty contended files,
  codex-rollout-without-bridge, session binding missing, or any non-stale
  root cause) keeps execution_safety at `bad`.

- e402540: `colony health` execution_safety no longer demands another lifecycle-bridge
  fix when the recent window is already clean. Two changes:

  - The `lifecycle_claim_mismatch` root cause now defers to
    `old_telemetry_pollution` when the recent 1h window has zero
    `pre_tool_use_missing` and at least the lifecycle-bridge measurable
    threshold of hook-capable edits. Stale 24h `path_mismatch` /
    `worktree_path_mismatch` buckets stop demanding `colony bridge
lifecycle` reinstall when the active editor session is fine; they
    just need to age out of the window.
  - The execution_safety evidence headline falls back to the recent rate
    when the all-time `claim_before_edit_ratio` is `null` (some edits
    lacked `file_path` metadata so status is `not_available`). The
    headline now reads `claim-before-edit n/a (recent 1h: 93%; target
50%+); ...` instead of a bare `n/a`, so operators see real signal
    during partial-metadata windows.

- 5dca65d: Fix `colony --version` (and `-V`) regression introduced by PR #372.

  Commander's `.version(str, flags)` accepts only one short + one long flag in the spec; the original `'-v, -V, --version'` triple silently dropped the trailing entries, so `colony --version` was rejected as an unknown option (caught by `scripts/e2e-publish.sh` check #6). The flag is now registered as the canonical `-V, --version`, and `-v` is canonicalized to `-V` in argv at the bin entrypoint so the lowercase shorthand still works.

- 25d12ac: `colony health` now surfaces a top-tools breakdown and a hook-wiring hint when the window has tool calls but zero `mcp__` entries, so the zero-state is debuggable instead of silent.
- e180b88: Add `colony health --merge-repo-store` so claim-before-edit metrics include the per-repo `<repo_root>/.omx/colony-home/data.db` that codex hooks write to when `COLONY_HOME` redirects them off the global database. Also stop classifying the lifecycle bridge as "unavailable" when PreToolUse signals are present — those signals are direct evidence the hook is firing, regardless of whether the OMX runtime summary stream is connected.
- 7d86bd2: `colony health` now surfaces an `execution_safety` action hint when any `LiveContentionOwner` in `live_contention_health.top_conflicts` holds a claim on a protected base branch (`main`/`master`/`dev`/`develop`/`production`/`release`, via the new `isProtectedBranch` helper from `@colony/storage`). Surfaces `gx branch start "<task>" "<agent>"` as the suggested fix and tells operators which branches are involved. Closes the loop on the Wave 2a `GuardedClaimResult.protected_branch` warning — the signal now propagates from claim time → contention payload → dashboard hint.
- c128606: Default the hook subprocess to the user's canonical Colony home (resolved through `loadSettingsForCwd`) instead of forcing a per-repo `.omx/colony-home/data.db`. The previous default split observations away from `~/.colony/data.db` and pinned the claim-before-edit health metric at 0%. Repos that need per-repo isolation can opt back in via a checked-in `.colony/settings.json` `dataDir` override.
- 36e95ba: Show live gain receipts before the reference model and expand the savings
  operation catalog.
- 2d84352: `colony queen archive` now resolves the plan by branch directly via
  `findTaskByBranch` instead of routing through `queenPlans()`. The queen
  listing only surfaces plans with a `queen` participant, so orphan plans
  published by codex/claude lanes (auto-plan-builder, ad-hoc spec lanes)
  were rejected with `queen plan not found` even though their parent
  task and sub-task rows existed in the DB. Add a public
  `countClaimedQueenPlanSubtasks` helper so the CLI can keep its
  `--force` safety check without reaching into the private `Storage.db`
  handle.
- 127fdf3: Add `colony queen archive <slug>` to dismiss orphan queen plans whose
  openspec change directory was never published. The existing `colony plan
close` and `mcp__colony__spec_archive` paths require a `CHANGE.md` and
  cannot reach DB-only plans (e.g. duplicate auto-plans), so health stayed
  red even after the work was abandoned. The new verb sets `status =
'archived'` on the parent task plus every `spec/<slug>/sub-N` row in one
  transaction, records a `plan-archived` observation, and refuses to run
  with claimed sub-tasks unless `--force` is set. Idempotent: re-running
  on an already-archived plan reports zero rows updated.
- f7fb265: `colony health` no longer counts archived sub-tasks as "remaining" when
  classifying queen plans. Previously a plan archived through `colony
queen archive` (parent + every sub-task flipped to `status='archived'`)
  kept tripping `archived_plans_with_remaining_subtasks` because the
  metric subtracted only `completed` rows, leaving archived rows in the
  remaining bucket. The plan-state recommendation then prompted operators
  to publish a replacement plan even when the work was intentionally
  abandoned. Archived sub-tasks are now subtracted alongside completed
  ones, so a fully-archived plan reports `remaining_subtask_count: 0`
  and stops surfacing in the recommendation list.

  The pre-existing case (parent archived, sub-tasks still open) is
  unchanged: open sub-tasks remain "remaining" and continue to trigger
  the replacement-plan recommendation.

- 3f1fa38: `colony health` Queen plan state repair hint now mentions `colony coordination sweep --archive-completed-plans` in its `inspect` field alongside the existing `colony queen sweep --json` reference. The new bulk flag (added in PR #423) is the operator path that clears all completed-but-unarchived plans without requiring per-plan opt-in; surfacing it in the hint makes it discoverable when the dashboard fires the repair signal.
- 9424987: Expand the token-savings reference model and README explanation so publishable
  packages show clearer Colony gain examples.
- 2a077ed: Add an optional Rust/Tantivy keyword search sidecar with SQLite FTS fallback.
- 0925df5: Document the safe stale-claim cleanup workflow for moving bad `signal_evaporation` health back to healthy readiness.
- 36bd261: Trim the session-start "Joined with" line and the per-turn conflict
  preface so they stop scaling with all-time-joined participants and full
  agent-worktree paths. Long-running task threads were spending hundreds
  of tokens on stale session lists every resume; the conflict preface was
  spending hundreds more per turn on duplicated worktree prefixes. Cap
  joined-with at 8 entries with `+N more` overflow, gate by a 1-hour
  last-activity window, and strip `.omx|.omc/agent-worktrees/<dir>/`
  from claimed file paths plus collapse session ids to their 8-char
  shorthand.

## Unreleased

### telemetry-driven coordination tightening

- Worker viewer now surfaces coordination drift from telemetry: edits without claims, sessions without handoff, blockers without messages, and abandoned proposals.
- `colony debrief` now reports coordination write/read ratio so release checks can see whether agents only read state or also leave durable coordination writes.
- Stranded session rescue now exposes owner-recovery diagnostics through MCP and the worker loop instead of requiring manual cleanup.
- Relay fallback guidance now stays visible when `task_relay` is unavailable, including debrief copy that names the fallback primitive.
- Edit and write hooks now auto-claim touched files so observed ownership is recorded even when agents forget the explicit claim step.
- MCP coordination tools now avoid dead wake overlap and make minimal `task_message` sends match `task_post` ergonomics.
- Built-in `TaskCreate` and `TaskUpdate` calls now mirror into task-thread observations without changing agent habits.
- Bash `git` and file operations now become coordination observations, including checkout and `rm` side effects for debrief/timeline evidence.
- MCP tool descriptions now steer intent-based search toward the active coordination primitives and their fallback rules.

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

- f48269e: Add `recall_session` MCP tool. An agent passes a `target_session_id` plus its own `current_session_id`, and the tool returns a compact timeline of the target (IDs + kind + ts only — bodies still come from `get_observations(ids[])`) while writing a `kind: 'recall'` observation into the _caller's_ session as the audit trail.

  The recall observation introduces a new wire contract that other code may filter on:

  - `kind === 'recall'`
  - `metadata.recalled_session_id` — the consulted session
  - `metadata.owner_ide` — `inferIdeFromSessionId` fallback when the target's `ide` column is `unknown`, so foreign-session recalls stay traceable without re-inferring at read time
  - `metadata.observation_ids` — the timeline slice that was returned
  - `metadata.around_id` and `metadata.limit` — the request parameters that produced the slice

  Both session ids are validated via `Storage.getSession()` before any write. `MemoryStore.addObservation` routes through `ensureSession` (memory-store.ts:96), which silently materialises a missing sessions row — without these checks a typo'd `current_session_id` would create a phantom session and write a recall observation into it. Errors come back as `{ code: 'SESSION_NOT_FOUND', error }`.

  Also extends `GET /api/sessions/:id/observations` on the worker viewer with an `?around=<id>&limit=<n>` query so the same paged timeline is reachable from the HTTP surface (the route already proxied to `Storage.timeline`, which has supported `aroundId` for a while). Cross-session `?around` ids cleanly return `[]` rather than spilling into the target window, matching the SQL filter on `session_id`.

- Add the debrief coordination-ratio section so the CLI reports whether agents only read Colony state or also leave durable coordination writes behind.
- Make edit hooks claim files automatically after successful write tools so the hook layer records observed ownership even when agents forget to claim manually.
- 754949f: Add wake-request primitive and attention inbox for idle/stalled cross-agent nudges.

  - `task_wake` / `task_ack_wake` / `task_cancel_wake` MCP tools post lightweight nudges on a task thread — no claim transfer, no baton pass. Targets see the request on their next SessionStart or UserPromptSubmit turn with a copy-paste-ready ack call.
  - `attention_inbox` MCP tool + `colony inbox` CLI command aggregate pending handoffs, pending wakes, stalled lanes from the hivemind snapshot, and recent other-session file claims into one compact view. Bodies are not expanded; fetch via `get_observations`.
  - Hook injection extended: `buildTaskPreface` surfaces pending wake requests alongside pending handoffs; `buildTaskUpdatesPreface` inlines an ack call for wake requests that arrive between turns.

  Deferred follow-ups (not in this change): safe session takeover, claim TTL renewal, session Stop checkpoint, and any terminal-control wake mechanism.

### Patch Changes

- Remove stale `task_ack_wake` guidance from CLI-facing coordination output now that wake MCP tools are retired; pending wake observations remain visible, but agents are routed to `task_message` / `task_post`.
- 5c9fa69: Add a `colony backfill ide` command that heals session rows whose stored `ide` is `'unknown'` by re-running the shared `inferIdeFromSessionId` helper against the row's session id. This is intended as a one-shot clean-up for databases populated before the hook-side inference learned to handle hyphen-delimited (`codex-...`) and Guardex-branch (`agent/<name>/...`) session ids. The underlying `Storage.backfillUnknownIde(mapper)` is idempotent, returns `{ scanned, updated }`, and skips any row the mapper cannot classify so it never invents an owner.
- 5928655: `colony config set` now coerces values using the settings schema instead
  of a regex. The old heuristic parsed anything matching `^-?\d+$` as a
  number — so `colony config set embedding.model 1.0` silently stored the
  number `1`. The new logic walks `SettingsSchema` to the target field and
  coerces only when the leaf type calls for it (booleans → bool, numbers
  → number, arrays/objects/records → JSON, enums and strings → raw). Zod
  still validates the final result, so malformed input is rejected with a
  shape-aware error rather than coerced into the wrong JS type.
- 77b4e06: Add `Storage.toolInvocationDistribution(since_ts, limit?)` and surface it as Section 5 of `colony debrief` (the timeline becomes Section 6). Each `tool_use` observation already carries the tool name in `metadata.tool`, so this is a pure read-side aggregation — no new write path or worker state file. The output lists every tool that fired in the window with call count and percent share, sorted descending; `mcp__*` tools are tinted cyan so MCP-vs-builtin signal stands out at a glance. The point is empirical: if `mcp__colony__task_post` fires once and `mcp__colony__task_propose` fires zero times in a week, that's a real signal about which mechanism is doing the work.
- 1309239: Drop the drifted local copy of `inferIdeFromSessionId` in the hook command and import the shared helper from `@colony/core`. The local copy only matched `codex@` / `claude@` prefixes, so ids like `agent/claude/<task>`, `codex-<task>`, or `claudecode/foo` fell through as `undefined` and the hook wrote `ide = 'unknown'` for them — the same drift the `colony backfill ide` command then had to repair. One source of truth means the write path and the backfill path cannot diverge again.
- 74b2a7c: Validate each JSONL row in `colony import` with a zod discriminated
  union. Previously malformed rows were coerced with `String()` /
  `Number()` and silently inserted as `NaN` timestamps or `"undefined"`
  strings. Now the command fails fast with `<file>:<line>: <field>:
<message>` the moment a row does not match the export schema.
- 185a9d9: Extract shared `isMainEntry`, pidfile helpers, `isAlive`, and the
  `spawn(process.execPath, …)` wrapper into a new `@colony/process`
  package. These utilities had divergent copies in four places
  (`apps/cli/src/commands/lifecycle.ts`, `apps/cli/src/commands/worker.ts`,
  `apps/mcp-server/src/server.ts`, `apps/worker/src/server.ts`, and
  `packages/hooks/src/auto-spawn.ts`). The regex that decides whether
  Node should be invoked via `execPath` — the Windows EFTYPE guard —
  and the realpath-normalized bin-shim check both now live exactly once.

  No behavior change. Internal helper refactor only.

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

- Mirror built-in TaskCreate and TaskUpdate calls into Colony task observations so task activity is visible without changing agent tool habits.
- Record Bash git and file operations as coordination observations so checkout, branch, merge, rm, mv, cp, and redirect side effects show up in debrief and timeline evidence.
- Reveal Bash coordination writes from PostToolUse by keeping git/file operation observations separate from redirect auto-claims.
- 2f371d4: Add `Storage.rebuildFts()` so the CLI `reindex` command no longer
  reaches through the type system to poke `better-sqlite3`. Behavior is
  unchanged — `reindex` still runs the FTS5 `'rebuild'` statement — but
  the public API is now typed and callers do not cast through `unknown`.

> History note: the CLI was published as `cavemem` through 0.3.0 and renamed to
> `@imdeadpool/colony` during the 0.3.0 cycle, then `@imdeadpool/colony-cli`
> during the 0.5.0 cycle. Version 0.4.0 was consumed by the
> `@colony/mcp-server` heartbeat bump (the CLI did not publish a 0.4.0); 0.5.0
> is the first linked release where the CLI and `@colony/*` workspace packages
> ship together.

## 0.5.0

### Minor Changes

- Sync linked release with the 0.4.0 MCP heartbeat bump so `@imdeadpool/colony`
  and the supporting `@colony/*` workspace packages publish together.

## 0.3.0

### Patch Changes

- eb4dad9: Rename the public CLI package and workspace package/import namespace from cavemem to Colony. The CLI binary is now `colony`, workspace imports use `@colony/*`, release scripts pack `colony`, and installed hook scripts call `colony`.
- f1d036a: Bind hook-created sessions back to their repository cwd so colony views can see live Codex/Claude work instead of orphan `cwd: null` sessions.
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
