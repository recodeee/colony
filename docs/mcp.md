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
2. `attention_inbox` to see what needs your attention: handoffs, messages, wakes, stalled lanes, fresh claims, stale-claim cleanup signals, and decaying hot files.
3. `task_ready_for_agent` to choose available work matched to the current agent.

Do not choose work before attention_inbox.

Codex-style MCP tool names include the server prefix:
`mcp__colony__hivemind_context`,
`mcp__colony__attention_inbox`, and
`mcp__colony__task_ready_for_agent`.

Use `task_list` for browsing/debugging recent task threads. Use `task_ready_for_agent` for choosing what to work on next.

## Ruflo sidecar boundary

Ruflo integration should stay at the sidecar boundary. Do not vendor Ruflo, copy
its swarm runtime, or import its browser/security tool trees into Colony. If
Ruflo runs beside Colony, expose it through a separate MCP/runtime and let Colony
observe compact events through a bridge.

The intended flow is
`Ruflo tools/events -> Colony bridge -> compact observations -> suggestions/health/debrief`.
Map those events into Colony records such as observations, task threads,
handoffs, claims, active-session state, learned patterns, and token receipts. See
[Ruflo sidecar architecture](./ruflo-sidecar.md).

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

After every `hivemind_context`, call `attention_inbox` before choosing work. `hivemind_context.summary.next_action` is intentionally explicit: `Do not choose work yet. Call attention_inbox, then task_ready_for_agent.` `attention_inbox` checks what needs you now: live pending handoffs, unread messages, blockers, stalled lanes, fresh claims, stale-claim cleanup signals, and decaying hot files. Review its compact IDs first; fetch full bodies with `get_observations` only after you pick the IDs worth reading.

Do not choose work before attention_inbox.

For choosing work to claim, the compact path is:

`hivemind_context -> attention_inbox -> task_ready_for_agent -> task_plan_claim_subtask`

Following the progressive-disclosure pattern saves ~10× tokens versus fetching full bodies upfront.

## Progressive disclosure budget contract

Invariant: compact MCP tools do not return full observation bodies by default. Default responses may include counts, IDs, snippets, previews, branch/task/file metadata, action hints, and suggested MCP calls. Full observation `content` and `metadata` belong behind `get_observations(ids[])`, after the caller has selected the compact IDs worth hydrating.

The expected compact startup and work-selection flow is:

`hivemind_context -> attention_inbox -> task_ready_for_agent -> get_observations only after compact IDs are selected`

Use `hivemind_context` for ownership, compact memory hits, negative warnings, and the attention summary. Use `attention_inbox` for compact attention buckets and message/action hints. Use `task_ready_for_agent` for the claimable-work picker and exact claim calls. Use `get_observations` only after a compact tool returned IDs that the caller deliberately selected.

Current payloads already expose this contract through fields such as `summary`, `observation_ids`, `observation_ids_truncated`, `hydrate_with`, `next_action`, compact message `preview`, and tool-specific action hints. A uniform `budget` object is planned/optional and is not required in current MCP payloads yet. When implemented, `budget` should be advisory and compact:

- `items_available`: total items matching the request before compaction.
- `items_returned`: items included in the current response.
- `collapsed_count`: items intentionally omitted from the compact response.
- `estimated_tokens_returned`: rough token estimate for the compact payload.
- `hydrate_with`: next tool to use for expansion, usually `get_observations`; it may name another compact tool such as `attention_inbox` when that is the next disclosure step.
- `why_collapsed`: short reason the response stayed compact.

Example noisy inbox payload. The `budget` object is planned/optional; the compact IDs, previews, and action hints match the current behavior:

