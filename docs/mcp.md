# MCP tools

colony exposes MCP tools over a stdio server. IDE installers register that server as `colony`, so agent tool calls appear under the `colony` namespace. The design goal is **progressive disclosure**: hits are compact until the agent asks for more.

The recommended workflow is a three-layer pattern:

1. `search` (or `list_sessions` → `timeline`) to get a compact index.
2. Review IDs.
3. `get_observations` with the filtered set.

For multi-agent runtime awareness, call `hivemind_context` first when you need ownership plus likely memory hits, or `hivemind` when you only need the runtime map. Both return compact active worktrees, branches, agents, and task previews from `.omx` proxy-runtime state without fetching observation bodies.

Following this pattern saves ~10× tokens versus fetching full bodies upfront.

## `search`

Find observations matching a natural-language query.

```json
{
  "name": "search",
  "input": { "query": "auth middleware", "limit": 10 }
}
```

Returns: `[ { id, session_id, snippet, score, ts } ]`

Scoring is hybrid: keyword (FTS5 BM25) blended with vector similarity via `settings.search.alpha`. Missing fields fall back gracefully.

## `timeline`

Chronological observation identifiers for a given session.

```json
{
  "name": "timeline",
  "input": { "session_id": "sess_abc", "around_id": 42, "limit": 50 }
}
```

Returns: `[ { id, kind, ts } ]` — no body content. Use the IDs in `get_observations`.

## `get_observations`

Fetch full observation bodies by ID.

```json
{
  "name": "get_observations",
  "input": { "ids": [12, 34], "expand": true }
}
```

Returns: `[ { id, session_id, kind, ts, content, metadata } ]`.

Content is expanded to human-readable form by default. Pass `expand: false` to request the compressed form (useful for audit or for agents that understand the caveman dialect directly).

## `list_sessions`

List recent sessions in reverse chronological order.

```json
{
  "name": "list_sessions",
  "input": { "limit": 20 }
}
```

Returns: `[ { id, ide, cwd, started_at, ended_at } ]`. Use `id` with `timeline` to navigate within a session.

## `hivemind`

Summarize what active agent sessions are doing now.

```json
{
  "name": "hivemind",
  "input": {
    "repo_root": "/home/deadpool/Documents/recodee",
    "include_stale": false,
    "limit": 50
  }
}
```

Returns:

```json
{
  "generated_at": "2026-04-23T08:01:00.000Z",
  "repo_roots": ["/home/deadpool/Documents/recodee"],
  "session_count": 1,
  "counts": { "working": 1, "thinking": 0, "idle": 0, "stalled": 0, "dead": 0, "unknown": 0 },
  "sessions": [
    {
      "branch": "agent/codex/live-task",
      "task": "Expose runtime tasks to Codex",
      "agent": "codex",
      "activity": "working",
      "worktree_path": "/home/deadpool/Documents/recodee/.omx/agent-worktrees/live-task",
      "source": "active-session"
    }
  ]
}
```

Inputs:

- `repo_root`: one workspace root to inspect. Defaults to the MCP server process cwd.
- `repo_roots`: multiple workspace roots to inspect. Also configurable with `COLONY_HIVEMIND_REPO_ROOTS` separated by the platform path delimiter.
- `include_stale`: include dead active-session records. Defaults to `false`.
- `limit`: maximum sessions returned, capped at 100.

Sources:

- `.omx/state/active-sessions/*.json` from the proxy runtime / Guardex active-agent producer.
- `.omx/agent-worktrees/*/AGENT.lock` and `.omc/agent-worktrees/*/AGENT.lock` as a telemetry fallback for task previews.

Use this from a Codex skill as the first context step when the skill needs to know which session owns which task before reading memory timelines.

## `hivemind_context`

Return live lane ownership plus compact relevant memory hits in one request.

```json
{
  "name": "hivemind_context",
  "input": {
    "repo_root": "/home/deadpool/Documents/recodee",
    "query": "session takeover stale source",
    "memory_limit": 3,
    "limit": 20
  }
}
```

Returns:

```json
{
  "generated_at": "2026-04-23T08:01:00.000Z",
  "summary": {
    "lane_count": 1,
    "memory_hit_count": 3,
    "needs_attention_count": 0,
    "next_action": "Use lane ownership first, then fetch only the specific memory IDs needed."
  },
  "lanes": [
    {
      "branch": "agent/codex/live-task",
      "task": "Expose runtime tasks to Codex",
      "owner": "codex/codex",
      "activity": "working",
      "needs_attention": false
    }
  ],
  "memory_hits": [
    { "id": 42, "session_id": "sess_abc", "snippet": "compact hit", "score": 1.2, "ts": 1710000000000 }
  ]
}
```

Inputs:

- `repo_root`, `repo_roots`, `include_stale`, and `limit`: same as `hivemind`.
- `query`: optional memory query. If omitted, the server derives one from active task text.
- `memory_limit`: compact memory hits to return, capped at 10 and defaulting to 3.

Use this for takeover, review, or resume flows where the agent needs current ownership and a small memory index before deciding which full observations to fetch.

## `examples_list`

List indexed example projects (food sources) discovered under `<repo_root>/examples/<name>/`. Populated by the `colony foraging scan` command and by the SessionStart hook when `settings.foraging.scanOnSessionStart` is true.

```json
{
  "name": "examples_list",
  "input": { "repo_root": "/abs/path/to/repo" }
}
```

Returns: `[ { example_name, manifest_kind, observation_count, last_scanned_at } ]`.

`manifest_kind` is one of `npm`, `pypi`, `cargo`, `go`, `unknown`, or `null`. `observation_count` is the cached number of `foraged-pattern` observations the indexer wrote for that example. Use this to choose a target for `examples_query` or `examples_integrate_plan`.

## `examples_query`

BM25-ranked search scoped to `kind = 'foraged-pattern'` observations, optionally narrowed to a single example.

```json
{
  "name": "examples_query",
  "input": { "query": "webhook signature", "example_name": "stripe-webhook", "limit": 10 }
}
```

Returns compact hits: `[ { id, session_id, snippet, score, ts } ]`. Follow with `get_observations(ids[])` for full bodies. Vector re-rank is intentionally skipped when a filter is present — the embedding index has no kind column.

## `examples_integrate_plan`

Build a deterministic plan for integrating a food source into the target repo. No LLM in the loop — the plan is derived from the indexed manifest and entrypoints plus a fresh read of the target `package.json`.

```json
{
  "name": "examples_integrate_plan",
  "input": {
    "repo_root": "/abs/path/to/repo",
    "example_name": "stripe-webhook",
    "target_hint": "apps/api/package.json"
  }
}
```

Returns:

```json
{
  "example_name": "stripe-webhook",
  "dependency_delta": { "add": { "stripe": "^14.0.0" }, "remove": ["lodash"] },
  "files_to_copy": [
    { "from": "examples/stripe-webhook/src/index.ts", "to_suggestion": "src/index.ts", "rationale": "…" }
  ],
  "config_steps": ["npm run build", "npm run test"],
  "uncertainty_notes": ["…"]
}
```

`dependency_delta.add` lists example deps missing from the target. `dependency_delta.remove` is informational — it is never a recommendation to delete. Only `npm` examples produce a real diff today; other `manifest_kind`s emit an uncertainty note and leave `add` empty. `target_hint` is optional: absolute paths are used as-is, relative paths are joined onto `repo_root`, and the default is `<repo_root>/package.json`.

## `task_list`

List recent task threads. Each task groups sessions collaborating on the same `(repo_root, branch)`.

```json
{ "name": "task_list", "input": { "limit": 50 } }
```

Returns: `[ { id, title, repo_root, branch, status, created_by, created_at, updated_at } ]`.

## `task_timeline`

Compact observation index for a task thread.

```json
{ "name": "task_timeline", "input": { "task_id": 17, "limit": 50 } }
```

Returns: `[ { id, kind, session_id, ts, reply_to } ]`. Use the IDs with `get_observations`.

## `task_updates_since`

Task-thread observations after `since_ts`, with the caller's own posts filtered out — tailored for "what changed while I was away".

```json
{
  "name": "task_updates_since",
  "input": { "task_id": 17, "session_id": "sess_abc", "since_ts": 1714000000000, "limit": 50 }
}
```

Returns: `[ { id, kind, session_id, ts } ]`.

## `task_post`

Post a coordination message on a task thread. Use the dedicated tools (`task_claim_file`, `task_hand_off`, `task_accept_handoff`) for structured actions; `task_post` is for free-form notes tagged with a `kind`.

```json
{
  "name": "task_post",
  "input": {
    "task_id": 17,
    "session_id": "sess_abc",
    "kind": "decision",
    "content": "Using BM25 + cosine hybrid with alpha=0.5",
    "reply_to": 123
  }
}
```

`kind` ∈ `question | answer | decision | blocker | note`. Returns `{ id }`.

## `task_claim_file`

Claim a file on a task so overlapping edits from other sessions surface a warning next turn. This is the soft-lock path — it never blocks writes; it arms the conflict preface.

```json
{
  "name": "task_claim_file",
  "input": {
    "task_id": 17,
    "session_id": "sess_abc",
    "file_path": "packages/storage/src/storage.ts",
    "note": "extending searchFts with a filter arg"
  }
}
```

Returns `{ observation_id }`.

