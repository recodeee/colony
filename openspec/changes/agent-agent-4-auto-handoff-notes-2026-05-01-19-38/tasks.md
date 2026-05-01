# Tasks

- [x] Inspect existing `task_note_working`, `task_post`, `task_hand_off`, and `attention_inbox` coordination paths.
- [x] Add `colony note working` for compact handoff notes in `branch | task | blocker | next | evidence` order.
- [x] Infer branch/task from the active session/task binding when unambiguous.
- [x] Validate required fields and compact long proof/log evidence with a warning.
- [x] Supersede the previous live auto handoff note when posting a replacement.
- [x] Add focused CLI/core tests for explicit notes, inferred fields, missing `next`, long evidence warnings, and replacement behavior.
- [x] Update MCP docs with the compact handoff note format and CLI helper.
- [x] Run focused verification.
  - `pnpm --filter @colony/core test -- test/working-note.test.ts` passed.
  - `pnpm --filter @colony/core typecheck` passed.
  - `pnpm --filter @imdeadpool/colony-cli test -- test/note.test.ts test/program.test.ts` passed.
  - `pnpm --filter @imdeadpool/colony-cli typecheck` passed.
  - `pnpm exec biome check apps/cli/src/commands/note.ts apps/cli/test/note.test.ts apps/cli/test/program.test.ts docs/mcp.md packages/core/src/task-thread.ts packages/core/src/working-note.ts packages/core/test/working-note.test.ts openspec/changes/agent-agent-4-auto-handoff-notes-2026-05-01-19-38/tasks.md` passed.
  - `openspec validate --specs` passed.

## Blocked / Deferred

- [ ] MCP `task_note_working` structured-input wiring is not edited in this slice because `apps/mcp-server/src/tools/task.ts`, `apps/mcp-server/test/task-threads.test.ts`, and `apps/mcp-server/test/server.test.ts` are actively owned by session `019de48e`. Agent 4 sent blocking coordination message `18240` and avoided those files.

## Cleanup

- [ ] Finish PR, merge, and sandbox cleanup; record PR URL and `MERGED` evidence.
