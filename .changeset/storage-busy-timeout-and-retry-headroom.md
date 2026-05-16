---
'colonyq': patch
---

Raise SQLite contention headroom in `@colony/storage` so the worker daemon,
MCP server, CLI hooks, and codex-fleet panes can share `~/.colony/data.db`
without surfacing `SQLITE_BUSY: database is locked` to callers. The
`Storage` constructor now sets `busy_timeout=15000` (was 5000), and
`withBusyRetry` defaults bump to 8 attempts with up-to-1s backoff (was 5
attempts / 250ms cap). Happy-path callers are unaffected because no busy
error still means no retry sleep; sustained contention from ~30+ concurrent
writers — the codex-fleet shape that triggered this — now has ~3.85s of
combined SQLite + Node retry headroom before raising.
