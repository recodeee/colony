# Tasks

- [x] Inspect `task_note_working`, `task_post`, bridge config, and OMX notepad guidance.
- [x] Route working-state guidance to `task_note_working` first.
- [x] Keep OMX fallback pointer-only and documented.
- [x] Add focused tests for no full notepad duplication and first-path descriptions.
- [x] Run targeted verification.
- [x] Commit, push, open PR, merge, and cleanup sandbox worktree.

## Completion Evidence

- Tests: `pnpm --filter @colony/mcp-server test -- test/task-threads.test.ts test/server.test.ts` -> 38 passed; `pnpm --filter @imdeadpool/colony-cli test -- test/health.test.ts` -> 10 passed.
- Typecheck: `pnpm --filter @colony/mcp-server typecheck` -> passed; `pnpm --filter @imdeadpool/colony-cli typecheck` -> passed.
- Lint/format: `pnpm exec biome check apps/mcp-server/src/tools/task.ts apps/mcp-server/test/task-threads.test.ts apps/mcp-server/test/server.test.ts apps/cli/src/commands/health.ts apps/cli/test/health.test.ts` -> passed.
- OpenSpec: `openspec validate agent-agent-5-task-note-working-first-write-path-agent-2026-04-29-00-39 --strict` -> passed; `openspec validate --specs` -> passed.
- PR URL: https://github.com/recodeee/colony/pull/221
- Merge state: `MERGED`, merge commit `07f60dbc9a4fc8fa0a3be3cac76b92d2125505f2`.
- Sandbox cleanup: source branch/worktree `agent/agent-5/task-note-working-first-write-path-agent-2026-04-29-00-39` pruned; local and remote tracking refs absent.