```json
{
  "summary": {
    "unread_message_count": 12,
    "pending_handoff_count": 1,
    "stalled_lane_count": 2,
    "blocked": true,
    "next_action": "Reply to blocking messages before choosing work."
  },
  "unread_messages": [
    {
      "id": 401,
      "task_id": 17,
      "urgency": "blocking",
      "preview": "Need PR merge evidence before cleanup.",
      "reply_tool": "task_message",
      "suggested_reply_args": {
        "task_id": 17,
        "reply_to": 401,
        "urgency": "fyi",
        "content": "..."
      },
      "mark_read_tool": "task_message_mark_read"
    }
  ],
  "pending_handoffs": [
    {
      "id": 402,
      "task_id": 17,
      "summary": "Take over cleanup evidence",
      "next": "Accept or decline the handoff."
    }
  ],
  "budget": {
    "items_available": 26,
    "items_returned": 5,
    "collapsed_count": 21,
    "estimated_tokens_returned": 950,
    "hydrate_with": "get_observations",
    "why_collapsed": "Noisy inbox: returned top blocking/needs_reply items, compact counts, and action hints only."
  }
}
```

Example stalled-lane payload. Stalled lanes stay compact: owner, branch, task, activity, and worktree path are enough to decide whether to rescue, inspect, or ignore. If there is no observation ID, expand with the lane's task timeline or a targeted search rather than fetching unrelated bodies:

```json
{
  "summary": {
    "stalled_lane_count": 1,
    "next_action": "Review stalled lanes before treating the repo as idle."
  },
  "stalled_lanes": [
    {
      "repo_root": "/abs/repo",
      "branch": "agent/codex/docs-budget-contract",
      "task": "Tool: colony.examples_query",
      "owner": "agent/unknown",
      "activity": "dead",
      "activity_summary": "Heartbeat stale for 7m 28s.",
      "worktree_path": "/abs/repo/.omx/agent-worktrees/repo__codex__docs-budget-contract"
    }
  ],
  "budget": {
    "items_available": 9,
    "items_returned": 1,
    "collapsed_count": 8,
    "estimated_tokens_returned": 420,
    "hydrate_with": "attention_inbox",
    "why_collapsed": "Only the top stalled lane is needed for the immediate startup decision."
  }
}
```

Example suggestion payload. `task_suggest_approach` and the SessionStart suggestion preface return derived guidance and task IDs, not full historical observation bodies:

```json
{
  "similar_tasks": [
    {
      "task_id": 31,
      "similarity": 0.91,
      "branch": "agent/codex/attention-budget",
      "repo_root": "/abs/repo",
      "status": "completed",
      "observation_count": 42
    }
  ],
  "first_files_likely_claimed": [
    {
      "file_path": "apps/mcp-server/src/tools/attention.ts",
      "appears_in_count": 4,
      "confidence": 0.64
    }
  ],
  "patterns_to_watch": [
    {
      "description": "Expired handoff caused stale ownership",
      "seen_in_task_id": 31,
      "kind": "expired-handoff"
    }
  ],
  "resolution_hints": {
    "median_elapsed_minutes": 38,
    "median_handoff_count": 1,
    "median_subtask_count": 2,
    "completed_sample_size": 5
  },
  "insufficient_data_reason": null,
  "budget": {
    "items_available": 12,
    "items_returned": 3,
    "collapsed_count": 9,
    "estimated_tokens_returned": 700,
    "hydrate_with": "task_suggest_approach",
    "why_collapsed": "Startup suggestion shows only top files and first pattern; run task_suggest_approach for the full derived guidance."
  }
}
```

The OMX-Colony bridge contract lives in `openspec/specs/omx-colony-bridge/spec.md`:
OMX runs agents, Colony coordinates agents, OMX displays Colony state, and
Colony consumes OMX telemetry. Use Colony first for coordination; use OMX state
or notepad only when Colony is unavailable or missing the required surface.
For current working state, call `task_note_working` before any OMX notepad
write. A successful Colony working note must not duplicate the full content into
`.omx/notepad.md`; only `bridge.writeOmxNotepadPointer=true` may append the tiny
pointer fields `branch`, `task`, `blocker`, `next`, `evidence`, and
`colony_observation_id`. If no active task matches, callers may opt into
`allow_omx_notepad_fallback=true` to write that same tiny pointer.

Working handoff notes use one compact field order:

```text
branch=<branch> | task=<task> | blocker=<blocker> | next=<next> | evidence=<path|command|PR|spec>
```

Use `task_note_working` or the CLI helper when posting progress:

