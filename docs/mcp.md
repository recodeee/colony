# MCP tools

cavemem exposes four tools over an MCP stdio server. The design goal is **progressive disclosure**: hits are compact until the agent asks for more.

The recommended workflow is a three-layer pattern:

1. `search` (or `list_sessions` → `timeline`) to get a compact index.
2. Review IDs.
3. `get_observations` with the filtered set.

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

## Contract stability

Fields may be added. Existing fields will not be removed or renamed within a minor version.
