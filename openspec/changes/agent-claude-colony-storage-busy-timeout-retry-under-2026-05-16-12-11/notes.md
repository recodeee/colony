# agent-claude-colony-storage-busy-timeout-retry-under-2026-05-16-12-11 (minimal / T1)

Branch: `agent/claude/colony-storage-busy-timeout-retry-under-2026-05-16-12-11`

Raise SQLite contention headroom in `@colony/storage` so the worker daemon, MCP server, CLI hooks, and codex-fleet panes can share `~/.colony/data.db` without surfacing `SQLITE_BUSY: database is locked` to callers.

- `busy_timeout` 5000 → 15000 ms (one connection-scoped pragma in the `Storage` constructor).
- `withBusyRetry` defaults: `maxAttempts` 5 → 8, `baseDelayMs` 5 → 10, `maxDelayMs` 250 → 1000. New worst-case wait ~3.85s vs old ~0.355s; happy-path callers stay sub-ms because no busy error means no retry sleep.
- Updated `keeps busy_timeout set to N` assertion in `test/busy-retry.test.ts` from 5000 to 15000.

Triggered by a real lock storm on 2026-05-16: ~30 codex-fleet panes + 4 live Claude sessions + 1 worker = 34+ concurrent writers, which exhausted the previous 5s window + 5-retry tail. The fleet teardown is the immediate fix; this PR is the durable headroom.

## Handoff

- Handoff: change=`agent-claude-colony-storage-busy-timeout-retry-under-2026-05-16-12-11`; branch=`agent/claude/colony-storage-busy-timeout-retry-under-2026-05-16-12-11`; scope=`packages/storage src + test only`; action=`finish via PR to main`.

## Cleanup

- [ ] Run: `gx branch finish --branch agent/claude/colony-storage-busy-timeout-retry-under-2026-05-16-12-11 --base main --via-pr --wait-for-merge --cleanup`
- [ ] Record PR URL + `MERGED` state in the completion handoff.
- [ ] Confirm sandbox worktree is gone (`git worktree list`, `git branch -a`).