```bash
colony note working --session-id sess_abc --repo-root /abs/repo --next "run focused tests" --evidence "apps/mcp-server/test/task-threads.test.ts"
```

`branch` and `task` are inferred from the active session/task binding when the
binding is unambiguous. `next` and `evidence` are required. Evidence must be a
compact pointer, not pasted logs; long proof text is compacted and returned with
a warning. Each successful auto note marks the prior live auto handoff note as
superseded so resume flows read one current state.

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
    "next_action": "Do not choose work yet. Call attention_inbox, then task_ready_for_agent.",
    "suggested_tools": ["attention_inbox", "task_ready_for_agent"],
    "must_check_attention": true,
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
    "hydration": "Hydrate with attention_inbox; call get_observations with observation_ids only for bodies.",
    "hydrate_with": "attention_inbox"
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

Returns: `{ tasks, hint, coordination_warning, next_tool }`. Before a session calls `task_ready_for_agent`, `coordination_warning` is `task_list is inventory; use task_ready_for_agent to choose work.` and `next_tool` is `task_ready_for_agent`. Repeated `task_list` calls without `task_ready_for_agent` return `Stop browsing. Call task_ready_for_agent before selecting work.` as the stronger warning. After `task_ready_for_agent`, `coordination_warning` is omitted and `task_list` stays a browsing/debugging surface. The legacy `hint` field remains for backward compatibility.

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

Post shared notes, decisions, blockers, questions, and answers on a task thread. Use `task_message` for directed agent-to-agent coordination. Use `task_note_working` as the first write path for current working state and when you do not know `task_id`. Use the dedicated tools (`task_claim_file`, `task_hand_off`, `task_accept_handoff`) for structured actions; `task_post` is for free-form shared thread state tagged with a `kind`.

Use `kind: "note"` when the caller already knows the `task_id` or needs a normal task-thread note. For current working state without a resolved `task_id`, call `task_note_working` first. The note lands on both the task thread and the posting session's memory through `MemoryStore`, so it stays compressed, timeline-visible, and searchable later.

Use `failed_approach`, `blocked_path`, `conflict_warning`, or `reverted_solution` when another agent should not repeat a concrete bad path. Keep these warnings explicit and evidence-based: failed paths, blocked approaches, reverted solutions, flaky routes, or do-not-touch notes. They show up compactly in `search`, `hivemind_context`, and `task_ready_for_agent`, but they do not lower ready-work ranking.

When a `note` or `decision` looks like future work, `task_post` returns a `recommendation` that points to `task_propose`. Use the proposal tool for weak candidates so foraging can reinforce, decay, and promote them instead of leaving them buried in a thread note.

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

`kind` ∈ `question | answer | decision | blocker | note | failed_approach | blocked_path | conflict_warning | reverted_solution`. Returns `{ id, hint }`, plus `recommendation` for future-work notes/decisions. The hint points unknown-`task_id` working-state writes to `task_note_working`, and also says `For directed agent coordination, use task_message.` when a post names an agent and asks for action or reply.

## `task_note_working`

Save current working state to the active Colony task. Use this to write working note, save current state, remember progress, log what I am doing, or as the notepad replacement when you do not know `task_id`. The note is still task/session scoped and persists through `MemoryStore`.

```json
{
  "name": "task_note_working",
  "input": {
    "session_id": "sess_abc",
    "repo_root": "/abs/repo",
    "branch": "agent/codex/current-work",
    "content": "branch=...; task=...; blocker=none; next=run tests; evidence=...",
    "pointer": {
      "branch": "agent/codex/current-work",
      "task": "bridge status",
      "blocker": "none",
      "next": "run tests",
      "evidence": "bridge_status"
    },
    "allow_omx_notepad_fallback": true
  }
}
```

Minimal working note:

```json
{
  "name": "task_note_working",
  "input": {
    "session_id": "sess_abc",
    "content": "branch=agent/codex/current-work; task=finish API slice; blocker=none; next=run typecheck; evidence=tests/api.test.ts"
  }
}
```

Filtered when one session participates in multiple active tasks:

