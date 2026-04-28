# Tasks

- [x] Inspect MCP tool registration and existing hivemind, attention, and ready-work tools.
- [x] Add compact `bridge_status` MCP tool.
- [x] Reuse ready-work ranking through a shared helper.
- [x] Add bridge-status test coverage.
- [x] Add transition-safe OMX notepad pointer support to `task_note_working`.
- [x] Add working-note bridge tests for success, ambiguous task, and no active task.
- [x] Run focused typecheck/tests and OpenSpec validation.
  - `pnpm --filter @colony/mcp-server test -- test/bridge-status.test.ts test/server.test.ts test/task-threads.test.ts` -> 34 passed before rebase; rerun pending after conflict resolution.
  - `pnpm --filter @colony/mcp-server typecheck` -> passed before rebase; rerun pending after conflict resolution.
  - `pnpm --filter @colony/config test -- test/schema.test.ts` -> 4 passed.
  - `pnpm --filter @colony/config typecheck` -> passed.
  - `pnpm --filter @imdeadpool/colony-cli test -- test/program.test.ts` -> 9 passed.
  - `pnpm --filter @imdeadpool/colony-cli typecheck` -> passed.
  - `node_modules/.pnpm/@biomejs+cli-linux-x64@1.9.4/node_modules/@biomejs/cli-linux-x64/biome check ...` -> passed.
  - `openspec validate --specs` -> 2 passed.
  - `openspec validate agent-codex-omx-bridge-status-tool-agent2-2026-04-28-23-12 --strict` -> passed.
- [ ] Commit, PR, merge, and cleanup.

## Completion / Cleanup

- PR URL: pending
- Merge state: pending
- Sandbox cleanup: pending
