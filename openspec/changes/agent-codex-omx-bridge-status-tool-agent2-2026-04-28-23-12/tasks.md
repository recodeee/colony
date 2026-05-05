# Tasks

- [x] Inspect MCP tool registration and existing hivemind, attention, and ready-work tools.
- [x] Add compact `bridge_status` MCP tool.
- [x] Reuse ready-work ranking through a shared helper.
- [x] Add bridge-status test coverage.
- [x] Add transition-safe OMX notepad pointer support to `task_note_working`.
- [x] Add working-note bridge tests for success, ambiguous task, and no active task.
- [x] Run focused typecheck/tests and OpenSpec validation.
  - `pnpm --filter @colony/mcp-server test -- task-threads.test.ts bridge-status.test.ts server.test.ts` -> 34 passed after rebase.
  - `pnpm test` -> passed after rebase.
  - `pnpm typecheck` -> passed after rebase.
  - `pnpm lint` -> passed after rebase.
  - `openspec validate --specs` -> 2 passed.
  - `openspec validate agent-codex-omx-bridge-status-tool-agent2-2026-04-28-23-12 --strict` -> passed.
- [x] Commit, PR, merge, and cleanup.

## Completion / Cleanup

- PR URL: https://github.com/recodeee/colony/pull/197
- Duplicate follow-up PR URL: https://github.com/recodeee/colony/pull/198
- Merge state: PR #197 `MERGED` at `1fccf45033ce34e2b8d65e88991345146aa4a604`; PR #198 `MERGED` at `72552a8cc622b257a132c8103247d4648315b908`
- Sandbox cleanup: original `colony__codex__omx-bridge-status-tool-agent2-2026-04-28-23-12` worktree pruned; local and remote `agent/codex/omx-bridge-status-tool-agent2-2026-04-28-23-12` branch deleted.
