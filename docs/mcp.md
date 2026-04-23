# MCP tools

cavemem exposes MCP tools over a stdio server. IDE installers register that server as `colony`, so agent tool calls appear under the `colony` namespace. The design goal is **progressive disclosure**: hits are compact until the agent asks for more.

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
- `repo_roots`: multiple workspace roots to inspect. Also configurable with `CAVEMEM_HIVEMIND_REPO_ROOTS` separated by the platform path delimiter.
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

## Contract stability

Fields may be added. Existing fields will not be removed or renamed within a minor version.
