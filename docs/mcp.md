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
    "summary": "Implementation landed. Codex: run the publish e2e script.",
    "next_steps": ["run scripts/e2e-publish.sh", "verify the packed CLI tarball includes staged assets"],
    "blockers": [],
    "transferred_files": ["apps/cli/scripts/prepack.mjs"],
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

Returns `{ status: 'accepted' }` on success. Errors include `{ code, error }`, where `code` is stable for branching, for example `HANDOFF_EXPIRED`, `NOT_PARTICIPANT`, `NOT_TARGET_AGENT`, or `ALREADY_ACCEPTED`.

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

Returns `{ status: 'cancelled' }` on success. Errors include `{ code, error }`.

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

Returns `{ status: 'acknowledged' }`. Errors include `{ code, error }`, for example `WAKE_EXPIRED`, `NOT_PARTICIPANT`, `NOT_TARGET_AGENT`, or `ALREADY_ACKNOWLEDGED`.

## `task_cancel_wake`

Cancel a pending wake. Either the sender (withdrawing) or the target (declining) may cancel.

```json
{
  "name": "task_cancel_wake",
  "input": { "wake_observation_id": 512, "session_id": "sess_xyz", "reason": "already done" }
}
```

Returns `{ status: 'cancelled' }`. Errors include `{ code, error }`.

## `task_message`

Send a direct message to another agent on a task thread. Use for coordination chat that **doesn't** transfer file claims — for "hand off the work + files", use `task_hand_off`. A message is a `task_post` with kind `message`, explicit addressing, and a read/reply/expire/retract/claim lifecycle.

```json
{
  "name": "task_message",
  "input": {
    "task_id": 17,
    "session_id": "sess_abc",
    "agent": "claude",
    "to_agent": "codex",
    "to_session_id": "sess_xyz",
    "content": "can you re-run the typecheck on your branch?",
    "urgency": "needs_reply",
    "reply_to": 401,
    "expires_in_minutes": 60
  }
}
```

`to_agent` ∈ `claude | codex | any` — `any` broadcasts to every participant but the sender. `to_session_id` narrows delivery to a specific live session. `urgency` ∈ `fyi | needs_reply | blocking` and controls preface prominence: `fyi` coalesces into a counter, `needs_reply` renders as a summary, `blocking` lands at the top of the preface and never coalesces. `reply_to` chains a reply; the parent message's status flips to `replied` atomically on the send. **Reply chains are 1-deep authoritative**: replies-to-replies are allowed, but only the immediate parent's status flips, never a transitively-referenced ancestor. `expires_in_minutes` (max 7 days) gives the message a TTL — past-TTL unread messages drop out of inbox queries and any later `task_message_mark_read` returns `MESSAGE_EXPIRED`; bodies remain in storage for audit and stay searchable via FTS. Replying to a still-unclaimed broadcast auto-claims it for the replier (see `task_message_claim`). Returns `{ message_observation_id, status: 'unread' }`.

## `task_messages`

List messages addressed to you across tasks you participate in (or scoped with `task_ids`). Compact shape — fetch full bodies via `get_observations`. Does **not** mark as read; call `task_message_mark_read` explicitly so an agent can peek at its inbox during planning without burning the "you have new mail" signal. Retracted messages and broadcasts already claimed by other agents are filtered out of every recipient's view.

```json
{
  "name": "task_messages",
  "input": {
    "session_id": "sess_abc",
    "agent": "claude",
    "since_ts": 1714000000000,
    "unread_only": true,
    "limit": 50
  }
}
```

Returns `[ { id, task_id, ts, from_session_id, from_agent, to_agent, to_session_id, urgency, status, reply_to, preview, expires_at, is_claimable_broadcast, claimed_by_session_id, claimed_by_agent } ]`, newest-first. `status` reflects the effective state: an `unread` row past its TTL surfaces as `expired` even if the on-disk status hasn't been rewritten yet.

## `task_message_mark_read`

Mark a message as read. Idempotent — re-marking a read or replied message is a no-op. Writes a sibling `message_read` observation so the original sender sees a read receipt in their `attention_inbox`. Returns the resulting `status`.

```json
{
  "name": "task_message_mark_read",
  "input": { "message_observation_id": 512, "session_id": "sess_xyz" }
}
```

Errors include `{ code, error }` with stable codes: `NOT_MESSAGE`, `TASK_MISMATCH`, `OBSERVATION_NOT_ON_TASK`, `NOT_PARTICIPANT`, `NOT_TARGET_SESSION`, `NOT_TARGET_AGENT`, `MESSAGE_EXPIRED` (TTL elapsed before read; status flips to `expired` on the same call), or `ALREADY_RETRACTED` (sender retracted the message).

## `task_message_retract`

Retract a message you sent. Sets the status to `retracted` and the body stops surfacing in any recipient's inbox; the body stays in storage (still searchable via FTS, still in the timeline) for audit. Cannot retract a message that has already been replied to — at that point the recipient has invested response work and silently rewriting the sender's intent would be deceptive.