## `task_hand_off`

Hand off work to another agent on this task. Atomically transfers file claims from the sender to the receiver when combined with `task_accept_handoff`.

```json
{
  "name": "task_hand_off",
  "input": {
    "task_id": 17,
    "session_id": "sess_abc",
    "agent": "claude",
    "to_agent": "codex",
    "summary": "Implementation landed. Codex: run the e2e script and check the pack-release path.",
    "next_steps": ["run scripts/e2e-publish.sh", "verify apps/cli/release/ is populated"],
    "blockers": [],
    "transferred_files": ["apps/cli/scripts/pack-release.mjs"],
    "expires_in_minutes": 60
  }
}
```

`to_agent` ∈ `claude | codex | any`. Use `any` to broadcast; the router surfaces capability-ranked candidates in the recipient's SessionStart preface. Returns `{ handoff_observation_id, status: 'pending' }`. The handoff is visible to the target at their next SessionStart with inlined `accept with:` / `decline with:` tool-call snippets.

## `task_accept_handoff`

Accept a pending handoff addressed to you. Installs the transferred file claims under the accepting session.

```json
{
  "name": "task_accept_handoff",
  "input": { "handoff_observation_id": 401, "session_id": "sess_xyz" }
}
```

Returns `{ status: 'accepted' }` on success, `{ error }` when the observation is not a handoff or is already resolved.

## `task_decline_handoff`

Decline a pending handoff. Records a reason so the sender can reissue, possibly targeting a different agent.

```json
{
  "name": "task_decline_handoff",
  "input": {
    "handoff_observation_id": 401,
    "session_id": "sess_xyz",
    "reason": "out of scope for this branch"
  }
}
```

Returns `{ status: 'cancelled' }` on success.

## `task_wake`

Post a wake request on a task thread — a lightweight nudge surfaced to the target on their next turn. No claim transfer. Use when another session needs to attend to something but a full handoff is the wrong shape.

```json
{
  "name": "task_wake",
  "input": {
    "task_id": 17,
    "session_id": "sess_abc",
    "agent": "claude",
    "to_agent": "codex",
    "reason": "New §V invariant added — please re-run your build",
    "next_step": "spec_build_context again with task_id=T5",
    "expires_in_minutes": 120
  }
}
```

Returns `{ wake_observation_id, status: 'pending' }`.

## `task_ack_wake`

Acknowledge a pending wake request. Records an ack on the task thread so the sender sees the response on their next turn.

```json
{
  "name": "task_ack_wake",
  "input": { "wake_observation_id": 512, "session_id": "sess_xyz" }
}
```

Returns `{ status: 'acknowledged' }`.

## `task_cancel_wake`

Cancel a pending wake. Either the sender (withdrawing) or the target (declining) may cancel.

```json
{
  "name": "task_cancel_wake",
  "input": { "wake_observation_id": 512, "session_id": "sess_xyz", "reason": "already done" }
}
```

Returns `{ status: 'cancelled' }`.

## `attention_inbox`

Compact list of what needs the caller's attention: pending handoffs, pending wakes, stalled lanes, and recent other-session file claims. Fetch full bodies via `get_observations`.

```json
{
  "name": "attention_inbox",
  "input": {
    "session_id": "sess_abc",
    "agent": "claude",
    "repo_roots": ["/abs/repo-a", "/abs/repo-b"],
    "recent_claim_window_minutes": 30,
    "recent_claim_limit": 20
  }
}
```

Either `repo_root` or `repo_roots` scopes the inbox. `task_ids` can narrow further. Returns a structured payload with the four buckets above; each entry carries the IDs to hydrate on demand.

## `task_propose`

Propose a potential improvement scoped to `(repo_root, branch)`. The proposal becomes a real task only after collective reinforcement crosses the promotion threshold.

```json
{
  "name": "task_propose",
  "input": {
    "repo_root": "/abs/repo",
    "branch": "main",
    "summary": "Extract a shared ExamplesIndex helper",
    "rationale": "Three call sites reimplement the walk; diverging filter lists now.",
    "touches_files": ["apps/cli/src/commands/foraging.ts", "apps/mcp-server/src/tools/foraging.ts"],
    "session_id": "sess_abc"
  }
}
```

Returns `{ proposal_id, strength, promotion_threshold }`.

## `task_reinforce`

Reinforce a pending proposal. `kind='explicit'` for direct support; `'rediscovered'` when you arrived at the same idea independently (weights higher — evidence of convergent need).

```json
{
  "name": "task_reinforce",
  "input": { "proposal_id": 42, "session_id": "sess_xyz", "kind": "rediscovered" }
}
```

Returns `{ proposal_id, strength, promoted, task_id }`. `promoted` flips `true` when the reinforcement crosses the threshold; `task_id` becomes non-null at the same moment.

