# agent-claude-move-task-foraging-report-to-foraging-ts-2026-05-14-21-12 (minimal / T1)

Branch: `agent/claude/move-task-foraging-report-to-foraging-ts-2026-05-14-21-12`

Move `task_foraging_report` from `apps/mcp-server/src/tools/attention.ts` to
`apps/mcp-server/src/tools/foraging.ts` (where it belongs alongside
`examples_list` / `examples_query` / `examples_integrate_plan`). Pure code-
location refactor: same MCP tool name, description, schema, handler body.
`server.ts` calls a new `registerTaskForagingReport` named export at
attention's old slot, so `listTools` ordering is preserved.

## Handoff

- Handoff: change=`agent-claude-move-task-foraging-report-to-foraging-ts-2026-05-14-21-12`; branch=`agent/claude/move-task-foraging-report-to-foraging-ts-2026-05-14-21-12`; scope=`apps/mcp-server only`; action=`finish via PR after user sign-off on the local diff`.

## Cleanup

- [ ] Run: `gx branch finish --branch agent/claude/move-task-foraging-report-to-foraging-ts-2026-05-14-21-12 --base main --via-pr --wait-for-merge --cleanup`
- [ ] Record PR URL + `MERGED` state in the completion handoff.
- [ ] Confirm sandbox worktree is gone (`git worktree list`, `git branch -a`).