```json
{
  "name": "task_note_working",
  "input": {
    "session_id": "sess_abc",
    "repo_root": "/abs/repo",
    "branch": "agent/codex/current-work",
    "content": "branch=agent/codex/current-work; task=finish API slice; blocker=none; next=push PR; evidence=pnpm test"
  }
}
```

`repo_root` and `branch` are optional filters. The tool scans active task participation for the session, posts `kind:"note"` when exactly one task matches, and returns `{ observation_id, id, task_id }`. If `bridge.writeOmxNotepadPointer=true`, a successful write appends only a tiny pointer to `.omx/notepad.md`: `branch`, `task`, `blocker`, `next`, `evidence`, `colony_observation_id`. The full `content` is never duplicated into OMX notepad after a Colony note succeeds. If multiple tasks match, it returns `AMBIGUOUS_ACTIVE_TASK` plus compact candidates (`task_id`, `repo_root`, `branch`, `status`, `updated_at`, `agent`) instead of guessing. If none match, it returns `ACTIVE_TASK_NOT_FOUND`; with `allow_omx_notepad_fallback:true`, it may write the same tiny pointer to OMX notepad so legacy resume still has a breadcrumb.

`task_note_working` is the first write path for working state. On success it
keeps the full note in Colony and skips `.omx/notepad.md` unless
`bridge.writeOmxNotepadPointer=true`. When the pointer bridge is enabled, OMX
receives only:

```text
branch=<branch>; task=<task>; blocker=<blocker>; next=<next>; evidence=<path|command|PR|spec>; colony_observation_id=<id>
```

When no active Colony task matches, pass `allow_omx_notepad_fallback=true` only
if a transition-era OMX resume pointer is still needed. Ambiguous task
resolution never writes the fallback pointer; choose a task by `repo_root` and
`branch` first.

## `task_post` lifecycle

- Current working state starts with `task_note_working`; use `task_post kind:'note'` when the task id is already known and the note is not the current working-state handoff.
- Routing note: use task_message for directed agent-to-agent coordination; keep task_post for shared kind:'note'|'blocker'|'question'|'answer'|'decision' thread state.
- Use specific tools for claim / hand_off / accept.
- Fallback when task_relay is unavailable in your client tool surface: post a note or blocker containing reason, one_line, base_branch, fetch_files_at if known, touched files, and whether the named source branch/worktree is missing.
- After that, use task_hand_off when another agent must resume the work.

## `task_claim_file`

Claim a file before editing so other agents see ownership and overlap warnings. Use this to avoid conflict and make file ownership visible before touching shared files.

Claims are warnings, not locks. They never block writes. They arm the conflict preface for the next turn.

Existing claims are age-classified before they are treated as ownership. Fresh claims can produce active overlap warnings; stale or expired/weak claims remain in audit history and may be returned as `weak_stale` details, but they are not active ownership and are not inherited by `task_relay`.

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

Read unread messages. Lists messages addressed to you across tasks you participate in (or scoped with `task_ids`). Compact shape includes `reply_tool`, `suggested_reply_args`, and `mark_read_tool` action hints; fetch full bodies via `get_observations`. Does **not** mark as read; call `task_message_mark_read` explicitly so an agent can peek at its inbox during planning without burning the "you have new mail" signal. Retracted messages and broadcasts already claimed by other agents are filtered out of every recipient's view.

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

Returns `[ { id, task_id, ts, from_session_id, from_agent, to_agent, to_session_id, urgency, status, reply_to, preview, expires_at, is_claimable_broadcast, claimed_by_session_id, claimed_by_agent, reply_tool, suggested_reply_args, mark_read_tool } ]`, newest-first. `unread_only: true` is the default-inbox shape used by `attention_inbox`: expired unread rows are hidden there. With `unread_only: false`, `status` reflects the effective audit state: an `unread` row past its TTL surfaces as `expired` even if the on-disk status hasn't been rewritten yet.

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

