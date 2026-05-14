# agent-claude-metrics-wrapper-session-attribution-via-2026-05-14-23-51 (minimal / T1)

Branch: `agent/claude/metrics-wrapper-session-attribution-via-2026-05-14-23-51`

The metrics wrapper now derives `session_id` for sessionless tools via the
same `detectMcpClientIdentity` heuristic the heartbeat already runs per
call. Eliminates the `<unknown>` bucket from `colony gain` for tools like
`task_plan_list` / `get_observations` / `search` / `task_timeline` whose
schemas don't carry `session_id`. Explicit `session_id` args still win;
fallback only fires when both `args.session_id` and
`args.current_session_id` are absent.

## Handoff

- Handoff: change=`agent-claude-metrics-wrapper-session-attribution-via-2026-05-14-23-51`; branch=`agent/claude/metrics-wrapper-session-attribution-via-2026-05-14-23-51`; scope=`apps/mcp-server only`; action=`finish via PR after user sign-off`.

## Cleanup

- [ ] Run: `gx branch finish --branch agent/claude/metrics-wrapper-session-attribution-via-2026-05-14-23-51 --base main --via-pr --wait-for-merge --cleanup`
- [ ] Record PR URL + `MERGED` state in the completion handoff.
- [ ] Confirm sandbox worktree is gone (`git worktree list`, `git branch -a`).