## `task_foraging_report`

List pending and recently promoted proposals on a `(repo_root, branch)`. Pending proposals whose strength has evaporated below the noise floor are omitted.

```json
{
  "name": "task_foraging_report",
  "input": { "repo_root": "/abs/repo", "branch": "main" }
}
```

Returns `{ pending: [ { id, strength, summary, ... } ], promoted: [ { id, task_id, summary, ... } ] }`.

## `agent_upsert_profile`

Set or update an agent's capability profile. Weights ∈ `[0, 1]`; missing weights keep their current value (or the `0.5` default for first-time profiles). Used by the handoff router to rank candidates for `to_agent: 'any'` broadcasts.

```json
{
  "name": "agent_upsert_profile",
  "input": {
    "agent": "claude",
    "capabilities": { "ui_work": 0.8, "api_work": 0.7, "test_work": 0.6 }
  }
}
```

Returns the saved profile.

## `agent_get_profile`

Read an agent's capability profile. Unknown agents return the default (`0.5` across all dimensions).

```json
{ "name": "agent_get_profile", "input": { "agent": "claude" } }
```

Returns `{ agent, capabilities, defaults }`.

## `spec_read`

Read the root `SPEC.md` for a repo. Returns parsed sections and the root hash — use the hash when opening a change to pin the base.

```json
{ "name": "spec_read", "input": { "repo_root": "/abs/repo" } }
```

Returns `{ rootHash, sections, alwaysInvariants }`. Section bodies are raw; row counts are included where the section has tabular rows so callers can decide whether to hydrate.

## `spec_change_open`

Open a new spec change. Creates `openspec/changes/<slug>/CHANGE.md`, opens a task-thread on `spec/<slug>`, and joins the caller as a participant.

```json
{
  "name": "spec_change_open",
  "input": {
    "repo_root": "/abs/repo",
    "slug": "add-embedding-batch-size",
    "session_id": "sess_abc",
    "agent": "claude",
    "proposal": "Wire the batchSize setting into createEmbedder."
  }
}
```

`slug` must be kebab-case. Returns `{ task_id, path, base_root_hash }`.

## `spec_change_add_delta`

Append a delta row to an in-flight change. `op` ∈ `add | modify | remove`; `target` is a root spec id like `V.3` or `T.12`.

```json
{
  "name": "spec_change_add_delta",
  "input": {
    "repo_root": "/abs/repo",
    "slug": "add-embedding-batch-size",
    "session_id": "sess_abc",
    "op": "modify",
    "target": "V.3",
    "row_cells": ["must", "embedding.batchSize passes through to createEmbedder"]
  }
}
```

Returns `{ delta_count }` — the running total for the change.

## `spec_build_context`

Resolve cite-scoped context for a `§T` task id. Returns only the invariants and rows the task is obliged to respect, plus `§V.always` entries — not the whole spec.

```json
{ "name": "spec_build_context", "input": { "repo_root": "/abs/repo", "task_id": "T5" } }
```

Returns `{ cited_ids, always_invariants, rendered }`. Errors with `{ error: 'no task <id>' }` when the task is not present.

## `spec_build_record_failure`

Record a test failure during `/co:build`. Hashes the signature, appends `§B`, and — if the `promote_after` threshold is reached — proposes a `§V` invariant via the colony ProposalSystem.

```json
{
  "name": "spec_build_record_failure",
  "input": {
    "repo_root": "/abs/repo",
    "slug": "add-embedding-batch-size",
    "session_id": "sess_abc",
    "agent": "claude",
    "test_id": "packages/embedding/test/batch.test.ts:14",
    "error": "Expected 16 but got 1",
    "stack": "…",
    "error_summary": "batchSize ignored when provider=local",
    "promote_after": 3
  }
}
```

Returns `{ action, signature_hash, match_count, proposal_id }`. `action` describes whether the gate just logged, promoted to a proposal, or skipped as duplicate.

## `spec_archive`

Validate, three-way-merge, and archive an in-flight change. Atomic: either the archive and root write both land, or neither does.

```json
{
  "name": "spec_archive",
  "input": {
    "repo_root": "/abs/repo",
    "slug": "add-embedding-batch-size",
    "session_id": "sess_abc",
    "agent": "claude",
    "strategy": "three_way"
  }
}
```

`strategy` ∈ `three_way | refuse_on_conflict | last_writer_wins`. Returns `{ status, archived_path, merged_root_hash, conflicts, applied }`. On `refuse_on_conflict` with real conflicts, the call returns `status: 'refused'` and `isError: true` so the caller sees the conflict set without committing.

## Contract stability

Fields may be added. Existing fields will not be removed or renamed within a minor version.