Compact post-`hivemind_context` attention check for live pending handoffs, unread messages, blockers, stalled lanes, pending wakes, recent other-session file claims, stale claim cleanup signals, and decaying hot files. Expired handoffs are hidden from the pending bucket; the original observations remain available via timeline/search for audit. This is the main surface where `task_message` items show up: expired unread messages are hidden, read/replied messages stop triggering attention, and blocking messages remain prominent until read, replied, retracted, or expired. Use `task_messages` for a focused message-only inbox. Review compact IDs first, then fetch full bodies via `get_observations` only for the entries you need.

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
3. Review compact item IDs for handoffs, unread messages, blockers, stalled lanes, fresh claims, stale-claim summary, and hot files.
4. Call `get_observations` only for the selected IDs that need full bodies.

Either `repo_root` or `repo_roots` scopes the inbox. `task_ids` can narrow further. `recent_other_claims` contains fresh active ownership only. Stale claims are summarized separately in `stale_claim_signals` with `stale_claim_count`, top stale branches, and a sweep suggestion so audit history stays separate from active ownership. `file_heat` is computed at read time from observations and active claims with `fileHeatHalfLifeMinutes` decay, so stale activity fades without a cleanup job. Returns a structured payload with attention buckets; each entry carries the IDs to hydrate on demand.

Unread `task_message` entries include compact action hints so recipients do not need to remember the lifecycle tools:

```json
{
  "id": 401,
  "task_id": 17,
  "urgency": "needs_reply",
  "reply_tool": "task_message",
  "suggested_reply_args": {
    "task_id": 17,
    "session_id": "sess_abc",
    "agent": "claude",
    "to_agent": "any",
    "to_session_id": "sess_xyz",
    "reply_to": 401,
    "urgency": "fyi",
    "content": "..."
  },
  "reply_args": {
    "task_id": 17,
    "session_id": "sess_abc",
    "agent": "claude",
    "to_agent": "any",
    "to_session_id": "sess_xyz",
    "reply_to": 401,
    "urgency": "fyi",
    "content": "..."
  },
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
  "mark_read_tool": "task_message_mark_read",
  "mark_read_args": {
    "message_observation_id": 401,
    "session_id": "sess_abc"
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

Example weak candidate:

```json
{
  "name": "task_propose",
  "input": {
    "repo_root": "/repo",
    "branch": "main",
    "summary": "Show promoted proposals in colony health",
    "rationale": "Agents keep leaving follow-up notes, but health reports show task_propose stayed at 0.",
    "touches_files": ["apps/cli/src/commands/health.ts", "apps/cli/test/health.test.ts"],
    "session_id": "sess_forager"
  }
}
```

## `task_reinforce`

Reinforce a pending proposal. `kind='explicit'` means direct support; `'rediscovered'` means you arrived at the same idea independently and weighs more than explicit support; `'adjacent'` is weak evidence from editing a touched file. Scoring is deterministic and source-diverse: repeated same-session reinforcement is collapsed, different sessions from the same agent type add moderate strength, and a different agent type/session adds stronger evidence. Existing rows keep their stored base weight, and session agent type is read from existing session metadata/IDE fields with conservative fallbacks.

```json
{
  "name": "task_reinforce",
  "input": { "proposal_id": 42, "session_id": "sess_xyz", "kind": "rediscovered" }
}
```

Returns `{ proposal_id, strength, promoted, task_id }`. `promoted` flips `true` when the reinforcement crosses the threshold; `task_id` becomes non-null at the same moment.

Example rediscovered issue:

```json
{
  "name": "task_reinforce",
  "input": { "proposal_id": 42, "session_id": "sess_second_agent", "kind": "rediscovered" }
}
```

## `task_foraging_report`

List pending and recently promoted proposals on a `(repo_root, branch)`. Pending proposals whose strength has evaporated below the noise floor are omitted.

```json
{
  "name": "task_foraging_report",
  "input": { "repo_root": "/abs/repo", "branch": "main" }
}
```

Returns `{ pending: [ { id, strength, summary, ... } ], promoted: [ { id, task_id, summary, ... } ] }`. Pending `reinforcement_count` counts unique reinforcing sessions, not duplicate rows.

Example pending/promoted report:

```json
{
  "name": "task_foraging_report",
  "input": { "repo_root": "/repo", "branch": "main" }
}
```

Use pending rows to decide whether to call `task_reinforce`; use promoted rows to find proposal-backed task threads that are ready to claim.

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
    "limit": 5,
    "auto_claim": true
  }
}
```