```json
{
  "name": "task_message_retract",
  "input": {
    "message_observation_id": 512,
    "session_id": "sess_abc",
    "reason": "duplicate of #498"
  }
}
```

Errors: `NOT_MESSAGE`, `TASK_MISMATCH`, `NOT_SENDER` (only the original sender may retract), `ALREADY_REPLIED`, `ALREADY_RETRACTED`.

## `task_message_claim`

Claim a `to_agent='any'` broadcast message. Once claimed, the broadcast drops out of every other recipient's inbox; only the claimer keeps seeing it. Use when you want to silently take ownership of a broadcast before responding — replying via `task_message` already auto-claims, so this tool is for the "I'll handle it but not yet ready to reply" case.

```json
{
  "name": "task_message_claim",
  "input": {
    "message_observation_id": 730,
    "session_id": "sess_xyz",
    "agent": "codex"
  }
}
```

Returns `{ status: 'claimed', claimed_by_session_id, claimed_by_agent, claimed_at }`. Errors: `NOT_MESSAGE`, `NOT_BROADCAST` (directed messages can't be claimed), `NOT_PARTICIPANT`, `ALREADY_CLAIMED` (someone else got there first — idempotent for the existing claimer), `MESSAGE_EXPIRED`, `ALREADY_RETRACTED`.

## `recall_session`

Pull a compact timeline of a past session (your own or another agent's) and audit the recall as a `kind: 'recall'` observation in the calling session. Use this when you need to stand on context from an earlier lane without pasting bodies into your current session.

```json
{
  "name": "recall_session",
  "input": {
    "target_session_id": "codex-abc-123",
    "current_session_id": "claude-now-789",
    "around_id": 4421,
    "limit": 25
  }
}
```

`target_session_id` is the session whose memory you want to read. `current_session_id` is **your** session — it must already exist (the tool will not auto-create it). `around_id` centres the window on a specific observation id; `limit` caps the count (default 20, max 100).

Returns:

```json
{
  "recall_observation_id": 9012,
  "session": { "id": "codex-abc-123", "ide": "codex", "cwd": "/repo", "started_at": 1714000000000, "ended_at": null },
  "observations": [{ "id": 4418, "kind": "edit", "ts": 1714000000123 }, ...]
}
```

Progressive disclosure: `observations` carries IDs only — fetch full bodies via `get_observations(ids[])`. The `recall_observation_id` is the audit row written into your current session, with metadata:

```json
{
  "recalled_session_id": "codex-abc-123",
  "owner_ide": "codex",
  "observation_ids": [4418, 4419, 4420, 4421, 4422],
  "around_id": 4421,
  "limit": 25
}
```

Wire contract: `kind: 'recall'`, plus `metadata.recalled_session_id`, `metadata.owner_ide`, and `metadata.observation_ids`. UI surfaces and search filters can key off these fields. `owner_ide` falls back to `inferIdeFromSessionId(target_session_id)` when the sessions row lists `ide` as `unknown`.

Errors include `{ "code": "SESSION_NOT_FOUND", "error": "..." }` when either `target_session_id` or `current_session_id` is missing — the tool refuses to silently materialise a phantom session via `MemoryStore.ensureSession`.

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

## `task_plan_publish`

Publish a multi-task plan as a spec change with one task thread per sub-task. Sub-tasks live on `spec/<slug>/sub-N` branches and link back via `metadata.parent_plan_slug`. The originating agent does **not** auto-join sub-tasks — publishing is advertising, not claiming.

```json
{
  "name": "task_plan_publish",
  "input": {
    "repo_root": "/abs/repo",
    "slug": "add-widget-page",
    "session_id": "sess_abc",
    "agent": "claude",
    "title": "Add widget page",
    "problem": "No widget page exists yet; users have no entry point.",
    "acceptance_criteria": ["Widget page renders", "Widget API returns rows"],
    "subtasks": [
      {
        "title": "Build widget API",
        "description": "Add GET /api/widgets that returns rows.",
        "file_scope": ["apps/api/src/widgets.ts"],
        "capability_hint": "api_work"
      },
      {
        "title": "Build widget page",
        "description": "Render the widget list with a card per row.",
        "file_scope": ["apps/frontend/src/pages/widgets.tsx"],
        "depends_on": [0],
        "capability_hint": "ui_work"
      }
    ],
    "auto_archive": false
  }
}
```

Validation:

- `subtasks` must contain at least 2 entries; for a single task use `task_thread` directly.
- `depends_on` indices are zero-based and must point to **earlier** indices (cycle prevention).
- Independent sub-tasks (no `depends_on` chain between them) cannot share `file_scope` entries. To overlap files, sequence the work via `depends_on`.

Optional inputs:

- `auto_archive` (default `false`): when `true`, the parent spec change three-way-merges and archives automatically after the last sub-task completes. Conflicts block the auto-archive (recorded as a `plan-archive-blocked` observation on the parent spec task) instead of forcing — the change stays open so the merge can be resolved by hand. Leave `auto_archive` off until you trust the lane to land cleanly; opt in per plan.

Returns `{ plan_slug, spec_task_id, spec_change_path, subtasks: [{ subtask_index, branch, task_id, title }] }`. Errors: `PLAN_INVALID_DEPENDENCY`, `PLAN_SCOPE_OVERLAP`.

## `task_plan_list`

List published plans with a sub-task rollup.

```json
{
  "name": "task_plan_list",
  "input": {
    "repo_root": "/abs/repo",
    "only_with_available_subtasks": true,
    "capability_match": "ui_work",
    "limit": 25
  }
}
```

Returns `[{ plan_slug, repo_root, spec_task_id, title, created_at, subtask_counts: { available, claimed, completed, blocked }, subtasks: [...], next_available: [...] }]`. `next_available` is the list of sub-tasks whose status is `available` **and** whose `depends_on` chain is fully `completed`. `capability_match` filters plans where at least one sub-task in `next_available` has the matching `capability_hint`.

## `task_plan_claim_subtask`

Claim an available sub-task. The handler runs scan-before-stamp inside a SQLite transaction so two concurrent claims serialize through the write lock; the first commit wins, the second sees the prior claim observation and rejects.

```json
{
  "name": "task_plan_claim_subtask",
  "input": {
    "plan_slug": "add-widget-page",
    "subtask_index": 0,
    "session_id": "sess_def",
    "agent": "codex"
  }
}
```

On success: joins the caller to the sub-task thread and activates file claims for every entry in the sub-task `file_scope`. Returns `{ task_id, branch, file_scope }`. Errors: `PLAN_SUBTASK_NOT_FOUND`, `PLAN_SUBTASK_DEPS_UNMET`, `PLAN_SUBTASK_NOT_AVAILABLE`.

## `task_plan_complete_subtask`

Mark your claimed sub-task complete. Releases the sub-task file claims and stamps a `plan-subtask-claim` observation with `status: 'completed'`. Downstream sub-tasks (those whose `depends_on` includes this one) become available automatically — `task_plan_list` will surface them in `next_available` on the next read.

```json
{
  "name": "task_plan_complete_subtask",
  "input": {
    "plan_slug": "add-widget-page",
    "subtask_index": 0,
    "session_id": "sess_def",
    "summary": "Widget API landed: GET /api/widgets serving rows."
  }
}
```

Returns `{ status: 'completed', auto_archive: { status, reason?, archived_path?, merged_root_hash?, applied?, conflicts? } }`. The `auto_archive` field is always present and reports what happened on this completion:

- `status: 'skipped'` — auto-archive disabled, sub-tasks still outstanding, or no parent linkage. `reason` carries the specific cause.
- `status: 'archived'` — the merge was clean and the change is now under `openspec/archive/<date>-<slug>/`. `archived_path` and `merged_root_hash` describe the result.
- `status: 'blocked'` — auto-archive opted in and the plan is fully completed, but the three-way merge has conflicts. The change stays open; resolve by hand and call `spec_archive` directly.
- `status: 'error'` — auto-archive opted in but the archive flow threw (for example a missing `CHANGE.md`). The completion still succeeded; the failure is recorded as a `plan-archive-error` observation on the parent spec task.

Errors on `task_plan_complete_subtask` itself: `PLAN_SUBTASK_NOT_FOUND`, `PLAN_SUBTASK_NOT_CLAIMED`, `PLAN_SUBTASK_NOT_YOURS`.

## Plan observation kinds

The lane introduces several observation kinds on the parent spec task and on the sub-task threads. They are written through `MemoryStore.addObservation`, so content is compressed and `metadata` carries the structured payload.

- `plan-subtask` — the initial advertisement, one per sub-task at publish time. `metadata` carries `parent_plan_slug`, `parent_plan_title`, `parent_spec_task_id`, `subtask_index`, `file_scope`, `depends_on`, `capability_hint`, and an initial `status: 'available'`.
- `plan-subtask-claim` — every lifecycle transition (claim, complete). `metadata.status` is the new state; `metadata.session_id` and `metadata.agent` identify the actor. The latest `plan-subtask-claim` observation by timestamp is authoritative.
- `plan-config` — written on the parent spec task at publish time. Carries plan-level lifecycle policy. Today: `metadata.auto_archive`.
- `plan-archived` — written on the parent spec task when auto-archive succeeds. Carries `archived_path`, `merged_root_hash`, `applied`.
- `plan-archive-blocked` — written when auto-archive is ready but the three-way merge has conflicts. Carries `conflicts` (the conflict set) and `applied` (the deltas that did merge cleanly).
- `plan-archive-error` — written when auto-archive throws. Carries the error message in `metadata.error`. The sub-task completion still succeeded; auto-archive errors never tear down completion.

## Contract stability

Fields may be added. Existing fields will not be removed or renamed within a minor version.
