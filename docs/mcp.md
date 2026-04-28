# MCP tools

colony exposes MCP tools over a stdio server. IDE installers register that server as `colony`, so agent tool calls appear under the `colony` namespace. The design goal is **progressive disclosure**: hits are compact until the agent asks for more.

For memory lookup, the recommended workflow is **search first, hydrate later**:

1. Before implementation, call `search` with query-rich terms from the task: feature name, package name, file path, task slug, or exact error message.
2. Review the compact IDs and snippets. Do not fetch full bodies for every hit.
3. Call `get_observations` only with the filtered IDs you actually need.

Use `list_sessions` -> `timeline` when you need to navigate a known session instead of searching memory globally.

## Agent startup loop

Agent startup, resume, "what needs me?", and "what should I do next?" flows should call these first:

1. `hivemind_context` to see active agents, owned branches, live lanes, compact memory hits, and relevant negative warnings.
2. `attention_inbox` to see what needs your attention: handoffs, messages, wakes, stalled lanes, recent claim activity, and decaying hot files.
3. `task_ready_for_agent` to choose available work matched to the current agent.

Codex-style MCP tool names include the server prefix:
`mcp__colony__hivemind_context`,
`mcp__colony__attention_inbox`, and
`mcp__colony__task_ready_for_agent`.

Use `task_list` for browsing/debugging recent task threads. Use `task_ready_for_agent` for choosing what to work on next.

Copy-paste startup:

```json
{ "name": "hivemind_context", "input": { "repo_root": "/abs/repo", "query": "current task or branch", "memory_limit": 3, "limit": 20 } }
```

```json
{ "name": "attention_inbox", "input": { "session_id": "sess_abc", "agent": "codex", "repo_root": "/abs/repo" } }
```

```json
{ "name": "task_ready_for_agent", "input": { "session_id": "sess_abc", "agent": "codex", "repo_root": "/abs/repo", "limit": 5 } }
```

When the selected task needs implementation context, call `search` with the task title, files, or error phrase, then hydrate only the needed IDs with `get_observations`. Claim files with `task_claim_file` or `task_plan_claim_subtask` before editing.

For multi-agent runtime awareness, call `hivemind_context` first when you need ownership plus likely memory hits, or `hivemind` when you only need the runtime map. Both return compact active worktrees, branches, agents, and task previews from `.omx` proxy-runtime state without fetching observation bodies.

After `hivemind_context`, call `attention_inbox` to check what needs you now: live pending handoffs, unread messages, blockers, stalled lanes, recent claims, and decaying hot files. Review its compact IDs first; fetch full bodies with `get_observations` only after you pick the IDs worth reading.

For choosing work to claim, the compact path is:

`hivemind_context -> attention_inbox -> task_ready_for_agent -> task_plan_claim_subtask`

Following the progressive-disclosure pattern saves ~10× tokens versus fetching full bodies upfront.

The OMX-Colony bridge contract lives in `openspec/specs/omx-colony-bridge/spec.md`:
OMX runs agents, Colony coordinates agents, OMX displays Colony state, and
Colony consumes OMX telemetry. Use Colony first for coordination; use OMX state
or notepad only when Colony is unavailable or missing the required surface.

## `search`

Find observations matching a natural-language query.

```json
{
  "name": "search",
  "input": { "query": "auth middleware", "limit": 10 }
}
```

Good planning queries include:

- Feature name: `queen plan publication`
- Package name: `@colony/mcp-server`
- File path: `apps/mcp-server/src/tools/search.ts`
- Task slug: `agent-agent5-mcp-search-first-docs`
- Error message: `cannot open '.git/FETCH_HEAD': Read-only file system`

Then hydrate only selected hits:

```json
{
  "name": "search",
  "input": {
    "query": "@colony/mcp-server apps/mcp-server/src/tools/search.ts search description",
    "limit": 5
  }
}
```

```json
{
  "name": "get_observations",
  "input": { "ids": [6337, 8946], "expand": true }
}
```

