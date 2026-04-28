## Implementation

- [x] Inspect `task_list`, existing task-ready routing hints, and telemetry/debrief surfaces.
- [x] Add `coordination_warning` and `next_tool` to `task_list` response.
- [x] Strengthen the warning after repeated inventory reads without `task_ready_for_agent`.
- [x] Preserve task data and existing `hint` field.
- [x] Update docs for the response shape.
- [x] Add normal and repeated-use tests.

## Verification

- [x] `pnpm --filter @colony/mcp-server test -- task-threads.test.ts`
- [x] `pnpm --filter @colony/mcp-server typecheck`
- [x] `pnpm exec biome check apps/mcp-server/src/tools/task.ts apps/mcp-server/test/task-threads.test.ts docs/mcp.md`
- [x] `openspec validate agent-agent-4-task-list-ready-warning-2026-04-29-00-31 --strict`

## Completion / Cleanup

- [ ] Commit changes.
- [ ] Push branch.
- [ ] Open/update PR.
- [ ] Merge PR.
- [ ] Prune sandbox worktree.
- [ ] Record final proof.
