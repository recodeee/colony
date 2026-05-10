---
"colonyq": patch
---

Stop mislabelling generic MCP errors and reduce SQLite contention failures.

- `mcpError` now codes non-`TaskThreadError` throws as `INTERNAL_ERROR` instead of `OBSERVATION_NOT_ON_TASK`, so validation failures and SQLite "database is locked" errors surface honestly in `mcp_metrics` and `colony gain`.
- Storage now sets `PRAGMA busy_timeout = 5000` on every connection (worker daemon, MCP server, CLI hooks all open separate handles to the same WAL DB), so concurrent writers wait the kernel out instead of throwing `SQLITE_BUSY` immediately.