Returns `{ ready, total_available, next_action }`. Each `ready` entry includes `priority`, `plan_slug`, `subtask_index`, `wave_index`, `wave_name`, `blocked_by_count`, `title`, `capability_hint`, `file_scope`, `fit_score`, compact `reason`, and `reasoning`. Claimable `ready` entries also include `next_tool: "task_plan_claim_subtask"`, exact copy-paste `claim_args`, `codex_mcp_call`, and `next_action_reason` so agents can claim instead of stopping at discovery. `reason` is one of `continue_current_task`, `urgent_override`, or `ready_high_score`. Blocked work is filtered out, and conflicting active file claims lower the score. When ready work exists, `next_action` points at `task_plan_claim_subtask` with the top ready entry's `plan_slug` and `subtask_index`; if the top reason is `continue_current_task`, keep working the already-claimed sub-task.

`auto_claim` defaults to `true`. When set, the server claims the unambiguous ready sub-task in the same MCP call and reports the outcome in `auto_claimed: { ok, plan_slug, subtask_index, task_id, branch, file_scope }`, plus a `next_action` of `Auto-claimed <slug>/sub-<n>: claim files before edits with task_claim_file, then post task_note_working.` The auto-claim only fires when `next_tool` would be `task_plan_claim_subtask` and `assigned_agent` matches the caller — cross-agent picks and ambiguous routings still defer to an explicit claim call. Pass `auto_claim: false` for browse-only callers that should not change ownership state. Because the loop closes inside one MCP call, the dashboard's `task_ready_for_agent -> task_plan_claim_subtask` conversion metric reads near-zero in normal operation; `colony health` suppresses the false-positive nag when claims are happening via this path (signature: `from_calls > 0`, `to_calls === 0`, `claimed > 0`).

When claimable work exists, the response also includes exact routing fields:

```json
{
  "next_tool": "task_plan_claim_subtask",
  "plan_slug": "example-plan",
  "subtask_index": 0,
  "reason": "ready_high_score",
  "next_action_reason": "Claim example-plan/sub-0: it is unclaimed, dependencies are met, and it is the highest-ranked claimable ready item.",
  "claim_args": {
    "repo_root": "/abs/repo",
    "plan_slug": "example-plan",
    "subtask_index": 0,
    "session_id": "sess_def",
    "agent": "codex",
    "file_scope": ["apps/api/example.ts"]
  },
  "codex_mcp_call": "mcp__colony__task_plan_claim_subtask({ agent: \"codex\", session_id: \"sess_def\", repo_root: \"/abs/repo\", plan_slug: \"example-plan\", subtask_index: 0, file_scope: [\"apps/api/example.ts\"] })"
}
```

When no plan exists, the response includes `empty_state: "No claimable plan subtasks. Publish a Queen/task plan for multi-agent work, reinforce a proposal with task_propose/task_reinforce, or use task_list only for browsing."` and `next_action: "Publish a Queen/task plan or promote a proposal into claimable work."` When a plan exists but later waves are blocked, it keeps the same `empty_state` and points `next_action` at completing dependencies instead of fabricating a claim.

The same picker is available in the CLI:

```bash
colony task ready --session sess_def --agent codex --repo-root /abs/repo
```

Use `--json` for the raw `task_ready_for_agent` payload.

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

## `task_autopilot_tick`

