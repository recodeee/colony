---
'@colony/mcp-server': patch
---

Attribute `<unknown>` session metrics via the MCP client-identity fallback

`colony gain` previously bucketed ~9,000 calls/day into a single
`<unknown>` session row. Cause: high-volume read-only tools
(`task_plan_list`, `get_observations`, `search`, `task_timeline`,
`list_sessions`, `examples_list`, …) carry no `session_id` in their
schema, so `metricContextOf` had nothing to attribute the call to.

The metrics wrapper now reuses the same `detectMcpClientIdentity` heuristic
the heartbeat wrapper already runs on every call: env-derived identity
(`CODEX_SESSION_ID`, `CLAUDECODE_SESSION_ID`, `COLONY_CLIENT_SESSION_ID`),
or a stable `mcp-<ppid>` fallback when no signal is available. The
explicit `args.session_id` / `args.current_session_id` path is unchanged;
the fallback only fires when both are absent.

Effect on the savings report: per-client session rows replace the giant
`<unknown>` bucket, making it possible to see which agent / connection is
driving the bulk of the load — the regression-investigation gap that
PR #531's compact-mode fix left open.

No new tool dependencies; the wrapper reads `detectMcpClientIdentity` from
`./heartbeat.js` (already in the same package).