Returns: `[ { id, session_id, snippet, score, ts } ]` - compact hits only, never full observation bodies. Use `get_observations` for the few IDs worth reading.

Search hits include `kind` and `task_id` so agents can recognize advisory negative warnings such as `failed_approach` before hydrating the full body.

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

Return live lane ownership plus compact relevant memory hits and negative warnings in one request.
Before editing, inspect ownership, then claim touched files on the active task.

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
    "negative_warning_count": 1,
    "needs_attention_count": 0,
    "next_action": "Call attention_inbox, then task_ready_for_agent before choosing work.",
    "suggested_tools": ["attention_inbox", "task_ready_for_agent"],
    "attention_hint": "Call attention_inbox to review pending handoffs, unread messages, blockers, and stalled lanes before claiming work.",
    "ready_work_hint": "Then call task_ready_for_agent to choose claimable work. Use task_list only for browsing/debugging.",
    "unread_message_count": 0,
    "pending_handoff_count": 0,
    "blocking": false,
    "ready_work_count": 0
  },
  "attention": {
    "unread_messages": 0,
    "pending_handoffs": 0,
    "blocking": false,
    "observation_ids": [],
    "hydrate_with": "get_observations"
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
    {
      "id": 42,
      "session_id": "sess_abc",
      "kind": "decision",
      "snippet": "compact hit",
      "score": 1.2,
      "ts": 1710000000000,
      "task_id": 17
    }
  ],
  "negative_warnings": [
    {
      "id": 43,
      "session_id": "sess_def",
      "kind": "failed_approach",
      "snippet": "do not repeat manual polling",
      "ts": 1710000001000,
      "task_id": 17
    }
  ]
}
```

Inputs:

- `repo_root`, `repo_roots`, `include_stale`, and `limit`: same as `hivemind`.
- `query`: optional memory query. If omitted, the server derives one from active task text.
- `memory_limit`: compact memory hits to return, capped at 10 and defaulting to 3.

Use this for takeover, review, or resume flows where the agent needs current ownership and a small memory index before deciding which full observations to fetch. The summary intentionally pushes the startup loop toward `attention_inbox`, then `task_ready_for_agent`; `hivemind_context` returns compact IDs and counts, not full observation bodies.

## `bridge_status`

Return compact coordination state for OMX HUD/status displays without fetching full observation bodies.
This composes the same hivemind, attention, and ready-work logic as the richer tools.

```json
{
  "name": "bridge_status",
  "input": {
    "session_id": "sess_abc",
    "agent": "codex",
    "repo_root": "/home/deadpool/Documents/recodee",
    "branch": "agent/codex/live-task",
    "query": "current task"
  }
}
```

Returns:

```json
{
  "schema": "colony.omx_hud_status.v1",
  "generated_at": "2026-04-28T21:30:00.000Z",
  "runtime_source": "omx",
  "hivemind": {
    "lane_count": 1,
    "total_lane_count": 1,
    "lanes_truncated": false,
    "needs_attention_count": 0,
    "counts": {
      "working": 1,
      "thinking": 0,
      "idle": 0,
      "stalled": 0,
      "dead": 0,
      "unknown": 0
    },
    "lane_preview": [
      {
        "branch": "agent/codex/live-task",
        "task": "Ship bridge status",
        "owner": "codex/codex",
        "activity": "working",
        "needs_attention": false,
        "risk": "none",
        "source": "active-session",
        "locked_file_count": 1,
        "locked_file_preview": ["apps/mcp-server/src/tools/bridge.ts"]
      }
    ]
  },
  "branch": "agent/codex/live-task",
  "task": "Ship bridge status",
  "blocker": null,
  "next_action": "Continue agent/codex/live-task.",
  "next": "Continue agent/codex/live-task.",
  "evidence": {
    "task_id": 17,
    "latest_working_note_id": 43,
    "attention_observation_ids": [],
    "attention_observation_ids_truncated": false,
    "hydrate_with": "get_observations"
  },
  "attention": {
    "unread_count": 0,
    "blocking_count": 0,
    "blocking": false,
    "pending_handoff_count": 0,
    "pending_wake_count": 0,
    "stalled_lane_count": 0
  },
  "attention_counts": {
    "lane_needs_attention_count": 0,
    "pending_handoff_count": 0,
    "pending_wake_count": 0,
    "unread_message_count": 0,
    "stalled_lane_count": 0,
    "recent_other_claim_count": 0,
    "blocked": false
  },
  "ready_work_count": 1,
  "ready_work_preview": [
    {
      "title": "Implement bridge status tool",
      "plan_slug": "bridge-ready-plan",
      "subtask_index": 0,
      "reason": "ready_high_score",
      "fit_score": 0.8,
      "capability_hint": "api_work",
      "file_count": 2,
      "file_scope_preview": ["apps/mcp-server/src/tools/bridge.ts"]
    }
  ],
  "claimed_file_count": 1,
  "claimed_file_preview": [
    {
      "task_id": 17,
      "file_path": "apps/mcp-server/src/tools/bridge.ts",
      "by_session_id": "sess_abc",
      "claimed_at": 1710000000000,
      "yours": true
    }
  ],
  "claimed_files": [
    {
      "task_id": 17,
      "file_path": "apps/mcp-server/src/tools/bridge.ts",
      "by_session_id": "sess_abc",
      "claimed_at": 1710000000000,
      "yours": true
    }
  ],
  "latest_working_note": {
    "id": 43,
    "task_id": 17,
    "session_id": "sess_abc",
    "ts": 1710000001000,
    "content": "branch=agent/codex/live-task; task=bridge status; blocker=none; next=run tests; evidence=bridge_status"
  }
}
```

Inputs:

- `session_id`, `agent`, and `repo_root`: required identity and workspace scope.
- `branch`: optional current branch hint used to pick the active lane.
- `query`: optional compact context query. No memory hits or full observation bodies are returned.

The payload is intentionally HUD-sized. `hivemind.lane_preview`,
`ready_work_preview`, and `claimed_file_preview` are capped previews. `next` is
a legacy alias for `next_action`. Hydrate `evidence.attention_observation_ids`
with `get_observations` only after the user expands the card or needs the full
body. Use `hivemind_context`, `attention_inbox`, or `task_ready_for_agent`
directly when the agent needs progressive-disclosure IDs or richer details.

### Normal edit workflow

Call `hivemind_context` before editing:

```json
{
  "name": "hivemind_context",
  "input": {
    "repo_root": "/home/deadpool/Documents/recodee",
    "query": "files I expect to touch",
    "memory_limit": 3,
    "limit": 20
  }
}
```

Inspect active lanes for branches, owners, and file ownership:

```json
{
  "lanes": [
    {
      "branch": "agent/codex/live-task",
      "owner": "codex/codex",
      "locked_file_preview": ["apps/mcp-server/src/tools/task.ts"]
    }
  ]
}
```

Call `task_claim_file` once for each file you expect to edit:

```json
{
  "name": "task_claim_file",
  "input": {
    "task_id": 17,
    "session_id": "sess_abc",
    "file_path": "apps/mcp-server/src/tools/task.ts",
    "note": "updating claim-before-edit wording"
  }
}
```

```json
{
  "name": "task_claim_file",
  "input": {
    "task_id": 17,
    "session_id": "sess_abc",
    "file_path": "docs/mcp.md",
    "note": "documenting normal edit workflow"
  }
}
```

Then edit. Claims are warnings, not locks. They never block writes. They make overlap visible so agents can coordinate before a collision.

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

Returns compact hits: `[ { id, session_id, kind, snippet, score, ts, task_id } ]`. Follow with `get_observations(ids[])` for full bodies. Vector re-rank is intentionally skipped when a filter is present — the embedding index has no kind column.

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

Browse task threads; use `task_ready_for_agent` when choosing work to claim. Each task groups sessions collaborating on the same `(repo_root, branch)`.

Use `task_list` when you need to inspect existing task threads by repo or branch for browsing/debugging. Do not use it as the main work picker; call `task_ready_for_agent` when the question is "what should I work on next?"

```json
{ "name": "task_list", "input": { "limit": 50, "session_id": "sess_abc" } }
```

Returns: `{ tasks, hint }`. The default hint is `Use task_ready_for_agent to choose claimable work; task_list is for browsing/debugging.` Repeated `task_list` calls without `task_ready_for_agent` return the stronger inventory warning.

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

Post shared notes, decisions, blockers, questions, and answers on a task thread. Use `task_message` for directed agent-to-agent coordination. Use the dedicated tools (`task_claim_file`, `task_hand_off`, `task_accept_handoff`) for structured actions; `task_post` is for free-form shared thread state tagged with a `kind`.

Use `kind: "note"` when an agent needs to write working note, save current state, remember progress, or log what I am doing. The note lands on both the task thread and the posting session's memory through `MemoryStore`, so it stays compressed, timeline-visible, and searchable later.

Use `failed_approach`, `blocked_path`, `conflict_warning`, or `reverted_solution` when another agent should not repeat a concrete bad path. Keep these warnings explicit and evidence-based: failed paths, blocked approaches, reverted solutions, flaky routes, or do-not-touch notes. They show up compactly in `search`, `hivemind_context`, and `task_ready_for_agent`, but they do not lower ready-work ranking.

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

`kind` ∈ `question | answer | decision | blocker | note | failed_approach | blocked_path | conflict_warning | reverted_solution`. Returns `{ id }`, plus `{ hint: "For directed coordination, use task_message." }` when the content looks like a directed request to another agent.

## `task_note_working`

Save current working state to the active Colony task without manually resolving `task_id`. This is the Colony-native replacement for ad hoc working notepad writes: the note is still task/session scoped and persists through `MemoryStore`.

```json
{
  "name": "task_note_working",
  "input": {
    "session_id": "sess_abc",
    "repo_root": "/abs/repo",
    "branch": "agent/codex/current-work",
    "content": "branch=...; task=...; blocker=none; next=run tests; evidence=..."
  }
}
```

`repo_root` and `branch` are optional filters. The tool scans active task participation for the session, posts `kind:"note"` when exactly one task matches, and returns `{ observation_id, id, task_id }`. If multiple tasks match, it returns `AMBIGUOUS_ACTIVE_TASK` plus compact candidates (`task_id`, `repo_root`, `branch`, `status`, `updated_at`, `agent`) instead of guessing. If none match, it returns `ACTIVE_TASK_NOT_FOUND`.

## `task_post` lifecycle

- Working-state shortcut: write working note, save current state, remember progress, or log what I am doing by posting kind:'note'.
- Routing note: use task_message for directed agent-to-agent coordination; keep task_post for shared kind:'note'|'blocker'|'question'|'answer'|'decision' thread state.
- Use specific tools for claim / hand_off / accept.
- Fallback when task_relay is unavailable in your client tool surface: post a note or blocker containing reason, one_line, base_branch, fetch_files_at if known, touched files, and whether the named source branch/worktree is missing.
- After that, use task_hand_off when another agent must resume the work.

## `task_claim_file`

Claim a file before editing so other agents see ownership and overlap warnings. Use this to avoid conflict and make file ownership visible before touching shared files.

Claims are warnings, not locks. They never block writes. They arm the conflict preface for the next turn.

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

`to_agent` ∈ `claude | codex | any`. Use `any` to broadcast; the router surfaces capability-ranked candidates in the recipient's SessionStart preface. Returns `{ handoff_observation_id, status: 'pending' }`. The handoff is visible to the target at their next SessionStart with inlined `accept with:` / `decline with:` tool-call snippets. Handoffs expire after 120 minutes by default; use `expires_in_minutes` to shorten or extend the live recruitment window up to the tool limit. Expired handoffs stay in the audit trail but drop out of pending inbox/observe surfaces.

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

Decline a pending handoff. Records a reason so the sender can reissue, possibly targeting a different agent. Declining an expired handoff returns stable code `HANDOFF_EXPIRED` and marks the handoff expired instead of cancelling it.

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

## `task_message`

Send a message to another agent. Use for directed coordination that **doesn't** transfer file claims — for "hand off the work + files", use `task_hand_off`. Use `task_post` for generic thread notes, blockers, questions, answers, and decisions. A message is a `task_post` with kind `message`, explicit addressing, and a read/reply/expire/retract/claim lifecycle.

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

`to_agent` ∈ `claude | codex | any`. `urgency` ∈ `fyi | needs_reply | blocking`. Returns `{ message_observation_id, status: 'unread' }`.

## `task_message` lifecycle

- Minimum call: task_message(task_id, session_id, agent, content); it broadcasts to_agent='any' with urgency='fyi'. Use to_agent / to_session_id for direct coordination that doesn't transfer file claims; for 'hand off the work + files', use task_hand_off instead.
- Urgency controls preface prominence: fyi (coalesced into a counter), needs_reply (rendered as a summary + expected action), blocking (top-of-preface, never coalesced).
- Pass reply_to to chain onto an earlier message; the parent's immediate status flips to "replied". Reply chains are 1-deep authoritative: replies-to-replies are allowed but only the immediate parent flips, never a transitively-referenced ancestor.
- expires_in_minutes is an optional TTL. Past-TTL unread messages drop out of default inbox/attention queries and any later mark_read returns stable MESSAGE_EXPIRED; their bodies stay in storage for audit and FTS.
- Replying to a still-unclaimed broadcast (to_agent=any) auto-claims it for you, hiding the broadcast from other recipients.
- Retract sent message. Recipients stop seeing it in inboxes; only the original sender can retract before it is answered, and audit storage keeps body text searchable for FTS and reply-chain history.

Directed-message workflow: `task_message` -> `attention_inbox` / `task_messages` -> `get_observations` -> `task_message_mark_read` -> reply.

1. Sender calls `task_message` with `to_agent`, optional `to_session_id`, `urgency`, and optional `reply_to`.
2. Recipient sees unread, `needs_reply`, and `blocking` items first in `attention_inbox`; use `task_messages` when you need the message-only list.
3. Recipient hydrates message bodies with `get_observations(ids[])`; `task_messages` stays compact and does not return full bodies.
4. Recipient calls `task_message_mark_read` after reading when no reply is needed.
5. Recipient replies with `task_message(..., reply_to=<message id>, ...)`; replying to an unclaimed broadcast auto-claims it. Use `task_message_claim` only when taking a broadcast before you are ready to reply.

## `task_messages`

Read unread messages. Lists messages addressed to you across tasks you participate in (or scoped with `task_ids`). Compact shape — fetch full bodies via `get_observations`. Does **not** mark as read; call `task_message_mark_read` explicitly so an agent can peek at its inbox during planning without burning the "you have new mail" signal. Retracted messages and broadcasts already claimed by other agents are filtered out of every recipient's view.

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

Returns `[ { id, task_id, ts, from_session_id, from_agent, to_agent, to_session_id, urgency, status, reply_to, preview, expires_at, is_claimable_broadcast, claimed_by_session_id, claimed_by_agent } ]`, newest-first. `unread_only: true` is the default-inbox shape used by `attention_inbox`: expired unread rows are hidden there. With `unread_only: false`, `status` reflects the effective audit state: an `unread` row past its TTL surfaces as `expired` even if the on-disk status hasn't been rewritten yet.

## `task_message_mark_read`

Mark message read. Idempotent — re-marking a read or replied message is a no-op. Writes a sibling `message_read` observation so the original sender sees a read receipt in their `attention_inbox`. Returns the resulting `status`.

```json
{
  "name": "task_message_mark_read",
  "input": { "message_observation_id": 512, "session_id": "sess_xyz" }
}
```

Errors include `{ code, error }` with stable codes: `NOT_MESSAGE`, `TASK_MISMATCH`, `OBSERVATION_NOT_ON_TASK`, `NOT_PARTICIPANT`, `NOT_TARGET_SESSION`, `NOT_TARGET_AGENT`, `MESSAGE_EXPIRED` (TTL elapsed before read; status flips to `expired` on the first call and later calls keep returning `MESSAGE_EXPIRED`), or `ALREADY_RETRACTED` (sender retracted the message).

## `task_message_retract`

Retract sent message. Sets the status to `retracted` and the body stops surfacing in any recipient's inbox; the body stays in storage (still searchable via FTS, still in the timeline) for audit. Cannot retract a message that has already been replied to — at that point the recipient has invested response work and silently rewriting the sender's intent would be deceptive.

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

Claim broadcast. Once claimed, the `to_agent='any'` broadcast drops out of every other recipient's inbox; only the claimer keeps seeing it. Use when you want to silently take ownership of a broadcast before responding — replying via `task_message` already auto-claims, so this tool is for the "I'll handle it but not yet ready to reply" case.

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

Compact post-`hivemind_context` attention check for live pending handoffs, unread messages, blockers, stalled lanes, pending wakes, recent other-session file claims, and decaying hot files. Expired handoffs are hidden from the pending bucket; the original observations remain available via timeline/search for audit. This is the main surface where `task_message` items show up: expired unread messages are hidden, read/replied messages stop triggering attention, and blocking messages remain prominent until read, replied, retracted, or expired. Use `task_messages` for a focused message-only inbox. Review compact IDs first, then fetch full bodies via `get_observations` only for the entries you need.

```json
{
  "name": "attention_inbox",
  "input": {
    "session_id": "sess_abc",
    "agent": "claude",
    "repo_roots": ["/abs/repo-a", "/abs/repo-b"],
    "recent_claim_window_minutes": 30,
    "recent_claim_limit": 20,
    "file_heat_half_life_minutes": 30,
    "file_heat_limit": 10
  }
}
```

Example workflow:

1. Call `hivemind_context` for active lanes plus compact memory hits.
2. Call `attention_inbox` with your `session_id`, `agent`, and repo scope.
3. Review compact item IDs for handoffs, unread messages, blockers, stalled lanes, claims, and hot files.
4. Call `get_observations` only for the selected IDs that need full bodies.

Either `repo_root` or `repo_roots` scopes the inbox. `task_ids` can narrow further. `file_heat` is computed at read time from observations and active claims with `fileHeatHalfLifeMinutes` decay, so stale activity fades without a cleanup job. Returns a structured payload with attention buckets; each entry carries the IDs to hydrate on demand.

Unread `task_message` entries include compact action hints so recipients do not need to remember the lifecycle tools:

```json
{
  "id": 401,
  "task_id": 17,
  "urgency": "needs_reply",
  "reply_with_tool": "task_message",
  "reply_with_args": {
    "task_id": 17,
    "session_id": "sess_abc",
    "agent": "claude",
    "to_agent": "any",
    "to_session_id": "sess_xyz",
    "reply_to": 401,
    "urgency": "fyi",
    "content": "..."
  },
  "mark_read_with_tool": "task_message_mark_read",
  "mark_read_with_args": {
    "message_observation_id": 401,
    "session_id": "sess_abc"
  },
  "next_action": "Reply with task_message using reply_to, or mark read after reading if no reply is needed."
}
```

`next_action` is present on `blocking` and `needs_reply` message entries; FYI messages still include the reply and mark-read tool hints.

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

Reinforce a pending proposal. `kind='explicit'` means direct support; `'rediscovered'` means you arrived at the same idea independently and weighs more than explicit support; `'adjacent'` is weak evidence from editing a touched file. Scoring is deterministic and source-diverse: repeated same-session reinforcement is collapsed, different sessions from the same agent type add moderate strength, and a different agent type/session adds stronger evidence. Existing rows keep their stored base weight, and session agent type is read from existing session metadata/IDE fields with conservative fallbacks.

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

Returns `{ pending: [ { id, strength, summary, ... } ], promoted: [ { id, task_id, summary, ... } ] }`. Pending `reinforcement_count` counts unique reinforcing sessions, not duplicate rows.

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
- `depends_on` indices are zero-based and must point to **earlier** indices; cycles are rejected with `PLAN_INVALID_WAVE_DEPENDENCY`.
- Parallel sub-tasks in the same ordered wave cannot share `file_scope` entries; this is rejected with `PLAN_WAVE_SCOPE_OVERLAP`.
- Finalizer tasks such as verification, release, targeted test, or final doc updates must run in the last wave and depend on all earlier non-finalizer work; violations return `PLAN_FINALIZER_NOT_LAST`.
- Independent sub-tasks (no `depends_on` chain between them) still cannot share `file_scope` entries. To overlap files, sequence the work via `depends_on`.

Optional inputs:

- `auto_archive` (default `false`): when `true`, the parent spec change three-way-merges and archives automatically after the last sub-task completes. Conflicts block the auto-archive (recorded as a `plan-archive-blocked` observation on the parent spec task) instead of forcing — the change stays open so the merge can be resolved by hand. Leave `auto_archive` off until you trust the lane to land cleanly; opt in per plan.

Returns `{ plan_slug, spec_task_id, spec_change_path, subtasks: [{ subtask_index, branch, task_id, title }] }`. Errors: `PLAN_INVALID_WAVE_DEPENDENCY`, `PLAN_WAVE_SCOPE_OVERLAP`, `PLAN_FINALIZER_NOT_LAST`, `PLAN_SCOPE_OVERLAP`.

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

## `task_ready_for_agent`

Find the next task to claim for this agent. Use this when deciding what to work on.

```json
{
  "name": "task_ready_for_agent",
  "input": {
    "session_id": "sess_def",
    "agent": "codex",
    "repo_root": "/abs/repo",
    "limit": 5
  }
}
```

Returns `{ ready, total_available }`. Each `ready` entry includes `plan_slug`, `subtask_index`, `title`, `capability_hint`, `file_scope`, `fit_score`, compact `reason`, and `reasoning`. `reason` is one of `continue_current_task`, `urgent_override`, or `ready_high_score`. Blocked work is filtered out, and conflicting active file claims lower the score. Claim new selected work with `task_plan_claim_subtask`; if the top reason is `continue_current_task`, keep working the already-claimed sub-task.

## `rescue_stranded_scan`

Find stranded sessions or abandoned file claims without changing state.

```json
{
  "name": "rescue_stranded_scan",
  "input": { "stranded_after_minutes": 10 }
}
```

Returns `{ dry_run: true, stranded, rescued }`. `rescued` is ordered by blocking urgency, stale age, downstream blocked count, then pending message state. Plan sub-task entries may include `plan_slug`, `wave_index`, `blocked_downstream_count`, `blocking_urgency`, `stale_age_minutes`, `message_attention_state`, and `suggested_action`. `blocked_downstream_count` ignores downstream sub-tasks that are already `completed`.

`rescue_stranded_scan` is read-only at the MCP boundary: it rolls back the core dry-run transaction, so it does not emit relays, observer notes, or release claims.

## `rescue_stranded_run`

Rescue stranded sessions after explicit confirmation. This mutates state by emitting rescue relays and releasing the stranded session's claims; it does not auto-reassign to a specific agent.

```json
{
  "name": "rescue_stranded_run",
  "input": {
    "stranded_after_minutes": 10,
    "confirm": true
  }
}
```

Without `confirm: true`, returns `RESCUE_CONFIRM_REQUIRED`.

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