Stateless one-shot advisor that collapses `attention_inbox` + `task_ready_for_agent` into a single decision. Returns the next tool, the args to call it with, and a sleep hint. The loop itself lives in the caller (Claude Code's `ScheduleWakeup`, the `/loop` skill, cron, or any other scheduler) — this MCP call is stateless and never sleeps.

```json
{
  "name": "task_autopilot_tick",
  "input": { "session_id": "sess_abc", "agent": "claude-code", "repo_root": "/abs/repo" }
}
```

Decision priority (first match wins):

1. `accept_handoff` — a pending handoff is addressed to this session/agent. Returns `task_accept_handoff` args with `observation_id`.
2. `accept_quota_relay` — a quota-pending claim is ready for adoption. Returns `task_claim_quota_accept` args lifted from the inbox's `suggested_actions.accept`.
3. `reply_blocking_message` — at least one unread message has `urgency='blocking'`. Returns `task_message_mark_read` args; the caller is expected to read the body before claiming new work.
4. `claim_ready` — `task_ready_for_agent` returned a claimable subtask. Returns `task_plan_claim_subtask` args (or `task_claim_quota_accept` for a quota-relay ready entry).
5. `continue_current` — the caller already holds an open subtask claim. Returns `task_plan_complete_subtask` args; the caller should finish or hand off before switching.
6. `no_op` — no actionable signal. `next_tool` and `next_args` are `null`; `suggested_wake_seconds` is conservative (1200s by default).

Returned shape:

```json
{
  "generated_at": 1700000000000,
  "decision": "claim_ready",
  "reason": "Claim foo/sub-0: it is unclaimed, dependencies are met, and it is the highest-ranked claimable ready item.",
  "next_tool": "task_plan_claim_subtask",
  "next_args": { "plan_slug": "foo", "subtask_index": 0, "session_id": "sess_abc", "agent": "claude-code", "repo_root": "/abs/repo", "file_scope": ["src/x.ts"] },
  "next_action": "Call task_plan_claim_subtask with plan_slug=\"foo\", subtask_index=0, ...",
  "suggested_wake_seconds": 60,
  "signals": {
    "pending_handoff_count": 0,
    "quota_pending_claim_count": 0,
    "unread_message_count": 0,
    "blocking_message_count": 0,
    "ready_subtask_count": 1,
    "stalled_lane_count": 8,
    "dead_heartbeat_lane_count": 6,
    "actionable_stalled_lane_count": 2
  }
}
```

Stalled lanes whose surface activity is just session-start noise — title beginning with `Session start`, `No active swarm`, or `Heartbeat`, plus `dead`-activity lanes with no title — are classified as **dead heartbeats** and excluded from `actionable_stalled_lane_count`. Callers should drive escalation off `actionable_stalled_lane_count`, not the raw `stalled_lane_count`, to avoid noisy takeover signals.

## `task_drift_check`

Compare a session's active claims for one task against its recent edit-tool observations within a configurable window. File-scope drift only — does not analyse semantic drift from the task description.

```json
{
  "name": "task_drift_check",
  "input": { "session_id": "sess_abc", "task_id": 42, "window_minutes": 60 }
}
```

Inputs:

- `session_id` — the agent's session.
- `task_id` — the task whose claims and edits are compared.
- `window_minutes` — lookback for edit observations. Default 60, max 1440. Claims have no time bound; only their `state='active'` rows count.

Returns:

```json
{
  "generated_at": 1700000000000,
  "task_id": 42,
  "session_id": "sess_abc",
  "window_minutes": 60,
  "claimed_files": ["src/keeper.ts", "src/idle-claim.ts"],
  "edited_files": ["src/keeper.ts", "src/uncovered.ts"],
  "edits_without_claim": ["src/uncovered.ts"],
  "claims_without_edits": ["src/idle-claim.ts"],
  "drift_score": 0.5,
  "recommendation": "Claim 1 file(s) edited without an active claim: src/uncovered.ts. Release or revisit 1 claim(s) with no recent edits: src/idle-claim.ts.",
  "next_tool": "task_claim_file",
  "next_args": [{ "session_id": "sess_abc", "task_id": 42, "file_path": "src/uncovered.ts" }]
}
```

`drift_score` is `edits_without_claim.length / max(1, edited_files.length)` — the share of recent edits that fell outside the claim manifest. `next_tool` / `next_args` carry concrete `task_claim_file` payloads when drift exists, otherwise `null`. Edit-tool detection uses the canonical `FILE_EDIT_TOOLS` set from `@colony/storage`.

## `savings_report`

Reports colony token savings: live per-operation usage from the `mcp_metrics` table plus reference rows for common coordination loops.

Args:

- `since_ms?` — absolute epoch-ms cutoff for the live window. Takes precedence over `hours`.
- `hours?` — relative live window in hours. Defaults to 24, max 720 (30d).
- `operation?` — filter live rows to one tool name (e.g. `"search"`).
- `input_usd_per_1m?` — USD price per 1M input tokens. Falls back to `COLONY_MCP_INPUT_USD_PER_1M`.
- `output_usd_per_1m?` — USD price per 1M output tokens. Falls back to `COLONY_MCP_OUTPUT_USD_PER_1M`.

Response shape:

```json
{
  "live": {
    "note": "Recorded mcp_metrics receipts for the requested window.",
    "window": { "since": 1730000000000, "until": 1730086400000, "hours": 24 },
    "cost_basis": { "input_usd_per_1m_tokens": 1.25, "output_usd_per_1m_tokens": 10, "configured": true },
    "totals": { "operation": "__total__", "calls": 1284, "ok_count": 1280, "error_count": 4, "error_reasons": [{ "error_code": "TASK_NOT_FOUND", "error_message": "task 6 not found", "count": 2, "last_ts": 1730086391120 }], "input_tokens": 153000, "output_tokens": 482000, "total_tokens": 635000, "total_cost_usd": 5.01125, "avg_cost_usd": 0.003903, "avg_input_tokens": 119, "avg_output_tokens": 376, "total_duration_ms": 4310, "avg_duration_ms": 3, "last_ts": 1730086391120 },
    "operations": [{ "operation": "search", "calls": 412, "ok_count": 411, "error_count": 1, "error_reasons": [], "...": "..." }]
  },
  "reference": {
    "kind": "static_per_session_model",
    "note": "Static estimated per-session token cost for common coordination loops, with vs. without colony. This total is not derived from the live mcp_metrics window.",
    "rows": [{ "operation": "...", "frequency_per_session": 5, "baseline_tokens": 8000, "colony_tokens": 1500, "savings_pct": 81, "rationale": "..." }],
    "totals": { "baseline_tokens": 802000, "colony_tokens": 83900, "savings_pct": 90 }
  }
}
```

Live tokens are counted with `@colony/compress#countTokens` — the same primitive that produces observation token receipts, so values line up across surfaces. Estimated USD cost is computed at report time from the live token totals and caller-provided USD-per-1M rates; unset rates keep `cost_basis.configured=false` and report zero cost fields. New failure rows record `error_code` / `error_message`; older failure rows may have unknown reason fields. The reference table is static and sourced from `packages/core/src/savings-reference.ts`; the CLI command `colony gain` and the worker's `/savings` page render the same payload.

## Plan observation kinds

The lane introduces several observation kinds on the parent spec task and on the sub-task threads. They are written through `MemoryStore.addObservation`, so content is compressed and `metadata` carries the structured payload.

- `plan-subtask` — the initial advertisement, one per sub-task at publish time. `metadata` carries `parent_plan_slug`, `parent_plan_title`, `parent_spec_task_id`, `subtask_index`, `file_scope`, `depends_on`, `capability_hint`, and an initial `status: 'available'`.
- `plan-subtask-claim` — every lifecycle transition (claim, complete). `metadata.status` is the new state; `metadata.session_id` and `metadata.agent` identify the actor. The latest `plan-subtask-claim` observation by timestamp is authoritative.
- `plan-config` — written on the parent spec task at publish time. Carries plan-level lifecycle policy. Today: `metadata.auto_archive`.
- `plan-archived` — written on the parent spec task when auto-archive succeeds. Carries `archived_path`, `merged_root_hash`, `applied`.
- `plan-archive-blocked` — written when auto-archive is ready but the three-way merge has conflicts. Carries `conflicts` (the conflict set) and `applied` (the deltas that did merge cleanly).
- `plan-archive-error` — written when auto-archive throws. Carries the error message in `metadata.error`. The sub-task completion still succeeded; auto-archive errors never tear down completion.
- `reflexion` — reserved for one-line lessons from failure, expiry, rollback, or success outcomes. Carries the shared `ReflexionMetadata` payload from `@colony/core`; writers store the summary/reflection through `MemoryStore.addObservation`, so the body is compressed.

## Contract stability

Fields may be added. Existing fields will not be removed or renamed within a minor version.
